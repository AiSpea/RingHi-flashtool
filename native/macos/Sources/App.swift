import AppKit
import Darwin
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  var window: NSWindow!
  var store: Store!
  let testing: Bool
  init(testing: Bool = false) { self.testing = testing }
  func applicationDidFinishLaunching(_ notification: Notification) {
    store = Store(testing: testing)
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1360, height: 900),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
    )
    window.title = "RingHi"
    window.delegate = self
    window.minSize = NSSize(width: 1140, height: 760)
    window.isReleasedWhenClosed = false
    window.contentView = NSHostingView(rootView: Workspace(store: store))
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    let menu = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "关于 RingHi", action: #selector(about), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(
      withTitle: "退出 RingHi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    menu.addItem(appItem)
    let edit = NSMenu(title: "编辑")
    for (title, selector, key) in [
      ("拷贝", #selector(NSText.copy(_:)), "c"), ("粘贴", #selector(NSText.paste(_:)), "v"),
      ("全选", #selector(NSText.selectAll(_:)), "a"),
    ] { edit.addItem(withTitle: title, action: selector, keyEquivalent: key) }
    let editItem = NSMenuItem()
    editItem.submenu = edit
    menu.addItem(editItem)
    NSApp.mainMenu = menu
    if let index = CommandLine.arguments.firstIndex(of: "--update-complete"), CommandLine.arguments.count > index + 1 {
      UpdateInstaller.acknowledge(URL(fileURLWithPath: CommandLine.arguments[index + 1]))
    }
    if testing { do { try prepareFixture() } catch { store.notice = error.localizedDescription } }
  }
  @objc func about() { store.selection = "about" }
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    NSApp.terminate(nil)
    return false
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard let store else { return .terminateNow }
    if store.closing { return .terminateCancel }
    if store.busy || store.starting {
      let alert = NSAlert()
      alert.messageText = "设备任务仍在执行"
      alert.informativeText = "关闭将停止接收、取消正在执行的任务并保存 CSV。未完成的设备会标记为中断，需要重新烧录。"
      alert.alertStyle = .warning
      alert.addButton(withTitle: "取消")
      alert.addButton(withTitle: "停止并关闭")
      if alert.runModal() != .alertSecondButtonReturn { return .terminateCancel }
    }
    store.finish { ok in
      guard ok else { store.updating = false; store.pendingUpdate = nil; sender.reply(toApplicationShouldTerminate: false); return }
      guard let (plan, file) = store.pendingUpdate else { sender.reply(toApplicationShouldTerminate: true); return }
      DispatchQueue.global().async {
        do {
          try UpdateInstaller.launch(plan, file: file)
          DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: true) }
        } catch {
          DispatchQueue.main.async {
            store.closing = false; store.updating = false; store.pendingUpdate = nil
            store.updateStatus = "未退出：" + error.localizedDescription
            sender.reply(toApplicationShouldTerminate: false)
          }
        }
      }
    }
    return .terminateLater
  }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    window?.makeKeyAndOrderFront(nil)
    return true
  }
  private func prepareFixture() throws {
    store.espPath = "软件验证 / ESP32.bin"
    store.mlPath = "软件验证 / ML307H.pkg"
    store.backupPath = Disk.root.appendingPathComponent("备份").path
    store.updateRelease = MacRelease(version: "0.4.10", archive: URL(string: "https://github.com/AiSpea/RingHi-flashtool/releases/download/mac-v0.4.10/RingHi-Native-0.4.10-mac-arm64.zip")!, checksums: URL(string: "https://github.com/AiSpea/RingHi-flashtool/releases/download/mac-v0.4.10/SHA256SUMS.txt")!)
    store.updateStatus = "软件验证：发现新版本 0.4.10（不会下载）"
    store.configExpanded = false
    store.notice = "隔离的软件验证数据；不会打开设备、登录或请求授权。"
    store.scanText = "软件验证：模拟任务状态"
    store.account = "软件验证"
    store.projects = [Project(id: 1, name: "验证项目")]
    store.project = 1
    let batch = try Batch(
      Configuration(
        mode: "dual", limit: 2, production: true, project: 0,
        espURL: URL(fileURLWithPath: store.espPath), mlURL: URL(fileURLWithPath: store.mlPath),
        backup: Disk.root), Spark(), Disk.root.appendingPathComponent("关闭验证.csv"),
      scanHardware: false)
    batch.executor = { b in
      b.change {
        $0.mac = "02:00:00:00:00:01"
        $0.imei = "000000000000001"
        $0.result = "烧录中"
        $0.espProgress = 43
        $0.mlProgress = 68
        $0.espState = "软件验证 · 正在写入"
        $0.mlState = "软件验证 · 正在写入"
      }
      while true { try b.ct.sleep(0.1) }
    }
    store.batch = batch
    batch.changed = { [weak self] in self?.store.refresh() }
    store.csvPath = batch.csv.path
    batch.observe(SelfTests.devices())
    store.refresh()
  }
}
@main enum Main {
  static func main() {
    setenv("PYTHONUTF8", "1", 1)
    setenv("NO_COLOR", "1", 1)
    let arguments = CommandLine.arguments
    for mode in ["--apply-update", "--replace-update"] {
      if let index = arguments.firstIndex(of: mode), arguments.count > index + 1 {
        do { try UpdateInstaller.apply(URL(fileURLWithPath: arguments[index + 1]), privileged: mode == "--replace-update"); exit(0) }
        catch {
          if mode == "--apply-update" {
            let app = NSApplication.shared; app.setActivationPolicy(.accessory)
            let alert = NSAlert(); alert.messageText = "RingHi 更新未完成"
            alert.informativeText = error.localizedDescription + "\n原账号和 CSV 保持不变，可以重新打开应用后重试。"
            alert.runModal()
          }
          fputs(error.localizedDescription + "\n", stderr); exit(1)
        }
      }
    }
    if let index = arguments.firstIndex(of: "--verify-update-archive"), arguments.count > index + 1 {
      do { try MacUpdates.validateZIP(Data(contentsOf: URL(fileURLWithPath: arguments[index + 1]))); print("PASS: update ZIP paths and limits"); exit(0) }
      catch { fputs(error.localizedDescription + "\n", stderr); exit(1) }
    }
    if arguments.contains("--stage-mac-update") {
      do {
        let ct = Cancellation()
        guard let release = try MacUpdates.check(current: "0.0.0", ct: ct) else { throw Failure("没有可下载的 Mac 更新") }
        let app = try MacUpdates.stage(release, ct: ct) { message in print(message); fflush(stdout) }
        print("STAGED " + app.path); exit(0)
      } catch { fputs(error.localizedDescription + "\n", stderr); exit(1) }
    }
    if arguments.contains("--check-mac-update") {
      do {
        let current = ProcessInfo.processInfo.environment["RINGHI_CHECK_FROM_VERSION"] ?? Disk.version
        let release = try MacUpdates.check(current: current, ct: Cancellation())
        print(release.map { "AVAILABLE " + $0.version + " " + $0.archive.absoluteString } ?? "CURRENT " + current)
        exit(0)
      } catch { fputs(error.localizedDescription + "\n", stderr); exit(1) }
    }
    if arguments.contains("--self-test") {
      do {
        try SelfTests.run()
        exit(0)
      } catch {
        fputs("FAIL: \(error.localizedDescription)\n", stderr)
        exit(1)
      }
    }
    let testing = arguments.contains("--ui-test")
    if testing {
      Disk.root = URL(
        fileURLWithPath: ProcessInfo.processInfo.environment["RINGHI_TEST_ROOT"]
          ?? "/tmp/ringhi-native-ui-" + UUID().uuidString)
    }
    if !testing, let id = Bundle.main.bundleIdentifier,
      let other = NSRunningApplication.runningApplications(withBundleIdentifier: id).first(where: {
        $0.processIdentifier != getpid()
      })
    {
      other.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
      return
    }
    let app = NSApplication.shared
    let delegate = AppDelegate(testing: testing)
    app.setActivationPolicy(.regular)
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
  }
}
