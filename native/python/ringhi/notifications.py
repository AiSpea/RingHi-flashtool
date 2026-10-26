"""Native USB removal events close connection generations even on rapid replug."""

import ctypes as c, sys
from ctypes import wintypes as w
from PySide6.QtCore import QAbstractNativeEventFilter


def removed_id(name):
    if not name.startswith("\\\\?\\"):
        return ""
    return name[4:].rsplit("#{", 1)[0].replace("#", "\\")


class RemovalFilter(QAbstractNativeEventFilter):
    def __init__(self, window):
        super().__init__()
        self.window = window
        self.handle = None
        if sys.platform == "win32":
            self.user = c.WinDLL("user32", use_last_error=True)
            data = c.create_string_buffer(32)
            c.c_uint32.from_buffer(data, 0).value = 32
            c.c_uint32.from_buffer(data, 4).value = 5
            self.user.RegisterDeviceNotificationW.argtypes = [
                w.HANDLE,
                c.c_void_p,
                w.DWORD,
            ]
            self.user.RegisterDeviceNotificationW.restype = w.HANDLE
            self.user.UnregisterDeviceNotification.argtypes = [w.HANDLE]
            self.handle = self.user.RegisterDeviceNotificationW(
                int(window.winId()), data, 4
            )

    def nativeEventFilter(self, eventType, message):
        if sys.platform == "win32":
            msg = w.MSG.from_address(int(message))
            if msg.message == 0x219 and msg.wParam == 0x8004 and msg.lParam:
                ptr = msg.lParam
                size = c.c_uint32.from_address(ptr).value
                kind = c.c_uint32.from_address(ptr + 4).value
                if kind == 5 and 30 <= size <= 65536:
                    name = c.wstring_at(ptr + 28, (size - 28) // 2).rstrip("\0")
                    hub = removed_id(name)
                    batch = self.window.batch
                    if batch and hub:
                        with batch.lock:
                            target = next(
                                (
                                    key
                                    for key in batch.current
                                    if key.lower() == hub.lower()
                                ),
                                None,
                            )
                            if target:
                                batch._remove(target)
        return False, 0

    def close(self):
        if self.handle:
            self.user.UnregisterDeviceNotification(self.handle)
            self.handle = None
