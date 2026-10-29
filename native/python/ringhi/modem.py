"""One modem transaction, with durable intent and immutable original backups."""

from pathlib import Path
from datetime import datetime
import struct, re, time
from . import storage
from .storage import read_json, save_json, verified, sha, now
from .wire import (open_ready, flash_identity as identity, at, PortOpenTimeout,
                   CommandRejected, transient_open, port_disconnected)
from .ports import NotReady
from .protocol import Download, partition
from .account import activate, retryable_activation, check_activation_context


def no_flash_written(state):
    return (
        state.get("phase") == "preparing"
        and not state.get("uid")
        and not state.get("lastWritten")
        and not state.get("backups")
    )


def old_for_mac(mac, pkg):
    records = [read_json(p) for p in (storage.ROOT / "ml-intents").glob("*.json")]
    records = [s for s in records if s.get("mac") == mac]
    if len(records) > 1:
        return resolved_alias(records, mac, pkg)
    if len(records) != 1 or records[0].get("firmwareSha256") != pkg.digest:
        raise OSError("下载模式缺少匹配的原固件及设备记录；未写入，请保留原备份")
    state = records[0]
    if not re.fullmatch(r"\d{15}", state.get("imei", "")):
        raise OSError("原记录缺少有效 IMEI")
    return state


def resolved_alias(records, mac, pkg):
    """Resolve old slot-1 IMEI aliases only with later verified hardware evidence.

    Keep every historical record. A merely newer timestamp cannot supersede an
    interrupted write, a different chip, or missing/corrupt original backups.
    """
    problem = "历史身份记录冲突，尚未确认同一芯片；未写入，请保留原备份"
    try:
        ordered = sorted(records, key=lambda r: datetime.fromisoformat(r["createdAt"]))
        current = ordered[-1]
        if current.get("phase") == "verified":
            verified_state = current
        elif no_flash_written(current) and current.get("previousBackup"):
            verified_state = read_json(Path(current["previousBackup"]) / "session.json")
        else:
            raise ValueError(problem)
        if (verified_state.get("phase") != "verified"
                or verified_state.get("mac") != mac
                or verified_state.get("imei") != current.get("imei")
                or not re.fullmatch(r"\d{15}", current.get("imei", ""))
                or any(r.get("firmwareSha256") != pkg.digest for r in (*records, verified_state))):
            raise ValueError(problem)
        confirmed = datetime.fromisoformat(verified_state["verifiedAt"])
        uid = verified_state["uid"]
        for older in ordered[:-1]:
            if (older.get("uid") != uid
                    or older.get("phase") not in ("verified", "awaiting-verification")
                    or datetime.fromisoformat(older["createdAt"]) >= confirmed):
                raise ValueError(problem)
        original_backups(verified_state, pkg)
        ledger = read_json(storage.ROOT / "activation" / (uid + ".json"), {})
        if ledger.get("uid") != uid or ledger.get("stage") != "complete":
            raise ValueError(problem)
        # Ephemeral expectation: preparing remains untouched, but the live ROM
        # UID must match before any new backup/erase/partition write.
        return dict(current, recoveryUid=uid)
    except (KeyError, TypeError, ValueError, OSError) as exc:
        raise OSError(problem) from exc


def original_backups(state, pkg, partial=False):
    if state.get("firmwareSha256") != pkg.digest or not re.fullmatch(
        r"[a-f0-9]{16,128}", state.get("uid", "")
    ):
        raise OSError("原备份固件或芯片 UID 不完整")
    root = Path(state["backup"]).resolve()
    result = {}
    for e in pkg.protected:
        meta = state.get("backups", {}).get(e.name, {})
        if not meta and partial:
            continue
        path = Path(meta.get("file", "")).resolve()
        if not path.is_relative_to(root):
            raise OSError("恢复文件不在原备份目录")
        data = path.read_bytes()
        if len(data) != e.capacity or sha(data) != meta.get("sha256"):
            raise OSError("原备份校验失败：" + e.name)
        result[e.name] = data
    if not result and not partial:
        raise OSError("缺少原始设备专属备份")
    return result


def check_uid(expected, found):
    if expected != found:
        raise OSError("实际芯片 UID 与原备份不匹配，未写入 Flash")


