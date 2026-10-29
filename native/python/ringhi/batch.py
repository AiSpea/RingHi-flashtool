from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
from pathlib import Path
import copy, threading, time, uuid
from . import storage, ports, esp, modem, production, __version__
from .storage import Cancel, Cancelled, atomic, save_json, csv_bytes, now
from .network import wait_network
from .product import SIM_ESIM, PRODUCTS, validate


@dataclass
class Config:
    esp_path: Path
    ml_path: Path
    backup: Path
    mode: str = "dual"
    production: bool = True
    limit: int = 2
    image: bytes = b""
    package: object = None
    product_type: str = SIM_ESIM


class Board:
    def __init__(self, number, hub, port_list):
        self.id = uuid.uuid4().hex
        self.number = number
        self.hub = hub
        self.hub_node = port_list[0].hub_node
        self.esp_chip = None
        self.ml_chip = None
        self.cancel = Cancel()
        self.lock = threading.RLock()
        self.worker = None
        self.events = []
        self.state = dict(
            id=self.id,
            task=number,
            hub=hub,
            mac="",
            imei="",
            connected=True,
            startedAt=now(),
            endedAt="",
            espFirmware="",
            mlFirmware="",
            espProgress=0,
            mlProgress=0,
            espState="等待识别",
            mlState="等待识别",
            production="未执行",
            cloud="未登记",
            result="等待配对",
            reason="",
            backup="",
            runId="",
            ports="",
        )

    def update(self, **values):
        with self.lock:
            self.state.update(values)

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.state)

    @property
    def mac(self):
        return self.snapshot()["mac"]

    @property
    def done(self):
        return bool(self.snapshot()["endedAt"])

    def finish(self, result, reason):
        self.update(result=result, reason=reason, endedAt=now())


