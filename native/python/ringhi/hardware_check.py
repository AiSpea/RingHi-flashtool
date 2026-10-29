"""Explicit complete hardware validation, using selected firmware on explicitly counted idle boards.

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


def run(output, expected_boards=1, flash_only=False):
    import psutil
    output=Path(output);output.parent.mkdir(parents=True,exist_ok=True)
    report={'finished':False,'passed':False,'phase':'preflight',
            'expectedBoards':expected_boards,'productionEnabled':not flash_only}
    batch=None;prepared=None;account=None
    def save():storage.save_json(output,report)
    save()
    try:
        if any(p.pid!=os.getpid() and p.info['name'] in ('RingHi.exe','esptool.exe','espflash.exe','RecoveryBatch.exe') for p in psutil.process_iter(['name'])):
            raise RuntimeError('Another application or hardware task is active')
        settings=storage.read_json(storage.ROOT/'settings.json',{})
        found,_=ports.scan();hubs={p.hub for p in found if p.mode=='esp'}
        if not 1<=expected_boards<=8:raise ValueError('Expected board count must be 1..8')
        if len(hubs)!=expected_boards:raise RuntimeError('Attached board count differs from explicit request')
        if any(p.hub not in hubs for p in found if p.mode in ('download','runtime','generic')):
            raise RuntimeError('Another modem is attached')
        cfg=Config(Path(settings['esp']),Path(settings['ml']),Path(settings['backup']),
                   mode='dual',production=not flash_only,limit=expected_boards,product_type=settings['productType'])
        cfg.image=cfg.esp_path.read_bytes();esp.validate_image(cfg.image)
        cfg.package=Package(cfg.ml_path.read_bytes())
        cfg.backup.mkdir(exist_ok=True,parents=True)
        csv=Path.home()/'Documents'/('RingHi-Validation-'+time.strftime('%Y%m%d-%H%M%S')+'.csv')
        if csv.exists():raise RuntimeError('CSV path already exists')
        # Same order as the UI: CSV must be writable before any authorization.
        storage.create_batch_csv(csv)
        report.update(phase='authorization',csvSaved=True);save()
        account=Account();account.login(load_credentials())
        if account.project<=0:raise RuntimeError('No saved authorization project')
        prepared=Prepared(account,Cancel(),lambda s:None)
        def scanner():
            ps,hs=ports.scan()
            return [p for p in ps if p.hub in hubs],hs & hubs
        batch=Batch(cfg,account,prepared,csv,scanner=scanner)
        prepared=None # Batch owns prepared-material cleanup.
        batch.start();deadline=time.monotonic()+900;last=None;started=time.monotonic()
        peak=0;peak_ml=0;peak_esp=0
        while time.monotonic()<deadline:
            rows=batch.snapshots()
            if len(rows)>expected_boards:raise RuntimeError('Test board connection changed')
            # Public summary contains only task number/stage, never device IDs.
            compact=[{k:r.get(k) for k in ('task','result','espProgress','mlProgress')}
                     | {'finished':bool(r.get('endedAt'))} for r in rows]
            peak=max(peak,sum(not r['finished'] and r['result']=='烧录中' for r in compact))
            peak_ml=max(peak_ml,sum(0<r['mlProgress']<100 and not r['finished'] for r in compact))
            peak_esp=max(peak_esp,sum(0<r['espProgress']<100 and not r['finished'] for r in compact))
            if compact!=last:
                report.update(phase='hardware',boards=compact,peakParallelBoards=peak,
                              peakParallelMl=peak_ml,peakParallelEsp=peak_esp,
                              elapsedSeconds=round(time.monotonic()-started,1))
                save();last=compact
            if len(rows)==expected_boards and all(r.get('endedAt') for r in rows):break
            time.sleep(.5)
        else:raise TimeoutError('Hardware validation timeout')
        batch.close();rows=batch.snapshots()
        storage.save_json(output.with_suffix('.local.json'),rows)
        downloads=all(r['espProgress']==100 and r['mlProgress']==100 for r in rows)
        completed=all(r['result']=='成功' for r in rows)
        report.update(finished=True,passed=downloads and completed,
                      wholeBoardPassed=completed and not flash_only,
                      espComplete=sum(r['espProgress']==100 for r in rows),
                      mlComplete=sum(r['mlProgress']==100 for r in rows),
                      unconfirmedResetReceipts=sum(r.get('mlResetReceipt')=='unconfirmed' for r in rows),
                      resetDriver22Count=sum('None, 22' in r.get('mlResetDetail','') for r in rows),
                      cloudComplete=sum(r['cloud']=='登记和报告上传成功' for r in rows),
                      productType=cfg.product_type,csvSaved=csv.is_file(),
                      elapsedSeconds=round(time.monotonic()-started,1))
    except Exception as exc:
        report.update(finished=True,errorType=type(exc).__name__)
        output.with_suffix('.local.log').write_text(str(exc),encoding='utf-8')
    finally:
        if batch:batch.close()
        if prepared:prepared.close()
        if account:account.close_current()
        save()
    return 0 if report['passed'] else 1
