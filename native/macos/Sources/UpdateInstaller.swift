import AppKit
import Foundation
import Darwin

struct UpdatePlan: Codable {
  let source: URL
  let destination: URL
  let version: String
  let parent: Int32
  let token: String
  var root: URL { source.deletingLastPathComponent().deletingLastPathComponent() }
  var backup: URL { destination.deletingLastPathComponent().appendingPathComponent(".RingHi-previous-" + token + ".app") }
  var ready: URL { root.appendingPathComponent("helper-ready") }
  var result: URL { root.appendingPathComponent("result.json") }
}

enum UpdateInstaller {
  static func makePlan(source: URL, destination: URL, version: String, parent: Int32 = getpid()) throws -> (UpdatePlan, URL) {
    let plan = UpdatePlan(source: source, destination: destination, version: version, parent: parent, token: UUID().uuidString)
    try validate(plan)
    let url = plan.root.appendingPathComponent("plan.json")
    try Disk.atomic(url, JSONEncoder().encode(plan))
    return (plan, url)
  }
  static func validate(_ plan: UpdatePlan) throws {
    try require(plan.parent > 1 && UUID(uuidString: plan.token) != nil && MacUpdates.version(plan.version) != nil, "更新计划无效")
    try require(plan.source.lastPathComponent == "RingHi Flasher.app" && plan.destination.lastPathComponent == "RingHi Flasher.app"
      && plan.source.standardizedFileURL.path != plan.destination.standardizedFileURL.path, "更新目标路径无效")
    try require(plan.destination.standardizedFileURL.path == plan.destination.resolvingSymlinksInPath().standardizedFileURL.path,
      "请先将 RingHi 安装到实际应用目录，不能更新链接或临时挂载的应用")
    let old = try Data(contentsOf: plan.destination.appendingPathComponent("Contents/Info.plist"))
    let info = try PropertyListSerialization.propertyList(from: old, format: nil) as? Object ?? [:]
    try require(text(info, "CFBundleIdentifier") == "com.aispea.ringhi.flasher", "原应用标识不匹配")
    try MacUpdates.verifyApp(plan.source, version: plan.version)
  }
  static func launch(_ plan: UpdatePlan, file: URL) throws {
    try validate(plan)
    let helper = Process()
    helper.executableURL = plan.source.appendingPathComponent("Contents/MacOS/RingHi Flasher")
    helper.arguments = ["--apply-update", file.path]
    helper.standardOutput = FileHandle.nullDevice; helper.standardError = FileHandle.nullDevice
    try helper.run()
    let deadline = Date().addingTimeInterval(8)
    while !FileManager.default.fileExists(atPath: plan.ready.path) {
      guard helper.isRunning && Date() < deadline else {
        if helper.isRunning { helper.terminate() }
        throw Failure("更新助手未就绪，原应用保持打开")
      }
      Thread.sleep(forTimeInterval: 0.05)
    }
  }
  static func shellQuote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
  static func appleQuote(_ value: String) -> String {
    "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
  }
  // Candidate is copied beside the destination before either rename, so the
  // switch stays on one volume. Only the .app changes, never user data.
  static func replace(_ plan: UpdatePlan, verify: (URL) throws -> Void) throws {
    let fm = FileManager.default
    let candidate = plan.destination.deletingLastPathComponent().appendingPathComponent(".RingHi-next-" + plan.token + ".app")
    try require(!fm.fileExists(atPath: candidate.path) && !fm.fileExists(atPath: plan.backup.path), "已有更新备份，请重新尝试")
    defer { try? fm.removeItem(at: candidate) }
    _ = try OwnedProcess.run(URL(fileURLWithPath: "/usr/bin/ditto"), ["--norsrc", plan.source.path, candidate.path], Cancellation(), timeout: 60)
    try verify(candidate)
    try fm.moveItem(at: plan.destination, to: plan.backup)
    do {
      try fm.moveItem(at: candidate, to: plan.destination)
      try verify(plan.destination)
    } catch {
      if fm.fileExists(atPath: plan.destination.path) { try fm.removeItem(at: plan.destination) }
      try fm.moveItem(at: plan.backup, to: plan.destination)
      throw error
    }
  }
  static func apply(_ file: URL, privileged: Bool = false) throws {
    let plan = try JSONDecoder().decode(UpdatePlan.self, from: Data(contentsOf: file))
    try require(plan.version == Disk.version, "更新助手版本不一致")
    try validate(plan)
    if privileged {
      try require(geteuid() == 0 && kill(plan.parent, 0) != 0, "请先退出原应用")
      try replace(plan) { try MacUpdates.verifyApp($0, version: plan.version) }
      return
    }
    try Disk.atomic(plan.ready, Data("ready".utf8))
    let deadline = Date().addingTimeInterval(90)
    while kill(plan.parent, 0) == 0 {
      try require(Date() < deadline, "原应用尚未退出，更新已取消")
      Thread.sleep(forTimeInterval: 0.1)
    }
    do {
      if FileManager.default.isWritableFile(atPath: plan.destination.deletingLastPathComponent().path) {
        try replace(plan) { try MacUpdates.verifyApp($0, version: plan.version) }
      } else {
        let command = shellQuote(plan.source.appendingPathComponent("Contents/MacOS/RingHi Flasher").path)
          + " --replace-update " + shellQuote(file.path)
        _ = try OwnedProcess.run(URL(fileURLWithPath: "/usr/bin/osascript"),
          ["-e", "do shell script " + appleQuote(command) + " with administrator privileges"], Cancellation(), timeout: 180)
      }
      try Disk.save(plan.result, ["installed": true, "version": plan.version, "path": plan.destination.path])
      _ = try OwnedProcess.run(URL(fileURLWithPath: "/usr/bin/open"),
        ["-n", plan.destination.path, "--args", "--update-complete", file.path], Cancellation(), timeout: 20)
    } catch {
      // A failed relaunch also restores the old app when this user can rename
      // its parent. On a protected volume retain the verified rollback copy.
      if FileManager.default.fileExists(atPath: plan.backup.path),
        FileManager.default.isWritableFile(atPath: plan.destination.deletingLastPathComponent().path) {
        let failed = plan.root.appendingPathComponent("failed-new.app")
        do {
          try FileManager.default.moveItem(at: plan.destination, to: failed)
          try FileManager.default.moveItem(at: plan.backup, to: plan.destination)
        } catch { /* Both copies remain available; report their location below. */ }
      }
      try? Disk.save(plan.result, ["installed": false, "error": error.localizedDescription, "backup": plan.backup.path])
      _ = try? OwnedProcess.run(URL(fileURLWithPath: "/usr/bin/open"), [plan.destination.path], Cancellation(), timeout: 20)
      throw error
    }
  }
  @discardableResult static func acknowledge(_ file: URL, running: URL = Bundle.main.bundleURL) -> Bool {
    guard let data = try? Data(contentsOf: file), let plan = try? JSONDecoder().decode(UpdatePlan.self, from: data),
      plan.version == Disk.version, plan.destination.standardizedFileURL.path == running.standardizedFileURL.path,
      UUID(uuidString: plan.token) != nil else { return false }
    try? Disk.save(plan.result, ["installed": true, "reopened": true, "version": Disk.version])
    // A rendered new window confirms restart. Remove the hidden rollback copy,
    // keeping one installed application; user data is outside both bundles.
    try? FileManager.default.removeItem(at: plan.backup)
    return true
  }
}
