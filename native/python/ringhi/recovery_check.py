"""Explicit hardware diagnostic; no flash writes, authorization or cloud calls.

Run only on an idle workstation with exactly one test board attached. The test
resets that ESP32 into ROM and returns it to firmware at the end.
"""
import os,json,time,threading
from pathlib import Path
from dataclasses import replace
from ringhi import esp,ports
from ringhi.storage import Cancel,Cancelled
import serial,psutil


def run(output):
    output=Path(output)
    root=output.parent
    report={'hardwareWrites':0,'activationRequests':0,'tests':[]}
    logs=[]; c=Cancel(); target=None; mac=None

    def resolve():
        found,hubs=ports.scan()
        matches=[p for p in found if p.hub==target.hub and p.chip==target.chip and p.mode=='esp']
        if target.hub not in hubs:raise Cancelled('test board removed')
        if any(p.hub_node!=target.hub_node for p in matches):raise Cancelled('connection changed')
        return ports.select(found,target.hub,target.chip,'esp')

    def test(name,fn):
        t=time.monotonic();fn()
        report['tests'].append({'name':name,'passed':True,'seconds':round(time.monotonic()-t,2)})

    try:
        if any(p.pid != os.getpid() and p.info['name'] in ('RingHi.exe','esptool.exe','espflash.exe','RecoveryBatch.exe') for p in psutil.process_iter(['name'])):
            raise RuntimeError('Application or hardware worker active')
        found,_=ports.scan(); targets=[p for p in found if p.mode=='esp']
        if len(targets)!=1:raise RuntimeError('Expected exactly one test board')
        target=targets[0]
        mac=esp.identify(resolve,c,log=logs.append)
        for i in range(3):
            test('same-board-stub-reconnect-'+str(i+1), lambda: esp.identify(resolve,c,expected=mac,before='no-reset',log=logs.append))
        def busy():
            port=serial.Serial(port=None,baudrate=115200,timeout=.1)
            port.dtr=False;port.rts=False;port.port=resolve().path;port.open()
            done=threading.Event()
            def release():
                time.sleep(3);port.close();done.set()
            thread=threading.Thread(target=release);thread.start()
            try:
                assert esp.identify(resolve,c,expected=mac,log=logs.append)==mac
                assert done.is_set()
            finally:
                thread.join(5);port.close()
        test('held-port-released-without-usb-unplug',busy)
        test('official-usb-download-reset-and-reconnect',lambda:esp.identify(resolve,c,expected=mac,before='usb-reset',log=logs.append))
        def stale():
            first=[True]
            def lookup():
                p=resolve()
                if first[0]:first[0]=False;return replace(p,path='COM65534')
                return p
            assert esp.identify(lookup,c,expected=mac,log=logs.append)==mac
        test('stale-com-path-refresh-without-usb-unplug',stale)
        test('final-reset-to-firmware',lambda:esp.reset(resolve,c,expected=mac))
        report.update(passed=True,sameDeviceConfirmed=True)
    except Exception as exc:
        report.update(passed=False,errorType=type(exc).__name__)
        logs.append(str(exc))
        if target and mac:
            try:esp.reset(resolve,Cancel(),expected=mac)
            except Exception as cleanup:logs.append(str(cleanup))
    finally:
        root.mkdir(exist_ok=True,parents=True)
        output.write_text(json.dumps(report,indent=2),encoding='utf-8')
        # Device-local details stay on this Windows computer, never printed or transferred.
        output.with_suffix('.local.log').write_text('\n'.join(logs),encoding='utf-8')

    return 0 if report.get('passed') else 1
