const fs=require('node:fs/promises'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {createReadStream}=require('node:fs');
const REPOSITORY='AiSpea/RingHi-flashtool';
const FEED=`https://github.com/${REPOSITORY}/releases/latest/download/ringhi-update.json`;
const MAX_PACKAGE=512*1024*1024;
function versionParts(value){if(typeof value!=='string'||!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(value))throw Error('更新版本号无效');return value.split('.').map(Number);}
function newer(a,b){const x=versionParts(a),y=versionParts(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false;}
function allowedUrl(input){const u=new URL(input);if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)throw Error('更新地址必须使用受信任的 HTTPS 下载源');if(!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname))throw Error('更新下载跳转到了未允许的地址');return u;}
function validateManifest(m,{platform,arch,currentVersion}){
 if(!m||m.schema!==1||m.appId!=='com.aispea.ringhi.flasher')throw Error('更新信息不属于 RingHi');versionParts(m.version);
 if(!newer(m.version,currentVersion))return null;
 const suffix=platform==='darwin'&&arch==='arm64'?'macOS-arm64.pkg':platform==='win32'&&arch==='x64'?'Windows-x64.exe':null;
 if(!suffix)throw Error('尚未提供适合当前系统或芯片架构的更新包');
 const artifact=m.artifacts?.[`${platform}-${arch}`],name=`RingHi-Flasher-${m.version}-${suffix}`;
 const expected=`https://github.com/${REPOSITORY}/releases/download/v${m.version}/${name}`;
 if(!artifact||artifact.name!==name||artifact.url!==expected||!Number.isSafeInteger(artifact.size)||artifact.size<=0||artifact.size>MAX_PACKAGE||!/^[a-f0-9]{64}$/.test(artifact.sha256||''))throw Error('更新包信息缺失或校验信息无效');
 return {version:m.version,notes:typeof m.notes==='string'?m.notes.slice(0,4000):'',artifact:{...artifact}};
}
async function digest(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
class UpdateService{
 constructor({directory,currentVersion,platform=process.platform,arch=process.arch,fetchImpl=fetch,onChange=()=>{},isBusy=()=>false,enabled=true}){Object.assign(this,{directory,currentVersion,platform,arch,fetchImpl,onChange,isBusy,enabled});this.state={phase:'idle',currentVersion,message:'尚未检查更新',checkedAt:null};this.offer=null;this.file=null;this.pending=null;}
 publish(patch){this.state={...this.state,...patch};this.onChange(this.snapshot());return this.snapshot();}
 snapshot(){return structuredClone(this.state);}
 async response(url,signal){for(let i=0;i<6;i++){allowedUrl(url);const r=await this.fetchImpl(url,{redirect:'manual',signal,headers:{Accept:'application/octet-stream','User-Agent':'RingHi-Flasher/'+this.currentVersion},credentials:'omit'});if([301,302,303,307,308].includes(r.status)){const next=r.headers.get('location');await r.body?.cancel();if(!next)throw Error('更新下载跳转缺少地址');url=new URL(next,url).href;continue;}if(!r.ok){await r.body?.cancel();throw Error(r.status===404?'尚未发布可用更新，或下载源不可访问':`更新服务器返回 ${r.status}`);}return r;}throw Error('更新下载跳转过多');}
 check(){if(this.pending||this.state.phase==='installing')return Promise.resolve(this.snapshot());const op=this.checkNow();this.pending=op;return op.finally(()=>{if(this.pending===op)this.pending=null;});}
 async checkNow(){
  if(!this.enabled)return this.publish({phase:'disabled',message:'开发或测试环境不自动更新'});
  if(this.state.phase==='downloaded')return this.snapshot();
  this.publish({phase:'checking',message:'正在检查新版本…'});
  try{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);let m;
   try{const r=await this.response(FEED,controller.signal);let bytes=0,chunks=[];for await(const chunk of r.body){bytes+=chunk.length;if(bytes>128*1024){controller.abort();throw Error('更新信息过大');}chunks.push(Buffer.from(chunk));}m=JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{clearTimeout(timer);}
   this.offer=validateManifest(m,this);this.file=null;return this.publish({phase:this.offer?'available':'current',version:this.offer?.version||null,notes:this.offer?.notes||'',message:this.offer?`发现新版本 v${this.offer.version}`:'当前已是最新版本',checkedAt:new Date().toISOString(),progress:0});
  }catch(e){return this.publish({phase:'error',message:'检查更新失败：'+e.message});}
 }
 download(){if(this.pending||this.state.phase==='installing')return Promise.resolve(this.snapshot());const op=this.downloadNow();this.pending=op;return op.finally(()=>{if(this.pending===op)this.pending=null;});}
 async downloadNow(){
  if(!this.offer)throw Error('请先检查更新');if(this.file&&this.state.phase==='downloaded')return this.snapshot();
  if(this.isBusy())throw Error('请先停止接收设备并等待当前任务完成，再下载更新');
  const {artifact}=this.offer;await fs.mkdir(this.directory,{recursive:true});const partial=path.join(this.directory,randomUUID()+'.partial'),target=path.join(this.directory,artifact.name);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15*60*1000);let handle;
  this.publish({phase:'downloading',message:'正在下载更新…',progress:0});
  try{const r=await this.response(artifact.url,controller.signal);const length=r.headers.get('content-length');if(length&&Number(length)!==artifact.size)throw Error('下载包大小与发布信息不符');handle=await fs.open(partial,'wx',0o600);const hash=createHash('sha256');let received=0,last=-1;
   for await(const chunk of r.body){received+=chunk.length;if(received>artifact.size){controller.abort();throw Error('下载包超过预期大小');}hash.update(chunk);await handle.writeFile(chunk);const progress=Math.floor(received/artifact.size*100);if(progress!==last){last=progress;this.publish({progress,message:`正在下载更新 · ${progress}%`});}}
   await handle.sync();await handle.close();handle=null;
   if(received!==artifact.size||hash.digest('hex')!==artifact.sha256)throw Error('下载包校验失败，未允许安装，请重新下载');
   await fs.rm(target,{force:true});await fs.rename(partial,target);this.file=target;return this.publish({phase:'downloaded',progress:100,message:'下载完成，SHA-256 校验通过；可退出并安装更新'});
  }catch(e){this.file=null;return this.publish({phase:'available',progress:0,message:'下载失败：'+e.message});}
  finally{clearTimeout(timer);controller.abort();if(handle)await handle.close().catch(()=>{});await fs.rm(partial,{force:true});}
 }
 async prepareInstall(){if(this.pending||this.state.phase!=='downloaded'||!this.file||!this.offer)throw Error('请先下载并校验更新');if(this.isBusy())throw Error('请先停止接收设备并等待烧录、产测和 CSV 保存完成');const file=this.file,a=this.offer.artifact;try{if((await fs.stat(file)).size!==a.size||await digest(file)!==a.sha256)throw Error('更新包发生变化');}catch{this.file=null;this.publish({phase:'available',progress:0,message:'更新包在下载后发生变化或已被移除，请重新下载'});throw Error(this.state.message);}if(this.isBusy())throw Error('设备任务已开始，暂不能安装更新');return {file,sha256:a.sha256,version:this.offer.version};}
}
module.exports={UpdateService,validateManifest,newer,allowedUrl,digest,FEED,REPOSITORY};
