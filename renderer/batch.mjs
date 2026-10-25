import {defaultBackupDirectory} from './backup.mjs';
import {createProduction} from './production.mjs';
import {productionLabels,productionPhaseLabels} from '../core/production.mjs';
import {BoardBatch,batchRowGroups} from '../core/board-batch.mjs';
import {EspFlasher} from './esp.mjs';
import {MlBatchFlasher} from './ml-batch.mjs';
import {nativeCall,NativeSerialPort} from './native.mjs';
import {parsePackage,matchPackageProfile,MAX_PACKAGE} from './upstream/ml307h/package.mjs';
const $=id=>document.getElementById(id);
const states={pending:'等待',waiting:'等待配对',queued:'排队',identifying:'识别中',ready:'已识别',flashing:'烧录中',passed:'完成',failed:'失败',skipped:'未写入',canceled:'未开始'};
export function mountBatch({getConfig,canStart,disconnect,refresh,activationFactory,activationReason}){
 let batch=null,timer=null,scanning=false,starting=false,prepared=null,backup=null,reading=false,lastError='',nodes=new Map(),csvBatch=null,csvClosed=false,csvEnding=false,csvState='开启新批次时选择保存文件，每批次单独记录。';
 const busy=()=>starting||Boolean(batch?.busy);
 const tell=(message,error=false)=>{$('batch-notice').textContent=message;$('batch-notice').className='notice'+(error?' error':'');};
 const csvCall=async(action,payload={})=>{const r=await window.ringhi.batchCsv(action,payload);if(!r.ok)throw Error(r.error);return r.data;};
 function csvResult(result){if(!result)return;csvState=result.saved?`已自动保存 ${result.rows} 条任务记录`:result.error;$('batch-csv-status').className=result.saved?'muted':'notice error';if(!result.saved){lastError=result.error;stop();}}
 async function saveRecord(record){const r=await window.ringhi.saveJob(record);csvResult(r.csv);if(r.csv?.saved===false)throw Error(r.csv.error||'批次 CSV 保存失败');update();}
 async function finishCsv(){if(!csvBatch||csvClosed||csvEnding)return;csvEnding=true;csvClosed=true;try{csvResult(await csvCall('end',{id:csvBatch.id}));}catch(e){csvState=e.message;$('batch-csv-status').className='notice error';}finally{csvEnding=false;update();}}
 function selectedFilter(){
  if($('batch-adapter').value!=='custom'){const [vendorId,productId]=$('batch-adapter').value.split(':').map(Number);return {vendorId,productId};}
  const vid=$('batch-vid').value.trim(),pid=$('batch-pid').value.trim();if(!/^[0-9a-f]{4}$/i.test(vid)||!/^[0-9a-f]{4}$/i.test(pid))throw Error('VID 和 PID 请填写 4 位十六进制');
  const vendorId=parseInt(vid,16),productId=parseInt(pid,16);if(!vendorId||vendorId===0x3563)throw Error('请选择 ESP32 下载接口');return {vendorId,productId};
 }
 function recipe(){const mode=$('batch-mode').value;const config={mode,production:mode==='dual'&&$('batch-production').checked,...(mode==='ml307h'?{}:getConfig())};selectedFilter();
  if(mode!=='esp32'){
   if(reading)throw Error('正在读取 ML307H PKG');
   if(!prepared)throw Error('请选择有效的 ML307H PKG');
   if(!backup)throw Error('ML307H 备份目录未就绪，请选择可写文件夹');
   if(!$('batch-ml-consent').checked)throw Error('请勾选 ML307H 固件适用确认');
   const reason=activationReason();if(reason)throw Error(reason);
   config.ml={pkg:prepared.pkg,firmwareName:prepared.name,backup,activationFactory};
  }
  return config;
 }
 function update(){
  let ready=false;try{const config=recipe();ready=canStart();if(!batch?.busy)$('batch-recipe').textContent=[config.entries?.map(p=>`${p.name} @ 0x${p.address.toString(16)}`).join(' / '),config.ml?.firmwareName].filter(Boolean).join(' ＋ ');}catch(e){if(!batch?.busy)$('batch-recipe').textContent=e.message;}
  $('batch-start').disabled=busy()||csvEnding||!ready;$('batch-export-csv').disabled=!csvBatch||csvEnding;$('batch-csv-path').textContent=csvBatch?.csvPath||'尚未选择 · 开启新批次时选择';$('batch-csv-status').textContent=csvState;$('batch-stop').disabled=!batch?.accepting;
  $('batch-options').disabled=busy();$('batch-ml-fields').disabled=busy();$('batch-state').textContent=batch?.accepting?'自动配对 / 接收中':batch?.running?'停止接收 · 等待任务收尾':batch?'已停止':'尚未开启';
  const rows=batch?.rows||[],groups=batchRowGroups(rows);$('batch-empty').hidden=groups.active.length>0;$('batch-finished-empty').hidden=groups.finished.length>0;$('batch-active-count').textContent=`${groups.active.length} 台`;$('batch-finished-count').textContent=`${groups.finished.length} 条记录`;
  const activeIds=new Set(groups.active.map(r=>r.id));
  for(const [id,value] of [['batch-total',rows.length],['batch-running',batch?.running||0],['batch-passed',rows.filter(r=>r.state==='passed').length],['batch-failed',rows.filter(r=>['failed','review'].includes(r.state)).length]])$(id).textContent=value;
  const keep=new Set(rows.map(r=>r.id));for(const [id,node] of nodes)if(!keep.has(id)){node.remove();nodes.delete(id);}
  for(const [index,row] of rows.entries()){
   let tr=nodes.get(row.id);if(!tr){tr=document.createElement('tr');tr.innerHTML='<td class="board-number"></td><td><strong class="mac"></strong><small class="hub"></small></td><td class="esp-cell"><progress max="100"></progress><span class="chip-status"></span><small class="chip-detail"></small></td><td class="ml-cell"><progress max="100"></progress><span class="chip-status"></span><small class="chip-detail"></small></td><td class="production-cell"><strong class="production-status"></strong><small class="production-reason"></small><small class="cloud-status"></small></td><td><strong class="overall"></strong><small class="result"></small></td><td><details><summary>日志</summary><pre></pre></details></td>';nodes.set(row.id,tr);}
   const target=$(activeIds.has(row.id)?'batch-devices':'batch-finished');if(tr.parentElement!==target)target.append(tr);
   tr.dataset.state=row.state;tr.querySelector('.board-number').textContent=`#${String(index+1).padStart(2,'0')}`;tr.querySelector('.mac').textContent=row.mac||($('batch-mode').value==='ml307h'?'仅 ML307H':'等待读取 MAC');tr.querySelector('.hub').textContent=`${row.board.label} · ${row.connected?'已接入':row.inFlight?'已拔出 · 等待任务收尾':'已拔出'}${row.imei?' · IMEI '+row.imei:''}`;
   for(const [id,cls] of [['esp32','.esp-cell'],['ml307h','.ml-cell']]){const cell=tr.querySelector(cls),s=row.chips[id];cell.dataset.state=s.state;cell.querySelector('progress').value=s.progress;cell.querySelector('.chip-status').textContent=`${states[s.state]||s.state} · ${s.progress}%`;cell.querySelector('.chip-detail').textContent=s.message;}
   const p=row.production;tr.querySelector('.production-status').textContent=productionLabels[p?.state||'not-run'];tr.querySelector('.production-reason').textContent=p?.reason||'等待双芯烧录完成';tr.querySelector('.cloud-status').textContent=p?`${p.cloudRegistered===true?'云端已登记':p.cloudRegistered===false?'云端未确认登记':'登记状态未提供'} · ${p.pendingUpload?'报告待上传':p.upload==='uploaded'?'报告已上传':p.upload||'等待报告'}`:'—';
   tr.querySelector('.overall').textContent=row.state==='passed'?(row.connected?'✓ 成功 · 待拔出':'✓ 成功'):row.state==='failed'?'✕ 失败':row.state==='review'?'! 待复测':row.state==='finishing'?'◌ 正在收尾':row.state==='testing'?'◌ '+(productionPhaseLabels[p?.phase]||'产测中'):row.state==='flashing'?'◌ 烧录中':states[row.state]||row.state;tr.querySelector('.result').textContent=row.message;const pre=tr.querySelector('pre'),logs=row.logs.join('\n')||'等待设备流程';if(pre.textContent!==logs){const top=pre.scrollTop;pre.textContent=logs;pre.scrollTop=top;}
  }
 }
 function changed(){update();refresh({batchUpdated:true});if(batch&&!batch.busy&&!starting)void finishCsv();}
 async function scan(){if(scanning||!batch)return;scanning=true;const current=batch;
  try{const result=await nativeCall('scan');if(current===batch)current.update(result.boards,{presentHubIds:result.presentHubIds});}catch(e){lastError='拓扑扫描失败：'+e.message;stop();}finally{scanning=false;}
 }
 function stop(){batch?.stop();void nativeCall('stop').catch(e=>tell(e.message,true));tell(lastError||'已停止接收新板。在途双芯片任务继续收尾，请等待每行结果。',!!lastError);changed();}
 $('batch-start').onclick=async()=>{
  if(busy()||!canStart())return;starting=true;lastError='';update();refresh();
  try{
   const config=recipe(),filter=selectedFilter();await disconnect();
   if(config.entries){const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');config.digest=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode((await Promise.all(config.entries.map(async p=>`${p.address}:${hex(new Uint8Array(await crypto.subtle.digest('SHA-256',p.bytes)))}`))).join('\n')))));}
   const selected=await csvCall('prepare',{mode:config.mode});if(!selected){tell('已取消选择 CSV，未开启新批次。');return;}csvBatch=selected;csvClosed=false;csvState='已创建批次 CSV，等待设备记录';
   const initial=await nativeCall('arm',{filters:[filter],mode:config.mode});nodes=new Map();$('batch-devices').replaceChildren();$('batch-finished').replaceChildren();
   batch=new BoardBatch({id:csvBatch.id,config,createProduction,limit:Number($('batch-limit').value),io:nativeCall,createESP:options=>new EspFlasher(options),createML:options=>new MlBatchFlasher(options),portFor:(lease,endpoint)=>new NativeSerialPort(lease,endpoint),save:saveRecord,change:changed,fatal:message=>{lastError=message;stop();}});
   $('batch-config').open=false;tell('自动配对已开启：同一个板载 Hub 下的芯片合为一行，识别身份后自动烧录。双芯烧录后自动产测，逐项显示结果和云端登记状态。');
   batch.update(initial.boards,{presentHubIds:initial.presentHubIds});clearInterval(timer);timer=setInterval(()=>{if(batch)void scan();},1500);
  }catch(e){lastError=e.message;tell(e.message,true);await nativeCall('stop').catch(()=>{});await finishCsv();}finally{starting=false;changed();}
 };
 $('batch-stop').onclick=stop;
 $('batch-export-csv').onclick=async()=>{if(!csvBatch||csvEnding)return;try{const r=await csvCall('export',{id:csvBatch.id});if(r){csvState=`已导出 ${r.rows} 条任务记录：${r.path}`;$('batch-csv-status').className='muted';}else csvState='已取消导出，原 CSV 保留';}catch(e){csvState=e.message;$('batch-csv-status').className='notice error';}update();};
 $('batch-adapter').onchange=()=>{$('batch-custom').hidden=$('batch-adapter').value!=='custom';update();};
 $('batch-mode').onchange=()=>{$('batch-production').disabled=$('batch-mode').value!=='dual';$('batch-ml-column').hidden=$('batch-mode').value==='esp32';$('batch-columns').classList.toggle('single-chip',$('batch-mode').value!=='dual');$('batch-firmware').hidden=$('batch-mode').value==='ml307h';$('batch-account').hidden=$('batch-mode').value==='esp32';changed();};
 for(const id of ['batch-vid','batch-pid','batch-ml-consent'])$(id).oninput=update;
 $('batch-ml-file').onchange=async event=>{reading=true;prepared=null;$('batch-ml-consent').checked=false;update();const file=event.target.files[0];try{if(!file||file.size>MAX_PACKAGE)throw Error('请选择有效 PKG（最大 64 MiB）');const pkg=await parsePackage(await file.arrayBuffer(),{inspectOnly:true});if(event.target.files[0]!==file)return;pkg.compatibility=matchPackageProfile(pkg,null,{checkBoard:false});if(!pkg.compatibility.supported)throw Error(pkg.compatibility.reason);prepared={pkg,name:file.name};$('batch-ml-status').textContent=`${file.name} · ${pkg.project} · ${pkg.version} · 包结构与校验通过`;}catch(e){$('batch-ml-status').textContent=e.message;}finally{reading=false;update();}};
 $('batch-backup').onclick=async()=>{try{backup=await window.showDirectoryPicker({mode:'readwrite',id:'ringhi-batch-backup'});$('batch-backup-label').textContent=(backup.path||backup.name)+' · 已验证可写 · 每块板独立备份';tell('备份目录已保存，更新和重启后保留。');}catch(e){if(e.name!=='AbortError')tell(e.message,true);}update();};
 window.ringhiBackupReady=window.ringhi.backupFiles?defaultBackupDirectory().then(dir=>{if(!backup){backup=dir;$('batch-backup-label').textContent=dir.path+' · 已验证可写 · 每块板独立备份';}changed();}).catch(e=>{tell('备份目录不可用：'+e.message,true);changed();}):Promise.resolve();
 return {busy,update,snapshotForExit:()=>batch?.snapshotForExit()||[]};
}
