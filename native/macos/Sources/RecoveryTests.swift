import Foundation

private final class RecoveryWire: Wire {
  var received: [Data] = []
  var error: Error?
  var sent: [Data] = []
  var closed = false
  func write(_ data: Data, _ ct: Cancellation) throws { try ct.check(); sent.append(data) }
  func read(_ timeout: Int, _ ct: Cancellation) throws -> Data {
    try ct.check()
    if let error { throw error }
    return received.isEmpty ? Data() : received.removeFirst()
  }
  func close() { closed = true }
}
enum RecoveryTests {
  static func run() throws {
    let check = SelfTests.check
    let rejects = SelfTests.rejects
    var time = 0.0
    let timing = RecoveryTiming(now: { time }, pause: { delay, ct in try ct.check(); time += delay })
    for code: Int32 in [-3, -4, -6] {
      var attempts = 0
      let expected = RecoveryWire()
      let wire = try MLConnection.open(Cancellation(), target: "download", timing: timing) {
        attempts += 1
        if attempts < 3 { throw USBTransportFailure(code: code, message: "temporary") }
        return expected
      }
      try check("USB open refresh retry \(code)", wire === expected && attempts == 3)
    }
    for error: Error in [Failure("ambiguous"), USBTransportFailure(code: -5, message: "invalid interface")] {
      var attempts = 0
      try rejects("ambiguous/invalid interface never retried") {
        _ = try MLConnection.open(Cancellation(), target: "download", timing: timing) { attempts += 1; throw error }
      }
      try check("open fails once", attempts == 1)
    }
    time = 0
    var statuses: [String] = []
    do {
      _ = try MLConnection.open(Cancellation(), target: "运行 AT 口", timeout: 1,
        status: { statuses.append($0) }, timing: timing) { throw PortNotReady(message: "missing") }
      throw Failure("Expected open timeout")
    } catch let e as PortOpenTimeout {
      try check("timeout retains requested mode", e.localizedDescription.contains("运行 AT 口"))
    }
    try check("bounded open and deduplicated status", time < 1.5 && statuses.count == 1)
    let cancelled = Cancellation(), opened = RecoveryWire()
    try rejects("cancel after open releases handle") {
      _ = try MLConnection.open(cancelled, target: "runtime") { cancelled.cancel(); return opened }
    }
    try check("cancelled handle closed", opened.closed)

    time = 0
    var fallbacks = 0
    try MLConnection.waitDownload(Cancellation(), timing: timing, downloadPresent: {
      if time < 12 { throw PortNotReady(message: "gap") }
    }, runtimePresent: { throw PortNotReady(message: "old AT gone") }, fallback: { fallbacks += 1 })
    try check("download appears after both interfaces absent", time >= 12 && fallbacks == 0)
    time = 0
    try MLConnection.waitDownload(Cancellation(), timing: timing, downloadPresent: {
      if time < 12 { throw PortNotReady(message: "gap") }
    }, runtimePresent: {}, fallback: { fallbacks += 1; throw PortOpenTimeout(message: "AT disappeared") })
    try check("fallback open timeout keeps waiting and never repeats reset", fallbacks == 1)
    time = 0; fallbacks = 0
    try MLConnection.waitDownload(Cancellation(), timing: timing,
      downloadPresent: { throw PortNotReady(message: "gap") }, runtimePresent: {},
      fallback: { fallbacks += 1; throw MLConnection.DownloadAppeared() })
    try check("download arriving during fallback skips reset", fallbacks == 1 && time < 9)
    time = 0
    try rejects("mode switch bounded when neither interface returns") {
      try MLConnection.waitDownload(Cancellation(), timeout: 10, timing: timing,
        downloadPresent: { throw PortNotReady(message: "gap") },
        runtimePresent: { throw PortNotReady(message: "gap") }, fallback: { throw Failure("must not reset") })
    }
    try check("bounded mode switch", time >= 10 && time < 11)
    time = 0
    try rejects("identity mismatch at fallback is fatal") {
      try MLConnection.waitDownload(Cancellation(), timing: timing,
        downloadPresent: { throw PortNotReady(message: "gap") }, runtimePresent: {}, fallback: { throw Failure("identity mismatch") })
    }
    try check("identity failure not swallowed for 45 seconds", time < 9)

    var reads = 0
    time = 0
    let version = try MLConnection.verify(Cancellation(), imei: "fixture", status: { _ in }, timing: timing) {
      reads += 1
      if reads == 1 { throw USBTransportFailure(code: -4, message: "boot disconnect") }
      if reads == 2 { throw ATNotReady(message: "boot not ready") }
      return ("fixture", "RingHi fixture")
    }
    try check("runtime reopening reaches confirmed identity", reads == 3 && version == "RingHi fixture")
    for identity in [("other", "RingHi"), ("fixture", "wrong firmware")] {
      reads = 0
      try rejects("wrong boot identity or firmware is fatal") {
        _ = try MLConnection.verify(Cancellation(), imei: "fixture", status: { _ in }, timing: timing) { reads += 1; return identity }
      }
      try check("wrong identity not retried", reads == 1)
    }
    time = 0
    try rejects("startup confirmation timeout remains failure") {
      _ = try MLConnection.verify(Cancellation(), imei: "fixture", timeout: 2, status: { _ in }, timing: timing) {
        throw ATNotReady(message: "still booting")
      }
    }
    try check("startup timeout is bounded", time == 2)

    let prior: Object = ["imei": "111111111111111", "backup": Disk.root.appendingPathComponent("recovery-complete").path,
      "phase": "awaiting-verification", "uid": String(repeating: "a", count: 32)]
    try MLRecovery.saveState(prior)
    let board = Board(BoardState())
    try rejects("failed startup retains durable awaiting-verification and 98 percent") {
      try MLRecovery.finishVerification(board, prior) { throw Failure("boot timeout") }
    }
    let intent = Disk.root.appendingPathComponent("ml-intents/111111111111111.json")
    try check("failed verification never marks verified", text(try Disk.load(intent), "phase") == "awaiting-verification" && board.state.mlProgress == 98)
    try MLRecovery.finishVerification(board, prior) { "RingHi fixture" }
    let completed = try Disk.load(intent)
    try check("successful verification records time and version", text(completed, "phase") == "verified" && !text(completed, "verifiedAt").isEmpty && text(completed, "versionAfter") == "RingHi fixture")
    try check("successful verification reaches 100 only after saving", board.state.mlProgress == 100)

    let ack = RecoveryWire(); ack.received = [try MLProtocol.frame(0x80, Data(), crc: false)]
    try check("reset waits for acknowledgement", try Download(ack, Cancellation()).reset())
    try check("reset frame sent only once", ack.sent.count == 1)
    let gone = RecoveryWire(); gone.error = USBTransportFailure(code: -4, message: "no device")
    try check("reset disconnect requires later boot verification", try !Download(gone, Cancellation()).reset())
    let silent = RecoveryWire()
    try check("reset without receipt remains unconfirmed", try !Download(silent, Cancellation()).reset(timeout: 0.001))
    for code: Int32 in [-1, -9] {
      let fault = RecoveryWire(); fault.error = USBTransportFailure(code: code, message: "I/O fault")
      try rejects("reset does not hide arbitrary USB error") { try Download(fault, Cancellation()).reset() }
    }
    let rejected = RecoveryWire(); rejected.received = [try MLProtocol.frame(0x81, Data(), crc: false)]
    try rejects("reset rejection preserved") { try Download(rejected, Cancellation()).reset() }
    let failedWrite = Download(gone, Cancellation())
    try rejects("same disconnect during Flash write is fatal") { try failedWrite.send(2, Data([1])) }
    try check("write marks session broken", failedWrite.broken)
    let count = gone.sent.count
    try rejects("broken write cannot be replayed") { try failedWrite.send(2, Data([1])) }
    try check("uncertain data not sent again", gone.sent.count == count)
  }
}
