import copy, csv, io, json
from pathlib import Path
from types import SimpleNamespace
import pytest
from ringhi import production, storage
from ringhi.product import SIM_ESIM, DUAL_SIM, EMPTY_CARD_DETAIL, PRODUCTS
from ringhi.batch import Config, Batch
from tests.test_core import report, Account


def empty_report():
    s = report(stage="failed")
    r = s["report"]
    r["checks"][-1].update(status="failed", detail=EMPTY_CARD_DETAIL)
    r["simSlots"] = [dict(index=i, type="none", status="empty") for i in (0, 1)]
    return s


def test_same_empty_board_obeys_explicit_product_without_mutating_report():
    s = empty_report()
    saved = copy.deepcopy(s)
    assert production.evaluate(s, DUAL_SIM).ready
    assert not production.evaluate(s, SIM_ESIM).ready
    assert s == saved
    r = production.evaluate(s, DUAL_SIM)
    assert r.raw_stage == "failed" and EMPTY_CARD_DETAIL in r.raw_sim
    assert "不参与判定" in r.card


@pytest.mark.parametrize("key,value", [("cloudRegistered", False), ("cloudRegistered", "true"),
    ("pendingUpload", True), ("pendingUpload", None), ("upload", "failed"), ("upload", "pending")])
def test_dual_sim_keeps_cloud_and_upload_gates(key, value):
    s = empty_report(); s[key] = value
    assert not production.evaluate(s, DUAL_SIM).ready


@pytest.mark.parametrize("id", ["wifi", "volte", "storage", "unknown_check"])
def test_empty_slot_exception_never_hides_other_failures(id):
    s = empty_report()
    s["report"]["checks"].append(dict(id=id, status="failed", detail="real failure"))
    assert not production.evaluate(s, DUAL_SIM).ready


@pytest.mark.parametrize("detail", ["Cannot restore SIM slot after eUICC check: timeout",
    "Original SIM slot restored but recovery marker could not be cleared",
    "Cannot read/save original SIM slot",
    "Power interrupted this factory run; retest required", "unknown reason"])
def test_unknown_or_storage_errors_remain_failures(detail):
    s = empty_report(); s["report"]["checks"][-1]["detail"] = detail
    assert not production.evaluate(s, DUAL_SIM).ready


@pytest.mark.parametrize("stage", ["sim_check", "volte_passed", "cancelled", "connected"])
def test_dual_sim_waits_for_terminal_report(stage):
    s = empty_report(); s["report"]["stage"] = stage
    assert not production.evaluate(s, DUAL_SIM).ready


@pytest.mark.parametrize("bad", ["missing-wifi", "missing-volte", "old-policy", "no-run"])
def test_ambiguous_evidence_never_bypasses(bad):
    s = empty_report(); r = s["report"]
    if bad == "slot-error": r["simSlots"][1]["status"] = "error"
    if bad == "one-slot": r["simSlots"].pop()
    if bad == "duplicate-slot": r["simSlots"][1]["index"] = 0
    if bad.startswith("missing-"): r["checks"] = [c for c in r["checks"] if c["id"] != bad[8:]]
    if bad == "old-policy": r["ledPolicy"] = "module-card-v2"
    if bad == "no-run": r["runId"] = ""
    assert not production.evaluate(s, DUAL_SIM).ready


@pytest.mark.parametrize("slot", [None, dict(index=0, type="sim", status="read", identitySuffix="123456"),
    dict(index=1, type="unknown", status="responding"), dict(index=1, type="euicc", status="read", identitySuffix="garbage!")])
def test_esim_requires_actual_eid_not_any_card_response(slot):
    s = report(); s["report"]["simSlots"] = [slot] if slot else []
    assert not production.evaluate(s, SIM_ESIM).ready
    assert production.evaluate(s, DUAL_SIM).ready


@pytest.mark.parametrize("index", [0, 1])
def test_esim_can_be_in_either_slot(index):
    s = report(); s["report"]["simSlots"][0]["index"] = index
    assert production.evaluate(s, SIM_ESIM).ready


def test_unknown_product_rejected():
    with pytest.raises(ValueError): production.evaluate(report(), "unknown")


