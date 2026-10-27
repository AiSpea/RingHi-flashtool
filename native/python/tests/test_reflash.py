"""Recovery regressions from real slot-1 IMEI aliasing and pending activation."""
from types import SimpleNamespace
import pytest
from ringhi import wire, storage, modem, account
from ringhi.storage import Cancel


@pytest.mark.parametrize('initial_slot', [0, 1])
def test_flash_identity_uses_primary_slot_before_return(monkeypatch, initial_slot):
    state = {'slot': initial_slot}
    commands = []
    def identity(*a, **kw):
        return ('1' * 15 if state['slot'] == 0 else '2' * 15, 'RingHi test')
    def at(w, cmd, c, **kw):
        commands.append(cmd)
        if cmd == 'AT^SIMSLOT?': return f'\r\n^SIMSLOT: {state["slot"]}\r\nOK\r\n'
        if cmd == 'AT^SIMSLOT=0': state['slot'] = 0
        return 'OK'
    monkeypatch.setattr(wire, 'identity', identity)
    monkeypatch.setattr(wire, 'at', at)
    assert wire.flash_identity(None, Cancel())[0] == '1' * 15
    assert commands == (['AT^SIMSLOT?', 'AT^SIMSLOT=0', 'AT^AEM=1,"ACT"', 'AT^SIMSLOT?']
                        if initial_slot else ['AT^SIMSLOT?'])


def test_stock_identity_does_not_change_slot(monkeypatch):
    monkeypatch.setattr(wire, 'identity', lambda *a: ('1' * 15, 'ML307H-DC-MBRH1S00'))
    monkeypatch.setattr(wire, 'at', lambda *a, **k: pytest.fail('stock path must stay read-only'))
    assert wire.flash_identity(None, Cancel())[0] == '1' * 15


@pytest.mark.parametrize('failure', ['query', 'select', 'activate', 'not-restored'])
def test_slot_restore_must_be_confirmed(monkeypatch, failure):
    monkeypatch.setattr(wire, 'identity', lambda *a, **k: ('2' * 15, 'RingHi'))
    def at(w, cmd, c, **kw):
        if (cmd == 'AT^SIMSLOT?' and failure == 'query'
            or cmd == 'AT^SIMSLOT=0' and failure == 'select'
            or cmd == 'AT^AEM=1,"ACT"' and failure == 'activate'):
            raise TimeoutError('not acknowledged')
        return '^SIMSLOT: 1\r\nOK' if cmd == 'AT^SIMSLOT?' else 'OK'
    monkeypatch.setattr(wire, 'at', at)
    with pytest.raises((OSError, TimeoutError)):
        wire.flash_identity(None, Cancel())


def ledger(tmp_path, **overrides):
    return dict(uid='a' * 32, project_id=188, stage='key-requesting',
                session=str(tmp_path), device_written=False) | overrides


@pytest.mark.parametrize('changes', [{'uid': 'b' * 32}, {'project_id': 184},
                                    {'stage': 'unrecognized'}, {'session': ''}])
def test_activation_context_mismatch_makes_no_network_or_device_calls(tmp_path, monkeypatch, changes):
    monkeypatch.setattr(storage, 'ROOT', tmp_path)
    storage.save_json(tmp_path / 'activation' / ('a' * 32 + '.json'), ledger(tmp_path, **changes))
    with pytest.raises(OSError):
        account.activate(None, 'a' * 32, tmp_path, SimpleNamespace(project=188), None, Cancel(), print)


def test_pending_preflight_checks_project_backup_mac_and_package(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, 'ROOT', tmp_path)
    prior = dict(uid='a' * 32, backup=str(tmp_path), mac='fixture-mac', firmwareSha256='package')
    storage.save_json(tmp_path / 'activation' / ('a' * 32 + '.json'), ledger(tmp_path))
    calls = []
    monkeypatch.setattr(modem, 'original_backups', lambda *a: calls.append('backup-checked'))
    board = SimpleNamespace(mac='fixture-mac')
    cfg = SimpleNamespace(package=SimpleNamespace(digest='package'))
    assert modem.pending_context(board, cfg, prior, 188)['stage'] == 'key-requesting'
    assert calls == ['backup-checked']
    for bad, project in [(prior, 184), (prior | {'mac': 'other'}, 188),
                         (prior | {'backup': 'other'}, 188), (prior | {'firmwareSha256': 'other'}, 188)]:
        with pytest.raises(OSError):
            modem.pending_context(board, cfg, bad, project)
    assert calls == ['backup-checked']


