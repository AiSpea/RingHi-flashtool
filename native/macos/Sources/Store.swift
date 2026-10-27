import AppKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers

struct Project: Identifiable, Hashable {
  var id: Int
  var name: String
}
final class Store: ObservableObject {
  @Published var espPath = ""
  @Published var mlPath = ""
  @Published var backupPath = ""
  @Published var mode = "dual"
  @Published var limit = 2
  @Published var production = true
  @Published var product: ProductType = .simEsim
  @Published var project = 0
  @Published var projects: [Project] = []
  @Published var account = "未登录"
  @Published var notice = "选择固件、备份目录及授权项目，然后开启新批次。"
  @Published var csvPath = ""
  @Published var rows: [Board] = []
  @Published var busy = false
  @Published var accepting = false
  @Published var starting = false
  @Published var closing = false
  @Published var loginBusy = false
  @Published var showLogin = false
  @Published var configExpanded = true
  @Published var scanText = "正在读取 USB 设备"
  @Published var selection = "batch"
  @Published var updateRelease: MacRelease?
  @Published var updateStatus = "启动后自动检查更新"
  @Published var checkingUpdate = false
  @Published var updating = false
  var updateCancellation: Cancellation?
  var pendingUpdate: (UpdatePlan, URL)?
  private var updateTimer: Timer?
  var batch: Batch?
  var preparation: Cancellation?
  let spark = Spark()
  var csvDirectory = ""
  private var inventoryTimer: Timer?
  let testing: Bool
  var locked: Bool { starting || busy || accepting || updating || closing }
  var canInstallUpdate: Bool { !locked && !loginBusy && !checkingUpdate }
  var connected: [Board] { rows.filter { $0.state.connected } }
  var disconnected: [Board] { rows.filter { !$0.state.connected } }
  init(testing: Bool = false) {
    self.testing = testing
    if !testing {
      load()
      inventoryTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
        self?.scan()
      }
      scan()
      updateTimer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in self?.checkUpdate() }
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.checkUpdate() }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.loginDefault() }
    }
  }
  func scan() {
    let mode = self.mode
    DispatchQueue.global().async {
      do {
        let devices = try Inventory.snapshot()
        let pairs = Inventory.pairs(devices, mode: mode)
        DispatchQueue.main.async {
          self.scanText = pairs.isEmpty ? "等待连接 RingHi" : "检测到 \(pairs.count) 个板载 Hub"
        }
      } catch {
        DispatchQueue.main.async { self.scanText = "USB 检查失败：" + error.localizedDescription }
      }
    }
  }
  private var settings: URL { Disk.root.appendingPathComponent("settings.json") }
  func load() {
    if let s = try? Disk.load(settings) {
      espPath = text(s, "esp")
      mlPath = text(s, "ml")
      backupPath = text(s, "backup")
      mode = text(s, "mode").isEmpty ? "dual" : text(s, "mode")
      limit = s["limit"] as? Int ?? 2
      production = s["production"] as? Bool ?? true
      product = ProductType(rawValue: text(s, "productType")) ?? .simEsim
      csvDirectory = text(s, "csvDirectory")
    }
    if !["dual", "esp", "ml"].contains(mode) { mode = "dual" }
    limit = max(1, min(8, limit))
    if backupPath.isEmpty,
      let legacy = try? Disk.load(Disk.legacy.appendingPathComponent("backup-directory.json"))
    {
      backupPath = text(legacy, "path")
    }
    if backupPath.isEmpty {
      backupPath =
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("RingHi Backups").path
    }
    let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
      "Desktop/RingHi")
    let esp = root.appendingPathComponent("RingHi-ESP32S3-s3.142-full-erase-16MB.bin")
    let ml = root.appendingPathComponent("RingHi-ML307H-v26.019.rhd943a9a6304d.pkg")
    if espPath.isEmpty && FileManager.default.fileExists(atPath: esp.path) { espPath = esp.path }
    if mlPath.isEmpty && FileManager.default.fileExists(atPath: ml.path) { mlPath = ml.path }
  }
  func saveSettings() throws {
    try Disk.save(
      settings,
      [
        "esp": espPath, "ml": mlPath, "backup": backupPath, "mode": mode, "limit": limit,
        "production": production, "csvDirectory": csvDirectory, "productType": product.rawValue,
      ])
  }
  func loginDefault() {
    guard !testing, !loginBusy else { return }
    loginBusy = true
    DispatchQueue.global().async {
      do {
        guard let credentials = try Credentials.load() else {
          DispatchQueue.main.async {
            self.account = "请配置授权账号"
            self.loginBusy = false
          }
          return
        }
        try self.spark.login(credentials)
        let projects = try self.spark.projects()
        DispatchQueue.main.async {
          self.applyProjects(projects)
          self.loginBusy = false
        }
      } catch {
        DispatchQueue.main.async {
          self.account = "登录未完成"
          self.notice = error.localizedDescription
          self.loginBusy = false
        }
      }
    }
  }
  func login(_ username: String, _ password: String, _ code: String) {
    guard !locked, !loginBusy else { return }
    loginBusy = true
    let c: Object = [
      "username": username.trimmingCharacters(in: .whitespacesAndNewlines), "password": password,
      "pccode": code.components(separatedBy: .whitespacesAndNewlines).joined(),
    ]
    DispatchQueue.global().async {
      do {
        try self.spark.login(c)
        let projects = try self.spark.projects()
        try Credentials.save(c)
        DispatchQueue.main.async {
          self.applyProjects(projects)
          self.showLogin = false
          self.loginBusy = false
          self.notice = "授权账号已保存到系统钥匙串"
        }
      } catch {
        DispatchQueue.main.async {
          self.notice = error.localizedDescription
          self.loginBusy = false
        }
      }
    }
  }
  func applyProjects(_ data: [Object]) {
    projects = data.compactMap {
      let id = Int(text($0, "project_id")) ?? Int(text($0, "id")) ?? 0
      guard id > 0 else { return nil }
      let name = text($0, "project_name").isEmpty ? text($0, "name") : text($0, "project_name")
      return Project(id: id, name: name.isEmpty ? "项目 \(id)" : name)
    }
    account = "已登录：" + spark.username
    project =
      projects.contains(where: { $0.id == spark.selectedProject }) ? spark.selectedProject : 0
  }
  func choose(_ role: String) {
    guard !locked else { return }
    let panel = NSOpenPanel()
    panel.canChooseDirectories = role == "backup"
    panel.canChooseFiles = role != "backup"
    panel.allowsMultipleSelection = false
    panel.prompt = role == "backup" ? "选择备份目录" : "选择固件"
    panel.message =
      role == "backup"
      ? "每块板的设备专属备份会单独保存"
      : role == "esp" ? "ESP32-S3 完整 16 MB BIN，写入地址 0x0" : "RingHi ML307H PKG 固件"
    if role != "backup" {
      panel.allowedContentTypes = [
        UTType(filenameExtension: role == "esp" ? "bin" : "pkg") ?? .data
      ]
    }
    guard panel.runModal() == .OK, let url = panel.url else { return }
    if role == "esp" {
      espPath = url.path
    } else if role == "ml" {
      mlPath = url.path
    } else {
      backupPath = url.path
    }
    do {
      try saveSettings()
      notice = "已选择：" + url.path
    } catch { notice = "配置保存失败：" + error.localizedDescription }
  }
  func start() {
    guard !starting, !busy, !closing, !updating else { return }
    if accepting {
      notice = "请先停止接收，再开启新批次"
      return
    }
    if mode != "esp" && (project == 0 || spark.username.isEmpty) {
      notice = "请先登录，并选择 ML307 授权项目"
      return
    }
    if production && mode != "dual" {
      notice = "整板产测需要双芯模式；单芯烧录请关闭产测"
      return
    }
    let panel = NSSavePanel()
    panel.title = "新建本批次 CSV，保存后开始"
    panel.message = "请使用新文件名；保存成功后才准备授权并接收设备。已有 CSV 不会覆盖。"
    panel.allowedContentTypes = [.commaSeparatedText]
    panel.nameFieldStringValue = "RingHi-" + DateFormatter.batch.string(from: Date()) + ".csv"
    panel.canCreateDirectories = true
    if !csvDirectory.isEmpty { panel.directoryURL = URL(fileURLWithPath: csvDirectory) }
    guard panel.runModal() == .OK, let url = panel.url else {
      notice = "已取消开启批次，未接收设备。"; return
    }
    starting = true
    notice = "正在新建并验证 CSV，保存成功后准备授权…"
    let ct = Cancellation(); preparation = ct
    let session = spark.snapshot()
    let cfg = Configuration(mode: mode, limit: limit, production: production, project: project,
      espURL: URL(fileURLWithPath: espPath), mlURL: URL(fileURLWithPath: mlPath),
      backup: URL(fileURLWithPath: backupPath), product: product)
    let previous = batch
    DispatchQueue.global().async {
      var prepared: ProjectAuthorization?
      do {
        try ct.check()
        try CSV.create(url)
        var c = cfg
        if c.mode != "ml" {
          c.esp = try Data(contentsOf: c.espURL)
          try EspEngine.validate(c.esp)
          try EspEngine.verify()
        }
        if c.mode != "esp" {
          c.pkg = try MLPackage(Data(contentsOf: c.mlURL))
          let probe = c.backup.appendingPathComponent(".ringhi-write-test-" + UUID().uuidString)
          try Disk.verified(probe, Data([1, 2, 3]))
          try FileManager.default.removeItem(at: probe)
          prepared = try ProjectAuthorization.prepare(session, project: c.project, ct: ct) { status in
            DispatchQueue.main.async { if !self.closing { self.notice = status } }
          }
          c.authorization = prepared
        }
        try ct.check()
        try previous?.finish()
        let candidate = try Batch(c, session, url, startImmediately: false)
        DispatchQueue.main.async {
          self.preparation = nil
          self.starting = false
          guard !self.closing && !ct.cancelled else {
            try? candidate.finish(); return
          }
          self.batch = candidate
          candidate.changed = { [weak self] in self?.refresh() }
          self.csvDirectory = url.deletingLastPathComponent().path
          self.csvPath = url.path
          self.configExpanded = false
          candidate.startScanning()
          self.notice = "CSV 已保存 · 接收中；插板核对身份后自动双芯烧录，烧录后逐台自动激活。"
          try? self.saveSettings()
          self.refresh()
        }
      } catch {
        prepared?.release()
        DispatchQueue.main.async {
          self.preparation = nil; self.starting = false
          self.notice = error.localizedDescription
        }
      }
    }
  }

  func refresh() {
    guard let batch else { return }
    rows = batch.boards
    busy = batch.busy
    accepting = batch.accepting
    if !batch.error.isEmpty { notice = batch.error }
  }
  func stop() {
    batch?.stop()
    refresh()
    notice = "已停止接收新设备，正在执行的任务继续收尾。"
  }
  func resume() {
    guard !updating, !closing, !starting else { return }
    do {
      try batch?.resume()
      refresh()
      notice = "继续接收，沿用本批次固件和授权配置。"
    } catch { notice = error.localizedDescription }
  }
  func export() {
    guard let batch else { return }
    let p = NSSavePanel()
    p.title = "导出本批次 CSV"
    p.allowedContentTypes = [.commaSeparatedText]
    p.nameFieldStringValue = "RingHi-" + DateFormatter.batch.string(from: Date()) + "-导出.csv"
    if !csvDirectory.isEmpty { p.directoryURL = URL(fileURLWithPath: csvDirectory) }
    guard p.runModal() == .OK, let url = p.url else { return }
    do {
      try batch.export(url)
      notice = "CSV 已导出：" + url.path
    } catch { notice = "导出失败：" + error.localizedDescription }
  }
  func checkUpdate() {
    guard !testing, !checkingUpdate, !updating, !closing else { return }
    checkingUpdate = true
    updateStatus = "正在检查 Mac 更新…"
    let ct = Cancellation(); updateCancellation = ct
    DispatchQueue.global().async {
      do {
        let release = try MacUpdates.check(ct: ct)
        DispatchQueue.main.async {
          self.checkingUpdate = false
          guard !self.closing else { return }
          self.updateRelease = release
          self.updateStatus = release.map { "发现新版本 " + $0.version } ?? "当前已是最新版本"
        }
      } catch {
        DispatchQueue.main.async {
          self.checkingUpdate = false
          if !self.closing { self.updateStatus = "检查未完成，可重试：" + error.localizedDescription }
        }
      }
    }
  }
  func installUpdate() {
    guard !testing, canInstallUpdate, let release = updateRelease else { return }
    updating = true
    let ct = Cancellation(); updateCancellation = ct
    DispatchQueue.global().async {
      do {
        let source = try MacUpdates.stage(release, ct: ct) { status in
          DispatchQueue.main.async { if !self.closing { self.updateStatus = status } }
        }
        try ct.check()
        let plan = try UpdateInstaller.makePlan(source: source, destination: Bundle.main.bundleURL, version: release.version)
        DispatchQueue.main.async {
          guard !self.closing, !ct.cancelled else { return }
          self.pendingUpdate = plan
          self.updateStatus = "校验通过，正在保存 CSV 并重启升级…"
          NSApp.terminate(nil)
        }
      } catch {
        DispatchQueue.main.async {
          self.updating = false; self.pendingUpdate = nil
          if !self.closing { self.updateStatus = "更新未完成，原应用未改动：" + error.localizedDescription }
        }
      }
    }
  }

  func finish(_ completion: @escaping (Bool) -> Void) {
    guard !closing else {
      completion(false)
      return
    }
    closing = true
    updateCancellation?.cancel()
    preparation?.cancel()
    notice = "正在停止设备任务并保存 CSV…"
    let current = batch
    DispatchQueue.global().async {
      do {
        try current?.finish()
        try self.saveSettings()
        DispatchQueue.main.async { completion(true) }
      } catch {
        DispatchQueue.main.async {
          self.closing = false
          self.notice = "未退出：" + error.localizedDescription
          completion(false)
        }
      }
    }
  }
}
