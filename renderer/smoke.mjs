// Read-only diagnostics. Never requests a device, opens a port, or claims activation.
import {Job} from '../core/job.mjs';
import {planFlashEntries} from './upstream/esp-flash-core.mjs';
export async function runSmoke({mlRoot,ml,esp}){
 const checks=[];const check=(name,value)=>{checks.push({name,passed:!!value});if(!value)throw Error(name);};
 check('secure local context',isSecureContext);check('desktop bridge',!!window.ringhi);
 check('USB available',!!navigator.usb);check('serial available',!!navigator.serial);check('directory picker available',typeof showDirectoryPicker==='function');
 check('activation enabled by default',document.getElementById('activate').checked);check('empty task cannot start',document.getElementById('run').disabled);
 check('ML307H backup and confirmation controls mounted',!!mlRoot.getElementById('directory')&&!!mlRoot.getElementById('consent'));
 check('ML307H not ready without hardware',!ml.snapshot().ready);check('ESP32 has no open transport',!esp.loader);
 check('Windows AT default',window.ringhi.platform!=='win32'||mlRoot.getElementById('at-transport').value==='serial');
 let rejected=false;try{planFlashEntries([{enabled:true,name:'a.bin',address:'0x0',bytes:new Uint8Array(8)},{enabled:true,name:'b.bin',address:'0x4',bytes:new Uint8Array(8)}]);}catch{rejected=true;}check('overlapping firmware blocked',rejected);
 const j=new Job('dual','SOFTWARE-SMOKE');j.start('ml307h');j.fail('ml307h','Simulated failure');check('ML failure prevents ESP execution',j.record.steps[1].status==='skipped');
 const ports=await navigator.serial.getPorts();const devices=await navigator.usb.getDevices();
 const topology=await window.ringhi.nativeBatch('diagnose',{mode:'dual',filters:[{vendorId:0x303a,productId:0x1001}]});check('native USB / serial topology available',topology.ok&&topology.data.available);
 const stored=await window.ringhi.history();check('journal readable',Array.isArray(stored));
 return {passed:checks.every(c=>c.passed),checks,authorizedSerialPorts:ports.length,authorizedUsbDevices:devices.length,nativeTopology:topology.data,physicalFlashing:'not-performed',activation:'not-requested',productionTest:'not-run'};
}
