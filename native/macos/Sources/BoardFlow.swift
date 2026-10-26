import Foundation

enum BoardFlow {
  static func wait<T>(_ ct: Cancellation, timeout: Double, _ get: () throws -> T) throws -> T {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
      try ct.check()
      do { return try get() } catch { try ct.check() }
      try ct.sleep(0.3)
    }
    throw Failure("原设备接口未按预期恢复，请保留备份")
  }
  static func run(
    _ b: Board, _ cfg: Configuration, _ spark: Spark,
    resolve: @escaping (String, Bool) throws -> USBDevice
  ) throws {
    let ct = b.ct
    let esp = cfg.mode != "ml"
    let ml = cfg.mode != "esp"
    var activation: Activation?
    defer { activation?.clear() }
    var version = ""
    if esp {
      b.change { $0.espState = "读取 MAC 与芯片容量" }
      do {
        let mac = try DeviceIdentity.readESP(
          resolve: { try resolve("esp", false).paths[0] },
          identify: { try EspEngine.identify($0, ct) }, ct: ct,
          status: { state in b.change { $0.espState = state } })
        b.change {
          $0.mac = mac
          $0.espState = "MAC 已确认"
        }
      } catch {
        b.change { $0.espState = "失败：" + error.localizedDescription }
        throw error
      }
    }
    if ml {
      b.change { $0.mlState = "读取 IMEI 与固件身份" }
      let wire = try USBWire(resolve("ml", false), download: false)
      defer { wire.close() }
      version = try DeviceIdentity.modemVersion { try AT.command(wire, $0, ct) }
      let imei = try AT.imei(wire, ct)
      wire.close()
      b.change {
        $0.imei = imei
        $0.mlState = "批次授权已就绪"
      }
      activation = try Activation(spark, cfg.project, cfg.authorization, ct)
    }
    try ct.check()
    b.change {
      $0.result = "烧录中"
      $0.reason = "两个芯片独立写入，等待校验和授权"
    }
    let group = DispatchGroup()
    let errors = FlowErrors()
    if esp {
      group.enter()
      Thread.detachNewThread {
        defer { group.leave() }
        do {
          try EspEngine.flash(
            resolve: { try resolve("esp", false).paths[0] }, file: cfg.espURL, image: cfg.esp,
            ct: ct,
            progress: { p, s in
              b.change {
                $0.espProgress = p
                $0.espState = s
              }
            }, stage: { b.record("ESP32", $0, $1) })
        } catch {
          b.change { $0.espState = "失败：" + error.localizedDescription }
          b.record("ESP32", "failed", error.localizedDescription)
          errors.add(error)
        }
      }
    }
    if ml {
      let auth = activation!
      let oldVersion = version
      group.enter()
      Thread.detachNewThread {
        defer { group.leave() }
        do {
          b.record("ML307H", "started", "开始下载、备份与写入")
          try flashML(b, cfg, auth, oldVersion, resolve)
        } catch {
          b.change { $0.mlState = "失败：" + error.localizedDescription }
          b.record("ML307H", "failed", error.localizedDescription)
          errors.add(error)
        }
      }
    }
    group.wait()
    try ct.check()
    if let error = errors.first { throw error }
    if esp {
      b.change {
        $0.result = "复位"
        $0.reason = "所选芯片写入完成，复位 ESP32"
      }
      let port = try wait(ct, timeout: 15) { try resolve("esp", false).paths[0] }
      try EspEngine.reset(port, ct)
    }
    if !cfg.production { return }
    b.change {
      $0.result = "产测中"
      $0.reason = "等待固件启动"
    }
    do {
      let result = try Factory.run(
        open: { try SerialWire(resolve("esp", false).paths[0]) },
        change: { r in
          b.change {
            $0.runID = r.runID
            $0.production = r.state == "passed" ? "产测通过" : r.reason
            $0.cloud = !r.cloud ? "等待登记" : r.ready ? "登记与报告上传成功" : "已登记 · 等待报告上传"
            $0.reason = r.reason
          }
        }, ct: ct)
      b.change {
        $0.production = result.reason
        $0.cloud = result.ready ? "登记与报告上传成功" : "未完整确认"
      }
      try require(result.ready, result.reason)
    } catch {
      b.change { $0.production = "未通过：" + error.localizedDescription }
      throw error
    }
  }
  static func flashML(
    _ b: Board, _ cfg: Configuration, _ activation: Activation, _ version: String,
    _ resolve: (String, Bool) throws -> USBDevice
  ) throws {
    guard let pkg = cfg.pkg else { throw Failure("缺少 ML307 固件") }
    let ct = b.ct
    let imei = b.state.imei
    let intent = Disk.root.appendingPathComponent("ml-intents/\(imei).json")
    if FileManager.default.fileExists(atPath: intent.path) {
      let old = try Disk.load(intent)
      try require(text(old, "phase") == "verified", "这台设备有未完成烧录记录，请核对原备份：" + text(old, "backup"))
    }
    let backup = cfg.backup.appendingPathComponent(
      DateFormatter.batch.string(from: Date()) + "_" + imei + "_" + b.id)
    try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true)
    b.change { $0.backup = backup.path }
    var state: Object = [
      "schema": 1, "kind": "ringhi-native-mac-flash-session", "imei": imei, "mac": b.state.mac,
      "hub": b.state.hub, "firmwareSha256": pkg.digest, "versionBefore": version,
      "backup": backup.path, "phase": "preparing", "createdAt": timestamp(),
    ]
    func save() throws {
      try Disk.save(backup.appendingPathComponent("session.json"), state)
      try Disk.save(intent, state)
    }
    try save()
    do {
      let wire = try USBWire(resolve("ml", false), download: false)
      defer { wire.close() }
      try require(try AT.imei(wire, ct) == imei, "下载前 IMEI 改变")
      _ = try AT.command(wire, "AT^AUTODL", ct, timeout: 3, disconnectOK: true)
    }
    try ct.sleep(2)
    if (try? resolve("ml", true)) == nil {
      let wire = try USBWire(resolve("ml", false), download: false)
      defer { wire.close() }
      try require(try AT.imei(wire, ct) == imei, "下载前 IMEI 改变")
      _ = try AT.command(wire, "AT^RESET=normal", ct, timeout: 3, disconnectOK: true)
    }
    let device = try wait(ct, timeout: 25) { try resolve("ml", true) }
    let wire = try USBWire(device, download: true)
    defer { wire.close() }
    let dl = Download(wire, ct)
    var weights: [String: Int] = [:]
    var done: [String: Int] = [:]
    var last = Date.distantPast
    for p in pkg.loaders { weights[p.name] = p.size }
    for p in pkg.protected {
      weights["备份 " + p.name] = Int(p.capacity)
      weights["写入 " + p.target] = Int(p.capacity)
    }
    for p in pkg.writes { weights["写入 " + p.target] = p.size }
    let total = max(1, weights.values.reduce(0, +))
    dl.progress = { label, n, max in
      if label.hasPrefix("写入 ") && n > 0 { b.record("ML307H", "writing", "收到首个 Flash 写入应答") }
      done[label] = min(n, max)
      if n != max && Date().timeIntervalSince(last) < 0.1 { return }
      last = Date()
      let percent = 2 + 88 * done.values.reduce(0, +) / total
      b.change {
        $0.mlProgress = percent
        $0.mlState = label + " · \(n*100/Swift.max(1,max))%"
      }
    }
    try dl.bootstrap(pkg)
    let uid = try dl.send(18, Data.le(0, 4), accepted: [0x83]).1.hex
    try require(matches(uid, "^[a-f0-9]{16,128}$"), "设备 UID 无效")
    state["uid"] = uid
    let table = try dl.send(15, accepted: [0x80, 0xb1])
    state["phase"] = "backing-up"
    try save()
    b.record("ML307H", "backup", "备份校准及工厂数据")
    var backups: Object = [:]
    for p in pkg.protected {
      let bytes = try dl.backup(p)
      let path = backup.appendingPathComponent(p.name + ".bin")
      try Disk.verified(path, bytes)
      backups[p.name] = ["file": path.path, "sha256": bytes.sha256, "size": bytes.count]
      state["backups"] = backups
      try save()
    }
    func saved(_ p: Partition) throws -> Data {
      let meta = object(backups, p.name)
      let bytes = try Data(contentsOf: URL(fileURLWithPath: text(meta, "file")))
      try require(bytes.count == p.capacity && bytes.sha256 == text(meta, "sha256"), "设备备份重新读取校验失败")
      return bytes
    }
    for p in pkg.protected { _ = try saved(p) }
    state["phase"] = "writing"
    try save()
    if table.0 == 0xb1 { try dl.send(14, timeout: 180) }
    for p in pkg.entries where p.type == "CODE" && p.backup == 2 {
      try dl.send(10, MLProtocol.partition(p.target, 0))
    }
    for p in pkg.writes where p.target != "mbl" {
      try dl.write(p.target, pkg.payload(p))
      state["lastWritten"] = p.name
      try save()
    }
    for p in pkg.protected { try dl.write(p.target, saved(p)) }
    let mbl = pkg.writes.last!
    try dl.write(mbl.target, pkg.payload(mbl))
    state["phase"] = "activating"
    try save()
    b.record("ML307H", "activation", "写入完成，自动激活")
    b.change {
      $0.mlProgress = 92
      $0.mlState = "下载完成 · 正在自动激活"
    }
    do {
      try activation.run(dl, uid, backup) { stage in b.change { $0.mlState = "授权：" + stage } }
    } catch {
      if !dl.broken && !ct.cancelled { try? dl.reset() }
      throw error
    }
    try dl.reset()
    state["phase"] = "awaiting-verification"
    try save()
    wire.close()
    try ct.sleep(2)
    let runtime = try wait(ct, timeout: 45) { try resolve("ml", false) }
    let at = try USBWire(runtime, download: false)
    defer { at.close() }
    try require(try AT.imei(at, ct) == imei, "复位后 IMEI 不一致")
    let after = try AT.command(at, "AT+CGMR", ct)
    try require(after.lowercased().contains("ringhi"), "复位后无法确认 RingHi 固件")
    state["versionAfter"] = after
    state["phase"] = "verified"
    try save()
    b.record("ML307H", "complete", "写入、自动激活和复位身份核验通过")
    b.change {
      $0.mlProgress = 100
      $0.mlState = "写入应答、自动激活、复位后身份通过"
    }
  }
}
final class FlowErrors {
  let lock = NSLock()
  var list: [Error] = []
  func add(_ error: Error) { lock.with { list.append(error) } }
  var first: Error? { lock.with { list.first } }
}
