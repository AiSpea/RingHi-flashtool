"""Explicit batch product policy; never infer the SKU from a missing eSIM."""
SIM_ESIM = "sim_esim"
DUAL_SIM = "dual_sim"
PRODUCTS = {SIM_ESIM: "SIM 卡槽 + eSIM 芯片", DUAL_SIM: "双 SIM 卡槽"}
EMPTY_CARD_DETAIL = "Neither slot confirmed a card, or modem/card query failed"


def validate(product_type):
    if product_type not in PRODUCTS:
        raise ValueError("请选择有效的产品类型")
    return product_type


def optional_card_failure(report):
    # The dual-empty-slot SKU does not require SIM/eSIM diagnostics, including
    # their slot restoration. Do not exempt storage errors, interrupted runs or
    # unknown firmware failures merely because legacy firmware labels them sim.
    details = {
        EMPTY_CARD_DETAIL,
        "SIM selection/communication failed",
        "Cannot restore SIM slot after eUICC check: "
        "SIM selection/activation did not respond within deadline",
    }
    checks = report.get("checks") or []
    sim = [c for c in checks if c.get("id") == "sim"]
    return (len(sim) == 1 and sim[0].get("status") == "failed"
            and sim[0].get("detail") in details)


def eid_observed(report):
    # Firmware reports only the last eight digits of a validated 32-digit EID.
    return any(
        s.get("type") == "euicc" and s.get("status") == "read"
        and isinstance(s.get("identitySuffix"), str)
        and len(s["identitySuffix"]) == 8 and s["identitySuffix"].isascii()
        and s["identitySuffix"].isdigit()
        for s in (report.get("simSlots") or [])
    )
