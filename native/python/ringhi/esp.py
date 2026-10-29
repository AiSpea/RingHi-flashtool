import sys, re, subprocess, time, threading, queue
from pathlib import Path
from contextlib import contextmanager
import psutil
from .storage import sha

ENGINE_HASH = "7a4fc0b651197d8034dab52db1468ebf5c009d8e754306e59c7de0aa47767914"


def resource(name):
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent)) / name


def engine():
    p = resource("Tools/esptool.exe")
    if not p.exists() or sha(p.read_bytes()) != ENGINE_HASH:
        raise OSError("乐鑫官方 esptool 缺失或 SHA-256 不匹配")
    return p


def validate_image(raw):
    if (
        len(raw) != 16777216
        or raw[0] != 0xE9
        or int.from_bytes(raw[12:14], "little") != 9
    ):
        raise ValueError("请选择 ESP32-S3 完整 16 MB BIN（地址 0x0）")


def clean(s):
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", s)


def decode_output(data):
    # Official Windows exe may format Win32 messages using the local code page.
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("gb18030", "replace")


def kill_tree(p):
    try:
        parent = psutil.Process(p.pid)
        children = parent.children(recursive=True)
        for child in children:
            try:
                child.kill()
            except psutil.NoSuchProcess:
                pass
        try:
            parent.kill()
        except psutil.NoSuchProcess:
            pass
        psutil.wait_procs(children + [parent], timeout=5)
    except psutil.NoSuchProcess:
        pass
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        raise OSError("烧录子进程未能退出，端口仍锁定，停止接收新板")



_port_locks = {}
_port_locks_guard = threading.Lock()


@contextmanager
def port_lease(port, cancel):
    # Serialize only this port, including child cleanup. Other boards stay parallel.
    with _port_locks_guard:
        lock = _port_locks.setdefault(port, threading.Lock())
    while not lock.acquire(timeout=0.1):
        cancel.check()
    try:
        cancel.check()
        yield
    finally:
        lock.release()


class ToolFailure(OSError):
    def __init__(self, message, output):
        super().__init__(message)
        self.output = output


class PortCleanupError(OSError):
    pass

def run(
    port,
    command,
    args,
    cancel,
    log=lambda s: None,
    timeout=90,
    after="no-reset-stub",
    baud=460800,
    before="default-reset",
):
    if not re.fullmatch(r"COM\d+", port):
        raise ValueError("目标串口无效")
    cancel.check()
    exe = engine()
    cmd = [
        str(exe),
        "--chip",
        "esp32s3",
        "--port",
        port,
        "--connect-attempts",
        "2",
        "--baud",
        str(baud),
        "--before",
        before,
        "--after",
        after,
        command,
    ] + list(args)
    with port_lease(port, cancel):
        return execute(cmd, cancel, log, timeout)


def preflight(cancel):
    """Check the bundled engine in its real launch environment, without a port."""
    text = execute([str(engine()), "version"], cancel, timeout=30)
    if not re.search(r"(?m)^esptool(?:\.py)? v5\.6\.0\b", text):
        raise OSError("ESP32 工具自检失败：未返回预期的 esptool 5.6.0 版本")
    return text


def execute(cmd, cancel, log=lambda s: None, timeout=90):
    from .process_job import launch

    cancel.check()
    try:
        p, job = launch(cmd)
    except (OSError, psutil.Error) as exc:
        code = (getattr(exc, "winerror", None) or getattr(exc, "errno", None)
                or type(exc).__name__)
        raise OSError(
            f"ESP32 工具启动失败（系统错误 {code}）：{exc}。"
            "尚未连接芯片；请检查工具文件是否被安全软件隔离、安装目录权限。"
        ) from exc
    q = queue.Queue()
    out = []

    def read():
        try:
            buf = b""
            while True:
                chunk = p.stdout.read(1)
                if not chunk:
                    break
                if chunk in (b"\r", b"\n"):
                    if buf:
                        q.put(clean(decode_output(buf)))
                        buf = b""
                else:
                    buf += chunk
            if buf:
                q.put(clean(decode_output(buf)))
        finally:
            q.put(None)

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    deadline = time.monotonic() + timeout
    ended = False
    try:
        while not ended:
            cancel.check()
            if time.monotonic() > deadline:
                raise ToolFailure("ESP32 官方工具执行超时", "\n".join(out))
            try:
                line = q.get(timeout=0.1)
            except queue.Empty:
                continue
            if line is None:
                ended = True
                continue
            out.append(line)
            log(line)
            if sum(map(len, out[-20:])) > 30000:
                raise OSError("ESP32 输出异常过长")
        code = p.wait(timeout=5)
        text = "\n".join(out)
        if code:
            raise ToolFailure(f"ESP32 官方工具失败（退出码 {code} / 0x{code & 0xffffffff:08X}）："
                          + ("\n".join(out[-12:]) or "进程未输出诊断，请检查安全软件拦截记录和安装文件。"), text)
        return text
    finally:
        try:
            job.close()
            if p.poll() is None:
                kill_tree(p)
            p.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise PortCleanupError("ESP32 子进程占用尚未释放，未启动下一次串口操作") from exc
        finally:
            p.stdout.close()
            reader.join(timeout=2)


