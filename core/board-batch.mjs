import {productionReady} from './production.mjs';
const selected=(mode,id)=>mode==='dual'||mode===id;
const stamp=()=>new Date().toISOString();
export function batchRowGroups(rows){return {active:rows.filter(r=>r.connected),finished:rows.filter(r=>!r.connected)};}
export class BoardBatch {
 constructor({id=crypto.randomUUID(),config,limit=4,io,createESP,createML,portFor,save,change=()=>{},fatal=()=>{},createProduction=null,schedule=(fn,ms)=>setTimeout(fn,ms),unschedule=id=>clearTimeout(id)}){
  if(!['dual','esp32','ml307h'].includes(config.mode)||!Number.isInteger(limit)||limit<1||limit>8)throw Error('批量配置无效');
  Object.assign(this,{config,limit,io,createESP,createML,portFor,save,change,fatal,createProduction,schedule,unschedule});this.id=id;this.rows=[];this.boards=new Map();this.identities=new Map();this.queue=[];this.accepting=true;this.running=0;this.progressTimer=null;
 }
 get busy(){return this.accepting||this.running>0;}
 emit(){if(this.progressTimer!==null){this.unschedule(this.progressTimer);this.progressTimer=null;}this.change(this);}
 // Protocol acknowledgements update the model immediately; rendering their
 // progress is shared across all boards at 10 Hz. State/failure/finish events
 // still emit synchronously, so throttling cannot delay terminal results.
 emitProgress(){if(this.progressTimer===null)this.progressTimer=this.schedule(()=>{this.progressTimer=null;this.emit();},100);}
 update(boards,{presentHubIds=boards.map(b=>b.id)}={}){const live=new Set([...presentHubIds,...boards.map(b=>b.id)]);
  for(const row of this.rows){row.connected=this.boards.get(row.board.id)===row&&live.has(row.board.id);
   if(!row.connected&&this.boards.get(row.board.id)===row){this.boards.delete(row.board.id);if(['waiting','queued'].includes(row.state)){row.state='canceled';row.message='设备已拔出，未开始写入';this.queue=this.queue.filter(r=>r!==row);void this.persist(row,'skipped').catch(()=>{});}}
  }
  for(const board of boards){let row=this.boards.get(board.id);if(!row){if(!this.accepting)continue;row={id:crypto.randomUUID(),startedAt:stamp(),board,mac:'',imei:'',state:'waiting',message:board.reason,connected:true,inFlight:false,logs:[],chips:{}};for(const id of ['esp32','ml307h'])row.chips[id]={state:selected(this.config.mode,id)?'pending':'skipped',progress:0,message:selected(this.config.mode,id)?'等待配对':'本批次未选择'};this.boards.set(board.id,row);this.rows.push(row);}row.connected=true;
   if(['waiting','queued'].includes(row.state)){row.board=board;row.message=board.reason||'端口已配对，等待空闲通道';row.state=board.ready&&this.accepting?'queued':'waiting';if(row.state==='queued'&&!this.queue.includes(row))this.queue.push(row);}
  }
  this.emit();this.pump();
 }
 stop(){this.accepting=false;for(const row of this.rows)if(['queued','waiting'].includes(row.state)){row.state='canceled';row.message='已停止接收，未写入';void this.persist(row,'skipped').catch(()=>{});}this.queue=[];this.emit();}
 pump(){while(this.accepting&&this.running<this.limit){const i=this.queue.findIndex(row=>row.state==='queued'&&row.connected&&!this.rows.some(other=>other!==row&&other.inFlight&&other.board.hubKey===row.board.hubKey));if(i<0)return;const [row]=this.queue.splice(i,1);this.running++;row.inFlight=true;void this.run(row).finally(()=>{row.inFlight=false;this.running--;this.emit();this.pump();});}}
 record(row,status='running',message=row.message){
  const record={schema:1,id:row.id,mode:this.config.mode,serial:row.mac||row.imei||row.board.label,hub:row.board.hubKey,batchId:this.id,startedAt:row.startedAt,status,message:row.message,productionTest:row.production?.state||'not-run',production:row.production,steps:Object.entries(row.chips).filter(([id])=>selected(this.config.mode,id)).map(([id,s])=>({id,status:({passed:'passed',failed:'failed',skipped:'skipped',pending:'pending'})[s.state]||'running',startedAt:s.startedAt||row.startedAt,finishedAt:s.finishedAt,...(id==='esp32'?{firmware:(this.config.entries||[]).map(p=>`${p.name}@${p.address}`).join(', '),digest:this.config.digest}:{firmware:this.config.ml?.firmwareName}),...s.details,mac:row.mac,imei:id==='ml307h'?row.imei:'',message:s.message}))};
  record.message=message;if(status!=='running')record.finishedAt=stamp();
  return structuredClone(record);
 }
 snapshotForExit(){return this.rows.filter(r=>r.inFlight||['waiting','queued'].includes(r.state)).map(r=>this.record(r));}
 async persist(row,status='running',message=row.message){
  try{await this.save(this.record(row,status,message));}catch(e){row.journalFailed=true;this.stop();this.fatal('本机记录写入失败，停止接收新设备：'+e.message);throw Error('本机记录保存失败：'+e.message);}
 }
 callbacks(row,id){return {log:message=>{row.logs.push(`[${id}] ${String(message).slice(0,500)}`);if(row.logs.length>200)row.logs.shift();},progress:value=>{const next=Math.max(0,Math.min(100,value));if(row.chips[id].progress===next)return;row.chips[id].progress=next;this.emitProgress();},stage:message=>{if(row.chips[id].message===message)return;row.chips[id].message=message;this.emitProgress();}};}
 async run(row){
  row.startedAt=stamp();row.state='identifying';row.message='读取 ESP32 MAC / ML307H 身份';this.emit();let lease,esp,ml,successMessage;
  try{
   ({lease}=await this.io('claim',{id:row.board.id}));
   const probes=[];
   if(selected(this.config.mode,'esp32')){esp=this.createESP(this.callbacks(row,'esp32'));row.chips.esp32.state='identifying';probes.push(['esp32',()=>esp.connect(this.config.chip,this.config.baud,this.portFor(lease,row.board.esp))]);}
   if(selected(this.config.mode,'ml307h')){ml=this.createML(this.callbacks(row,'ml307h'));row.chips.ml307h.state='identifying';probes.push(['ml307h',()=>ml.probe(lease,this.config.ml.pkg)]);}
   const results=await Promise.allSettled(probes.map(([,fn])=>fn()));
   for(let i=0;i<results.length;i++){const id=probes[i][0],r=results[i];if(r.status==='rejected'){row.chips[id].state='failed';row.chips[id].message=r.reason.message;}else{row.chips[id].state='ready';row.chips[id].message='身份已确认';}}
   if(esp?.mac)row.mac=esp.mac;
   if(ml?.identity)row.imei=ml.identity.imei;
   if(results.some(r=>r.status==='rejected'))throw Error('身份检查失败，两个芯片均未开始写入');
   if(esp&&(!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(row.mac)||['00:00:00:00:00:00','FF:FF:FF:FF:FF:FF'].includes(row.mac)))throw Error('ESP32 MAC 无效，未开始写入');
   const keys=[row.mac&&`mac:${row.mac}`,row.imei&&`imei:${row.imei}`].filter(Boolean),previousRows=[...new Set(keys.map(k=>this.identities.get(k)).filter(Boolean))];
   for(const previous of previousRows){
    if(previous.inFlight||previous.connected)throw Error('该 MAC / IMEI 已在另一板卡任务中，请检查重复身份');
    if((row.mac&&previous.mac&&row.mac!==previous.mac)||(row.imei&&previous.imei&&row.imei!==previous.imei))throw Error('芯片组合与本批次已有板卡不一致，拒绝串配');
   }
   for(const key of keys)this.identities.set(key,row);
   this.emit();await this.persist(row);
   if(!this.accepting)throw Error('批次已停止，两个芯片均未开始写入');
   const productionEnabled=this.config.production===true&&this.config.mode==='dual';
   row.state='flashing';row.message=this.config.mode==='dual'?'两颗芯片独立写入中':'正在写入所选芯片';this.emit();
   const task=async(id,fn)=>{const state=row.chips[id];state.state='flashing';state.startedAt=stamp();state.message='正在写入';this.emit();
    try{state.details=await fn();state.state='passed';state.progress=100;state.message=id==='esp32'?(productionEnabled?'MD5 校验通过 · 等待双芯就绪后启动':'MD5 校验通过 · 已请求复位'):'协议应答完成 · 已请求复位';}
    catch(e){state.state='failed';state.message=e.message;state.details={...(e.details||{}),verification:e.verification||e.details?.verification||'unconfirmed',reset:e.reset||e.details?.reset||'unconfirmed',checksumRetries:e.checksumRetries};}
    state.finishedAt=stamp();if(id==='esp32'&&state.details?.checksumRetries)state.message+=` · 校验拒绝后重传 ${state.details.checksumRetries} 次`;this.emit();if(!row.journalFailed)try{await this.persist(row);}catch{}
   };
   const writes=[];
   if(esp)writes.push(task('esp32',async()=>({...await esp.flash(this.config.entries,{deferReset:productionEnabled}),digest:this.config.digest})));
   if(ml)writes.push(task('ml307h',()=>ml.flash({...this.config.ml,beforeSwitch:async details=>{row.chips.ml307h.details=details;await this.persist(row);}})));
   await Promise.all(writes);
   let passed=Object.entries(row.chips).filter(([id])=>selected(this.config.mode,id)).every(([,s])=>s.state==='passed')&&!row.journalFailed;
   if(passed&&productionEnabled){
    row.state='testing';row.message='烧录完成 · 等待 ML307H 重启就绪';row.production={state:'starting',reason:row.message,cloudRegistered:null};this.emit();await this.persist(row);
    if(!this.createProduction)throw Error('产测适配器未配置');
    try{await ml.waitReady();}catch(e){row.chips.ml307h.state='failed';row.chips.ml307h.message=e.message;throw e;}
    await esp.resetAfterProbe();await esp.disconnect();row.chips.esp32.details.reset='requested';row.chips.esp32.message='MD5 校验通过 · 已启动';
    const runner=this.createProduction(async value=>{row.production=value;row.message=value.phaseReason||value.reason;this.emit();await this.persist(row);});
    row.production=await runner.run({lease,board:row.board,mac:row.mac});
    passed=productionReady(row.production);
    if(passed){successMessage='双芯烧录与产测通过 · 云端已登记 · 最终报告已上传';row.state='finishing';row.message='结果已确认 · 正在释放设备端口';this.emit();}
    else{row.state=row.production.state==='failed'?'failed':'review';row.message=row.production.phaseReason||(row.production.state==='passed'?'云端登记或最终报告未确认，整板未通过':row.production.reason);await this.persist(row,'failed');}
    return;
   }
   row.state=passed?'finishing':'failed';row.message=passed?'写入已完成 · 正在释放设备端口':row.journalFailed?'记录保存失败，请检查本机磁盘':'烧录失败，请查看两个芯片的独立结果';
   if(passed){successMessage=this.config.mode==='dual'?'双芯片烧录成功 · 可拔出':'所选芯片烧录成功 · 可拔出';this.emit();}
   else if(!row.journalFailed)await this.persist(row,'failed');
  }catch(error){
   row.state='failed';row.message=error.message;if(row.production&&['starting','running'].includes(row.production.state))row.production={...row.production,state:'review',reason:error.message};for(const state of Object.values(row.chips))if(['pending','ready','identifying'].includes(state.state)){state.state='skipped';state.message='未写入';}
   if(!row.journalFailed)try{await this.persist(row,'failed');}catch(e){row.message+='；'+e.message;}
  }finally{
   let cleanupChanged=false;
   if(esp?.loader)try{await esp.resetAfterProbe();if(row.chips.esp32.details?.reset==='deferred'){row.chips.esp32.details.reset='requested';row.chips.esp32.message='MD5 校验通过 · 已请求复位';cleanupChanged=true;}}catch(e){row.state='failed';row.message='ESP32 复位失败：'+e.message;if(row.chips.esp32.details)row.chips.esp32.details.reset='unconfirmed';cleanupChanged=true;}
   const disconnected=await Promise.allSettled([esp?.disconnect(),ml?.disconnect()]);
   const closeError=disconnected.find(r=>r.status==='rejected');if(closeError){row.state='failed';row.message='串口关闭失败：'+closeError.reason.message;cleanupChanged=true;}
   if(lease)try{await this.io('release',{lease});}catch(e){row.state='failed';row.message='接口释放失败：'+e.message;cleanupChanged=true;this.stop();this.fatal(row.message);}
   if(successMessage&&row.state==='finishing'&&!row.journalFailed){
    row.message='结果已确认 · 正在保存记录和批次 CSV';this.emit();
    try{await this.persist(row,'completed',successMessage);row.state='passed';row.message=successMessage;}
    catch(e){row.state='failed';row.message=e.message;}
   }
   if(cleanupChanged&&!row.journalFailed&&this.rows.includes(row))try{await this.persist(row,row.state==='passed'?'completed':'failed');}catch{}
   this.emit();
  }
 }
}
