"""ML307 mode-transition and activation-finalization fault injection."""
from contextlib import nullcontext
from types import SimpleNamespace as NS
import pytest
from ringhi import modem, wire, ports, storage
from ringhi.storage import Cancel, Cancelled


@pytest.fixture
def clock(monkeypatch):
    t = NS(now=0)
    monkeypatch.setattr(modem.time, 'monotonic', lambda: t.now)
    def sleep(self, seconds):
        self.check()
        t.now += seconds
    monkeypatch.setattr(Cancel, 'sleep', sleep)
    return t


@pytest.mark.parametrize('code', [2, 3, 5, 21, 32, 1167])
def test_transient_open_re_resolves_and_releases_busy_port(code, clock):
    seen=[]
    def opener(path, cancel):
        seen.append(path)
        if len(seen)<3:
            err=OSError('transient');err.winerror=code;raise err
        return 'opened'
    assert wire.open_ready(lambda:NS(path='COM'+str(len(seen)+1)),Cancel(),opener=opener)=='opened'
    assert seen==['COM1','COM2','COM3']


def test_open_timeout_preserves_stage_and_os_error(clock):
    def opener(*a):
        err=OSError('sharing violation');err.winerror=32;raise err
    with pytest.raises(wire.PortOpenTimeout,match='ML307 下载口.*COM8.*sharing violation') as caught:
        wire.open_ready(lambda:NS(path='COM8'),Cancel(),timeout=1,opener=opener,target='ML307 下载口')
    assert caught.value.__cause__.winerror==32
    assert '尚未发送数据' not in str(caught.value)


def test_missing_mode_error_reports_observed_same_chip_only(clock):
    p=ports.Port('COM7','USB\\VID_3563&PID_2000','chip','hub',1,4)
    with pytest.raises(wire.PortOpenTimeout,match='download.*COM7/runtime'):
        wire.open_ready(lambda:ports.select([p], 'hub','chip','download'),Cancel(),timeout=0,target='下载口')


def test_cancel_racing_successful_open_closes_handle():
    c=Cancel();closed=[]
    def opener(*a):
        c.cancel();return NS(close=lambda:closed.append(True))
    with pytest.raises(Cancelled):wire.open_ready(lambda:NS(path='COM1'),c,opener=opener)
    assert closed==[True]


def setup_switch(monkeypatch):
    commands=[]
    monkeypatch.setattr(modem,'identity',lambda *a,**k:('1'*15,'RingHi'))
    monkeypatch.setattr(modem,'at',lambda w,cmd,*a,**kw:commands.append(cmd))
    return commands


def test_delayed_download_after_old_at_disappears(clock,monkeypatch):
    commands=setup_switch(monkeypatch)
    def resolve(mode):
        if mode=='runtime' and clock.now==0:return NS(path='COM1')
        if mode=='download' and clock.now>=15:return NS(path='COM2')
        raise ports.NotReady('switching')
    monkeypatch.setattr(modem,'open_ready',lambda lookup,*a,**k:nullcontext(lookup()))
    modem.enter_download(resolve,'1'*15,Cancel(),lambda s:None)
    assert commands==['AT^AUTODL'] and clock.now>=15


def test_download_arrives_during_fallback_open(clock,monkeypatch):
    commands=setup_switch(monkeypatch);calls=[]
    def resolve(mode):
        if mode=='download':
            if len(calls)>=2:return NS(path='COM9')
            raise ports.NotReady('not yet')
        return NS(path='COM1')
    def opening(lookup,*a,**kw):
        calls.append(kw);return nullcontext(lookup())
    monkeypatch.setattr(modem,'open_ready',opening)
    modem.enter_download(resolve,'1'*15,Cancel(),lambda s:None)
    assert commands==['AT^AUTODL']


def test_fallback_open_timeout_continues_waiting_download(clock,monkeypatch):
    commands=setup_switch(monkeypatch);opens=[]
    def resolve(mode):
        if mode=='download' and clock.now<15:raise ports.NotReady('switching')
        return NS(path='COM2' if mode=='download' else 'COM1')
    def opening(*a,**kw):
        opens.append(1)
        if len(opens)==2:raise wire.PortOpenTimeout('AT vanished while opening')
        return nullcontext(object())
    monkeypatch.setattr(modem,'open_ready',opening)
    modem.enter_download(resolve,'1'*15,Cancel(),lambda s:None)
    assert commands==['AT^AUTODL'] and len(opens)==2


def test_still_runtime_reset_once_and_bound_wait(clock,monkeypatch):
    commands=setup_switch(monkeypatch)
    def resolve(mode):
        if mode=='download':raise ports.NotReady('only runtime')
        return NS(path='COM1')
    monkeypatch.setattr(modem,'open_ready',lambda lookup,*a,**k:nullcontext(lookup()))
    with pytest.raises(wire.PortOpenTimeout,match='下载模式切换'):
        modem.enter_download(resolve,'1'*15,Cancel(),lambda s:None)
    assert commands==['AT^AUTODL','AT^RESET=normal'] and 45<=clock.now<46