def parse_identity(text):
    if not re.search(r"Chip type:\s*ESP32-?S3\b", text, re.I) or not re.search(
        r"Detected flash size:\s*16\s*MB\b", text, re.I
    ):
        raise OSError("芯片或 Flash 容量不符合 ESP32-S3 16 MB")
    m = re.search(r"(?im)^MAC:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})\s*$", text)
    if not m:
        raise OSError("未读到 ESP32 MAC")
    return m[1].upper()


def recoverable(exc):
    from .ports import NotReady, Ambiguous
    if isinstance(exc, (PortCleanupError, Ambiguous)):
        return False
    if isinstance(exc, NotReady):
        return True
    text = str(exc) + "\n" + getattr(exc, "output", "")
    if "工具启动失败" in text or "SHA-256" in text:
        return False
    return any(term in text for term in (
        "Could not open COM", "ClearCommError failed", "PermissionError",
        "A serial exception error occurred", "Failed to connect",
        "Write timeout", "write timeout", "Cannot configure port",
        "GetOverlappedResult", "device does not recognize", "No serial data received",
        "Packet content transfer stopped", "SerialException",
    )) or isinstance(exc, ToolFailure) and "执行超时" in str(exc)


def wait_port(resolve, cancel, status, seconds=20):
    from .ports import NotReady
    deadline = time.monotonic() + seconds
    while True:
        cancel.check()
        try:
            return resolve()
        except NotReady as exc:
            if time.monotonic() >= deadline:
                raise OSError("ESP32 下载口在等待后仍未出现，请检查 USB 连接或驱动") from exc
            status("等待同一块板的 USB 串口重新枚举…")
            cancel.sleep(0.35)


def identify(resolve, cancel, status=lambda text: None, *, expected=None,
             before="default-reset", log=lambda text: None):
    modes = (before, "no-reset", "usb-reset", "no-reset", "default-reset", "no-reset")
    for attempt, mode in enumerate(modes):
        cancel.check()
        status("读取 MAC 与 Flash 容量" if not attempt else
               f"自动恢复 ESP32 连接 · {attempt + 1}/{len(modes)} · {mode}")
        try:
            port = wait_port(resolve, cancel, status)
            text = run(port.path, "flash-id", [], cancel, log=log,
                       timeout=20, before=mode)
            mac = parse_identity(text)
            if expected and mac != expected:
                raise OSError("ESP32 MAC 与本轮设备不一致，已停止恢复，未继续写入")
            return mac
        except OSError as exc:
            if not recoverable(exc) or attempt == len(modes) - 1:
                raise
            # run() has joined its own process tree before retrying. Never kill
            # another application's process to take its serial port.
            log(f"ESP32 连接恢复 {attempt + 1}: {exc}")
            status("正在释放本工具占用并等待串口恢复；其他串口软件需先关闭")
            cancel.sleep(1)


def read_operation(resolve, command, args, cancel, status, log, timeout,
                   expected=None, after="no-reset-stub"):
    # Verification is read-only. Recovery can re-enter ROM but cannot reflash.
    for attempt in range(3):
        try:
            port = wait_port(resolve, cancel, status)
            return run(port.path, command, args, cancel, log, timeout,
                       before="no-reset", after=after)
        except OSError as exc:
            if not recoverable(exc) or attempt == 2:
                raise
            log(f"ESP32 {command} 连接恢复: {exc}")
            identify(resolve, cancel, status, expected=expected, before="no-reset", log=log)



def write_verified(text):
    return (
        bool(re.search(r"(?m)^Wrote 16777216 bytes\b", text))
        and "Hash of data verified." in text
    )


def digest_verified(text):
    return (
        "Verifying 0x1000000 (16777216) bytes at 0x00000000 in flash" in text
        and "Verification successful (digest matched)." in text
    )


