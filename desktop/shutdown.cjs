const fs=require('node:fs/promises'),path=require('node:path');
const {atomicWrite}=require('./batch-csv.cjs');
const message='用户关闭软件，任务已中断；未完成的设备需重新烧录或复测。授权结果未确认时请先核对，勿重复领取。';
function interruptedRecord(record){
 if(record.status!=='running')return record;
 const out=structuredClone(record),now=new Date().toISOString();
 const waiting=out.steps.every(s=>['pending','skipped'].includes(s.status));
 out.status=waiting?'skipped':'interrupted';out.finishedAt=now;out.message=waiting?'用户关闭软件，排队任务未开始写入':message;
 for(const step of out.steps){if(step.status==='pending'){step.status='skipped';step.message='用户关闭软件，未执行';}else if(step.status==='running'){step.status='interrupted';step.finishedAt=now;step.message='用户关闭软件，写入或授权结果未确认';}}
 if(out.production){out.production={...out.production,phase:'interrupted',phaseReason:out.message};if(['starting','running'].includes(out.production.state)){out.production.state='interrupted';out.production.reason='用户关闭软件，产测未完成';out.productionTest='interrupted';}}
 return out;
}
// Main-process journal: survives destruction of the renderer and retains passed
// chips/finished jobs. Fresh snapshots include queued boards not yet journaled.
async function saveInterruptedJobs({jobs,ids,records=[]}){
 await fs.mkdir(jobs,{recursive:true});const snapshots=new Map(records.map(r=>[r.id,r]));
 for(const id of new Set([...ids,...snapshots.keys()])){
  if(!/^[0-9a-f-]{36}$/.test(id))throw Error('退出记录任务号无效');
  const file=path.join(jobs,id+'.json');let old;
  try{old=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(old&&old.status!=='running')continue;
  const record=snapshots.get(id)||old;if(!record)continue;
  await atomicWrite(file,JSON.stringify(interruptedRecord(record),null,2));
 }
}
class ShutdownCoordinator {
 constructor(options){Object.assign(this,options);this.pending=null;this.blocked=false;this.finished=false;}
 request(){if(this.finished)return Promise.resolve(true);if(this.pending)return this.pending;this.pending=this.run().finally(()=>{this.pending=null;});return this.pending;}
 async run(){
  if(this.isBusy()&&!await this.confirm())return false;
  this.blocked=true;this.block();
  // Invalidate native leases before awaiting renderer IPC. Browser-owned USB and
  // serial work stops when the renderer is destroyed, before final CSV flush.
  const stopping=Promise.resolve().then(()=>this.stopDevices()).catch(()=>{});
  let records=[];try{records=await this.snapshot();}catch{}
  this.stopRenderer();
  await this.save(records);
  let timer;await Promise.race([stopping,new Promise(r=>{timer=setTimeout(r,3000);})]);clearTimeout(timer);
  this.finished=true;await this.quit();return true;
 }
}
module.exports={ShutdownCoordinator,interruptedRecord,saveInterruptedJobs};
