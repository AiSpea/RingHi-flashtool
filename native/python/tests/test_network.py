import ssl
import threading
from types import SimpleNamespace
import pytest
import requests
from ringhi import network, storage
from ringhi.storage import Cancel, Cancelled


class Response:
    status_code = 200

    def __init__(self, code=200, data=b'{"code":200,"data":{}}'):
        self.status_code, self.data = code, data

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError()

    def iter_content(self, size):
        yield self.data

    def json(self):
        import json

        return json.loads(self._content)


@pytest.fixture
def fake(monkeypatch, tmp_path):
    monkeypatch.setattr(storage, "ROOT", tmp_path)
    monkeypatch.setattr(Cancel, "sleep", lambda self, delay: self.check())
    state = SimpleNamespace(sessions=[], calls=[], replies=[], health=[])

    class Session:
        def __init__(self):
            self.closed = False
            state.sessions.append(self)

        def mount(self, *args):
            pass

        def close(self):
            self.closed = True

        def get(self, url, **kwargs):
            state.calls.append(("health", self.trust_env, kwargs))
            item = state.health.pop(0) if state.health else Response(data=b"hello")
            if isinstance(item, Exception):
                raise item
            return item

        def request(self, method, url, **kwargs):
            state.calls.append(("api", self.trust_env, kwargs))
            item = state.replies.pop(0) if state.replies else Response()
            if isinstance(item, Exception):
                raise item
            return item

    monkeypatch.setattr(network.requests, "Session", Session)
    return state


def call(t, action="activation-key", **kwargs):
    return t.request(
        action,
        "POST",
        "/api/getactivekey/",
        {"Authorization": "Bearer PRIVATE_TOKEN"},
        {"cpucode": "PRIVATE_CPU"},
        **kwargs,
    )


def posts(fake):
    return [c for c in fake.calls if c[0] == "api"]


def test_reuse_actual_api_without_homepage_gate_or_credentials_in_log(fake):
    t = network.Transport()
    call(t)
    call(t)
    assert len(fake.sessions) == 1 and len(posts(fake)) == 2
    health = [c for c in fake.calls if c[0] == "health"]
    assert health == []
    assert all(not c[1] for c in fake.calls)
    log = (storage.ROOT / "network-diagnostics.jsonl").read_text()
    assert "PRIVATE" not in log and "Authorization" not in log and "cpucode" not in log
    t.close_current()
    assert fake.sessions[0].closed


@pytest.mark.parametrize(
    "error",
    [
        requests.ReadTimeout("secret"),
        requests.ConnectionError("secret"),
        requests.exceptions.SSLError("UNEXPECTED_EOF_WHILE_READING"),
    ],
)
def test_ambiguous_post_never_replayed(fake, error):
    fake.replies = [error]
    with pytest.raises(network.NetworkError) as caught:
        call(network.Transport())
    assert len(posts(fake)) == 1 and caught.value.delivery == "unknown"
    assert "secret" not in (storage.ROOT / "network-diagnostics.jsonl").read_text()


def test_tracked_tls_failure_can_retry_without_second_business_request(fake):
    error = requests.ConnectionError(network.BeforeSendError("TLS setup"))
    fake.replies = [error, Response()]
    call(network.Transport())
    assert len(posts(fake)) == 2 and len(fake.sessions) == 2 and fake.sessions[0].closed


def test_before_send_retries_are_bounded(fake):
    fake.replies = [requests.ConnectTimeout() for _ in range(4)]
    with pytest.raises(network.NetworkError) as caught:
        call(network.Transport())
    assert len(posts(fake)) == 4 and caught.value.delivery == "not-sent"


def test_read_only_can_recover_lost_response(fake):
    fake.replies = [requests.ReadTimeout(), Response(503), Response()]
    assert call(network.Transport(), "project-keys").status_code == 200
    assert len(posts(fake)) == 3


