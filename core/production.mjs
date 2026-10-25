// Interpret device reports, never infer a pass from LEDs or a persistent done bit.
export const productionLabels={'not-run':'未执行',starting:'等待启动',running:'产测中',passed:'产测通过',failed:'产测失败',review:'待复测',cancelled:'已取消',interrupted:'已中断'};
export const productionPhaseLabels={registration:'等待云端登记',upload:'等待报告上传',closing:'正在释放产测串口',review:'待处理'};
// A measured pass alone is not a completed board. Require the cloud acknowledgement
// and delivery of this run's final report, including after a bounded wait expires.
export const productionReady=p=>p?.state==='passed'&&p.cloudRegistered===true&&p.pendingUpload===false&&p.upload==='uploaded'&&p.phase!=='review';
const text=v=>typeof v==='string'?v.slice(0,512):'';
export function evaluateFactory(status){
 const r=status?.report,base={runId:text(r?.runId),policy:text(r?.ledPolicy),stage:text(r?.stage),firmware:text(r?.espVersion),cloudRegistered:typeof status?.cloudRegistered==='boolean'?status.cloudRegistered:null,upload:text(status?.upload),pendingUpload:status?.pendingUpload===true,checks:[]};
 if(!r || !base.runId || !Array.isArray(r.checks))return {...base,state:'running',reason:'等待新一轮产测，检查 AiSpea_Factory 工厂 Wi-Fi'};
 base.checks=r.checks.slice(0,32).map(c=>({id:text(c.id),status:text(c.status),detail:text(c.detail)}));
 if(r.cancelled===true || r.stage==='cancelled')return {...base,state:'cancelled',reason:'设备取消了本轮产测'};
 const failed=base.checks.filter(c=>c.status==='failed');
 if(failed.length || r.stage==='failed')return {...base,state:'failed',reason:failed.map(c=>`${c.id}: ${c.detail||'未通过'}`).join('；')||'设备报告本轮产测失败'};
 const pass=id=>base.checks.some(c=>c.id===id&&c.status==='passed');
 if(r.ledPolicy==='volte-card-v3'){
  if(r.stage!=='passed')return {...base,state:'running',reason:({connected:'工厂 Wi-Fi 已连接',volte_check:'检查 VoLTE 授权',volte_passed:'VoLTE 授权通过',sim_check:'检查 SIM / eSIM 响应'})[r.stage]||'正在产测'};
  return ['wifi','volte','sim'].every(pass)?{...base,state:'passed',reason:'工厂 Wi-Fi、VoLTE 授权、有卡响应通过'}:{...base,state:'review',reason:'终态与检查项不一致，不能确认通过'};
 }
 if(r.ledPolicy && r.ledPolicy!=='module-card-v2')return {...base,state:'review',reason:'未知产测协议，请更新工具'};
 // Legacy s3.91–s3.96 has no final stage: require every gate AND this run's done.
 const required=['storage','at','modem','spi','wifi','rf'];if(r.profile!=='sim_optional')required.push('sim');
 if(r.ledPolicy==='module-card-v2'){
  const slots=r.simSlots||[];
  if(slots.some(s=>['error','locked'].includes(s.status)))return {...base,state:'failed',reason:'卡槽通信异常或锁卡'};
  if(slots.length!==2 || slots.some(s=>s.status==='unknown'))return {...base,state:'running',reason:'等待双卡槽检查完成'};
  if(r.profile==='euicc'&&!slots.some(s=>s.type==='euicc'&&s.status==='read'))return {...base,state:'review',reason:'未确认 eUICC，需检查产品模板与测试卡'};
  if(r.profile==='sim_required'&&!slots.some(s=>s.status==='read'))return {...base,state:'review',reason:'未读取到测试卡'};
 }
 if(base.checks.some(c=>c.status==='review'&&!['cloud','led','cellular','audio'].includes(c.id)))return {...base,state:'review',reason:base.checks.filter(c=>c.status==='review').map(c=>`${c.id}: ${c.detail}`).join('；')};
 if(status.done===true&&required.every(pass))return {...base,state:'passed',reason:'旧版产测必检项通过'};
 return {...base,state:'running',reason:'等待旧版产测必检项完成'};
}
export class ProductionRunner {
 constructor({connect,change=()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,bootTimeout=45000,testTimeout=180000,cloudTimeout=30000,poll=1500}){Object.assign(this,{connect,change,sleep,now,bootTimeout,testTimeout,cloudTimeout,poll});}
 async run(context){
  let port,last={state:'starting',reason:'等待 ESP32 USB 控制台',cloudRegistered:null,upload:''},baseline='',runId='',seq=-1;
  const emit=async value=>{last=value;await this.change(value);return value;};await emit(last);
  try{
   const bootEnd=this.now()+this.bootTimeout;let status;
   while(this.now()<bootEnd){
    try{port=await this.connect(context);status=await port.status();if(status)break;}catch{}
    await port?.close();port=null;await this.sleep(this.poll);
   }
   if(!status) return emit({...last,state:'review',reason:'未收到 FACTORY STATUS：固件未启动、接口不支持或设备断开'});
   baseline=status.report?.runId||'';
   if(status.pendingUpload)return emit({...evaluateFactory(status),state:'review',reason:'设备有上一轮待上传报告；保留报告，联网上传后再测',runId:''});
   const reply=await port.retest();
   if(reply!=='armed')return emit({...last,state:'review',reason:reply==='refused'?'设备拒绝产测：已有用户配置、业务活动或待上传报告':'产测启动未确认，未自动重复发送命令'});
   await emit({...last,state:'running',reason:'等待 AiSpea_Factory 工厂 Wi-Fi，随后自动产测'});
   const end=this.now()+this.testTimeout;let terminalAt=null;
   while(this.now()<end){
    await this.sleep(this.poll);status=await port.status();
    if(!status)continue;
    const id=status.report?.runId;
    if(!id || id===baseline)continue; // Old / resumed report is never this job's result.
    if(runId&&id!==runId)return emit({...last,state:'review',reason:'产测轮次意外变化，需复测'});
    runId=id;
    const next=Number(status.report.sequence);if(Number.isFinite(next)){if(next<seq)return emit({...last,state:'review',reason:'产测报告序号倒退，需复测'});seq=next;}
    const value=evaluateFactory(status);
    if(value.state==='passed'){
     if(terminalAt===null)terminalAt=this.now();
     if(productionReady(value)){
      await emit({...value,phase:'closing',phaseReason:'产测与云端结果已确认 · 正在释放产测串口'});
      await port.close();port=null;
      return {...value,phase:'complete',phaseReason:''};
     }
     const phase=value.cloudRegistered===true?'upload':'registration';
     const phaseReason=phase==='upload'?'产测通过、云端已登记 · 等待最终报告上传':'产测通过 · 等待云端登记成功';
     if(/HTTP (403|409)/.test(value.upload))return emit({...value,phase:'review',phaseReason:`云端拒绝本轮报告（${value.upload}），整板未通过，请检查登记权限或设备身份`});
     if(this.now()-terminalAt>=this.cloudTimeout)return emit({...value,phase:'review',phaseReason:phase==='upload'?'最终报告上传超时，整板未通过，请检查工厂网络后复测':'云端登记未确认或超时，整板未通过，请检查工厂网络与登记权限'});
     await emit({...value,phase,phaseReason});
    }else{
     await emit(value);
     if(value.state!=='running')return value;
    }
   }
   if(last.state==='passed')return emit({...last,phase:'review',phaseReason:last.cloudRegistered===true?'最终报告上传未完成，整板未通过':'云端登记未确认，整板未通过'});
   return emit({...last,state:'review',reason:runId?'产测等待超时，请检查设备、测试卡与工厂网络':'未开始产测：未发现或未连接 AiSpea_Factory 工厂 Wi-Fi，或设备不满足产测条件'});
  }catch(e){return emit({...last,state:'review',reason:'产测通信中断：'+e.message});}
  finally{await port?.close();}
 }
}
