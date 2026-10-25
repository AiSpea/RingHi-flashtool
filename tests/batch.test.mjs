import test from 'node:test';import assert from 'node:assert/strict';
import {BatchQueue} from '../core/batch.mjs';
import policy from '../desktop/batch-policy.cjs';
const entries=[{name:'firmware.bin',address:0,bytes:new Uint8Array([1,2,3])}];
const tick=()=>new Promise(r=>setTimeout(r,0));
async function drained(q){for(let n=0;n<100;n++){if(!q.running&&!q.queue.length)return;await tick();}throw Error('queue did not drain');}
function setup(extra={}){const records=[],writes=[];const q=new BatchQueue({entries,chip:'ESP32-S3',baud:460800,save:async r=>records.push(structuredClone(r)),createFlasher:()=>({async connect(_c,_b,port){this.mac=port.mac;this.port=port;if(port.bad)throw Error('chip mismatch');},async flash(){writes.push(this.port);if(this.port.fail)throw Error('disconnect');return {verification:'md5-passed',mac:this.mac};},async disconnect(){}}),...extra});return {q,records,writes};}
const port=n=>({mac:`00:11:22:33:44:${n.toString(16).padStart(2,'0').toUpperCase()}`});
test('parallel ports journal MAC before writes; same MAC never written twice',async()=>{
 const {q,records,writes}=setup();q.add(port(1),'a');q.add(port(1),'b');q.add(port(2),'c');await drained(q);
 assert.equal(writes.length,2);assert.equal(q.rows[1].state,'duplicate');
 for(const p of writes){const rows=records.filter(r=>r.serial===p.mac);assert.equal(rows[0].status,'running');assert.equal(rows.at(-1).status,'completed');assert.equal(rows.at(-1).steps[0].mac,p.mac);}
 q.stop();
});
test('one broken device does not stop other ports; failed MAC stays claimed after reconnect',async()=>{
 const {q,writes}=setup();const a={...port(1),fail:true};q.add(a,'a');q.add(port(2),'b');await drained(q);q.detach(a);q.add(port(1),'replug');await drained(q);
 assert.deepEqual(q.rows.map(r=>r.state),['failed','passed','duplicate']);assert.equal(writes.length,2);q.stop();
});
test('parallelism bound and stop drains in-flight writes but cancels queued ports',async()=>{
 let release;const gate=new Promise(r=>release=r);let count=0,max=0;
 const {q}=setup({limit:2,createFlasher:()=>({async connect(_c,_b,p){this.mac=p.mac;},async flash(){count++;max=Math.max(max,count);await gate;count--;return {};},async disconnect(){}})});
 for(let n=0;n<5;n++)q.add(port(n),'slot');await tick();assert.equal(count,2);q.stop();release();await drained(q);
 assert.equal(max,2);assert.deepEqual(q.rows.map(r=>r.state),['passed','passed','canceled','canceled','canceled']);assert.equal(q.busy,false);
});
test('disconnect while queued is never opened',async()=>{
 let release;const gate=new Promise(r=>release=r);const opened=[];
 const {q}=setup({limit:1,createFlasher:()=>({async connect(_c,_b,p){opened.push(p);this.mac=p.mac;await gate;},async flash(){return {};},async disconnect(){}})});
 const a=port(1),b=port(2);q.add(a,'a');q.add(b,'b');q.detach(b);release();await drained(q);assert.deepEqual(opened,[a]);q.stop();
});
test('stop during identity read prevents subsequent write',async()=>{
 let release;const gate=new Promise(r=>release=r);let writes=0;
 const {q}=setup({createFlasher:()=>({async connect(_c,_b,p){this.mac=p.mac;await gate;},async flash(){writes++;return {};},async disconnect(){}})});
 q.add(port(1),'a');await tick();q.stop();release();await drained(q);assert.equal(writes,0);assert.equal(q.rows[0].state,'canceled');
});
test('journal failure blocks writes and stops admission',async()=>{
 const {q,writes}=setup({save:async()=>{throw Error('disk full');}});q.add(port(1),'a');await drained(q);assert.equal(q.accepting,false);assert.equal(writes.length,0);assert.match(q.rows[0].message,/记录保存失败/);assert.equal(q.add(port(2),'b'),undefined);
});
test('wrong chip fails only its row without writes',async()=>{const {q,writes}=setup();q.add({...port(1),bad:true},'a');await drained(q);assert.equal(q.rows[0].state,'failed');assert.equal(writes.length,0);q.stop();});
test('polling a port repeatedly queues only one task; replug checks MAC again',async()=>{const {q,writes}=setup();const a=port(1);q.add(a,'a');q.add(a,'a');await drained(q);q.detach(a);q.add(a,'a');await drained(q);assert.equal(q.rows.length,2);assert.equal(writes.length,1);q.stop();});
test('batch access accepts exact serial VID/PID only, rejects ML USB and malformed filters',()=>{
 const f=policy.filters([{vendorId:0x303a,productId:0x1001}]);assert(policy.permits(f,'serial',{vendorId:'12346',productId:'4097'}));assert(!policy.permits(f,'usb',{vendorId:0x303a,productId:0x1001}));assert(!policy.permits(f,'serial',{vendorId:0x303a,productId:2}));assert(!policy.permits([],'serial',{vendorId:0x303a,productId:0x1001}));assert.throws(()=>policy.filters([{vendorId:0x3563,productId:0x2000}]));assert.throws(()=>policy.filters([]));
});
