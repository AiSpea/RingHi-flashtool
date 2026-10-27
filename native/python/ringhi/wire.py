from __future__ import annotations
import re, time
import serial
from .storage import Cancel
from .ports import NotReady, Ambiguous


class CommandRejected(OSError):
    pass


class Wire:
    def __init__(self, port, cancel: Cancel):
        self.cancel = cancel
        self.serial = serial.Serial(
            port=None, baudrate=115200, timeout=0.15, write_timeout=3
        )
        self.serial.dtr = False
        self.serial.rts = False
        self.serial.port = port
        try:
            self.serial.open()
        except Exception:
            self.serial.close()
            raise

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def close(self):
        self.serial.close()

    def clear(self):
        self.cancel.check()
        self.serial.reset_input_buffer()

    def write(self, data):
        self.cancel.check()
        n = self.serial.write(data)
        if n != len(data):
            raise OSError("串口写入不完整，未自动重发")
        self.cancel.check()

    def read(self):
        self.cancel.check()
        return self.serial.read(max(1, min(self.serial.in_waiting, 8192)))


def transient_open(e):
    if isinstance(e, NotReady):
        return True
    if isinstance(e, Ambiguous):
        return False
    code = getattr(e, "winerror", None)
    if code is None:
        match = re.search(r"(?:WinError\s+|None,\s*)(\d+)", str(e))
        code = int(match[1]) if match else None
    return code in (2, 3, 21, 1167)


def open_ready(resolve, cancel, status=lambda s: None, timeout=30, opener=Wire):
    deadline = time.monotonic() + timeout
    while True:
        cancel.check()
        try:
            return opener(resolve().path, cancel)
        except Exception as e:
            if not transient_open(e):
                raise
            if time.monotonic() >= deadline:
                raise OSError("目标端口驱动未就绪；请检查连接，尚未发送数据") from e
            status("等待目标端口和驱动就绪")
            cancel.sleep(0.3)


def at(wire, command, cancel, timeout=5, disconnect_ok=False):
    wire.clear()
    wire.write((command + "\r").encode("ascii"))
    deadline = time.monotonic() + timeout
    buf = b""
    while time.monotonic() < deadline:
        cancel.check()
        try:
            buf += wire.read()
        except (OSError, serial.SerialException):
            if disconnect_ok:
                return buf.decode("utf-8", "replace")
            raise
        if len(buf) > 65536:
            raise OSError("AT 响应过长")
        lines = buf.decode("utf-8", "replace").splitlines()
        if any(
            s.strip() == "ERROR" or s.startswith(("+CME ERROR:", "+CMS ERROR:"))
            for s in lines
        ):
            raise CommandRejected("设备拒绝命令：" + command)
        if any(s.strip() == "OK" for s in lines):
            return buf.decode("utf-8", "replace")
    if disconnect_ok:
        return buf.decode("utf-8", "replace")
    raise TimeoutError("AT 响应超时：" + command)


def identity(wire, cancel, boot_wait=0):
    # Early boot may expose AT before CGMR is ready. Retry only read-only identity queries.
    deadline = time.monotonic() + boot_wait
    while True:
        cancel.check()
        try:
            model = at(wire, "AT+CGMM", cancel)
            if "ML307H" not in [s.strip().upper() for s in model.splitlines()]:
                raise ValueError("型号未确认是 ML307H，未写入")
            version = at(wire, "AT+CGMR", cancel)
            match = re.search(r"(?<!\d)\d{15}(?!\d)", at(wire, "AT+CGSN=1", cancel))
            if not match:
                raise ValueError("未读取到有效 IMEI")
            return match[0], version
        except (CommandRejected, TimeoutError):
            if time.monotonic() >= deadline:
                raise
            cancel.sleep(0.7)


def flash_identity(wire, cancel, boot_wait=0, status=lambda s: None):
    """Use the primary-slot IMEI for flashing; identity() itself stays read-only.

    RingHi factory tests can leave slot 1 selected. Its IMEI is not the stable
    identity used by our original backups. Normalize before any ledger lookup.
    Stock/blank-module firmware keeps its existing identification path.
    """
    result = identity(wire, cancel, boot_wait)
    if "ringhi" not in result[1].lower():
        return result

    def slot():
        reply = at(wire, "AT^SIMSLOT?", cancel, timeout=5)
        matches = re.findall(r"(?m)^\s*\^SIMSLOT:\s*([01])\s*$", reply)
        if len(matches) != 1:
            raise OSError("未确认 ML307 当前卡槽，尚未开始写入")
        return int(matches[0])

    if slot() == 1:
        status("恢复主卡槽 · 重新核对设备身份")
        at(wire, "AT^SIMSLOT=0", cancel, timeout=10)
        at(wire, 'AT^AEM=1,"ACT"', cancel, timeout=15)
        if slot() != 0:
            raise OSError("ML307 主卡槽恢复未确认，尚未开始写入")
        result = identity(wire, cancel, boot_wait=max(boot_wait, 20))
    return result
