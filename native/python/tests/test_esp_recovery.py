"""Recovery fault injection: topology changes, port leases and ROM transitions."""
import threading
from types import SimpleNamespace
import pytest
from ringhi import esp, ports, storage
from ringhi.storage import Cancel, Cancelled

MAC='00:11:22:33:44:55'
IDENTITY=f'Chip type: ESP32-S3\nDetected flash size: 16 MB\nMAC: {MAC}\n'

@pytest.fixture(autouse=True)
def quick(monkeypatch):
    monkeypatch.setattr(Cancel, 'sleep', lambda self, s: self.check())


def test_readiness_does_not_use_up_reset_attempts(monkeypatch):
    calls=[]; reads=[]
    def resolve():
        reads.append(1)
        if len(reads)<15: raise ports.NotReady('not yet')
        return SimpleNamespace(path='COM42')
    monkeypatch.setattr(esp,'run',lambda *a,**kw: calls.append((a,kw)) or IDENTITY)
    assert esp.identify(resolve,Cancel())==MAC
    assert len(calls)==1 and len(reads)==15


def test_download_recovery_modes_and_new_port(monkeypatch):
    calls=[]
    def run(port,command,args,cancel,**kw):
        calls.append((port,kw['before']))
        if len(calls)<4: raise OSError('Failed to connect to ESP32-S3: No serial data received')
        return IDENTITY
    monkeypatch.setattr(esp,'run',run)
    assert esp.identify(lambda: SimpleNamespace(path='COM'+str(30+len(calls))),Cancel())==MAC
    assert calls==[('COM30','default-reset'),('COM31','no-reset'),('COM32','usb-reset'),('COM33','no-reset')]


def test_busy_port_recovers_but_never_kills_an_unowned_process(monkeypatch):
    calls=[]
    def run(*a,**kw):
        calls.append(1)
        if len(calls)<3: raise OSError('Could not open COM7: PermissionError(13)')
        return IDENTITY
    monkeypatch.setattr(esp,'run',run)
    monkeypatch.setattr(esp,'kill_tree',lambda p: pytest.fail('must not kill other port owners'))
    assert esp.identify(lambda: SimpleNamespace(path='COM7'),Cancel())==MAC
    assert len(calls)==3


@pytest.mark.parametrize('error',[ports.Ambiguous('multiple'),esp.PortCleanupError('still running'),OSError('ESP32 工具启动失败'),OSError('SHA-256 mismatch')])
def test_fatal_conditions_not_retried(monkeypatch,error):
    calls=[]
    def run(*a,**kw): calls.append(1); raise error
    monkeypatch.setattr(esp,'run',run)
    with pytest.raises(OSError): esp.identify(lambda: SimpleNamespace(path='COM1'),Cancel())
    assert len(calls)==1


def test_changed_mac_blocks_recovery(monkeypatch):
    monkeypatch.setattr(esp,'run',lambda *a,**kw: IDENTITY.replace(MAC,'AA:BB:CC:DD:EE:FF'))
    with pytest.raises(OSError,match='MAC'):
        esp.identify(lambda: SimpleNamespace(path='COM1'),Cancel(),expected=MAC)


def test_unplug_cancels_wait_before_any_command(monkeypatch):
    c=Cancel()
    def resolve(): c.cancel(); raise ports.NotReady('missing')
    monkeypatch.setattr(esp,'run',lambda *a,**kw: pytest.fail('must not open disconnected board'))
    with pytest.raises(Cancelled): esp.identify(resolve,c)


def test_commands_keep_stub_and_bound_internal_connect_attempts(monkeypatch):
    seen=[]
    monkeypatch.setattr(esp,'engine',lambda:'official.exe')
    monkeypatch.setattr(esp,'execute',lambda cmd,*a: seen.append(cmd) or 'ok')
    esp.run('COM4','flash-id',[],Cancel())
    assert seen[0][seen[0].index('--after')+1]=='no-reset-stub'
    assert seen[0][seen[0].index('--connect-attempts')+1]=='2'


def test_same_port_serialized_other_port_independent():
    c=Cancel(); entered=threading.Event(); other=threading.Event()
    def worker(port,event):
        with esp.port_lease(port,c):event.set()
    with esp.port_lease('COM1',c):
        a=threading.Thread(target=worker,args=('COM1',entered));a.start()
        b=threading.Thread(target=worker,args=('COM2',other));b.start()
        assert other.wait(1) and not entered.is_set()
    a.join(1);b.join(1);assert entered.is_set()


def image_file(tmp_path):
    raw=bytearray(16777216);raw[0]=0xe9;raw[12]=9
    path=tmp_path/'firmware.bin';path.write_bytes(raw)
    return path,bytes(raw)


def test_write_preconnect_can_recover_without_repeating_completed_write(monkeypatch,tmp_path):
    path,raw=image_file(tmp_path);calls=[]
    def run(port,cmd,args,cancel,*a,**kw):
        calls.append(cmd)
        if calls==['write-flash']:raise OSError('Failed to connect to ESP32-S3')
        if cmd=='flash-id':return IDENTITY
        if cmd=='write-flash':return 'Wrote 16777216 bytes\nHash of data verified.'
        return 'Verifying 0x1000000 (16777216) bytes at 0x00000000 in flash\nVerification successful (digest matched).'
    monkeypatch.setattr(esp,'run',run)
    esp.flash(lambda:SimpleNamespace(path='COM4'),path,raw,MAC,Cancel(),lambda *a:None,lambda *a:None)
    assert calls==['write-flash','flash-id','write-flash','verify-flash']


@pytest.mark.parametrize('output',['Connected to ESP32-S3\nFailed to connect','Flash will be erased\nFailed to connect','Writing at 0x00000000\nCould not open COM1'])
def test_partial_or_ambiguous_write_is_never_replayed(monkeypatch,tmp_path,output):
    path,raw=image_file(tmp_path);calls=[]
    def run(*a,**kw):calls.append(1);raise esp.ToolFailure('failed',output)
    monkeypatch.setattr(esp,'run',run)
    with pytest.raises(OSError):
        esp.flash(lambda:SimpleNamespace(path='COM4'),path,raw,MAC,Cancel(),lambda *a:None,lambda *a:None)
    assert len(calls)==1


def test_verify_transport_recovery_only_reads_and_checks_mac(monkeypatch):
    calls=[]
    def run(port,cmd,*a,**kw):
        calls.append(cmd)
        if len(calls)==1:raise OSError('ClearCommError failed')
        return IDENTITY if cmd=='flash-id' else 'verified'
    monkeypatch.setattr(esp,'run',run)
    assert esp.read_operation(lambda:SimpleNamespace(path='COM4'),'verify-flash',[],Cancel(),lambda *a:None,lambda *a:None,20,expected=MAC)=='verified'
    assert calls==['verify-flash','flash-id','verify-flash']
