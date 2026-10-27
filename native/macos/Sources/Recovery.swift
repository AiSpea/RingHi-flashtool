import Foundation

// A fresh task may resume the same chip/project, never a transport retry loop.
enum MLRecovery {
  static let stages: Set<String> = ["preparing", "device-preparing", "key-requesting", "device-writing", "third-party-requesting", "third-party-writing", "reporting"]
  static func checkLedger(_ old: Object, uid: String, project: Int) throws {
    if old.isEmpty { return }
    try require(text(old, "uid") == uid, "授权记录与实际芯片 UID 不一致")
    if text(old, "stage") != "complete" {
      try require(matches(uid, "^[a-f0-9]{16,128}$") && stages.contains(text(old, "stage"))
        && !text(old, "session").isEmpty && (old["project_id"] as? Int ?? 0) > 0, "原授权记录不完整，原备份已保留")
      try require(old["project_id"] as? Int == project, "恢复授权需选择原授权项目")
    }
  }
  static func ledger(_ uid: String) throws -> Object {
    let path = Disk.root.appendingPathComponent("activation/\(uid).json")
    return FileManager.default.fileExists(atPath: path.path) ? try Disk.load(path) : [:]
  }
  static func context(_ prior: Object, mac: String, digest: String, project: Int) throws -> Object {
    let uid = text(prior, "uid")
    let record = try ledger(uid)
    try checkLedger(record, uid: uid, project: project)
    try require(["activating", "awaiting-verification"].contains(text(prior, "phase"))
      && matches(uid, "^[a-f0-9]{16,128}$") && matches(text(prior, "imei"), "^[0-9]{15}$")
      && !text(prior, "backup").isEmpty && !record.isEmpty
      && text(record, "session") == text(prior, "backup")
      && record["project_id"] as? Int == project && text(prior, "mac") == mac
      && text(prior, "firmwareSha256") == digest, "恢复需使用同一设备、原授权项目、原固件和原备份")
    return record
  }
  static func validateBackups(_ prior: Object, _ pkg: MLPackage) throws {
    let root = URL(fileURLWithPath: text(prior, "backup")).resolvingSymlinksInPath().standardizedFileURL.path
    for p in pkg.protected {
      let meta = object(object(prior, "backups"), p.name)
      let url = URL(fileURLWithPath: text(meta, "file")).resolvingSymlinksInPath().standardizedFileURL
      try require(url.path.hasPrefix(root + "/"), "恢复文件不在原备份目录")
      let bytes = try Data(contentsOf: url)
      try require(bytes.count == p.capacity && bytes.sha256 == text(meta, "sha256"), "原备份校验失败：" + p.name)
    }
  }
  static func untouched(_ record: Object) -> Bool {
    text(record, "phase") == "preparing" && text(record, "uid").isEmpty
      && text(record, "lastWritten").isEmpty && object(record, "backups").isEmpty
  }
  static func date(_ value: String) throws -> Date {
    guard let date = ISO8601DateFormatter.fractional.date(from: value)
      ?? ISO8601DateFormatter().date(from: value) else { throw Failure("原记录时间无效，未写入") }
    return date
  }
  static func selectDownload(_ records: [Object], mac: String, digest: String,
    validate: (Object) throws -> Void) throws -> Object {
    try require(!mac.isEmpty && !records.isEmpty && records.allSatisfy { text($0, "mac") == mac }, "下载模式缺少原设备记录")
    if records.count == 1 {
      try require(text(records[0], "firmwareSha256") == digest && matches(text(records[0], "imei"), "^[0-9]{15}$"), "下载模式原固件或身份不匹配")
      return records[0]
    }
    let dated = try records.map { (try date(text($0, "createdAt")), $0) }.sorted { $0.0 < $1.0 }
    var current = dated.last!.1
    let reference: Object
    if text(current, "phase") == "verified" { reference = current }
    else if untouched(current) && !text(current, "previousBackup").isEmpty {
      reference = try Disk.load(URL(fileURLWithPath: text(current, "previousBackup")).appendingPathComponent("session.json"))
    } else { throw Failure("历史身份记录冲突，尚未确认同一芯片；原备份已保留") }
    let uid = text(reference, "uid")
    try require(text(reference, "phase") == "verified" && text(reference, "mac") == mac
      && text(reference, "imei") == text(current, "imei") && matches(text(current, "imei"), "^[0-9]{15}$")
      && matches(uid, "^[a-f0-9]{16,128}$") && text(reference, "firmwareSha256") == digest
      && records.allSatisfy { text($0, "firmwareSha256") == digest }, "历史身份/固件不一致，未写入")
    let confirmed = try date(text(reference, "verifiedAt"))
    for (created, older) in dated.dropLast() {
      try require(text(older, "uid") == uid && ["verified", "awaiting-verification"].contains(text(older, "phase"))
        && created < confirmed, "存在不同芯片或未确认的中断写入，未写入")
    }
    try validate(reference)
    let auth = try ledger(uid)
    try require(text(auth, "uid") == uid && text(auth, "stage") == "complete", "原授权尚未完成，未自动合并身份记录")
    current["recoveryUid"] = uid // Live ROM UID must match before any backup or Flash write.
    return current
  }
  static func downloadRecord(_ mac: String, _ pkg: MLPackage) throws -> Object {
    let folder = Disk.root.appendingPathComponent("ml-intents")
    let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
    let records = try files.filter { $0.pathExtension == "json" }.map { try Disk.load($0) }.filter { text($0, "mac") == mac }
    return try selectDownload(records, mac: mac, digest: pkg.digest) { try validateBackups($0, pkg) }
  }
  static func preflight(_ b: Board, _ cfg: Configuration, _ resolve: (String, Bool) throws -> USBDevice) throws -> String {
    guard let pkg = cfg.pkg else { throw Failure("缺少 ML307 固件") }
    var prior: Object = [:]
    var version = ""
    var runtime: USBDevice?
    do { runtime = try resolve("ml", false) } catch is PortNotReady { _ = try resolve("ml", true) }
    if let runtime {
      let wire = try USBWire(runtime, download: false); defer { wire.close() }
      let identity = try DeviceIdentity.flashIdentity(wire, b.ct)
      version = identity.1
      b.change { $0.imei = identity.0 }
      let path = Disk.root.appendingPathComponent("ml-intents/\(identity.0).json")
      if FileManager.default.fileExists(atPath: path.path) { prior = try Disk.load(path) }
      if !prior.isEmpty {
        try require(text(prior, "mac").isEmpty || text(prior, "mac") == b.state.mac, "IMEI 对应另一块板的记录，未开始写入")
        let phase = text(prior, "phase")
        let untouched = phase == "preparing" && text(prior, "uid").isEmpty && text(prior, "lastWritten").isEmpty && object(prior, "backups").isEmpty
        try require(untouched || ["verified", "activating", "awaiting-verification"].contains(phase), "存在中断写入，请保留原备份核对，未开始双芯写入")
      }
    } else {
      try require(!b.state.mac.isEmpty, "下载模式恢复必须先确认 ESP32 MAC")
      prior = try downloadRecord(b.state.mac, pkg)
      try require(untouched(prior) || ["verified", "activating", "awaiting-verification"].contains(text(prior, "phase")), "下载中断在写入/备份阶段，请保留原备份核对")
      b.change { $0.imei = text(prior, "imei") }
      version = text(prior, "versionBefore")
    }
    if ["activating", "awaiting-verification"].contains(text(prior, "phase")) {
      _ = try context(prior, mac: b.state.mac, digest: pkg.digest, project: cfg.project)
      try validateBackups(prior, pkg)
    } else if !text(prior, "uid").isEmpty || !text(prior, "recoveryUid").isEmpty {
      let old = try ledger(text(prior, "uid").isEmpty ? text(prior, "recoveryUid") : text(prior, "uid"))
      try require(old.isEmpty || text(old, "stage") == "complete", "上次授权未完成，请保留原备份")
    }
    return version
  }
  static func resume(_ b: Board, _ cfg: Configuration, _ auth: Activation, _ prior: Object,
    _ resolve: (String, Bool) throws -> USBDevice) throws {
    guard let pkg = cfg.pkg else { throw Failure("缺少 ML307 固件") }
    let ct = b.ct
    let record = try context(prior, mac: b.state.mac, digest: pkg.digest, project: cfg.project)
    try validateBackups(prior, pkg)
    let backup = URL(fileURLWithPath: text(prior, "backup"))
    b.change { $0.backup = backup.path; $0.mlProgress = 92; $0.mlState = "恢复同设备授权 · 保留已写固件和原备份" }
    if (try? resolve("ml", true)) == nil {
      let at = try USBWire(resolve("ml", false), download: false); defer { at.close() }
      try require(try DeviceIdentity.flashIdentity(at, ct).0 == text(prior, "imei"), "恢复前设备身份不一致")
      _ = try AT.command(at, "AT^AUTODL", ct, timeout: 3, disconnectOK: true)
      at.close()
      try ct.sleep(2)
      if (try? resolve("ml", true)) == nil {
        let again = try USBWire(resolve("ml", false), download: false); defer { again.close() }
        try require(try DeviceIdentity.flashIdentity(again, ct).0 == text(prior, "imei"), "复位前设备身份不一致")
        _ = try AT.command(again, "AT^RESET=normal", ct, timeout: 3, disconnectOK: true)
      }
    }
    let wire = try USBWire(BoardFlow.wait(ct, timeout: 25) { try resolve("ml", true) }, download: true)
    defer { wire.close() }
    let dl = Download(wire, ct)
    try dl.bootstrap(pkg) // RAM loaders only: no erase or firmware partition writes.
    let uid = try dl.send(18, Data.le(0, 4), accepted: [0x83]).1.hex
    try require(uid == text(prior, "uid"), "实际芯片 UID 与原备份不匹配，未开始激活")
    do {
      if text(record, "stage") != "complete" {
        try auth.run(dl, uid, backup) { value in b.change { $0.mlState = "恢复授权：" + value } }
      }
      try dl.reset()
    } catch {
      if !dl.broken && !ct.cancelled { try? dl.reset() }
      throw error
    }
    wire.close()
    var state = prior
    func save() throws {
      try Disk.save(backup.appendingPathComponent("session.json"), state)
      try Disk.save(Disk.root.appendingPathComponent("ml-intents/\(text(prior, "imei")).json"), state)
    }
    state["phase"] = "awaiting-verification"; try save()
    let runtime = try BoardFlow.wait(ct, timeout: 45) { try resolve("ml", false) }
    let at = try USBWire(runtime, download: false); defer { at.close() }
    let identity = try DeviceIdentity.flashIdentity(at, ct)
    try require(identity.0 == text(prior, "imei") && identity.1.lowercased().contains("ringhi"), "激活恢复后身份或固件未确认")
    state["phase"] = "verified"; state["versionAfter"] = identity.1; try save()
    b.change { $0.mlProgress = 100; $0.mlState = "激活恢复与启动身份确认完成 · 未重烧固件" }
  }
}
