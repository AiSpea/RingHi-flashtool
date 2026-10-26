import os, sys, re, subprocess, time, threading, queue
from pathlib import Path
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


def run(
    port,
    command,
    args,
    cancel,
    log=lambda s: None,
    timeout=90,
    after="no-reset",
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
        "--baud",
        str(baud),
        "--before",
        before,
        "--after",
        after,
        command,
    ] + list(args)
    p = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"},
    )
    from .process_job import Job

    try:
        job = Job(p)
    except Exception:
        kill_tree(p)
        raise
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
                raise TimeoutError("ESP32 官方工具执行超时")
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
            raise OSError("ESP32 官方工具失败：" + "\n".join(out[-12:]))
        return text
    finally:
        job.close()
        if p.poll() is None:
            kill_tree(p)
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


def identify(resolve, cancel, status=lambda text: None):
    from .ports import NotReady

    # Only flash-id is retried: it reads identity and loads the RAM stub, never
    # writes flash. Re-resolve the same hub/chip after USB re-enumeration.
    before = "default-reset"
    for attempt in range(4):
        try:
            status(
                "读取 MAC 与 Flash 容量"
                if not attempt
                else f"等待 USB 下载口恢复 · {attempt + 1}/4"
            )
            return parse_identity(
                run(resolve().path, "flash-id", [], cancel, timeout=30, before=before)
            )
        except OSError as e:
            text = str(e)
            unopened = isinstance(e, NotReady) or (
                "Could not open COM" in text
                and not re.search("Connecting|Connected to|Writing at", text)
            )
            reset_disconnect = (
                "ClearCommError failed" in text
                or "A serial exception error occurred" in text
                or "Failed to connect" in text
            )
            if not (unopened or reset_disconnect) or attempt == 3:
                raise
            # A reset can invalidate Windows' open CDC handle. First reopen
            # without resetting again; only then try the official USB reset.
            if not unopened:
                before = "usb-reset" if before == "no-reset" else "no-reset"
            cancel.sleep(1)


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
    result = run(
        resolve().path, "write-flash", options, cancel, output, 600, before="no-reset"
    )
    if not write_verified(result):
        raise OSError("未确认完整 16 MB 写入与 MD5，未判定成功")
    progress(97, "独立复核完整 16 MB MD5")
    verified = run(
        resolve().path, "verify-flash", options, cancel, log, 120, before="no-reset"
    )
    if not digest_verified(verified):
        raise OSError("完整 Flash MD5 未确认一致")
    progress(100, "完整 MD5 校验通过 · esptool 5.6.0")


def reset(resolve, cancel):
    run(
        resolve().path,
        "read-mac",
        [],
        cancel,
        timeout=45,
        after="hard-reset",
        before="no-reset",
    )
