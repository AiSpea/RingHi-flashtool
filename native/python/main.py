import sys, ctypes
from pathlib import Path


def main():
    import truststore

    truststore.inject_into_ssl()

    if "--self-test" in sys.argv:
        import pytest

        return pytest.main([str(Path(__file__).parent / "tests"), "-q"])
    # Named OS mutex prevents another native writer in the same Windows session.
    handle = None
    if sys.platform == "win32" and "--ui-test" not in sys.argv:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateMutexW.argtypes = [
            ctypes.c_void_p,
            ctypes.c_bool,
            ctypes.c_wchar_p,
        ]
        kernel.CreateMutexW.restype = ctypes.c_void_p
        handle = kernel.CreateMutexW(None, True, r"Local\RingHi.Native.Workstation")
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        if ctypes.get_last_error() == 183:
            ctypes.windll.user32.MessageBoxW(
                None, "RingHi 已在运行，请使用已打开的窗口。", "RingHi", 0
            )
            return 1
    from PySide6.QtWidgets import QApplication
    from PySide6.QtGui import QFont, QFontDatabase
    from ringhi import storage

    test = "--ui-test" in sys.argv
    if test:
        root = Path(sys.argv[sys.argv.index("--ui-test") + 1])
        root.mkdir(parents=True, exist_ok=True)
        storage.ROOT = root / "isolated-user-data"
    app = QApplication(sys.argv)
    if test and sys.platform == "win32" and app.platformName() == "offscreen":
        # Offscreen Qt has no Windows font provider; load local OS fonts for QA only.
        import os

        fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
        for name in ("msyh.ttc", "msyhbd.ttc", "segoeui.ttf"):
            if QFontDatabase.addApplicationFont(str(fonts / name)) < 0:
                raise RuntimeError("软件验证无法加载系统字体：" + name)
    app.setApplicationName("RingHi")
    app.setOrganizationName("AiSpea")
    app.setFont(QFont("Microsoft YaHei UI", 10))
    from ringhi.ui import Window, STYLE

    app.setStyleSheet(STYLE)
    window = Window(test=test)
    window.show()
    if test:
        from tests.ui_check import schedule

        schedule(window, root)
    from ringhi.notifications import RemovalFilter

    notifications = RemovalFilter(window)
    app.installNativeEventFilter(notifications)
    code = app.exec()
    notifications.close()
    if handle:
        kernel.ReleaseMutex.argtypes = [ctypes.c_void_p]
        kernel.ReleaseMutex(handle)
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel.CloseHandle(handle)
    return code


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        import traceback
        from ringhi import storage

        storage.ROOT.mkdir(parents=True, exist_ok=True)
        (storage.ROOT / "startup-error.log").write_text(
            traceback.format_exc(), encoding="utf-8"
        )
        if sys.platform == "win32":
            ctypes.windll.user32.MessageBoxW(
                None,
                "启动失败，诊断已保存到：" + str(storage.ROOT / "startup-error.log"),
                "RingHi",
                0,
            )
        raise
