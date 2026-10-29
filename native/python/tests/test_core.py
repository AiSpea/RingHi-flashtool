import threading, time
from pathlib import Path
import pytest
from ringhi import storage, ports, esp, modem
from ringhi.storage import Cancel, Cancelled
from ringhi.package import crc16, checksum, Package
from ringhi.protocol import frame, decode, Download
from ringhi.account import Prepared, NetworkError, wire_value
from ringhi.production import evaluate
from ringhi.batch import Batch, Config
from ringhi.wire import open_ready, identity, CommandRejected


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "ROOT", tmp_path / "data")


def test_known_vectors():
    assert crc16(b"123456789") == 0x31C3
    assert checksum(bytes([1, 2, 3])) == 0xFDFB


@pytest.mark.parametrize("crc", [False, True])
@pytest.mark.parametrize("size", [0, 1, 2, 255, 256, 4096])
def test_frame_fragmented(crc, size):
    payload = b"1" * size
    data = frame(0x82, payload, crc)
    assert decode(data, crc) == (0x82, payload)
    assert decode(data[:9], crc) is None
    corrupt = bytearray(data)
    corrupt[-3] ^= 1
    with pytest.raises(OSError):
        decode(corrupt, crc)


class FakeWire:
    def __init__(self, data):
        self.data = data
        self.writes = []

    def write(self, data):
        self.writes.append(data)

    def read(self):
        data = self.data
        self.data = b""
        return data


def test_bad_reply_never_replayed():
    w = FakeWire(frame(0x80, b"")[:-1] + b"0")
    dl = Download(w, Cancel())
    with pytest.raises(OSError):
        dl.send(1)
    with pytest.raises(OSError):
        dl.send(1)
    assert len(w.writes) == 1


def report(stage="passed", cloud=True, pending=False, upload="uploaded"):
    return dict(
        cloudRegistered=cloud,
        pendingUpload=pending,
        upload=upload,
        report=dict(
            runId="round-2",
            stage=stage,
            ledPolicy="volte-card-v3",
            simSlots=[dict(index=1, type="euicc", status="read", identitySuffix="12345678")],
            checks=[dict(id=i, status="passed") for i in ("wifi", "volte", "sim")],
        ),
    )


@pytest.mark.parametrize(
    "cloud,pending,upload,ready",
    [
        (True, False, "uploaded", True),
        (False, False, "uploaded", False),
        (True, True, "uploaded", False),
        (True, False, "pending", False),
    ],
)
def test_all_factory_gates(cloud, pending, upload, ready):
    assert evaluate(report(cloud=cloud, pending=pending, upload=upload)).ready is ready


@pytest.mark.parametrize(
    "bad",
    ["missing-check", "bad-policy", "failed", "cancelled", "no-run", "missing-pending"],
)
def test_factory_never_false_success(bad):
    r = report()
    if bad == "missing-check":
        r["report"]["checks"].pop()
    if bad == "bad-policy":
        r["report"]["ledPolicy"] = "old"
    if bad in ("failed", "cancelled"):
        r["report"]["stage"] = bad
    if bad == "no-run":
        r["report"]["runId"] = ""
    if bad == "missing-pending":
        del r["pendingUpload"]
    assert not evaluate(r).ready


class Account:
    username = "fixture"
    project = 188

    def ensure_authorized(self, *args, **kwargs):
        pass

    def note_authorized(self):
        pass

    def choose_route(self, *args):
        pass

    def close_current(self):
        pass

    def __init__(self):
        self.calls = []
        self.fail = False

    def call(self, action, body, **kwargs):
        self.calls.append(action)
        if self.fail and self.calls.count(action) == 1:
            raise NetworkError("temporary", True)
        return dict(AES="TEST_AES", rsa_n="TEST_N", rsa_e="TEST_E", rsa_d="TEST_D")