def test_batch_snapshot_and_csv_keep_sku(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "ROOT", tmp_path)
    cfg = Config(Path("esp.bin"), Path("ml.pkg"), tmp_path, mode="esp", production=False, product_type=DUAL_SIM)
    batch = Batch(cfg, Account(), None, tmp_path / "batch.csv")
    try:
        cfg.product_type = SIM_ESIM
        assert batch.cfg.product_type == DUAL_SIM
        assert json.loads((batch.folder / "batch.json").read_text())["productType"] == DUAL_SIM
        row = dict(productType=DUAL_SIM, productName=PRODUCTS[DUAL_SIM], cardCheck="不适用", deviceStage="failed", deviceSim=EMPTY_CARD_DETAIL)
        records = list(csv.DictReader(io.StringIO(storage.csv_bytes([row]).decode("utf-8-sig"))))
        assert records[0]["产品类型"] == "双 SIM 卡槽"
        assert records[0]["设备原始产测结果"] == "failed"
        assert records[0]["设备原始有卡检查"] == EMPTY_CARD_DETAIL
        # Existing records without the new fields remain exportable, not relabelled.
        old = list(csv.DictReader(io.StringIO(storage.csv_bytes([{}]).decode("utf-8-sig"))))
        assert old[0]["产品类型"] == ""
    finally: batch.close()


def test_run_dual_empty_waits_for_final_upload(monkeypatch):
    s = empty_report(); waiting = copy.deepcopy(s); waiting["pendingUpload"] = True
    statuses = iter([dict(report={}, pendingUpload=False), waiting, s])
    events = []; wire = SimpleNamespace(close=lambda: events.append("close"))
    cancel = SimpleNamespace(check=lambda: None, sleep=lambda delay: None)
    monkeypatch.setattr(production, "open_ready", lambda *a, **kw: wire)
    monkeypatch.setattr(production, "status", lambda *a: next(statuses))
    monkeypatch.setattr(production, "command", lambda *a: "armed")
    changes = []
    result = production.run(lambda: "fixture", cancel, changes.append, DUAL_SIM)
    assert result.ready and result.phase == "complete"
    assert any(r.phase == "upload" and not r.ready for r in changes)
    assert events == ["close"]


RESTORE_TIMEOUT = ("Cannot restore SIM slot after eUICC check: "
                   "SIM selection/activation did not respond within deadline")


@pytest.mark.parametrize("detail", [EMPTY_CARD_DETAIL, RESTORE_TIMEOUT, "SIM selection/communication failed"])
@pytest.mark.parametrize("slots", [[], [dict(index=1, status="error")], None])
def test_dual_product_ignores_optional_card_diagnostics_only(detail, slots):
    s = empty_report()
    s["report"]["checks"][-1]["detail"] = detail
    s["report"]["simSlots"] = slots
    original = copy.deepcopy(s)
    r = production.evaluate(s, DUAL_SIM)
    assert r.ready and r.raw_stage == "failed" and detail in r.raw_sim
    assert "不参与判定" in r.card
    assert not production.evaluate(s, SIM_ESIM).ready
    assert s == original


@pytest.mark.parametrize("key,value", [("cloudRegistered", False), ("pendingUpload", True), ("upload", "pending")])
def test_restore_failure_exemption_still_waits_for_cloud(key, value):
    s = empty_report()
    s["report"]["checks"][-1]["detail"] = RESTORE_TIMEOUT
    s[key] = value
    r = production.evaluate(s, DUAL_SIM)
    assert r.state == "passed" and not r.ready


@pytest.mark.parametrize("id", ["wifi", "volte", "storage"])
def test_restore_exemption_does_not_hide_mandatory_failures(id):
    s = empty_report()
    s["report"]["checks"][-1]["detail"] = RESTORE_TIMEOUT
    s["report"]["checks"].append(dict(id=id, status="failed", detail="required failure"))
    assert not production.evaluate(s, DUAL_SIM).ready


def test_restore_failure_run_waits_for_registration_and_final_report(monkeypatch):
    terminal = empty_report()
    terminal["report"]["checks"][-1]["detail"] = RESTORE_TIMEOUT
    unregistered = copy.deepcopy(terminal)
    unregistered.update(cloudRegistered=False, pendingUpload=True, upload="pending")
    uploading = copy.deepcopy(terminal)
    uploading.update(pendingUpload=True, upload="uploading")
    statuses = iter([dict(report={}, pendingUpload=False), unregistered, uploading, terminal])
    events = []
    port = SimpleNamespace(close=lambda: events.append("close"))
    monkeypatch.setattr(production, "open_ready", lambda *a, **kw: port)
    monkeypatch.setattr(production, "status", lambda *a: next(statuses))
    monkeypatch.setattr(production, "command", lambda *a: "armed")
    changes = []
    result = production.run(None, SimpleNamespace(check=lambda: None, sleep=lambda n: None), changes.append, DUAL_SIM)
    assert result.ready
    assert any(r.phase == "registration" and not r.ready for r in changes)
    assert any(r.phase == "upload" and not r.ready for r in changes)
    assert RESTORE_TIMEOUT in result.raw_sim
    assert events == ["close"]
