import Foundation

enum ProductType: String, CaseIterable, Codable {
  case simEsim = "sim_esim"
  case dualSim = "dual_sim"
  var label: String { self == .simEsim ? "SIM 卡槽 + eSIM 芯片" : "双 SIM 卡槽" }
  static func label(_ value: String?) -> String {
    value.flatMap(ProductType.init(rawValue:))?.label ?? "未记录"
  }
  static func optionalCardFailure(_ report: Object) -> Bool {
    let details: Set<String> = [
      "Neither slot confirmed a card, or modem/card query failed",
      "SIM selection/communication failed",
      "Cannot restore SIM slot after eUICC check: SIM selection/activation did not respond within deadline",
    ]
    let sim = (report["checks"] as? [Object] ?? []).filter { text($0, "id") == "sim" }
    return sim.count == 1 && text(sim[0], "status") == "failed"
      && details.contains(text(sim[0], "detail"))
  }
  static func eidObserved(_ report: Object) -> Bool {
    // The firmware reports only the suffix of its validated 32-digit EID.
    (report["simSlots"] as? [Object] ?? []).contains {
      text($0, "type") == "euicc" && text($0, "status") == "read"
        && matches(text($0, "identitySuffix"), "^[0-9]{8}$")
    }
  }
}
