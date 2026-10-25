import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {crc16,checksum16,frame,DownloadDecoder,partitionPayload,hex,md5,u32} from '../renderer/upstream/ml307h/protocol.mjs';
import {parsePackage,matchPackageProfile} from '../renderer/upstream/ml307h/package.mjs';
import {Downloader,BackupStore,burn} from '../renderer/upstream/ml307h/download.mjs';
import {UsbTransport,ByteQueue,parseIdentity} from '../renderer/upstream/ml307h/transport.mjs';
import {packageFixture} from './ml307h-fixtures.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const enc=new TextEncoder();
test('official ROM and MDL ACK fixtures use different checksums',()=>{
  assert.equal(crc16(enc.encode('123456789')),0x31c3);
  for(const [crc,wire] of [[true,'9f8e6d5c8000000038dd7e'],[false,'9f8e6d5c800000007fff7e']]){assert.equal(hex(frame(128,new Uint8Array(),crc)),wire);const d=new DownloadDecoder(crc),b=Uint8Array.from(Buffer.from(wire,'hex'));let out=[];for(const x of b)out.push(...d.feed(Uint8Array.of(x)));assert.equal(out.length,1);assert.equal(out[0].cmd,128);}
});
test('decoder rejects corruption and resynchronizes after noise',()=>{const b=frame(128);b[8]^=1;const d=new DownloadDecoder();const frames=d.feed(Uint8Array.from([1,2,...b,...frame(131,u32(42))]));assert.equal(frames.length,1);assert.equal(frames[0].cmd,131);assert.equal(d.invalid,1);});
test('partition form uses UTF16LE name and 64-bit size',()=>{const b=partitionPayload('calibration',2**32+3),v=new DataView(b.buffer);assert.equal(b.length,88);assert.equal(v.getUint16(0,true),99);assert.equal(v.getBigUint64(72,true),4294967299n);assert.throws(()=>partitionPayload('../bad'));assert.throws(()=>frame(2,new Uint8Array(65536)));});
test('legacy MD5 matches independent RFC/Node vectors',()=>{for(const s of ['', 'abc','a'.repeat(10000)])assert.equal(md5(enc.encode(s)),createHash('md5').update(s).digest('hex'));});
test('valid target packages support none/MD5/CRC integrity and immutable source bytes',async()=>{for(const auth of [0,1,2]){const b=packageFixture(auth),p=await parsePackage(b);assert.equal(p.auth,auth);assert.equal(p.writes.at(-1).name,'mbl');const old=p.payload(p.loaders[0]);b.fill(0);assert.deepEqual(p.payload(p.loaders[0]),old);}});
test('package auth failures are rejected',async()=>{for(const auth of [1,2]){const b=packageFixture(auth);b[b.length-1]^=1;await assert.rejects(parsePackage(b),/校验失败/);}});
test('package rejects malicious offsets, overlap, unknown auth and wrong board',async()=>{
  const cases=[b=>new DataView(b.buffer).setBigUint64(136+320,2n**63n,true),b=>new DataView(b.buffer).setBigUint64(136+464+320,BigInt(136+10*464),true),b=>new DataView(b.buffer).setUint32(88,9,true),b=>b.fill(0,16,48),b=>b.fill(0,136+10*464+64,136+10*464+96)];
  for(const modify of cases){const b=packageFixture(0);modify(b);await assert.rejects(parsePackage(b));}
});
test('selected protected partitions and absent MBL fail preflight',async()=>{for(const index of [5,9]){const b=packageFixture(0);new DataView(b.buffer).setUint32(136+index*464+428,index===5?1:0,true);await assert.rejects(parsePackage(b));}});
test('identity checks require correct project and exact IMEI',()=>{assert.equal(parseIdentity('project=test0817 OK','+CGSN: 123456789012345\r\nOK').imei,'123456789012345');assert.throws(()=>parseIdentity('other','123456789012345','test0817'));});
test('other boards load from PKG alone; legacy explicit profiles still validate',async()=>{
  const raw=packageFixture(2,{project:'sensor_app',board:'sensor_b',omit:['ap_extend','ap_extflash','factory_bak']});
  const p=await parsePackage(raw);assert.equal(p.compatibility.supported,true);assert.equal(p.compatibility.profile.board,null);assert.match(p.compatibility.reason,/请确认固件/);
  const autoDL=mockDL(),autoStore=new BackupStore(new MemoryDirectory());await burn(autoDL,p,autoStore,{imei:'123456789012345',version:'vendor firmware'});assert.ok(autoDL.ops.includes('write:ap'));assert.ok(!autoDL.ops.includes('write:ap_extend'));
  const config={schema:1,protocol:'ml307h-rom-v1',project:p.project,board:'sensor_b',firmwareSha256:p.digest,requiredImages:['ap']};
  const supported=await parsePackage(raw,{profile:config});assert.equal(supported.compatibility.profile.board,'sensor_b');
  const dl=mockDL(),store=new BackupStore(new MemoryDirectory());
  await burn(dl,supported,store,{imei:'123456789012345',version:'sensor_b v1.2.3'});
  assert.ok(dl.ops.includes('backup:factory'));assert.ok(!dl.ops.includes('backup:factory_bak'));assert.ok(!dl.ops.includes('write:ap_extflash'));assert.deepEqual(dl.ops.slice(-2),['write:mbl','reset']);
  assert.equal(parseIdentity('sensor_b v1.2.3','123456789012345','sensor_b').imei,'123456789012345');
  assert.throws(()=>parseIdentity('sensor_b_pro v1.2.3','123456789012345','sensor_b'),/板型/);
  for(const changes of [{firmwareSha256:'0'.repeat(64)},{project:'wrong'},{board:'other'},{requiredImages:['ap','absent']},{protocol:'unknown'}])assert.equal(matchPackageProfile(p,{...config,...changes}).supported,false);
});
test('unsupported target and wrong physical board send no download commands',async()=>{
  const p=await parsePackage(packageFixture(2,{project:'sensor_app',board:'sensor_b'}),{inspectOnly:true}),dl=mockDL();
  p.compatibility={supported:false,profile:null};
  await assert.rejects(burn(dl,p,new BackupStore(new MemoryDirectory()),identity),/适配/);assert.deepEqual(dl.ops,[]);
  p.compatibility=matchPackageProfile(p,{schema:1,protocol:'ml307h-rom-v1',project:p.project,board:'sensor_b',firmwareSha256:p.digest,requiredImages:['ap']});
  await assert.rejects(burn(dl,p,new BackupStore(new MemoryDirectory()),identity),/适配/);assert.deepEqual(dl.ops,[]);
});
test('custom profile persists across preparation and recovery; changed profile is rejected',async()=>{
  const p=await parsePackage(packageFixture(2,{project:'sensor_app',board:'sensor_b'}),{inspectOnly:true});
  p.compatibility=matchPackageProfile(p,{schema:1,protocol:'ml307h-rom-v1',project:p.project,board:'sensor_b',firmwareSha256:p.digest,requiredImages:['ap']});
  const root=new MemoryDirectory(),store=new BackupStore(root),boardIdentity={...identity,version:'sensor_b v1.2.3'};
  await store.prepare(p,boardIdentity);const record=JSON.parse(new TextDecoder().decode(root.files.get('preparation.json')));
  assert.equal(record.profile.board,'sensor_b');assert.equal((await new BackupStore(root).recover(record,p)).version,boardIdentity.version);
  p.compatibility.profile.requiredImages.push('ap_extend');
  await assert.rejects(new BackupStore(root).recover(record,p),/配置不匹配/);
});
test('USB packet writes split 99 bytes, add ZLP only at exact boundary',async()=>{
  const calls=[],usb=Object.create(UsbTransport.prototype);Object.assign(usb,{closed:false,failed:false,output:{packetSize:64,endpointNumber:1},device:{transferOut:async(n,b)=>{calls.push(b.length);return {status:'ok',bytesWritten:b.length};}}});
  await usb.write(new Uint8Array(99));assert.deepEqual(calls,[64,35]);calls.length=0;await usb.write(new Uint8Array(128));assert.deepEqual(calls,[64,64,0]);
});
test('short USB write poisons session without retry',async()=>{let count=0;const usb=Object.create(UsbTransport.prototype);Object.assign(usb,{closed:false,failed:false,queue:new ByteQueue(),output:{packetSize:64,endpointNumber:1},device:{close:async()=>{},transferOut:async()=>{count++;return {status:'ok',bytesWritten:2};}}});await assert.rejects(usb.write(new Uint8Array(99)),/短写/);await assert.rejects(usb.write(new Uint8Array(99)));assert.equal(count,1);});
test('lost command ACK is never replayed',async()=>{let writes=0;const dl=new Downloader({write:async()=>writes++,read:async()=>{throw Error('timeout');}});await assert.rejects(dl.transaction(2,Uint8Array.of(1)));await assert.rejects(dl.transaction(2,Uint8Array.of(1)));assert.equal(writes,1);});
test('ROM accepts bounded raw HandshakeROM banner then validates CRC CONNECT',async()=>{const responses=[enc.encode('Handshake'),enc.encode('ROM\r\n'),frame(128,new Uint8Array(),true)],writes=[];const dl=new Downloader({write:async b=>writes.push(b),read:async()=>responses.shift()});await dl.handshake(true);assert.equal(writes.length,2);assert.equal(hex(writes[1]),hex(frame(0,new Uint8Array(),true)));});
class MemoryDirectory {
  constructor(){this.files=new Map();this.dirs=new Map();}
  async getDirectoryHandle(n,{create}={}){if(!this.dirs.has(n)){if(!create)throw new DOMException('missing','NotFoundError');this.dirs.set(n,new MemoryDirectory());}return this.dirs.get(n);}
  async getFileHandle(n,{create}={}){if(!this.files.has(n)){if(!create)throw new DOMException('missing','NotFoundError');this.files.set(n,new Uint8Array());}const files=this.files;return {getFile:async()=>{const b=files.get(n);return new Blob([b]);},createWritable:async()=>({write:async b=>{files.set(n,b.slice());},close:async()=>{},abort:async()=>{}})};}
}
const identity={imei:'123456789012345',version:'test0817 v1.2.3'};
function mockDL(status=128){const ops=[];return {ops,log:()=>{},bootstrap:async()=>ops.push('bootstrap'),transaction:async(cmd,payload)=>{ops.push(cmd);return {cmd:cmd===15?status:cmd===18?131:128,payload:cmd===18?new Uint8Array(16).fill(7):new Uint8Array()};},backup:async e=>{ops.push('backup:'+e.name);return new Uint8Array(e.capacity).fill(7);},writePartition:async(name)=>ops.push('write:'+name),reset:async()=>ops.push('reset')};}
test('activation hook runs after firmware and restoration, before reset; off omits hook',async()=>{
  const p=await parsePackage(packageFixture()),dl=mockDL(),store=new BackupStore(new MemoryDirectory());
  await burn(dl,p,store,identity,{activate:async(d,s)=>{assert.equal(s.state.phase,'awaiting-verification');assert.equal(d.ops.at(-1),'write:mbl');d.ops.push('activate');}});
  assert.deepEqual(dl.ops.slice(-3),['write:mbl','activate','reset']);
});
test('activation failure keeps firmware completion and only resets a healthy transport',async()=>{
  const p=await parsePackage(packageFixture());
  for(const broken of [false,true]){const dl=mockDL(),store=new BackupStore(new MemoryDirectory());await assert.rejects(burn(dl,p,store,identity,{activate:async()=>{dl.broken=broken;store.state.activation={status:'unconfirmed'};await store.saveState();throw Error('activation failed');}}),/activation failed/);assert.equal(store.state.phase,'awaiting-verification');assert.equal(dl.ops.includes('reset'),!broken);}
});
test('a persisted activation journal blocks recovery writes and repeated activation',async()=>{
  const p=await parsePackage(packageFixture()),root=new MemoryDirectory(),store=new BackupStore(root);await burn(mockDL(),p,store,identity);store.state.activation={status:'unconfirmed'};await store.saveState();const dl=mockDL();await assert.rejects(burn(dl,p,new BackupStore(root),identity,{activate:async()=>{throw Error('must not run');}}),/激活记录/);assert(!dl.ops.some(x=>typeof x==='string'&&x.startsWith('write:')));
});
test('full burn backs up first, restores protection and writes MBL last',async()=>{const pkg=await parsePackage(packageFixture()),root=new MemoryDirectory(),store=new BackupStore(root),dl=mockDL(177);await burn(dl,pkg,store,identity);assert.ok(dl.ops.indexOf('backup:factory_bak')<dl.ops.indexOf(14));assert.ok(dl.ops.indexOf(14)<dl.ops.indexOf('write:ap'));assert.ok(dl.ops.indexOf('write:factory')<dl.ops.indexOf('write:mbl'));assert.deepEqual(dl.ops.slice(-2),['write:mbl','reset']);assert.equal(store.state.phase,'awaiting-verification');});
test('backup failure stops all erase/write commands',async()=>{const pkg=await parsePackage(packageFixture()),dl=mockDL(177),store=new BackupStore(new MemoryDirectory());store.save=async()=>{throw Error('disk full');};await assert.rejects(burn(dl,pkg,store,identity),/disk full/);assert.ok(!dl.ops.includes(14));assert.ok(!dl.ops.some(x=>typeof x==='string'&&x.startsWith('write:')));});
test('corrupt/empty tables and mismatched recovery UID are rejected',async()=>{const p=await parsePackage(packageFixture());for(const code of [176,178,133]){const dl=mockDL(code);await assert.rejects(burn(dl,p,new BackupStore(new MemoryDirectory()),identity),/分区表/);assert.ok(!dl.ops.some(x=>typeof x==='string'&&x.startsWith('write:')));}const dl=mockDL();await assert.rejects(burn(dl,p,new BackupStore(new MemoryDirectory()),{...identity,uid:'00'.repeat(16)}),/UID/);assert.ok(!dl.ops.includes(15));});
test('resume uses matching persisted snapshots instead of overwriting with damaged live data',async()=>{const p=await parsePackage(packageFixture()),root=new MemoryDirectory(),store=new BackupStore(root),dl=mockDL();let failed=false;dl.writePartition=async name=>{if(name==='ap'){failed=true;throw Error('unplug');}};await assert.rejects(burn(dl,p,store,identity));assert.ok(failed);const again=mockDL();await burn(again,p,new BackupStore(root),identity);assert.ok(!again.ops.some(x=>typeof x==='string'&&x.startsWith('backup:')));});
test('a new session preserves prior snapshots but journals current interrupted writes at UID root',async()=>{const p=await parsePackage(packageFixture()),root=new MemoryDirectory(),store=new BackupStore(root);await burn(mockDL(),p,store,identity);store.state.phase='verified';await store.saveState();const oldName=store.state.backups.factory.file;await new Promise(r=>setTimeout(r,2));const second=new BackupStore(root);await second.begin(store.state.uid,p,identity);await second.save(p.entries.find(e=>e.name==='factory'),new Uint8Array(32).fill(9));assert.notEqual(second.state.backups.factory.file,oldName);assert.ok(second.directory.files.has(oldName));});
test('recovery cannot create fresh backups in a different directory',async()=>{const p=await parsePackage(packageFixture()),dl=mockDL();await assert.rejects(burn(dl,p,new BackupStore(new MemoryDirectory()),{...identity,uid:'07'.repeat(16)}));assert.ok(!dl.ops.some(x=>typeof x==='string'&&(x.startsWith('backup:')||x.startsWith('write:'))));});
test('durable pre-AUTODL intent recovers early and partial-backup interruptions',async()=>{
  const p=await parsePackage(packageFixture()),root=new MemoryDirectory(),store=new BackupStore(root),prepared=await store.prepare(p,identity);
  const record=JSON.parse(new TextDecoder().decode(root.files.get('preparation.json')));
  const reopened=new BackupStore(root);assert.deepEqual(await reopened.recover(record,p),prepared);
  await assert.rejects(new BackupStore(new MemoryDirectory()).recover(record,p));
  const dl=mockDL();dl.backup=async e=>{if(e.name==='factory')throw Error('unplug');return new Uint8Array(e.capacity).fill(7);};
  await assert.rejects(burn(dl,p,store,prepared),/unplug/);
  const again=new BackupStore(root),restored=await again.recover(record,p);assert.equal(restored.uid,'07'.repeat(16));
  const next=mockDL();await burn(next,p,again,restored);assert.ok(!next.ops.includes('backup:calibration'));assert.ok(next.ops.includes('backup:factory'));assert.equal(again.state.phase,'awaiting-verification');
  const verified=new BackupStore(root);await verified.recover(record,p);assert.equal(verified.state.phase,'awaiting-verification');
});
test('version comparison does not accept a prefix of another build',async()=>{const {versionMatches}=await import('../renderer/upstream/ml307h/transport.mjs');assert.ok(versionMatches('test0817 v1.2.3','v1.2.3'));assert.ok(!versionMatches('test0817 v1.2.30','v1.2.3'));});
test('preparation cannot overwrite another unfinished recovery record',async()=>{const p=await parsePackage(packageFixture()),root=new MemoryDirectory(),store=new BackupStore(root);await store.prepare(p,identity);const original=root.files.get('preparation.json').slice();await assert.rejects(store.prepare(p,{...identity,imei:'987654321098765'}),/未完成/);assert.deepEqual(root.files.get('preparation.json'),original);});
test('retry heals failed root UID binding before partition mutation',async()=>{const p=await parsePackage(packageFixture()),root=new MemoryDirectory(),store=new BackupStore(root),prepared=await store.prepare(p,identity),write=store.writeVerified.bind(store);store.writeVerified=async(name,data)=>{if(name==='preparation.json')throw Error('disk failure');return write(name,data);};await assert.rejects(burn(mockDL(),p,store,prepared),/disk failure/);assert.ok(!JSON.parse(new TextDecoder().decode(root.files.get('preparation.json'))).uid);const again=new BackupStore(root),dl=mockDL();dl.writePartition=async()=>{assert.equal(JSON.parse(new TextDecoder().decode(root.files.get('preparation.json'))).uid,'07'.repeat(16));};await burn(dl,p,again,prepared);});