def test_batch_authorization_shared(monkeypatch):
    monkeypatch.setattr(Cancel, "sleep", lambda *a: None)
    a = Account()
    a.fail = True
    p = Prepared(a, Cancel(), lambda s: None)
    one = p.copy(a)
    two = p.copy(a)
    one[0][0] = 0
    assert two[0] == b"TEST_AES"
    assert a.calls == ["project-keys", "project-keys", "private-key", "private-key"]
    p.close()
    with pytest.raises(ValueError):
        p.copy(a)
    assert two[0] == b"TEST_AES"


def test_activation_reads_not_business_retries():
    class Reject(Account):
        def call(self, *args, **kwargs):
            self.calls.append(args[0])
            raise NetworkError("403", False)

    a = Reject()
    with pytest.raises(NetworkError):
        Prepared(a, Cancel(), lambda s: None)
    assert len(a.calls) == 1


@pytest.mark.parametrize("value", ["", "\n", "中文", None])
def test_material_validation(value):
    with pytest.raises(ValueError):
        wire_value({"x": value}, "x")


def test_open_ready_re_resolves_before_commands(monkeypatch):
    monkeypatch.setattr(Cancel, "sleep", lambda *a: None)
    calls = []

    def resolve():
        calls.append("resolve")
        if len(calls) < 3:
            raise ports.NotReady("transition")
        return ports.Port("COM8", "x", "c", "h", 1, None)

    assert open_ready(resolve, Cancel(), opener=lambda p, c: p) == "COM8"
    assert len(calls) == 3


def test_open_ambiguity_no_retry():
    calls = []

    def resolve():
        calls.append(1)
        raise ports.Ambiguous("multiple")

    with pytest.raises(ports.Ambiguous):
        open_ready(resolve, Cancel())
    assert len(calls) == 1


def pair(hub, node=1, mode="runtime"):
    return [
        ports.Port(
            "COM1", "USB\\VID_303A&PID_1001\\00:11:22:33:44:55", hub + "E", hub, node, 0
        ),
        ports.Port(
            "COM2",
            "USB\\VID_3563&PID_"
            + dict(runtime="2000", download="1000", generic="2001")[mode],
            hub + "M",
            hub,
            node,
            4 if mode == "runtime" else None,
        ),
    ]


@pytest.mark.parametrize("mode", ["runtime", "download", "generic"])
def test_topology_modes(mode):
    assert pair("A", mode=mode)[1].mode == mode


def test_hub_and_chip_identity():
    ps = pair("A") + pair("B")
    assert ports.select(ps, "B", "BM", "runtime").path == "COM2"
    with pytest.raises(ports.NotReady):
        ports.select(ps, "B", "AM", "runtime")
    with pytest.raises(ports.Ambiguous):
        ports.select(ps + [ps[0]], "A", "AE", "esp")


def until(fn):
    deadline = time.monotonic() + 3
    while not fn():
        if time.monotonic() > deadline:
            raise AssertionError("timed out")
        time.sleep(0.01)


def config(tmp_path, limit=2):
    return Config(
        tmp_path / "esp.bin",
        tmp_path / "ml.pkg",
        tmp_path / "backups",
        mode="esp",
        production=False,
        limit=limit,
    )


def test_unplug_reinsert_queue_released_csv(tmp_path):
    runs = []

    def execute(b, resolve):
        runs.append(b.id)
        while len(runs) == 1:
            b.cancel.sleep(0.01)

    batch = Batch(
        config(tmp_path, 1), Account(), None, tmp_path / "batch.csv", execute=execute
    )
    batch.observe(pair("A"), {"A"})
    until(lambda: len(runs) == 1)
    batch.observe([], set())
    batch.observe(pair("A", 2), {"A"})
    until(lambda: len(runs) == 2 and not batch.busy)
    rows = batch.snapshots()
    assert len(rows) == 2 and not rows[0]["connected"] and rows[1]["connected"]
    assert rows[0]["result"] == "已中断" and rows[1]["result"] == "成功"
    batch.save()
    batch.export(tmp_path / "export.csv")
    assert (tmp_path / "batch.csv").read_bytes() == (
        tmp_path / "export.csv"
    ).read_bytes()
    batch.close()