def test_failed_archive_prevents_new_request(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, 'ROOT', tmp_path)
    storage.save_json(tmp_path / 'activation' / ('a' * 32 + '.json'), ledger(tmp_path))
    monkeypatch.setattr(account, 'save_json', lambda *a: (_ for _ in ()).throw(OSError('disk full')))
    with pytest.raises(OSError, match='disk full'):
        account.activate(None, 'a' * 32, tmp_path, SimpleNamespace(project=188), None, Cancel(), print)


@pytest.fixture
def alias_records(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, 'ROOT', tmp_path)
    p = SimpleNamespace(name='factory',capacity=4)
    pkg = SimpleNamespace(digest='pkg',protected=[p])
    backup = tmp_path/'backup';backup.mkdir();(backup/'factory.bin').write_bytes(b'DATA')
    verified = dict(mac='board',imei='1'*15,uid='a'*32,phase='verified',firmwareSha256='pkg',
        backup=str(backup),createdAt='2026-10-27T05:26:00+00:00',verifiedAt='2026-10-27T05:27:00+00:00',
        backups={'factory':dict(file=str(backup/'factory.bin'),sha256=storage.sha(b'DATA'))})
    old=verified|dict(imei='2'*15,phase='awaiting-verification',createdAt='2026-10-27T05:12:00+00:00')
    current=dict(mac='board',imei='1'*15,phase='preparing',firmwareSha256='pkg',
        createdAt='2026-10-27T07:09:00+00:00',previousBackup=str(backup))
    storage.save_json(backup/'session.json',verified)
    storage.save_json(tmp_path/'activation'/('a'*32+'.json'),dict(uid='a'*32,stage='complete'))
    return pkg, old, current, verified


def test_alias_resolves_only_with_later_verified_same_chip_backup(alias_records,tmp_path):
    pkg,old,current,verified=alias_records
    for r in (old,current):storage.save_json(tmp_path/'ml-intents'/(r['imei']+'.json'),r)
    result=modem.old_for_mac('board',pkg)
    assert result['imei']=='1'*15 and result['recoveryUid']=='a'*32
    assert modem.no_flash_written(result)
    assert storage.read_json(tmp_path/'ml-intents'/('2'*15+'.json'))==old
    assert modem.resolved_alias([old,verified],'board',pkg)['uid']=='a'*32


@pytest.mark.parametrize('change',[
    {'uid':'b'*32},{'phase':'writing'}, {'firmwareSha256':'wrong'},
    {'createdAt':'2026-10-27T08:00:00+00:00'}, {'createdAt':'invalid'},
])
def test_alias_does_not_hide_different_chip_or_newer_interrupted_write(alias_records,change):
    pkg,old,current,_=alias_records
    with pytest.raises(OSError):modem.resolved_alias([old|change,current],'board',pkg)


def test_alias_missing_or_corrupt_backup_stays_blocked(alias_records):
    pkg,old,current,verified=alias_records
    from pathlib import Path
    Path(verified['backup'],'factory.bin').write_bytes(b'BAD!')
    with pytest.raises(OSError):modem.resolved_alias([old,current],'board',pkg)


def test_resolved_alias_live_uid_mismatch_stops_before_backup_or_flash(tmp_path,monkeypatch):
    from contextlib import nullcontext
    monkeypatch.setattr(storage,'ROOT',tmp_path)
    prior=dict(mac='board',imei='1'*15,phase='preparing',backup='original',
               recoveryUid='a'*32,firmwareSha256='pkg')
    intent=tmp_path/'ml-intents'/('1'*15+'.json');storage.save_json(intent,prior)
    monkeypatch.setattr(modem,'old_for_mac',lambda *a:dict(prior))
    def resolve(mode):
        if mode=='runtime':raise modem.NotReady('download only')
        return SimpleNamespace(path='COM1')
    calls=[]
    class DL:
        def __init__(self,*a):pass
        def bootstrap(self,pkg):calls.append('RAM')
        def send(self,cmd,*a,**kw):
            assert cmd==18
            calls.append('UID');return 0x83,bytes.fromhex('b'*32)
        def backup(self,*a):pytest.fail('must not read backup after UID mismatch')
        def write(self,*a):pytest.fail('must not write after UID mismatch')
    monkeypatch.setattr(modem,'Download',DL)
    monkeypatch.setattr(modem,'open_ready',lambda *a,**k:nullcontext(object()))
    pkg=SimpleNamespace(digest='pkg',loaders=[],protected=[],writes=[])
    b=SimpleNamespace(cancel=Cancel(),mac='board',hub='hub',id='test',update=lambda **k:None)
    with pytest.raises(OSError,match='UID'):
        modem.run(b,SimpleNamespace(package=pkg,backup=tmp_path/'backups'),resolve,SimpleNamespace(project=188),None)
    assert calls==['RAM','UID'] and storage.read_json(intent)==prior
