import Combine
import Foundation
import Darwin

struct TimelineEvent: Codable {
  var time: String
  var chip: String
  var phase: String
  var message: String
}
struct BoardState: Codable {
  var id = UUID().uuidString, number = 0, hub = "", epoch = "", espKey = "", mlKey = "", mac = "",
    imei = "", connected = true, startedAt = timestamp(), endedAt = "", espFirmware = "",
    mlFirmware = "", espProgress = 0, mlProgress = 0, espState = "等待配对", mlState = "等待配对",
    production = "未执行", cloud = "未登记", result = "等待", reason = "", backup = "", runID = "",
    espStartedAt = "", espWritingAt = "", espCompletedAt = "", mlStartedAt = "", mlWritingAt = "",
    mlCompletedAt = "", events: [TimelineEvent] = []
}
final class Board: ObservableObject, Identifiable {
  let id: String
  let ct = Cancellation()
  private let lock = NSLock()
  private var value: BoardState
  init(_ s: BoardState) {
    value = s
    id = s.id
  }
  var state: BoardState { lock.with { value } }
  func change(_ body: (inout BoardState) -> Void) {
    lock.with { body(&value) }
    DispatchQueue.main.async { self.objectWillChange.send() }
  }
  func record(_ chip: String, _ phase: String, _ message: String) {
    let added = lock.with { () -> Bool in
      if value.events.contains(where: { $0.chip == chip && $0.phase == phase }) { return false }
      let time = timestamp()
      value.events.append(TimelineEvent(time: time, chip: chip, phase: phase, message: message))
      switch (chip, phase) {
      case ("ESP32", "started"): value.espStartedAt = time
      case ("ESP32", "writing"): value.espWritingAt = time
      case ("ESP32", "complete"): value.espCompletedAt = time
      case ("ML307H", "started"): value.mlStartedAt = time
      case ("ML307H", "writing"): value.mlWritingAt = time
      case ("ML307H", "complete"): value.mlCompletedAt = time
      default: break
      }
      return true
    }
    if added { DispatchQueue.main.async { self.objectWillChange.send() } }
  }
}
struct Configuration {
  var espName = ""
  var mode = "dual", limit = 2, production = true, project = 0
  var espURL: URL, mlURL: URL, backup: URL
  var esp = Data()
  var pkg: MLPackage?
  var authorization: ProjectAuthorization? = nil
}
enum CSV {
  static func create(_ url: URL) throws {
    let descriptor = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
    try require(descriptor >= 0, "请新建 CSV 文件；所选文件已存在或目录不可写")
    let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    defer { try? file.close() }
    let header = bytes([])
    try file.write(contentsOf: header)
    try file.synchronize()
    try require(try Data(contentsOf: url) == header, "CSV 写入校验失败，未开始批次")
  }