def test_success_stays_connected_until_removal(tmp_path):
    batch = Batch(
        config(tmp_path), Account(), None, tmp_path / "out.csv", execute=lambda *a: None
    )
    batch.observe(pair("A"), {"A"})
    until(lambda: not batch.busy)
    assert batch.snapshots()[0]["connected"]
    batch.observe(pair("A"), {"A"})
    assert len(batch.rows) == 1
    batch.observe([], set())
    assert not batch.snapshots()[0]["connected"]
    batch.close()


def test_pause_resume_without_duplicate_rows(tmp_path):
    entered = threading.Event()
    release = threading.Event()

    def execute(b, resolve):
        entered.set()
        release.wait(2)

    batch = Batch(
        config(tmp_path, 1), Account(), None, tmp_path / "out.csv", execute=execute
    )
    batch.observe(pair("A") + pair("B"), {"A", "B"})
    assert entered.wait(1)
    batch.pause()
    release.set()
    until(lambda: not batch.busy)
    batch.resume()
    batch.execute = lambda *a: None
    batch.observe(pair("A") + pair("B"), {"A", "B"})
    until(lambda: not batch.busy)
    assert len(batch.rows) == 2
    assert all(r["result"] == "成功" for r in batch.snapshots())
    batch.close()


def test_close_cancel_saves(tmp_path):
    def execute(b, resolve):
        while True:
            b.cancel.sleep(0.02)

    batch = Batch(
        config(tmp_path), Account(), None, tmp_path / "out.csv", execute=execute
    )
    batch.observe(pair("A"), {"A"})
    until(lambda: batch.rows[0].state["result"] == "身份检查")
    batch.close()
    assert not batch.busy and "已中断" in (tmp_path / "out.csv").read_text("utf-8-sig")


def test_generic_no_hardware_call(tmp_path):
    a = Account()
    p = Prepared(a, Cancel(), lambda s: None)
    cfg = config(tmp_path)
    cfg.mode = "dual"
    calls = []
    batch = Batch(cfg, a, p, tmp_path / "out.csv", execute=lambda *a: calls.append(1))
    batch.observe(pair("A", mode="generic"), {"A"})
    assert not calls
    assert batch.rows[0].state["result"] == "需要恢复"
    batch.close()


def test_csv_injection_identifiers(tmp_path):
    raw = storage.csv_bytes(
        [
            {
                "mac": "00:01:02:03:04:05",
                "imei": "001234567890123",
                "reason": '=HYPERLINK("x")\n逗号,测试',
            }
        ]
    )
    assert raw.startswith(b"\xef\xbb\xbf")
    assert "'001234567890123" in raw.decode("utf-8")
    assert "'=HYPERLINK" in raw.decode("utf-8")


@pytest.mark.parametrize(
    "text",
    [
        "Verification successful (digest matched).",
        "Wrote 4096 bytes\nHash of data verified.",
    ],
)
def test_esp_cannot_accept_partial_hash(text):
    assert not esp.write_verified(text) and not esp.digest_verified(text)


def test_full_esp_proof():
    assert esp.write_verified(
        "Wrote 16777216 bytes (1 compressed) at 0x00000000\nHash of data verified."
    )
    assert esp.digest_verified(
        "Verifying 0x1000000 (16777216) bytes at 0x00000000 in flash\nVerification successful (digest matched)."
    )


@pytest.mark.parametrize(
    "phase", ["writing", "activating", "awaiting-verification", "backing-up"]
)
def test_intents_not_treated_as_unwritten(phase):
    assert not modem.no_flash_written({"phase": phase})


def test_backup_uid_gate():
    with pytest.raises(OSError):
        modem.check_uid("a" * 32, "b" * 32)
    modem.check_uid("a" * 32, "a" * 32)


def test_pkg_reject_short():
    with pytest.raises(ValueError):
        Package(b"fake")


