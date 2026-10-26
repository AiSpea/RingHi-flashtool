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