def test_ambiguous_download_never_reset_or_retried(clock,monkeypatch):
    commands=setup_switch(monkeypatch)
    def resolve(mode):
        if mode=='download':raise ports.Ambiguous('multiple')
        return NS(path='COM1')
    monkeypatch.setattr(modem,'open_ready',lambda lookup,*a,**k:nullcontext(lookup()))
    with pytest.raises(ports.Ambiguous):modem.enter_download(resolve,'1'*15,Cancel(),lambda s:None)
    assert commands==['AT^AUTODL']


def test_runtime_read_disconnect_reopens_new_com(clock,monkeypatch):
    calls=[];closed=[]
    class W:
        def __enter__(self):return self
        def __exit__(self,*a):closed.append(True)
    monkeypatch.setattr(modem,'open_ready',lambda *a,**k:W())
    def identity(*a,**kw):
        calls.append(1)
        if len(calls)==1:
            err=OSError('removed');err.winerror=1167;raise err
        return '1'*15,'RingHi-test'
    monkeypatch.setattr(modem,'identity',identity)
    assert modem.verify_runtime(None,'1'*15,Cancel(),lambda s:None)=='RingHi-test'
    assert len(calls)==2 and len(closed)==2


@pytest.mark.parametrize('actual,version,error',[('2'*15,'RingHi','IMEI'),('1'*15,'stock','固件版本')])
def test_wrong_runtime_identity_fails_without_retry(clock,monkeypatch,actual,version,error):
    calls=[]
    monkeypatch.setattr(modem,'open_ready',lambda *a,**k:nullcontext(object()))
    monkeypatch.setattr(modem,'identity',lambda *a,**k:(calls.append(1) or actual,version))
    with pytest.raises(OSError,match=error):modem.verify_runtime(None,'1'*15,Cancel(),lambda s:None)
    assert len(calls)==1


@pytest.fixture
def recovery(tmp_path,monkeypatch):
    monkeypatch.setattr(storage,'ROOT',tmp_path)
    prior=dict(uid='a'*32,imei='1'*15,mac='fixture',backup=str(tmp_path/'backup'),
               phase='awaiting-verification',firmwareSha256='pkg')
    board=NS(cancel=Cancel(),mac='fixture',update=lambda **v: updates.append(v))
    updates=[]
    ledger=dict(uid=prior['uid'],session=prior['backup'],stage='complete',project_id=188)
    storage.save_json(tmp_path/'activation'/(prior['uid']+'.json'),ledger)
    monkeypatch.setattr(modem,'original_backups',lambda *a:None)
    cfg=NS(package=NS(digest='pkg'));account=NS(project=188)
    return prior,board,cfg,account,updates


def test_completed_activation_only_checks_boot_no_network_or_download(recovery,monkeypatch):
    prior,board,cfg,account,updates=recovery
    monkeypatch.setattr(modem,'enter_download',lambda *a:pytest.fail('unnecessary download'))
    monkeypatch.setattr(modem,'activate',lambda *a:pytest.fail('must not reacquire'))
    monkeypatch.setattr(modem,'verify_runtime',lambda *a:'RingHi')
    modem.resume_activation(board,cfg,None,account,None,prior)
    assert [r['mlProgress'] for r in updates]==[98,100]
    assert prior['phase']=='verified'


def test_boot_timeout_keeps_completed_ledger_and_98_percent(recovery,clock,monkeypatch):
    prior,board,cfg,account,updates=recovery
    def opening(*a,**k):raise wire.PortOpenTimeout('runtime absent')
    monkeypatch.setattr(modem,'open_ready',opening)
    with pytest.raises(OSError,match='启动核验超时'):
        modem.resume_activation(board,cfg,None,account,None,prior)
    assert prior['phase']=='awaiting-verification'
    assert [r['mlProgress'] for r in updates if 'mlProgress' in r]==[98]
    assert storage.read_json(storage.ROOT/'activation'/(prior['uid']+'.json'))['stage']=='complete'


@pytest.mark.parametrize('change',[{'project_id':184},{'uid':'b'*32},{'session':'wrong'}])
def test_completed_recovery_context_mismatch_stops_before_read(recovery,monkeypatch,change):
    prior,board,cfg,account,updates=recovery
    p=storage.ROOT/'activation'/(prior['uid']+'.json')
    storage.save_json(p,storage.read_json(p)|change)
    monkeypatch.setattr(modem,'verify_runtime',lambda *a:pytest.fail('wrong context'))
    with pytest.raises(OSError):modem.resume_activation(board,cfg,None,account,None,prior)


