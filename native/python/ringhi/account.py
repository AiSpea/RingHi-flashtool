"""Official authorization; DPAPI migration stays on this Windows user account."""

import base64, ctypes as c, json, re, secrets, threading, time
from .network import Transport, NetworkError, wait_network
from . import storage, __version__
from .storage import atomic, read_json, save_json, Cancel


def dpapi(data, encrypt=False):
    from ctypes import wintypes as w

    class Blob(c.Structure):
        _fields_ = [("size", w.DWORD), ("data", c.POINTER(c.c_ubyte))]

    buf = (c.c_ubyte * len(data)).from_buffer_copy(data)
    source = Blob(len(data), buf)
    dest = Blob()
    crypt = c.WinDLL("crypt32", use_last_error=True)
    kernel = c.WinDLL("kernel32", use_last_error=True)
    name = "CryptProtectData" if encrypt else "CryptUnprotectData"
    fn = getattr(crypt, name)
    fn.argtypes = [
        c.POINTER(Blob),
        c.c_void_p,
        c.c_void_p,
        c.c_void_p,
        c.c_void_p,
        w.DWORD,
        c.POINTER(Blob),
    ]
    fn.restype = w.BOOL
    if not fn(c.byref(source), None, None, None, None, 1, c.byref(dest)):
        raise c.WinError(c.get_last_error())
    try:
        return c.string_at(dest.data, dest.size)
    finally:
        kernel.LocalFree.argtypes = [c.c_void_p]
        kernel.LocalFree(dest.data)


def validate(creds):
    if (
        not creds
        or not 0 < len(creds.get("username", "").strip()) <= 128
        or not 0 < len(creds.get("password", "")) <= 512
        or not re.fullmatch(r"[A-Za-z0-9+/]{107}=", creds.get("pccode", ""))
    ):
        raise ValueError("请填写账号、密码和完整 PC 注册码")
    if len(base64.b64decode(creds["pccode"])) != 80:
        raise ValueError("PC 注册码长度无效")


def load_credentials():
    current = storage.ROOT / "account.dpapi"
    old = storage.LEGACY / "ml307h-default.enc"
    path = current if current.exists() else old
    if not path.exists():
        return None
    raw = path.read_bytes()
    if raw.startswith(b"v10") and path == old:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        state = read_json(storage.LEGACY / "Local State")
        wrapped = base64.b64decode(state["os_crypt"]["encrypted_key"])
        if not wrapped.startswith(b"DPAPI"):
            raise ValueError("旧账号保护格式不支持")
        plain = AESGCM(dpapi(wrapped[5:])).decrypt(raw[3:15], raw[15:], None)
    else:
        plain = None
        for skip in (0, 3):
            try:
                plain = dpapi(raw[skip:])
                break
            except OSError:
                continue
        if plain is None:
            raise OSError("旧账号无法解密，请在本机重新登录；原文件已保留")
    creds = json.loads(plain)
    validate(creds)
    return creds


def save_credentials(creds):
    validate(creds)
    atomic(storage.ROOT / "account.dpapi", dpapi(json.dumps(creds).encode(), True))


