import AppKit
import Darwin
import Foundation

final class ReceiptTestProtocol: URLProtocol {
  static var completed: (() -> Void)?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(#"{"code":200,"data":{"cdkey":"TEST_RECEIPT","has3rd":0}}"#.utf8))
    Self.completed?()
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
final class RouteTestProtocol: URLProtocol {
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    let bytes = try! JSONSerialization.data(withJSONObject: ["code": 200, "data": ["route": request.url!.lastPathComponent]])
    client?.urlProtocol(self, didLoad: bytes)
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
final class ScriptWire: Wire {
  var chunks: [Data]
  var writes = 0
  init(_ chunks: [Data]) { self.chunks = chunks }
  func write(_ data: Data, _ ct: Cancellation) throws {
    try ct.check()
    writes += 1
  }
  func read(_ timeout: Int, _ ct: Cancellation) throws -> Data {
    try ct.check()
    return chunks.isEmpty ? Data() : chunks.removeFirst()
  }
  func close() {}
}
enum SelfTests {
  static var count = 0
  static func check(_ name: String, _ value: @autoclosure () throws -> Bool) throws {
    try require(try value(), name)
    count += 1
    print("PASS \(count): \(name)")
  }
  static func rejects(_ name: String, _ action: () throws -> Void) throws {
    do { try action() } catch {
      try check(name, true)
      return
    }
    throw Failure("Expected rejection: " + name)
  }
  static func wait(_ test: () -> Bool) throws {
    let end = Date().addingTimeInterval(4)
    while !test() {
      try require(Date() < end, "状态等待超时")
      Thread.sleep(forTimeInterval: 0.02)
    }
  }
  static func devices(_ epoch: String = "one", hub: String = "2:1") -> [USBDevice] {
    [
      USBDevice(key: hub, parent: "2:", vendor: 0x1a40, product: 0x0101, kind: 9, epoch: epoch),
      USBDevice(
        key: hub + ".1", parent: hub, vendor: 0x303a, product: 0x1001, kind: 0, epoch: "esp",
        paths: ["/dev/cu.TEST"]),
      USBDevice(
        key: hub + ".2", parent: hub, vendor: 0x3563, product: 0x2000, kind: 0, epoch: "ml"),
    ]
  }
  static func directAndCSVChecks() throws {
    let cfg = Spark.directConfiguration()
    for key in ["HTTPEnable", "HTTPSEnable", "SOCKSEnable", "ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"] {
      try check("proxy disabled: " + key, (cfg.connectionProxyDictionary?[key] as? Int) == 0)
    }
    let ct = Cancellation()
    let spark = Spark(configuration: {
      let config = Spark.directConfiguration(); config.protocolClasses = [ReceiptTestProtocol.self]; return config
    })
    ReceiptTestProtocol.completed = { ct.cancel() }
    defer { ReceiptTestProtocol.completed = nil }
    let response = try spark.call("activation-key", [:], ct) as? Object ?? [:]
    try check("acknowledged license survives cancellation", ct.cancelled && text(response, "cdkey") == "TEST_RECEIPT")
    try FileManager.default.createDirectory(at: Disk.root, withIntermediateDirectories: true)
    let csv = Disk.root.appendingPathComponent("exclusive-new-batch.csv")
    try CSV.create(csv)
    try check("new CSV header saved before preparation", try Data(contentsOf: csv) == CSV.bytes([]))
    try rejects("existing CSV cannot be overwritten") { try CSV.create(csv) }
    try check("existing CSV unchanged", try Data(contentsOf: csv) == CSV.bytes([]))
    try rejects("invalid CSV path prevents start") { try CSV.create(Disk.root.appendingPathComponent("missing/new.csv")) }
  }
  static func connectionPoolChecks() throws {
    var created = 0
    let account = Spark(configuration: {
      created += 1
      let config = Spark.directConfiguration(); config.protocolClasses = [RouteTestProtocol.self]; return config
    })
    let snapshot = account.snapshot()
    let lock = NSLock(); var failures: [String] = []
    let group = DispatchGroup()
    for i in 0..<8 {
      group.enter()
      Thread.detachNewThread {
        defer { group.leave() }
        let action = i % 2 == 0 ? "projects" : "project-keys"
        do {
          let result = try (i % 2 == 0 ? account : snapshot).call(action, [:], Cancellation()) as? Object ?? [:]
          if text(result, "route") != Spark.routes[action] { lock.with { failures.append("cross-task response") } }
        } catch { lock.with { failures.append(error.localizedDescription) } }
      }
    }
    group.wait()
    try check("one connection pool shared by batch snapshots", created == 1)
    try check("parallel official responses remain isolated", failures.isEmpty)
    let ct = Cancellation(); ct.cancel()
    try rejects("cancelled board cannot send request") { _ = try snapshot.call("projects", [:], ct) }
    let result = try account.call("projects", [:], Cancellation()) as? Object ?? [:]
    try check("cancelled board does not invalidate other connections", text(result, "route") == "getauthorize")
    try check("shared connection pool sends no cookies", !Spark.directConfiguration().httpShouldSetCookies)
  }
  static func aliasRecoveryChecks() throws {
    let uid = String(repeating: "c", count: 32)
    let directory = Disk.root.appendingPathComponent("alias-original")
    let original: Object = ["mac": "test-board", "imei": "111111111111111", "uid": uid, "phase": "verified",
      "firmwareSha256": "fixture", "createdAt": "2026-10-27T05:26:00Z", "verifiedAt": "2026-10-27T05:27:00Z"]
    var old = original; old["imei"] = "222222222222222"; old["phase"] = "awaiting-verification"; old["createdAt"] = "2026-10-27T05:12:00Z"
    let current: Object = ["mac": "test-board", "imei": "111111111111111", "phase": "preparing", "firmwareSha256": "fixture",
      "createdAt": "2026-10-27T07:09:00Z", "previousBackup": directory.path]
    try Disk.save(directory.appendingPathComponent("session.json"), original)
    try Disk.save(Disk.root.appendingPathComponent("activation/\(uid).json"), ["uid": uid, "stage": "complete"])
    var validations = 0
    let selected = try MLRecovery.selectDownload([old, current], mac: "test-board", digest: "fixture") { _ in validations += 1 }
    try check("alias resolved to canonical IMEI and live UID expectation", text(selected, "imei") == "111111111111111" && text(selected, "recoveryUid") == uid)
    try check("alias backup must be validated and preparing stays untouched", validations == 1 && MLRecovery.untouched(selected))
    _ = try MLRecovery.selectDownload([old, original], mac: "test-board", digest: "fixture") { _ in }
    try check("verified current record supersedes proven old alias", true)
    for (field, value) in [("uid", String(repeating: "d", count: 32)), ("phase", "writing"), ("firmwareSha256", "other"), ("createdAt", "2026-10-27T08:00:00Z"), ("createdAt", "invalid")] {
      var bad = old; bad[field] = value
      try rejects("alias cannot bypass " + field + ":" + value) {
        _ = try MLRecovery.selectDownload([bad, current], mac: "test-board", digest: "fixture") { _ in }
      }
    }
    try rejects("corrupt alias backup stops recovery") {
      _ = try MLRecovery.selectDownload([old, current], mac: "test-board", digest: "fixture") { _ in throw Failure("corrupt backup") }
    }
    try Disk.save(Disk.root.appendingPathComponent("activation/\(uid).json"), ["uid": uid, "stage": "key-requesting"])
    try rejects("unfinished authorization cannot be superseded") {
      _ = try MLRecovery.selectDownload([old, current], mac: "test-board", digest: "fixture") { _ in }
    }
  }
  static func authorizationChecks() throws {
    var calls: [String] = []
    func material(_ action: String) -> Object {
      calls.append(action)
      return action == "project-keys" ? ["AES": "TEST_AES", "rsa_n": "TEST_N", "rsa_e": "TEST_E"] : ["rsa_d": "TEST_D"]
    }
    let prepared = try ProjectAuthorization.prepare(username: "test", project: 42, request: material, ct: Cancellation(), status: { _ in }, delay: 0)
    var a = try prepared.copyForDevice(project: 42, username: "test")
    let b = try prepared.copyForDevice(project: 42, username: "test")
    a[0].resetBytes(in: 0..<a[0].count)
    try check("device material copies independent", String(decoding: b[0], as: UTF8.self) == "TEST_AES")
    try check("two devices require only two material calls total", calls == ["project-keys", "private-key"])
    try rejects("cross-project material rejected") { _ = try prepared.copyForDevice(project: 43, username: "test") }
    try rejects("cross-account material rejected") { _ = try prepared.copyForDevice(project: 42, username: "other") }
    prepared.release()
    try rejects("released material unusable") { _ = try prepared.copyForDevice(project: 42, username: "test") }
    try check("device copy survives batch cleanup", String(decoding: b[3], as: UTF8.self) == "TEST_D")
    var attempts = 0
    calls = []
    let recovered = try ProjectAuthorization.prepare(username: "test", project: 42, request: { action in
      if action == "private-key" { attempts += 1; if attempts == 1 { throw AuthorizationRequestFailure(message: "timeout", retryPreparation: true) } }
      return material(action)
    }, ct: Cancellation(), status: { _ in }, delay: 0)
    try check("retry private material without public refetch", attempts == 2 && calls.filter { $0 == "project-keys" }.count == 1)
    recovered.release()
    attempts = 0
    try rejects("failed preparation never ready") {
      _ = try ProjectAuthorization.prepare(username: "test", project: 42, request: { _ in attempts += 1; throw AuthorizationRequestFailure(message: "timeout", retryPreparation: true) }, ct: Cancellation(), status: { _ in }, delay: 0)
    }
    try check("preparation attempts bounded", attempts == 2)
    attempts = 0
    try rejects("authorization rejection not retried") {
      _ = try ProjectAuthorization.prepare(username: "test", project: 42, request: { _ in attempts += 1; throw AuthorizationRequestFailure(message: "unauthorized", retryPreparation: false) }, ct: Cancellation(), status: { _ in }, delay: 0)
    }
    try check("rejection requested once", attempts == 1)
    let cancelled = Cancellation(); attempts = 0
    try rejects("close cancels preparation") {
      _ = try ProjectAuthorization.prepare(username: "test", project: 42, request: { _ in attempts += 1; cancelled.cancel(); throw AuthorizationRequestFailure(message: "timeout", retryPreparation: true) }, ct: cancelled, status: { _ in }, delay: 0)
    }
    try check("cancel prevents retries", attempts == 1)
    for action in ["activation-key", "third-party-key", "activation-report", "login"] {
      try check("no replay for \(action)", !AuthorizationErrors.canRetryPreparation(action, code: NSURLErrorTimedOut))
    }
    try check("certificate errors not retried", !AuthorizationErrors.canRetryPreparation("private-key", code: NSURLErrorServerCertificateUntrusted))
    try check("expired session not retried", !AuthorizationErrors.canRetryPreparation("project-keys", code: nil, http: 401))
    try rejects("hardware batch cannot start without prepared material") {
      _ = try Batch(Configuration(mode: "dual", limit: 2, production: false, project: 42, espURL: Disk.root, mlURL: Disk.root, backup: Disk.root), Spark(), Disk.root.appendingPathComponent("not-ready.csv"))
    }
  }
  static func identityChecks() throws {
    var commands: [String] = []
    let factory = try DeviceIdentity.modemVersion { command in
      commands.append(command)
      return command == "AT+CGMM" ? "AT+CGMM\r\nML307H\r\nOK\r\n" : "ML307H-DC-MBRH1S00\r\nOK"
    }
    try check("factory ML307H accepted before first flash", factory.contains("ML307H-DC-MBRH1S00"))
    try check("model checked before old firmware version", commands == ["AT+CGMM", "AT+CGMR"])
    for model in ["ML307A", "ML307H-unknown", "ERROR", "prefix ML307H"] {
      var calls = 0
      try rejects("reject unconfirmed modem model \(model)") {
        _ = try DeviceIdentity.modemVersion { _ in calls += 1; return model }
      }
      try check("stop after wrong model \(model)", calls == 1)
    }
    let failure = "ERROR: A fatal error occurred: Could not open /dev/cu.usbmodemTEST, the port is busy or doesn't exist."
    try check("pre-open failure recognized", DeviceIdentity.beforePortOpened(failure))
    for evidence in ["Connecting...", "Connected to ESP32", "Uploading stub", "Writing at 0x0", "Wrote 12 bytes", "Hash of data verified."] {
      try check("no retry after \(evidence)", !DeviceIdentity.beforePortOpened(evidence + "\n" + failure))
    }
    var resolutions = 0
    var opened: [String] = []
    let result = try DeviceIdentity.readESP(resolve: {
      resolutions += 1
      return "/dev/cu.test\(resolutions)"
    }, identify: { path in
      opened.append(path)
      if opened.count == 1 { throw Failure(failure) }
      return "MAC"
    }, ct: Cancellation(), status: { _ in }, delay: 0)
    try check("port recovery uses refreshed original target", result == "MAC" && opened == ["/dev/cu.test1", "/dev/cu.test2"])
    resolutions = 0
    _ = try DeviceIdentity.readESP(resolve: {
      resolutions += 1
      if resolutions == 1 { throw PortNotReady(message: "not ready") }
      return "/dev/cu.ready"
    }, identify: { $0 }, ct: Cancellation(), status: { _ in }, delay: 0)
    try check("missing port waits before identification", resolutions == 2)
    for message in ["target ambiguous", "original Hub disconnected", "wrong flash capacity", "Connecting...\n" + failure] {
      resolutions = 0
      try rejects("unrecoverable error stops: \(message)") {
        _ = try DeviceIdentity.readESP(resolve: { resolutions += 1; throw Failure(message) }, identify: { _ in throw Failure("must not open") }, ct: Cancellation(), status: { _ in }, delay: 0)
      }
      try check("unrecoverable error not replayed", resolutions == 1)
    }
    resolutions = 0
    try rejects("bounded absent port wait") {
      _ = try DeviceIdentity.readESP(resolve: { resolutions += 1; throw PortNotReady(message: "missing") }, identify: { $0 }, ct: Cancellation(), status: { _ in }, attempts: 3, delay: 0)
    }
    try check("bounded attempts", resolutions == 3)
    let cancel = Cancellation(); resolutions = 0
    try rejects("unplug cancels retry wait") {
      _ = try DeviceIdentity.readESP(resolve: { resolutions += 1; throw PortNotReady(message: "missing") }, identify: { $0 }, ct: cancel, status: { _ in cancel.cancel() }, delay: 0)
    }
    try check("cancelled target never reopened", resolutions == 1)
    // Run the shipped tool only against a deliberately nonexistent path; no connected hardware is opened.
    var actualError = ""
    do { _ = try EspEngine.identify("/dev/cu.RingHiAbsent-" + UUID().uuidString, Cancellation()) }
    catch { actualError = error.localizedDescription }
    try check("shipped macOS esptool pre-open output recognized", DeviceIdentity.beforePortOpened(actualError))
  }
  static func recoveryChecks() throws {
    for initial in [0, 1] {
      var slot = initial; var commands: [String] = []
      let identity = try DeviceIdentity.flashIdentity(read: { (slot == 0 ? "111111111111111" : "222222222222222", "RingHi") }, command: { cmd, _ in
        commands.append(cmd)
        if cmd == "AT^SIMSLOT=0" { slot = 0 }
        return cmd == "AT^SIMSLOT?" ? "^SIMSLOT: \(slot)\r\nOK" : "OK"
      })
      try check("slot normalized before IMEI " + String(initial), identity.0 == "111111111111111")
      try check("slot restore commands bounded", commands.count == (initial == 0 ? 1 : 4))
    }
    _ = try DeviceIdentity.flashIdentity(read: { ("111111111111111", "ML307H-DC-MBRH1S00") }, command: { _, _ in throw Failure("stock must not change slot") })
    for failure in ["AT^SIMSLOT?", "AT^SIMSLOT=0", "AT^AEM=1,\"ACT\"", "readback"] {
      try rejects("slot failure stops identity: " + failure) {
        _ = try DeviceIdentity.flashIdentity(read: { ("222222222222222", "RingHi") }, command: { cmd, _ in
          if cmd == failure { throw Failure("timeout") }
          return cmd == "AT^SIMSLOT?" ? "^SIMSLOT: 1\r\nOK" : "OK"
        })
      }
    }
    let uid = String(repeating: "a", count: 32)
    let backup = Disk.root.appendingPathComponent("recovery-backup").path
    var ledger: Object = ["uid": uid, "project_id": 42, "stage": "key-requesting", "session": backup]
    let path = Disk.root.appendingPathComponent("activation/\(uid).json")
    let prior: Object = ["uid": uid, "phase": "activating", "imei": "111111111111111", "mac": "test-MAC", "firmwareSha256": "fixture-hash", "backup": backup]
    for stage in MLRecovery.stages.union(["complete"]) {
      ledger["stage"] = stage; try Disk.save(path, ledger)
      _ = try MLRecovery.context(prior, mac: "test-MAC", digest: "fixture-hash", project: 42)
      try check("known activation stage recoverable " + stage, true)
    }
    ledger["stage"] = "key-requesting"; try Disk.save(path, ledger)
    for field in ["uid", "backup", "mac", "firmwareSha256", "imei", "phase"] {
      var bad = prior; bad[field] = "different"
      try rejects("recovery mismatch " + field) { _ = try MLRecovery.context(bad, mac: "test-MAC", digest: "fixture-hash", project: 42) }
    }
    try rejects("wrong recovery project") { _ = try MLRecovery.context(prior, mac: "test-MAC", digest: "fixture-hash", project: 43) }
    ledger["stage"] = "unknown"; try Disk.save(path, ledger)
    try rejects("unknown activation stage blocked") { _ = try MLRecovery.context(prior, mac: "test-MAC", digest: "fixture-hash", project: 42) }
  }
  static func run() throws {
    Disk.root = URL(fileURLWithPath: "/tmp/ringhi-native-tests-" + UUID().uuidString)
    print("Isolated evidence: " + Disk.root.path)
    try UpdateTests.run()
    try RecoveryTests.run()
    try recoveryChecks()
    try aliasRecoveryChecks()
    try connectionPoolChecks()
    try check(
      "SHA256 vector",
      Data("abc".utf8).sha256 == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    try check("CRC XMODEM vector", MLProtocol.crc(Data("123456789".utf8)) == 0x31c3)
    try check("checksum LE vector", MLProtocol.checksum(Data([1, 2, 3])) == 0xfdfb)
    for crc in [true, false] {
      let frame = try MLProtocol.frame(0x82, Data([4, 5, 6]), crc: crc)
      try check(
        "frame roundtrip \(crc)", try MLProtocol.decode(frame, crc: crc)?.1 == Data([4, 5, 6]))
      for n in 0..<frame.count {
        try check(
          "fragment \(crc)/\(n)", try MLProtocol.decode(Data(frame.prefix(n)), crc: crc) == nil)
      }
      var bad = frame
      bad[8] ^= 1
      try rejects("corrupt response") { _ = try MLProtocol.decode(bad, crc: crc) }
      let wire = ScriptWire([bad])
      let dl = Download(wire, Cancellation())
      dl.crc = crc
      try rejects("corrupt reply halts download") { try dl.send(1) }
      try rejects("no retry after unknown write") { try dl.send(1) }
      try check("only one write", wire.writes == 1)
    }
    try check("descriptor is 88 bytes", try MLProtocol.partition("factory", 1024).count == 88)
    try rejects("reject invalid partition") { _ = try MLProtocol.partition("../factory", 1024) }
    let environment = ProcessInfo.processInfo.environment
    if let mlPath = environment["RINGHI_TEST_ML_FIRMWARE"] {
      let raw = try Data(contentsOf: URL(fileURLWithPath: mlPath))
      let pkg = try MLPackage(raw)
      try check(
        "real PKG project and MBL order",
        pkg.project == "ringhi" && pkg.writes.last?.target == "mbl")
      try check(
        "protected calibration/factory",
        Set(pkg.protected.map { $0.name }).isSuperset(of: ["calibration", "factory"]))
      var bad = raw
      bad[8] ^= 1
      try rejects("invalid PKG declared size") { _ = try MLPackage(bad) }
    }
    if let espPath = environment["RINGHI_TEST_ESP_FIRMWARE"] {
      try EspEngine.validate(Data(contentsOf: URL(fileURLWithPath: espPath)))
      try check("real ESP32 S3 image", true)
    }
    try rejects("wrong image size") { try EspEngine.validate(Data([0xe9])) }
    for action in ["project-keys", "private-key"] {
      let message = AuthorizationErrors.message(action, code: NSURLErrorTimedOut)
      try check("preparation timeout is not activation: \(action)", message.contains("尚未开始烧录") && message.contains("未领取") && message.contains("超时"))
    }
    try check("TLS failure distinguished", AuthorizationErrors.message("private-key", code: NSURLErrorSecureConnectionFailed).contains("TLS"))
    try check("expired session explained", AuthorizationErrors.message("projects", code: nil, http: 401).contains("重新登录"))
    try check("HTTP failure code retained", AuthorizationErrors.message("project-keys", code: nil, http: 503).contains("HTTP 503"))
    for action in ["activation-key", "third-party-key", "activation-report"] {
      let message = AuthorizationErrors.message(action, code: NSURLErrorTimedOut)
      try check("uncertain activation not replayed: \(action)", message.contains("核对官方激活记录") && !message.contains("未领取"))
    }
    try directAndCSVChecks()
    try authorizationChecks()
    try identityChecks()
    let identity = "Chip type: ESP32-S3\nDetected flash size: 16MB\nMAC: 02:00:00:00:00:01\n"
    try check("MAC identity", try EspEngine.parseIdentity(identity) == "02:00:00:00:00:01")
    try rejects("wrong flash capacity") {
      _ = try EspEngine.parseIdentity(identity.replacingOccurrences(of: "16MB", with: "8MB"))
    }
    try check(
      "progress parses",
      EspEngine.progress("Writing at 0x00000000 [=====] 56.4% 123/456 bytes...") == 57)
    try check("100 percent is not verified", !EspEngine.writeVerified("Writing at 0x01000000 100%"))
    try check(
      "full write positive proof",
      EspEngine.writeVerified("Wrote 16777216 bytes\nHash of data verified."))
    try check(
      "short write rejected", !EspEngine.writeVerified("Wrote 10 bytes\nHash of data verified."))
    try check(
      "independent full MD5",
      EspEngine.digestVerified(
        "Verifying 0x1000000 (16777216) bytes at 0x00000000 in flash\nVerification successful (digest matched)."
      ))
    let pair = Inventory.pairs(devices(), mode: "dual")
    try check("one board per hub", pair.count == 1 && pair[0].ready)
    try check("IOKit location conversion", Inventory.key(0x0212_3000) == "2:1.2.3")
    var d = devices()
    d.append(d[1])
    try check("ambiguous ESP blocked", !Inventory.pairs(d, mode: "dual")[0].ready)
    d = devices()
    d[2].product = 0x1000
    try check("download mode reaches guarded recovery preflight", Inventory.pairs(d, mode: "dual")[0].ready)
    try check(
      "missing chip waits", !Inventory.pairs(Array(devices().prefix(2)), mode: "dual")[0].ready)
    try check("single chip mode", Inventory.pairs(Array(devices().prefix(2)), mode: "esp")[0].ready)
    var report: Object = [
      "runId": "test", "stage": "passed", "ledPolicy": "volte-card-v3",
      "simSlots": [["index": 1, "type": "euicc", "status": "read", "identitySuffix": "12345678"]],
      "checks": [
        ["id": "wifi", "status": "passed"], ["id": "volte", "status": "passed"],
        ["id": "sim", "status": "passed"],
      ],
    ]
    var status: Object = [
      "report": report, "cloudRegistered": true, "pendingUpload": false, "upload": "uploaded",
    ]
    try check("factory strict pass", Factory.evaluate(status).ready)
    status["cloudRegistered"] = false
    try check(
      "wait cloud",
      !Factory.evaluate(status).ready && Factory.evaluate(status).phase == "registration")
    status["cloudRegistered"] = true
    status["pendingUpload"] = true
    try check(
      "wait report", !Factory.evaluate(status).ready && Factory.evaluate(status).phase == "upload")
    status.removeValue(forKey: "pendingUpload")
    try check("missing upload flag not success", !Factory.evaluate(status).ready)
    status["pendingUpload"] = false
    report["checks"] = [["id": "wifi", "status": "failed", "detail": "no Wi-Fi"]]
    status["report"] = report
    try check("failure reason", Factory.evaluate(status).reason.contains("no Wi-Fi"))
    let emptyDetail = "Neither slot confirmed a card, or modem/card query failed"
    let emptyChecks: [Object] = [["id": "wifi", "status": "passed"], ["id": "volte", "status": "passed"], ["id": "sim", "status": "failed", "detail": emptyDetail]]
    let emptySlots: [Object] = [["index": 0, "type": "none", "status": "empty"], ["index": 1, "type": "none", "status": "empty"]]
    let emptyReport: Object = ["runId": "empty", "stage": "failed", "ledPolicy": "volte-card-v3", "checks": emptyChecks, "simSlots": emptySlots]
    let emptyStatus: Object = ["report": emptyReport, "cloudRegistered": true, "pendingUpload": false, "upload": "uploaded"]
    let dual = Factory.evaluate(emptyStatus, product: .dualSim)
    try check("dual empty slots accepted", dual.ready && dual.card.contains("不参与判定"))
    try check("raw device failure preserved", dual.rawStage == "failed" && dual.rawSim.contains(emptyDetail))
    try check("eSIM product never auto downgrades", !Factory.evaluate(emptyStatus).ready)
    for (key, value) in [("cloudRegistered", false as Any), ("cloudRegistered", "true" as Any), ("pendingUpload", true as Any), ("upload", "pending" as Any)] {
      var s = emptyStatus; s[key] = value
      try check("dual keeps cloud gate " + key, !Factory.evaluate(s, product: .dualSim).ready)
    }
    for stage in ["sim_check", "volte_passed", "cancelled", "connected"] {
      var r = emptyReport; r["stage"] = stage; var s = emptyStatus; s["report"] = r
      try check("dual waits terminal " + stage, !Factory.evaluate(s, product: .dualSim).ready)
    }
    for id in ["wifi", "volte", "storage", "unknown_check"] {
      var r = emptyReport; r["checks"] = emptyChecks + [["id": id, "status": "failed", "detail": "real failure"]]
      var s = emptyStatus; s["report"] = r
      try check("dual preserves failure " + id, !Factory.evaluate(s, product: .dualSim).ready)
    }
    for reason in ["Cannot restore SIM slot after eUICC check: timeout", "Original SIM slot restored but recovery marker could not be cleared", "Cannot read/save original SIM slot", "Power interrupted this factory run; retest required", "unknown reason"] {
      var checks = emptyChecks; checks[2]["detail"] = reason
      var r = emptyReport; r["checks"] = checks; var s = emptyStatus; s["report"] = r
      try check("slot error cannot be waived " + reason, !Factory.evaluate(s, product: .dualSim).ready)
    }
    for slots in [Array(emptySlots.prefix(1)), [emptySlots[0], emptySlots[0]], [["index": 0, "type": "none", "status": "empty"], ["index": 1, "type": "unknown", "status": "error"]]] {
      var r = emptyReport; r["simSlots"] = slots; var s = emptyStatus; s["report"] = r
      try check("optional slot snapshots not required", Factory.evaluate(s, product: .dualSim).ready)
    }
    for reason in [emptyDetail, "SIM selection/communication failed", "Cannot restore SIM slot after eUICC check: SIM selection/activation did not respond within deadline"] {
      var checks = emptyChecks; checks[2]["detail"] = reason
      var r = emptyReport; r["checks"] = checks; r.removeValue(forKey: "simSlots")
      var s = emptyStatus; s["report"] = r
      try check("dual optional card result " + reason, Factory.evaluate(s, product: .dualSim).ready)
      try check("eSIM still fails " + reason, !Factory.evaluate(s, product: .simEsim).ready)
      s["cloudRegistered"] = false
      try check("optional failure waits registration", Factory.evaluate(s, product: .dualSim).phase == "registration" && !Factory.evaluate(s, product: .dualSim).ready)
      s["cloudRegistered"] = true; s["pendingUpload"] = true
      try check("optional failure waits upload", Factory.evaluate(s, product: .dualSim).phase == "upload" && !Factory.evaluate(s, product: .dualSim).ready)
      s["pendingUpload"] = false
      try check("raw card failure preserved", Factory.evaluate(s, product: .dualSim).rawSim.contains(reason))
    }
    var passedReport = emptyReport
    passedReport["stage"] = "passed"
    passedReport["checks"] = [["id": "wifi", "status": "passed"], ["id": "volte", "status": "passed"], ["id": "sim", "status": "passed"]]
    for slot: Object in [["index": 0, "type": "sim", "status": "read", "identitySuffix": "123456"], ["index": 1, "type": "unknown", "status": "responding"], ["index": 1, "type": "euicc", "status": "read", "identitySuffix": "garbage!"]] {
      var r = passedReport; r["simSlots"] = [slot]; var s = emptyStatus; s["report"] = r
      try check("eSIM requires valid EID evidence", !Factory.evaluate(s).ready)
      try check("dual does not require EID", Factory.evaluate(s, product: .dualSim).ready)
    }
    for index in [0, 1] {
      var r = passedReport; r["simSlots"] = [["index": index, "type": "euicc", "status": "read", "identitySuffix": "12345678"]]
      var s = emptyStatus; s["report"] = r
      try check("eSIM either slot", Factory.evaluate(s).ready)
    }
    var skuRow = BoardState(); skuRow.productType = ProductType.dualSim.rawValue
    skuRow.cardCheck = dual.card; skuRow.deviceStage = dual.rawStage; skuRow.deviceSim = dual.rawSim
    let skuCSV = String(decoding: CSV.bytes([skuRow]), as: UTF8.self)
    try check("CSV product and original report retained", skuCSV.contains("双 SIM 卡槽") && skuCSV.contains(emptyDetail) && skuCSV.contains("failed"))
    let oldRow = BoardState()
    let oldData = try JSONEncoder().encode(oldRow)
    let oldRoundtrip = try JSONDecoder().decode(BoardState.self, from: oldData)
    try check("legacy row remains unclassified", oldRoundtrip.productType == nil && ProductType.label(oldRoundtrip.productType) == "未记录")
    try check("CSV formula guard", CSV.cell("=1+1") == "\"'=1+1\"")
    var row = BoardState()
    row.mac = "02:00:00:00:00:01"
    row.imei = "000000000000001"
    row.reason = "中文,\"换行\"\n继续"
    let csv = CSV.bytes([row])
    try check("CSV UTF8 BOM", csv.prefix(3) == Data([239, 187, 191]))
    try check(
      "CSV Chinese quoting", String(decoding: csv, as: UTF8.self).contains("\"中文,\"\"换行\"\"\n继续\""))
    try check(
      "CSV identifier precision", String(decoding: csv, as: UTF8.self).contains("'000000000000001"))
    let target = Disk.root.appendingPathComponent("atomic.csv")
    try Disk.verified(target, csv)
    try check("atomic persistence", try Data(contentsOf: target) == csv)
    let cfg = Configuration(
      mode: "dual", limit: 1, production: false, project: 0,
      espURL: URL(fileURLWithPath: "/fixture/esp.bin"),
      mlURL: URL(fileURLWithPath: "/fixture/ml.pkg"), backup: Disk.root)
    let batch = try Batch(
      cfg, Spark(), Disk.root.appendingPathComponent("batch.csv"), scanHardware: false)
    batch.executor = { b in while true { try b.ct.sleep(0.01) } }
    batch.observe(devices())
    try wait { batch.busy }
    try check("worker acquired", batch.boards.count == 1)
    batch.observe([])
    try wait { !batch.busy }
    try check(
      "unplug cancels and releases",
      batch.boards[0].state.result == "已中断" && !batch.boards[0].state.connected)
    batch.observe(devices("two"))
    try wait { batch.busy }
    try check("reinsert new task", batch.boards.count == 2)
    batch.stop()
    try check("stop intake", !batch.accepting)
    try batch.resume()
    try check("resume same batch", batch.accepting)
    try batch.finish()
    try check(
      "close releases tasks and saves CSV",
      !batch.busy && (try Data(contentsOf: batch.csv)) == CSV.bytes(batch.boards.map { $0.state }))
    try rejects("closed batch cannot resume") { try batch.resume() }
    let export = Disk.root.appendingPathComponent("export.csv")
    try batch.export(export)
    try check(
      "export matches autosave", try Data(contentsOf: export) == Data(contentsOf: batch.csv))
    let complete = try Batch(
      cfg, Spark(), Disk.root.appendingPathComponent("complete.csv"), scanHardware: false)
    complete.executor = { _ in }
    complete.observe(devices())
    try wait { !complete.busy }
    try check(
      "success stays connected",
      complete.boards[0].state.connected && complete.boards[0].state.result == "成功")
    complete.observe(devices())
    try check("no duplicate while attached", complete.boards.count == 1)
    complete.observe(devices("replacement"))
    try wait { !complete.busy }
    try check(
      "hub generation prevents missed rapid replug",
      complete.boards.count == 2 && !complete.boards[0].state.connected)
    try complete.finish()
    let output = try OwnedProcess.run(
      URL(fileURLWithPath: "/bin/sh"), ["-c", "printf '中文\\r完成\\n'"], Cancellation(), timeout: 2)
    try check("UTF8 process output", output.contains("中文\n完成"))
    let cancel = Cancellation()
    let pidFile = Disk.root.appendingPathComponent("child.pid")
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { cancel.cancel() }
    let cancelStart = Date()
    try rejects("cancel process group") {
      _ = try OwnedProcess.run(
        URL(fileURLWithPath: "/bin/sh"),
        ["-c", "sleep 60 & echo $! > \"$1\"; wait", "test", pidFile.path], cancel, timeout: 2)
    }
    try check(
      "cancellation releases in under two seconds", Date().timeIntervalSince(cancelStart) < 2)
    let pid = Int32(
      try String(contentsOf: pidFile).trimmingCharacters(in: .whitespacesAndNewlines))!
    Thread.sleep(forTimeInterval: 0.1)
    try check("child no longer running", kill(pid, 0) != 0)
    try rejects("process timeout") {
      _ = try OwnedProcess.run(
        URL(fileURLWithPath: "/bin/sleep"), ["5"], Cancellation(), timeout: 0.1)
    }
    let version = try EspEngine.preflight(Cancellation())
    try check("official bundled esptool", version.contains("5.6.0"))
    print("PASS TOTAL: \(count); no hardware opened, no cloud activation requested.")
  }
}
