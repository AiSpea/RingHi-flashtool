"""Explicit software-only Qt smoke check. No scan, account calls, or hardware engine."""

import time
from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QMessageBox
from ringhi.batch import Config, Batch
from ringhi.account import Account
from ringhi.ports import Port
from ringhi.storage import save_json


def check_csv_gate(window, output):
    from unittest.mock import patch
    from ringhi import ui, storage

    events = []
    image = output / "qa-image.bin"
    package = output / "qa-package.pkg"
    image.write_bytes(b"fixture")
    package.write_bytes(b"fixture")
    path = output / "csv-gate.csv"
    path.unlink(missing_ok=True)
    original = (
        window.esp_edit.text(),
        window.ml_edit.text(),
        window.backup_edit.text(),
    )
    window.esp_edit.setText(str(image))
    window.ml_edit.setText(str(package))
    window.backup_edit.setText(str(output / "gate-backup"))

    class Prepared:
        def __init__(self, *args):
            assert path.read_bytes() == storage.csv_bytes([])
            events.append("authorization-after-saved-csv")

        def close(self):
            pass

    class Batch:
        def __init__(self, *args):
            assert path.read_bytes() == storage.csv_bytes([])
            events.append("batch-created")

        def start(self):
            events.append("scan-started")

        def close(self):
            pass

    def background(fn, ready, failed=None):
        try:
            ready(fn())
        except Exception as e:
            if failed:
                failed(e)
            else:
                raise

    with (
        patch.object(window, "background", background),
        patch.object(ui, "validate_image", lambda raw: None),
        patch.object(ui, "engine", lambda: None),
        patch.object(ui, "Package", lambda raw: object()),
        patch.object(ui, "Prepared", Prepared),
        patch.object(ui, "Batch", Batch),
    ):
        with patch.object(ui.QFileDialog, "getSaveFileName", return_value=("", "")):
            window.start_batch()
            assert not events and not path.exists() and window.preparing is None
        # Existing records cannot be overwritten and cannot lead to authorization/start.
        path.write_bytes(b"old-records")
        with patch.object(
            ui.QFileDialog, "getSaveFileName", return_value=(str(path), "")
        ):
            window.start_batch()
            assert (
                not events
                and window.batch is None
                and path.read_bytes() == b"old-records"
            )
        with (
            patch.object(storage, "create_batch_csv", side_effect=OSError("Disk full")),
            patch.object(
                ui.QFileDialog,
                "getSaveFileName",
                return_value=(str(output / "unwritable.csv"), ""),
            ),
        ):
            window.start_batch()
            assert not events and window.batch is None and window.preparing is None
        path.unlink()
        with patch.object(
            ui.QFileDialog, "getSaveFileName", return_value=(str(path), "")
        ):
            window.start_batch()
            assert events == [
                "authorization-after-saved-csv",
                "batch-created",
                "scan-started",
            ]
    window.batch = None
    for field, value in zip(
        (window.esp_edit, window.ml_edit, window.backup_edit), original
    ):
        field.setText(value)
    window.config.show()
    window.tick()


def check_update_gate(window, output):
    from unittest.mock import patch
    from ringhi import ui

    original_batch = window.batch
    errors = []
    calls = []
    window.batch = None
    window.update_info = {"version": "v99.0.0"}
    with (
        patch.object(window, "error", lambda e: errors.append(str(e))),
        patch.object(ui.QMessageBox, "question", return_value=QMessageBox.Yes),
        patch.object(window, "background", lambda *args: calls.append(args)),
    ):
        window.update_clicked()
        assert window.updating and not window.start_button.isEnabled()

        class Paused:
            def resume(self):
                raise AssertionError("Resume must be blocked during update")

        window.batch = Paused()
        window.resume()
        window.batch = None
        assert not window.resume_button.isEnabled()
        window.start_batch()
        assert window.preparing is None
        window.update_clicked()
        assert len(calls) == 1
        window.update_failed("fixture-download-failure")
        assert not window.updating and window.start_button.isEnabled()

        class Busy:
            busy = True
            accepting = True

        window.batch = Busy()
        window.update_clicked()
        assert len(calls) == 1 and not window.updating
    window.batch = original_batch
    window.update_info = None
    window.tick()