def verify_runtime(resolve, imei, cancel, status):
    # Re-open after a boot-time disconnect, always resolving the same chip anew.
    # Never reset/reflash or repeat an activation to repair an identity read.
    deadline = time.monotonic() + 60
    while True:
        cancel.check()
        try:
            with open_ready(lambda: resolve("runtime"), cancel, status,
                            timeout=max(0, min(5, deadline - time.monotonic())),
                            target="ML307 运行 AT 口（固件/激活后的启动核验）") as wire:
                actual, version = identity(wire, cancel)
        except Exception as exc:
            retry = isinstance(exc, (PortOpenTimeout, CommandRejected, TimeoutError))
            if not (retry or transient_open(exc) or port_disconnected(exc)):
                raise
            if time.monotonic() >= deadline:
                raise OSError(f"ML307 启动核验超时；已完成的写入和授权记录保留：{exc}") from exc
            status(f"等待 ML307 启动身份就绪 · {exc}")
            cancel.sleep(0.5)
            continue
        if actual != imei:
            raise OSError("复位后 IMEI 与原设备不一致")
        if "ringhi" not in version.lower():
            raise OSError("复位后 RingHi 固件版本未确认")
        return version


class _DownloadAppeared(Exception):
    """Abort a fallback AT open if the requested download port arrived."""


def enter_download(resolve, imei, cancel, status):
    status("切换 ML307 下载模式")
    with open_ready(lambda: resolve("runtime"), cancel, status,
                    target="ML307 运行 AT 口（进入下载前）") as wire:
        current, _ = identity(wire, cancel)
        if current != imei:
            raise OSError("下载前 IMEI 改变，已停止")
        at(wire, "AT^AUTODL", cancel, timeout=3, disconnect_ok=True)
    # A mode switch can temporarily expose neither interface. Keep waiting for
    # download instead of treating a missing old AT port as a failed download.
    start = time.monotonic()
    deadline = start + 45
    fallback_attempted = False
    last_missing = None
    status("等待 ML307 下载口重新枚举")
    while time.monotonic() < deadline:
        cancel.check()
        try:
            resolve("download")
            return
        except NotReady as exc:
            last_missing = exc
        if not fallback_attempted and time.monotonic() - start >= 8:
            try:
                resolve("runtime")
            except NotReady:
                pass
            else:
                fallback_attempted = True

                def remaining_runtime():
                    try:
                        resolve("download")
                    except NotReady:
                        return resolve("runtime")
                    raise _DownloadAppeared()

                try:
                    with open_ready(remaining_runtime, cancel, status, timeout=3,
                                    target="ML307 切换中仍存在的 AT 口") as wire:
                        current, _ = identity(wire, cancel)
                        if current != imei:
                            raise OSError("复位前 IMEI 改变")
                        status("ML307 仍在运行模式 · 确认身份后复位一次")
                        at(wire, "AT^RESET=normal", cancel, timeout=3, disconnect_ok=True)
                except _DownloadAppeared:
                    return
                except PortOpenTimeout:
                    # AT disappeared while opening: the mode switch may be in
                    # progress. Do not resend AUTODL or restart the whole job.
                    pass
                except OSError as exc:
                    if not port_disconnected(exc):
                        raise
                status("等待 ML307 下载口重新枚举")
        cancel.sleep(0.3)
    raise PortOpenTimeout(f"ML307 下载模式切换超时；未开始新的写入：{last_missing}")


def finish_verification(board, prior, resolve):
    """Finish a known write/activation without acquiring another activation."""
    board.update(imei=prior["imei"], backup=prior["backup"], mlProgress=98,
                 mlState="写入及官方激活已完成 · 等待启动身份核验")
    version = verify_runtime(resolve, prior["imei"], board.cancel,
                             lambda text: board.update(mlState=text))
    prior.update(phase="verified", versionAfter=version, verifiedAt=now())
    save_json(Path(prior["backup"]) / "session.json", prior)
    save_json(storage.ROOT / "ml-intents" / (prior["imei"] + ".json"), prior)
    board.update(mlProgress=100, mlState="写入、激活与启动身份确认完成")


