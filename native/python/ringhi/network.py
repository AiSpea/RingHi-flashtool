"""Reusable, phase-aware official HTTPS transport. No credential-bearing relay."""

import json
import ssl
import threading
import time
import requests
from requests.adapters import HTTPAdapter
from urllib3.connection import HTTPSConnection
from urllib3.connectionpool import HTTPSConnectionPool
from urllib3.exceptions import HTTPError as PoolError
from . import storage
from .storage import Cancel, Cancelled

BASE = "https://spark.aicxtek.com:7702"
READ_ONLY = {"projects", "project-keys", "private-key", "health"}
_log_lock = threading.Lock()


class NetworkError(OSError):
    def __init__(self, message, retry=False, delivery="unknown", category=""):
        super().__init__(message)
        self.retry, self.delivery, self.category = retry, delivery, category


class BeforeSendError(OSError):
    """TCP/proxy CONNECT/TLS failed before any official HTTP request bytes."""


class TrackedConnection(HTTPSConnection):
    def connect(self):
        try:
            super().connect()
        except (OSError, PoolError) as exc:
            raise BeforeSendError("HTTPS connection setup failed") from exc


class TrackedPool(HTTPSConnectionPool):
    ConnectionCls = TrackedConnection


class PhaseAdapter(HTTPAdapter):
    @staticmethod
    def track(manager):
        # Copy, never alter urllib3's global pool registry or other app clients.
        manager.pool_classes_by_scheme = dict(manager.pool_classes_by_scheme)
        manager.pool_classes_by_scheme["https"] = TrackedPool

    def init_poolmanager(self, *args, **kwargs):
        super().init_poolmanager(*args, **kwargs)
        self.track(self.poolmanager)

    def proxy_manager_for(self, *args, **kwargs):
        manager = super().proxy_manager_for(*args, **kwargs)
        self.track(manager)
        return manager


def causes(exc):
    pending, seen = [exc], set()
    while pending:
        e = pending.pop()
        if not isinstance(e, BaseException) or id(e) in seen:
            continue
        seen.add(id(e))
        yield e
        pending.extend([e.__cause__, e.__context__, getattr(e, "reason", None)])
        pending.extend(e.args)


def classify(exc):
    chain = list(causes(exc))
    certificate = any(
        isinstance(e, ssl.SSLCertVerificationError)
        or "CERTIFICATE_VERIFY_FAILED" in str(e)
        for e in chain
    )
    before = any(
        isinstance(e, (BeforeSendError, requests.ConnectTimeout)) for e in chain
    )
    if certificate:
        return "certificate", "not-sent" if before else "unknown"
    if before:
        return "connect", "not-sent"
    if any(isinstance(e, requests.ReadTimeout) for e in chain):
        return "response-timeout", "unknown"
    return "connection-interrupted", "unknown"


def audit(action, attempt, proxy, started, **values):
    # Fixed fields only: no URL, exception messages, bodies, token or device IDs.
    row = dict(
        at=storage.now(),
        action=action,
        attempt=attempt,
        route="proxy" if proxy else "direct",
        milliseconds=round((time.monotonic() - started) * 1000),
        **values,
    )
    try:
        with _log_lock:
            path = storage.ROOT / "network-diagnostics.jsonl"
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() and path.stat().st_size > 512 * 1024:
                path.replace(path.with_suffix(".previous.jsonl"))
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError:
        pass  # Diagnostic disk failure must not turn an acknowledged POST into a retry.