def check_expanded_table(window, output):
    from PySide6.QtWidgets import QApplication, QWidget
    from PySide6.QtCore import Qt, QPoint, QPointF
    from PySide6.QtGui import QWheelEvent

    template = dict(
        task=1,
        connected=True,
        mac="00:11:22:33:44:55",
        imei="000000000000001",
        ports="COM101 + COM102",
        espProgress=30,
        mlProgress=40,
        espState="写入中",
        mlState="备份与写入",
        production="等待双芯完成",
        cloud="等待登记",
        result="烧录中",
        reason="测试数据",
    )
    rows = [dict(template, task=i + 1) for i in range(8)]
    window.timer.stop()
    window.render(window.connected, rows)
    window.resize(1080, 760)
    QApplication.processEvents()
    table = window.connected
    assert (
        not table.horizontalScrollBar().isVisible()
        and not table.verticalScrollBar().isVisible()
    )
    assert (
        table.horizontalScrollBar().maximum()
        == table.verticalScrollBar().maximum()
        == 0
    )
    assert sum(table.columnWidth(i) for i in range(7)) <= table.viewport().width()
    assert table.visualItemRect(table.item(7, 6)).bottom() <= table.viewport().height()
    assert all(table.cellWidget(r, c) is None for r in range(8) for c in range(7))
    opened = []

    def inspect_detail():
        from PySide6.QtWidgets import QTextEdit

        dialog = QApplication.activeModalWidget()
        assert dialog and template["mac"] in dialog.findChild(QTextEdit).toPlainText()
        opened.append(True)
        dialog.accept()

    QTimer.singleShot(0, inspect_detail)
    table.cellClicked.emit(0, 6)
    assert opened, "Details action must remain available without cell widgets"
    # Stable item identity across live progress changes, without rebuilding table controls.
    item = table.item(0, 2)
    count = len(table.findChildren(QWidget))
    frames = []
    scroll = window.batch_scroll.verticalScrollBar()
    for frame in range(30):
        started = time.perf_counter()
        rows[0]["espProgress"] = frame
        window.render(table, rows)
        scroll.setValue(min(scroll.maximum(), frame * 18))
        QApplication.processEvents()
        frames.append((time.perf_counter() - started) * 1000)
    assert table.item(0, 2) is item and len(table.findChildren(QWidget)) == count
    scroll.setValue(150)
    before = scroll.value()
    wheel = QWheelEvent(
        QPointF(20, 20),
        QPointF(table.viewport().mapToGlobal(QPoint(20, 20))),
        QPoint(),
        QPoint(0, -120),
        Qt.NoButton,
        Qt.NoModifier,
        Qt.NoScrollPhase,
        False,
    )
    QApplication.sendEvent(table.viewport(), wheel)
    QApplication.processEvents()
    assert scroll.value() > before, "Wheel over devices must scroll the outer page"
    window.batch_scroll.ensureWidgetVisible(table, 0, 0)
    window.grab().save(str(output / "eight-devices-narrow.png"))
    window.resize(1440, 940)
    window.timer.start(350)
    return {
        "rows": 8,
        "innerScrollbars": False,
        "outerWheelWorks": True,
        "widgetsRebuilt": False,
        "maxUpdateAndScrollMs": max(frames),
        "meanUpdateAndScrollMs": sum(frames) / len(frames),
    }