test('directory preflight distinguishes all phases without modifying backup bytes',async()=>{
  const p=await parsePackage(packageFixture()),root=new MemoryDirectory(),store=new BackupStore(root);
  assert.equal((await store.inspect()).status,'empty');assert.equal(root.files.size,0);
  const prepared=await store.prepare(p,identity);assert.equal((await store.inspect()).status,'preparing');
  await store.rejectPreparation(prepared);assert.equal((await store.inspect()).status,'rejected');
  const next=await store.prepare(p,identity);await burn(mockDL(),p,store,next);
  for(const phase of ['backing-up','writing','awaiting-verification','verified']){
    store.state.phase=phase;await store.saveState();
    const before=Array.from(store.directory.files,([k,v])=>[k,Array.from(v)]);
    assert.equal((await new BackupStore(root).inspect()).status,phase);
    assert.deepEqual(Array.from(store.directory.files,([k,v])=>[k,Array.from(v)]),before);
  }
  store.state.identity.preparationId='other';await store.saveState();await assert.rejects(store.inspect(),/不一致/);
  root.files.set('preparation.json',new TextEncoder().encode('{'));await assert.rejects(store.inspect());
});

test('explicit new flash archives an unverified completed write and preserves its backups',async()=>{
  const p=await parsePackage(packageFixture()),root=new MemoryDirectory(),store=new BackupStore(root),prepared=await store.prepare(p,identity);
  await burn(mockDL(),p,store,prepared);
  const originals=Array.from(store.directory.files,([name,data])=>[name,data.slice()]).filter(([name])=>name.endsWith('.bin'));
  await store.archiveCompleted(prepared.preparationId,{...identity,version:'test0817 different-version'});
  const archived=await store.inspect();assert.equal(archived.status,'archived-unverified');assert.equal(archived.session.verifiedAt,undefined);
  assert.ok(Array.from(store.directory.files.keys()).some(k=>k.startsWith('history-')));
  const newPkg=await parsePackage(packageFixture(1)),again=new BackupStore(root),next=await again.prepare(newPkg,identity),dl=mockDL();
  assert.notEqual(next.preparationId,prepared.preparationId);assert.equal(next.uid,archived.record.uid);await burn(dl,newPkg,again,next);
  assert.ok(dl.ops.includes('write:ap'));assert.equal(again.state.phase,'awaiting-verification');
  for(const [name,data] of originals)assert.deepEqual(again.directory.files.get(name),data);
});
test('reflash archive rejects interrupted writes, wrong devices, changed sessions and corrupt backups',async()=>{
  for(const scenario of ['preparing','backing-up','writing','other-device','other-session','bad-backup']){
    const p=await parsePackage(packageFixture()),root=new MemoryDirectory(),store=new BackupStore(root),prepared=await store.prepare(p,identity);
    if(scenario!=='preparing')await burn(mockDL(),p,store,prepared);
    if(['backing-up','writing'].includes(scenario)){store.state.phase=scenario;await store.saveState();}
    if(scenario==='bad-backup')store.directory.files.set(store.state.backups.factory.file,new Uint8Array(32));
    const original=root.files.get('preparation.json').slice(),state=store.directory.files.get('session.json')?.slice();
    await assert.rejects(store.archiveCompleted(scenario==='other-session'?'changed':prepared.preparationId,scenario==='other-device'?{...identity,imei:'987654321098765'}:identity));
    assert.deepEqual(root.files.get('preparation.json'),original);assert.deepEqual(store.directory.files.get('session.json'),state);
  }
});

