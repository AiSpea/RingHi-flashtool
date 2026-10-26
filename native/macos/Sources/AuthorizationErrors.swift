import Foundation

enum AuthorizationErrors {
  static func canRetryPreparation(_ action: String, code: Int?, http: Int? = nil) -> Bool {
    guard ["project-keys", "private-key"].contains(action) else { return false }
    if let http, http != 200 { return [408, 502, 503, 504].contains(http) }
    return [NSURLErrorTimedOut, NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost,
      NSURLErrorDNSLookupFailed, NSURLErrorCannotFindHost, NSURLErrorSecureConnectionFailed].contains(code ?? 0)
  }
  static func message(_ action: String, code: Int?, http: Int? = nil) -> String {
    let detail: String
    if let http, http != 200 {
      detail = http == 401 ? "登录已失效（HTTP 401），请重新登录" : http == 403 ? "访问被拒绝（HTTP 403），请检查账号权限" : "服务器响应 HTTP \(http)"
    } else {
      switch code {
      case NSURLErrorTimedOut: detail = "连接超时"
      case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: detail = "域名解析失败"
      case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted,
           NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateHasUnknownRoot,
           NSURLErrorServerCertificateNotYetValid: detail = "TLS 安全连接失败"
      case NSURLErrorNotConnectedToInternet, NSURLErrorCannotConnectToHost: detail = "无法连接服务器，请检查网络"
      default: detail = "连接中断（\(code ?? 0)）"
      }
    }
    if ["project-keys", "private-key"].contains(action) {
      return "ML307 授权准备失败：\(detail)；批次尚未开始烧录，也未领取设备激活码。请检查网络后重新开启批次。"
    }
    if ["login", "projects"].contains(action) {
      return "官方登录/项目查询失败：\(detail)；此请求不领取设备激活码，请检查网络或重新登录。"
    }
    return "官方激活请求未确认：\(detail)；未自动重试，请核对官方激活记录并保留设备备份。"
  }
}