def schedule(window, output):
    result = {"hardwareWrites": 0, "activationRequests": 0, "scanCalls": 0}
    beats = []
    heartbeat = QTimer(window)
    heartbeat.timeout.connect(lambda: beats.append(time.monotonic()))
    heartbeat.start(20)

    def pair(hub):
        return [
            Port("TEST", "USB\\VID_303A&PID_1001", hub + "E", hub, 1, 0),
            Port("TEST", "USB\\VID_3563&PID_2000", hub + "M", hub, 1, 4),
        ]

    def start():
        try:
            check_csv_gate(window, output)
            result["csvSavedBeforeAuthorizationAndScan"] = True
            result["csvCancelAndFailurePreventStart"] = True
            window.grab().save(str(output / "setup.png"))
            # Capture the whole configuration at its actual scroll position, plus narrow layout.
            window.batch_scroll.ensureWidgetVisible(window.production)
            from PySide6.QtWidgets import QApplication

            QApplication.processEvents()
            window.grab().save(str(output / "configuration.png"))
            assert (
                window.ml_edit.mapTo(window.config, window.ml_edit.rect().topLeft()).x()
                < window.esp_edit.mapTo(
                    window.config, window.esp_edit.rect().topLeft()
                ).x()
            )
            assert window.mode.count() == 3 and window.limit.count() == 6
            assert window.product_type.count() == 2
            window.product_type.setCurrentIndex(1)
            window.save_settings()
            window.product_type.setCurrentIndex(0)
            window.settings = __import__("ringhi.storage", fromlist=["read_json"]).read_json(__import__("ringhi.storage", fromlist=["ROOT"]).ROOT / "settings.json")
            window.load_settings()
            assert window.product_type.currentData() == "dual_sim"
            result["productSelectionPersists"] = True
            assert all(
                widget.isVisible()
                for widget in (
                    window.ml_edit,
                    window.esp_edit,
                    window.backup_edit,
                    window.login_button,
                    window.projects,
                    window.production,
                    window.product_type,
                    window.mode,
                    window.limit,
                )
            )
            result["allConfigurationControlsPresent"] = True
            window.resize(1080, 760)
            window.batch_scroll.verticalScrollBar().setValue(0)
            QApplication.processEvents()
            window.grab().save(str(output / "setup-narrow.png"))
            window.resize(1440, 940)
            QApplication.processEvents()
            cfg = Config(
                output / "fixture.bin",
                output / "fixture.pkg",
                output / "backups",
                mode="esp",
                production=False,
                limit=2,
                product_type="dual_sim",
            )

            def execute(b, resolve):
                b.update(mac="TEST:DEVICE:" + str(b.number), result="软件测试中")
                for i in range(20):
                    b.cancel.sleep(0.03)
                    b.update(
                        espProgress=i * 5,
                        mlProgress=i * 5,
                        espState="测试写入",
                        mlState="测试状态",
                    )
                b.update(
                    espProgress=100,
                    mlProgress=100,
                    espState="测试校验通过",
                    mlState="测试校验通过",
                )

            window.batch = Batch(
                cfg, Account(), None, output / "ui.csv", execute=execute
            )
            window.batch.observe(pair("A") + pair("B"), {"A", "B"})
            assert all(r["productType"] == "dual_sim" for r in window.batch.snapshots())
            window.product_type.setCurrentIndex(0)
            assert window.batch.cfg.product_type == "dual_sim"
            result["batchProductFrozen"] = True
            window.config.hide()
            window.set_notice("软件验证 · 测试数据，不操作真实设备")
            QTimer.singleShot(180, remove)
        except Exception as e:
            fail(e)

    def remove():
        try:
            window.batch.observe(pair("B"), {"B"})
            window.batch.observe(pair("A") + pair("B"), {"A", "B"})
            assert all(r["productType"] == "dual_sim" for r in window.batch.snapshots())
            window.product_type.setCurrentIndex(0)
            assert window.batch.cfg.product_type == "dual_sim"
            result["batchProductFrozen"] = True
            QTimer.singleShot(1300, check)
        except Exception as e:
            fail(e)

    def check():
        try:
            rows = window.batch.snapshots()
            assert len(rows) == 3 and not rows[0]["connected"]
            assert all(r["endedAt"] for r in rows)
            assert all(r["result"] == "成功" for r in rows[1:])
            assert rows[1]["connected"]
            window.batch.export(output / "export.csv")
            assert (output / "export.csv").read_bytes() == (
                output / "ui.csv"
            ).read_bytes()
            window.tick()
            window.grab().save(str(output / "complete.png"))
            from PySide6.QtWidgets import QApplication

            window.batch_scroll.ensureWidgetVisible(window.history)
            QApplication.processEvents()
            window.grab().save(str(output / "history.png"))
            window.resize(1080, 760)
            window.batch_scroll.ensureWidgetVisible(window.connected)
            QApplication.processEvents()
            window.grab().save(str(output / "queue-narrow.png"))
            window.resize(1440, 940)
            result["scrollValidation"] = check_expanded_table(window, output)
            check_update_gate(window, output)
            result["updateLocksBatchAndProtectsActiveTasks"] = True
            gaps = [b - a for a, b in zip(beats, beats[1:])]
            result.update(
                passed=True,
                tasks=len(rows),
                exportMatches=True,
                heartbeatCount=len(beats),
                maxGuiGapMs=max(gaps, default=0) * 1000,
            )
            assert len(beats) > 20 and max(gaps, default=0) < 1
            # Test cancel-then-confirm closing with an active task through the real close handler.
            window.batch.close()

            def forever(b, resolve):
                while True:
                    b.cancel.sleep(0.03)

            window.batch = Batch(
                Config(
                    output / "a",
                    output / "b",
                    output / "backups",
                    mode="esp",
                    production=False,
                ),
                Account(),
                None,
                output / "close.csv",
                execute=forever,
            )
            window.batch.observe(pair("C"), {"C"})
            QTimer.singleShot(150, close_test)
        except Exception as e:
            fail(e)

    def close_test():
        try:
            original = QMessageBox.question
            QMessageBox.question = lambda *a, **k: QMessageBox.Cancel
            window.close()
            assert not window.closing and window.isVisible()
            result["cancelCloseKeepsWindow"] = True
            QMessageBox.question = lambda *a, **k: QMessageBox.Yes
            window.close()
            QMessageBox.question = original
            timer = QTimer(window)
            timer.setSingleShot(False)
            timer.setInterval(20)

            def final():
                if not window.batch.busy:
                    timer.stop()
                    result["closeSavedInterruptedCSV"] = "已中断" in (
                        output / "close.csv"
                    ).read_text("utf-8-sig")
                    save_json(output / "ui-report.json", result)

            timer.timeout.connect(final)
            timer.start()
            window._qa_timer = timer
        except Exception as e:
            fail(e)

    def fail(e):
        result.update(passed=False, error=str(e))
        save_json(output / "ui-report.json", result)
        window.allow_close = True
        window.close()

    QTimer.singleShot(400, start)
