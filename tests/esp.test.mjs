import test from 'node:test';import assert from 'node:assert/strict';import {EspFlasher} from '../renderer/esp.mjs';
const entries=[{enabled:true,name:'merged.bin',address:'0x0',bytes:new Uint8Array([1,2,3,4])}];
test('ESP writes compressed selected ranges, verifies MD5 and resets after verification',async()=>{const events=[],esp=new EspFlasher();esp.chip='ESP32-S3';esp.loader={async writeFlash(options){assert.equal(options.eraseAll,false);assert.equal(options.compress,true);assert.equal(options.calculateMD5Hash(entries[0].bytes),'08d6c05a21512a79a1dfeb9d2a8f262f');events.push('verify');},async after(){events.push('reset');}};esp.transport={async disconnect(){events.push('close');}};const result=await esp.flash(entries);assert.deepEqual(events,['verify','reset','close']);assert.equal(result.verification,'md5-passed');assert.equal(esp.loader,null);});
test('ESP interrupted write never requests reset or retries and releases port',async()=>{let writes=0,resets=0,closed=0;const esp=new EspFlasher();esp.loader={async writeFlash(){writes++;throw Error('disconnect');},async after(){resets++;}};esp.transport={async disconnect(){closed++;}};await assert.rejects(esp.flash(entries),e=>e.verification==='unconfirmed');assert.equal(writes,1);assert.equal(resets,0);assert.equal(closed,1);});
test('ESP reset failure retains verification result without reporting full success',async()=>{const esp=new EspFlasher();esp.loader={async writeFlash(){},async after(){throw Error('reset failed');}};await assert.rejects(esp.flash(entries),e=>e.verification==='md5-passed'&&e.reset==='unconfirmed');});

test('production defers ESP reset and retains ROM connection until coordinator releases it',async()=>{const events=[],esp=new EspFlasher();esp.loader={async writeFlash(){events.push('verify');},async after(){events.push('reset');}};esp.transport={async disconnect(){events.push('close');}};const result=await esp.flash(entries,{deferReset:true});assert.equal(result.reset,'deferred');assert.deepEqual(events,['verify']);assert(esp.loader);await esp.resetAfterProbe();await esp.disconnect();assert.deepEqual(events,['verify','reset','close']);});

test('S3 native USB uses bounded compressed blocks with MD5, while other transports keep their policy',async()=>{
 for(const [chip,vid,pid,expected] of [['ESP32-S3',0x303a,0x1001,4096],['ESP32-S3',0x10c4,0xea60,16384],['ESP32-C3',0x303a,0x1001,16384]]){
  const esp=new EspFlasher();let calls=0;esp.transport={device:{getInfo:()=>({usbVendorId:vid,usbProductId:pid})},async disconnect(){}};
  esp.loader={chip:{CHIP_NAME:chip},FLASH_WRITE_SIZE:16384,async writeFlash(opts){calls++;assert.equal(this.FLASH_WRITE_SIZE,expected);assert.equal(opts.compress,true);assert.equal(opts.eraseAll,false);assert.equal(opts.calculateMD5Hash(entries[0].bytes),'08d6c05a21512a79a1dfeb9d2a8f262f');}};
  const result=await esp.flash(entries,{deferReset:true});assert.equal(result.verification,'md5-passed');assert.equal(calls,1);await esp.disconnect();
 }
});
test('checksum rejection remains failure, is explained, and is never automatically retried or reset',async()=>{
 const esp=new EspFlasher();let calls=0,closed=0;esp.loader={async writeFlash(){calls++;throw Error('Failed to write compressed data to flash after seq 22 failed with status 193,0');},async after(){throw Error('must not reset an incomplete image');}};esp.transport={async disconnect(){closed++;}};
 await assert.rejects(esp.flash(entries),e=>e.message.includes('数据块校验失败')&&e.message.includes('seq 22')&&e.verification==='unconfirmed'&&e.reset==='not-requested');assert.equal(calls,1);assert.equal(closed,1);
});

test('100 percent is withheld until MD5 and reset complete, retry count survives success and failure',async()=>{
 const values=[],stages=[],esp=new EspFlasher({progress:n=>values.push(n),stage:s=>stages.push(s)});esp.loader={async writeFlash(o){o.reportProgress(0,4,4);assert.deepEqual(values,[99]);this.checksumRetries=2;},async after(){assert.equal(values.at(-1),99);}};const result=await esp.flash(entries);assert.equal(values.at(-1),100);assert.equal(result.checksumRetries,2);assert(stages.some(s=>s.includes('等待写入应答')));
 const bad=new EspFlasher();bad.loader={async writeFlash(){this.checksumRetries=2;throw Error('checksum exhausted');}};await assert.rejects(bad.flash(entries),e=>e.checksumRetries===2&&e.verification==='unconfirmed');
});