test('each new flash creates a separate labeled folder and leaves prior and legacy records untouched',async()=>{
  const p=await parsePackage(packageFixture()),parent=new MemoryDirectory();
  parent.files.set('preparation.json',enc.encode('legacy untouched'));
  const first=await BackupStore.createSession(parent,p,identity,{firmwareName:'one.pkg'});
  await burn(mockDL(),p,first.store,first.identity);
  const snapshot=dir=>({files:Array.from(dir.files,([name,data])=>[name,Array.from(data)]),dirs:Array.from(dir.dirs,([name,d])=>[name,snapshot(d)])});
  const before=snapshot(first.store.root);
  const second=await BackupStore.createSession(parent,p,identity,{firmwareName:'two.pkg'});
  assert.notEqual(first.name,second.name);assert.equal(parent.dirs.size,2);assert.match(second.name,/^\d{8}-\d{6}_test0817_IMEI2345_/);
  const metadata=JSON.parse(new TextDecoder().decode(second.store.root.files.get('backup-info.json')));
  assert.equal(metadata.firmwareName,'two.pkg');assert.equal(metadata.firmwareSha256,p.digest);assert.equal(metadata.device.imei,identity.imei);assert.equal(metadata.board,'test0817');assert.ok(metadata.createdAt&&metadata.timeZone);
  assert.ok(second.store.root.files.has('备份说明.txt'));
  const dl=mockDL();await burn(dl,p,second.store,second.identity);assert.ok(dl.ops.includes('backup:factory'));
  assert.deepEqual(snapshot(first.store.root),before);assert.equal(new TextDecoder().decode(parent.files.get('preparation.json')),'legacy untouched');
  const recovered=new BackupStore(first.store.root),record=(await recovered.inspect()).record;
  await recovered.recover(record,p);assert.equal(parent.dirs.size,2);assert.equal(recovered.state.phase,'awaiting-verification');
});
test('session folder or metadata failure rejects preparation before touching existing sessions',async()=>{
  const p=await parsePackage(packageFixture()),parent=new MemoryDirectory();
  parent.getDirectoryHandle=async(name,{create}={})=>{if(create)throw Error('disk full');throw new DOMException('missing','NotFoundError');};
  await assert.rejects(BackupStore.createSession(parent,p,identity),/disk full/);
  const root=new MemoryDirectory(),child=new MemoryDirectory();root.getDirectoryHandle=async(n,{create}={})=>{if(!create)throw new DOMException('missing','NotFoundError');return child;};
  child.getFileHandle=async()=>{throw Error('metadata denied');};
  await assert.rejects(BackupStore.createSession(root,p,identity),/metadata denied/);assert.equal(child.files.size,0);
});

