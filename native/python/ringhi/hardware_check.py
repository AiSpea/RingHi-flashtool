"""Explicit complete hardware validation, using selected firmware on one idle board.

This writes both chips and performs activation/production/cloud checks. It is not
an automatic startup diagnostic. Device details remain on the test workstation.
"""
import json, os, time
from pathlib import Path
from . import storage, ports, esp
from .account import Account, Prepared, load_credentials
from .batch import Batch, Config
from .package import Package
from .storage import Cancel


def run(output):
    import psutil
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    report={'finished':False,'passed':False,'phase':'preflight'}
    batch=None;prepared=None;account=None
    def save():storage.save_json(output,report)
    save()
    try:
        if any(p.pid!=os.getpid() and p.info['name'] in ('RingHi.exe','esptool.exe','espflash.exe','RecoveryBatch.exe') for p in psutil.process_iter(['name'])):
            raise RuntimeError('Another application or hardware task is active')
        settings=storage.read_json(storage.ROOT/'settings.json',{})
        found,_=ports.scan();hubs={p.hub for p in found if p.mode=='esp'}
        if len(hubs)!=1:raise RuntimeError('Expected exactly one test board')
        hub=next(iter(hubs))
        if any(p.hub!=hub for p in found if p.mode in ('download','runtime','generic')):
            raise RuntimeError('Another modem is attached')
        cfg=Config(Path(settings['esp']),Path(settings['ml']),Path(settings['backup']),
                   mode='dual',production=True,limit=1,product_type=settings['productType'])
        cfg.image=cfg.esp_path.read_bytes();esp.validate_image(cfg.image)
        cfg.package=Package(cfg.ml_path.read_bytes())
        cfg.backup.mkdir(exist_ok=True,parents=True)
        csv=Path.home()/'Documents'/('RingHi-Validation-'+time.strftime('%Y%m%d-%H%M%S')+'.csv')
        if csv.exists():raise RuntimeError('CSV path already exists')
        # Same order as the UI: CSV must be writable before any authorization.
        storage.atomic(csv,storage.csv_bytes([]))
        report.update(phase='authorization',csvSaved=True);save()
        account=Account();account.login(load_credentials())
        if account.project<=0:raise RuntimeError('No saved authorization project')
        prepared=Prepared(account,Cancel(),lambda s:None)
        def scanner():
            ps,hs=ports.scan()
            return [p for p in ps if p.hub==hub],{h for h in hs if h==hub}
        batch=Batch(cfg,account,prepared,csv,scanner=scanner)
        prepared=None # Batch owns prepared-material cleanup.
        batch.start();deadline=time.monotonic()+480;last=None
        while time.monotonic()<deadline:
            rows=batch.snapshots()
            if rows:
                if len(rows)!=1:raise RuntimeError('Test board connection changed')
                row=rows[0]
                current=(row['result'],row['espProgress'],row['mlProgress'],bool(row['endedAt']))
                if current!=last:
                    report.update(phase=current[0],espProgress=current[1],mlProgress=current[2]);save();last=current
                if current[3]:break
            time.sleep(.5)
        else:raise TimeoutError('Hardware validation timeout')
        batch.close();row=batch.snapshots()[0]
        storage.save_json(output.with_suffix('.local.json'),row)
        report.update(finished=True,passed=row['result']=='成功',
                      espComplete=row['espProgress']==100,mlComplete=row['mlProgress']==100,
                      cloudComplete=row['cloud']=='登记和报告上传成功',
                      productionEnabled=True,productType=cfg.product_type,
                      csvSaved=csv.is_file())
    except Exception as exc:
        report.update(finished=True,errorType=type(exc).__name__)
        output.with_suffix('.local.log').write_text(str(exc),encoding='utf-8')
    finally:
        if batch:batch.close()
        if prepared:prepared.close()
        if account:account.close_current()
        save()
    return 0 if report['passed'] else 1