  static let fields = [
    "任务号", "任务ID", "ESP32 MAC", "ML307 IMEI", "USB Hub", "仍接入", "开始时间 UTC", "完成时间 UTC", "ESP32 固件",
    "ML307 固件", "ESP32 进度", "ESP32 状态", "ML307 进度", "ML307 状态", "产测", "云端登记及上传", "整板结果", "原因",
    "备份路径", "产测轮次", "ESP32 引擎启动 UTC", "ESP32 首次写入回执 UTC", "ESP32 校验完成 UTC", "ML307 开始执行 UTC",
    "ML307 首次写入回执 UTC", "ML307 激活核验完成 UTC",
  ]
  static func cell(_ text: String, identifier: Bool = false) -> String {
    var value = text
    if identifier
      || "=+-@".contains(value.trimmingCharacters(in: .whitespacesAndNewlines).first ?? " ")
    {
      value = "'" + value
    }
    return "\"" + value.replacingOccurrences(of: "\"", with: "\"\"") + "\""
  }
  static func bytes(_ rows: [BoardState]) -> Data {
    var lines = [fields.map { cell($0) }.joined(separator: ",")]
    for s in rows {
      let values = [
        String(s.number), s.id, s.mac, s.imei, s.hub, String(s.connected), s.startedAt, s.endedAt,
        s.espFirmware, s.mlFirmware, String(s.espProgress), s.espState, String(s.mlProgress),
        s.mlState, s.production, s.cloud, s.result, s.reason, s.backup, s.runID, s.espStartedAt,
        s.espWritingAt, s.espCompletedAt, s.mlStartedAt, s.mlWritingAt, s.mlCompletedAt,
      ]
      lines.append(
        values.enumerated().map { cell($0.element, identifier: $0.offset == 2 || $0.offset == 3) }
          .joined(separator: ","))
    }
    return Data([0xef, 0xbb, 0xbf]) + Data((lines.joined(separator: "\r\n") + "\r\n").utf8)
  }
}
final class Batch {
  let id = DateFormatter.batch.string(from: Date()) + "-" + UUID().uuidString
  let config: Configuration
  let spark: Spark
  let csv: URL
  let folder: URL
  private let lock = NSLock(), saveLock = NSLock()
  private let scanner = DispatchQueue(label: "RingHi.scan")
  private var timer: DispatchSourceTimer?
  private var rows: [Board] = [], current: [String: Board] = [:], active = Set<String>(),
    leased = Set<String>(), acceptingValue = true, closed = false, lastSave = Date.distantPast
  private var failure = ""
  var changed: () -> Void = {}
  var executor: ((Board) throws -> Void)?
  let scanHardware: Bool
  var boards: [Board] { lock.with { rows } }
  var busy: Bool { lock.with { !active.isEmpty } }
  var accepting: Bool { lock.with { acceptingValue } }
  var error: String { lock.with { failure } }
  init(_ config: Configuration, _ spark: Spark, _ csv: URL, scanHardware: Bool = true, startImmediately: Bool = true) throws {
    if scanHardware && config.mode != "esp" {
      guard let authorization = config.authorization else { throw Failure("请先准备本批次授权") }
      try authorization.requireReady(project: config.project, username: spark.username)
    }
    self.csv = csv
    self.spark = spark.snapshot()
    self.scanHardware = scanHardware
    folder = Disk.root.appendingPathComponent("batches/\(id)")
    var frozen = config
    frozen.espName = config.espURL.lastPathComponent
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    if !config.esp.isEmpty {
      frozen.espURL = folder.appendingPathComponent("esp32.bin")
      try Disk.verified(frozen.espURL, config.esp)
    }
    self.config = frozen
    try save()
    if scanHardware && startImmediately { startScanning() }
  }
  func startScanning() {
    if scanHardware && timer == nil {
      let t = DispatchSource.makeTimerSource(queue: scanner)
      t.schedule(deadline: .now() + 0.2, repeating: 0.5)
      t.setEventHandler { [weak self] in self?.scan() }
      timer = t
      t.resume()
    }
  }
  func notify() { DispatchQueue.main.async { self.changed() } }
  func scan() {
    guard !lock.with({ closed }) else { return }
    do {
      let devices = try Inventory.snapshot()
      observe(devices)
      if Date().timeIntervalSince(lastSave) > 1 {
        try save()
        lastSave = Date()
      }
    } catch {
      lock.with {
        failure = "扫描 / CSV 保存失败，已停止接收：" + error.localizedDescription
        acceptingValue = false
      }
      notify()
    }
  }
  func observe(_ devices: [USBDevice]) {
    let pairs = Inventory.pairs(devices, mode: config.mode)
    let hubs = Dictionary(
      devices.filter { $0.kind == 9 }.map { ($0.key, $0.epoch) }, uniquingKeysWith: { a, _ in a })
    var start: [Board] = []
    lock.with {
      for (key, b) in current where hubs[key] != b.state.epoch {
        b.change { $0.connected = false }
        b.ct.cancel()
        if !active.contains(b.id) && b.state.endedAt.isEmpty { terminal(b, "未开始", "设备已拔出，未写入") }
        current.removeValue(forKey: key)
      }
      if acceptingValue && !closed {
        for pair in pairs {
          var b = current[pair.hub]
          if b == nil {
            var s = BoardState()
            s.number = rows.count + 1
            s.hub = pair.hub
            s.epoch = pair.epoch
            s.espFirmware = config.espName
            s.mlFirmware = config.mlURL.lastPathComponent
            b = Board(s)
            rows.append(b!)
            current[pair.hub] = b!
          }
          guard let row = b, row.state.endedAt.isEmpty, !active.contains(row.id) else { continue }
          row.change {
            $0.espKey = pair.esp?.key ?? ""
            $0.mlKey = pair.ml?.key ?? ""
            $0.result = pair.ready ? "排队" : "等待配对"
            $0.reason = pair.ready ? "端口已配对，等待空闲通道" : pair.reason
          }
          if pair.ready && active.count < config.limit && !leased.contains(pair.hub) {
            active.insert(row.id)
            leased.insert(pair.hub)
            start.append(row)
          }
        }
      }
    }
    for b in start { Thread.detachNewThread { self.execute(b) } }
    notify()
  }
  private func execute(_ b: Board) {
    defer {
      lock.with {
        active.remove(b.id)
        leased.remove(b.state.hub)
      }
      do { try save() } catch {
        lock.with {
          failure = "CSV 保存失败，已停止接收：" + error.localizedDescription
          acceptingValue = false
        }
      }
      notify()
    }
    do {
      try b.ct.check()
      b.change {
        $0.result = "身份检查"
        $0.reason = "核对 MAC、IMEI 和所选固件"
      }
      if let executor {
        try executor(b)
      } else {
        try BoardFlow.run(
          b, config, spark, resolve: { role, download in try self.resolve(b, role, download) })
      }
      try b.ct.check()
      terminal(b, "成功", config.production ? "双芯、授权、产测与云端确认完成" : "所选芯片烧录完成；本批次未启用产测")
    } catch { terminal(b, b.ct.cancelled ? "已中断" : "失败", error.localizedDescription) }
  }
  private func terminal(_ b: Board, _ result: String, _ why: String) {
    b.change {
      $0.result = result
      $0.reason = why
      $0.endedAt = timestamp()
      if result != "成功" {
        if $0.espProgress < 100 && !$0.espState.hasPrefix("失败") {
          $0.espState = "未完成 · " + $0.espState
        }
        if $0.mlProgress < 100 && !$0.mlState.hasPrefix("失败") { $0.mlState = "未完成 · " + $0.mlState }
      }
    }
  }
  func resolve(_ b: Board, _ role: String, _ download: Bool) throws -> USBDevice {
    try b.ct.check()
    let s = b.state
    try require(s.connected, "设备连接已变化")
    let inventory = try Inventory.snapshot()
    try require(
      inventory.contains { $0.kind == 9 && $0.key == s.hub && $0.epoch == s.epoch },
      "原板载 Hub 已断开或被替换")
    let matches = inventory.filter {
      $0.key == (role == "esp" ? s.espKey : s.mlKey)
        && $0.vendor == (role == "esp" ? 0x303a : 0x3563)
        && $0.product == (role == "esp" ? 0x1001 : download ? 0x1000 : 0x2000)
    }
    if matches.isEmpty { throw PortNotReady(message: "目标 \(role) 接口未就绪，未打开其他接口") }
    try require(matches.count == 1, "目标 \(role) 接口不唯一，未打开其他接口")
    if role == "esp" {
      if matches[0].paths.isEmpty { throw PortNotReady(message: "目标 ESP32 串口尚未就绪") }
      try require(matches[0].paths.count == 1, "目标 ESP32 串口不唯一，未打开其他串口")
    }
    return matches[0]
  }
  func stop() {
    lock.with {
      acceptingValue = false
      for b in rows where !active.contains(b.id) && b.state.endedAt.isEmpty {
        terminal(b, "未开始", "已停止接收，未写入")
      }
    }
    try? save()
    notify()
  }
  func resume() throws {
    try require(!lock.with { closed }, "批次已关闭，请开启新批次")
    try require(error.isEmpty, "请先解决扫描 / CSV 保存问题")
    lock.with {
      acceptingValue = true
      for b in rows where b.state.connected && b.state.result == "未开始" && !active.contains(b.id) {
        b.change {
          $0.result = "等待"
          $0.reason = ""
          $0.endedAt = ""
        }
      }
    }
    if scanHardware { scanner.async { self.scan() } }
    notify()
  }
  func save() throws {
    try saveLock.with {
      let snapshots = boards.map { $0.state }
      try Disk.atomic(
        folder.appendingPathComponent("records.json"), JSONEncoder().encode(snapshots))
      try Disk.atomic(csv, CSV.bytes(snapshots))
    }
  }
  func export(_ target: URL) throws {
    try saveLock.with { try Disk.atomic(target, CSV.bytes(boards.map { $0.state })) }
  }
  func finish() throws {
    lock.with {
      acceptingValue = false
      closed = true
      for b in rows where b.state.endedAt.isEmpty {
        b.ct.cancel()
        if !active.contains(b.id) { terminal(b, "未开始", "已关闭软件，未写入") }
      }
    }
    timer?.cancel()
    timer = nil
    let deadline = Date().addingTimeInterval(35)
    while busy && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
    try require(!busy, "设备任务尚未释放，请稍后重试关闭；CSV 已保留")
    try save()
    config.authorization?.release()
    notify()
  }
  deinit { timer?.cancel(); config.authorization?.release() }
}
extension DateFormatter {
  static var batch: DateFormatter {
    let f = DateFormatter()
    f.dateFormat = "yyyyMMdd-HHmmss"
    f.locale = Locale(identifier: "en_US_POSIX")
    return f
  }
}
