"""One modem transaction, with durable intent and immutable original backups."""

from pathlib import Path
import struct, re, time
from . import storage
from .storage import read_json, save_json, verified, sha, now
from .wire import open_ready, identity, at
from .ports import NotReady
from .protocol import Download, partition
from .account import activate, retryable_activation


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
    if len(records) != 1 or records[0].get("firmwareSha256") != pkg.digest:
        raise OSError("下载模式缺少唯一匹配的原固件及设备记录；未写入，请保留原备份")
    state = records[0]
    if not re.fullmatch(r"\d{15}", state.get("imei", "")):
        raise OSError("原记录缺少有效 IMEI")
    return state


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
    with open_ready(lambda: resolve("runtime"), cancel, status, timeout=45) as wire:
        actual, version = identity(wire, cancel, boot_wait=20)
    if actual != imei:
        raise OSError("复位后 IMEI 与原设备不一致")
    if "ringhi" not in version.lower():
        raise OSError("复位后 RingHi 固件版本未确认")
    return version


def enter_download(resolve, imei, cancel, status):
    status("切换 ML307 下载模式")
    with open_ready(lambda: resolve("runtime"), cancel, status) as wire:
        current, _ = identity(wire, cancel)
        if current != imei:
            raise OSError("下载前 IMEI 改变，已停止")
        at(wire, "AT^AUTODL", cancel, timeout=3, disconnect_ok=True)
    # Wait for actual driver readiness; do not reopen the disappearing old COM.
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        cancel.check()
        try:
            resolve("download")
            break
        except NotReady:
            cancel.sleep(0.2)
    else:
        # Some factory firmware ACKs AUTODL but stays in runtime until reset.
        try:
            with open_ready(
                lambda: resolve("runtime"), cancel, status, timeout=3
            ) as wire:
                current, _ = identity(wire, cancel)
                if current != imei:
                    raise OSError("复位前 IMEI 改变")
                at(wire, "AT^RESET=normal", cancel, timeout=3, disconnect_ok=True)
        except NotReady:
            pass


def resume_activation(board, cfg, resolve, account, prepared, prior):
    cancel = board.cancel
    status = lambda text: board.update(mlState=text)
    ledger = read_json(storage.ROOT / "activation" / (prior["uid"] + ".json"), {})
    if (
        prior.get("phase") != "activating"
        or not retryable_activation(ledger)
        or ledger.get("session") != prior.get("backup")
        or ledger.get("project_id") != account.project
        or prior.get("mac") != board.mac
        or prior.get("firmwareSha256") != cfg.package.digest
    ):
        raise OSError("不能确认上次激活请求未发出，未重复领取")
    original_backups(prior, cfg.package)
    # Confirm network readiness before switching a successfully written modem.
    account.choose_route(cancel, status)
    board.update(
        imei=prior["imei"],
        backup=prior["backup"],
        mlProgress=92,
        mlState="恢复未发出的激活请求 · 保留已写固件和原备份",
    )
    enter_download(resolve, prior["imei"], cancel, status)
    with open_ready(lambda: resolve("download"), cancel, status) as wire:
        dl = Download(wire, cancel)
        dl.bootstrap(cfg.package)  # RAM loaders only; no erase/partition writes.
        _, raw = dl.send(18, struct.pack("<I", 0), accepted=(0x83,))
        check_uid(prior["uid"], raw.hex())
        try:
            activate(
                dl,
                prior["uid"],
                Path(prior["backup"]),
                account,
                prepared,
                cancel,
                status,
            )
        finally:
            if not dl.broken and not cancel.event.is_set():
                dl.reset()
    prior.update(phase="awaiting-verification")
    save_json(Path(prior["backup"]) / "session.json", prior)
    save_json(storage.ROOT / "ml-intents" / (prior["imei"] + ".json"), prior)
    version = verify_runtime(resolve, prior["imei"], cancel, status)
    prior.update(phase="verified", versionAfter=version, verifiedAt=now())
    save_json(Path(prior["backup"]) / "session.json", prior)
    save_json(storage.ROOT / "ml-intents" / (prior["imei"] + ".json"), prior)
    board.update(mlProgress=100, mlState="激活恢复与启动身份确认完成 · 未重烧固件")


