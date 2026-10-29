import Darwin
import Foundation

enum OwnedProcess {
  static func run(
    _ url: URL, _ arguments: [String], _ ct: Cancellation, timeout: Double,
    started: () -> Void = {}, line: (String) throws -> Void = { _ in }
  ) throws -> String {
    try ct.check()
    let args = ([url.path] + arguments).map { strdup($0) }
    defer { args.forEach { free($0) } }
    var argv = args + [nil]
    var fd: Int32 = -1
    let pid = url.path.withCString { rh_spawn($0, &argv, &fd) }
    try require(pid > 0, "无法启动工具：\(String(cString:strerror(errno)))")
    defer {
      rh_process_stop(pid)
      Darwin.close(fd)
    }
    started()
    var pending = Data()
    var output = ""
    var exit: Int32 = 0
    var ended = false
    let end = Date().addingTimeInterval(timeout)
    func emit(_ data: Data) throws {
      let s = String(decoding: data, as: UTF8.self).replacingOccurrences(
        of: "\\x1B\\[[0-?]*[ -/]*[@-~]", with: "", options: .regularExpression)
      output += s + "\n"
      if output.utf8.count > 512 * 1024 { output = String(output.suffix(128 * 1024)) }
      try line(s)
    }
    while true {
      try ct.check()
      try require(Date() < end, "官方工具操作超时")
      var b = Array(repeating: UInt8(0), count: 8192)
      let n = Darwin.read(fd, &b, b.count)
      if n > 0 {
        pending.append(contentsOf: b.prefix(n))
        try require(pending.count <= 256 * 1024, "工具输出行过长")
        while let index = pending.firstIndex(where: { $0 == 10 || $0 == 13 }) {
          try emit(pending.prefix(index))
          pending = Data(pending.dropFirst(index + 1))
        }
      } else if n < 0 && errno != EAGAIN && errno != EINTR {
        throw Failure("官方工具输出读取失败")
      }
      if !ended {
        let r = rh_process_poll(pid, &exit)
        try require(r >= 0, "工具进程状态读取失败")
        ended = r == 1
      }
      if ended && n <= 0 {
        if !pending.isEmpty { try emit(pending) }
        break
      }
      if n <= 0 {
        var poller = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        _ = Darwin.poll(&poller, 1, 50)
      }
    }
    try require(exit == 0, "esptool 失败（\(exit)）：" + output.suffix(1600))
    return output
  }
}
enum EspEngine {
  static var executable = Bundle.main.resourceURL!.appendingPathComponent("Tools/esptool")
  static let hash = "230d151117a97d34dbedb32c50011b1d7c424275fba575a4b03a496799f64b63"
  static func verify() throws {
    try require(FileManager.default.isExecutableFile(atPath: executable.path), "官方 esptool 缺失")
    let data = try Data(contentsOf: executable, options: .mappedIfSafe)
    try require(data.sha256 == hash, "官方 esptool 校验不符")
  }
  @discardableResult static func preflight(_ ct: Cancellation) throws -> String {
    try verify()
    let output = try OwnedProcess.run(executable, ["version"], ct, timeout: 60)
    try require(matches(output, "(?m)^esptool(?:\\.py)? v5\\.6\\.0\\b"), "ESP32 工具自检失败：版本未确认")
    return output
  }
  static func validate(_ b: Data) throws {
    try require(
      b.count == 16 * 1024 * 1024 && b[0] == 0xe9 && b.uint(12, 2) == 9,
      "请选择 ESP32-S3 完整 16 MB BIN，地址固定 0x0")
  }
  static func run(
    _ command: String, _ port: String, _ extra: [String], _ ct: Cancellation, timeout: Double = 180,
    before: String = "default-reset", after: String = "no-reset-stub", started: () -> Void = {}, line: (String) throws -> Void = { _ in }
  ) throws -> String {
    try verify()
    try require(port.hasPrefix("/dev/cu.") && !port.contains("\n"), "串口路径无效")
    return try OwnedProcess.run(
      executable,
      [
        "--chip", "esp32s3", "--port", port, "--baud", "460800", "--before", before,
        "--after", after, command,
      ] + extra, ct, timeout: timeout, started: started, line: line)
  }
  static func parseIdentity(_ output: String) throws -> String {
    try require(
      matches(output, "(?i)Chip type:\\s*ESP32-?S3\\b")
        && matches(output, "(?i)Detected flash size:\\s*16\\s*MB\\b"), "芯片或容量与 16 MB 固件不符")
    guard let mac = capture(output, "(?im)^MAC:\\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})\\s*$") else {
      throw Failure("未读到 ESP32 MAC")
    }
    return mac.uppercased()
  }
  static func identify(_ port: String, _ ct: Cancellation) throws -> String {
    try parseIdentity(run("flash-id", port, [], ct, timeout: 45))
  }
  static func progress(_ text: String) -> Int {
    guard let n = capture(text, "(?i)Writing at\\s+0x[0-9a-f]+[^\\r\\n]*?\\b(\\d+(?:\\.\\d+)?)%"),
      let value = Double(n), (0...100).contains(value)
    else { return 0 }
    return Int(ceil(value))
  }
  static func writeVerified(_ text: String) -> Bool {
    matches(text, "(?m)^Wrote 16777216 bytes\\b") && text.contains("Hash of data verified.")
  }
  static func digestVerified(_ text: String) -> Bool {
    text.contains("Verifying 0x1000000 (16777216) bytes at 0x00000000 in flash")
      && text.contains("Verification successful (digest matched).")
  }
  static func flash(
    resolve: () throws -> String, file: URL, image: Data, ct: Cancellation,
    progress update: (Int, String) -> Void, stage: (String, String) -> Void
  ) throws {
    try validate(image)
    let current = try Data(contentsOf: file)
    try require(current.sha256 == image.sha256, "本批次固件快照已改变，未写入")
    let port = try resolve()
    let logURL = file.deletingLastPathComponent().appendingPathComponent(
      "esptool-\(UUID().uuidString).log")
    try Disk.atomic(logURL, Data())
    let log = try FileHandle(forWritingTo: logURL)
    defer { try? log.close() }
    var last = 0
    func record(_ line: String) throws {
      try log.write(contentsOf: Data((timestamp() + " " + line + "\n").utf8))
    }
    let options = [
      "--flash-mode", "keep", "--flash-freq", "keep", "--flash-size", "keep", "0x0", file.path,
    ]
    update(1, "启动乐鑫官方 esptool")
    let output = try run(
      "write-flash", port, options, ct, timeout: 600, before: "no-reset",
      started: { stage("started", "乐鑫 esptool 已启动") }
    ) { line in
      try record(line)
      let p = progress(line)
      if p > last {
        last = p
        stage("writing", "收到 Flash 数据块回执")
        update(min(95, max(2, p)), p >= 100 ? "数据已发送 · 等待 Flash 写入完成" : "正在写入 · \(p)% · esptool")
      } else if line.contains("Connecting") {
        stage("connecting", "连接 ROM 下载器")
        update(1, "连接官方 ROM 下载器")
      } else if line.contains("stub flasher") || line.contains("Stub running") {
        stage("stub", "准备官方烧录程序")
      } else if line.contains("Compressed ") || line.contains("Flash will be erased") {
        stage("preparing", "准备擦除与压缩写入")
        update(max(1, last), "准备擦除 / 压缩写入")
      } else if line.contains("Verifying written data") {
        stage("verify", "数据已写入，正在校验 Flash")
        update(96, "数据传输完成 · 校验 Flash")
      }
    }
    try require(writeVerified(output), "未确认完整 16 MB 写入和 MD5 成功")
    update(97, "写入校验通过 · 独立复核完整 16 MB")
    let verify = try run("verify-flash", try resolve(), options, ct, timeout: 90, before: "no-reset", line: record)
    try require(digestVerified(verify), "完整 Flash MD5 未确认一致")
    stage("complete", "完整 16 MB 写入与独立 MD5 校验通过")
    update(100, "完整 MD5 校验通过 · esptool 5.6.0")
  }
  static func reset(_ path: String, _ ct: Cancellation) throws {
    _ = try run("read-mac", path, [], ct, timeout: 45, after: "hard-reset")
  }
}
