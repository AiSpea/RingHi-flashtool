import Foundation

struct Partition {
  var name: String
  var type: String
  var target: String
  var offset: Int
  var size: Int
  var address: UInt64
  var capacity: UInt64
  var selected: Int
  var backup: Int
}
struct MLPackage {
  let raw: Data
  let project: String
  let version: String
  let digest: String
  let entries: [Partition]
  var loaders: [Partition] { entries.filter { ["MDL", "DL"].contains($0.type) } }
  var writes: [Partition] {
    entries.filter { $0.type == "CODE" && $0.selected == 1 && $0.size > 0 }
  }
  var protected: [Partition] {
    entries.filter {
      $0.type == "CODE"
        && ($0.backup == 1 || ["calibration", "factory", "factory_bak"].contains($0.name))
    }
  }
  func payload(_ p: Partition) -> Data { raw.subdata(in: p.offset..<p.offset + p.size) }
  init(_ b: Data) throws {
    try require((136...64 * 1024 * 1024).contains(b.count), "PKG 文件大小无效")
    try require(
      b.uint(0, 4) == 0x5c6d_8e9f && b.uint(4, 4) == 1 && b.uint(8, 8) == b.count, "PKG 格式或总长度不符")
    func str(_ at: Int, _ n: Int) throws -> String {
      let d = b.subdata(in: at..<at + n)
      guard let end = d.firstIndex(of: 0), let s = String(data: d.prefix(end), encoding: .utf8)
      else { throw Failure("PKG 字符串缺少结束符或编码无效") }
      return s
    }
    let project = try str(16, 32)
    let version = try str(48, 32)
    let offset = Int(b.uint(80, 4))
    let count = Int(b.uint(84, 4))
    let auth = Int(b.uint(88, 4))
    let end = offset + count * 464
    try require(project == "ringhi", "仅接受 RingHi 项目固件")
    try require(
      offset >= 136 && (1...128).contains(count) && end <= b.count && auth <= 2, "PKG 分区表越界或校验类型无效")
    let payload = b.subdata(in: offset..<b.count)
    if auth == 1 {
      try require(
        payload.md5 == String(decoding: b.subdata(in: 96..<128), as: UTF8.self).lowercased(),
        "PKG MD5 校验失败")
    }
    if auth == 2 { try require(UInt64(MLProtocol.crc(payload)) == b.uint(92, 4), "PKG CRC 校验失败") }
    var names = Set<String>()
    var targets = Set<String>()
    var entries: [Partition] = []
    var ranges: [(UInt64, UInt64)] = []
    var flash: [(UInt64, UInt64)] = []
    for i in 0..<count {
      let a = offset + i * 464
      let name = try str(a, 32)
      let type = try str(a + 32, 32)
      var target = try str(a + 352, 36)
      if target.isEmpty { target = name }
      let pos = b.uint(a + 320, 8)
      let size = b.uint(a + 328, 8)
      let address = b.uint(a + 336, 8)
      let capacity = b.uint(a + 344, 8)
      let flag = b.uint(a + 424, 4)
      let selected = b.uint(a + 428, 4)
      let backup = b.uint(a + 432, 4)
      try require(
        matches(name, "^[a-zA-Z0-9_]{1,35}$") && names.insert(name).inserted, "PKG 分区名无效或重复")
      try require(
        ["INIT", "MDL", "DL", "CODE"].contains(type) && flag <= 3 && selected <= 1 && backup <= 2,
        "PKG 未知分区标记")
      try require(flag & 2 == 0 || selected == 1, "PKG 必选镜像未选择")
      try require(pos <= Int.max && size <= Int.max, "PKG 镜像范围溢出")
      if size > 0 {
        try require(pos >= end && pos <= b.count && size <= UInt64(b.count) - pos, "PKG 镜像越界")
        ranges.append((pos, pos + size))
      }
      try require(type != "INIT" || size == 0, "INIT 含有镜像")
      try require(type == "CODE" || backup == 0, "Loader 备份标记异常")
      if ["MDL", "DL"].contains(type) {
        try require(size > 0 && selected == 1 && address <= UInt32.max, "Loader 无效")
      }
      if type == "CODE" {
        try require(
          matches(target, "^[a-zA-Z0-9_]{1,35}$") && targets.insert(target).inserted, "目标分区重复或无效")
        try require(
          capacity > 0 && capacity <= 64 * 1024 * 1024 && size <= capacity
            && (selected == 0 || size > 0) && address <= UInt64.max - capacity, "分区容量无效")
        flash.append((address, address + capacity))
      }
      entries.append(
        Partition(
          name: name, type: type, target: target, offset: Int(pos), size: Int(size),
          address: address, capacity: capacity, selected: Int(selected), backup: Int(backup)))
    }
    for range in [ranges, flash] {
      let sorted = range.sorted { $0.0 < $1.0 }
      if sorted.count > 1 {
        for i in 1..<sorted.count { try require(sorted[i].0 >= sorted[i - 1].1, "PKG 分区或镜像重叠") }
      }
    }
    self.raw = b
    self.project = project
    self.version = version
    self.digest = b.sha256
    self.entries = entries
    try require(loaders.map { $0.type } == ["MDL", "DL"], "需要顺序正确的 MDL、DL")
    try require(writes.last?.target == "mbl", "MBL 必须最后写入")
    for name in ["ap", "calibration", "factory"] {
      try require(
        entries.contains { $0.type == "CODE" && $0.name == name && $0.target == name },
        "缺少分区 \(name)")
    }
    try require(
      writes.contains { $0.name == "ap" }
        && protected.allSatisfy { $0.selected == 0 && $0.backup != 2 }, "AP 未选择或专属分区被覆盖")
    if let bak = entries.first(where: { $0.name == "factory_bak" }) {
      try require(
        bak.target == "factory_bak"
          && bak.capacity == entries.first(where: { $0.name == "factory" })?.capacity, "工厂备份容量不一致")
    }
  }
}
enum MLProtocol {
  static func crc(_ bytes: Data) -> UInt16 {
    var c: UInt32 = 0
    for b in bytes {
      c ^= UInt32(b) << 8
      for _ in 0..<8 { c = ((c << 1) ^ ((c & 0x8000 != 0) ? 0x1021 : 0)) & 0xffff }
    }
    return UInt16(c)
  }
  static func checksum(_ bytes: Data) -> UInt16 {
    var sum: UInt32 = 0
    for i in stride(from: 0, to: bytes.count, by: 2) {
      sum += UInt32(bytes[i]) + (i + 1 < bytes.count ? UInt32(bytes[i + 1]) << 8 : 0)
    }
    sum = (sum & 65535) + (sum >> 16)
    return ~UInt16(truncatingIfNeeded: (sum & 65535) + (sum >> 16))
  }
  static func frame(_ command: UInt16, _ bytes: Data, crc: Bool) throws -> Data {
    try require(bytes.count <= 65535, "下载帧过长")
    let body = Data.le(UInt64(command), 2) + Data.le(UInt64(bytes.count), 2) + bytes
    return Data.le(0x5c6d_8e9f, 4) + body
      + Data.le(UInt64(crc ? self.crc(body) : checksum(body)), 2) + Data([0x7e])
  }
  static func partition(_ name: String, _ size: UInt64) throws -> Data {
    try require(matches(name, "^[a-zA-Z0-9_]{1,35}$"), "分区名无效")
    var b = Data(repeating: 0, count: 88)
    let n = Data(
      name.utf16.flatMap { [UInt8(truncatingIfNeeded: $0), UInt8(truncatingIfNeeded: $0 >> 8)] })
    b.replaceSubrange(0..<n.count, with: n)
    b.replaceSubrange(72..<80, with: Data.le(size, 8))
    return b
  }
  static func decode(_ data: Data, crc: Bool) throws -> (UInt16, Data)? {
    if data.count < 11 { return nil }
    try require(data.uint(0, 4) == 0x5c6d_8e9f, "下载帧头异常")
    let n = Int(data.uint(6, 2)) + 11
    if data.count < n { return nil }
    try require(data.count == n, "下载回包附加数据异常")
    let body = data.subdata(in: 4..<n - 3)
    try require(
      data[n - 1] == 0x7e && data.uint(n - 3, 2) == UInt64(crc ? self.crc(body) : checksum(body)),
      "下载回包校验失败")
    return (UInt16(data.uint(4, 2)), data.subdata(in: 8..<n - 3))
  }
}
final class Download {
  let wire: Wire
  let ct: Cancellation
  var crc = true
  private(set) var broken = false
  var progress: (String, Int, Int) -> Void = { _, _, _ in }
  init(_ wire: Wire, _ ct: Cancellation) {
    self.wire = wire
    self.ct = ct
  }
  @discardableResult func send(
    _ command: UInt16, _ bytes: Data = Data(), timeout: Double = 60, accepted: [UInt16] = [0x80]
  ) throws -> (UInt16, Data) {
    try require(!broken, "下载状态未知，禁止继续发送")
    do {
      try wire.write(MLProtocol.frame(command, bytes, crc: crc), ct)
      let end = Date().addingTimeInterval(timeout)
      var data = Data()
      while Date() < end {
        data.append(try wire.read(200, ct))
        try require(data.count <= 65546, "下载回包过长")
        if let reply = try MLProtocol.decode(data, crc: crc) {
          try require(
            accepted.contains(reply.0), String(format: "命令 0x%02x 被拒绝，回包 0x%02x", command, reply.0))
          return reply
        }
      }
      throw Failure("下载应答超时，未自动重发")
    } catch {
      broken = true
      throw error
    }
  }
  func handshake(_ crc: Bool) throws {
    self.crc = crc
    try wire.write(Data([0x7e, 0x7e, 0x7e]), ct)
    let end = Date().addingTimeInterval(8)
    var buffer = Data()
    var banner = Data()
    while Date() < end {
      let incoming = try wire.read(200, ct)
      buffer.append(incoming)
      banner.append(incoming)
      try require(banner.count <= 65536, "握手回复过长")
      if crc && matches(String(decoding: banner, as: UTF8.self), "(?i)^\\s*HandshakeROM(?:\\s|$)") {
        try send(0, timeout: 5)
        return
      }
      while buffer.count >= 4 && buffer.uint(0, 4) != 0x5c6d_8e9f {
        buffer = Data(buffer.dropFirst())
      }
      if let r = try MLProtocol.decode(buffer, crc: crc) {
        try require(r.0 == 0x81, "下载握手阶段不符")
        try send(0, timeout: 5)
        return
      }
    }
    throw Failure("下载握手超时")
  }
  func image(_ start: Data, _ data: Data, _ name: String, chunk: Int) throws {
    try send(1, start)
    for i in stride(from: 0, to: data.count, by: chunk) {
      let n = min(chunk, data.count - i)
      try send(2, data.subdata(in: i..<i + n))
      progress(name, i + n, data.count)
    }
    try send(3)
  }
  func bootstrap(_ pkg: MLPackage) throws {
    try handshake(true)
    for e in pkg.loaders {
      try image(
        Data.le(e.address, 4) + Data.le(UInt64(e.size), 4), pkg.payload(e), e.name, chunk: 50)
      try send(4, timeout: 10)
      try handshake(false)
    }
  }
  func backup(_ p: Partition) throws -> Data {
    let r = try send(32, MLProtocol.partition(p.target, 0), accepted: [0x82]).1
    try require(r.count == 4 && r.uint(0, 4) == p.capacity, "备份容量与固件不符：\(p.name)")
    var b = Data()
    while b.count < Int(p.capacity) {
      let n = min(256, Int(p.capacity) - b.count)
      let part = try send(33, Data.le(UInt64(n), 4), accepted: [0x82]).1
      try require(part.count == n, "备份返回长度错误")
      b.append(part)
      progress("备份 " + p.name, b.count, Int(p.capacity))
    }
    try send(34)
    if p.name != "factory_bak" {
      try require(
        !b.prefix(16).allSatisfy { $0 == 0 } && !b.prefix(16).allSatisfy { $0 == 255 },
        "设备专属分区为空：\(p.name)")
    }
    return b
  }
  func write(_ name: String, _ b: Data) throws {
    try image(MLProtocol.partition(name, UInt64(b.count)), b, "写入 " + name, chunk: 256)
  }
  func reset() throws {
    try require(!broken, "下载已中断，不能确认复位")
    try wire.write(MLProtocol.frame(16, Data.le(0, 4), crc: false), ct)
  }
}
