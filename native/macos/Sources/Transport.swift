import Darwin
import Foundation
import IOKit
import IOKit.serial

struct USBDevice: Equatable {
  var key: String
  var parent: String
  var vendor: Int
  var product: Int
  var kind: Int
  var epoch: String
  var paths: [String] = []
}
struct DevicePair {
  var hub: String
  var epoch: String
  var esp: USBDevice?
  var ml: USBDevice?
  var reason: String
  var ready: Bool { reason.isEmpty }
}
enum Inventory {
  static func key(_ location: UInt32) -> String {
    let ports = stride(from: 20, through: 0, by: -4).map { Int((location >> $0) & 15) }.filter {
      $0 != 0
    }
    return "\(location>>24):" + ports.map(String.init).joined(separator: ".")
  }
  static func property(_ service: io_registry_entry_t, _ name: String) -> Any? {
    IORegistryEntryCreateCFProperty(service, name as CFString, kCFAllocatorDefault, 0)?
      .takeRetainedValue()
  }
  static func each(_ name: String, _ body: (io_object_t) -> Void) {
    var iterator: io_iterator_t = 0
    guard
      IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching(name), &iterator)
        == KERN_SUCCESS
    else { return }
    defer { IOObjectRelease(iterator) }
    while true {
      let service = IOIteratorNext(iterator)
      if service == 0 { break }
      body(service)
      IOObjectRelease(service)
    }
  }
  static func snapshot() throws -> [USBDevice] {
    var serial: [String: [String]] = [:]
    var epochs: [String: String] = [:]
    each("IOUSBHostDevice") { service in
      if let location = property(service, "locationID") as? NSNumber {
        var id: UInt64 = 0
        if IORegistryEntryGetRegistryEntryID(service, &id) == KERN_SUCCESS {
          epochs[key(location.uint32Value)] = String(id)
        }
      }
    }
    each("IOSerialBSDClient") { service in
      guard let path = property(service, "IOCalloutDevice") as? String, path.hasPrefix("/dev/cu.")
      else { return }
      var node = service
      IOObjectRetain(node)
      defer { IOObjectRelease(node) }
      for _ in 0..<24 {
        if let location = property(node, "locationID") as? NSNumber,
          property(node, "idVendor") != nil
        {
          serial[key(location.uint32Value), default: []].append(path)
          break
        }
        var parent: io_registry_entry_t = 0
        if IORegistryEntryGetParentEntry(node, kIOServicePlane, &parent) != KERN_SUCCESS { break }
        IOObjectRelease(node)
        node = parent
      }
    }
    var raw = Array(repeating: RHDevice(), count: 256)
    var error = Array(repeating: CChar(0), count: 512)
    let n = rh_usb_scan(&raw, Int32(raw.count), &error, Int32(error.count))
    try require(n >= 0, "USB 枚举失败：" + String(cString: error))
    func string<T>(_ tuple: T) -> String {
      withUnsafePointer(to: tuple) {
        $0.withMemoryRebound(to: CChar.self, capacity: 64) { String(cString: $0) }
      }
    }
    return raw.prefix(Int(n)).map {
      let key = string($0.key)
      return USBDevice(
        key: key, parent: string($0.parent), vendor: Int($0.vendor), product: Int($0.product),
        kind: Int($0.kind), epoch: epochs[key] ?? "address-\($0.address)",
        paths: Array(Set(serial[key] ?? [])).sorted())
    }
  }
  static func pairs(_ devices: [USBDevice], mode: String) -> [DevicePair] {
    let chips = devices.filter { $0.vendor == 0x3563 || $0.vendor == 0x303a }
    let grouped = Dictionary(grouping: chips, by: { $0.parent })
    return grouped.keys.sorted().map { key in
      let nodes = grouped[key]!
      let hubs = devices.filter { $0.kind == 9 && $0.key == key }
      let esps = nodes.filter { $0.vendor == 0x303a && $0.product == 0x1001 }
      let mls = nodes.filter { $0.vendor == 0x3563 }
      var reason = ""
      if hubs.count != 1 {
        reason = "未发现独立板载 Hub"
      } else if esps.count > 1 || mls.count > 1 {
        reason = "同一 Hub 下芯片不唯一，未打开端口"
      } else if mode != "ml" && esps.count != 1 {
        reason = "等待 ESP32"
      } else if mode != "esp" && mls.count != 1 {
        reason = "等待 ML307H"
      } else if mode != "esp" && mls.first?.product != 0x2000 {
        reason = "ML307H 已在下载模式，请核对原备份后恢复"
      } else if mode != "ml" && esps.first?.paths.count != 1 {
        reason = "等待唯一 ESP32 串口"
      }
      return DevicePair(
        hub: key, epoch: hubs.first?.epoch ?? "missing", esp: esps.first, ml: mls.first,
        reason: reason)
    }
  }
}
protocol Wire: AnyObject {
  func write(_ data: Data, _ ct: Cancellation) throws
  func read(_ timeout: Int, _ ct: Cancellation) throws -> Data
  func clear(_ ct: Cancellation) throws
  func close()
}
extension Wire {
  func clear(_ ct: Cancellation) throws {
    var total = 0
    for _ in 0..<20 {
      let bytes = try read(2, ct)
      if bytes.isEmpty { return }
      total += bytes.count
      try require(total <= 65536, "设备输入缓冲超过限制")
    }
  }
}
final class USBWire: Wire {
  private var handle: UnsafeMutableRawPointer?
  init(_ device: USBDevice, download: Bool) throws {
    try require(
      device.vendor == 0x3563 && device.product == (download ? 0x1000 : 0x2000), "ML307 USB 模式不符")
    var error = Array(repeating: CChar(0), count: 512)
    handle = device.key.withCString {
      rh_usb_open($0, Int32(device.product), download ? 0 : 4, &error, Int32(error.count))
    }
    try require(handle != nil, "无法打开 ML307 USB：" + String(cString: error))
  }
  func read(_ timeout: Int, _ ct: Cancellation) throws -> Data {
    try ct.check()
    guard let handle else { throw Failure("USB 已关闭") }
    var b = Array(repeating: UInt8(0), count: 8192)
    let n = rh_usb_read(handle, &b, Int32(b.count), Int32(max(1, min(timeout, 200))))
    try require(n >= 0, "USB 接收失败：" + String(cString: rh_usb_error(n)))
    try ct.check()
    return Data(b.prefix(Int(n)))
  }
  func write(_ data: Data, _ ct: Cancellation) throws {
    try ct.check()
    guard let handle else { throw Failure("USB 已关闭") }
    let n = data.withUnsafeBytes {
      rh_usb_write(handle, $0.bindMemory(to: UInt8.self).baseAddress, Int32(data.count))
    }
    try require(n == data.count, "USB 写入未确认，未自动重发：" + String(cString: rh_usb_error(n)))
    try ct.check()
  }
  func close() {
    if let handle {
      rh_usb_close(handle)
      self.handle = nil
    }
  }
  deinit { close() }
}
final class SerialWire: Wire {
  private var fd: Int32 = -1
  init(_ path: String) throws {
    try require(path.hasPrefix("/dev/cu.") && !path.contains("\n"), "串口路径无效")
    fd = path.withCString { rh_serial_open($0) }
    try require(fd >= 0, "串口无法打开或被占用：\(path)")
  }
  func read(_ timeout: Int, _ ct: Cancellation) throws -> Data {
    try ct.check()
    try require(fd >= 0, "串口已关闭")
    var b = Array(repeating: UInt8(0), count: 8192)
    let n = rh_serial_read(fd, &b, Int32(b.count), Int32(max(1, min(timeout, 200))))
    try require(n >= 0, "串口断开或读取失败")
    try ct.check()
    return Data(b.prefix(Int(n)))
  }
  func write(_ data: Data, _ ct: Cancellation) throws {
    try ct.check()
    try require(fd >= 0, "串口已关闭")
    let n = data.withUnsafeBytes {
      rh_serial_write(fd, $0.bindMemory(to: UInt8.self).baseAddress, Int32(data.count))
    }
    try require(n == data.count, "串口写入未确认，未自动重发")
    try ct.check()
  }
  func close() {
    if fd >= 0 {
      Darwin.close(fd)
      fd = -1
    }
  }
  deinit { close() }
}
enum AT {
  static func command(
    _ wire: Wire, _ command: String, _ ct: Cancellation, timeout: Double = 5,
    disconnectOK: Bool = false
  ) throws -> String {
    try wire.clear(ct)
    try wire.write(Data((command + "\r").utf8), ct)
    let end = Date().addingTimeInterval(timeout)
    var bytes = Data()
    while Date() < end {
      do { bytes.append(try wire.read(200, ct)) } catch {
        try ct.check()
        if disconnectOK { return String(decoding: bytes, as: UTF8.self) }
        throw error
      }
      try require(bytes.count <= 65536, "AT 响应过长")
      let value = String(decoding: bytes, as: UTF8.self)
      for line in value.components(separatedBy: .newlines).map({
        $0.trimmingCharacters(in: .whitespaces)
      }) {
        if line == "OK" { return value }
        if line == "ERROR" || line.hasPrefix("+CME ERROR:") || line.hasPrefix("+CMS ERROR:") {
          throw Failure("设备拒绝命令：\(command)")
        }
      }
    }
    if disconnectOK { return String(decoding: bytes, as: UTF8.self) }
    throw Failure("AT 响应超时：\(command)")
  }
  static func imei(_ wire: Wire, _ ct: Cancellation) throws -> String {
    let value = try command(wire, "AT+CGSN=1", ct)
    guard let id = capture(value, "(?<!\\d)(\\d{15})(?!\\d)") else { throw Failure("未读到有效 IMEI") }
    return id
  }
}
