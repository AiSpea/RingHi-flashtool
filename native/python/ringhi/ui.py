from __future__ import annotations
import json, threading, time, uuid
from pathlib import Path
from PySide6.QtCore import QTimer, Signal, QObject, QSize, Qt, QRect
from PySide6.QtGui import QIcon, QDesktopServices, QPainter, QPalette, QColor
from PySide6.QtCore import QUrl
from PySide6.QtWidgets import (
    QMainWindow,
    QWidget,
    QHBoxLayout,
    QVBoxLayout,
    QLabel,
    QPushButton,
    QLineEdit,
    QComboBox,
    QCheckBox,
    QFileDialog,
    QMessageBox,
    QTableWidget,
    QTableWidgetItem,
    QHeaderView,
    QStyledItemDelegate,
    QApplication,
    QStyle,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QTextEdit,
    QStackedWidget,
    QScrollArea,
    QFrame,
    QSizePolicy,
)
from . import __version__, storage, ports, updates
from .storage import Cancel, read_json, save_json
from .account import Account, Prepared, load_credentials, save_credentials, validate
from .package import Package
from .batch import Batch, Config
from .product import PRODUCTS, SIM_ESIM
from .esp import resource, validate_image, preflight

STYLE = """
QWidget { font-family: "Microsoft YaHei UI", "Segoe UI"; font-size: 14px; color: #243c45; }
QMainWindow, #body, #batchPage, QScrollArea { background: #f4f7f8; }
QLabel { background: transparent; }
#sidebar { background: #123334; border: 0; }
#sidebar QLabel { color: #b8d1cd; }
#brand { color: #ffffff; font-size: 29px; font-weight: 700; }
#sidebar QPushButton { background: transparent; color: #c4d9d5; border: 0; text-align: left; padding: 14px 12px; font-size: 15px; }
#sidebar QPushButton:checked { background: #2b504e; color: #ffffff; border-radius: 9px; }
#sidebar QPushButton:hover { background: #234643; }
#title { font-size: 28px; font-weight: 700; color: #192f38; }
#subtitle, #muted { color: #617782; }
#sectionTitle { font-size: 17px; font-weight: 600; }
#card { background: white; border: 1px solid #e1e9ec; border-radius: 12px; }
#cardTitle { font-size: 17px; font-weight: 600; }
#metricValue { font-size: 27px; font-weight: 600; }
#metricLabel { color: #617782; font-size: 13px; }
#badge { background: #edf5f2; color: #38665b; border-radius: 10px; padding: 5px 12px; font-size: 12px; }
#line { background: #eaf0f2; max-height: 1px; border: 0; }
QPushButton { background: white; border: 1px solid #d6e1e4; border-radius: 7px; padding: 10px 16px; min-height: 22px; font-weight: 600; }
QPushButton:hover { background: #edf6f2; border-color: #98c2b6; }
QPushButton:disabled { color: #8b9fa6; background: #f6f8f9; border-color: #e7edef; }
QPushButton#primary { background: #087d68; color: white; border-color: #087d68; }
QPushButton#primary:hover { background: #066c5a; }
QPushButton#primary:disabled { background: #a3c7bd; border-color: #a3c7bd; }
QPushButton#sectionToggle { background: transparent; border: 0; padding: 8px 0; text-align: left; font-size: 17px; }
QPushButton#detail { background: #f5f8f9; border: 0; padding: 7px 12px; font-size: 13px; }
QLineEdit, QComboBox { background: white; border: 1px solid #d6e1e5; border-radius: 7px; padding: 10px; min-height: 22px; }
QComboBox::drop-down { border: 0; width: 28px; }
QCheckBox { spacing: 10px; }
QCheckBox::indicator { width: 18px; height: 18px; }
QTableWidget { background: white; alternate-background-color: #fafcfc; border: 0; gridline-color: #ecf1f3; selection-background-color: #edf6f2; selection-color: #143a35; }
QHeaderView::section { background: #f4f7f8; color: #617782; border: 0; padding: 13px 8px; font-size: 13px; font-weight: 500; }
QProgressBar { border: 0; border-radius: 3px; background: #e8efef; height: 6px; max-height: 6px; }
QProgressBar::chunk { background: #118b76; border-radius: 3px; }
QLabel#notice { background: #edf5f2; color: #365f55; border-radius: 7px; padding: 12px 16px; }
QTextEdit { border: 1px solid #dce5e9; border-radius: 8px; padding: 12px; }
"""


class NoWheelComboBox(QComboBox):
    """Leave page scrolling to the parent; selection requires deliberate input."""

    def wheelEvent(self, event):
        event.ignore()


class ElidedLabel(QLabel):
    """One-line summary; complete text remains available as a tooltip."""

    def __init__(self, text=""):
        super().__init__(text)
        self.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)
        self.setMinimumWidth(0)
        self.setMinimumHeight(22)
        self.setToolTip(text)

    def setText(self, text):
        super().setText(text)
        self.setToolTip(text)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setPen(self.palette().color(QPalette.WindowText))
        text = self.fontMetrics().elidedText(self.text(), Qt.ElideMiddle, self.width())
        painter.drawText(self.rect(), Qt.AlignVCenter | Qt.AlignLeft, text)