def preflight(board, cfg, resolve):
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
        elif not no_flash_written(prior) and prior.get("phase") != "verified":
            raise OSError("下载中断阶段需核对原记录，未开始双芯写入")
        if prior.get("uid"):
            ledger = read_json(
                storage.ROOT / "activation" / (prior["uid"] + ".json"), {}
            )
            if ledger and ledger.get("stage") != "complete":
                raise OSError("上次授权请求未确认，未开始双芯写入")
        board.update(imei=prior["imei"], mlState="原恢复记录已核对")
        return
    with open_ready(lambda: resolve("runtime"), board.cancel, timeout=20) as wire:
        imei, version = identity(wire, board.cancel, boot_wait=12)
    prior = read_json(storage.ROOT / "ml-intents" / (imei + ".json"), {})
    if (
        prior
        and prior.get("phase")
        not in ("verified", "awaiting-verification", "activating")
        and not no_flash_written(prior)
    ):
        raise OSError("ML307 存在中断写入，请从下载模式使用原备份恢复；未开始双芯写入")
    if prior.get("phase") in ("activating", "awaiting-verification"):
        ledger = read_json(
            storage.ROOT / "activation" / (prior.get("uid", "") + ".json"), {}
        )
        if (
            ledger.get("stage") != "complete"
            and not (
                prior.get("phase") == "activating" and retryable_activation(ledger)
            )
        ) or ledger.get("session") != prior.get("backup"):
            raise OSError("上次授权结果未确认，未开始双芯写入")
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
            imei, version = identity(wire, cancel, boot_wait=12)
        prior = read_json(storage.ROOT / "ml-intents" / (imei + ".json"), {})
        # A completed write may merely have raced boot-time identity availability.
        if prior.get("phase") in ("awaiting-verification", "activating"):
            ledger = read_json(
                storage.ROOT / "activation" / (prior.get("uid", "") + ".json"), {}
            )
            if prior.get("phase") == "activating" and retryable_activation(ledger):
                resume_activation(board, cfg, resolve, account, prepared, prior)
                return
            if (
                prior.get("mac") != board.mac
                or prior.get("firmwareSha256") != pkg.digest
                or ledger.get("stage") != "complete"
                or ledger.get("session") != prior.get("backup")
            ):
                raise OSError("上次授权或写入结果待核对，未重复领取激活码")
            version = verify_runtime(resolve, imei, cancel, status)
            prior.update(phase="verified", versionAfter=version, verifiedAt=now())
            save_json(Path(prior["backup"]) / "session.json", prior)
            save_json(storage.ROOT / "ml-intents" / (imei + ".json"), prior)
            board.update(imei=imei, backup=prior["backup"])
            progress(100, "上次写入、激活和本次重启身份已确认")
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

    if already_download and prior.get("uid") and not recovery:
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

    with open_ready(lambda: resolve("download"), cancel, status) as wire:
        dl = Download(wire, cancel, advance)
        status("连接官方 ROM 下载器")
        dl.bootstrap(pkg)
        _, raw_uid = dl.send(18, struct.pack("<I", 0), accepted=(0x83,))
        uid = raw_uid.hex()
        if not re.fullmatch(r"[a-f0-9]{16,128}", uid):
            raise OSError("芯片 UID 无效")
        if prior and prior.get("uid"):
            check_uid(prior["uid"], uid)
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
        dl.reset()
        state["phase"] = "awaiting-verification"
        save()
    progress(98, "已激活 · 等待启动身份核验")
    state["versionAfter"] = verify_runtime(resolve, imei, cancel, status)
    state["phase"] = "verified"
    state["verifiedAt"] = now()
    save()
    progress(100, "写入、原始数据、自动激活与重启身份通过")