def verification_interrupted(exc):
    """Only a completed single-image write followed by a transport failure.

    esptool 5.6 prints Wrote after the final write barrier, then starts MD5.
    A Windows driver can reject the timeout/port configuration used by MD5.
    This permits a fresh read-only verification, never another Flash write.
    """
    if not isinstance(exc, ToolFailure) or not recoverable(exc):
        return False
    text = exc.output
    if re.search(r"MD5 of file does not match|Write failed|Verification failed|"
                 r"Reflashing the whole image", text, re.I):
        return False
    completed = list(re.finditer(
        r"(?m)^Wrote 16777216 bytes(?: \(\d+ compressed\))? "
        r"at 0x00000000(?: in [^\r\n]+)?\r?$", text))
    if len(completed) != 1:
        return False
    tail = text[completed[0].end():]
    return ("Verifying written data..." in tail
            and not re.search(r"Writing at|Erasing|^Wrote ", tail, re.M))


def verify_written(resolve, file, raw, mac, cancel, progress, log,
                   reconnect=False):
    """Read-only completion; bind the image and recovered port to this task."""
    validate_image(raw)
    if sha(Path(file).read_bytes()) != sha(raw):
        raise OSError("本批次固件快照已改变，未继续校验")
    if reconnect:
        progress(96, "写入已完成 · 恢复校验连接，核对原设备 MAC")
        identify(resolve, cancel, lambda s: progress(96, s), expected=mac,
                 before="no-reset", log=log)
    progress(97, "独立复核完整 16 MB MD5")
    options = ["--flash-mode", "keep", "--flash-freq", "keep",
               "--flash-size", "keep", "0x0", str(file)]
    verified = read_operation(
        resolve, "verify-flash", options, cancel, lambda s: progress(97, s),
        log, 120, expected=mac,
    )
    if not digest_verified(verified):
        raise OSError("完整 Flash MD5 未确认一致")
    progress(100, "完整 MD5 校验通过 · esptool 5.6.0")


def flash(resolve, file, raw, mac, cancel, progress, log):
    validate_image(raw)
    if sha(Path(file).read_bytes()) != sha(raw):
        raise OSError("本批次固件快照已改变，未写入")

    def output(line):
        log(line)
        m = re.search(r"Writing at\s+0x[0-9a-f]+.*?\b(\d+(?:\.\d+)?)%", line, re.I)
        if m:
            progress(min(95, int(float(m[1]))), "写入 Flash · " + m[1] + "%")
        elif "Verifying written data" in line:
            progress(96, "写入完成 · 校验 Flash")
        elif "Connecting" in line:
            progress(1, "连接乐鑫 ROM 下载器")

    options = [
        "--flash-mode",
        "keep",
        "--flash-freq",
        "keep",
        "--flash-size",
        "keep",
        "0x0",
        str(file),
    ]
    # A fresh port lookup also checks this board's connection generation.
    # Re-issue write-flash ONLY when the official tool explicitly failed to open
    # or synchronize, before it could begin an erase/write command.
    for attempt in range(3):
        try:
            port = wait_port(resolve, cancel, lambda s: progress(0, s))
            result = run(port.path, "write-flash", options, cancel, output,
                         600, before="no-reset")
            break
        except OSError as exc:
            if verification_interrupted(exc):
                cancel.check()
                log(f"ESP32 完整写入后的校验连接中断；仅恢复校验，不重写 Flash：{exc}")
                try:
                    verify_written(resolve, file, raw, mac, cancel, progress, log,
                                   reconnect=True)
                except OSError as recovery:
                    raise OSError(
                        "ESP32 固件数据已发送完成，但完整 MD5 校验未通过；"
                        "未重复擦写，不能判定烧录成功。校验恢复结果：" + str(recovery)
                    ) from recovery
                return
            text = str(exc) + "\n" + getattr(exc, "output", "")
            preconnect = ("Could not open COM" in text or "Failed to connect" in text)
            started = re.search(r"Connected to|Stub running|Stub flasher running|"
                                r"Flash will be erased|Erasing|Writing at|Wrote ", text)
            if not recoverable(exc) or not preconnect or started or attempt == 2:
                raise
            log(f"ESP32 尚未开始写入，恢复下载连接: {exc}")
            identify(resolve, cancel, lambda s: progress(0, s), expected=mac,
                     before="no-reset", log=log)
    if not write_verified(result):
        raise OSError("未确认完整 16 MB 写入与 MD5，未判定成功")
    verify_written(resolve, file, raw, mac, cancel, progress, log)


def reset(resolve, cancel, expected=None):
    read_operation(resolve, "read-mac", [], cancel, lambda s: None,
                   lambda s: None, 45, expected=expected, after="hard-reset")