def test_fallback_rejects_changed_imei_before_reset(clock,monkeypatch):
    commands=setup_switch(monkeypatch);reads=[]
    def identity(*a,**kw):
        reads.append(1);return ('1'*15 if len(reads)==1 else '2'*15),'RingHi'
    monkeypatch.setattr(modem,'identity',identity)
    def resolve(mode):
        if mode=='download':raise ports.NotReady('not yet')
        return NS(path='COM1')
    monkeypatch.setattr(modem,'open_ready',lambda lookup,*a,**k:nullcontext(lookup()))
    with pytest.raises(OSError,match='IMEI'):modem.enter_download(resolve,'1'*15,Cancel(),lambda s:None)
    assert commands==['AT^AUTODL']


@pytest.mark.parametrize('complete',[False,True])
def test_recovery_reset_failure_keeps_primary_error_or_completed_phase(recovery,monkeypatch,complete):
    prior,board,cfg,account,updates=recovery
    path=storage.ROOT/'activation'/(prior['uid']+'.json')
    if not complete:storage.save_json(path,storage.read_json(path)|{'stage':'key-requesting'})
    account.choose_route=lambda *a:None
    monkeypatch.setattr(modem,'open_ready',lambda *a,**kw:nullcontext(object()))
    class D:
        broken=False
        def __init__(self,*a):pass
        def bootstrap(self,*a):pass
        def send(self,*a,**kw):return 0x83,bytes.fromhex(prior['uid'])
        def reset(self):raise OSError('reset failed')
    monkeypatch.setattr(modem,'Download',D)
    def activate(*a):raise OSError('activation primary failure')
    monkeypatch.setattr(modem,'activate',activate)
    with pytest.raises(OSError,match='reset failed' if complete else 'activation primary failure'):
        modem.resume_activation(board,cfg,None,account,None,prior,already_download=True)
    if complete:
        assert storage.read_json(storage.ROOT/'ml-intents'/(prior['imei']+'.json'))['phase']=='awaiting-verification'
        assert storage.read_json(path)['stage']=='complete'
    else:assert storage.read_json(path)['stage']=='key-requesting'


def test_cancellation_during_missing_download_stops_wait(clock,monkeypatch):
    commands=setup_switch(monkeypatch);cancel=Cancel()
    def resolve(mode):
        if mode=='download':
            cancel.cancel();raise ports.NotReady('removed')
        return NS(path='COM1')
    monkeypatch.setattr(modem,'open_ready',lambda lookup,*a,**k:nullcontext(lookup()))
    with pytest.raises(Cancelled):modem.enter_download(resolve,'1'*15,cancel,lambda s:None)
    assert commands==['AT^AUTODL']


def test_reset_waits_for_ack_before_transport_can_close(clock):
    from ringhi.protocol import Download,frame
    events=[]
    def read():events.append('ack-read');return frame(0x80,b'',False)
    w=NS(write=lambda b:events.append('reset-sent'),read=read)
    assert Download(w,Cancel()).reset() is True
    assert events==['reset-sent','ack-read']


def test_reset_disconnect_or_silence_still_requires_runtime_verification(clock):
    from ringhi.protocol import Download
    def read():
        err=OSError('removed');err.winerror=1167;raise err
    assert Download(NS(write=lambda b:None,read=read),Cancel()).reset() is False
    def silence():clock.now+=.2;return b''
    assert Download(NS(write=lambda b:None,read=silence),Cancel()).reset() is False
    assert clock.now>=3


def test_reset_rejection_never_replayed(clock):
    from ringhi.protocol import Download,frame
    sent=[]
    with pytest.raises(OSError,match='复位命令被拒绝'):
        Download(NS(write=sent.append,read=lambda:frame(0x99,b'',False)),Cancel()).reset()
    assert len(sent)==1


@pytest.mark.parametrize('code',[995,1167,31,6])
def test_windows_reset_disconnect_is_not_flash_success(code,clock):
    import serial
    from ringhi.protocol import Download
    sent=[]
    def read():raise serial.SerialException(f"ClearCommError failed (OSError(22, 'I/O aborted', None, {code}))")
    assert Download(NS(write=sent.append,read=read),Cancel()).reset() is False
    assert len(sent)==1


def test_same_windows_995_during_flash_command_still_fails(clock):
    import serial
    from ringhi.protocol import Download
    sent=[]
    def read():raise serial.SerialException("ClearCommError failed (OSError(22, 'I/O aborted', None, 995))")
    d=Download(NS(write=sent.append,read=read),Cancel())
    with pytest.raises(serial.SerialException):d.send(2,b'flash-data')
    assert d.broken and len(sent)==1
