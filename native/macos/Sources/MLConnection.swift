import Foundation

struct USBTransportFailure: LocalizedError {
  let code: Int32
  let message: String
  var errorDescription: String? { message }
}
struct ATNotReady: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}
struct PortOpenTimeout: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}
struct RecoveryTiming {
  var now: () -> Double = { ProcessInfo.processInfo.systemUptime }
  var pause: (Double, Cancellation) throws -> Void = { try $1.sleep($0) }
}
enum MLConnection {
  static func transientOpen(_ error: Error) -> Bool {
    if error is PortNotReady { return true }
    guard let usb = error as? USBTransportFailure else { return false }
    return [-3, -4, -6].contains(usb.code) // Access/busy can end when an old handle closes.
  }
  static func runtimeRetry(_ error: Error) -> Bool {
    transientOpen(error) || error is PortOpenTimeout || error is ATNotReady
      || (error as? USBTransportFailure)?.code == -1
  }
  static func open(_ ct: Cancellation, target: String, timeout: Double = 30,
    status: (String) -> Void = { _ in }, timing: RecoveryTiming = RecoveryTiming(),
    acquire: () throws -> Wire) throws -> Wire {
    let end = timing.now() + timeout
    var last = ""
    while true {
      try ct.check()
      let wire: Wire
      do { wire = try acquire() }
      catch {
        try ct.check()
        guard transientOpen(error) else { throw error }
        let message = target + "：" + error.localizedDescription
        if timing.now() >= end { throw PortOpenTimeout(message: "等待超时 · " + message) }
        if message != last { status("等待接口恢复 · " + message); last = message }
        try timing.pause(0.3, ct)
        continue
      }
      do { try ct.check() } catch { wire.close(); throw error }
      return wire
    }
  }
  static func openUSB(_ resolve: (String, Bool) throws -> USBDevice, download: Bool,
    ct: Cancellation, timeout: Double = 30, status: (String) -> Void = { _ in }) throws -> Wire {
    try open(ct, target: download ? "ML307 下载口" : "ML307 运行 AT 口", timeout: timeout, status: status) {
      try USBWire(resolve("ml", download), download: download)
    }
  }
  // Neither interface may exist during a normal switch. Identity ambiguity is fatal.
  static func waitDownload(_ ct: Cancellation, timeout: Double = 45,
    timing: RecoveryTiming = RecoveryTiming(), downloadPresent: () throws -> Void,
    runtimePresent: () throws -> Void, fallback: () throws -> Void) throws {
    let start = timing.now()
    var attempted = false
    var last = "下载口尚未枚举"
    while timing.now() - start < timeout {
      try ct.check()
      do { try downloadPresent(); return }
      catch let e as PortNotReady { last = e.localizedDescription }
      if !attempted && timing.now() - start >= 8 {
        var present = false
        do { try runtimePresent(); present = true } catch is PortNotReady {}
        if present {
          attempted = true
          do { try fallback() }
          catch is DownloadAppeared { return }
          catch is PortOpenTimeout {}
          catch let e as USBTransportFailure where e.code == -4 {}
        }
      }
      try timing.pause(0.3, ct)
    }
    throw PortOpenTimeout(message: "ML307 下载模式切换超时；未开始新的写入：" + last)
  }
  struct DownloadAppeared: Error {}
  static func enterDownload(_ resolve: (String, Bool) throws -> USBDevice,
    imei: String, ct: Cancellation, status: (String) -> Void) throws {
    status("切换 ML307 下载模式")
    let wire = try openUSB(resolve, download: false, ct: ct, status: status)
    do {
      defer { wire.close() }
      try require(try DeviceIdentity.flashIdentity(wire, ct).0 == imei, "下载前 IMEI 改变")
      _ = try AT.command(wire, "AT^AUTODL", ct, timeout: 3, disconnectOK: true)
    }
    status("等待 ML307 下载口重新枚举")
    try waitDownload(ct, downloadPresent: { _ = try resolve("ml", true) },
      runtimePresent: { _ = try resolve("ml", false) }, fallback: {
        let at = try open(ct, target: "ML307 切换中的 AT 口", timeout: 3, status: status) {
          var appeared = false
          do { _ = try resolve("ml", true); appeared = true } catch is PortNotReady {}
          if appeared { throw DownloadAppeared() }
          return try USBWire(resolve("ml", false), download: false)
        }
        defer { at.close() }
        try require(try DeviceIdentity.flashIdentity(at, ct).0 == imei, "复位前 IMEI 改变")
        status("ML307 仍在运行模式 · 确认身份后复位一次")
        _ = try AT.command(at, "AT^RESET=normal", ct, timeout: 3, disconnectOK: true)
      })
  }
  static func verify(_ ct: Cancellation, imei: String, timeout: Double = 60,
    status: (String) -> Void, timing: RecoveryTiming = RecoveryTiming(),
    readIdentity: () throws -> (String, String)) throws -> String {
    let end = timing.now() + timeout
    while true {
      try ct.check()
      let identity: (String, String)
      do { identity = try readIdentity() }
      catch {
        try ct.check()
        guard runtimeRetry(error) else { throw error }
        if timing.now() >= end {
          throw Failure("ML307 启动核验超时；写入和授权记录已保留：" + error.localizedDescription)
        }
        status("等待 ML307 启动身份就绪 · " + error.localizedDescription)
        try timing.pause(0.5, ct)
        continue
      }
      try require(identity.0 == imei, "复位后 IMEI 与原设备不一致")
      try require(identity.1.lowercased().contains("ringhi"), "复位后 RingHi 固件未确认")
      return identity.1
    }
  }
  static func verifyRuntime(_ resolve: (String, Bool) throws -> USBDevice,
    imei: String, ct: Cancellation, status: (String) -> Void) throws -> String {
    try verify(ct, imei: imei, status: status) {
      let wire = try openUSB(resolve, download: false, ct: ct, timeout: 5, status: status)
      defer { wire.close() }
      return try DeviceIdentity.flashIdentity(wire, ct)
    }
  }
}
