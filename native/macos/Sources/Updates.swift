import AppKit
import Foundation
import Darwin

struct MacRelease: Equatable {
  let version: String
  let archive: URL
  let checksums: URL
  var filename: String { "RingHi-Native-\(version)-mac-arm64.zip" }
}
enum MacUpdates {
  static let repository = "AiSpea/RingHi-flashtool"
  static func version(_ value: String) -> [Int]? {
    guard matches(value, #"^\d+\.\d+\.\d+$"#) else { return nil }
    let result = value.split(separator: ".").compactMap { Int($0) }
    return result.count == 3 ? result : nil
  }
  static func newer(_ a: String, than b: String) -> Bool {
    guard let a = version(a), let b = version(b) else { return false }
    return b.lexicographicallyPrecedes(a)
  }
  static func assetURL(_ value: String, tag: String, name: String) -> URL? {
    guard let url = URL(string: value), url.scheme == "https", url.host == "github.com",
      url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
      url.path == "/\(repository)/releases/download/\(tag)/\(name)" else { return nil }
    return url
  }
  static func select(_ releases: [Object], current: String) throws -> MacRelease? {
    let candidates = releases.filter { !bool($0, "draft") && !bool($0, "prerelease")
      && text($0, "tag_name").hasPrefix("mac-v")
      && newer(String(text($0, "tag_name").dropFirst(5)), than: current)
    }.sorted { newer(String(text($0, "tag_name").dropFirst(5)), than: String(text($1, "tag_name").dropFirst(5))) }
    for release in candidates {
      let tag = text(release, "tag_name"), v = String(tag.dropFirst(5))
      let filename = "RingHi-Native-\(v)-mac-arm64.zip"
      let assets = release["assets"] as? [Object] ?? []
      guard let archive = assets.first(where: { text($0, "name") == filename }),
        let sums = assets.first(where: { text($0, "name") == "SHA256SUMS.txt" }) else { continue }
      guard let a = assetURL(text(archive, "browser_download_url"), tag: tag, name: filename),
        let s = assetURL(text(sums, "browser_download_url"), tag: tag, name: "SHA256SUMS.txt")
      else { throw Failure("Mac 更新包来源无效") }
      return MacRelease(version: v, archive: a, checksums: s)
    }
    return nil
  }
  static func expectedHash(_ data: Data, name: String) throws -> String {
    try require(data.count <= 65536, "更新校验清单过大")
    let values = String(decoding: data, as: UTF8.self).split(whereSeparator: \.isNewline).compactMap { line -> String? in
      let parts = line.split(whereSeparator: \.isWhitespace)
      guard parts.count == 2, parts[1] == name || parts[1] == "*" + name else { return nil }
      return String(parts[0]).lowercased()
    }
    try require(values.count == 1 && matches(values[0], "^[a-f0-9]{64}$"), "更新包缺少唯一的 SHA-256 校验值")
    return values[0]
  }
  static func check(current: String = Disk.version, ct: Cancellation) throws -> MacRelease? {
    // Mac has a separate feed; Windows owns /releases/latest.
    var releases: [Object] = []
    for page in 1...3 {
      let url = URL(string: "https://api.github.com/repos/\(repository)/releases?per_page=100&page=\(page)")!
      let data = try UpdateTransfer.fetch(url, limit: 4 * 1024 * 1024, ct: ct)
      guard let batch = try JSONSerialization.jsonObject(with: data) as? [Object] else { throw Failure("Mac 版本列表格式错误") }
      releases += batch
      if batch.count < 100 { break }
    }
    return try select(releases, current: current)
  }
  static func validateZIP(_ data: Data) throws {
    // Validate central and local paths before ditto extracts the archive.
    try require(data.count >= 22, "更新压缩包不完整")
    guard let end = stride(from: data.count - 22, through: max(0, data.count - 65557), by: -1).first(where: {
      data.uint($0, 4) == 0x06054b50 && $0 + 22 + Int(data.uint($0 + 20, 2)) == data.count
    }) else { throw Failure("更新压缩包目录无效") }
    let count = Int(data.uint(end + 10, 2)), size = Int(data.uint(end + 12, 4))
    var offset = Int(data.uint(end + 16, 4)), expanded: UInt64 = 0
    try require(data.uint(end + 4, 4) == 0 && data.uint(end + 8, 2) == UInt64(count)
      && count > 0 && count < 10000 && offset + size == end, "不支持此更新压缩包")
    var names = Set<String>()
    for _ in 0..<count {
      try require(offset + 46 <= end && data.uint(offset, 4) == 0x02014b50, "压缩包条目无效")
      let length = Int(data.uint(offset + 28, 2)), extra = Int(data.uint(offset + 30, 2)), comment = Int(data.uint(offset + 32, 2))
      let next = offset + 46 + length + extra + comment
      try require(next <= end, "压缩包目录越界")
      guard let name = String(data: data.subdata(in: offset + 46..<offset + 46 + length), encoding: .utf8) else { throw Failure("压缩包路径无效") }
      let parts = name.split(separator: "/", omittingEmptySubsequences: false)
      try require(name.hasPrefix("RingHi Flasher.app/") && !name.contains("\\") && !name.contains("\0")
        && !parts.contains("..") && !parts.contains(".") && !names.contains(name.lowercased()), "压缩包包含不安全或重复路径")
      names.insert(name.lowercased())
      let kind = (data.uint(offset + 38, 4) >> 16) & 0xf000
      try require(kind == 0 || kind == 0x8000 || kind == 0x4000, "更新包不能包含符号链接")
      try require(data.uint(offset + 8, 2) & 1 == 0, "不支持加密更新包")
      expanded += data.uint(offset + 24, 4)
      try require(expanded <= 512 * 1024 * 1024, "更新包解压大小超限")
      let local = Int(data.uint(offset + 42, 4))
      try require(local + 30 <= data.count && data.uint(local, 4) == 0x04034b50, "压缩包文件头无效")
      let localLength = Int(data.uint(local + 26, 2))
      try require(local + 30 + localLength <= data.count
        && data.subdata(in: local + 30..<local + 30 + localLength) == Data(name.utf8), "压缩包路径不一致")
      offset = next
    }
    try require(offset == end, "压缩包目录长度不一致")
  }
  static func verifyApp(_ app: URL, version: String) throws {
    let info = try Data(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
    let plist = try PropertyListSerialization.propertyList(from: info, format: nil) as? Object ?? [:]
    try require(text(plist, "CFBundleIdentifier") == "com.aispea.ringhi.flasher"
      && text(plist, "CFBundleShortVersionString") == version
      && text(plist, "CFBundleExecutable") == "RingHi Flasher", "更新应用的标识或版本不一致")
    _ = try OwnedProcess.run(URL(fileURLWithPath: "/usr/bin/codesign"), ["--verify", "--deep", "--strict", app.path], Cancellation(), timeout: 30)
  }
  static func stage(_ release: MacRelease, ct: Cancellation, progress: @escaping (String) -> Void) throws -> URL {
    progress("正在下载校验清单…")
    let expected = try expectedHash(UpdateTransfer.fetch(release.checksums, limit: 65536, ct: ct), name: release.filename)
    progress("正在下载 Mac \(release.version)…")
    var lastAmount = ""
    let archive = try UpdateTransfer.fetch(release.archive, limit: 128 * 1024 * 1024, ct: ct, timeout: 600) { received, total in
      let amount = total > 0 ? "\(min(99, Int(Double(received) / Double(total) * 100)))%" : "\(received / 1024 / 1024) MB"
      if amount != lastAmount { lastAmount = amount; progress("正在下载 Mac \(release.version) · \(amount)") }
    }
    try require(archive.sha256 == expected, "更新包 SHA-256 校验失败，原应用未改动")
    try validateZIP(archive); try ct.check()
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("RingHi-update-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    do {
      let zip = root.appendingPathComponent("update.zip"), unpacked = root.appendingPathComponent("unpacked")
      try archive.write(to: zip); progress("正在校验新应用…")
      _ = try OwnedProcess.run(URL(fileURLWithPath: "/usr/bin/ditto"), ["-x", "-k", zip.path, unpacked.path], ct, timeout: 60)
      let app = unpacked.appendingPathComponent("RingHi Flasher.app")
      try verifyApp(app, version: release.version)
      try FileManager.default.removeItem(at: zip)
      return app
    } catch { try? FileManager.default.removeItem(at: root); throw error }
  }
}

// Anonymous direct HTTPS; bounded downloads and restricted asset redirects.
final class UpdateTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  let lock = NSLock(), done = DispatchSemaphore(value: 0)
  var data = Data(), error: Error?, expected: Int64 = 0
  let limit: Int
  let progress: (Int, Int64) -> Void
  init(limit: Int, progress: @escaping (Int, Int64) -> Void) { self.limit = limit; self.progress = progress }
  static func allowed(_ url: URL) -> Bool {
    url.scheme == "https" && url.user == nil && url.password == nil && url.port == nil
      && ["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].contains(url.host ?? "")
  }
  static func fetch(_ url: URL, limit: Int, ct: Cancellation, timeout: Double = 45,
    progress: @escaping (Int, Int64) -> Void = { _, _ in },
    configuration: URLSessionConfiguration? = nil) throws -> Data {
    try require(allowed(url), "更新地址无效"); try ct.check()
    let delegate = UpdateTransfer(limit: limit, progress: progress)
    let cfg = configuration ?? Spark.directConfiguration()
    cfg.timeoutIntervalForRequest = 30; cfg.timeoutIntervalForResource = timeout
    let session = URLSession(configuration: cfg, delegate: delegate, delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    var request = URLRequest(url: url); request.setValue("RingHi-Mac/" + Disk.version, forHTTPHeaderField: "User-Agent")
    let task = session.dataTask(with: request); task.resume()
    let deadline = Date().addingTimeInterval(timeout)
    while delegate.done.wait(timeout: .now() + 0.1) == .timedOut {
      try ct.check(); try require(Date() < deadline, "检查或下载更新超时，请稍后重试")
    }
    return try delegate.lock.with { if let error = delegate.error { throw error }; return delegate.data }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    let allowed = request.url.map(Self.allowed) ?? false
    if !allowed { lock.with { error = Failure("更新下载重定向来源无效") } }
    completionHandler(allowed ? request : nil)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard (response as? HTTPURLResponse)?.statusCode == 200, response.expectedContentLength <= limit else {
      lock.with { error = Failure("更新服务响应异常或文件过大") }; completionHandler(.cancel); return
    }
    expected = response.expectedContentLength; completionHandler(.allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
    let received = lock.with { () -> Int in
      if data.count + chunk.count > limit { error = Failure("更新下载超出大小限制"); return -1 }
      data.append(chunk); return data.count
    }
    if received < 0 { dataTask.cancel() } else { progress(received, expected) }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError failure: Error?) {
    lock.with { if error == nil { error = failure } }; done.signal()
  }
}
