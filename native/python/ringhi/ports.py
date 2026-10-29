"""Windows SetupAPI topology via ctypes. Never pair devices by COM order."""

from dataclasses import dataclass
import ctypes as c, re, sys
from ctypes import wintypes as w


class NotReady(OSError):
    pass


class Ambiguous(OSError):
    pass


@dataclass(frozen=True)
class Port:
    path: str
    instance: str
    chip: str
    hub: str
    hub_node: int
    interface: int | None

    @property
    def mode(self):
        s = self.instance.upper()
        if "VID_303A&PID_1001" in s:
            return "esp"
        for pid, mode in [
            ("2000", "runtime"),
            ("1000", "download"),
            ("2001", "generic"),
        ]:
            if "VID_3563&PID_" + pid in s:
                return (
                    mode if mode != "runtime" or self.interface in (4, None) else "aux"
                )
        return "other"


def select(ports, hub, chip, mode):
    matches = [p for p in ports if p.hub == hub and p.chip == chip and p.mode == mode]
    if not matches:
        observed = ", ".join(
            f"{p.path}/{p.mode}" for p in ports if p.hub == hub and p.chip == chip
        ) or "无"
        raise NotReady(f"需要 {mode} 端口，当前同芯片端口：{observed}")
    if len(matches) != 1:
        raise Ambiguous("同一芯片出现多个目标串口，未尝试其他设备")
    return matches[0]


def scan():
    if sys.platform != "win32":
        return [], set()
    api = c.WinDLL("setupapi", use_last_error=True)
    cm = c.WinDLL("cfgmgr32", use_last_error=True)

    class Guid(c.Structure):
        _fields_ = [
            ("a", w.DWORD),
            ("b", w.WORD),
            ("d", w.WORD),
            ("tail", c.c_ubyte * 8),
        ]

    class Info(c.Structure):
        _fields_ = [
            ("size", w.DWORD),
            ("guid", Guid),
            ("node", w.DWORD),
            ("reserved", c.c_void_p),
        ]

    class Key(c.Structure):
        _fields_ = [("guid", Guid), ("pid", w.DWORD)]

    def guid(s):
        import uuid

        return Guid.from_buffer_copy(uuid.UUID(s).bytes_le)

    api.SetupDiGetClassDevsW.argtypes = [c.POINTER(Guid), w.LPCWSTR, w.HWND, w.DWORD]
    api.SetupDiGetClassDevsW.restype = w.HANDLE
    api.SetupDiEnumDeviceInfo.argtypes = [w.HANDLE, w.DWORD, c.POINTER(Info)]
    api.SetupDiEnumDeviceInfo.restype = w.BOOL
    api.SetupDiDestroyDeviceInfoList.argtypes = [w.HANDLE]
    cm.CM_Get_DevNode_PropertyW.argtypes = [
        w.DWORD,
        c.POINTER(Key),
        c.POINTER(w.DWORD),
        c.c_void_p,
        c.POINTER(w.DWORD),
        w.DWORD,
    ]
    cm.CM_Get_Device_IDW.argtypes = [w.DWORD, w.LPWSTR, w.DWORD, w.DWORD]
    cm.CM_Get_Parent.argtypes = [c.POINTER(w.DWORD), w.DWORD, w.DWORD]

    def prop(node, pid):
        key = Key(guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid)
        size = w.DWORD()
        kind = w.DWORD()
        cm.CM_Get_DevNode_PropertyW(
            node, c.byref(key), c.byref(kind), None, c.byref(size), 0
        )
        if not 0 < size.value <= 65536:
            return ""
        buf = c.create_string_buffer(size.value)
        if cm.CM_Get_DevNode_PropertyW(
            node, c.byref(key), c.byref(kind), buf, c.byref(size), 0
        ):
            return ""
        return buf.raw[: size.value].decode("utf-16-le").rstrip("\0")

    def identity(node):
        buf = c.create_unicode_buffer(1024)
        return buf.value if cm.CM_Get_Device_IDW(node, buf, 1024, 0) == 0 else ""

    def parent(node):
        result = w.DWORD()
        return result.value if cm.CM_Get_Parent(c.byref(result), node, 0) == 0 else None

    def nodes(cls):
        g = guid(cls)
        handle = api.SetupDiGetClassDevsW(c.byref(g), None, None, 2)
        if handle == c.c_void_p(-1).value:
            raise c.WinError(c.get_last_error())
        try:
            index = 0
            while True:
                info = Info()
                info.size = c.sizeof(info)
                if not api.SetupDiEnumDeviceInfo(handle, index, c.byref(info)):
                    if c.get_last_error() != 259:
                        raise c.WinError(c.get_last_error())
                    break
                yield info.node
                index += 1
        finally:
            api.SetupDiDestroyDeviceInfoList(handle)

    hubs = {
        identity(n)
        for n in nodes("36fc9e60-c465-11cf-8056-444553540000")
        if "hub" in prop(n, 6).lower()
    }
    ports = []
    for node in nodes("4d36e978-e325-11ce-bfc1-08002be10318"):
        match = re.search(r"\((COM\d+)\)", prop(node, 14), re.I)
        if not match:
            continue
        im = re.search(r"&MI_([0-9A-F]{2})", identity(node), re.I)
        interface = int(im[1], 16) if im else None
        locations = ""
        for _ in range(10):
            ident = identity(node)
            loc = prop(node, 37)
            if "#USB(" in loc:
                locations = loc.split("\0")[0]
            if (
                re.match(r"^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}", ident, re.I)
                and "&MI_" not in ident.upper()
            ):
                par = parent(node)
                if (
                    par is not None
                    and locations
                    and "hub" in prop(par, 6).lower()
                    and "ROOT_HUB" not in identity(par)
                ):
                    ports.append(
                        Port(
                            match[1].upper(),
                            ident,
                            locations.split("#USBMI(")[0],
                            identity(par),
                            par,
                            interface,
                        )
                    )
                break
            node = parent(node)
            if node is None:
                break
    return ports, hubs