class Account:
    ROUTES = {
        "login": "pclogin",
        "projects": "getauthorize",
        "project-keys": "getkey",
        "private-key": "getprivatekey",
        "activation-key": "getactivekey",
        "third-party-key": "get3rdactivekey",
        "activation-report": "activated",
    }

    def __init__(self):
        self.username = ""
        self.token = ""
        self.project = 0
        self.use_proxy = False
        self.transport = Transport()
        self.auth_lock = threading.RLock()
        self.authorized_at = 0
        self.authorized_context = None

    def call(self, action, body=None, *, cancel=None, status=lambda s: None):
        token = self.token
        try:
            return self._call(action, body, cancel=cancel, status=status)
        except NetworkError as exc:
            if exc.category != "session" or exc.delivery != "response":
                raise
            # An explicit authentication rejection is not an ambiguous delivery.
            # Refresh once, on demand, without polling permissions for each board.
            if self.token == token:
                self.authorized_context = None
            if action in ("login", "projects") or not (
                self.username and self.project > 0 and token
            ):
                raise
            self.ensure_authorized(cancel, status)
            return self._call(action, body, cancel=cancel, status=status)

    def _call(self, action, body=None, *, cancel=None, status=lambda s: None):
        headers = {
            "Client": "PC",
            "Accept": "application/json",
            "User-Agent": "RingHi-Python/" + __version__,
        }
        if action != "login":
            headers["Authorization"] = "Bearer " + self.token
        response = self.transport.request(
            action,
            "GET" if action == "projects" else "POST",
            "/api/" + self.ROUTES[action] + "/",
            headers,
            body or {},
            cancel,
            status,
        )
        self.use_proxy = self.transport.local.proxy
        if response.status_code != 200:
            raise NetworkError(
                f"官方接口返回 HTTP {response.status_code}，未自动重复设备请求",
                retry=action in ("projects", "project-keys", "private-key")
                and response.status_code in (408, 429, 502, 503, 504),
                category="session" if response.status_code in (401, 403) else "http",
                delivery="response",
            )
        try:
            result = response.json()
            if not isinstance(result, dict):
                raise ValueError()
        except ValueError as exc:
            raise NetworkError(
                "官方响应格式无效，未自动重复设备请求", category="response-format"
            ) from exc
        code = str(result.get("code"))
        if code != "200":
            message = str(result.get("msg", "")).lower()
            expired = (
                code in ("401", "403")
                or (
                    "token" in message
                    and any(
                        term in message
                        for term in (
                            "expired",
                            "invalid",
                            "not valid",
                            "missing",
                            "required",
                        )
                    )
                )
                or "身份认证" in message
                or "authentication credentials were not provided" in message
            )
            reason = (
                "授权额度不足"
                if code == "201"
                else (
                    "登录会话失效，请重新登录"
                    if expired
                    else "官方未接受请求，请核对账号和项目权限"
                )
            )
            raise NetworkError(
                reason + (f"（业务码 {code}）" if code.isdigit() else ""),
                category="session" if expired else "business",
                delivery="response",
            )
        if action == "activation-report":
            return {"reported": True}
        data = result.get("data")
        if action == "activation-key":
            if not isinstance(data, dict):
                raise ValueError("官方授权响应格式无效")
            flag = data.get("has3rd")
            if type(flag) not in (bool, int) or flag not in (False, True, 0, 1):
                raise ValueError("官方第三方授权标记无效")
            data["has3rd"] = bool(flag)
        return data

    def choose_route(self, cancel=None, status=lambda s: None):
        if cancel:
            cancel.check()
        self.transport.session(False)
        self.use_proxy = False

    def note_authorized(self):
        self.authorized_context = (self.token, self.project, self.username)
        self.authorized_at = time.monotonic()

    def ensure_authorized(self, cancel=None, status=lambda s: None, *, force=False):
        # Prepared batch permission is bound to this account/project/token, not
        # to a timer. Serialize refresh after an explicit session rejection.
        cancel = cancel or Cancel()
        cancel.check()
        while not self.auth_lock.acquire(timeout=0.1):
            cancel.check()
        try:
            cancel.check()
            if (
                not force
                and self.authorized_context == (self.token, self.project, self.username)
            ):
                if cancel:
                    cancel.check()
                return
            self.authorized_context = None
            try:
                data = self.call("projects", cancel=cancel, status=status)
            except NetworkError as exc:
                if exc.category != "session":
                    raise
                creds = load_credentials()
                if not creds or creds["username"] != self.username:
                    raise NetworkError(
                        "登录会话已过期，请重新登录当前账号", category="session"
                    ) from exc
                status("登录会话已过期 · 正在恢复当前账号")
                data = self.call("login", creds, cancel=cancel, status=status)
                token = data.get("token", "") if isinstance(data, dict) else ""
                if not re.fullmatch(r"[!-~]{1,4096}", token):
                    raise ValueError("登录会话无效")
                self.token = token
                data = self.call("projects", cancel=cancel, status=status)
            items = data.get("projects", []) if isinstance(data, dict) else data
            if not isinstance(items, list) or not any(
                str(item.get("project_id")) == str(self.project)
                for item in items
                if isinstance(item, dict)
            ):
                raise NetworkError(
                    "当前账号已无所选项目权限，请重新选择项目",
                    category="business",
                    delivery="response",
                )
            self.note_authorized()
        finally:
            self.auth_lock.release()

    def close_current(self):
        self.transport.release_current()

    def close(self):
        self.authorized_context = None
        self.transport.close()

    def login(self, creds):
        try:
            validate(creds)
            self.choose_route()
            data = self.call("login", creds)
            token = data.get("token", "")
            if not re.fullmatch(r"[!-~]{1,4096}", token):
                raise ValueError("登录会话无效")
            self.token = token
            self.username = creds["username"]
            p = read_json(
                storage.ROOT / "project.json",
                read_json(storage.LEGACY / "ml307h-default-project.json", {}),
            )
            if p.get("username") == self.username:
                self.project = int(p.get("projectId", 0))
            data = self.call("projects")
            return data.get("projects", []) if isinstance(data, dict) else data
        finally:
            self.close_current()

    def select(self, project):
        if project < 1:
            raise ValueError("请选择授权项目")
        self.project = project
        save_json(
            storage.ROOT / "project.json",
            {"username": self.username, "projectId": project},
        )

    def snapshot(self):
        a = Account()
        a.username = self.username
        a.token = self.token
        a.project = self.project
        a.use_proxy = self.use_proxy
        return a


