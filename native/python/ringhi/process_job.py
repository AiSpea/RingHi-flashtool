"""Windows kill-on-close process job. An esptool child cannot outlive its task."""

import ctypes as c, sys, os, subprocess, threading, time
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
        except Exception:
            self.close()
            raise

    def close(self):
        if not self.handle:
            return
        # Closing a job requests termination asynchronously. Wait for all owned
        # processes to exit before allowing another command to reopen the port.
        class Accounting(c.Structure):
            _fields_ = [("times", c.c_longlong * 4), ("faults", w.DWORD),
                        ("total", w.DWORD), ("active", w.DWORD), ("ended", w.DWORD)]
        self.k.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
        self.k.TerminateJobObject.restype = w.BOOL
        self.k.QueryInformationJobObject.argtypes = [w.HANDLE, c.c_int,
            c.c_void_p, w.DWORD, c.c_void_p]
        self.k.QueryInformationJobObject.restype = w.BOOL
        try:
            if not self.k.TerminateJobObject(self.handle, 1):
                raise c.WinError(c.get_last_error())
            deadline = time.monotonic() + 5
            while True:
                info = Accounting()
                if not self.k.QueryInformationJobObject(
                        self.handle, 1, c.byref(info), c.sizeof(info), None):
                    raise c.WinError(c.get_last_error())
                if info.active == 0:
                    break
                if time.monotonic() >= deadline:
                    raise OSError("ESP32 子进程尚未完全退出，端口不能重新使用")
                time.sleep(0.025)
        finally:
            self.k.CloseHandle(self.handle)
            self.handle = None


_launch_lock = threading.Lock()


def external_environment():
    # esptool is an independent frozen application, not a RingHi child worker.
    env = {k: v for k, v in os.environ.items()
           if not k.startswith("_PYI_") and k not in
           ("_MEIPASS2", "PYTHONHOME", "PYTHONPATH")}
    env.update(PYINSTALLER_RESET_ENVIRONMENT="1", PYTHONIOENCODING="utf-8",
               PYTHONUNBUFFERED="1")
    bundle = getattr(sys, "_MEIPASS", None)
    if bundle:
        base = os.path.normcase(os.path.abspath(bundle))
        env["PATH"] = os.pathsep.join(
            p for p in env.get("PATH", "").split(os.pathsep)
            if not (os.path.normcase(os.path.abspath(p)) == base or
                    os.path.normcase(os.path.abspath(p)).startswith(base + os.sep)))
    return env


def launch(command):
    """Assign the suspended process before its bootloader can spawn children."""
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    windows = sys.platform == "win32"
    if windows:
        flags |= 0x00000004  # CREATE_SUSPENDED; no child can escape the job.
    with _launch_lock:
        kernel = None
        if windows:
            kernel = c.WinDLL("kernel32", use_last_error=True)
            kernel.GetDllDirectoryW.argtypes = [w.DWORD, w.LPWSTR]
            kernel.GetDllDirectoryW.restype = w.DWORD
            kernel.SetDllDirectoryW.argtypes = [w.LPCWSTR]
            kernel.SetDllDirectoryW.restype = w.BOOL
            size = kernel.GetDllDirectoryW(0, None)
            directory = c.create_unicode_buffer(size + 1)
            kernel.GetDllDirectoryW(len(directory), directory)
            if not kernel.SetDllDirectoryW(None):
                raise c.WinError(c.get_last_error())
        try:
            process = subprocess.Popen(
                command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, creationflags=flags,
                env=external_environment())
        finally:
            if kernel:
                kernel.SetDllDirectoryW(directory.value or None)
    job = None
    try:
        job = Job(process)
        if windows:
            psutil.Process(process.pid).resume()
        return process, job
    except Exception:
        if job:
            job.close()
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        process.stdout.close()
        raise
