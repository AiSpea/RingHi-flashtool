import Foundation

final class UpdateTestProtocol: URLProtocol {
  static var status = 200
  static var body = Data("test".utf8)
  static var stall = false
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    if Self.stall { return }
    let r = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1", headerFields: [:])!
    client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Self.body)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
enum UpdateTests {
  static func run() throws {
    func check(_ name: String, _ value: @autoclosure () throws -> Bool) throws { try SelfTests.check(name, try value()) }
    func release(_ tag: String, draft: Bool = false, prerelease: Bool = false) -> Object {
      let v = String(tag.dropFirst(5))
      let name = "RingHi-Native-\(v)-mac-arm64.zip"
      let base = "https://github.com/AiSpea/RingHi-flashtool/releases/download/" + tag + "/"
      return ["tag_name": tag, "draft": draft, "prerelease": prerelease, "assets": [
        ["name": name, "browser_download_url": base + name],
        ["name": "SHA256SUMS.txt", "browser_download_url": base + "SHA256SUMS.txt"]]]
    }
    try check("Mac semantic update comparison", MacUpdates.newer("0.4.10", than: "0.4.9"))
    try check("Mac rejects malformed version", !MacUpdates.newer("0.4.9-beta", than: "0.4.8"))
    let catalog = [release("mac-v0.4.9"), release("v0.9.99"), release("mac-v0.5.0", draft: true), release("mac-v0.6.0", prerelease: true)]
    try check("Mac feed ignores Windows draft and prerelease", try MacUpdates.select(catalog, current: "0.4.8")?.version == "0.4.9")
    try check("same version has no upgrade", try MacUpdates.select(catalog, current: "0.4.9") == nil)
    try check("unordered Mac feed selects newest", try MacUpdates.select([release("mac-v0.4.9"), release("mac-v0.4.10")], current: "0.4.8")?.version == "0.4.10")
    try check("legacy PKG-only release does not mask eligible ZIP", try MacUpdates.select([["tag_name": "mac-v9.0.0"], release("mac-v0.4.9")], current: "0.4.8")?.version == "0.4.9")
    var bad = release("mac-v0.4.9")
    var assets = bad["assets"] as! [Object]; assets[0]["browser_download_url"] = "https://github.com/other/asset.zip"; bad["assets"] = assets
    try SelfTests.rejects("reject update asset in another repository") { _ = try MacUpdates.select([bad], current: "0.4.8") }
    for path in ["http://github.com", "https://github.com.evil.test", "https://user@github.com", "https://github.com:443"] {
      try check("reject unsafe update origin " + path, MacUpdates.assetURL(path + "/AiSpea/RingHi-flashtool/releases/download/mac-v0.4.9/a.zip", tag: "mac-v0.4.9", name: "a.zip") == nil)
    }
    let digest = Data("test".utf8).sha256
    try check("checksum matches exact filename", try MacUpdates.expectedHash(Data((digest + "  a.zip\n").utf8), name: "a.zip") == digest)
    for manifest in [digest + "  b.zip", digest + "  a.zip\n" + digest + "  a.zip", "bad  a.zip"] {
      try SelfTests.rejects("reject missing duplicate or malformed checksum") { _ = try MacUpdates.expectedHash(Data(manifest.utf8), name: "a.zip") }
    }
    // Small ZIP records exercise the actual pre-extraction validator.
    func zip(_ name: String, kind: UInt64 = 0x8000, expanded: UInt64 = 1, localName: String? = nil) -> Data {
      let localName = localName ?? name
      var local = Data.le(0x04034b50, 4) + Data(repeating: 0, count: 22)
      local += Data.le(UInt64(localName.utf8.count), 2) + Data.le(0, 2) + Data(localName.utf8) + Data([1])
      var central = Data.le(0x02014b50, 4) + Data(repeating: 0, count: 16)
      central += Data.le(1, 4) + Data.le(expanded, 4) + Data.le(UInt64(name.utf8.count), 2)
      central += Data(repeating: 0, count: 8) + Data.le(kind << 16, 4) + Data.le(0, 4) + Data(name.utf8)
      return local + central + Data.le(0x06054b50, 4) + Data.le(0, 4) + Data.le(1, 2) + Data.le(1, 2)
        + Data.le(UInt64(central.count), 4) + Data.le(UInt64(local.count), 4) + Data.le(0, 2)
    }
    try MacUpdates.validateZIP(zip("RingHi Flasher.app/Contents/test"))
    try check("valid distribution path accepted", true)
    for name in ["../outside", "/RingHi Flasher.app/test", "RingHi Flasher.app/../outside", "RingHi Flasher.app/./test", "RingHi Flasher.app/a\\b"] {
      try SelfTests.rejects("ZIP rejects traversal or alien path") { try MacUpdates.validateZIP(zip(name)) }
    }
    try SelfTests.rejects("ZIP rejects symlink") { try MacUpdates.validateZIP(zip("RingHi Flasher.app/link", kind: 0xa000)) }
    try SelfTests.rejects("ZIP rejects expansion bomb") { try MacUpdates.validateZIP(zip("RingHi Flasher.app/big", expanded: 0xffffffff)) }
    try SelfTests.rejects("ZIP rejects mismatched local filename") { try MacUpdates.validateZIP(zip("RingHi Flasher.app/good", localName: "../bad")) }
    try SelfTests.rejects("ZIP rejects truncated input") { try MacUpdates.validateZIP(Data([1, 2])) }
    let cfg = Spark.directConfiguration(); cfg.protocolClasses = [UpdateTestProtocol.self]
    let url = URL(string: "https://api.github.com/test")!
    try check("anonymous update transfer completes", try UpdateTransfer.fetch(url, limit: 100, ct: Cancellation(), configuration: cfg) == Data("test".utf8))
    UpdateTestProtocol.status = 503
    try SelfTests.rejects("update HTTP failure preserves application") { _ = try UpdateTransfer.fetch(url, limit: 100, ct: Cancellation(), configuration: cfg) }
    UpdateTestProtocol.status = 200; UpdateTestProtocol.body = Data(repeating: 0, count: 128)
    try SelfTests.rejects("chunked update download respects size bound") { _ = try UpdateTransfer.fetch(url, limit: 100, ct: Cancellation(), configuration: cfg) }
    UpdateTestProtocol.stall = true
    try SelfTests.rejects("stalled update reaches deadline") { _ = try UpdateTransfer.fetch(url, limit: 100, ct: Cancellation(), timeout: 0.1, configuration: cfg) }
    let ct = Cancellation(); DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { ct.cancel() }
    try SelfTests.rejects("cancel interrupted download") { _ = try UpdateTransfer.fetch(url, limit: 100, ct: ct, configuration: cfg) }
    UpdateTestProtocol.stall = false; UpdateTestProtocol.body = Data("test".utf8)
    try check("asset redirect host permitted", UpdateTransfer.allowed(URL(string: "https://release-assets.githubusercontent.com/asset")!))
    try check("foreign redirect refused", !UpdateTransfer.allowed(URL(string: "https://example.com/asset")!))

    let root = Disk.root.appendingPathComponent("update-transaction")
    let source = root.appendingPathComponent("stage/unpacked/RingHi Flasher.app")
    let destination = root.appendingPathComponent("Applications/RingHi Flasher.app")
    try Disk.atomic(source.appendingPathComponent("marker"), Data("new".utf8))
    try Disk.atomic(destination.appendingPathComponent("marker"), Data("old".utf8))
    let csv = root.appendingPathComponent("Documents/production.csv"), config = root.appendingPathComponent("Support/settings.json")
    try Disk.atomic(csv, Data("device,result\nTEST,success\n".utf8)); try Disk.atomic(config, Data("private-config-fixture".utf8))
    let originalCSV = try Data(contentsOf: csv), originalConfig = try Data(contentsOf: config)
    let plan = UpdatePlan(source: source, destination: destination, version: Disk.version, parent: getpid(), token: UUID().uuidString)
    var verifications = 0
    try SelfTests.rejects("post-swap verification rolls back old app") {
      try UpdateInstaller.replace(plan) { _ in verifications += 1; if verifications == 2 { throw Failure("Injected verification failure") } }
    }
    try check("rollback restores original application", try Data(contentsOf: destination.appendingPathComponent("marker")) == Data("old".utf8))
    try UpdateInstaller.replace(plan) { app in try require(Data(contentsOf: app.appendingPathComponent("marker")) == Data("new".utf8), "wrong app") }
    try check("successful replacement installs new application", try Data(contentsOf: destination.appendingPathComponent("marker")) == Data("new".utf8))
    try check("rollback copy preserved until restart", try Data(contentsOf: plan.backup.appendingPathComponent("marker")) == Data("old".utf8))
    try check("account configuration and CSV remain byte-identical", try Data(contentsOf: csv) == originalCSV && Data(contentsOf: config) == originalConfig)
    let planFile = plan.root.appendingPathComponent("plan.json")
    try Disk.atomic(planFile, JSONEncoder().encode(plan))
    try check("restart rejects a different application path", !UpdateInstaller.acknowledge(planFile, running: root.appendingPathComponent("Other.app")))
    try check("restart accepts directory URL and file URL for same app", UpdateInstaller.acknowledge(planFile, running: URL(fileURLWithPath: destination.path, isDirectory: true)))
    try check("confirmed restart removes only previous app", !FileManager.default.fileExists(atPath: plan.backup.path) && FileManager.default.fileExists(atPath: destination.path))
    try check("restart completion recorded", bool(try Disk.load(plan.result), "reopened"))
    let store = Store(testing: true)
    try check("idle store permits install", store.canInstallUpdate)
    for property in [\Store.busy, \Store.accepting, \Store.starting, \Store.loginBusy, \Store.closing, \Store.updating, \Store.checkingUpdate] {
      store[keyPath: property] = true
      try check("update blocked while task intake login or close active", !store.canInstallUpdate)
      store[keyPath: property] = false
    }
    func pump(_ condition: () -> Bool) throws {
      let deadline = Date().addingTimeInterval(4)
      while !condition() {
        try require(Date() < deadline, "store finish callback timed out")
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
      }
    }
    let savedRoot = Disk.root
    let badRoot = savedRoot.appendingPathComponent("not-a-directory")
    try Disk.atomic(badRoot, Data("unchanged".utf8))
    Disk.root = badRoot
    var failureResult: Bool?
    store.finish { failureResult = $0 }
    try pump { failureResult != nil }
    try check("settings save failure prevents exit", failureResult == false && !store.closing)
    Disk.root = savedRoot
    let saving = Store(testing: true)
    let batchCSV = savedRoot.appendingPathComponent("updater-final-save.csv")
    saving.batch = try Batch(Configuration(mode: "dual", limit: 1, production: true, project: 0,
      espURL: savedRoot, mlURL: savedRoot, backup: savedRoot), Spark(), batchCSV, scanHardware: false)
    var successResult: Bool?
    saving.finish { successResult = $0 }
    try pump { successResult != nil }
    try check("upgrade shutdown persists final CSV before exit", successResult == true && (try Data(contentsOf: batchCSV)) == CSV.bytes([]))
    store.updating = true; store.start(); store.resume()
    try check("updating cannot start or resume a hardware batch", store.batch == nil && !store.starting && !store.accepting)
  }
}