def test_real_images_if_available():
    root = Path.home() / "Desktop" / "RingHi"
    packages = list(root.glob("*.pkg"))
    images = list(root.glob("*142*.bin"))
    if not packages:
        pytest.skip("no firmware fixture on host")
    p = Package(packages[0].read_bytes())
    assert p.project == "ringhi" and p.protected and p.writes[-1].target == "mbl"
    if images:
        esp.validate_image(images[0].read_bytes())


def test_atomic_failed_replace_preserves(tmp_path, monkeypatch):
    path = tmp_path / "data.csv"
    storage.atomic(path, b"original")

    def fail(*a):
        raise PermissionError("locked")

    monkeypatch.setattr(storage.os, "replace", fail)
    with pytest.raises(PermissionError):
        storage.atomic(path, b"new")
    assert path.read_bytes() == b"original"


def test_read_only_boot_identity_wait(monkeypatch):
    import ringhi.wire as w

    calls = []

    def fake(wire, cmd, cancel, **kwargs):
        calls.append(cmd)
        if cmd == "AT+CGMR" and calls.count(cmd) == 1:
            raise CommandRejected("boot not ready")
        return {
            "AT+CGMM": "ML307H\r\nOK",
            "AT+CGMR": "ringhi v26.019\r\nOK",
            "AT+CGSN=1": "123456789012345\r\nOK",
        }[cmd]

    monkeypatch.setattr(w, "at", fake)
    monkeypatch.setattr(Cancel, "sleep", lambda *a: None)
    assert identity(None, Cancel(), boot_wait=5)[0] == "123456789012345"
    assert calls.count("AT+CGMR") == 2
    assert all(c.startswith("AT+CG") for c in calls)


def test_recovery_backup_integrity(tmp_path):
    from types import SimpleNamespace

    data = b"factory-calibration"
    file = tmp_path / "factory.bin"
    file.write_bytes(data)
    package = SimpleNamespace(
        digest="matching",
        protected=[SimpleNamespace(name="factory", capacity=len(data))],
    )
    state = dict(
        firmwareSha256="matching",
        uid="a" * 32,
        backup=str(tmp_path),
        backups={"factory": {"file": str(file), "sha256": storage.sha(data)}},
    )
    assert modem.original_backups(state, package)["factory"] == data
    file.write_bytes(b"corrupted")
    with pytest.raises(OSError):
        modem.original_backups(state, package)


def test_recovery_never_accepts_other_package(tmp_path):
    from types import SimpleNamespace

    with pytest.raises(OSError):
        modem.original_backups(
            dict(firmwareSha256="wrong", uid="a" * 32), SimpleNamespace(digest="right")
        )


def test_atomic_hub_replacement_cancels_old_before_queue(tmp_path):
    runs = []

    def execute(b, resolve):
        runs.append(b.id)
        if len(runs) == 1:
            while True:
                b.cancel.sleep(0.01)

    batch = Batch(
        config(tmp_path, 2), Account(), None, tmp_path / "out.csv", execute=execute
    )
    batch.observe(pair("A", 1), {"A"})
    until(lambda: len(runs) == 1)
    batch.observe(pair("A", 99), {"A"})
    until(lambda: len(runs) == 2 and not batch.busy)
    assert len(batch.rows) == 2 and batch.rows[0].cancel.event.is_set()
    assert batch.rows[1].state["result"] == "成功"
    batch.close()


def test_update_asset_source_and_versions():
    from ringhi.updates import allowed, version

    assert allowed(
        "https://github.com/AiSpea/RingHi-flashtool/releases/download/v0.5.1/RingHi-Python-0.5.1-win-x64.zip"
    )
    assert not allowed(
        "https://evil.invalid/AiSpea/RingHi-flashtool/releases/download/x"
    )
    assert not allowed("http://github.com/AiSpea/RingHi-flashtool/releases/download/x")
    assert version("v0.5.0") > version("0.4.5")
    assert version("v0.5.0-rc1") == (0, 0, 0)


