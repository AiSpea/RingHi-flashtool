from __future__ import annotations
import csv, hashlib, io, json, os, tempfile, threading
from pathlib import Path
from datetime import datetime, timezone

LEGACY = Path(os.environ.get("APPDATA", Path.home() / ".config")) / "ringhi-flasher"
ROOT = (
    LEGACY / "native-preview"
)  # Keep the same account, batch, intent and activation files.


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(data: bytes):
    return hashlib.sha256(data).hexdigest()


def read_json(path: Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8-sig"))


def atomic(path: Path, data: bytes):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix="." + path.name, suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def save_json(path, value):
    atomic(Path(path), json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8"))


def verified(path, data):
    atomic(Path(path), data)
    if sha(Path(path).read_bytes()) != sha(data):
        raise OSError("备份落盘校验失败")


COLUMNS = [
    ("task", "任务号"),
    ("id", "任务ID"),
    ("mac", "ESP32 MAC"),
    ("imei", "ML307 IMEI"),
    ("hub", "USB Hub"),
    ("connected", "仍接入"),
    ("startedAt", "开始时间 UTC"),
    ("endedAt", "完成时间 UTC"),
    ("espFirmware", "ESP32 固件"),
    ("mlFirmware", "ML307 固件"),
    ("espProgress", "ESP32 进度"),
    ("espState", "ESP32 状态"),
    ("mlProgress", "ML307 进度"),
    ("mlState", "ML307 状态"),
    ("production", "产测"),
    ("cloud", "云端登记及上传"),
    ("result", "整板结果"),
    ("reason", "原因"),
    ("backup", "备份路径"),
    ("runId", "产测轮次"),
    ("productType", "产品类型代码"),
    ("productName", "产品类型"),
    ("cardCheck", "eSIM 检查"),
    ("deviceStage", "设备原始产测结果"),
    ("deviceSim", "设备原始有卡检查"),
]


def csv_bytes(rows):
    out = io.StringIO(newline="")
    writer = csv.writer(out)
    writer.writerow([label for _, label in COLUMNS])
    for row in rows:
        values = []
        for key, _ in COLUMNS:
            v = str(row.get(key, ""))
            if key in ("mac", "imei") or v.lstrip().startswith(
                ("=", "+", "-", "@", "\t", "\r", "\n")
            ):
                v = "'" + v
            values.append(v)
        writer.writerow(values)
    return out.getvalue().encode("utf-8-sig")


class Cancelled(Exception):
    pass


class Cancel:
    def __init__(self):
        self.event = threading.Event()

    def cancel(self):
        self.event.set()

    def check(self):
        if self.event.is_set():
            raise Cancelled("操作已停止")

    def sleep(self, seconds):
        if self.event.wait(seconds):
            self.check()


def create_batch_csv(path):
    """Reserve a fresh batch file exclusively; never erase another batch's history."""
    path = Path(path)
    payload = csv_bytes([])
    try:
        with path.open("xb") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
    except FileExistsError as exc:
        raise ValueError(
            "该 CSV 已存在，请为新批次选择一个新文件名，原记录不会覆盖"
        ) from exc
    if path.read_bytes() != payload:
        raise OSError("CSV 保存校验失败，未启动烧录")