def resume_activation(board, cfg, resolve, account, prepared, prior, already_download=False):
    cancel = board.cancel
    status = lambda text: board.update(mlState=text)
    ledger = read_json(storage.ROOT / "activation" / (prior["uid"] + ".json"), {})
    if (
        prior.get("phase") not in ("activating", "awaiting-verification")
        or not (retryable_activation(ledger) or ledger.get("stage") == "complete")
        or ledger.get("session") != prior.get("backup")
        or ledger.get("project_id") != account.project
        or prior.get("mac") != board.mac
        or prior.get("firmwareSha256") != cfg.package.digest
    ):
        raise OSError("原授权项目、设备或备份不匹配，未恢复激活")
    check_activation_context(ledger, prior["uid"], account.project)
    original_backups(prior, cfg.package)
    if ledger.get("stage") == "complete" and not already_download:
        finish_verification(board, prior, resolve)
        return
    # Confirm network readiness before switching a successfully written modem.
    account.choose_route(cancel, status)
    board.update(
        imei=prior["imei"],
        backup=prior["backup"],
        mlProgress=92,
        mlState="恢复同设备授权 · 保留已写固件和原备份",
    )
    if not already_download:
        enter_download(resolve, prior["imei"], cancel, status)
    with open_ready(lambda: resolve("download"), cancel, status,
                    target="ML307 下载口（恢复原设备授权）") as wire:
        dl = Download(wire, cancel)
        dl.bootstrap(cfg.package)  # RAM loaders only; no erase/partition writes.
        _, raw = dl.send(18, struct.pack("<I", 0), accepted=(0x83,))
        check_uid(prior["uid"], raw.hex())
        try:
            if ledger.get("stage") != "complete":
                activate(
                    dl,
                    prior["uid"],
                    Path(prior["backup"]),
                    account,
                    prepared,
                    cancel,
                    status,
                )
            prior.update(phase="awaiting-verification")
            save_json(Path(prior["backup"]) / "session.json", prior)
            save_json(storage.ROOT / "ml-intents" / (prior["imei"] + ".json"), prior)
            board.update(mlProgress=97, mlState="官方激活已确认 · 正在复位 ML307")
        except Exception:
            if not dl.broken and not cancel.event.is_set():
                try:
                    dl.reset()
                except OSError:
                    pass
            raise
        dl.reset()
    finish_verification(board, prior, resolve)


def pending_context(board, cfg, prior, project):
    ledger = read_json(storage.ROOT / "activation" / (prior.get("uid", "") + ".json"), {})
    check_activation_context(ledger, prior.get("uid"), project)
    if (not ledger or ledger.get("session") != prior.get("backup")
            or (project is not None and ledger.get("project_id") != project)
            or prior.get("mac") != board.mac
            or prior.get("firmwareSha256") != cfg.package.digest):
        raise OSError("恢复需使用同一设备、原授权项目和原固件，原备份已保留")
    original_backups(prior, cfg.package)
    return ledger


def preflight(board, cfg, resolve, project=None):
    """No flash writes until both chip identities/recovery records have been checked."""
    try:
        resolve("runtime")
    except NotReady:
        resolve("download")
        prior = old_for_mac(board.mac, cfg.package)
        if prior.get("phase") in ("writing", "recovering-writing", "backing-up"):
            original_backups(
                prior, cfg.package, partial=prior.get("phase") == "backing-up"
            )
        elif prior.get("phase") in ("activating", "awaiting-verification"):
            pending_context(board, cfg, prior, project)
        elif not no_flash_written(prior) and prior.get("phase") != "verified":
            raise OSError("下载中断阶段需核对原记录，未开始双芯写入")
        expected_uid = prior.get("uid") or prior.get("recoveryUid")
        if expected_uid:
            ledger = read_json(
                storage.ROOT / "activation" / (expected_uid + ".json"), {}
            )
            check_activation_context(ledger, expected_uid, project)
        board.update(imei=prior["imei"], mlState="原恢复记录已核对")
        return
    with open_ready(lambda: resolve("runtime"), board.cancel, timeout=20) as wire:
        imei, version = identity(wire, board.cancel, boot_wait=12,
                                 status=lambda text: board.update(mlState=text))
    prior = read_json(storage.ROOT / "ml-intents" / (imei + ".json"), {})
    if (
        prior
        and prior.get("phase")
        not in ("verified", "awaiting-verification", "activating")
        and not no_flash_written(prior)
    ):
        raise OSError("ML307 存在中断写入，请从下载模式使用原备份恢复；未开始双芯写入")
    if prior and board.mac and prior.get("mac") and prior["mac"] != board.mac:
        raise OSError("当前 IMEI 对应另一块板的记录，请核对卡槽和设备身份；未写入")
    if prior.get("phase") in ("activating", "awaiting-verification"):
        pending_context(board, cfg, prior, project)
    board.update(imei=imei, mlState="型号与 IMEI 已确认")