def test_auth_rejection_not_network_retry(fake):
    from ringhi.account import Account

    fake.replies = [Response(200, b'{"code":401}')]
    with pytest.raises(network.NetworkError, match="登录会话失效"):
        Account().call("activation-key")
    assert len(posts(fake)) == 1


def test_cancel_during_recovery_sends_no_further_request(fake):
    cancel = Cancel()
    fake.replies = [requests.ConnectTimeout()]
    with pytest.raises(Cancelled):
        call(network.Transport(), cancel=cancel, status=lambda s: cancel.cancel())
    assert len(posts(fake)) == 1


def test_homepage_failure_does_not_gate_actual_api(fake):
    fake.health = [requests.ConnectionError() for _ in range(4)]
    assert call(network.Transport()).status_code == 200
    assert len(posts(fake)) == 1 and len(fake.health) == 4


def test_sessions_do_not_cross_worker_threads(fake):
    t = network.Transport()
    barrier = threading.Barrier(2)
    ids = []

    def work():
        s = t.session()
        ids.append(id(s))
        barrier.wait()
        t.close_current()

    threads = [threading.Thread(target=work) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(2)
    assert len(set(ids)) == 2 and all(s.closed for s in fake.sessions)


def test_connect_phase_is_marked_and_certificate_preserved(monkeypatch):
    def fail(self):
        raise ssl.SSLCertVerificationError("certificate failed")

    monkeypatch.setattr(network.HTTPSConnection, "connect", fail)
    c = network.TrackedConnection("example.invalid")
    with pytest.raises(network.BeforeSendError) as caught:
        c.connect()
    assert network.classify(caught.value) == ("certificate", "not-sent")


def test_adapter_tracks_direct_and_proxy_without_global_changes():
    from urllib3.poolmanager import pool_classes_by_scheme

    original = pool_classes_by_scheme["https"]
    adapter = network.PhaseAdapter(max_retries=0)
    assert adapter.poolmanager.pool_classes_by_scheme["https"] is network.TrackedPool
    assert (
        adapter.proxy_manager_for("http://127.0.0.1:1").pool_classes_by_scheme["https"]
        is network.TrackedPool
    )
    assert pool_classes_by_scheme["https"] is original
    adapter.close()


def test_certificate_failure_never_weakens_verification_or_retries_post(fake):
    before = network.BeforeSendError("setup")
    before.__cause__ = ssl.SSLCertVerificationError("CERTIFICATE_VERIFY_FAILED")
    fake.replies = [requests.ConnectionError(before)]
    with pytest.raises(network.NetworkError) as caught:
        call(network.Transport())
    assert caught.value.category == "certificate" and len(posts(fake)) == 1
    assert all(c[2].get("verify", True) for c in fake.calls)


def test_activation_can_resume_but_incomplete_context_stays_blocked(
    tmp_path, monkeypatch
):
    from ringhi.account import activate, Prepared, retryable_activation
    from ringhi import account as account_module

    monkeypatch.setattr(
        account_module, "dpapi", lambda data, encrypt=False: b"SEALED_TEST"
    )
    monkeypatch.setattr(storage, "ROOT", tmp_path)

    class Account:
        username = "fixture"
        project = 188
        use_proxy = False

        def __init__(self):
            self.keys = 0

        def close_current(self):
            pass

        def ensure_authorized(self, *args, **kwargs):
            pass

        def note_authorized(self):
            pass

        def choose_route(self, *args):
            pass

        def call(self, action, body, **kwargs):
            if action == "activation-key":
                self.keys += 1
                return {"cdkey": "TEST_CDKEY", "has3rd": False}
            if action == "activation-report":
                return {"reported": True}
            return dict(AES="TEST_AES", rsa_n="TEST_N", rsa_e="TEST_E", rsa_d="TEST_D")

    class Device:
        def send(self, cmd, *args, **kwargs):
            return (0x48, b"CPU_FIXTURE\0") if cmd == 0x47 else (0x80, b"")

    account = Account()
    prepared = Prepared(account, Cancel(), lambda s: None)
    path = tmp_path / "activation" / ("a" * 32 + ".json")
    record = dict(
        uid="a" * 32,
        project_id=188,
        session=str(tmp_path),
        stage="key-requesting",
        device_written=False,
        network={"delivery": "not-sent", "category": "connect"},
    )
    storage.save_json(path, record)
    assert retryable_activation(record)
    activate(Device(), "a" * 32, tmp_path, account, prepared, Cancel(), lambda s: None)
    assert storage.read_json(path)["stage"] == "complete" and account.keys == 1
    assert len(list((tmp_path / "activation" / "history").glob("*.json"))) == 1
    assert not retryable_activation(
        {"stage": "key-requesting", "device_written": False}
    )
    assert not retryable_activation(
        {
            "stage": "reporting",
            "device_written": True,
            "network": {"delivery": "not-sent"},
        }
    )


@pytest.mark.parametrize("wrong_uid", [False, True])
@pytest.mark.parametrize("stage", ["key-requesting", "device-writing", "third-party-requesting", "third-party-writing", "reporting"])
@pytest.mark.parametrize("already_download", [False, True])
def test_activation_only_recovery_never_rewrites_firmware(
    tmp_path, monkeypatch, wrong_uid, stage, already_download
):
    from ringhi import modem

    monkeypatch.setattr(storage, "ROOT", tmp_path)
    prior = dict(
        phase="activating",
        uid="aa" * 16,
        imei="1" * 15,
        mac="00:11:22:33:44:55",
        firmwareSha256="pkg",
        backup=str(tmp_path / "backup"),
    )
    storage.save_json(
        tmp_path / "activation" / (prior["uid"] + ".json"),
        dict(
            stage=stage,
            uid=prior["uid"],
            device_written=False,
            project_id=188,
            session=prior["backup"],
            network={"delivery": "unknown"},
        ),
    )
    operations = []

    class Device:
        broken = False

        def __init__(self, *a):
            pass

        def bootstrap(self, pkg):
            operations.append("ram-loader")

        def send(self, *a, **kw):
            return (0x83, bytes.fromhex(("bb" if wrong_uid else "aa") * 16))

        def reset(self):
            operations.append("reset")

        def write(self, *a):
            pytest.fail("recovery must never rewrite firmware")

    class Wire:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            pass

    monkeypatch.setattr(modem, "Download", Device)
    monkeypatch.setattr(
        modem, "original_backups", lambda *a: operations.append("verify-backups")
    )
    monkeypatch.setattr(
        modem, "enter_download", lambda *a: operations.append("enter-download")
    )
    monkeypatch.setattr(modem, "open_ready", lambda *a, **k: Wire())
    monkeypatch.setattr(modem, "activate", lambda *a: operations.append("activate"))
    monkeypatch.setattr(modem, "verify_runtime", lambda *a: "RingHi-test")
    board = SimpleNamespace(
        mac=prior["mac"], cancel=Cancel(), update=lambda **kwargs: None
    )
    cfg = SimpleNamespace(package=SimpleNamespace(digest="pkg"))
    account = SimpleNamespace(project=188, choose_route=lambda *a: None)
    if wrong_uid:
        with pytest.raises(OSError, match="UID"):
            modem.resume_activation(board, cfg, None, account, None, prior, already_download=already_download)
        assert "activate" not in operations
    else:
        modem.resume_activation(board, cfg, None, account, None, prior, already_download=already_download)
        assert operations == [
            "verify-backups",
            *([] if already_download else ["enter-download"]),
            "ram-loader",
            "activate",
            "reset",
        ]
        assert prior["phase"] == "verified"


@pytest.mark.parametrize("cancel_at", ["activation-key", "activation-report"])
def test_received_receipt_survives_cancel_without_reissuing_key(
    tmp_path, monkeypatch, cancel_at
):
    from ringhi import account as module
    import json

    monkeypatch.setattr(storage, "ROOT", tmp_path)
    sealed = []

    def encrypt(data, encrypt=False):
        assert encrypt
        sealed.append(json.loads(data))
        return b"DPAPI_TEST_CIPHERTEXT"

    monkeypatch.setattr(module, "dpapi", encrypt)
    cancel = Cancel()
    sent = []

    class Account:
        username = "fixture"
        project = 188
        use_proxy = False

        def close_current(self):
            pass

        def ensure_authorized(self, *args, **kwargs):
            pass

        def note_authorized(self):
            pass

        def choose_route(self, *args):
            pass

        def call(self, action, body, **kwargs):
            if action == cancel_at:
                cancel.cancel()
            if action == "activation-key":
                return {"cdkey": "PRIVATE_KEY", "has3rd": False}
            if action == "activation-report":
                return {"reported": True}
            return dict(AES="TEST_AES", rsa_n="TEST_N", rsa_e="TEST_E", rsa_d="TEST_D")

    class Device:
        def send(self, cmd, *a, **kw):
            sent.append(cmd)
            return (0x48, b"CPU_FIXTURE\0") if cmd == 0x47 else (0x80, b"")

    account = Account()
    prepared = module.Prepared(account, Cancel(), lambda s: None)
    if cancel_at == "activation-key":
        with pytest.raises(Cancelled):
            module.activate(
                Device(), "a" * 32, tmp_path, account, prepared, cancel, lambda s: None
            )
        assert 0x4A not in sent
    else:
        module.activate(
            Device(), "a" * 32, tmp_path, account, prepared, cancel, lambda s: None
        )
        assert sent.count(0x4A) == 1
        assert (
            storage.read_json(tmp_path / "activation" / ("a" * 32 + ".json"))["stage"]
            == "complete"
        )
    assert sealed[-1]["responses"]["activation-key"]["cdkey"] == "PRIVATE_KEY"
    assert (
        tmp_path / "activation" / "receipts" / ("a" * 32 + ".dpapi")
    ).read_bytes() == b"DPAPI_TEST_CIPHERTEXT"
    assert (
        "PRIVATE_KEY"
        not in (tmp_path / "activation" / ("a" * 32 + ".json")).read_text()
    )


def test_expired_session_refreshed_before_any_activation(fake, monkeypatch):
    from ringhi import account as module

    a = module.Account()
    a.username = "fixture"
    a.project = 188
    a.token = "EXPIRED"
    monkeypatch.setattr(
        module,
        "load_credentials",
        lambda: {
            "username": "fixture",
            "password": "PRIVATE_PASSWORD",
            "pccode": "PRIVATE_CODE",
        },
    )
    fake.replies = [
        Response(200, b'{"code":4000,"msg":"Token is invalid or expired"}'),
        Response(200, b'{"code":200,"data":{"token":"FRESH"}}'),
        Response(200, b'{"code":200,"data":[{"project_id":188}]}'),
    ]
    a.ensure_authorized(Cancel())
    assert a.token == "FRESH" and len(posts(fake)) == 3
    assert posts(fake)[-1][2]["headers"]["Authorization"] == "Bearer FRESH"
    log = (storage.ROOT / "network-diagnostics.jsonl").read_text()
    assert "activation-key" not in log and "PRIVATE_PASSWORD" not in log


def test_expired_session_never_switches_account(fake, monkeypatch):
    from ringhi import account as module

    a = module.Account()
    a.username = "fixture"
    a.project = 188
    monkeypatch.setattr(module, "load_credentials", lambda: {"username": "different"})
    fake.replies = [Response(200, b'{"code":401}')]
    with pytest.raises(network.NetworkError, match="当前账号"):
        a.ensure_authorized()
    assert len(posts(fake)) == 1


def test_removed_project_stops_before_hardware(fake):
    from ringhi import account as module

    a = module.Account()
    a.project = 188
    fake.replies = [Response(200, b'{"code":200,"data":[{"project_id":184}]}')]
    with pytest.raises(network.NetworkError, match="项目权限"):
        a.ensure_authorized()
    assert len(posts(fake)) == 1


def test_connected_board_waits_and_recovers_after_outage(monkeypatch):
    attempts = []
    notices = []
    monkeypatch.setattr(Cancel, "sleep", lambda self, delay: self.check())

    def request():
        attempts.append(1)
        if len(attempts) < 3:
            raise network.NetworkError("offline", True, "not-sent", "connect")
        return "ack"

    assert network.wait_network(request, Cancel(), notices.append) == "ack"
    assert len(notices) == 2 and len(attempts) == 3


def test_cancel_wait_does_not_create_ambiguous_activation():
    cancel = Cancel()

    def fail():
        raise network.NetworkError("offline", True, "not-sent", "connect")

    with pytest.raises(Cancelled) as stopped:
        network.wait_network(fail, cancel, lambda s: cancel.cancel())
    assert stopped.value.delivery == "not-sent"


def test_actual_request_ignores_inherited_proxy(fake):
    t = network.Transport()
    t.session(True)
    call(t)
    assert all(not c[1] for c in posts(fake))


def test_recent_batch_permission_does_not_requery_on_insert(fake):
    from ringhi.account import Account

    a = Account()
    a.username = "fixture"
    a.project = 188
    a.token = "VALID"
    a.note_authorized()
    a.ensure_authorized()
    assert not posts(fake)
    fake.replies = [Response(200, b'{"code":200,"data":[{"project_id":188}]}')]
    a.ensure_authorized(force=True)
    assert len(posts(fake)) == 1


def test_healthy_connection_reused_exclusively_across_workers(fake):
    t = network.Transport()
    def work():
        call(t, 'projects')
        t.release_current()
    for _ in range(4):
        worker = threading.Thread(target=work)
        worker.start(); worker.join(2)
        assert not worker.is_alive()
    assert len(fake.sessions) == 1 and len(posts(fake)) == 4
    assert not fake.sessions[0].closed
    t.close()
    assert fake.sessions[0].closed and not t.idle


def test_failed_connection_not_returned_to_reuse_pool(fake):
    t = network.Transport()
    fake.replies = [requests.ReadTimeout('ambiguous')]
    with pytest.raises(network.NetworkError):
        call(t)
    t.release_current()
    assert not t.idle and fake.sessions[0].closed
    call(t)
    assert len(fake.sessions) == 2


def test_checked_out_connection_cannot_be_used_by_second_worker(fake):
    t = network.Transport()
    call(t); first = t.session(); t.release_current()
    barrier = threading.Barrier(2)
    ids = []
    def work():
        call(t)
        ids.append(id(t.session()))
        barrier.wait(timeout=2)
        t.release_current()
    workers = [threading.Thread(target=work) for _ in range(2)]
    for w in workers: w.start()
    for w in workers: w.join(3)
    assert len(set(ids)) == 2 and id(first) in ids
    t.close()


def test_account_cleanup_keeps_successful_connection_for_next_stage(fake):
    from ringhi.account import Account
    a = Account()
    fake.replies = [Response(200,b'{"code":200,"data":[{"project_id":188}]}')]
    a.project = 188
    a.ensure_authorized()
    a.close_current()
    assert len(a.transport.idle) == 1 and not fake.sessions[0].closed
    a.ensure_authorized()
    assert len(posts(fake)) == 1
    a.close()


def test_cancel_does_not_wait_for_another_boards_network(fake):
    from ringhi.account import Account
    a=Account();cancel=Cancel();started=threading.Event();stopped=threading.Event()
    def worker():
        started.set()
        try:a.ensure_authorized(cancel)
        except Cancelled:stopped.set()
    with a.auth_lock:
        t=threading.Thread(target=worker);t.start();assert started.wait(1)
        cancel.cancel()
        assert stopped.wait(1)
    t.join(1)
    assert not posts(fake)


def test_incomplete_response_after_success_never_reenters_pool(fake):
    t=network.Transport();call(t)
    fake.replies=[Response(data=b'x'*(1024*1024+1))]
    with pytest.raises(network.NetworkError,match='响应过大'):call(t)
    t.release_current()
    assert not t.idle and fake.sessions[0].closed
