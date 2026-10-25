import {CMD,frame,DownloadDecoder,partitionPayload,u32,concat,hex,sha256,bytes} from './protocol.mjs';
import {boardMatches} from './transport.mjs';
import {packageMatchesDevice,restoreSavedProfile,validDeviceIdentity,sameSavedIdentity} from './package.mjs';
const encoder=new TextEncoder(),decoder=new TextDecoder();
function assertTarget(pkg,identity){
  if(!packageMatchesDevice(pkg,identity))throw Error('固件适配配置与设备板型不匹配，禁止开始烧录');
}
function checkSavedProfile(record,pkg){
  if(record.profile?JSON.stringify(record.profile)!==JSON.stringify(pkg.compatibility.profile):pkg.compatibility.profile.firmwareSha256)throw Error('恢复记录的板型配置不匹配，请选择原固件与原备份目录');
}
export class Downloader {
  constructor(transport,{log=()=>{},progress=()=>{}}={}){this.transport=transport;this.log=log;this.progress=progress;this.crc=true;this.broken=false;}
  async transaction(cmd,payload=new Uint8Array(),{ok=[0x80],timeout=60000}={}){
    if(this.broken)throw Error('下载状态未知，禁止继续发送');
    try{
      await this.transport.write(frame(cmd,payload,this.crc));const parser=new DownloadDecoder(this.crc),end=Date.now()+timeout;
      while(Date.now()<end){const frames=parser.feed(await this.transport.read(Math.max(1,end-Date.now())));if(parser.invalid)throw Error('设备回包校验失败');if(!frames.length)continue;if(frames.length!==1||parser.buffer.length)throw Error('设备返回了非预期的额外数据');const r=frames[0];if(ok&&!ok.includes(r.cmd))throw Error(`设备响应 0x${r.cmd.toString(16)}，命令 0x${cmd.toString(16)} 未成功`);return r;}
      throw Error('等待应答超时');
    }catch(e){this.broken=true;throw Error(`${e.message}。已停止，不自动重发。`);}
  }
  async handshake(crc){
    this.crc=crc;await this.transport.write(Uint8Array.of(0x7e,0x7e,0x7e));const parser=new DownloadDecoder(crc),end=Date.now()+8000;let banner=new Uint8Array();
    while(Date.now()<end){const chunk=await this.transport.read(Math.max(1,end-Date.now()));banner=concat(banner,chunk);if(banner.length>65536)throw Error('握手回复过长');const frames=parser.feed(chunk);if(parser.invalid)throw Error('握手校验不匹配；需从 ROM 模式重新开始');const rawROM=crc&&/^(?:\s*)HandshakeROM(?:\s|$)/i.test(decoder.decode(banner));if(frames.some(f=>f.cmd===0x81)||rawROM){await this.transaction(CMD.CONNECT,new Uint8Array(),{timeout:5000});return;}}
    throw Error('未收到阶段版本握手，不能确认下载状态');
  }
  async sendImage(startPayload,data,label,chunkSize){
    await this.transaction(CMD.START,startPayload);this.progress(label,0,data.length);
    for(let at=0;at<data.length;at+=chunkSize){const chunk=data.subarray(at,at+chunkSize);await this.transaction(CMD.DATA,chunk);this.progress(label,at+chunk.length,data.length);}
    await this.transaction(CMD.END);
  }
  async bootstrap(pkg){
    this.log('连接 ROM，校验算法 CRC16');await this.handshake(true);
    for(const e of pkg.loaders){this.log(`装载 ${e.name} 至内存`);await this.sendImage(concat(u32(e.address),u32(e.size)),pkg.payload(e),e.name,50);await this.transaction(CMD.EXEC,new Uint8Array(),{timeout:10000});this.log(`${e.name} 已执行，切换 checksum16`);await this.handshake(false);}
  }
  async backup(e){
    const r=await this.transaction(CMD.BACKUP_START,partitionPayload(e.target),{ok:[0x82]});if(r.payload.length!==4)throw Error('备份大小应答无效');
    const n=new DataView(r.payload.buffer,r.payload.byteOffset).getUint32(0,true);if(n!==e.capacity||!n||n>64*1024*1024)throw Error(`${e.name} 原分区容量与目标不一致，需专门迁移方案`);
    const out=new Uint8Array(n);for(let at=0;at<n;){const size=Math.min(256,n-at),r=await this.transaction(CMD.BACKUP_DATA,u32(size),{ok:[0x82]});if(r.payload.length!==size)throw Error('备份返回长度不匹配');out.set(r.payload,at);at+=size;this.progress(`备份 ${e.name}`,at,n);}
    await this.transaction(CMD.BACKUP_END);
    if(e.name!=='factory_bak'&&([0,255].some(fill=>out.subarray(0,16).every(x=>x===fill))))throw Error(`${e.name} 数据为空/已擦除，不能建立有效备份`);
    return out;
  }
  async writePartition(name,data){this.log(`写入 ${name} · ${data.length} bytes`);await this.sendImage(partitionPayload(name,data.length),data,name,256);}
  async reset(){await this.transport.write(frame(CMD.RESET,u32(0),false));}
}
export class BackupStore {
  constructor(root){this.root=root;this.directory=null;this.state=null;}
  static async createSession(parent,pkg,identity,{firmwareName=''}={}){
    assertTarget(pkg,identity);
    if(!validDeviceIdentity(identity))throw Error('设备记录无效，不能创建烧录备份');
    const now=new Date(),pad=n=>String(n).padStart(2,'0');
    const stamp=`${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const board=(pkg.compatibility.profile.board||pkg.project).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,40);
    let root,name;
    for(let attempt=0;attempt<5;attempt++){
      name=`${stamp}_${board}_${identity.imei?'IMEI'+identity.imei.slice(-4):'USB'}_${crypto.randomUUID()}`;
      try{await parent.getDirectoryHandle(name);continue;}catch(e){if(e.name!=='NotFoundError')throw e;}
      root=await parent.getDirectoryHandle(name,{create:true});break;
    }
    if(!root)throw Error('未能创建独立备份文件夹，请重试');
    const store=new BackupStore(root);store.directory=root;
    const metadata={schema:1,kind:'ml307h-flash-session',folder:name,createdAt:now.toISOString(),localTime:now.toLocaleString(),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,board:pkg.compatibility.profile.board,project:pkg.project,firmwareName,firmwareVersion:pkg.version,firmwareSha256:pkg.digest,firmwareBytes:pkg.byteLength,device:identity};
    await store.writeVerified('backup-info.json',encoder.encode(JSON.stringify(metadata,null,2)));
    await store.writeVerified('备份说明.txt',encoder.encode([
      'ML307H 本次烧录备份',`创建时间：${metadata.localTime} (${metadata.timeZone})`,`板型：${metadata.board||'未提供标准板型字段（用户确认硬件）'}`,`项目：${metadata.project}`,`设备 IMEI：${identity.imei||'快捷模式未读取，以下载 UID 关联备份'}`,`烧录前设备版本：${identity.version||'快捷模式未读取'}`,`固件文件：${firmwareName}`,`固件包版本：${pkg.version}`,`固件 SHA-256：${pkg.digest}`,
      '', '本文件夹仅对应一次新烧录。创建文件夹不代表备份或写入已完成。',
      'preparation.json：进入下载模式前的准备记录。',
      '设备 UID 子目录/session.json：本次备份清单、校验值及最新写入/核对状态。',
      '设备 UID 子目录/*.bin：本设备的校准、工厂等专属分区备份（不是完整固件备份）。',
      '恢复中断烧录：选择原固件，点击“恢复／核对已有备份”，选择本文件夹。',
      '请保留整个文件夹；文件仅保存到电脑，不上传服务器。'
    ].join('\n')));
    const prepared=await store.prepare(pkg,identity);
    return {store,identity:prepared,name};
  }
  async inspect(){
    // Read-only preflight. Never create files/directories or discard an old
    // transaction just because a user selected this folder again.
    const read=async(dir,name)=>{const f=await (await dir.getFileHandle(name)).getFile();if(f.size>65536)throw Error('备份会话记录过大');return JSON.parse(await f.text());};
    let record;
    try{record=await read(this.root,'preparation.json');}catch(e){if(e.name==='NotFoundError')return {status:'empty'};throw e;}
    if(record?.schema!==1||!record.preparationId||!['preparing','rejected'].includes(record.phase)||!/^[a-f0-9]{64}$/.test(record.digest)||!validDeviceIdentity(record.identity))throw Error('备份目录中的准备记录无效，请保留原文件并检查目录');
    if(record.phase==='rejected')return {status:'rejected',record};
    if(!record.uid)return {status:'preparing',record};
    if(!/^[a-f0-9]{16,128}$/.test(record.uid))throw Error('备份记录的设备 UID 无效');
    const directory=await this.root.getDirectoryHandle(record.uid);
    const session=await read(directory,'session.json');
    if(session?.schema!==1||session.uid!==record.uid||session.digest!==record.digest||!sameSavedIdentity(session.identity,record.identity)||session.identity?.preparationId!==record.preparationId||!['backing-up','writing','awaiting-verification','verified','archived-unverified'].includes(session.phase))throw Error('备份目录中的准备记录和设备会话不一致');
    return {status:session.phase,record,session};
  }
  async archiveCompleted(preparationId,current){
    const info=await this.inspect();
    if(info.status!=='awaiting-verification'||info.record.preparationId!==preparationId)throw Error('原会话状态已变化，只有完整写入、待核对的会话可重新烧录');
    if(!current.imei||current.imei!==info.record.identity.imei||typeof current.version!=='string'||(info.record.profile?.board&&!boardMatches(current.version,info.record.profile.board)))throw Error('当前设备与上次烧录设备不一致，不能结束原会话');
    this.directory=await this.root.getDirectoryHandle(info.record.uid);this.state=info.session;
    const backups=Object.entries(this.state.backups||{});
    if(!backups.some(([name])=>name==='calibration')||!backups.some(([name])=>name==='factory'))throw Error('原会话缺少设备专属数据备份');
    for(const [name,meta] of backups){
      if(!/^[a-zA-Z0-9_]+$/.test(name)||!Number.isInteger(meta?.size)||meta.size<1||meta.size>64*1024*1024)throw Error('原备份记录无效');
      await this.load({name,capacity:meta.size});
    }
    // Archive the original journal before recording an explicit skip. Never
    // manufacture a successful verification, and never remove backup bytes.
    await this.writeVerified(`history-${Date.now()}-${crypto.randomUUID()}.json`,encoder.encode(JSON.stringify(this.state)));
    this.state={...this.state,phase:'archived-unverified',verificationSkippedAt:new Date().toISOString(),lastObservedIdentity:current};
    await this.saveState();
  }
  async writeVerified(name,data){
    data=bytes(data);const file=await this.directory.getFileHandle(name,{create:true}),w=await file.createWritable();
    try{await w.write(data);await w.close();}catch(e){await w.abort().catch(()=>{});throw e;}
    const saved=new Uint8Array(await (await file.getFile()).arrayBuffer());const digest=await sha256(data);
    if(saved.length!==data.length||await sha256(saved)!==digest)throw Error(`备份 ${name} 落盘校验失败`);return digest;
  }
  async prepare(pkg,identity){
    assertTarget(pkg,identity);
    this.directory=this.root;
    let old;
    try{const f=await (await this.root.getFileHandle('preparation.json')).getFile();if(f.size>65536)throw Error('准备记录过大');old=JSON.parse(await f.text());}catch(e){if(e.name!=='NotFoundError')throw e;}
    if(old&&old.phase!=='rejected'){
      if(!old.uid)throw Error('此目录有未完成的准备记录，请先恢复原会话或使用另一个目录');
      const dir=await this.root.getDirectoryHandle(old.uid),f=await (await dir.getFileHandle('session.json')).getFile();
      if(f.size>65536)throw Error('会话记录过大');const previous=JSON.parse(await f.text());
      if(!['verified','archived-unverified'].includes(previous.phase)||previous.uid!==old.uid||previous.digest!==old.digest)throw Error('此目录有未完成的烧录，请先恢复原会话或使用另一个目录');
      await this.writeVerified(`preparation-${old.preparationId}.json`,encoder.encode(JSON.stringify(old)));
      if(previous.phase==='archived-unverified'&&identity.imei&&previous.identity?.imei===identity.imei)identity={...identity,uid:previous.uid};
    }
    const intent={schema:1,phase:'preparing',digest:pkg.digest,profile:pkg.compatibility.profile,identity,preparationId:crypto.randomUUID()};
    await this.writeVerified('preparation.json',encoder.encode(JSON.stringify(intent,null,2)));
    return {...identity,preparationId:intent.preparationId};
  }
  async rejectPreparation(identity){
    const f=await (await this.root.getFileHandle('preparation.json')).getFile();
    if(f.size>65536)throw Error('准备记录过大');const intent=JSON.parse(await f.text());
    if(intent.preparationId!==identity.preparationId||intent.uid)throw Error('不能修改不匹配的准备记录');
    intent.phase='rejected';this.directory=this.root;
    await this.writeVerified('preparation.json',encoder.encode(JSON.stringify(intent,null,2)));
  }
  async recover(record,pkg){
    const f=await (await this.root.getFileHandle('preparation.json')).getFile();
    if(f.size>65536)throw Error('准备记录过大');const intent=JSON.parse(await f.text());
    if(!record.preparationId||record.preparationId!==intent.preparationId||intent.digest!==pkg.digest||!sameSavedIdentity(intent.identity,record.identity))throw Error('请选择原备份目录，准备记录不匹配');
    const identity={...intent.identity,preparationId:intent.preparationId};
    restoreSavedProfile(pkg,intent);assertTarget(pkg,identity);checkSavedProfile(intent,pkg);
    if(intent.uid){
      const dir=await this.root.getDirectoryHandle(intent.uid),f=await (await dir.getFileHandle('session.json')).getFile();
      if(f.size>65536)throw Error('会话记录过大');const session=JSON.parse(await f.text());
      if(session.schema!==1||session.identity?.preparationId!==intent.preparationId||session.uid!==intent.uid||session.digest!==pkg.digest||!sameSavedIdentity(session.identity,identity)||!['backing-up','writing','awaiting-verification'].includes(session.phase))throw Error('原备份会话不匹配');
      checkSavedProfile(session,pkg);
      this.directory=dir;this.state=session;identity.uid=intent.uid;
      if(session.phase!=='backing-up')for(const e of pkg.protectedEntries)await this.load(e);
    }
    return identity;
  }
  async begin(uid,pkg,identity){
    if(!/^[a-f0-9]{16,128}$/.test(uid))throw Error('设备 UID 长度/格式异常');
    let intent;
    if(identity.preparationId){
      const f=await (await this.root.getFileHandle('preparation.json')).getFile();if(f.size>65536)throw Error('准备记录过大');intent=JSON.parse(await f.text());
      if(intent.preparationId!==identity.preparationId||intent.digest!==pkg.digest||!sameSavedIdentity(intent.identity,identity)||(intent.uid&&intent.uid!==uid))throw Error('准备记录与当前设备不匹配');
      checkSavedProfile(intent,pkg);
    }
    this.directory=await this.root.getDirectoryHandle(uid,{create:!identity.uid&&!intent?.uid});
    let previous;
    try{const f=await this.directory.getFileHandle('session.json');const blob=await f.getFile();if(blob.size>65536)throw Error('备份状态文件过大');previous=JSON.parse(await blob.text());}catch(e){if(e.name!=='NotFoundError')throw e;}
    if(previous&&(previous.schema!==1||!['writing','awaiting-verification','verified','archived-unverified','backing-up'].includes(previous.phase)||previous.uid!==uid||!previous.backups))throw Error('备份会话状态无效');
    if((identity.uid||intent?.uid)&&!previous)throw Error('恢复必须使用原目录中的完整备份会话');
    if(previous&&!['verified','archived-unverified'].includes(previous.phase)){
      if(previous.digest!==pkg.digest||!sameSavedIdentity(previous.identity,identity))throw Error('该 UID 有另一个固件/身份的未完成会话，请先处理原会话');
      checkSavedProfile(previous,pkg);
      this.state=previous;await this.bindIntent(intent,uid);return previous.phase!=='backing-up';
    }
    // Keep old bytes using unique filenames; the UID journal always points at the latest session.
    if(previous)await this.writeVerified(`history-${Date.now()}.json`,encoder.encode(JSON.stringify(previous)));
    this.state={schema:1,uid,digest:pkg.digest,profile:pkg.compatibility.profile,identity,phase:'backing-up',backups:{},written:[],created:new Date().toISOString(),prefix:`${Math.max(Date.now(),Number(previous?.prefix?.split('-')[0]||0)+1)}-${pkg.digest.slice(0,12)}`};
    await this.saveState();
    await this.bindIntent(intent,uid);return false;
  }
  async bindIntent(intent,uid){
    if(intent){intent.uid=uid;const directory=this.directory;this.directory=this.root;try{await this.writeVerified('preparation.json',encoder.encode(JSON.stringify(intent,null,2)));}finally{this.directory=directory;}}
  }
  async saveState(){await this.writeVerified('session.json',encoder.encode(JSON.stringify(this.state,null,2)));}
  async save(e,data){const file=`${this.state.prefix}-${e.name}.bin`,digest=await this.writeVerified(file,data);this.state.backups[e.name]={file,size:data.length,sha256:digest};await this.saveState();}
  async load(e){const metadata=this.state.backups[e.name];if(!metadata||metadata.size!==e.capacity||!/^\d+-[a-f0-9]{12}-[a-zA-Z0-9_]+\.bin$/.test(metadata.file))throw Error(`缺少 ${e.name} 完整备份`);const f=await (await this.directory.getFileHandle(metadata.file)).getFile();if(f.size!==e.capacity)throw Error('备份大小不匹配');const data=new Uint8Array(await f.arrayBuffer());if(await sha256(data)!==metadata.sha256)throw Error('备份摘要不匹配');return data;}
}
export async function burn(dl,pkg,store,identity,{activate}={}){
  assertTarget(pkg,identity);
  await dl.bootstrap(pkg);
  const uid=hex((await dl.transaction(CMD.UID,u32(0),{ok:[0x83]})).payload);
  if(identity.uid&&identity.uid!==uid)throw Error('实际设备 UID 与恢复记录不同，拒绝继续');
  const status=(await dl.transaction(CMD.CHECK_TABLE,new Uint8Array(),{ok:null})).cmd;
  if(![0x80,0xb1].includes(status))throw Error(`分区表状态 0x${status.toString(16)}：本工具仅支持有效分区表升级，不执行全片擦除`);
  const recovery=await store.begin(uid,pkg,identity);const saved=new Map();
  if(store.state.activation)throw Error('此会话已有功能激活记录，不能重新写入或重复激活；请先核对官方授权结果');
  for(const e of pkg.protectedEntries){const exists=!!store.state.backups[e.name];const data=(recovery||exists)?await store.load(e):await dl.backup(e);if(!recovery&&!exists)await store.save(e,data);saved.set(e.name,data);}
  store.state.phase='writing';await store.saveState();dl.log(recovery?'已验证同 UID、同固件的备份，重新执行完整写入':'备份已写入本机并校验');
  if(status===0xb1){dl.log('更新分区表');await dl.transaction(CMD.UPDATE_TABLE,new Uint8Array(),{timeout:180000});}
  for(const e of pkg.entries.filter(e=>e.type==='CODE'&&e.backup===2)){dl.log(`按固件清单擦除 ${e.target}`);await dl.transaction(CMD.ERASE_PART,partitionPayload(e.target));}
  for(const e of pkg.writes.filter(e=>e.target!=='mbl')){await dl.writePartition(e.target,pkg.payload(e));store.state.written.push(e.name);await store.saveState();}
  for(const e of pkg.protectedEntries)await dl.writePartition(e.target,saved.get(e.name));
  const mbl=pkg.writes.at(-1);await dl.writePartition(mbl.target,pkg.payload(mbl));store.state.written.push(mbl.name);store.state.phase='awaiting-verification';await store.saveState();
  let activationError;
  if(activate)try{await activate(dl,store);}catch(error){activationError=error;}
  if(!dl.broken)try{await dl.reset();}catch(error){if(!activationError)throw error;}
  if(activationError)throw activationError;
  dl.log('分区写入完成，已请求复位；等待重新连接 AT 并核对版本/身份');return {uid};
}