class DeviceDelegate(QStyledItemDelegate):
    """Paint lightweight cells; progress updates never rebuild child widgets."""

    def __init__(self, parent):
        super().__init__(parent)
        self.icons = {
            name: QIcon(str(resource("assets/" + name + ".svg")))
            for name in ("check", "error", "clock")
        }

    def paint(self, painter, option, index):
        row = index.data(Qt.UserRole)
        if row is None:
            return super().paint(painter, option, index)
        painter.save()
        painter.setClipRect(option.rect)
        painter.fillRect(
            option.rect,
            QColor(
                "#edf6f2"
                if option.state & QStyle.State_Selected
                else "#fafcfc"
                if index.row() % 2
                else "#ffffff"
            ),
        )
        rect = option.rect.adjusted(10, 14, -10, -12)

        def text(value, y, color="#243c45", bold=False, size=13, inset=0):
            font = option.font
            font.setPixelSize(size)
            font.setBold(bold)
            painter.setFont(font)
            painter.setPen(QColor(color))
            line = QRect(
                rect.x() + inset, rect.y() + y, max(0, rect.width() - inset), 24
            )
            painter.drawText(
                line,
                Qt.AlignLeft | Qt.AlignVCenter,
                painter.fontMetrics().elidedText(
                    str(value), Qt.ElideRight, line.width()
                ),
            )

        col = index.column()
        if col == 0:
            text("#" + str(row["task"]), 26, size=12)
        elif col == 1:
            text(row.get("mac") or "待读取 MAC", 0, bold=True)
            text(row.get("ports", ""), 28, "#617782", size=12)
            if row.get("imei"):
                text("IMEI " + row["imei"], 52, "#617782", size=12)
        elif col in (2, 3):
            chip = "esp" if col == 2 else "ml"
            value = row.get(chip + "Progress", 0)
            state = row.get(chip + "State", "")
            color = "#b7422f" if state.startswith("失败") else "#118b76"
            text(str(value) + "%", 0, bold=True)
            painter.setPen(Qt.NoPen)
            painter.setBrush(QColor("#e8efef"))
            bar = QRect(rect.x(), rect.y() + 32, rect.width(), 6)
            painter.drawRoundedRect(bar, 3, 3)
            painter.setBrush(QColor(color))
            bar.setWidth(int(bar.width() * max(0, min(value, 100)) / 100))
            painter.drawRoundedRect(bar, 3, 3)
            text(
                state, 46, "#b7422f" if state.startswith("失败") else "#617782", size=12
            )
        elif col == 4:
            text("产测 · " + row.get("production", ""), 0, size=12)
            text("云端 · " + row.get("cloud", ""), 30, size=12)
        elif col == 5:
            result = row.get("result", "")
            failed = result in ("失败", "已中断", "需要恢复")
            icon = "check" if result == "成功" else "error" if failed else "clock"
            self.icons[icon].paint(painter, QRect(rect.x(), rect.y() + 3, 16, 16))
            text(
                result,
                0,
                "#087d68" if result == "成功" else "#b7422f" if failed else "#284a54",
                True,
                12,
                21,
            )
            text(row.get("reason", ""), 30, "#617782", size=12)
        else:
            painter.setPen(Qt.NoPen)
            painter.setBrush(QColor("#edf4f2"))
            painter.drawRoundedRect(
                QRect(rect.x() - 4, rect.y() + 21, rect.width() + 8, 34), 6, 6
            )
            text("详情", 26, bold=True, size=12)
        painter.restore()


class DeviceTable(QTableWidget):
    """All rows and columns belong to the outer page, without nested scrolling."""

    def __init__(self, active):
        super().__init__(0, 7)
        self.active = active
        self.rows = []
        self.signatures = []
        self.empty = QLabel(
            "暂无接入设备" if active else "暂无拔出记录", self.viewport()
        )
        self.empty.setObjectName("muted")
        self.empty.setAlignment(Qt.AlignCenter)
        self.badge = None
        self.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.setItemDelegate(DeviceDelegate(self))
        self.verticalHeader().setDefaultSectionSize(112)
        self.horizontalHeader().setFixedHeight(48)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        # Keep all seven columns in view, including results and details at 1080px.
        base = [42, 176, 110, 110, 112, 116, 64]
        available = self.viewport().width()
        extra = max(0, available - sum(base))
        widths = [
            value + int(extra * weight)
            for value, weight in zip(base, (0, 0.25, 0.23, 0.23, 0.16, 0.13, 0))
        ]
        if available < sum(base):
            widths = [int(value * available / sum(base)) for value in base]
        widths[-1] += available - sum(widths)
        for i, width in enumerate(widths):
            if self.columnWidth(i) != width:
                self.setColumnWidth(i, width)
        self.empty.setGeometry(self.viewport().rect())

    def wheelEvent(self, event):
        parent = self.parentWidget()
        while parent and not isinstance(parent, QScrollArea):
            parent = parent.parentWidget()
        if parent:
            QApplication.sendEvent(parent.viewport(), event)
        else:
            event.ignore()

    def fit_rows(self, count):
        self.empty.setVisible(count == 0)
        self.badge.setText(f"{count} 台" if self.active else f"{count} 条")
        height = 48 + (count * 112 if count else 80) + 2 * self.frameWidth()
        if self.height() != height:
            self.setFixedHeight(height)
        self.empty.setGeometry(self.viewport().rect())


class Bus(QObject):
    done = Signal(str, object, object)
    notice = Signal(str)


