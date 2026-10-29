import struct, time, re
from .package import crc16, checksum

MAGIC = 0x5C6D8E9F


def frame(cmd, data=b"", crc=True):
    if len(data) > 65535:
        raise ValueError("下载帧过长")
    body = struct.pack("<HH", cmd, len(data)) + data
    return (
        struct.pack("<I", MAGIC)
        + body
        + struct.pack("<H", crc16(body) if crc else checksum(body))
        + b"\x7e"
    )


def decode(data, crc):
    if len(data) < 11:
        return None
    if struct.unpack_from("<I", data)[0] != MAGIC:
        raise OSError("下载帧头异常")
    length = struct.unpack_from("<H", data, 6)[0] + 11
    if len(data) < length:
        return None
    if len(data) != length:
        raise OSError("下载回包含额外数据")
    if data[-1] != 0x7E or struct.unpack_from("<H", data, length - 3)[0] != (
        crc16(data[4:-3]) if crc else checksum(data[4:-3])
    ):
        raise OSError("下载回包校验失败")
    return struct.unpack_from("<H", data, 4)[0], data[8:-3]


def partition(name, size):
    if not re.fullmatch("[a-zA-Z0-9_]{1,35}", name):
        raise ValueError("分区名无效")
    data = bytearray(88)
    s = name.encode("utf-16-le")
    data[: len(s)] = s
    struct.pack_into("<Q", data, 72, size)
    return bytes(data)


class Download:
    def __init__(self, wire, cancel, progress=lambda *a: None):
        self.wire = wire
        self.cancel = cancel
        self.crc = True
        self.broken = False
        self.progress = progress
        self.reset_detail = ""

    def send(self, cmd, data=b"", timeout=60, accepted=(0x80,)):
        if self.broken:
            raise OSError("下载状态未知，禁止继续发送")
        try:
            self.wire.write(frame(cmd, data, self.crc))
            deadline = time.monotonic() + timeout
            buf = b""
            while time.monotonic() < deadline:
                self.cancel.check()
                buf += self.wire.read()
                if len(buf) > 65546:
                    raise OSError("回包过大")
                reply = decode(buf, self.crc)
                if reply:
                    if reply[0] not in accepted:
                        raise OSError(f"下载命令 0x{cmd:x} 被拒绝，返回 0x{reply[0]:x}")
                    return reply
            raise TimeoutError(f"下载命令 0x{cmd:x} 应答超时")
        except Exception:
            self.broken = True
            raise

    def handshake(self, crc):
        self.crc = crc
        self.wire.write(b"\x7e" * 3)
        buf = b""
        banner = b""
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            self.cancel.check()
            incoming = self.wire.read()
            buf += incoming
            banner += incoming
            if len(banner) > 65536:
                raise OSError("握手响应过长")
            if crc and re.match(rb"^\s*HandshakeROM(?:\s|$)", banner, re.I):
                self.send(0, timeout=5)
                return
            while len(buf) >= 4 and not buf.startswith(struct.pack("<I", MAGIC)):
                buf = buf[1:]
            reply = decode(buf, crc)
            if reply:
                if reply[0] != 0x81:
                    raise OSError("下载握手阶段不匹配，请完全断电重插")
                self.send(0, timeout=5)
                return
        raise TimeoutError("下载握手超时；请完全断电重插，不会盲目重发写入")

    def image(self, start, data, name, chunk):
        self.send(1, start)
        for i in range(0, len(data), chunk):
            self.send(2, data[i : i + chunk])
            self.progress(name, min(i + chunk, len(data)), len(data))
        self.send(3)

    def bootstrap(self, pkg):
        self.handshake(True)
        for e in pkg.loaders:
            self.image(
                struct.pack("<II", e.address, e.size), pkg.payload(e), e.name, 50
            )
            self.send(4, timeout=10)
            self.handshake(False)

    def backup(self, e):
        _, header = self.send(32, partition(e.target, 0), accepted=(0x82,))
        if len(header) != 4 or struct.unpack("<I", header)[0] != e.capacity:
            raise OSError("备份容量不匹配：" + e.name)
        out = bytearray()
        while len(out) < e.capacity:
            n = min(256, e.capacity - len(out))
            _, part = self.send(33, struct.pack("<I", n), accepted=(0x82,))
            if len(part) != n:
                raise OSError("备份长度错误")
            out += part
            self.progress("备份 " + e.name, len(out), e.capacity)
        self.send(34)
        if e.name != "factory_bak" and (
            out[:16] == b"\0" * 16 or out[:16] == b"\xff" * 16
        ):
            raise OSError("设备专属分区为空：" + e.name)
        return bytes(out)

    def write(self, name, data):
        self.image(partition(name, len(data)), data, "写入 " + name, 256)

    def reset(self):
        if self.broken:
            raise OSError("下载已中断，不能确认复位")
        self.cancel.check()
        self.reset_detail = ""
        try:
            self.wire.write(frame(16, struct.pack("<I", 0), False))
        except OSError as exc:
            # A driver can invalidate its handle while completing this write.
            # Do not resend an uncertain reset; only an independent runtime
            # identity check can establish that the device actually booted.
            self.cancel.check()
            self.reset_detail = f"复位发送回执未确认：{type(exc).__name__}: {exc}"
            return False
        # Keep the transport alive until the loader acknowledges or disconnects.
        # Closing immediately can cancel a queued USB transfer. A reset receipt
        # is not boot success: the caller must still verify the runtime identity.
        deadline = time.monotonic() + 3
        buf = b""
        while time.monotonic() < deadline:
            self.cancel.check()
            try:
                buf += self.wire.read()
            except OSError as exc:
                # Handle invalidation is driver-dependent (including Windows
                # ClearCommError / ERROR_BAD_COMMAND 22). This exception policy
                # belongs only to reset, never Flash writes or activation.
                self.cancel.check()
                self.reset_detail = f"复位回执读取中断：{type(exc).__name__}: {exc}"
                return False
            if len(buf) > 65546:
                raise OSError("复位回包过大")
            reply = decode(buf, False)
            if reply:
                if reply[0] != 0x80:
                    raise OSError(f"复位命令被拒绝，返回 0x{reply[0]:x}")
                return True
        self.reset_detail = "复位回执等待超时"
        return False