def test_ml_preflight_failure_prevents_esp_write(tmp_path, monkeypatch):
    import ringhi.batch as module

    a = Account()
    p = Prepared(a, Cancel(), lambda s: None)
    cfg = config(tmp_path)
    cfg.mode = "dual"
    called = []
    monkeypatch.setattr(module.esp, "identify", lambda *a: "00:11:22:33:44:55")

    def reject(*a):
        raise ValueError("wrong modem model")

    monkeypatch.setattr(module.modem, "preflight", reject)
    monkeypatch.setattr(module.esp, "flash", lambda *a: called.append("write"))
    batch = Batch(cfg, a, p, tmp_path / "out.csv")
    batch.observe(pair("A"), {"A"})
    until(lambda: not batch.busy)
    assert not called and batch.snapshots()[0]["result"] == "失败"
    batch.close()


def test_activation_uncertainty_allows_new_task_without_transport_loop(tmp_path):
    from ringhi.account import activate

    class Cloud(Account):
        def call(self, action, body, **kwargs):
            if action == "activation-key":
                self.calls.append(action)
                raise NetworkError("unknown request outcome", False)
            return super().call(action, body)

    class Device:
        def send(self, cmd, *args, **kwargs):
            return (0x48, b"CPU_FIXTURE\0") if cmd == 0x47 else (0x80, b"")

    a = Cloud()
    prepared = Prepared(a, Cancel(), lambda s: None)
    with pytest.raises(NetworkError):
        activate(Device(), "a" * 32, tmp_path, a, prepared, Cancel(), lambda s: None)
    assert a.calls.count("activation-key") == 1
    with pytest.raises(NetworkError):
        activate(Device(), "a" * 32, tmp_path, a, prepared, Cancel(), lambda s: None)
    assert a.calls.count("activation-key") == 2
    assert len(list((storage.ROOT / "activation" / "history").glob("*.json"))) == 1
    assert (
        "TEST_AES"
        not in (storage.ROOT / "activation" / ("a" * 32 + ".json")).read_text()
    )
    prepared.close()


def test_ui_close_session_guard_not_cross_hub(tmp_path):
    b = Batch(
        config(tmp_path), Account(), None, tmp_path / "out.csv", execute=lambda *a: None
    )
    b.observe(pair("A"), {"A"})
    until(lambda: not b.busy)
    old = b.rows[0]
    b.observe([], set())
    b.observe(pair("A", 2), {"A"})
    with pytest.raises(Cancelled):
        b.resolve(old, "esp")
    b.close()


def test_partial_backup_resume_keeps_verified_original(tmp_path):
    from types import SimpleNamespace

    file = tmp_path / "factory.bin"
    file.write_bytes(b"1234")
    pkg = SimpleNamespace(
        digest="p",
        protected=[
            SimpleNamespace(name="factory", capacity=4),
            SimpleNamespace(name="calibration", capacity=4),
        ],
    )
    state = dict(
        firmwareSha256="p",
        uid="a" * 32,
        backup=str(tmp_path),
        backups={"factory": {"file": str(file), "sha256": storage.sha(b"1234")}},
    )
    assert modem.original_backups(state, pkg, partial=True) == {"factory": b"1234"}
    with pytest.raises(OSError):
        modem.original_backups(state, pkg)


def test_new_batch_csv_saved_and_existing_history_never_overwritten(tmp_path):
    path = tmp_path / "new.csv"
    storage.create_batch_csv(path)
    assert path.read_bytes() == storage.csv_bytes([])
    original = storage.csv_bytes([{"task": 1, "mac": "00:01:02:03:04:05"}])
    path.write_bytes(original)
    with pytest.raises(ValueError, match="已存在"):
        storage.create_batch_csv(path)
    assert path.read_bytes() == original
    with pytest.raises(OSError):
        storage.create_batch_csv(tmp_path / "missing" / "new.csv")


