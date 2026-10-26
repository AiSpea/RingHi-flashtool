"""Windows kill-on-close process job. An esptool child cannot outlive its task."""

import ctypes as c, sys
from ctypes import wintypes as w
import psutil


class Job:
    def __init__(self, process):
        self.handle = None
        if sys.platform != "win32":
            return

        class Limits(c.Structure):
            _fields_ = [
                ("process_time", c.c_longlong),
                ("job_time", c.c_longlong),
                ("flags", w.DWORD),
                ("min", c.c_size_t),
                ("max", c.c_size_t),
                ("active", w.DWORD),
                ("affinity", c.c_size_t),
                ("priority", w.DWORD),
                ("scheduling", w.DWORD),
            ]

        class IO(c.Structure):
            _fields_ = [("values", c.c_ulonglong * 6)]

        class Extended(c.Structure):
            _fields_ = [
                ("basic", Limits),
                ("io", IO),
                ("process_mem", c.c_size_t),
                ("job_mem", c.c_size_t),
                ("peak_process", c.c_size_t),
                ("peak_job", c.c_size_t),
            ]

        self.k = c.WinDLL("kernel32", use_last_error=True)
        self.k.CreateJobObjectW.argtypes = [c.c_void_p, w.LPCWSTR]
        self.k.CreateJobObjectW.restype = w.HANDLE
        self.k.SetInformationJobObject.argtypes = [
            w.HANDLE,
            c.c_int,
            c.c_void_p,
            w.DWORD,
        ]
        self.k.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.k.CloseHandle.argtypes = [w.HANDLE]
        self.k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
        self.k.OpenProcess.restype = w.HANDLE
        self.k.IsProcessInJob.argtypes = [w.HANDLE, w.HANDLE, c.POINTER(w.BOOL)]
        self.handle = self.k.CreateJobObjectW(None, None)
        if not self.handle:
            raise c.WinError(c.get_last_error())
        try:
            limit = Extended()
            limit.basic.flags = 0x2000
            if not self.k.SetInformationJobObject(
                self.handle, 9, c.byref(limit), c.sizeof(limit)
            ):
                raise c.WinError(c.get_last_error())
            if not self.k.AssignProcessToJobObject(self.handle, int(process._handle)):
                raise c.WinError(c.get_last_error())
            # Include descendants that might have been created before parent assignment.
            for child in psutil.Process(process.pid).children(recursive=True):
                handle = self.k.OpenProcess(0x0101 | 0x1000, False, child.pid)
                if not handle:
                    if not child.is_running():
                        continue
                    raise c.WinError(c.get_last_error())
                try:
                    inside = w.BOOL()
                    if not self.k.IsProcessInJob(handle, self.handle, c.byref(inside)):
                        raise c.WinError(c.get_last_error())
                    if not inside and not self.k.AssignProcessToJobObject(
                        self.handle, handle
                    ):
                        raise c.WinError(c.get_last_error())
                finally:
                    self.k.CloseHandle(handle)
        except Exception:
            self.close()
            raise

    def close(self):
        if self.handle:
            self.k.CloseHandle(self.handle)
            self.handle = None
