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


COMPLETE_WRITE = ('Wrote 16777216 bytes (3255619 compressed) at 0x00000000 in 30.3 seconds (4435.8 kbit/s).\n'
                  'Verifying written data...\nStaying in flasher stub.\n'
                  "ERROR: A serial exception error occurred: Cannot configure port. PermissionError(13, '设备不识别此命令。', None, 22)")
FULL_DIGEST = 'Verifying 0x1000000 (16777216) bytes at 0x00000000 in flash\nVerification successful (digest matched).'


def test_completed_write_driver_22_only_reidentifies_and_verifies(monkeypatch,tmp_path):
    file,raw=image_file(tmp_path);calls=[];progress=[]
    def run(port,cmd,*a,**kw):
        calls.append((port,cmd))
        if cmd=='write-flash':raise esp.ToolFailure('serial failure',COMPLETE_WRITE)
        return IDENTITY if cmd=='flash-id' else FULL_DIGEST
    monkeypatch.setattr(esp,'run',run)
    esp.flash(lambda:SimpleNamespace(path='COM'+str(10+len(calls))),file,raw,MAC,Cancel(),lambda n,s:progress.append(n),lambda s:None)
    assert calls==[('COM10','write-flash'),('COM11','flash-id'),('COM12','verify-flash')]
    assert progress[-1]==100 and 96 in progress and 97 in progress


@pytest.mark.parametrize('change',[
    lambda t:t.replace('16777216','4096'),
    lambda t:t.replace('0x00000000','0x00001000'),
    lambda t:t.replace('Verifying written data...',''),
    lambda t:t+'\nMD5 of file does not match data in flash!',
    lambda t:t+'\nWrite failed, the written flash region is empty.',
    lambda t:t+'\nWriting at 0x00000000 1%',
    lambda t:t+'\n'+t,
])
def test_incomplete_or_mismatch_write_not_recovered(change):
    assert not esp.verification_interrupted(esp.ToolFailure('serial failure',change(COMPLETE_WRITE)))


def test_cleanup_failure_not_converted_to_verify():
    assert not esp.verification_interrupted(esp.PortCleanupError(COMPLETE_WRITE))


@pytest.mark.parametrize('failure',['wrong-mac','bad-digest','cancel','missing-port','snapshot-changed'])
def test_write_completion_cannot_bypass_verification_gates(monkeypatch,tmp_path,failure):
    file,raw=image_file(tmp_path);commands=[];progress=[];cancel=Cancel()
    def run(port,cmd,*a,**kw):
        commands.append(cmd)
        if cmd=='write-flash':
            if failure=='cancel':cancel.cancel()
            if failure=='snapshot-changed':file.write_bytes(b'changed')
            raise esp.ToolFailure('serial failure',COMPLETE_WRITE)
        if cmd=='flash-id':return IDENTITY.replace(MAC,'AA:BB:CC:DD:EE:FF') if failure=='wrong-mac' else IDENTITY
        return 'Verification failed.' if failure=='bad-digest' else FULL_DIGEST
    monkeypatch.setattr(esp,'run',run)
    def resolve():
        if commands and failure=='missing-port':raise Cancelled('original connection gone')
        return SimpleNamespace(path='COM4')
    with pytest.raises((OSError,Cancelled)):
        esp.flash(resolve,file,raw,MAC,cancel,lambda n,s:progress.append(n),lambda s:None)
    assert commands.count('write-flash')==1 and 100 not in progress
    if failure in ('wrong-mac','cancel','missing-port','snapshot-changed'):assert 'verify-flash' not in commands


def test_full_write_generic_tool_exit_without_transport_error_stays_failure():
    text=COMPLETE_WRITE.split('ERROR:')[0]+'ERROR: unexpected internal failure'
    assert not esp.verification_interrupted(esp.ToolFailure('failed',text))
