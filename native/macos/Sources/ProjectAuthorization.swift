import Foundation

struct AuthorizationRequestFailure: LocalizedError {
  let message: String
  let retryPreparation: Bool
  var errorDescription: String? { message }
}
final class ProjectAuthorization {
  private let lock = NSLock()
  private let project: Int
  private let username: String
  private var parts: [Data]?
  private init(project: Int, username: String, parts: [Data]) {
    self.project = project; self.username = username; self.parts = parts
  }
  static func prepare(_ spark: Spark, project: Int, ct: Cancellation, status: (String) -> Void) throws -> ProjectAuthorization {
    try prepare(username: spark.username, project: project, request: {
      try spark.call($0, ["project_id": project], ct) as? Object ?? [:]
    }, ct: ct, status: status)
  }
  static func prepare(username: String, project: Int, request: (String) throws -> Object,
    ct: Cancellation, status: (String) -> Void, delay: Double = 1) throws -> ProjectAuthorization {
    try require(project > 0 && !username.isEmpty, "请先登录并选择授权项目")
    func fetch(_ action: String) throws -> Object {
      for attempt in 0..<2 {
        try ct.check()
        status(attempt == 0 ? "正在准备本批次公共授权材料…" : "授权服务暂时连接失败，正在重试公共材料（2/2）…")
        do { return try request(action) }
        catch let e as AuthorizationRequestFailure {
          if !e.retryPreparation || attempt == 1 { throw e }
          try ct.sleep(delay)
        }
      }
      throw Failure("授权准备未完成")
    }
    var parts: [Data] = []
    defer { for i in parts.indices { parts[i].resetBytes(in: 0..<parts[i].count) } }
    let keys = try fetch("project-keys")
    for name in ["AES", "rsa_n", "rsa_e"] { parts.append(try Spark.wire(keys, name)) }
    let privateKey = try fetch("private-key")
    parts.append(try Spark.wire(privateKey, "rsa_d"))
    try ct.check()
    return ProjectAuthorization(project: project, username: username, parts: parts)
  }
  func requireReady(project: Int, username: String) throws {
    try lock.with { try require(parts != nil && self.project == project && self.username == username,
      "批次授权未就绪或账号/项目已变化，请重新开启批次") }
  }
  func copyForDevice(project: Int, username: String) throws -> [Data] {
    try lock.with {
      try require(parts != nil && self.project == project && self.username == username,
        "批次授权未就绪或账号/项目已变化，请重新开启批次")
      return parts!
    }
  }
  func release() {
    lock.with {
      if var current = parts { for i in current.indices { current[i].resetBytes(in: 0..<current[i].count) } }
      parts = nil
    }
  }
  deinit { release() }
}
