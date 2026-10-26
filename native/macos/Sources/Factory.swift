import Foundation

struct FactoryResult {
  var state = "running", reason = "等待产测", runID = "", upload = "", phase = "", firmware = ""
  var cloud = false, pending = false
  var ready: Bool { state == "passed" && cloud && !pending && upload == "uploaded" }
}
enum Factory {
  static func evaluate(_ status: Object) -> FactoryResult {
    let report = object(status, "report")
    let checks = report["checks"] as? [Object] ?? []
    var r = FactoryResult()
    r.runID = text(report, "runId")
    r.cloud = bool(status, "cloudRegistered")
    r.pending = bool(status, "pendingUpload")
    r.upload = text(status, "upload")
    r.firmware = text(report, "espVersion")
    if r.runID.isEmpty || report["checks"] == nil { return r }
    let stage = text(report, "stage")
    let policy = text(report, "ledPolicy")
    if stage == "cancelled" || bool(report, "cancelled") {
      r.state = "cancelled"
      r.reason = "设备取消产测"
      return r
    }
    let failed = checks.filter { text($0, "status") == "failed" }
    if stage == "failed" || !failed.isEmpty {
      r.state = "failed"
      r.reason =
        failed.isEmpty
        ? "设备报告产测失败"
        : failed.map { text($0, "id") + ": " + text($0, "detail") }.joined(separator: "；")
      return r
    }
    if policy != "volte-card-v3" {
      r.state = "review"
      r.reason = "需要 s3.142 或兼容 volte-card-v3 的产测固件"
      return r
    }
    if stage != "passed" {
      r.reason = "产测中：" + stage
      return r
    }
    if !["wifi", "volte", "sim"].allSatisfy({ id in
      checks.contains { text($0, "id") == id && text($0, "status") == "passed" }
    }) {
      r.state = "review"
      r.reason = "产测终态与必检项不一致"
      return r
    }
    if !(status["cloudRegistered"] is Bool) || !(status["pendingUpload"] is Bool) {
      r.reason = "等待完整云端登记与上传状态"
      return r
    }
    r.state = "passed"
    r.phase = !r.cloud ? "registration" : (!r.ready ? "upload" : "closing")
    r.reason = !r.cloud ? "产测通过 · 等待云端登记" : (!r.ready ? "云端登记成功 · 等待最终报告上传" : "产测与云端确认完成 · 释放串口")
    return r
  }
  static func command(_ wire: Wire, _ command: String, _ ct: Cancellation, accept: (String) -> Any?)
    throws -> Any?
  {
    try wire.clear(ct)
    try wire.write(Data((command + "\n").utf8), ct)
    let end = Date().addingTimeInterval(12)
    var buffer = Data()
    while Date() < end {
      buffer.append(try wire.read(200, ct))
      try require(buffer.count <= 65536, "产测响应过长")
      while let index = buffer.firstIndex(of: 10) {
        let line = String(decoding: buffer.prefix(index), as: UTF8.self).trimmingCharacters(
          in: .whitespacesAndNewlines)
        buffer = Data(buffer.dropFirst(index + 1))
        if let answer = accept(line) { return answer }
      }
    }
    return nil
  }
  static func status(_ wire: Wire, _ ct: Cancellation) throws -> Object? {
    try command(wire, "FACTORY STATUS", ct) { line in
      guard let d = try? json(Data(line.utf8)), d["active"] is Bool, d["done"] is Bool,
        d["report"] != nil
      else { return nil }
      return d
    } as? Object
  }
  static func run(open: () throws -> Wire, change: (FactoryResult) -> Void, ct: Cancellation) throws
    -> FactoryResult
  {
    var port: Wire?
    defer { port?.close() }
    let boot = Date().addingTimeInterval(45)
    var initial: Object?
    while Date() < boot {
      try ct.check()
      do {
        port = try open()
        initial = try status(port!, ct)
        if initial != nil { break }
      } catch { try ct.check() }
      port?.close()
      port = nil
      try ct.sleep(1.5)
    }
    guard let initial, let wire = port else { throw Failure("未收到 FACTORY STATUS，固件未启动或 USB 未恢复") }
    try require(!bool(initial, "pendingUpload"), "保留上一轮待上传报告，联网完成上传后再测")
    let baseline = text(object(initial, "report"), "runId")
    let reply = try command(wire, "FACTORY RETEST", ct) { line in
      line.hasPrefix("Factory scan armed") ? "armed" : line.hasPrefix("Refused:") ? "refused" : nil
    }
    try require(reply as? String == "armed", "产测启动未确认或被拒绝，未重复发送")
    let end = Date().addingTimeInterval(180)
    var run = ""
    var sequence: Int64 = -1
    var terminal: Date?
    var last = FactoryResult()
    last.reason = "等待 AiSpea_Factory 工厂 Wi-Fi"
    change(last)
    while Date() < end {
      try ct.sleep(1.5)
      guard let status = try status(wire, ct) else { continue }
      let report = object(status, "report")
      let id = text(report, "runId")
      if id.isEmpty || id == baseline { continue }
      try require(run.isEmpty || run == id, "产测轮次意外变化")
      run = id
      if let next = Int64(text(report, "sequence")) {
        try require(next >= sequence, "产测报告序号倒退")
        sequence = next
      }
      last = evaluate(status)
      change(last)
      if last.ready {
        wire.close()
        port = nil
        last.phase = "complete"
        last.reason = "产测通过 · 云端登记和报告上传完成"
        return last
      }
      if last.state == "passed" {
        if terminal == nil { terminal = Date() }
        if Date().timeIntervalSince(terminal!) >= 30 {
          throw Failure(last.cloud ? "最终报告上传超时，整板未通过" : "云端登记超时，整板未通过")
        }
      } else if last.state != "running" {
        return last
      }
    }
    throw Failure("产测超时，请检查工厂 Wi-Fi、SIM / eSIM 与设备状态")
  }
}