class Window(QMainWindow):
    def __init__(self, test=False):
        super().__init__()
        self.test = test
        self.setWindowTitle("RingHi")
        self.setMinimumSize(1080, 720)
        self.resize(1440, 940)
        self.setWindowIcon(QIcon(str(resource("assets/app.ico"))))
        self.account = Account()
        self.batch = None
        self.preparing = None
        self.closing = False
        self.allow_close = False
        self.jobs = {}
        self.passive = []
        self.scanning = False
        self.prepared_cfg = None
        self.update_info = None
        self.update_stage = None
        self.updating = False
        self.bus = Bus()
        self.bus.done.connect(self.job_done)
        self.bus.notice.connect(self.set_notice)
        self.settings = read_json(storage.ROOT / "settings.json", {}) or {}
        self.csv_dir = self.settings.get("csvDirectory", str(Path.home() / "Documents"))
        self.make_ui()
        self.load_settings()
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.tick)
        self.timer.start(350)
        self.ticks = 0
        if not test:
            QTimer.singleShot(100, self.auto_login)
            QTimer.singleShot(1800, self.check_updates)

    def background(self, fn, success=lambda result: None, failure=None):
        ident = uuid.uuid4().hex
        self.jobs[ident] = (success, failure or self.error)

        def run():
            try:
                self.bus.done.emit(ident, fn(), None)
            except Exception as e:
                self.bus.done.emit(ident, None, e)

        threading.Thread(target=run, daemon=True).start()
        return ident

    def job_done(self, ident, value, error):
        pair = self.jobs.pop(ident, None)
        if pair:
            if error:
                pair[1](error)
            else:
                pair[0](value)

    def set_notice(self, text):
        self.notice.setText(text)

    def error(self, e):
        self.set_notice(str(e))

    def button(self, text, callback, primary=False):
        b = QPushButton(text)
        b.clicked.connect(callback)
        if primary:
            b.setObjectName("primary")
        return b

    def make_ui(self):
        body = QWidget()
        body.setObjectName("body")
        self.setCentralWidget(body)
        root = QHBoxLayout(body)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        side = QFrame()
        side.setObjectName("sidebar")
        side.setFixedWidth(204)
        sl = QVBoxLayout(side)
        sl.setContentsMargins(20, 32, 20, 24)
        sl.setSpacing(10)
        logo = QLabel()
        logo.setPixmap(QIcon(str(resource("assets/app.ico"))).pixmap(56, 56))
        sl.addWidget(logo)
        brand = QLabel("RingHi")
        brand.setObjectName("brand")
        sl.addWidget(brand)
        sl.addWidget(QLabel("设备工作台"))
        sl.addSpacing(36)
        self.pages = QStackedWidget()
        self.nav = []
        for i, name in enumerate(["批量烧录", "生产记录", "说明与更新"]):
            b = self.button(name, lambda checked=False, n=i: self.navigate(n))
            b.setIcon(
                QIcon(
                    str(resource("assets/" + ("batch", "records", "info")[i] + ".svg"))
                )
            )
            b.setIconSize(QSize(22, 22))
            b.setCheckable(True)
            self.nav.append(b)
            sl.addWidget(b)
        sl.addStretch()
        self.update_button = self.button("检查更新", self.update_clicked)
        self.update_button.setToolTip("自动检查更新；有新版时在这里提示")
        sl.addWidget(self.update_button)
        sl.addWidget(QLabel("●  本地运行"))
        sl.addWidget(QLabel("Windows · v" + __version__))
        root.addWidget(side)
        root.addWidget(self.pages, 1)
        page = QWidget()
        page.setObjectName("batchPage")
        layout = QVBoxLayout(page)
        layout.setContentsMargins(32, 28, 32, 28)
        layout.setSpacing(24)
        heading = QVBoxLayout()
        heading.setSpacing(8)
        title = QLabel("批量烧录")
        title.setObjectName("title")
        heading.addWidget(title)
        sub = QLabel("配置一次，插入即烧录。每块板独立显示双芯进度和整板结果。")
        sub.setWordWrap(True)
        sub.setObjectName("subtitle")
        heading.addWidget(sub)
        layout.addLayout(heading)

        batch_card, batch_layout = self.card()
        toolbar = QHBoxLayout()
        toolbar.setSpacing(12)
        self.counts = QLabel("准备新批次")
        self.counts.setObjectName("cardTitle")
        toolbar.addWidget(self.counts, 1)
        self.pause_button = self.button("暂停接收", self.pause)
        self.resume_button = self.button("继续接收", self.resume)
        self.start_button = self.button("开启新批次", self.start_batch, True)
        for button in (self.pause_button, self.resume_button, self.start_button):
            toolbar.addWidget(button)
        batch_layout.addLayout(toolbar)
        metrics = QHBoxLayout()
        self.metric_values = []
        for label, color in (
            ("本批次任务", "#243c45"),
            ("进行中", "#243c45"),
            ("已成功", "#087d68"),
            ("待处理", "#b7422f"),
        ):
            group = QVBoxLayout()
            group.setSpacing(4)
            value = QLabel("0")
            value.setObjectName("metricValue")
            value.setStyleSheet("color:" + color)
            caption = QLabel(label)
            caption.setObjectName("metricLabel")
            group.addWidget(value)
            group.addWidget(caption)
            metrics.addLayout(group, 1)
            self.metric_values.append(value)
        batch_layout.addLayout(metrics)
        self.notice = QLabel("选择固件和授权项目，开启批次后自动接收设备。")
        self.notice.setObjectName("notice")
        self.notice.setWordWrap(True)
        batch_layout.addWidget(self.notice)
        csv_row = QHBoxLayout()
        csv_row.setSpacing(20)
        csv_text = QVBoxLayout()
        csv_text.setSpacing(4)
        csv_text.addWidget(QLabel("本批次 CSV"))
        self.csv_label = ElidedLabel("开启批次时选择保存位置，过程自动保存")
        self.csv_label.setObjectName("muted")
        csv_text.addWidget(self.csv_label)
        csv_row.addLayout(csv_text, 1)
        self.export_button = self.button("导出 CSV", self.export)
        csv_row.addWidget(self.export_button)
        batch_layout.addLayout(csv_row)
        layout.addWidget(batch_card)

        config_section = QVBoxLayout()
        config_section.setSpacing(14)
        config_heading = QHBoxLayout()
        self.config_toggle = self.button("固件与接入配置", self.toggle_config)
        self.config_toggle.setObjectName("sectionToggle")
        self.config_toggle.setIcon(QIcon(str(resource("assets/down.svg"))))
        config_heading.addWidget(self.config_toggle)
        self.config_summary = ElidedLabel("左右选择双芯固件，下方设置本批次流程")
        self.config_summary.setObjectName("muted")
        config_heading.addWidget(self.config_summary, 1)
        config_section.addLayout(config_heading)
        self.config = QWidget()
        all_config = QVBoxLayout(self.config)
        all_config.setContentsMargins(0, 0, 0, 0)
        all_config.setSpacing(16)
        conf = QHBoxLayout()
        conf.setSpacing(20)
        ml_group, ml_layout = self.card()
        self.card_heading(ml_layout, "ML307H", "固件、备份与官方授权", "自动激活")
        self.ml_edit = self.file_row(ml_layout, "固件包 · PKG", "*.pkg")
        self.backup_edit = self.file_row(ml_layout, "设备备份目录", directory=True)
        account_row = QHBoxLayout()
        self.account_label = QLabel("未登录官方授权账号")
        self.account_label.setWordWrap(True)
        account_row.addWidget(self.account_label, 1)
        self.login_button = self.button("登录", self.login_dialog)
        account_row.addWidget(self.login_button)
        ml_layout.addLayout(account_row)
        self.projects = NoWheelComboBox()
        self.projects.setPlaceholderText("选择官方授权项目")
        self.projects.currentIndexChanged.connect(self.select_project)
        ml_layout.addWidget(self.projects)
        tag = QLabel("烧录后自动激活；每块板独立保留校准与工厂数据。")
        tag.setWordWrap(True)
        tag.setObjectName("muted")
        ml_layout.addWidget(tag)
        esp_group, el = self.card()
        self.card_heading(el, "ESP32-S3", "固件与写入校验", "MD5 校验")
        self.esp_edit = self.file_row(el, "完整固件 · BIN", "*.bin")
        for title, description in (
            ("完整镜像", "16 MB · 从地址 0x0 写入"),
            ("写入后校验", "使用官方 esptool，校验完成后进入后续流程。"),
        ):
            notes = QVBoxLayout()
            notes.setSpacing(6)
            notes.addWidget(QLabel(title))
            caption = QLabel(description)
            caption.setWordWrap(True)
            caption.setObjectName("muted")
            notes.addWidget(caption)
            el.addLayout(notes)
        el.addStretch()
        conf.addWidget(ml_group, 1)
        conf.addWidget(esp_group, 1)
        all_config.addLayout(conf)
        options, options_layout = self.card()
        options_layout.addWidget(QLabel("产品类型（切换后对新批次生效）"))
        self.product_type = NoWheelComboBox()
        for code, label in PRODUCTS.items():
            self.product_type.addItem(label, code)
        options_layout.addWidget(self.product_type)
        product_note = QLabel("SIM + eSIM：必须读到 eSIM EID。双 SIM：卡槽/eSIM 检查不参与判定；授权、云端登记和最终报告上传仍须通过。")
        product_note.setWordWrap(True)
        product_note.setObjectName("muted")
        options_layout.addWidget(product_note)
        option_row = QHBoxLayout()
        option_row.setSpacing(24)
        self.mode = NoWheelComboBox()
        self.mode.addItems(["双芯烧录", "仅 ESP32", "仅 ML307H"])
        self.limit = NoWheelComboBox()
        self.limit.addItems(["1", "2", "3", "4", "6", "8"])
        self.limit.setCurrentText("2")
        for label, field in (("烧录模式", self.mode), ("同时处理板数", self.limit)):
            group = QVBoxLayout()
            group.setSpacing(8)
            group.addWidget(QLabel(label))
            group.addWidget(field)
            option_row.addLayout(group, 1)
        self.production = QCheckBox("双芯完成后自动产测")
        self.production.setChecked(True)
        option_row.addWidget(self.production, 2, Qt.AlignBottom)
        options_layout.addLayout(option_row)
        note = QLabel(
            "开启产测时，写入校验、自动激活、产测、云端登记与最终报告上传全部完成，才显示整板成功。"
        )
        note.setWordWrap(True)
        note.setObjectName("muted")
        options_layout.addWidget(note)
        all_config.addWidget(options)
        config_section.addWidget(self.config)
        layout.addLayout(config_section)
        self.connected = self.table_section(layout, "当前接入设备", True)
        self.history = self.table_section(layout, "已拔出记录", False)
        self.scan_label = QLabel("正在扫描 USB 接口…")
        self.scan_label.setObjectName("subtitle")
        layout.addWidget(self.scan_label)
        layout.addStretch()
        self.batch_scroll = QScrollArea()
        self.batch_scroll.setWidgetResizable(True)
        self.batch_scroll.setFrameShape(QFrame.NoFrame)
        self.batch_scroll.setWidget(page)
        self.pages.addWidget(self.batch_scroll)
        record = QWidget()
        rl = QVBoxLayout(record)
        rl.setContentsMargins(30, 30, 30, 30)
        title = QLabel("生产记录")
        title.setObjectName("title")
        rl.addWidget(title)
        rl.addWidget(QLabel("包含原工具和 Python 版的历史批次，原始记录保留。"))
        buttons = QHBoxLayout()
        buttons.addWidget(self.button("刷新记录", self.refresh_records))
        buttons.addWidget(
            self.button(
                "打开记录文件夹",
                lambda: QDesktopServices.openUrl(
                    QUrl.fromLocalFile(str(storage.ROOT / "batches"))
                ),
            )
        )
        buttons.addStretch()
        rl.addLayout(buttons)
        self.records = QTableWidget(0, 4)
        self.records.setHorizontalHeaderLabels(["批次", "任务数", "成功", "记录文件"])
        self.records.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.records.setEditTriggers(QTableWidget.NoEditTriggers)
        rl.addWidget(self.records)
        self.pages.addWidget(record)
        about = QWidget()
        al = QVBoxLayout(about)
        al.setContentsMargins(34, 34, 34, 34)
        title = QLabel("说明与更新")
        title.setObjectName("title")
        al.addWidget(title)
        text = QLabel(
            "RingHi 设备工作台 v"
            + __version__
            + "\n\n1. 选择双芯固件、ML307 授权项目和备份目录。\n2. 开启新批次，选择本批次 CSV 文件。\n3. 插入板子后自动识别并执行；成功设备拔出后归档。\n4. 发生中断时保留原备份，重新插入后核对恢复条件。\n\nML307 默认自动激活。产测需要 AiSpea_Factory Wi-Fi。SIM + eSIM 产品要求读到 EID；双 SIM 产品不要求插卡或 eSIM。\nCSV 自动保存；关闭活动任务前会提示，可取消关闭。\n\n这是 Python + Qt 原生桌面应用，不包含浏览器内核。"
        )
        text.setWordWrap(True)
        text.setStyleSheet("line-height:1.6;font-size:16px;")
        al.addWidget(text)
        self.update_label = QLabel("自动检查公开发布的 Python 原生版更新。")
        self.update_label.setWordWrap(True)
        al.addWidget(self.update_label)
        al.addWidget(self.button("立即检查更新", self.check_updates))
        al.addWidget(
            self.button(
                "打开版本发布页面",
                lambda: QDesktopServices.openUrl(
                    QUrl("https://github.com/AiSpea/RingHi-flashtool/releases")
                ),
            )
        )
        al.addStretch()
        self.pages.addWidget(about)
        self.navigate(0)

    def card(self):
        frame = QFrame()
        frame.setObjectName("card")
        layout = QVBoxLayout(frame)
        layout.setContentsMargins(22, 22, 22, 22)
        layout.setSpacing(20)
        return frame, layout

    def card_heading(self, layout, title, subtitle, badge):
        row = QHBoxLayout()
        text = QVBoxLayout()
        text.setSpacing(6)
        heading = QLabel(title)
        heading.setObjectName("cardTitle")
        caption = QLabel(subtitle)
        caption.setObjectName("muted")
        text.addWidget(heading)
        text.addWidget(caption)
        row.addLayout(text, 1)
        tag = QLabel(badge)
        tag.setObjectName("badge")
        row.addWidget(tag, 0, Qt.AlignTop)
        layout.addLayout(row)

    def file_row(self, layout, label, pattern="", directory=False):
        field = QVBoxLayout()
        field.setSpacing(8)
        field.addWidget(QLabel(label))
        row = QHBoxLayout()
        row.setSpacing(10)
        edit = QLineEdit()
        edit.setPlaceholderText(label)
        row.addWidget(edit, 1)

        def choose():
            path = (
                QFileDialog.getExistingDirectory(self, label, edit.text())
                if directory
                else QFileDialog.getOpenFileName(
                    self, label, edit.text(), f"固件文件 ({pattern});;所有文件 (*)"
                )[0]
            )
            if path:
                edit.setText(path)

        row.addWidget(self.button("选择", choose))
        field.addLayout(row)
        layout.addLayout(field)
        edit.textChanged.connect(edit.setToolTip)
        return edit

    def table_section(self, layout, title, active):
        card, content = self.card()
        content.setSpacing(16)
        heading = QHBoxLayout()
        texts = QVBoxLayout()
        texts.setSpacing(6)
        header = QLabel(title)
        header.setObjectName("sectionTitle")
        texts.addWidget(header)
        hint = QLabel(
            "成功设备保留在此表，拔出后归档。"
            if active
            else "保留本批次每次烧录结果；重新插入会创建新任务。"
        )
        hint.setWordWrap(True)
        hint.setObjectName("muted")
        texts.addWidget(hint)
        heading.addLayout(texts, 1)
        badge = QLabel("0 台" if active else "0 条")
        badge.setObjectName("badge")
        heading.addWidget(badge, 0, Qt.AlignTop)
        content.addLayout(heading)
        table = DeviceTable(active)
        table.badge = badge
        table.setHorizontalHeaderLabels(
            [
                "任务",
                "ESP32 MAC / 设备",
                "ESP32 进度",
                "ML307H 进度",
                "产测 / 云端",
                "整板结果",
                "操作",
            ]
        )
        table.verticalHeader().hide()
        table.setEditTriggers(QTableWidget.NoEditTriggers)
        table.setSelectionBehavior(QTableWidget.SelectRows)
        table.setAlternatingRowColors(True)
        table.setShowGrid(False)
        table.setWordWrap(False)
        table.horizontalHeader().setSectionResizeMode(QHeaderView.Fixed)
        table.horizontalHeader().setMinimumSectionSize(40)
        table.fit_rows(0)

        def open_detail(row, col):
            if col == 6 and row < len(table.rows):
                self.detail(table.rows[row])

        table.cellClicked.connect(open_detail)
        table.cellActivated.connect(open_detail)
        content.addWidget(table)
        layout.addWidget(card)
        return table

    def navigate(self, n):
        self.pages.setCurrentIndex(n)
        for i, b in enumerate(self.nav):
            b.setChecked(i == n)
        if n == 1:
            self.refresh_records()

    def toggle_config(self):
        self.config.setVisible(not self.config.isVisible())
        self.config_toggle.setIcon(
            QIcon(
                str(
                    resource(
                        "assets/"
                        + ("down" if self.config.isVisible() else "right")
                        + ".svg"
                    )
                )
            )
        )

    def load_settings(self):
        s = self.settings
        self.esp_edit.setText(s.get("esp", ""))
        self.ml_edit.setText(s.get("ml", ""))
        self.backup_edit.setText(
            s.get("backup", str(Path.home() / "Documents" / "RingHi Backups"))
        )
        self.mode.setCurrentIndex(max(0, min(2, int(s.get("mode", 0)))))
        self.limit.setCurrentText(str(s.get("limit", 2)))
        self.production.setChecked(s.get("production", True))
        self.product_type.setCurrentIndex(max(0, self.product_type.findData(s.get("productType", SIM_ESIM))))

    def save_settings(self):
        save_json(
            storage.ROOT / "settings.json",
            dict(
                esp=self.esp_edit.text(),
                ml=self.ml_edit.text(),
                backup=self.backup_edit.text(),
                mode=self.mode.currentIndex(),
                limit=int(self.limit.currentText()),
                production=self.production.isChecked(),
                productType=self.product_type.currentData(),
                csvDirectory=self.csv_dir,
            ),
        )

    def auto_login(self):
        self.account_label.setText("连接官方授权服务…")
        self.login_button.setEnabled(False)

        def run():
            c = load_credentials()
            if c is None:
                return None
            a = Account()
            items = a.login(c)
            return a, items

        self.background(run, self.login_result, lambda e: self.login_failed(e))

    def login_result(self, result):
        self.login_button.setEnabled(True)
        if result is None:
            self.account_label.setText("未配置账号，请登录")
            return
        self.account, items = result
        self.account_label.setText("已登录：" + self.account.username)
        self.projects.blockSignals(True)
        self.projects.clear()
        self.projects.addItem("请选择授权项目", 0)
        for item in items:
            self.projects.addItem(
                f"{item.get('name', '')}（{item['project_id']}） · 剩余 {item.get('nonactivated_count', '—')}",
                int(item["project_id"]),
            )
        i = self.projects.findData(self.account.project)
        self.projects.setCurrentIndex(max(0, i))
        self.projects.blockSignals(False)

    def login_failed(self, e):
        self.login_button.setEnabled(True)
        self.account_label.setText("登录失败：" + str(e))

    def login_dialog(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("ML307 官方授权登录")
        dialog.resize(500, 320)
        form = QFormLayout(dialog)
        user = QLineEdit()
        password = QLineEdit()
        password.setEchoMode(QLineEdit.Password)
        pc = QLineEdit()
        pc.setEchoMode(QLineEdit.Password)
        form.addRow("账号", user)
        form.addRow("密码", password)
        form.addRow("PC 注册码", pc)
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        form.addRow(buttons)
        buttons.accepted.connect(dialog.accept)
        buttons.rejected.connect(dialog.reject)
        if dialog.exec() != QDialog.Accepted:
            return
        creds = {
            "username": user.text().strip(),
            "password": password.text(),
            "pccode": pc.text().strip(),
        }
        try:
            validate(creds)
        except Exception as e:
            self.error(e)
            return
        self.login_button.setEnabled(False)

        def run():
            a = Account()
            items = a.login(creds)
            save_credentials(creds)
            return a, items

        self.background(run, self.login_result, self.login_failed)

    def select_project(self):
        if self.projects.currentData():
            try:
                self.account.select(int(self.projects.currentData()))
            except Exception as e:
                self.error(e)

    def start_batch(self):
        if self.preparing or self.closing or self.updating:
            return
        if self.batch and (self.batch.busy or self.batch.accepting):
            self.error("请先暂停接收并等待任务完成")
            return
        cfg = Config(
            Path(self.esp_edit.text()),
            Path(self.ml_edit.text()),
            Path(self.backup_edit.text()),
            ["dual", "esp", "ml"][self.mode.currentIndex()],
            self.production.isChecked(),
            int(self.limit.currentText()),
            product_type=self.product_type.currentData(),
        )
        if cfg.production and cfg.mode != "dual":
            self.error("自动整板产测需要双芯模式；单芯烧录请取消产测")
            return
        self.preparing = Cancel()
        cancel = self.preparing
        self.config.setEnabled(False)
        path, _ = QFileDialog.getSaveFileName(
            self,
            "新建本批次 CSV，保存后开始",
            str(
                Path(self.csv_dir)
                / ("RingHi-" + time.strftime("%Y%m%d-%H%M%S") + ".csv")
            ),
            "CSV 文件 (*.csv)",
        )
        if not path:
            self.preparing = None
            self.config.setEnabled(True)
            self.set_notice("已取消新批次，未接收设备。")
            return
        path = str(Path(path).with_suffix(".csv")) if not Path(path).suffix else path
        account = self.account.snapshot()
        self.set_notice("正在新建并保存 CSV，保存成功后检查固件和授权…")

        def prepare():
            prepared = candidate = None
            try:
                cancel.check()
                storage.create_batch_csv(Path(path))
                self.bus.notice.emit("CSV 已保存，正在检查固件与准备批次授权…")
                cancel.check()
                if cfg.mode != "ml":
                    cfg.image = cfg.esp_path.read_bytes()
                    validate_image(cfg.image)
                    self.bus.notice.emit("正在自检 ESP32 官方工具（不访问设备）…")
                    preflight(cancel)
                if cfg.mode != "esp":
                    cfg.package = Package(cfg.ml_path.read_bytes())
                    cfg.backup.mkdir(parents=True, exist_ok=True)
                    probe = cfg.backup / (".probe-" + uuid.uuid4().hex)
                    storage.verified(probe, b"RingHi")
                    probe.unlink()
                    prepared = Prepared(account, cancel, self.bus.notice.emit)
                cancel.check()
                if self.batch:
                    self.batch.close()
                # Save initial records and firmware off the GUI thread, before scanning.
                candidate = Batch(cfg, account, prepared, path)
                cancel.check()
                return candidate
            except Exception:
                if candidate:
                    candidate.close()
                else:
                    if prepared:
                        prepared.close()
                    account.close()
                raise

        def ready(candidate):
            self.preparing = None
            if self.closing:
                self.background(candidate.close)
                return
            try:
                self.csv_dir = str(Path(path).parent)
                self.save_settings()
                self.batch = candidate
                self.batch.start()
                self.config.hide()
                self.config_toggle.setIcon(QIcon(str(resource("assets/right.svg"))))
                self.set_notice(
                    "CSV 已保存 · 批次已就绪。正在接收设备，请等待整板成功后再拔出。"
                )
            except Exception as e:
                self.background(candidate.close)
                self.error(e)

        def failed(e):
            self.preparing = None
            self.config.setEnabled(True)
            self.error("新批次未启动：" + str(e))

        self.background(prepare, ready, failed)

    def pause(self):
        if self.batch:
            self.batch.pause()
            self.set_notice("已暂停接收；正在执行的任务继续完成。可点击“继续接收”。")

    def resume(self):
        if self.updating or self.closing:
            return
        if self.batch:
            try:
                self.batch.resume()
                self.set_notice("已继续接收 · 插入设备自动执行")
            except Exception as e:
                self.error(e)

    def export(self):
        if not self.batch:
            return
        path, _ = QFileDialog.getSaveFileName(
            self,
            "导出本批次 CSV",
            str(Path(self.csv_dir) / "RingHi-导出.csv"),
            "CSV 文件 (*.csv)",
        )
        if path:
            try:
                self.batch.export(path)
                self.set_notice("CSV 已导出：" + path)
            except Exception as e:
                self.error(e)

    def passive_scan(self):
        if self.scanning or self.batch or self.test or self.closing:
            return
        self.scanning = True

        def ready(result):
            self.scanning = False
            found, _ = result
            self.passive = []
            for i, hub in enumerate(
                dict.fromkeys(p.hub for p in found if p.mode not in ("other", "aux")), 1
            ):
                group = [p for p in found if p.hub == hub]
                e = next((p for p in group if p.mode == "esp"), None)
                m = next(
                    (p for p in group if p.mode in ("runtime", "download", "generic")),
                    None,
                )
                mac = e.instance.rsplit("\\", 1)[-1] if e else ""
                self.passive.append(
                    dict(
                        task=i,
                        mac=mac if len(mac) == 17 else "",
                        imei="",
                        ports=" + ".join(
                            p.path for p in group if p.mode not in ("other", "aux")
                        ),
                        espProgress=0,
                        mlProgress=0,
                        espState="已枚举 · 待读取芯片" if e else "未发现接口",
                        mlState={
                            "runtime": "AT 运行模式",
                            "download": "下载模式 · 开批次后核对恢复",
                            "generic": "异常模式 · 请完全断电重插",
                        }.get(m.mode, "未发现接口")
                        if m
                        else "未发现接口",
                        production="未执行",
                        cloud="未登记",
                        result="待开启批次",
                        reason="仅扫描接口，尚未打开设备",
                        connected=True,
                    )
                )
            self.scan_label.setText(
                f"已发现 {len(self.passive)} 块板 · {len(found)} 个串口 · 未开启批次不会烧录"
            )

        self.background(
            ports.scan,
            ready,
            lambda e: (
                setattr(self, "scanning", False),
                self.scan_label.setText("扫描失败：" + str(e)),
            ),
        )

    def tick(self):
        self.ticks += 1
        if self.ticks % 6 == 1:
            self.passive_scan()
        busy = self.batch and self.batch.busy
        accepting = self.batch and self.batch.accepting
        locked = bool(
            busy or accepting or self.preparing or self.closing or self.updating
        )
        self.config.setEnabled(not locked)
        self.start_button.setEnabled(not locked)
        self.pause_button.setEnabled(bool(accepting) and not self.closing)
        self.resume_button.setEnabled(
            bool(
                self.batch and not accepting and not self.closing and not self.updating
            )
        )
        self.export_button.setEnabled(self.batch is not None)
        rows = self.batch.snapshots() if self.batch else self.passive
        self.render(self.connected, [r for r in rows if r["connected"]])
        self.render(self.history, [r for r in rows if not r["connected"]])
        if self.batch:
            running = sum(
                not r.get("endedAt") and r.get("result") not in ("等待配对", "需要恢复")
                for r in rows
            )
            success = sum(r["result"] == "成功" for r in rows)
            failed = sum(r["result"] in ("失败", "已中断", "需要恢复") for r in rows)
            self.counts.setText("正在接收设备" if accepting else "接收已暂停")
            for value, count in zip(
                self.metric_values, (len(rows), running, success, failed)
            ):
                value.setText(str(count))
            self.csv_label.setText(str(self.batch.csv))
            self.scan_label.setText(
                "接收中 · 成功设备拔出后归档" if accepting else "接收已暂停"
            )
            if self.batch.error:
                self.set_notice(self.batch.error)
        self.config_summary.setText(
            PRODUCTS[self.batch.cfg.product_type if self.batch else self.product_type.currentData()] + " · " + (" / ".join(
                Path(edit.text()).name
                for edit in (self.ml_edit, self.esp_edit)
                if edit.text()
            )
            or "左右选择双芯固件，下方设置本批次流程")
        )
        if self.closing and not self.preparing and not self.jobs:
            self.allow_close = True
            self.close()

    def render(self, table, rows):
        # Ignore timestamps/log text for painting; keep the full snapshot for details.
        fields = (
            "task",
            "mac",
            "imei",
            "ports",
            "productName",
            "espProgress",
            "espState",
            "mlProgress",
            "mlState",
            "production",
            "cloud",
            "result",
            "reason",
        )
        table.rows = rows
        signatures = [tuple(row.get(key, "") for key in fields) for row in rows]
        if signatures == table.signatures:
            return
        old = table.signatures
        table.signatures = signatures
        table.setRowCount(len(rows))
        table.fit_rows(len(rows))
        for n, row in enumerate(rows):
            if n < len(old) and old[n] == signatures[n]:
                continue
            visible = {key: row.get(key, "") for key in fields}
            tips = (
                str(row["task"]),
                "\n".join(str(row.get(k, "")) for k in ("mac", "ports", "imei", "productName")),
                row.get("espState", ""),
                row.get("mlState", ""),
                row.get("production", "") + "\n" + row.get("cloud", ""),
                row.get("result", "") + "\n" + row.get("reason", ""),
                "查看完整状态与日志",
            )
            for col, tip in enumerate(tips):
                item = table.item(n, col)
                if item is None:
                    item = QTableWidgetItem()
                    table.setItem(n, col, item)
                item.setData(Qt.UserRole, visible)
                item.setText(tip)
                item.setToolTip(tip)

    def detail(self, row):
        dialog = QDialog(self)
        dialog.setWindowTitle("设备任务详情")
        dialog.resize(750, 570)
        l = QVBoxLayout(dialog)
        view = QTextEdit()
        view.setReadOnly(True)
        view.setPlainText(json.dumps(row, ensure_ascii=False, indent=2))
        l.addWidget(view)
        l.addWidget(self.button("复制完整状态与日志", lambda: QApplication.clipboard().setText(view.toPlainText())))
        l.addWidget(self.button("关闭", dialog.accept))
        dialog.exec()

    def refresh_records(self):
        rows = []
        for folder in sorted((storage.ROOT / "batches").glob("*"), reverse=True):
            try:
                data = read_json(folder / "records.json", [])
                rows.append(
                    (
                        folder.name,
                        str(len(data)),
                        str(sum(r.get("result") == "成功" for r in data)),
                        str(folder / "records.json"),
                    )
                )
            except (OSError, ValueError):
                continue
        self.records.setRowCount(len(rows))
        for i, row in enumerate(rows):
            for col, value in enumerate(row):
                self.records.setItem(i, col, QTableWidgetItem(value))

    def check_updates(self):
        if self.test or self.closing or self.updating:
            return
        self.update_label.setText("正在检查更新…")

        def ready(info):
            self.update_info = info
            self.update_label.setText(
                "当前已经是最新的 Python 原生版。"
                if not info
                else "新版本 "
                + info["version"]
                + " 可下载并覆盖更新，账号与 CSV 保留。"
            )
            self.update_button.setText(
                "↑ 更新到 " + info["version"] if info else "已是最新版本"
            )

        self.background(
            updates.check,
            ready,
            lambda e: self.update_label.setText("暂时无法检查更新：" + str(e)),
        )

    def update_clicked(self):
        if self.updating or self.closing:
            return
        if not self.update_info:
            self.check_updates()
            return
        if self.preparing or self.batch and (self.batch.busy or self.batch.accepting):
            self.error("请先暂停接收并等待任务结束，再更新")
            return
        if (
            QMessageBox.question(
                self,
                "更新 RingHi",
                "下载并校验后会保存 CSV、退出安装并自动重新打开。账号、配置和记录保留，无需重启电脑。\n现在更新？",
                QMessageBox.Yes | QMessageBox.Cancel,
                QMessageBox.Yes,
            )
            != QMessageBox.Yes
        ):
            return
        self.updating = True
        self.tick()
        self.update_button.setEnabled(False)
        self.set_notice("正在下载并校验更新包…")

        def ready(path):
            self.update_stage = path
            self.close()

        self.background(
            lambda: updates.download(self.update_info),
            ready,
            self.update_failed,
        )

    def update_failed(self, error):
        self.updating = False
        self.update_stage = None
        self.update_button.setEnabled(True)
        self.error(error)
        self.tick()

    def closeEvent(self, event):
        if self.updating and self.update_stage is None:
            self.set_notice("正在下载并校验更新，完成后会自动保存并重新打开…")
            event.ignore()
            return
        if self.allow_close:
            if self.update_stage:
                try:
                    updates.launch_replace(self.update_stage)
                except Exception as e:
                    self.allow_close = False
                    self.closing = False
                    self.update_failed(e)
                    event.ignore()
                    return
            event.accept()
            return
        event.ignore()
        if self.closing:
            return
        if self.preparing or self.batch and self.batch.busy:
            answer = QMessageBox.question(
                self,
                "关闭 RingHi",
                "当前有任务执行中。关闭会停止烧录 / 产测，保留备份并自动保存 CSV。\n是否关闭？",
                QMessageBox.Yes | QMessageBox.Cancel,
                QMessageBox.Cancel,
            )
            if answer != QMessageBox.Yes:
                return
        self.closing = True
        self.set_notice("正在停止任务、释放端口并保存 CSV…")
        if self.preparing:
            self.preparing.cancel()

        def finish():
            if self.batch:
                self.batch.close()

        def done(_):
            try:
                self.save_settings()
            except Exception as e:
                self.closing = False
                self.update_failed("设置保存失败：" + str(e))

        def failed(e):
            self.closing = False
            self.update_failed("CSV 未保存成功，窗口保留。请导出后再关闭：" + str(e))

        self.background(finish, done, failed)