def wire_value(data, key):
    value = data.get(key, "")
    if not isinstance(value, str) or not re.fullmatch(r"[\x20-\x7e]{1,65535}", value):
        raise ValueError("官方授权材料格式无效")
    return value.encode("ascii")


class Prepared:
    def __init__(self, account, cancel, status):
        self.user = account.username
        self.project = account.project
        self.lock = threading.Lock()
        self.parts = []
        if not self.user or self.project < 1:
            raise ValueError("请先登录并选择授权项目")
        try:
            for action, keys in [
                ("project-keys", ("AES", "rsa_n", "rsa_e")),
                ("private-key", ("rsa_d",)),
            ]:
                for attempt in range(2):
                    cancel.check()
                    status(
                        "准备本批次授权材料" + (" · 安全重试 2/2" if attempt else "")
                    )
                    try:
                        data = account.call(
                            action,
                            {"project_id": self.project},
                            cancel=cancel,
                            status=status,
                        )
                        break
                    except NetworkError as e:
                        if not e.retry or attempt:
                            raise
                        cancel.sleep(1)
                for key in keys:
                    self.parts.append(bytearray(wire_value(data, key)))
            cancel.check()
            account.note_authorized()
        except Exception:
            self.close()
            raise
        finally:
            account.close_current()

    def copy(self, account):
        with self.lock:
            if (
                len(self.parts) != 4
                or self.user != account.username
                or self.project != account.project
            ):
                raise ValueError("批次授权未就绪或账号/项目已改变")
            return [bytearray(p) for p in self.parts]

    def close(self):
        with self.lock:
            for p in self.parts:
                p[:] = b"\0" * len(p)
            self.parts = []


def retryable_activation(record):
    # Product owner verified that the same chip/project can be authorized again.
    # A new board task may resume a known attempt; this is not a transport retry
    # loop. Validate context and archive the old attempt before making a new one.
    return bool(
        record
        and re.fullmatch(r"[a-f0-9]{16,128}", record.get("uid", ""))
        and type(record.get("project_id")) is int
        and record["project_id"] > 0
        and isinstance(record.get("session"), str) and record["session"]
        and record.get("stage") in (
            "preparing", "device-preparing", "key-requesting", "device-writing",
            "third-party-requesting", "third-party-writing", "reporting",
        )
    )


def check_activation_context(record, uid, project):
    if not record:
        return
    if record.get("uid") != uid:
        raise OSError("授权记录与实际芯片 UID 不一致，未开始激活")
    if record.get("stage") != "complete":
        if not retryable_activation(record):
            raise OSError("原授权记录不完整，无法确认恢复对象；原备份已保留")
        if project is not None and record.get("project_id") != project:
            raise OSError("恢复授权需选择原授权项目，未自动更换项目")


