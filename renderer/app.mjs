import {mountUpdates} from './updates.mjs';
import {pickBackupDirectory} from './backup.mjs';
import {mountFlash} from './upstream/ml307h-flash.js';
import {prepareActivation} from './upstream/ml307h/activation.mjs';
import {planFlashEntries} from './upstream/esp-flash-core.mjs';
import {EspFlasher} from './esp.mjs';
import {mountBatch} from './batch.mjs';
import {productionLabels} from '../core/production.mjs';
import {Job} from '../core/job.mjs';
if(window.ringhi.backupFiles)window.showDirectoryPicker=pickBackupDirectory;
const $=id=>document.getElementById(id),native=window.ringhi;
let exiting=false;
window.ringhi.onPrepareExit?.(()=>{exiting=true;document.body.inert=true;return [...(batchUI?.snapshotForExit()||[]),...(active()?[job.snapshot()]:[])];});
let updatesUI;
let batchUI,defaultUsername='',preferredProjectId=null;
let mode='dual',job=null,ml,mlRoot,mlBusy=false,espWorking=false,continuing=false,accountBusy=false,saveError='';
let account={token:'',name:'',projects:[],selected:null,featuresReady:false};
const rows=new Map();let fileReads=0;let latestMl=null;
const text=(id,value)=>$(id).textContent=value;
function notice(id,value,kind=''){text(id,value);$(id).className='notice '+kind;}
function log(value){const el=$('esp-log');el.textContent=(el.textContent+'\n'+String(value).slice(0,1000)).split('\n').slice(-300).join('\n');el.scrollTop=el.scrollHeight;}
const esp=new EspFlasher({log,progress:value=>$('esp-progress').value=value});
const active=()=>job?.record.status==='running';
function accountReason(){return !$('activate').checked?'':accountBusy?'正在登录或查询授权':!account.token?'请先登录 ML307H 授权账号':!account.selected||!account.featuresReady?'请选择授权项目并等待功能查询完成':account.selected.nonactivated_count<1?'所选项目授权额度不足，请刷新授权或更换项目':'';}
function renderAccount(){
 const reason=accountReason(),ready=account.token&&account.featuresReady;
 text('account-status',accountBusy?'登录 / 查询中':!$('activate').checked?'仅烧录 · 激活关闭':ready&&!reason?'授权就绪 · 自动激活':account.token?'授权未就绪':'未登录 · 等待授权');
 $('account-status').dataset.state=ready&&!reason?'ready':'blocked';
 text('batch-auth-state','ML307H · '+$('account-status').textContent);$('batch-auth-state').hidden=$('batch-mode').value==='esp32';
 $('default-account-controls').hidden=Boolean(account.token);$('account-session').hidden=!account.token;
}
function espPlan(){return planFlashEntries([...rows].map(([row,file])=>({enabled:true,name:file?.name,bytes:file?.bytes,address:row.querySelector('.address').value})));}
function espReady(){try{return !!esp.loader&&!esp.busy&&!fileReads&&$('esp-consent').checked&&espPlan().length>0;}catch{return false;}}
async function save(){if(!job)return;try{await native.saveJob(job.snapshot());saveError='';}catch{saveError='任务记录无法写入本机，请检查磁盘；停止继续烧录。';throw Error(saveError);}}
function refresh({batchUpdated=false}={}){
 if(exiting)return;
 const snapshot=ml?.snapshot();const deviceWorking=Boolean(batchUI?.busy()||active()||mlBusy||espWorking||snapshot?.prepared&&!snapshot?.written);const working=deviceWorking||updatesUI?.locked;
 native.setBusy(deviceWorking);updatesUI?.setBusy(deviceWorking);
 $('run').disabled=Boolean(working||saveError||accountBusy||(mode!=='esp32'&&(!snapshot?.ready||accountReason()))||(mode!=='ml307h'&&!espReady()));
 for(const b of $('modes').children)b.disabled=Boolean(working);
 $('serial').disabled=Boolean(working);$('account-fields').disabled=Boolean(working||accountBusy);
 $('esp-fields').disabled=Boolean(working);
 $('ml-workbench').inert=Boolean(batchUI?.busy()||espWorking||active()&&job.record.steps.find(s=>s.id==='esp32')?.status==='running');
 $('ml-summary').textContent=job?.record.steps.find(s=>s.id==='ml307h')?.status==='passed'?'固件完成 · '+(latestMl?.activation==='complete'?'已激活':'未申请激活'):snapshot?.ready?'准备完成':snapshot?.prepared?'下载流程进行中':'等待固件、设备与备份';
 $('esp-summary').textContent=job?.record.steps.find(s=>s.id==='esp32')?.status==='passed'?'写入与 MD5 校验完成':espReady()?'准备完成':esp.loader?'已连接，待核对固件':'等待固件与设备';
 $('esp-connect').disabled=Boolean(working||esp.busy);$('esp-disconnect').disabled=!esp.loader||Boolean(working);
 if(saveError)notice('run-hint',saveError,'error');renderAccount();if(!batchUpdated)batchUI?.update();
}
async function begin(kind){if(active())return;job=new Job(kind,$('serial').value);job.start(kind==='esp32'?'esp32':'ml307h');latestMl=null;refresh();await save();notice('run-hint',kind==='dual'?'双芯片任务进行中：ML307H → ESP32':'任务进行中，请保持连接');refresh();}
async function fail(id,error,details={}){if(active()){job.fail(id,error.message,details);try{await save();}catch{}}notice('run-hint',saveError||error.message,'error');refresh();}
async function done(){await save();notice('run-hint','烧录流程完成。产测尚未执行，请继续检查整板启动与功能。','success');refresh();}
async function runEsp(){
 espWorking=true;refresh();
 try{if(!espReady())throw Error('ESP32 连接或固件准备状态已变化，请重新检查');
  const plan=espPlan();const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(await Promise.all(plan.map(async p=>`${p.address}:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',p.bytes))).map(b=>b.toString(16).padStart(2,'0')).join('')}`)).then(a=>a.join('\n')))))).map(b=>b.toString(16).padStart(2,'0')).join('');
  await save();notice('esp-message','正在写入并校验，请勿断开设备');const result=await esp.flash(plan);job.finish('esp32',{...result,digest});notice('esp-message','写入完成 · MD5 校验通过 · 已请求复位','success');await done();
 }catch(e){log(e.message);notice('esp-message','已停止：'+e.message,'error');await fail('esp32',e,{verification:e.verification||'not-run',reset:e.reset||'not-requested'});}
 finally{espWorking=false;text('esp-identity',esp.chip||'连接已释放');refresh();}
}
async function settle(snapshot){
 refresh();if(!active()||continuing||!latestMl)return;
 continuing=true;
 try{job.finish('ml307h',{firmware:snapshot.firmware,digest:snapshot.digest,uid:snapshot.uid,backup:snapshot.backup,activation:snapshot.activation,verification:'protocol-ack',reset:'requested'});await save();
  if(job.record.mode==='dual'){job.start('esp32');await save();await runEsp();}else await done();
 }catch(e){const id=job.record.steps.find(s=>s.status==='running')?.id;if(id)await fail(id,e);else notice('run-hint',e.message,'error');}
 finally{continuing=false;refresh();}
}
function addRow(){const row=document.createElement('tr');row.innerHTML='<td><input type="file" accept=".bin" aria-label="ESP32 BIN 固件"></td><td><input class="address" value="0x0" aria-label="写入地址"></td><td class="file-state">未选择</td><td><button aria-label="删除固件行">移除</button></td>';
 rows.set(row,null);$('esp-files').append(row);row.querySelector('button').onclick=()=>{rows.delete(row);row.remove();$('esp-consent').checked=false;refresh();};
 row.querySelector('.address').oninput=()=>{$('esp-consent').checked=false;refresh();};
 row.querySelector('[type=file]').onchange=async e=>{fileReads++;rows.set(row,null);$('esp-consent').checked=false;refresh();try{const file=e.target.files[0];if(!file)throw Error('未选择');if(!/\.bin$/i.test(file.name)||file.size===0||file.size>64*1024*1024)throw Error('请选择有效的 BIN，最大 64 MiB');const bytes=new Uint8Array(await file.arrayBuffer());if(e.target.files[0]!==file)return;if(rows.has(row))rows.set(row,{name:file.name,bytes});row.querySelector('.file-state').textContent=(file.size/1024).toFixed(1)+' KiB';notice('esp-message','文件已读取。请核对地址，并勾选硬件适用确认。');}catch(error){row.querySelector('.file-state').textContent=error.message;}finally{fileReads--;refresh();}};
}
async function api(action,payload){const result=await native.official(action,payload);if(!result.ok){if(result.error.code==='official_session_expired')clearAccount();throw Object.assign(Error(result.error.message),{code:result.error.code});}return result.data;}
function clearAccount(){account={token:'',name:'',projects:[],selected:null,featuresReady:false};$('login-form').reset();$('project').replaceChildren();text('quota','');text('features','');renderAccount();}
async function defaultCall(action,payload){const result=await native.defaultAccount(action,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{code:result.error.code});return result.data;}
async function defaultStatus(){const config=await defaultCall('status');defaultUsername=config.username||'';preferredProjectId=config.projectId||null;text('default-account-name',config.configured?'默认账号 · '+config.username:'默认账号尚未配置');text('default-account-message',config.configured?'已保存在本机，启动时自动登录。':'请展开下方配置，登录并保存一次。');return config;}
async function loadFeatures(){
 account.featuresReady=false;const id=Number($('project').value);account.selected=account.projects.find(p=>p.project_id===id)||null;text('quota','');text('features','');
 if(!account.selected)throw Error('请选择本批次的授权项目');
 const result=await api('features',{token:account.token,project_id:id});account.featuresReady=true;
 text('features','授权功能：'+(result.features.map(f=>f.name||f.feature_id).join(' · ')||'项目无额外功能项'));
 const p=account.selected;text('quota',`总授权 ${p.authorized_count} · 已激活 ${p.activated_count} · 剩余 ${p.nonactivated_count}（最近查询）`);
}
async function projects(){
 const previous=account.selected?.project_id||(account.name===defaultUsername?preferredProjectId:null);account.selected=null;account.featuresReady=false;account.projects=[];$('project').replaceChildren();text('quota','');text('features','');
 const result=await api('projects',{token:account.token});account.projects=result.projects;
 const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='请选择授权项目';$('project').append(placeholder);
 for(const p of result.projects){const o=document.createElement('option');o.value=p.project_id;o.textContent=`${p.name} · ID ${p.project_id}`;$('project').append(o);}
 const selected=result.projects.find(p=>p.project_id===previous)||(result.projects.length===1?result.projects[0]:null);
 if(!result.projects.length)throw Error('此账号暂无授权项目，请核对官方配置');
 if(!selected)throw Error('查询到多个授权项目，请选择本批次项目');
 $('project').value=String(selected.project_id);await loadFeatures();
}
function loggedIn(result,name){account.token=result.token;account.name=name;text('account-name',name+' · 官方账号');$('manual-account').open=false;renderAccount();}
function authorizationNotice(){const reason=accountReason();notice('account-message',reason||($('activate').checked?'授权已就绪：ML307H 烧录完成后自动激活。':'账号已登录，本批次仅烧录固件。'),reason?'error':'success');}
async function useDefault(){
 if(accountBusy)return;accountBusy=true;clearAccount();refresh();notice('account-message','正在使用默认账号登录并查询官方授权…');
 try{const result=await defaultCall('login');loggedIn(result,result.username);await defaultStatus();await projects();accountBusy=false;authorizationNotice();}
 catch(e){notice('account-message',e.message,'error');}finally{accountBusy=false;ml?.refresh();refresh();}
}
async function initializeDefault(){
 accountBusy=true;refresh();
 try{const config=await defaultStatus();accountBusy=false;if(config.configured)await useDefault();else{notice('account-message','未配置默认账号；ML307H 自动激活需要先完成登录。','error');$('manual-account').open=true;}}
 catch(e){notice('account-message',e.message,'error');}finally{accountBusy=false;refresh();}
}
$('default-login').onclick=useDefault;
// Read form values before resetting any previous session.
$('login-form').onsubmit=async e=>{
 e.preventDefault();if(accountBusy)return;
 const credentials={username:$('username').value.trim(),password:$('password').value,pccode:$('pccode').value},remember=$('remember-account').checked;
 accountBusy=true;clearAccount();refresh();notice('account-message','正在登录并查询官方授权…');
 try{const result=await api('login',credentials);loggedIn(result,credentials.username);if(remember){await defaultCall('save',credentials);await defaultStatus();}await projects();accountBusy=false;authorizationNotice();}
 catch(error){notice('account-message',error.message,'error');}finally{credentials.password='';credentials.pccode='';$('password').value='';$('pccode').value='';accountBusy=false;ml?.refresh();refresh();}
};
$('logout').onclick=async()=>{if(accountBusy)return;const token=account.token;clearAccount();accountBusy=true;refresh();try{await api('logout',{token});notice('account-message','本次会话已退出；默认配置仍保留，下次启动会自动登录。');}catch(e){notice('account-message','本次会话已清除，官方注销未确认','error');}finally{accountBusy=false;ml?.refresh();refresh();}};
$('forget-account').onclick=async()=>{if(accountBusy)return;accountBusy=true;refresh();try{await defaultCall('clear');clearAccount();await defaultStatus();notice('account-message','本机默认账号已清除，请重新配置。');}catch(e){notice('account-message',e.message,'error');}finally{accountBusy=false;ml?.refresh();refresh();}};
$('refresh-projects').onclick=async()=>{if(accountBusy)return;accountBusy=true;refresh();try{await projects();accountBusy=false;authorizationNotice();}catch(e){notice('account-message',e.message,'error');}finally{accountBusy=false;ml?.refresh();refresh();}};
$('project').onchange=async()=>{if(accountBusy)return;accountBusy=true;refresh();try{await loadFeatures();if(account.name===defaultUsername){await defaultCall('select-project',{username:account.name,projectId:account.selected.project_id});preferredProjectId=account.selected.project_id;}accountBusy=false;authorizationNotice();}catch(e){notice('account-message',e.message,'error');}finally{accountBusy=false;ml?.refresh();refresh();}};
$('activate').onchange=()=>{authorizationNotice();ml?.refresh();refresh();};
$('add-file').onclick=addRow;$('esp-consent').onchange=refresh;
$('chip').onchange=async()=>{await esp.disconnect();$('esp-consent').checked=false;text('esp-identity','型号已改变，请重新连接');refresh();};
$('esp-connect').onclick=async()=>{espWorking=true;refresh();try{notice('esp-message','请选择 ESP32 串口，正在识别芯片…');await esp.connect($('chip').value,Number($('baud').value));text('esp-identity',`${esp.chip} · MAC ${esp.mac}`);notice('esp-message','芯片已识别。固件与地址确认后可开始。','success');}catch(e){notice('esp-message',e.message,'error');text('esp-identity','未连接');}finally{espWorking=false;refresh();}};
$('esp-disconnect').onclick=async()=>{await esp.disconnect();text('esp-identity','已释放连接');refresh();};
$('run').onclick=async()=>{if($('run').disabled)return;try{if(mode==='esp32'){await begin('esp32');await runEsp();}else{await begin(mode);ml.start();}}catch(e){await fail(mode==='esp32'?'esp32':'ml307h',e);}};
for(const button of $('modes').children)button.onclick=()=>{mode=button.dataset.mode;for(const b of $('modes').children)b.classList.toggle('selected',b===button);$('ml-section').hidden=mode==='esp32';$('esp-section').hidden=mode==='ml307h';$('single-columns').classList.toggle('single-chip',mode!=='dual');text('run',mode==='dual'?'开始双芯片烧录 ↗':`开始 ${mode==='ml307h'?'ML307H':'ESP32'} 烧录 ↗`);refresh();};
const labels={dual:'双芯片',ml307h:'ML307H',esp32:'ESP32',running:'运行中',completed:'完成',failed:'失败',interrupted:'中断',passed:'完成',pending:'等待',skipped:'未执行'};
async function showHistory(){try{const records=await native.history();$('records').replaceChildren();for(const r of records){const tr=document.createElement('tr');for(const value of [new Date(r.startedAt).toLocaleString()+'\n'+r.id.slice(0,8),r.serial||r.steps.find(s=>s.mac)?.mac||'—',labels[r.mode],(r.productionTest==='review'?'待复测':r.productionTest==='cancelled'?'产测已取消':labels[r.status]||r.status),r.steps.map(s=>`${s.id}: ${labels[s.status]||s.status}${s.activation&&s.activation!=='not-requested'?' · 激活 '+s.activation:''}${s.message?' · '+s.message:''}`).join(' / ')+' · '+(productionLabels[r.productionTest]||'未执行')+(r.production?.reason?' · '+r.production.reason:'')+(r.message?' · '+r.message:'')+(r.production?' · '+(r.production.cloudRegistered===true?'云端已登记':r.production.cloudRegistered===false?'云端未确认登记':'登记状态未提供'):'')]){const td=document.createElement('td');td.textContent=value;tr.append(td);}$('records').append(tr);}text('records-message',records.length?`显示最近 ${records.length} 条任务`:'暂无烧录记录');}catch(e){text('records-message',e.message);}}
async function showBatchHistory(){
 try{const result=await native.batchCsv('list');if(!result.ok)throw Error(result.error);$('batch-records').replaceChildren();
  for(const r of result.data){const tr=document.createElement('tr');for(const v of [new Date(r.createdAt).toLocaleString()+' · '+r.id,`${r.rows} 次 · 完成 ${r.passed} · 失败 ${r.failed} · 中断 ${r.interrupted}${r.active?' · 批次接收中':''}`,r.csvPath||'历史批次 · 可选择文件导出']){const td=document.createElement('td');td.textContent=v;tr.append(td);}const td=document.createElement('td'),button=document.createElement('button');button.textContent='导出 CSV';button.onclick=async()=>{button.disabled=true;try{const out=await native.batchCsv('export',{id:r.id});if(!out.ok)throw Error(out.error);text('batch-records-message',out.data?`已导出 ${out.data.rows} 条：${out.data.path}`:'已取消导出');}catch(e){text('batch-records-message',e.message);}finally{button.disabled=false;}};td.append(button);tr.append(td);$('batch-records').append(tr);}
  text('batch-records-message',result.data.length?`共 ${result.data.length} 个批次。数字设备标识按文本导出，避免表格软件改写。`:'暂无批次记录');
 }catch(e){text('batch-records-message',e.message);}
}
const espHome=document.createElement('div');espHome.hidden=true;$('esp-section').before(espHome);const accountHome=document.createElement('div');accountHome.hidden=true;$('account-panel').before(accountHome);
function navigate(page){
 for(const name of ['batch','flash','records','help'])$('page-'+name).hidden=name!==page;
 for(const x of document.querySelectorAll('[data-page]'))x.classList.toggle('active',x.dataset.page===page);
 text('page-title',({batch:'批量烧录',flash:'单板烧录',records:'生产记录',help:'说明与更新'})[page]);
 document.body.classList.toggle('batch-view',page==='batch');
 if(page==='batch'){$('batch-firmware').append($('esp-section'));$('batch-account').append($('account-panel'));$('esp-section').hidden=false;}
 if(page==='flash'){espHome.after($('esp-section'));accountHome.after($('account-panel'));$('esp-section').hidden=mode==='ml307h';}
 if(page==='records'){void showHistory();void showBatchHistory();}
}
for(const b of document.querySelectorAll('[data-page]'))b.onclick=()=>navigate(b.dataset.page);
$('export').onclick=async()=>{try{const r=await native.exportHistory();text('records-message',r.saved?'记录已导出':'已取消导出');}catch(e){text('records-message',e.message);}};
const chooser=$('device-dialog');native.onDevices(data=>{text('device-title',data.kind==='usb'?'选择 ML307H USB 设备':'选择串口设备');$('device-list').replaceChildren();$('device-empty').hidden=data.items.length>0;for(const item of data.items){const b=document.createElement('button');b.textContent=item.label;b.onclick=()=>{native.chooseDevice(item.id);chooser.close();};$('device-list').append(b);}if(!chooser.open)chooser.showModal();});
function cancelDevice(){native.chooseDevice('');chooser.close();}$('device-cancel').onclick=cancelDevice;chooser.oncancel=e=>{e.preventDefault();cancelDevice();};
try{
 const html=await(await fetch('./renderer/upstream/ml307h-flash.html')).text(),parsed=new DOMParser().parseFromString(html,'text/html'),main=parsed.querySelector('main');main.querySelector('.heading').remove();main.querySelector('#support').nextElementSibling.textContent='激活使用上方官方账号和项目。运行与下载 USB 接口分别选择。';
 mlRoot=$('ml-workbench').attachShadow({mode:'open'});const css=document.createElement('link');css.rel='stylesheet';css.href='./renderer/upstream/ml307h-flash.css';const style=document.createElement('style');style.textContent='main{max-width:none;margin:0;padding:0}.panel{box-shadow:none;border-color:#e4eaee;border-radius:10px;padding:16px}.configuration{gap:12px}.config-card h2{font-size:14px}.selection{font-size:13px}.hint{font-size:11px}button{font-size:12px}#history-panel{display:none}';mlRoot.append(css,style,main);
 if(native.platform==='win32')mlRoot.getElementById('at-transport').value='serial';
 ml=mountFlash(mlRoot,{requireConfirmation:true,guard:accountReason,onLock:locked=>{mlBusy=locked;},onRunStart:async()=>{if(!active())await begin('ml307h');else await save();},onError:error=>{latestMl=null;const s=ml?.snapshot()||{};void fail('ml307h',error,{firmware:s.firmware,digest:s.digest,uid:s.uid,backup:s.backup,activation:s.activation||'not-requested',verification:s.written?'protocol-ack':'unconfirmed'});},onComplete:result=>{latestMl=result;},onSettled:settle,
  prepareActivation:async()=>{if(!$('activate').checked)return null;const reason=accountReason();if(reason)throw Error(reason);const token=account.token,id=account.selected.project_id;return prepareActivation({api,token,project:account.selected,isCurrent:()=>account.token===token&&account.selected?.project_id===id,onStage:message=>notice('account-message',message)});}});
 addRow();
 batchUI=mountBatch({getConfig:()=>{if(fileReads||!$('esp-consent').checked)throw Error('请先核对固件');return {entries:espPlan(),chip:$('chip').value,baud:Number($('baud').value)};},canStart:()=>!updatesUI?.locked&&!active()&&!mlBusy&&!espWorking&&!esp.busy&&!saveError&&!(ml.snapshot().prepared&&!ml.snapshot().written),disconnect:async()=>{await esp.disconnect();await ml.releaseIdle();},refresh,activationReason:accountReason,activationFactory:async()=>{if(!$('activate').checked)return null;const reason=accountReason();if(reason)throw Error(reason);const token=account.token,id=account.selected.project_id;return prepareActivation({api,token,project:account.selected,isCurrent:()=>account.token===token&&account.selected?.project_id===id});}});
 if(native.updates)updatesUI=mountUpdates({native,document,openHelp:()=>navigate('help'),onState:()=>refresh()});
 navigate('batch');const info=await native.appInfo();text('platform',(native.platform==='win32'?'Windows':'macOS')+' · v'+info.version);text('app-version','v'+info.version);text('app-location',info.applicationPath);text('app-data-location',info.dataPath);refresh();setInterval(refresh,300);
 window.ringhiSmoke=async()=>{const {runSmoke}=await import('./smoke.mjs');return runSmoke({mlRoot,ml,esp,rows});};window.ringhiReady=true;window.ringhiAccountReady=initializeDefault();
}catch(error){notice('run-hint','初始化失败：'+error.message,'error');console.error(error);}