class Transport:
    def __init__(self):
        self.local = threading.local()
        self.lock = threading.Lock()
        self.sessions = set()
        self.idle = []

    def session(self, proxy=False):
        # Compatibility argument cannot opt the application into system proxies.
        proxy = False
        if getattr(self.local, "session", None) is None or self.local.proxy != proxy:
            self.close_current()
            with self.lock:
                session = self.idle.pop() if self.idle else None
            if session is None:
                session = requests.Session()
                session.trust_env = False
                session.mount(
                    "https://",
                    PhaseAdapter(max_retries=0, pool_connections=1, pool_maxsize=1),
                )
            self.local.session, self.local.proxy = session, proxy
            self.local.ready = False
            self.local.reusable = False
            with self.lock:
                self.sessions.add(session)
        return self.local.session

    def release_current(self):
        """Return a healthy, fully consumed session for exclusive use by another worker.

        Never share a requests Session concurrently. Cookies are not part of the
        authorization protocol; bearer credentials are supplied per request only.
        """
        session = getattr(self.local, "session", None)
        if session is None:
            return
        if not getattr(self.local, "reusable", False):
            self.close_current()
            return
        if hasattr(session, "cookies"):
            session.cookies.clear()
        with self.lock:
            keep = len(self.idle) < 8
            if keep:
                self.idle.append(session)
        if not keep:
            self.close_current()
            return
        self.local.session = None
        self.local.ready = False
        self.local.reusable = False

    def close_current(self):
        s = getattr(self.local, "session", None)
        if s is not None:
            s.close()
            with self.lock:
                self.sessions.discard(s)
        self.local.session = None
        self.local.ready = False

    def close(self):
        # Call only after workers have finished. Each worker owns its Session.
        with self.lock:
            sessions = list(self.sessions)
            self.sessions.clear()
            self.idle.clear()
        for s in sessions:
            s.close()
        self.local.session = None
        self.local.ready = False

    def ready(self, cancel=None, status=lambda s: None):
        cancel = cancel or Cancel()
        last = None
        # Anonymous diagnostics only; production calls use their actual API.
        for attempt, proxy in enumerate((False, False, False, False), 1):
            cancel.check()
            started = time.monotonic()
            try:
                s = self.session(proxy)
                response = s.get(
                    BASE + "/", timeout=(5, 8), allow_redirects=False, stream=True
                )
                with response:
                    response.raise_for_status()
                    if response.status_code != 200:
                        raise requests.ConnectionError("Unexpected health status")
                    body = bytearray()
                    for chunk in response.iter_content(4096):
                        cancel.check()
                        body.extend(chunk)
                        if len(body) > 16384:
                            raise ValueError("官方连通性响应无效")
                self.local.ready = True
                self.local.last_used = time.monotonic()
                audit("health", attempt, proxy, started, outcome="ready")
                return proxy
            except requests.RequestException as exc:
                category, _ = classify(exc)
                last = category
                audit(
                    "health",
                    attempt,
                    proxy,
                    started,
                    outcome="failed",
                    category=category,
                    delivery="not-sent",
                )
                self.close_current()
                if attempt < 4:
                    status(f"正在恢复官方连接 · {attempt}/4 · 尚未发送授权请求")
                    cancel.sleep(min(attempt, 2))
        raise NetworkError(
            "官方直连暂不可用，尚未发送授权请求",
            True,
            delivery="not-sent",
            category=last or "connect",
        )

    def request(
        self, action, method, path, headers, body, cancel=None, status=lambda s: None
    ):
        cancel = cancel or Cancel()
        safe = action in READ_ONLY
        # The actual API is the readiness check. Do not gate it on an unrelated
        # homepage request; tracked TLS gives precise pre-send failure evidence.
        self.session(False)
        for attempt in range(1, 5):
            cancel.check()
            started = time.monotonic()
            proxy = self.local.proxy
            try:
                s = self.session(proxy)
                self.local.reusable = False
                response = s.request(
                    method,
                    BASE + path,
                    headers=headers,
                    json=body if method != "GET" else None,
                    timeout=(6, 60 if not safe else 18),
                    allow_redirects=False,
                    stream=True,
                )
                with response:
                    raw = bytearray()
                    for chunk in response.iter_content(8192):
                        # Once headers arrived, finish retaining the response even
                        # when the user cancels: do not lose an activation receipt.
                        raw.extend(chunk)
                        if len(raw) > 1024 * 1024:
                            raise NetworkError(
                                "官方响应过大，未自动重复请求", category="response-size"
                            )
                    response._content = bytes(raw)
                    response._content_consumed = True
                self.local.last_used = time.monotonic()
                self.local.reusable = True
                audit(
                    action,
                    attempt,
                    proxy,
                    started,
                    outcome="response",
                    http=response.status_code,
                )
                if (
                    safe
                    and response.status_code in (408, 429, 502, 503, 504)
                    and attempt < 4
                ):
                    self.close_current()
                    status(f"官方查询暂不可用 · 自动恢复 {attempt}/4")
                    cancel.sleep(min(attempt * 2, 5))
                    self.session(False)
                    continue
                return response
            except requests.RequestException as exc:
                category, delivery = classify(exc)
                audit(
                    action,
                    attempt,
                    proxy,
                    started,
                    outcome="failed",
                    category=category,
                    delivery=delivery,
                    errorType=type(exc).__name__,
                    causeTypes=[type(e).__name__ for e in causes(exc)][:8],
                    errorNumbers=[
                        getattr(e, "errno", None)
                        for e in causes(exc)
                        if getattr(e, "errno", None) is not None
                    ][:8],
                )
                self.close_current()
                retry = category != "certificate" and (safe or delivery == "not-sent")
                if retry and attempt < 4:
                    status(
                        ("官方项目查询" if action == "projects" else "官方授权服务")
                        + ("：连接未建立" if delivery == "not-sent" else "：响应中断")
                        + f" · 重试 {attempt}/4"
                        + (" · 授权请求尚未发出" if not safe else "")
                    )
                    cancel.sleep(min(attempt, 3))
                    self.session(False)
                    continue
                detail = (
                    "TLS 证书验证失败"
                    if category == "certificate"
                    else (
                        "连接建立失败，授权请求尚未发出"
                        if delivery == "not-sent"
                        else "请求已发出但响应未确认，保留现场待核对"
                    )
                )
                raise NetworkError(
                    detail, safe or delivery == "not-sent", delivery, category
                ) from exc


def wait_network(operation, cancel, status, *, query=False):
    """Keep a connected board waiting during a recoverable outage, cancellably.

    Read-only queries may be repeated. Device requests are repeated only if the
    transport proves that no official request bytes were sent.
    """
    attempt = 0
    while True:
        cancel.check()
        try:
            return operation()
        except NetworkError as exc:
            recoverable = exc.category != "certificate" and (
                exc.delivery == "not-sent" or query and exc.retry
            )
            if not recoverable:
                raise
            attempt += 1
            status(f"等待官方直连恢复 · 自动重试 {attempt} · 尚未完成授权")
            try:
                cancel.sleep(5)
            except Cancelled as stopped:
                # A cancellation between proven-unsent attempts must not poison
                # a device with an invented ambiguous activation request.
                stopped.delivery = "not-sent"
                stopped.category = "cancel-before-send"
                raise
