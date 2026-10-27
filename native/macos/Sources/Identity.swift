import Foundation

struct PortNotReady: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}
enum DeviceIdentity {
  static func isML307H(_ reply: String) -> Bool {
    reply.components(separatedBy: .newlines).contains {
      $0.trimmingCharacters(in: .whitespaces).uppercased() == "ML307H"
    }
  }
  // A new board has factory firmware; its actual model must match before first programming.
  static func modemVersion(command: (String) throws -> String) throws -> String {
    try require(isML307H(try command("AT+CGMM")), "模块型号不是 ML307H 或型号未确认，未开始写入")
    return try command("AT+CGMR")
  }
  static func flashIdentity(
    read: () throws -> (String, String), command: (String, Double) throws -> String,
    status: (String) -> Void = { _ in }
  ) throws -> (String, String) {
    let initial = try read()
    guard initial.1.lowercased().contains("ringhi") else { return initial }
    func slot() throws -> Int {
      let reply = try command("AT^SIMSLOT?", 5)
      let values = reply.components(separatedBy: .newlines).compactMap {
        capture($0, #"^\s*\^SIMSLOT:\s*([01])\s*$"#)
      }
      try require(values.count == 1, "未确认 ML307 当前卡槽，尚未开始写入")
      return Int(values[0])!
    }
    if try slot() == 1 {
      status("恢复主卡槽 · 重新核对设备身份")
      _ = try command("AT^SIMSLOT=0", 10)
      _ = try command("AT^AEM=1,\"ACT\"", 15)
      try require(try slot() == 0, "ML307 主卡槽恢复未确认，尚未开始写入")
      return try read()
    }
    return initial
  }
  static func flashIdentity(_ wire: Wire, _ ct: Cancellation) throws -> (String, String) {
    try flashIdentity(read: {
      let version = try modemVersion { try AT.command(wire, $0, ct) }
      return (try AT.imei(wire, ct), version)
    }, command: { try AT.command(wire, $0, ct, timeout: $1) })
  }
  static func beforePortOpened(_ message: String) -> Bool {
    matches(message, #"(?im)^(?:ERROR: )?A fatal error occurred: Could not open /dev/cu\.[^\r\n,]+, the port is busy or doesn't exist\."#)
      && !matches(message, #"(?im)Connecting|Connected to|Uploading stub|Writing at|Wrote |Hash of data verified"#)
  }
  // Only identity reads may retry. The caller must resolve the same board and connection generation.
  static func readESP(
    resolve: () throws -> String, identify: (String) throws -> String, ct: Cancellation,
    status: (String) -> Void, attempts: Int = 6, delay: Double = 0.5
  ) throws -> String {
    var attempt = 0
    while true {
      try ct.check()
      do { return try identify(resolve()) }
      catch {
        try ct.check()
        guard error is PortNotReady || beforePortOpened(error.localizedDescription) else { throw error }
        attempt += 1
        guard attempt < attempts else {
          throw Failure("ESP32 端口仍未就绪或被占用，请保持连接并关闭占用串口的软件；尚未开始写入。\n" + error.localizedDescription)
        }
        status("等待 ESP32 端口恢复 · \(attempt)/\(attempts) · 尚未写入")
        try ct.sleep(delay)
      }
    }
  }
}