def test_usb_reset_disconnect_reopens_same_chip_without_reset(monkeypatch):
    from types import SimpleNamespace

    calls = []
    paths = iter(["COM40", "COM41"])

    def run(port, command, args, cancel, **kwargs):
        calls.append((port, command, kwargs["before"]))
        if len(calls) == 1:
            raise OSError(
                "ClearCommError failed (PermissionError(13, 'error', None, 22))"
            )
        return (
            "Chip type: ESP32-S3\nDetected flash size: 16 MB\nMAC: 00:11:22:33:44:55\n"
        )

    monkeypatch.setattr(esp, "run", run)
    monkeypatch.setattr(Cancel, "sleep", lambda *args: None)
    assert (
        esp.identify(lambda: SimpleNamespace(path=next(paths)), Cancel())
        == "00:11:22:33:44:55"
    )
    assert calls == [
        ("COM40", "flash-id", "default-reset"),
        ("COM41", "flash-id", "no-reset"),
    ]


def test_esp_wrong_identity_is_not_retried(monkeypatch):
    from types import SimpleNamespace

    calls = []
    monkeypatch.setattr(
        esp, "run", lambda *a, **kw: calls.append(a) or "Chip type: ESP32-C3"
    )
    with pytest.raises(OSError, match="容量"):
        esp.identify(lambda: SimpleNamespace(path="COM1"), Cancel())
    assert len(calls) == 1


def test_windows_esptool_error_decodes_local_codepage():
    text = "设备不识别此命令"
    assert esp.decode_output(text.encode("gb18030")) == text
    assert esp.decode_output(text.encode("utf-8")) == text


def test_device_identity_visible_before_network_wait(tmp_path, monkeypatch):
    from ringhi import batch as module

    events = []
    cfg = config(tmp_path)
    cfg.mode = "dual"
    a = Account()

    def network_ready(*args, **kwargs):
        events.append("network")
        assert b.mac == "00:11:22:33:44:55"
        assert b.snapshot()["imei"] == "1" * 15
        raise NetworkError("permission rejected", False, category="business")

    a.ensure_authorized = network_ready
    batch = Batch(cfg, a, object(), tmp_path / "out.csv", execute=lambda *args: None)
    b = module.Board(1, "A", pair("A"))
    monkeypatch.setattr(
        module.esp,
        "identify",
        lambda *a: events.append("esp-id") or "00:11:22:33:44:55",
    )
    monkeypatch.setattr(
        module.modem,
        "preflight",
        lambda *a: events.append("ml-id") or b.update(imei="1" * 15),
    )
    with pytest.raises(NetworkError):
        batch._hardware(b)
    assert events == ["esp-id", "ml-id", "network"]
    batch.prepared = None
    batch.close()


@pytest.mark.parametrize("mode", ["esp", "runtime"])
def test_esp_resolve_refreshes_changed_com_without_switching_chip(tmp_path, mode):
    current=pair('A')
    b=Batch(config(tmp_path),Account(),None,tmp_path/'out.csv',
            scanner=lambda:(current,{'A'}),execute=lambda *a:None)
    b.observe(current,{'A'});until(lambda:not b.busy)
    row=b.rows[0]
    from dataclasses import replace
    old=b.resolve(row,mode)
    current=[replace(p,path='COM88') if p.mode==mode else p for p in current]
    assert b.resolve(row,mode).path=='COM88' and old.path!='COM88'
    current=[p for p in current if p.mode!=mode]
    with pytest.raises(ports.NotReady):b.resolve(row,mode)
    b.close()


def test_esp_refresh_rejects_new_connection_generation(tmp_path):
    current=pair('A')
    b=Batch(config(tmp_path),Account(),None,tmp_path/'out.csv',
            scanner=lambda:(current,{'A'}),execute=lambda *a:None)
    b.observe(current,{'A'});until(lambda:not b.busy)
    old=b.rows[0]
    current=pair('A',99)
    with pytest.raises(Cancelled):b.resolve(old,'esp')
    b.close()