test('legacy custom session recovers from its saved profile without JSON import',async()=>{
  const raw=packageFixture(2,{project:'sensor_app',board:'sensor_b'}),old=await parsePackage(raw);
  old.compatibility=matchPackageProfile(old,{schema:1,protocol:'ml307h-rom-v1',project:old.project,board:'sensor_b',firmwareSha256:old.digest,requiredImages:['ap']});
  const root=new MemoryDirectory(),store=new BackupStore(root),device={...identity,version:'sensor_b v1.2.3'};
  const prepared=await store.prepare(old,device);const dl=mockDL();dl.writePartition=async()=>{throw Error('unplug');};await assert.rejects(burn(dl,old,store,prepared),/unplug/);
  const record=JSON.parse(new TextDecoder().decode(root.files.get('preparation.json')));
  const loaded=await parsePackage(raw);assert.equal(loaded.compatibility.profile.board,null);
  const reopened=new BackupStore(root),restored=await reopened.recover(record,loaded);
  assert.equal(loaded.compatibility.profile.board,'sensor_b');assert.equal(restored.imei,device.imei);
  const resumed=mockDL();await burn(resumed,loaded,reopened,restored);assert.ok(resumed.ops.includes('write:ap'));assert.ok(!resumed.ops.includes('backup:factory'));
});
test('PKG-only generic session preserves identity, digest and backups on resume',async()=>{
  const raw=packageFixture(2,{project:'new_board',board:'unlisted_board'}),pkg=await parsePackage(raw),parent=new MemoryDirectory();
  const created=await BackupStore.createSession(parent,pkg,identity,{firmwareName:'new.pkg'});
  assert.match(created.name,/_new_board_IMEI/);const info=JSON.parse(new TextDecoder().decode(created.store.root.files.get('backup-info.json')));assert.equal(info.board,null);
  const dl=mockDL();dl.writePartition=async()=>{throw Error('disconnect');};await assert.rejects(burn(dl,pkg,created.store,created.identity));
  const record=JSON.parse(new TextDecoder().decode(created.store.root.files.get('preparation.json'))),reloaded=await parsePackage(raw),store=new BackupStore(created.store.root);
  const recovered=await store.recover(record,reloaded);await burn(mockDL(),reloaded,store,recovered);assert.equal(store.state.phase,'awaiting-verification');
  const bad=await parsePackage(packageFixture(1,{project:'new_board',board:'unlisted_board'}));await assert.rejects(new BackupStore(created.store.root).recover(record,bad),/不匹配/);
});