class Batch:
    """One connection generation per row. A disconnected worker keeps its hub lease until fully closed."""

    def __init__(self, cfg, account, prepared, csv, scanner=ports.scan, execute=None):
        if cfg.mode != "esp" and not prepared:
            raise ValueError("请先准备本批次授权")
        validate(cfg.product_type)
        self.cfg = copy.copy(cfg)
        self.account = account
        self.prepared = prepared
        self.csv = Path(csv)
        self.scanner = scanner
        self.execute = execute
        self.lock = threading.RLock()
        self.save_lock = threading.Lock()
        self.scan_lock = threading.RLock()
        self.rows = []
        self.current = {}
        self.leases = {}
        self.ports = []
        self.hubs = set()
        self.accepting = True
        self.error = ""
        self.stop_event = threading.Event()
        self.sequence = 0
        self.pool = ThreadPoolExecutor(
            max_workers=max(1, cfg.limit), thread_name_prefix="RingHi-board"
        )
        self.threads = []
        self.folder = (
            storage.ROOT
            / "batches"
            / (time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex)
        )
        self.folder.mkdir(parents=True)
        save_json(
            self.folder / "batch.json",
            {
                "productType": cfg.product_type,
                "mode": cfg.mode,
                "production": cfg.production,
                "projectId": account.project,
                "espFirmware": str(cfg.esp_path),
                "mlFirmware": str(cfg.ml_path),
                "version": __version__,
            },
        )
        if cfg.image:
            self.esp_file = self.folder / "esp32.bin"
            storage.verified(self.esp_file, cfg.image)
        else:
            self.esp_file = cfg.esp_path
        self.save()
        self.thread = None

    def start(self):
        self.thread = threading.Thread(
            target=self._scan_loop, name="RingHi-scan", daemon=True
        )
        self.thread.start()

    def _scan_loop(self):
        while not self.stop_event.is_set():
            try:
                self.refresh_ports()
                self.save()
            except Exception as e:
                with self.lock:
                    self.error = "扫描或 CSV 保存失败：" + str(e)
                    self.accepting = False
            self.stop_event.wait(0.7)

    def refresh_ports(self):
        # Serialize scans so an older periodic snapshot cannot overwrite the
        # fresh topology obtained by a recovering chip worker.
        with self.scan_lock:
            found, hubs = self.scanner()
            self.observe(found, hubs)

    def observe(self, found, hubs):
        with self.lock:
            self.ports = found
            self.hubs = hubs
            for hub, b in list(self.current.items()):
                node = next((p.hub_node for p in found if p.hub == hub), None)
                if hub not in hubs or node is not None and node != b.hub_node:
                    self._remove(hub)
            if not self.accepting:
                return
            for hub in dict.fromkeys(
                p.hub for p in found if p.mode not in ("aux", "other")
            ):
                group = [p for p in found if p.hub == hub]
                b = self.current.get(hub)
                if b is None:
                    self.sequence += 1
                    b = Board(self.sequence, hub, group)
                    b.update(
                        productType=self.cfg.product_type,
                        productName=PRODUCTS[self.cfg.product_type],
                        espFirmware=self.cfg.esp_path.name,
                        mlFirmware=self.cfg.ml_path.name,
                    )
                    self.rows.append(b)
                    self.current[hub] = b
                if b.worker is not None or b.done:
                    continue
                esp_ports = [p for p in group if p.mode == "esp"]
                ml_ports = [
                    p for p in group if p.mode in ("runtime", "download", "generic")
                ]
                b.update(ports=" + ".join(p.path for p in esp_ports + ml_ports))
                if (
                    self.cfg.mode != "ml"
                    and len(esp_ports) != 1
                    or self.cfg.mode != "esp"
                    and len(ml_ports) != 1
                ):
                    b.update(
                        result="等待配对",
                        reason="同一板载 Hub 下需要唯一 ESP32 和 ML307；当前接口缺失或不唯一",
                    )
                    continue
                if self.cfg.mode != "esp" and ml_ports[0].mode == "generic":
                    b.update(
                        result="需要恢复",
                        mlState="GENERIC COM 异常模式",
                        reason="请将本板完全断电后重插；原备份保留，未开始写入",
                    )
                    continue
                b.esp_chip = esp_ports[0].chip if esp_ports else None
                b.ml_chip = ml_ports[0].chip if ml_ports else None
                b.update(result="排队", reason="等待空闲烧录通道")
                b.worker = self.pool.submit(self._run, b)

    def _remove(self, hub):
        b = self.current.pop(hub)
        b.update(connected=False)
        b.cancel.cancel()
        if b.worker is None:
            b.finish("未开始", "设备已拔出，未写入")

    def resolve(self, b, mode):
        b.cancel.check()
        with self.lock:
            if self.current.get(b.hub) is not b or not b.state["connected"]:
                raise Cancelled("原设备连接已变化")
        # Both chips re-enumerate. Refresh the same physical chip before open.
        self.refresh_ports()
        b.cancel.check()
        with self.lock:
            if self.current.get(b.hub) is not b or not b.state["connected"]:
                raise Cancelled("原设备连接已变化")
            return ports.select(
                self.ports, b.hub, b.esp_chip if mode == "esp" else b.ml_chip, mode
            )

    def _run(self, b):
        with self.lock:
            lease = self.leases.setdefault(b.hub, threading.Lock())
        acquired = False
        try:
            while not acquired:
                b.cancel.check()
                acquired = lease.acquire(timeout=0.1)
            b.cancel.check()
            with self.lock:
                if not self.accepting:
                    raise Cancelled("已暂停接收，尚未开始写入")
            b.update(result="身份检查", reason="核对同一板载 Hub 与设备身份")
            if self.execute:
                self.execute(b, self.resolve)
            else:
                self._hardware(b)
            b.cancel.check()
            b.finish(
                "成功",
                "双芯、自动激活、产测及云端确认完成"
                if self.cfg.production
                else "所选芯片烧录完成；未启用产测",
            )
        except Cancelled as e:
            b.finish("已中断", str(e) + "；重新插入可新建任务")
        except Exception as e:
            b.finish("失败", str(e))
        finally:
            if acquired:
                lease.release()
            try:
                self.save()
            except OSError as e:
                with self.lock:
                    self.error = "CSV 保存失败：" + str(e)
                    self.accepting = False

    def _hardware(self, b):
        cfg = self.cfg
        c = b.cancel
        if cfg.mode != "ml":
            b.update(espState="读取 MAC 与 Flash 容量")
            mac = esp.identify(
                lambda: self.resolve(b, "esp"),
                c,
                lambda text: b.update(espState=text),
            )
            b.update(mac=mac, espState="MAC 已确认")
        if cfg.mode != "esp":
            modem.preflight(b, cfg, lambda mode: self.resolve(b, mode), self.account.project)
            try:
                b.update(result="等待授权", reason="芯片身份已确认，检查本批次授权")
                wait_network(
                    lambda: self.account.ensure_authorized(
                        c, lambda s: b.update(mlState=s)
                    ),
                    c,
                    lambda s: b.update(mlState=s, reason=s),
                    query=True,
                )
            finally:
                self.account.close_current()
        b.update(result="烧录中", reason="两颗芯片独立执行，完成后统一产测")

        def esp_task():
            try:
                with (self.folder / ("esp-" + b.id + ".log")).open(
                    "a", encoding="utf-8"
                ) as log:
                    esp.flash(
                        lambda: self.resolve(b, "esp"),
                        self.esp_file,
                        cfg.image,
                        b.mac,
                        c,
                        lambda n, s: b.update(espProgress=n, espState=s),
                        lambda s: log.write(now() + " " + s + "\n"),
                    )
            except Exception as e:
                b.update(espState="失败：" + str(e))
                raise

        def ml_task():
            try:
                modem.run(
                    b,
                    cfg,
                    lambda mode: self.resolve(b, mode),
                    self.account,
                    self.prepared,
                )
            except Exception as e:
                b.update(mlState="失败：" + str(e))
                raise

        # Separate per-chip workers. Neither waits for the other chip's write/activation.
        with ThreadPoolExecutor(
            max_workers=2, thread_name_prefix="RingHi-chip"
        ) as pool:
            jobs = []
            if cfg.mode != "ml":
                jobs.append(pool.submit(esp_task))
            if cfg.mode != "esp":
                jobs.append(pool.submit(ml_task))
            wait(jobs)
            errors = [j.exception() for j in jobs if j.exception()]
            c.check()
            if errors:
                raise errors[0]
        if cfg.mode != "ml":
            b.update(result="复位中", reason="写入与激活完成，复位 ESP32")
            esp.reset(lambda: self.resolve(b, "esp"), c, expected=b.mac)
        if cfg.production:
            b.update(result="产测中", reason="等待设备启动")

            def changed(r):
                b.update(
                    production=r.reason,
                    cardCheck=r.card,
                    deviceStage=r.raw_stage,
                    deviceSim=r.raw_sim,
                    cloud="登记和报告上传成功"
                    if r.ready
                    else "已登记 · 等待报告上传"
                    if r.cloud
                    else "等待登记",
                    runId=r.run_id,
                    result="收尾中" if r.ready else "产测中",
                    reason=r.reason,
                )

            r = production.run(lambda: self.resolve(b, "esp"), c, changed, cfg.product_type)
            if not r.ready:
                raise OSError(r.reason)

    def snapshots(self):
        with self.lock:
            return [b.snapshot() for b in self.rows]

    @property
    def busy(self):
        with self.lock:
            return any(b.worker is not None and not b.worker.done() for b in self.rows)

    def pause(self):
        with self.lock:
            self.accepting = False
            for b in self.rows:
                if b.state["result"] == "排队" and not b.done:
                    b.cancel.cancel()

    def resume(self):
        with self.lock:
            if self.error:
                raise OSError("请先解决错误：" + self.error)
            for b in self.current.values():
                if (
                    b.done
                    and b.state["espProgress"] == 0
                    and b.state["mlProgress"] == 0
                    and b.state["result"] in ("未开始", "已中断")
                    and (b.worker is None or b.worker.done())
                ):
                    b.cancel = Cancel()
                    b.worker = None
                    b.update(endedAt="", result="等待配对", reason="")
            self.accepting = True

    def save(self):
        with self.save_lock:
            rows = self.snapshots()
            save_json(self.folder / "records.json", rows)
            atomic(self.csv, csv_bytes(rows))

    def export(self, path):
        atomic(Path(path), csv_bytes(self.snapshots()))

    def close(self):
        with self.lock:
            self.accepting = False
            self.stop_event.set()
            for b in self.rows:
                if not b.done:
                    b.cancel.cancel()
        if self.thread:
            self.thread.join(timeout=5)
        self.pool.shutdown(wait=True, cancel_futures=False)
        for b in self.rows:
            if not b.done:
                b.finish("未开始", "批次已关闭，未开始写入")
        self.save()
        if self.prepared:
            self.prepared.close()
        if hasattr(self.account, "close"):
            self.account.close()