def run(board, cfg, resolve, account, prepared):
    cancel = board.cancel
    pkg = cfg.package
    status = lambda text: board.update(mlState=text)
    progress = lambda n, text: board.update(mlProgress=n, mlState=text)
    runtime = None
    try:
        runtime = resolve("runtime")
    except NotReady:
        pass
    prior = None
    version = ""
    imei = ""
    already_download = runtime is None
    if runtime:
        status("核对 ML307H 型号与 IMEI")
        with open_ready(lambda: resolve("runtime"), cancel, status) as wire:
            imei, version = identity(wire, cancel, boot_wait=12, status=status)
        prior = read_json(storage.ROOT / "ml-intents" / (imei + ".json"), {})
        # A completed write may merely have raced boot-time identity availability.
        if prior.get("phase") in ("awaiting-verification", "activating"):
            ledger = read_json(
                storage.ROOT / "activation" / (prior.get("uid", "") + ".json"), {}
            )
            if retryable_activation(ledger):
                resume_activation(board, cfg, resolve, account, prepared, prior)
                return
            if (
                prior.get("mac") != board.mac
                or prior.get("firmwareSha256") != pkg.digest
                or ledger.get("stage") != "complete"
                or ledger.get("session") != prior.get("backup")
            ):
                raise OSError("上次授权或写入结果待核对，未重复领取激活码")
            pending_context(board, cfg, prior, account.project)
            finish_verification(board, prior, resolve)
            return
        if prior and prior.get("phase") != "verified" and not no_flash_written(prior):
            raise OSError(
                "这台设备存在中断写入；请完全断电重插进入下载模式，使用原备份恢复"
            )
    else:
        resolve("download")  # Reject generic or ambiguous ports before loading RAM.
        prior = old_for_mac(board.mac, pkg)
        imei = prior["imei"]
        version = prior.get("versionBefore", "")
    if already_download and prior.get("phase") in ("activating", "awaiting-verification"):
        pending_context(board, cfg, prior, account.project)
        resume_activation(board, cfg, resolve, account, prepared, prior, already_download=True)
        return
    board.update(imei=imei)
    recovery = already_download and prior.get("phase") in (
        "writing",
        "recovering-writing",
        "backing-up",
    )
    if (
        already_download
        and not recovery
        and not no_flash_written(prior)
        and prior.get("phase") != "verified"
    ):
        raise OSError("此下载中断阶段需要人工核对原记录，未重复激活")
    resume_backup = recovery and prior.get("phase") == "backing-up"
    saved = original_backups(prior, pkg, partial=resume_backup) if recovery else None
    # Preflight activation ledger before erasing any firmware; ambiguous requests cannot be replayed.
    if prior and prior.get("uid"):
        ledger = read_json(storage.ROOT / "activation" / (prior["uid"] + ".json"), {})
        if ledger and ledger.get("stage") != "complete":
            raise OSError("上次激活请求结果未知，请先核对官方记录，未开始新写入")
    if recovery:
        state = dict(prior)
        backup = Path(state["backup"])
    else:
        backup = cfg.backup / (
            time.strftime("%Y%m%d-%H%M%S") + "_" + imei + "_" + board.id
        )
        backup.mkdir(parents=True, exist_ok=False)
        state = {
            "schema": 1,
            "kind": "ringhi-python-flash-session",
            "imei": imei,
            "mac": board.mac,
            "hub": board.hub,
            "firmwareSha256": pkg.digest,
            "versionBefore": version,
            "backup": str(backup),
            "phase": "preparing",
            "createdAt": now(),
        }
        if prior:
            state["previousBackup"] = prior.get("backup", "")
    board.update(backup=str(backup))
    intent = storage.ROOT / "ml-intents" / (imei + ".json")

    def save():
        save_json(backup / "session.json", state)
        save_json(intent, state)

    if already_download and (prior.get("uid") or prior.get("recoveryUid")) and not recovery:
        save_json(backup / "session.json", state)
    else:
        save()
    if not already_download:
        enter_download(resolve, imei, cancel, status)
    done = {}
    weights = {e.name: e.size for e in pkg.loaders}
    for e in pkg.protected:
        weights["备份 " + e.name] = e.capacity
        weights["写入 " + e.target] = e.capacity
    for e in pkg.writes:
        weights["写入 " + e.target] = e.size
    total = max(1, sum(weights.values()))
    last = [0.0]

    def advance(name, n, size):
        done[name] = min(n, size)
        if n == size or time.monotonic() - last[0] > 0.12:
            last[0] = time.monotonic()
            progress(
                min(90, 2 + int(88 * sum(done.values()) / total)),
                ("恢复 " if recovery else "") + name + f" · {n * 100 // max(1, size)}%",
            )

    with open_ready(lambda: resolve("download"), cancel, status,
                    target="ML307 下载口（写入前）") as wire:
        dl = Download(wire, cancel, advance)
        status("连接官方 ROM 下载器")
        dl.bootstrap(pkg)
        _, raw_uid = dl.send(18, struct.pack("<I", 0), accepted=(0x83,))
        uid = raw_uid.hex()
        if not re.fullmatch(r"[a-f0-9]{16,128}", uid):
            raise OSError("芯片 UID 无效")
        expected_uid = (prior.get("uid") or prior.get("recoveryUid")) if prior else None
        if expected_uid:
            check_uid(expected_uid, uid)
        state["uid"] = uid
        if not recovery or resume_backup:
            state["phase"] = "backing-up"
            if not resume_backup:
                state["backups"] = {}
                saved = {}
            save()
            for e in pkg.protected:
                if e.name in saved:
                    continue
                data = dl.backup(e)
                path = backup / (e.name + ".bin")
                verified(path, data)
                saved[e.name] = data
                state["backups"][e.name] = {
                    "file": str(path),
                    "size": len(data),
                    "sha256": sha(data),
                }
                save()
        original_backups(
            state, pkg
        )  # Read back every saved original byte before writes.
        ledger = read_json(storage.ROOT / "activation" / (uid + ".json"), {})
        if ledger and ledger.get("stage") != "complete":
            raise OSError("芯片上次激活结果未知，未写入新固件")
        table, _ = dl.send(15, accepted=(0x80, 0xB1))
        state["phase"] = "recovering-writing" if recovery else "writing"
        save()
        if table == 0xB1:
            dl.send(14, timeout=180)
        for e in pkg.entries:
            if e.kind == "CODE" and e.backup == 2:
                dl.send(10, partition(e.target, 0))
        for e in pkg.writes:
            if e.target == "mbl":
                continue
            dl.write(e.target, pkg.payload(e))
            state["lastWritten"] = e.name
            save()
        for e in pkg.protected:
            dl.write(e.target, saved[e.name])
        mbl = pkg.writes[-1]
        dl.write(mbl.target, pkg.payload(mbl))
        state["phase"] = "activating"
        save()
        progress(92, "写入完成 · 自动激活")
        try:
            activate(dl, uid, backup, account, prepared, cancel, status)
        except Exception:
            if not dl.broken and not cancel.event.is_set():
                try:
                    dl.reset()
                except OSError:
                    pass
            raise
        state["phase"] = "awaiting-verification"
        save()
        progress(97, "官方激活已确认 · 正在复位 ML307")
        dl.reset()
    progress(98, "已激活 · 等待启动身份核验")
    state["versionAfter"] = verify_runtime(resolve, imei, cancel, status)
    state["phase"] = "verified"
    state["verifiedAt"] = now()
    save()
    progress(100, "写入、原始数据、自动激活与重启身份通过")
