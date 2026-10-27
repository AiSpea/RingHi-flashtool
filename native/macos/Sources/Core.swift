import CryptoKit
import Darwin
import Foundation

struct Failure: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
  if try !condition() { throw Failure(message) }
}
extension NSLock {
  func with<T>(_ body: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try body()
  }
}
final class Cancellation {
  private let lock = NSLock()
  private var value = false
  var cancelled: Bool { lock.with { value } }
  func cancel() { lock.with { value = true } }
  func check() throws { if cancelled { throw Failure("操作已取消；未确认完整烧录") } }
  func sleep(_ seconds: Double) throws {
    let end = Date().addingTimeInterval(seconds)
    repeat {
      try check()
      Thread.sleep(forTimeInterval: min(0.05, max(0, end.timeIntervalSinceNow)))
    } while Date() < end
  }
}
typealias Object = [String: Any]
func text(_ o: Object, _ key: String) -> String {
  if let s = o[key] as? String { return s }
  if let n = o[key] as? NSNumber { return n.stringValue }
  return ""
}
func bool(_ o: Object, _ key: String) -> Bool { (o[key] as? Bool) == true }
func object(_ o: Object, _ key: String) -> Object { o[key] as? Object ?? [:] }
func json(_ data: Data) throws -> Object {
  guard let d = try JSONSerialization.jsonObject(with: data) as? Object else {
    throw Failure("响应不是 JSON 对象")
  }
  return d
}
func matches(_ s: String, _ pattern: String) -> Bool {
  s.range(of: pattern, options: .regularExpression) != nil
}
func capture(_ s: String, _ pattern: String) -> String? {
  guard let r = try? NSRegularExpression(pattern: pattern),
    let m = r.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), m.numberOfRanges > 1,
    let range = Range(m.range(at: 1), in: s)
  else { return nil }
  return String(s[range])
}
func timestamp() -> String { ISO8601DateFormatter.fractional.string(from: Date()) }
extension ISO8601DateFormatter {
  static var fractional: ISO8601DateFormatter {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }
}
extension Data {
  var sha256: String { SHA256.hash(data: self).map { String(format: "%02x", $0) }.joined() }
  var md5: String { Insecure.MD5.hash(data: self).map { String(format: "%02x", $0) }.joined() }
  var hex: String { map { String(format: "%02x", $0) }.joined() }
  func uint(_ offset: Int, _ count: Int) -> UInt64 {
    (0..<count).reduce(0) { $0 | UInt64(self[offset + $1]) << ($1 * 8) }
  }
  static func le(_ n: UInt64, _ count: Int) -> Data {
    Data((0..<count).map { UInt8(truncatingIfNeeded: n >> ($0 * 8)) })
  }
}
enum Disk {
  static let version = "0.4.9"
  static let legacy = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
    "Library/Application Support/ringhi-flasher")
  static var root = legacy.appendingPathComponent("native-macos")
  static func atomic(_ url: URL, _ data: Data) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }
  static func save(_ url: URL, _ value: Any) throws {
    try atomic(
      url, JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .prettyPrinted]))
  }
  static func verified(_ url: URL, _ data: Data) throws {
    try atomic(url, data)
    let check = try Data(contentsOf: url)
    try require(check.sha256 == data.sha256, "备份重新读取校验失败")
  }
  static func load(_ url: URL) throws -> Object { try json(Data(contentsOf: url)) }
}
