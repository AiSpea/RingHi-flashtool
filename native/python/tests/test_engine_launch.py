"""Process-level checks: no serial port is opened by these tests."""
import concurrent.futures
import os
import sys
import time
from pathlib import Path
import pytest
from ringhi import esp, process_job
from ringhi.storage import Cancel, Cancelled


def test_environment_is_independent(monkeypatch, tmp_path):
    monkeypatch.setenv('_PYI_APPLICATION_HOME_DIR', 'wrong-runtime')
    monkeypatch.setenv('_PYI_PARENT_PROCESS_LEVEL', '1')
    monkeypatch.setenv('_MEIPASS2', 'wrong-runtime')
    monkeypatch.setenv('PYTHONHOME', 'wrong-python')
    monkeypatch.setenv('PYTHONPATH', 'wrong-modules')
    monkeypatch.setenv('PATH', str(tmp_path) + os.pathsep + '/system-bin')
    monkeypatch.setattr(sys, '_MEIPASS', str(tmp_path), raising=False)
    env = process_job.external_environment()
    assert not any(k.startswith('_PYI_') for k in env)
    assert all(k not in env for k in ('_MEIPASS2', 'PYTHONHOME', 'PYTHONPATH'))
    assert env['PYINSTALLER_RESET_ENVIRONMENT'] == '1'
    assert str(tmp_path) not in env['PATH']
    assert os.environ['PYTHONHOME'] == 'wrong-python'  # parent remains unchanged


def test_start_failure_reports_system_error(monkeypatch):
    def fail(cmd):
        raise PermissionError(13, 'test access denied')
    monkeypatch.setattr(process_job, 'launch', fail)
    with pytest.raises(OSError, match='启动失败.*13.*尚未连接芯片'):
        esp.execute(['missing'], Cancel())


def test_nonzero_without_output_has_exit_code():
    with pytest.raises(OSError, match='退出码 7 / 0x00000007.*未输出诊断'):
        esp.execute([sys.executable, '-c', 'raise SystemExit(7)'], Cancel())


def test_cancel_kills_child_and_returns():
    cancel = Cancel()
    with pytest.raises(Cancelled):
        esp.execute([sys.executable, '-u', '-c',
                     'import time; print("started"); time.sleep(60)'],
                    cancel, lambda _: cancel.cancel(), timeout=10)


def test_output_and_concurrent_launches():
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        outputs = list(pool.map(lambda _: esp.execute(
            [sys.executable, '-c', 'print("ready")'], Cancel()), range(8)))
    assert outputs == ['ready'] * 8


@pytest.mark.skipif(sys.platform != 'win32', reason='Windows job and DLL behavior')
def test_job_owns_descendants(tmp_path):
    import psutil
    pidfile = tmp_path / 'child.pid'
    code = ('import subprocess,sys,time,pathlib; '
            'p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"]); '
            f'pathlib.Path({str(pidfile)!r}).write_text(str(p.pid)); '
            'time.sleep(60)')
    process, job = process_job.launch([sys.executable, '-c', code])
    try:
        limit = time.monotonic() + 10
        while not pidfile.exists() and time.monotonic() < limit:
            time.sleep(.05)
        assert pidfile.exists()
        child = psutil.Process(int(pidfile.read_text()))
        job.close()
        process.wait(timeout=5)
        child.wait(timeout=5)
    finally:
        job.close()
        process.stdout.close()


@pytest.mark.skipif(sys.platform != 'win32', reason='Pinned Windows official engine')
def test_official_engine_parallel_preflight():
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        outputs = list(pool.map(lambda _: esp.preflight(Cancel()), range(8)))
    assert all('5.6.0' in out for out in outputs)