test('default quick selection restores a legacy checked session before resuming writes',async()=>{
  const raw=packageFixture(),p=await parsePackage(raw),root=new MemoryDirectory(),store=new BackupStore(root);
  const prepared=await store.prepare(p,identity),fail=mockDL();fail.writePartition=async()=>{throw Error('unplug');};
  await assert.rejects(burn(fail,p,store,prepared),/unplug/);
  const loaded=await parsePackage(raw);loaded.compatibility=matchPackageProfile(loaded,null,{checkBoard:false});
  const recoveredStore=new BackupStore(root),recovered=await recoveredStore.recover((await store.inspect()).record,loaded);
  assert.equal(loaded.compatibility.profile.board,'test0817');assert.equal(recovered.imei,identity.imei);
  const dl=mockDL();await burn(dl,loaded,recoveredStore,recovered);assert.ok(!dl.ops.includes('backup:factory'));assert.ok(dl.ops.includes('write:ap'));
});
test('quick mode accepts absent runtime identity, journals checks and binds backups to download UID',async()=>{
  const raw=packageFixture(),p=await parsePackage(raw);p.compatibility=matchPackageProfile(p,null,{checkBoard:false});
  const quick={identification:'download-uid',version:'',imei:'',mode:'quick',flashChecks:{board:false,reread:false,usbSerial:false}},root=new MemoryDirectory();
  const created=await BackupStore.createSession(root,p,quick);assert.match(created.name,/_USB_/);
  const fail=mockDL();fail.writePartition=async()=>{throw Error('unplug');};await assert.rejects(burn(fail,p,created.store,created.identity),/unplug/);
  const info=await created.store.inspect();assert.equal(info.status,'writing');assert.equal(info.record.uid,'07'.repeat(16));assert.equal(info.record.identity.imei,'');
  const loaded=await parsePackage(raw),recoveredStore=new BackupStore(created.store.root),recovered=await recoveredStore.recover(info.record,loaded);
  assert.equal(recovered.flashChecks.board,false);assert.equal(loaded.compatibility.profile.board,null);
  const wrong=mockDL();wrong.transaction=async()=>({cmd:131,payload:new Uint8Array(16).fill(8)});
  await assert.rejects(burn(wrong,loaded,recoveredStore,recovered),/UID/);assert.ok(!wrong.ops.includes('write:ap'));
  const good=mockDL();await burn(good,loaded,recoveredStore,recovered);assert.ok(!good.ops.includes('backup:factory'));assert.equal(recoveredStore.state.phase,'awaiting-verification');
});
test('quick mode still stops on corrupted backup and invalid option records',async()=>{
  const p=await parsePackage(packageFixture()),quick={identification:'download-uid',version:'',imei:'',mode:'quick',flashChecks:{board:false,reread:false,usbSerial:false}};
  for(const bad of [{...quick,flashChecks:{board:true,reread:false,usbSerial:false}},{...quick,flashChecks:{board:false,reread:'false',usbSerial:false}},{version:'',imei:''}]){
    const dl=mockDL();await assert.rejects(burn(dl,p,new BackupStore(new MemoryDirectory()),bad));assert.deepEqual(dl.ops,[]);
  }
  const store=new BackupStore(new MemoryDirectory()),id=await store.prepare(p,quick);
  const fail=mockDL();fail.writePartition=async()=>{throw Error('unplug');};await assert.rejects(burn(fail,p,store,id));
  store.directory.files.set(store.state.backups.factory.file,new Uint8Array(32));
  const record=JSON.parse(new TextDecoder().decode(store.root.files.get('preparation.json')));
  await assert.rejects(new BackupStore(store.root).recover(record,p),/摘要/);
});
