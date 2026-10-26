"""Strict RingHi PKG parser; hardware-protected data can never become image writes."""

from dataclasses import dataclass
import struct, re, hashlib
from .storage import sha


def crc16(data):
    import binascii

    return binascii.crc_hqx(data, 0)


def checksum(data):
    data += b"\0" * (len(data) % 2)
    n = sum(struct.unpack("<" + "H" * (len(data) // 2), data))
    n = (n & 65535) + (n >> 16)
    return ~((n & 65535) + (n >> 16)) & 65535


def need(ok, why):
    if not ok:
        raise ValueError("PKG：" + why)


def text(data, at, count):
    block = data[at : at + count]
    need(b"\0" in block, "字符串缺少结束符")
    return block.split(b"\0", 1)[0].decode("utf-8")


def disjoint(ranges):
    ranges = sorted(ranges)
    need(all(a[1] <= b[0] for a, b in zip(ranges, ranges[1:])), "分区或镜像重叠")


@dataclass(frozen=True)
class Partition:
    name: str
    kind: str
    file: str
    offset: int
    size: int
    address: int
    capacity: int
    target: str
    flag: int
    selected: int
    backup: int


class Package:
    def __init__(self, raw: bytes):
        need(136 <= len(raw) <= 64 * 1024 * 1024, "文件大小无效")
        need(
            struct.unpack_from("<IIQ", raw) == (0x5C6D8E9F, 1, len(raw)),
            "格式或总长度不符",
        )
        self.raw = raw
        self.digest = sha(raw)
        self.project = text(raw, 16, 32)
        self.version = text(raw, 48, 32)
        need(self.project == "ringhi", "仅接受 RingHi 项目固件")
        offset, count, auth = struct.unpack_from("<III", raw, 80)
        end = offset + count * 464
        need(
            offset >= 136 and 0 < count <= 128 and end <= len(raw) and auth <= 2,
            "分区表范围或校验类型无效",
        )
        if auth == 1:
            need(
                hashlib.md5(raw[offset:]).hexdigest()
                == raw[96:128].decode("ascii").lower(),
                "MD5 校验失败",
            )
        if auth == 2:
            need(
                crc16(raw[offset:]) == struct.unpack_from("<I", raw, 92)[0],
                "CRC 校验失败",
            )
        self.entries = []
        names = set()
        targets = set()
        ranges = []
        flash = []
        for i in range(count):
            a = offset + i * 464
            pos, size, address, capacity = struct.unpack_from("<QQQQ", raw, a + 320)
            name, kind, file = (
                text(raw, a, 32),
                text(raw, a + 32, 32),
                text(raw, a + 64, 256),
            )
            target = text(raw, a + 352, 36) or name
            flag, selected, backup = struct.unpack_from("<III", raw, a + 424)
            need(
                re.fullmatch(r"[a-zA-Z0-9_]{1,35}", name) and name not in names,
                "分区名非法或重复",
            )
            names.add(name)
            need(
                kind in ("INIT", "MDL", "DL", "CODE")
                and flag <= 3
                and selected <= 1
                and backup <= 2,
                "未知分区标记",
            )
            need(not flag & 2 or selected == 1, "必选镜像未选择")
            if size:
                need(end <= pos <= len(raw) and size <= len(raw) - pos, "镜像越界")
                ranges.append((pos, pos + size))
            need(kind != "INIT" or size == 0, "INIT 含镜像")
            need(kind == "CODE" or backup == 0, "loader 含备份标记")
            if kind in ("MDL", "DL"):
                need(
                    size > 0 and selected == 1 and address <= 0xFFFFFFFF, "loader 无效"
                )
            if kind == "CODE":
                need(
                    re.fullmatch(r"[a-zA-Z0-9_]{1,35}", target)
                    and target not in targets,
                    "目标分区重复或非法",
                )
                targets.add(target)
                need(
                    0 < capacity <= 64 * 1024 * 1024
                    and size <= capacity
                    and (selected == 0 or size > 0),
                    "分区容量无效",
                )
                flash.append((address, address + capacity))
            self.entries.append(
                Partition(
                    name,
                    kind,
                    file,
                    pos,
                    size,
                    address,
                    capacity,
                    target,
                    flag,
                    selected,
                    backup,
                )
            )
        disjoint(ranges)
        disjoint(flash)
        self.loaders = [e for e in self.entries if e.kind in ("MDL", "DL")]
        self.writes = [
            e
            for e in self.entries
            if e.kind == "CODE" and e.selected == 1 and e.size > 0
        ]
        self.protected = [
            e
            for e in self.entries
            if e.kind == "CODE"
            and (e.backup == 1 or e.name in ("calibration", "factory", "factory_bak"))
        ]
        need([e.kind for e in self.loaders] == ["MDL", "DL"], "需要按序 MDL、DL")
        need(self.writes and self.writes[-1].target == "mbl", "MBL 必须最后写入")
        for name in ("ap", "calibration", "factory"):
            need(
                any(
                    e.kind == "CODE" and e.name == name and e.target == name
                    for e in self.entries
                ),
                "缺少 " + name,
            )
        need(any(e.name == "ap" for e in self.writes), "AP 未选择")
        need(
            all(e.selected == 0 and e.backup != 2 for e in self.protected),
            "保护分区禁止镜像覆盖或擦除",
        )
        bak = next((e for e in self.entries if e.name == "factory_bak"), None)
        if bak:
            need(
                bak.target == "factory_bak"
                and bak.capacity
                == next(e.capacity for e in self.entries if e.name == "factory"),
                "工厂备份容量不一致",
            )

    def payload(self, e):
        return self.raw[e.offset : e.offset + e.size]
