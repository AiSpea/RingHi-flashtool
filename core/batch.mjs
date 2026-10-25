// Each port owns its transport; MAC claims are acquired before any write.
export class BatchQueue {
 constructor({limit=4,createFlasher,entries,chip,baud,digest,save,change=()=>{},fatal=()=>{}}){
  if(!Number.isInteger(limit)||limit<1||limit>8)throw Error('并发数必须为 1–8');
  Object.assign(this,{limit,createFlasher,entries,chip,baud,digest,save,change,fatal});
  this.id=crypto.randomUUID();this.rows=[];this.ports=new Map();this.macs=new Map();this.queue=[];this.running=0;this.accepting=true;
 }
 get busy(){return this.accepting||this.running>0;}
 emit(){this.change(this);}
 add(port,label){
  if(!this.accepting||this.ports.has(port))return;
  const row={id:crypto.randomUUID(),port,label,mac:'',state:'queued',progress:0,message:'等待空闲烧录通道',connected:true,logs:[]};
  this.ports.set(port,row);this.rows.push(row);this.queue.push(row);this.emit();this.pump();return row;
 }
 detach(port){const row=this.ports.get(port);if(!row)return;row.connected=false;this.ports.delete(port);if(row.state==='queued'){row.state='canceled';row.message='排队时设备已拔出';}this.emit();}
 stop(){this.accepting=false;for(const row of this.queue){if(row.state==='queued'){row.state='canceled';row.message='已停止接收，未开始烧录';}}this.queue=[];this.emit();}
 pump(){while(this.accepting&&this.running<this.limit&&this.queue.length){const row=this.queue.shift();if(row.state!=='queued')continue;this.running++;void this.run(row).finally(()=>{this.running--;this.emit();this.pump();});}}
 async persist(row,status,details={}){
  const now=new Date().toISOString();
  await this.save({schema:1,id:row.id,serial:row.mac||row.label,mode:'esp32',batchId:this.id,startedAt:row.startedAt,status,productionTest:'not-run',...(status==='running'?{}:{finishedAt:now}),steps:[{id:'esp32',status:status==='completed'?'passed':status==='failed'?'failed':status==='skipped'?'skipped':'running',startedAt:row.startedAt,mac:row.mac,port:row.label,digest:this.digest||'',firmware:this.entries.map(p=>`${p.name}@0x${p.address.toString(16)}`).join(', '),...details}]});
 }
 async run(row){
  row.startedAt=new Date().toISOString();row.state='identifying';row.message='正在连接芯片并读取 MAC';this.emit();
  const flasher=this.createFlasher({log:message=>{row.logs.push(String(message).slice(0,500));if(row.logs.length>120)row.logs.shift();},progress:value=>{row.progress=value;this.emit();}});
  let journalFailed=false;
  const record=async(status,details)=>{try{await this.persist(row,status,details);}catch(e){journalFailed=true;this.stop();throw Error('本机记录保存失败，已停止接收新设备：'+e.message);}};
  try{
   await record('running');
   await flasher.connect(this.chip,this.baud,row.port);
   row.mac=flasher.mac;
   if(!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(row.mac)||['00:00:00:00:00:00','FF:FF:FF:FF:FF:FF'].includes(row.mac))throw Error('MAC 无效，未写入固件');
   if(this.macs.has(row.mac)){
    row.state='duplicate';row.message='本批次已处理此 MAC，未重复写入';this.emit();await record('skipped',{message:row.message,verification:'not-run'});return;
   }
   this.macs.set(row.mac,row);
   row.state='identified';row.message='MAC 已识别，准备自动写入';this.emit();
   if(!row.connected)throw Error('设备已断开，未写入固件');
   // Stopping intake also stops a probe that has not yet begun its write.
   if(!this.accepting){row.state='canceled';row.message='已停止，设备尚未写入';await record('skipped',{message:row.message,verification:'not-run'});return;}
   await record('running',{firmware:this.entries.map(p=>p.name).join(', ')});
   // Recheck after journal I/O: stop/disconnect may have arrived during it.
   if(!this.accepting||!row.connected)throw Error('写入前已停止或设备断开，未写入固件');
   row.state='flashing';row.message='正在写入并校验';this.emit();
   const result=await flasher.flash(this.entries);row.result=result;
   await record('completed',result);
   row.state='passed';row.progress=100;row.message='MD5 校验通过 · 已请求复位 · 可拔出';
  }catch(error){
   row.state='failed';row.message=error.message;
   if(!journalFailed){try{await record('failed',{message:error.message,verification:error.verification||'not-run',reset:error.reset||'not-requested'});}catch(e){row.message+='；'+e.message;}}
   if(journalFailed)this.fatal(row.message);
  }finally{await flasher.disconnect().catch(()=>{});row.finishedAt=new Date().toISOString();this.emit();}
 }
}
