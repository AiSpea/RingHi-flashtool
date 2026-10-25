import {NativeMlTransport} from './native.mjs';
import {atCommand,parseIdentity} from './upstream/ml307h/transport.mjs';
import {packageMatchesDevice} from './upstream/ml307h/package.mjs';
import {Downloader,BackupStore,burn} from './upstream/ml307h/download.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export class MlBatchFlasher {
 constructor({log=()=>{},progress=()=>{},stage=()=>{},open=NativeMlTransport.open,createSession=BackupStore.createSession,burnDevice=burn}={}){Object.assign(this,{log,progress,stage,open,createSession,burnDevice});this.at=null;this.usb=null;this.activation=null;}
 async probe(lease,pkg){this.lease=lease;this.pkg=pkg;this.stage('读取 ML307H 身份');this.at=await this.open(lease,'runtime');
  this.identity={...parseIdentity(await atCommand(this.at,'AT+CGMR'),await atCommand(this.at,'AT+CGSN=1')),mode:'checked',flashChecks:{board:!!pkg.compatibility.profile.board,reread:true,usbSerial:false}};
  if(!packageMatchesDevice(pkg,this.identity))throw Error('ML307H 固件与设备板型不匹配');return this.identity;
 }
 async flash({backup,firmwareName,activationFactory,beforeSwitch=async()=>{}}){
  let created;
  try{
   // One activation context per physical board; never share an activation run.
   this.activation=activationFactory?await activationFactory():null;
   const current=parseIdentity(await atCommand(this.at,'AT+CGMR'),await atCommand(this.at,'AT+CGSN=1'));
   if(current.imei!==this.identity.imei)throw Error('ML307H 身份在准备期间变化，拒绝继续');
   created=await this.createSession(backup,this.pkg,this.identity,{firmwareName});this.store=created.store;this.identity=created.identity;
   await beforeSwitch({backup:created.name,imei:this.identity.imei,digest:this.pkg.digest,firmware:firmwareName});
   this.stage('切换下载模式');this.progress(1);let reply;
   try{reply=await atCommand(this.at,'AT^AUTODL',{timeout:10000,disconnectOK:true});}
   catch(e){if(e.commandRejected)await this.store.rejectPreparation(this.identity);throw e;}
   if(reply.split(/[\r\n]+/).some(l=>l.trim()==='OK')){
    await sleep(2000);let runtime=false;try{await atCommand(this.at,'AT',{timeout:1500});runtime=true;}catch{}
    if(runtime)await atCommand(this.at,'AT^RESET=normal',{timeout:3000,disconnectOK:true});
   }
   await this.at.close();this.at=null;
   this.stage('定位原 Hub 分支的下载设备');this.usb=await this.open(this.lease,'download');
   const weights=new Map();for(const e of this.pkg.loaders)weights.set(e.name,e.size);for(const e of this.pkg.protectedEntries){weights.set(`备份 ${e.name}`,e.capacity);weights.set(e.target,e.capacity);}for(const e of this.pkg.writes)weights.set(e.target,e.size);
   const completed=new Map(),total=[...weights.values()].reduce((a,b)=>a+b,0);
   const dl=new Downloader(this.usb,{log:this.log,progress:(name,done,size)=>{completed.set(name,Math.min(weights.get(name)||size,done));this.progress(Math.min(95,Math.floor(2+93*[...completed.values()].reduce((a,b)=>a+b,0)/Math.max(1,total))));this.stage(`${name.startsWith('备份 ')?'备份':'写入'} ${name} · ${Math.round(100*done/size)}%`);}});
   const result=await this.burnDevice(dl,this.pkg,this.store,this.identity,{activate:this.activation?.run});this.progress(100);this.stage('写入完成 · 已请求复位');
   return {firmware:firmwareName,digest:this.pkg.digest,imei:this.identity.imei,uid:result.uid,backup:created.name,activation:this.store.state.activation?.status||'not-requested',verification:'protocol-ack',reset:'requested'};
  }catch(e){e.details={firmware:firmwareName,digest:this.pkg.digest,imei:this.identity?.imei||'',backup:created?.name||'',uid:this.store?.state?.uid||'',activation:this.store?.state?.activation?.status||'not-requested',verification:this.store?.state?.phase==='awaiting-verification'?'protocol-ack':'unconfirmed',reset:'unconfirmed'};throw e;
  }finally{this.activation?.dispose();this.activation=null;await this.disconnect();}
 }
 async waitReady(){
  const end=Date.now()+45000;let error;
  while(Date.now()<end){let t;try{t=await this.open(this.lease,'runtime');const current=parseIdentity(await atCommand(t,'AT+CGMR'),await atCommand(t,'AT+CGSN=1'));if(current.imei!==this.identity.imei)throw Object.assign(Error('ML307H 重启后身份不一致'),{identityMismatch:true});if(!packageMatchesDevice(this.pkg,current))throw Object.assign(Error('ML307H 重启后固件不匹配'),{identityMismatch:true});return current;}catch(e){if(e.identityMismatch)throw e;error=e;}finally{await t?.close();}await sleep(1000);}
  throw Error('ML307H 重启就绪超时：'+(error?.message||'无响应'));
 }
 async disconnect(){const at=this.at,usb=this.usb;this.at=null;this.usb=null;await at?.close().catch(()=>{});await usb?.close().catch(()=>{});}
}