def activate(dl, uid, backup, account, prepared, cancel, status):
    path = storage.ROOT / "activation" / (uid + ".json")
    old = read_json(path, {})
    check_activation_context(old, uid, account.project)
    if retryable_activation(old):
        if old.get("session") != str(backup):
            raise OSError("原激活项目或备份不匹配，未领取新激活码")
    cancel.check()
    if old:
        history = path.parent / "history" / (uid + "-" + secrets.token_hex(6))
        save_json(history.with_suffix(".json"), old)
        receipt_path = path.parent / "receipts" / (uid + ".dpapi")
        if receipt_path.exists():
            atomic(history.with_suffix(".dpapi"), receipt_path.read_bytes())
    parts = prepared.copy(account)
    record = {
        "uid": uid,
        "project_id": account.project,
        "session": str(backup),
        "startedAt": storage.now(),
        "stage": "preparing",
        "device_written": False,
    }

    def stage(s):
        if s != "complete":
            cancel.check()
        record["stage"] = s
        save_json(path, record)
        status(
            "自动激活 · "
            + {
                "device-preparing": "准备设备",
                "key-requesting": "领取本机激活码",
                "device-writing": "写入激活码",
                "reporting": "确认官方回执",
                "complete": "官方已确认",
            }.get(s, s)
        )

    receipts = {}

    def receipt(action, data, body):
        receipts[action] = data
        sealed = {
            "uid": uid,
            "project_id": account.project,
            "session": str(backup),
            "at": storage.now(),
            "cpucode": body["cpucode"],
            "responses": receipts,
            "device_written": record["device_written"],
        }
        # Preserve an acknowledged key/report before cancellation or USB writes.
        # User-bound DPAPI; never put these response bodies in plain logs/CSV.
        atomic(
            path.parent / "receipts" / (uid + ".dpapi"),
            dpapi(json.dumps(sealed).encode("utf-8"), True),
        )

    try:
        account.choose_route(cancel, status)
        wait_network(
            lambda: account.ensure_authorized(cancel, status),
            cancel,
            status,
            query=True,
        )
        stage("device-preparing")
        dl.send(0x42, timeout=3)
        dl.send(0x49, secrets.token_bytes(32), timeout=3)
        for i, p in enumerate(parts):
            dl.send(0x43 + i, bytes(p), timeout=3)
            p[:] = b"\0" * len(p)
        _, raw = dl.send(0x47, timeout=3, accepted=(0x48,))
        cpu = raw.split(b"\0")[0]
        if not re.fullmatch(rb"[\x20-\x7e]{1,4096}", cpu) or any(raw[len(cpu) :]):
            raise ValueError("设备产品标识格式无效")
        body = {"project_id": account.project, "cpucode": cpu.decode("ascii")}
        stage("key-requesting")
        key = wait_network(
            lambda: account.call("activation-key", body, cancel=cancel, status=status),
            cancel,
            status,
        )
        receipt("activation-key", key, body)
        stage("device-writing")
        dl.send(0x4A, wire_value(key, "cdkey"), timeout=3)
        if key["has3rd"]:
            stage("third-party-requesting")
            third = wait_network(
                lambda: account.call(
                    "third-party-key", body, cancel=cancel, status=status
                ),
                cancel,
                status,
            )
            receipt("third-party-key", third, body)
            stage("third-party-writing")
            dl.send(0x4B, wire_value(third, "cdkey"), timeout=3)
        record["device_written"] = True
        stage("reporting")
        report = wait_network(
            lambda: account.call(
                "activation-report", body, cancel=cancel, status=status
            ),
            cancel,
            status,
        )
        if not report.get("reported"):
            raise OSError("官方未确认激活结果")
        receipt("activation-report", report, body)
        stage("complete")
    except Exception as exc:
        if isinstance(exc, NetworkError) or hasattr(exc, "delivery"):
            # Persist only non-secret classification, never request bodies/keys.
            record["network"] = {
                "delivery": "not-sent"
                if record["stage"] in ("preparing", "device-preparing")
                else exc.delivery,
                "category": exc.category,
                "route": "proxy" if getattr(account, "use_proxy", False) else "direct",
            }
        record["stoppedAt"] = storage.now()
        save_json(path, record)
        raise
    finally:
        account.close_current()
        for p in parts:
            p[:] = b"\0" * len(p)
