import Foundation

// One URLSession owns the connection pool. Each task keeps its own response and
// cancellation delegate; cancelling one board never invalidates another's session.
final class OfficialHTTP: NSObject, URLSessionDataDelegate {
  private let lock = NSLock()
  private var requests: [Int: RequestDelegate] = [:]
  private var session: URLSession!
  init(configuration: URLSessionConfiguration) {
    super.init()
    session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }
  func task(_ request: URLRequest) -> (URLSessionDataTask, RequestDelegate) {
    let response = RequestDelegate()
    let task = session.dataTask(with: request)
    lock.with { requests[task.taskIdentifier] = response }
    return (task, response)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
    didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let handler = lock.with({ requests[dataTask.taskIdentifier] }) else { completionHandler(.cancel); return }
    handler.urlSession(session, dataTask: dataTask, didReceive: response, completionHandler: completionHandler)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.with { requests[dataTask.taskIdentifier] }?.urlSession(session, dataTask: dataTask, didReceive: data)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let handler = lock.with { requests.removeValue(forKey: task.taskIdentifier) }
    handler?.urlSession(session, task: task, didCompleteWithError: error)
  }
  func close() { session.invalidateAndCancel() }
}

// URLSession retains its delegate. This owner breaks that cycle at the end of
// the last account/batch snapshot, after the batch has joined its device workers.
final class OfficialConnectionPool {
  let http: OfficialHTTP
  init(_ configuration: URLSessionConfiguration) { http = OfficialHTTP(configuration: configuration) }
  deinit { http.close() }
}
