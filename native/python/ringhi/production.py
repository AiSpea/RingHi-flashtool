import json, time, codecs
from dataclasses import dataclass
from .wire import open_ready
from .storage import Cancelled


@dataclass
class Result:
    state: str = "running"
    reason: str = "等待产测"
    run_id: str = ""
    cloud: bool = False
    pending: bool = True
    upload: str = ""
    phase: str = ""

    @property
    def ready(self):
        return (
            self.state == "passed"
            and self.cloud
            and not self.pending
            and self.upload == "uploaded"
        )


def evaluate(status):
    report = status.get("report") or {}
    r = Result(
        run_id=report.get("runId", ""),
        cloud=status.get("cloudRegistered") is True,
        pending=status.get("pendingUpload") is not False,
        upload=status.get("upload", ""),
    )
    checks = report.get("checks")
    if not r.run_id or not isinstance(checks, list):
        return r
    stage = report.get("stage")
    failed = [c for c in checks if c.get("status") == "failed"]
    if stage == "cancelled" or report.get("cancelled"):
        r.state = "cancelled"
        r.reason = "设备取消产测"
        return r
    if stage == "failed" or failed:
        r.state = "failed"
        r.reason = (
            "；".join(c.get("id", "") + ": " + c.get("detail", "") for c in failed)
            or "设备报告产测失败"
        )
        return r
    if report.get("ledPolicy") != "volte-card-v3":
        r.state = "review"
        r.reason = "需要 s3.142 或兼容 volte-card-v3 的产测固件"
        return r
    if stage != "passed":
        r.reason = "产测中：" + str(stage)
        return r
    if not all(
        any(c.get("id") == i and c.get("status") == "passed" for c in checks)
        for i in ("wifi", "volte", "sim")
    ):
        r.state = "review"
        r.reason = "产测终态与必检项不一致"
        return r
    r.state = "passed"
    r.phase = "registration" if not r.cloud else "upload" if not r.ready else "closing"
    r.reason = (
        "产测通过 · 等待云端登记"
        if not r.cloud
        else "登记成功 · 等待最终报告上传"
        if not r.ready
        else "产测与云端确认完成 · 释放端口"
    )
    return r


def command(wire, cmd, accept, cancel, timeout=12):
    wire.clear()
    wire.write((cmd + "\n").encode("ascii"))
    buf = ""
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        cancel.check()
        buf += decoder.decode(wire.read())
        if len(buf) > 65536:
            raise OSError("产测响应过长")
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            result = accept(line.strip())
            if result is not None:
                return result
    return None


def status(wire, cancel):
    def parse(line):
        try:
            obj = json.loads(line)
            if (
                isinstance(obj, dict)
                and type(obj.get("active")) is bool
                and type(obj.get("done")) is bool
                and "report" in obj
            ):
                return obj
        except (ValueError, TypeError):
            pass

    return command(wire, "FACTORY STATUS", parse, cancel)


def run(resolve, cancel, change):
    port = None
    try:
        deadline = time.monotonic() + 45
        initial = None
        while time.monotonic() < deadline:
            cancel.check()
            try:
                port = open_ready(resolve, cancel, timeout=3)
                initial = status(port, cancel)
                if initial is not None:
                    break
            except Cancelled:
                raise
            except (OSError, ValueError):
                pass
            if port:
                port.close()
                port = None
            cancel.sleep(1)
        if initial is None:
            raise OSError("未收到 FACTORY STATUS：固件未启动、USB 未恢复或固件不支持")
        if initial.get("pendingUpload"):
            raise OSError("保留上一轮待上传报告；请联网完成上传后再测")
        baseline = (initial.get("report") or {}).get("runId", "")
        answer = command(
            port,
            "FACTORY RETEST",
            lambda line: (
                "armed"
                if line.startswith("Factory scan armed")
                else "refused"
                if line.startswith("Refused:")
                else None
            ),
            cancel,
        )
        if answer != "armed":
            raise OSError("产测启动未确认，未重复发送")
        deadline = time.monotonic() + 180
        run_id = ""
        sequence = -1
        terminal = None
        change(Result(reason="等待 AiSpea_Factory 工厂 Wi-Fi"))
        while time.monotonic() < deadline:
            cancel.sleep(1.5)
            s = status(port, cancel)
            if s is None:
                continue
            report = s.get("report") or {}
            ident = report.get("runId", "")
            if not ident or ident == baseline:
                continue
            if run_id and ident != run_id:
                raise OSError("产测轮次意外变化")
            run_id = ident
            next_seq = int(report.get("sequence", sequence))
            if next_seq < sequence:
                raise OSError("产测报告序号倒退")
            sequence = next_seq
            r = evaluate(s)
            change(r)
            if r.ready:
                port.close()
                port = None
                r.phase = "complete"
                r.reason = "产测通过 · 云端登记和报告上传完成"
                change(r)
                return r
            if r.state == "passed":
                terminal = terminal or time.monotonic()
                if time.monotonic() - terminal >= 30:
                    raise TimeoutError(
                        "最终报告上传超时" if r.cloud else "云端登记超时"
                    )
            elif r.state != "running":
                return r
        raise TimeoutError("产测超时，请检查工厂 Wi-Fi、SIM / eSIM 与设备状态")
    finally:
        if port:
            port.close()
