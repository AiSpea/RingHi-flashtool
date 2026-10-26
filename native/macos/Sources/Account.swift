import CoreFoundation
import Foundation
import Security

enum Credentials {
  static let service = "com.aispea.ringhi.flasher.native.account"
  static func readKeychain(_ service: String, account: String? = nil) throws -> Data? {
    var query: Object = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    if let account { query[kSecAttrAccount as String] = account }
    var value: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &value)
    if status == errSecItemNotFound { return nil }
    try require(status == errSecSuccess, "钥匙串访问未获允许，请在登录窗口重新配置账号（\(status)）")
    return value as? Data
  }
  static func validate(_ value: Object) throws {
    let u = text(value, "username")
    let p = text(value, "password")
    let code = text(value, "pccode")
    try require(
      !u.trimmingCharacters(in: .whitespaces).isEmpty && u.count <= 128 && !p.isEmpty
        && p.count <= 512 && matches(code, "^[A-Za-z0-9+/]{107}=$")
        && Data(base64Encoded: code)?.count == 80, "请填写账号、密码与完整 PC 注册码")
  }
  static func save(_ value: Object) throws {
    try validate(value)
    let data = try JSONSerialization.data(withJSONObject: value)
    let query: Object = [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: "default",
    ]
    let update = SecItemUpdate(
      query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if update == errSecItemNotFound {
      var add = query
      add[kSecValueData as String] = data
      add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      try require(SecItemAdd(add as CFDictionary, nil) == errSecSuccess, "账号未能保存到系统钥匙串")
    } else {
      try require(update == errSecSuccess, "钥匙串账号更新失败")
    }
  }
  static func load() throws -> Object? {
    if let native = try readKeychain(service, account: "default") {
      let value = try json(native)
      try validate(value)
      return value
    }
    let file = Disk.legacy.appendingPathComponent("ml307h-default.enc")
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    let encrypted = try Data(contentsOf: file)
    try require(
      encrypted.prefix(3) == Data("v10".utf8) && encrypted.count > 3 && encrypted.count < 16384,
      "旧账号格式不支持，请重新登录；原账号文件已保留")
    guard let key = try readKeychain("ringhi-flasher Safe Storage", account: "ringhi-flasher Key")
    else { throw Failure("未找到旧版账号钥匙串，请重新登录；原账号文件已保留") }
    let cipher = Data(encrypted.dropFirst(3))
    var plain = Array(repeating: UInt8(0), count: cipher.count + 16)
    var length = Int32(plain.count)
    let result = key.withUnsafeBytes { password in
      cipher.withUnsafeBytes { data in
        rh_legacy_decrypt(
          password.bindMemory(to: UInt8.self).baseAddress, Int32(key.count),
          data.bindMemory(to: UInt8.self).baseAddress, Int32(cipher.count), &plain, &length)
      }
    }
    defer {
      plain.withUnsafeMutableBytes { buffer in
        if let base = buffer.baseAddress { memset_s(base, buffer.count, 0, buffer.count) }
      }
    }
    try require(result == 0, "旧账号解密失败，请重新登录；原文件已保留")
    let value = try json(Data(plain.prefix(Int(length))))
    try validate(value)
    try save(value)
    return value
  }
}
final class RequestDelegate: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
  let done = DispatchSemaphore(value: 0)
  var data = Data()
  var response: HTTPURLResponse?
  var error: Error?
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    self.response = response as? HTTPURLResponse
    completionHandler(.allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    if self.data.count + data.count > 1024 * 1024 {
      error = Failure("官方响应过大")
      dataTask.cancel()
    } else {
      self.data.append(data)
    }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if self.error == nil { self.error = error }
    done.signal()
  }
}
final class Spark {
  private let configuration: () -> URLSessionConfiguration
  init(configuration: @escaping () -> URLSessionConfiguration = Spark.directConfiguration) {
    self.configuration = configuration
  }
  private let lock = NSLock()
  private var token = ""
  private(set) var username = ""
  var selectedProject = 0
  static let routes = [
    "login": "pclogin", "projects": "getauthorize", "project-keys": "getkey",
    "private-key": "getprivatekey", "activation-key": "getactivekey",
    "third-party-key": "get3rdactivekey", "activation-report": "activated",
  ]
  func login(_ credentials: Object, _ ct: Cancellation = Cancellation()) throws {
    try Credentials.validate(credentials)
    let data = try call("login", credentials, ct) as? Object ?? [:]
    let token = text(data, "token")
    try require(matches(token, "^[!-~]{1,4096}$"), "登录返回无效会话")
    lock.with {
      self.token = token
      username = text(credentials, "username")
    }
    for path in [
      Disk.root.appendingPathComponent("project.json"),
      Disk.legacy.appendingPathComponent("ml307h-default-project.json"),
    ] {
      if let p = try? Disk.load(path), text(p, "username") == username,
        let id = p["projectId"] as? Int
      {
        selectedProject = id
        break
      }
    }
  }
  func snapshot() -> Spark {
    let copy = Spark(configuration: configuration)
    lock.with {
      copy.token = token
      copy.username = username
      copy.selectedProject = selectedProject
    }
    return copy
  }
  func select(_ id: Int) throws {
    try require(id > 0, "授权项目无效")
    selectedProject = id
    try Disk.save(
      Disk.root.appendingPathComponent("project.json"), ["username": username, "projectId": id])
  }
  static func directConfiguration() -> URLSessionConfiguration {
    let config = URLSessionConfiguration.ephemeral
    config.connectionProxyDictionary = ["HTTPEnable": 0, "HTTPSEnable": 0, "SOCKSEnable": 0,
      "ProxyAutoConfigEnable": 0, "ProxyAutoDiscoveryEnable": 0]
    config.timeoutIntervalForRequest = 60
    config.timeoutIntervalForResource = 65
    return config
  }
  func call(_ action: String, _ body: Object, _ ct: Cancellation) throws -> Any {
    try ct.check()
    guard let route = Self.routes[action],
      let url = URL(string: "https://spark.aicxtek.com:7702/api/\(route)/")
    else { throw Failure("官方操作无效") }
    var request = URLRequest(url: url)
    request.httpMethod = action == "projects" ? "GET" : "POST"
    let mutation = ["activation-key", "third-party-key", "activation-report"].contains(action)
    request.timeoutInterval = mutation ? 60 : 18
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("PC", forHTTPHeaderField: "Client")
    request.setValue("RingHi-Native/\(Disk.version)", forHTTPHeaderField: "User-Agent")
    if action != "login" {
      request.setValue("Bearer " + lock.with { token }, forHTTPHeaderField: "Authorization")
    }
    if request.httpMethod == "POST" {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
    }
    let delegate = RequestDelegate()
    let configuration = self.configuration()
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    let task = session.dataTask(with: request)
    defer { session.invalidateAndCancel() }
    task.resume()
    let deadline = Date().addingTimeInterval(mutation ? 66 : 21)
    while delegate.done.wait(timeout: .now() + 0.1) != .success {
      if (!mutation && ct.cancelled) || Date() > deadline {
        task.cancel()
        try ct.check()
        throw AuthorizationRequestFailure(message: AuthorizationErrors.message(action, code: NSURLErrorTimedOut),
          retryPreparation: AuthorizationErrors.canRetryPreparation(action, code: NSURLErrorTimedOut))
      }
    }
    // Retain acknowledged device responses even when cancellation arrived in flight.
    if delegate.error != nil || delegate.response?.statusCode != 200 {
      throw AuthorizationRequestFailure(message: AuthorizationErrors.message(action, code: (delegate.error as NSError?)?.code,
        http: delegate.response?.statusCode), retryPreparation: AuthorizationErrors.canRetryPreparation(action,
          code: (delegate.error as NSError?)?.code, http: delegate.response?.statusCode))
    }
    let value = try json(delegate.data)
    try require(text(value, "code") == "200", "官方拒绝请求（业务码 \(text(value,"code"))），请核对账号或授权额度")
    if action == "activation-report" { return ["reported": true] }
    guard let result = value["data"] else { throw Failure("官方响应缺少数据") }
    return result
  }
  func projects() throws -> [Object] {
    let d = try call("projects", [:], Cancellation())
    if let rows = d as? [Object] { return rows }
    return (d as? Object)?["projects"] as? [Object] ?? []
  }
  static func wire(_ value: Object, _ name: String) throws -> Data {
    let s = text(value, name)
    try require(matches(s, "^[ -~]{1,65535}$"), "官方授权材料格式无效")
    return Data(s.utf8)
  }
  static func thirdParty(_ value: Object) throws -> Bool {
    guard let flag = value["has3rd"] as? NSNumber else { throw Failure("官方第三方授权标记缺失") }
    try require(flag == 0 || flag == 1, "官方第三方授权标记无效")
    return flag == 1
  }
}
final class Activation {
  let spark: Spark
  let project: Int
  let ct: Cancellation
  var materials: [Data]
  init(_ spark: Spark, _ project: Int, _ prepared: ProjectAuthorization?, _ ct: Cancellation) throws {
    self.spark = spark; self.project = project; self.ct = ct
    try ct.check()
    guard let prepared else { throw Failure("批次公共授权材料未准备，未开始烧录") }
    materials = try prepared.copyForDevice(project: project, username: spark.username)
  }
  func clear() {
    for i in materials.indices { materials[i].resetBytes(in: 0..<materials[i].count) }
    materials = []
  }
  deinit { clear() }
  static func product(_ bytes: Data) throws -> String {
    try require(!bytes.isEmpty && bytes.count <= 4097, "产品标识长度无效")
    let n = bytes.firstIndex(of: 0) ?? bytes.count
    try require(
      (1...4096).contains(n) && bytes.prefix(n).allSatisfy { (32...126).contains($0) }
        && bytes.dropFirst(n).allSatisfy { $0 == 0 }, "产品标识格式无效")
    return String(decoding: bytes.prefix(n), as: UTF8.self)
  }
  func run(_ dl: Download, _ uid: String, _ backup: URL, _ change: (String) -> Void) throws {
    let ledger = Disk.root.appendingPathComponent("activation/\(uid).json")
    if FileManager.default.fileExists(atPath: ledger.path) {
      let old = try Disk.load(ledger)
      try require(text(old, "stage") == "complete", "上次授权结果待核对，禁止重复领取，请保留原备份")
    }
    var record: Object = [
      "uid": uid, "project_id": project, "session": backup.path, "startedAt": timestamp(),
      "device_written": false, "stage": "preparing",
    ]
    func stage(_ value: String) throws {
      try ct.check()
      record["stage"] = value
      try Disk.save(ledger, record)
      change(value)
    }
    var responses: Object = [:]
    func retain(_ action: String, _ response: Object) throws {
      responses[action] = response
      try ActivationReceipt.save(uid: uid, value: ["uid": uid, "session": backup.path,
        "project": project, "responses": responses])
    }
    defer { clear() }
    do {
      try stage("device-preparing")
      try dl.send(0x42, timeout: 3)
      var random = Data(repeating: 0, count: 32)
      let status = random.withUnsafeMutableBytes {
        SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!)
      }
      try require(status == errSecSuccess, "随机数生成失败")
      try dl.send(0x49, random, timeout: 3)
      for i in materials.indices {
        var bytes = materials[i]
        defer { bytes.resetBytes(in: 0..<bytes.count) }
        try dl.send(UInt16(0x43 + i), bytes, timeout: 3)
      }
      clear()
      let cpu = try Self.product(dl.send(0x47, timeout: 3, accepted: [0x48]).1)
      try stage("key-requesting")
      let license =
        try spark.call("activation-key", ["project_id": project, "cpucode": cpu], ct) as? Object
        ?? [:]
      try retain("activation-key", license)
      let third = try Spark.thirdParty(license)
      try stage("device-writing")
      var main = try Spark.wire(license, "cdkey")
      defer { main.resetBytes(in: 0..<main.count) }
      try dl.send(0x4a, main, timeout: 3)
      if third {
        try stage("third-party-requesting")
        let key =
          try spark.call("third-party-key", ["project_id": project, "cpucode": cpu], ct) as? Object
          ?? [:]
        try retain("third-party-key", key)
        try stage("third-party-writing")
        var extra = try Spark.wire(key, "cdkey")
        defer { extra.resetBytes(in: 0..<extra.count) }
        try dl.send(0x4b, extra, timeout: 3)
      }
      record["device_written"] = true
      try stage("reporting")
      let result =
        try spark.call("activation-report", ["project_id": project, "cpucode": cpu], ct) as? Object
        ?? [:]
      try require(bool(result, "reported"), "官方未确认激活结果")
      try retain("activation-report", result)
      // The official acknowledgement is final even if the user cancelled meanwhile.
      record["stage"] = "complete"
      record["completeAt"] = timestamp()
      try Disk.save(ledger, record)
      change("complete")
    } catch {
      record["stoppedAt"] = timestamp()
      try? Disk.save(ledger, record)
      throw error
    }
  }
}

// Credentials and activation keys remain in the user's protected Keychain, never in CSV/logs.
enum ActivationReceipt {
  static func save(uid: String, value: Object) throws {
    let query: Object = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "com.aispea.ringhi.flasher.native.receipt",
      kSecAttrAccount as String: uid]
    let bytes = try JSONSerialization.data(withJSONObject: value)
    let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
    if status == errSecItemNotFound {
      var add = query; add[kSecValueData as String] = bytes
      add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      try require(SecItemAdd(add as CFDictionary, nil) == errSecSuccess, "授权回执未能保存到钥匙串，请保留现场")
    } else { try require(status == errSecSuccess, "授权回执保存失败，请保留现场") }
  }
}
