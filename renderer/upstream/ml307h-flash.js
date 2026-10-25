import {parsePackage,MAX_PACKAGE,matchPackageProfile,packageMatchesDevice,flashChecks,validDeviceIdentity} from './ml307h/package.mjs';
import {acquireDeviceLease,UsbTransport,SerialTransport,atCommand,parseIdentity,versionMatches} from './ml307h/transport.mjs';
import {Downloader,BackupStore,burn} from './ml307h/download.mjs';
export function mountFlash(root=document,hooks={}){
const $=id=>root.getElementById(id),s={pkg:null,identity:null,at:null,usb:null,base:null,root:null,store:null,release:null,busy:false,prepared:false,written:false,mutated:false,records:[],verified:false,directoryStatus:null,error:null,firmwareName:'',runtimePort:null,waitingDownload:false,startedAt:0,finishedAt:0,history:[]};
const requireConfirmation=hooks.requireConfirmation!==false;
$('consent').closest('.confirmation').hidden=!requireConfirmation;
function confirmationReady(){return !requireConfirmation||$('consent').checked;}
let activationRun=null;
let nextAction='package';
let downloadWait=null;
function selectedChecks(){return {board:$('check-board').checked,reread:$('check-reread').checked,usbSerial:$('check-usb').checked};}
function quick(){return $('flash-mode').value==='quick';}
function describeIdentity(i){return i.identification==='download-uid'?'设备已连接 · 将使用下载 UID 关联备份':`已识别 ${i.version} · IMEI 尾号 ${i.imei.slice(-4)}`;}
function applySavedChecks(i){const c=flashChecks(i);$('flash-mode').value=i.mode==='quick'?'quick':'checked';$('check-board').checked=c.board;$('check-reread').checked=c.reread;$('check-usb').checked=c.usbSerial;}

function target(){return s.pkg?.compatibility?.profile;}
function compatible(){return packageMatchesDevice(s.pkg,s.identity);}
function refreshCompatibility(){if(s.pkg){s.pkg.compatibility=matchPackageProfile(s.pkg,null,{checkBoard:selectedChecks().board});$('compatibility').textContent=s.pkg.compatibility.supported&&!selectedChecks().board?`${s.pkg.project} · 格式与分区检查通过。板型核对已关闭，请自行确认固件适用于当前硬件。`:s.pkg.compatibility.reason;$('compatibility').dataset.supported=String(s.pkg.compatibility.supported);}}
function log(message){s.records.push(`${new Date().toLocaleTimeString()} ${message}`);if(s.records.length>1500)s.records.shift();$('console').textContent=s.records.join('\n');$('console').scrollTop=$('console').scrollHeight;}
function message(text,kind=''){ $('message').textContent=text;$('message').className='notice '+kind;}
const supported=isSecureContext&&!!navigator.usb&&!!navigator.locks&&!!window.showDirectoryPicker;
$('support').textContent=supported?'桌面 USB 与本地备份已就绪。Windows 下载接口需可由 WinUSB 访问。':'完整烧录需要 HTTPS、桌面 Chrome、WebUSB 与文件夹访问支持；仍可离线检查固件。';
function liveAT(){return !!(s.at&&!s.at.closed&&!s.at.failed&&!s.at.queue.error);}
function pendingSession(){return s.directoryStatus&&!['empty','rejected','verified','archived-unverified'].includes(s.directoryStatus.status);}
function directoryReady(){return !!s.base&&!!s.directoryStatus&&!pendingSession();}
async function scanDirectory(){
  if(!s.root){s.directoryStatus={status:'empty'};$('backup').textContent=s.base?`备份总目录已授权：${s.base.name||'所选文件夹'}。每次烧录自动创建独立文件夹，旧记录不会覆盖。`:'尚未选择备份总目录。';return;}
  s.directoryStatus=null;
  try{s.directoryStatus=await new BackupStore(s.root).inspect();}
  catch(e){s.directoryStatus={status:'invalid',reason:e.message};throw e;}
  const status=s.directoryStatus.status;
  $('backup').textContent=`本次备份文件夹：${s.root.name||'所选文件夹'}。`+(status==='awaiting-verification'?'上次已写入、尚未核对。可重新烧录，也可选择核对结果。':pendingSession()?'发现上次中断的升级，请按上方提示继续原会话。':'目录检查通过，备份将在下载模式下自动完成。');
}
function connectionMessage(e){return e.code==='DEVICE_BUSY'?e.message:['NotReadableError','NetworkError','InvalidStateError'].includes(e.name)||/claim.*interface|access denied|busy/i.test(e.message)?'接口无法独占访问，可能被其他程序占用或已断开。请关闭日志、串口助手等程序，重新插拔后重试。':e.message;}
async function dropAT(){const at=s.at;s.at=null;s.identity=null;$('identity').textContent='未连接，请重新连接并识别设备';await at?.close();if(!s.mutated){s.release?.();s.release=null;}}
function snapshot(){return {ready:!$('prepare').disabled,busy:s.busy,prepared:s.prepared,written:s.written,firmware:s.firmwareName,digest:s.pkg?.digest||'',uid:s.store?.state?.uid||s.identity?.imei||'',backup:s.root?.name||'',activation:s.store?.state?.activation?.status||'not-requested'};}
function update(){
  hooks.onLock?.(s.busy||(s.prepared&&!s.written));
  const activationReason=hooks.guard?.()||'';
  const ready=!!(supported&&compatible()&&(s.prepared||directoryReady())&&confirmationReady()&&!activationReason);

  $('prepare').disabled=s.busy||!ready||!liveAT()||s.prepared;
  $('flash').disabled=(s.busy&&!s.waitingDownload)||!ready||!s.prepared||s.written;
  $('verify').disabled=s.busy||!s.written||s.verified||!s.identity?.imei;
  $('verify').hidden=!selectedChecks().board&&!selectedChecks().reread;
  $('verify-hint').textContent=$('verify').hidden?'完成后连接已自动释放，可直接更换固件或打开日志工具。':'可选核对启动后的设备身份与固件版本，不影响下一次新烧录。';
  $('mode-hint').textContent=quick()?'快捷下载：按下方顺序操作，可选检查按需开启。':'核对下载：读取运行身份，自动核对板型及 IMEI。';
  for(const id of ['package','connect-at','directory','recovery-directory','recovery','consent','at-transport','flash-mode','check-board','check-reread','check-usb'])$(id).disabled=s.busy||(s.prepared&&!s.written&&id!=='at-transport');
  $('connect-at').disabled ||= !supported;
  $('directory').disabled ||= !supported;$('recovery-directory').disabled ||= !supported;
  $('check-previous').hidden=s.prepared||s.directoryStatus?.status!=='awaiting-verification';$('check-previous').disabled=!s.directoryStatus?.record?.identity?.imei||s.busy||!s.pkg?.compatibility?.supported||s.directoryStatus?.record?.digest!==s.pkg?.digest;
  $('reflash').hidden=!s.written;$('reflash').disabled=s.busy;
  $('flash').hidden=!s.prepared||s.written||(s.busy&&!s.waitingDownload);
  $('prepare').hidden=s.prepared&&!s.written;
  $('folder-name').textContent=s.base?.name||'未选择';
  $('file-name').textContent=s.firmwareName||'未选择固件';
  $('task-device').textContent=s.store?.state?.uid||s.identity?.uid||s.identity?.imei||(s.prepared?'等待下载 UID':liveAT()?'运行模式已连接':'未连接');
  $('task-firmware').textContent=s.firmwareName||'—';
  $('release').disabled=s.busy;$('report').disabled=s.busy;
  let title,hint,label;
  if(!supported){title='请使用支持烧录的浏览器';hint='需要 HTTPS 下的桌面 Chrome / Edge、USB 和文件夹访问能力。仍可离线检查固件。';label='浏览器不支持烧录';nextAction=null;}
  else if(s.waitingDownload){title='连接下载设备';hint='正在尝试自动连接；设备已出现时，可立即点击右侧按钮手动选择，无需等待。';label='正在连接…';nextAction=null;}
  else if(s.busy){title='正在执行，请稍候';hint='请完成浏览器弹窗中的选择或授权；操作进行中请保持 USB 连接。具体进度见下方操作日志。';label='正在处理…';nextAction=null;}
  else if(s.verified){title='烧录完成，设备核对通过';hint='可直接更换固件，或再次下载当前固件。备份总目录继续保留。';label='准备下一次下载';nextAction='reflash';}
  else if(s.written){title='本次写入完成';hint='现在可以更换固件继续烧录，无需刷新；备份总目录已保留。也可打开日志工具检查启动。';label='准备下一次下载';nextAction='reflash';}
  else if(s.prepared){title='请选择下载设备';hint='点击“手动选择下载设备”，选择下载模式 ML307H；连接后自动备份并写入，请保持 USB 连接。';label='手动选择下载设备';nextAction='flash';}
  else if(!s.pkg){title='第 1 步：选择固件';hint='选择固件开发者提供的 .pkg 文件，先检查项目、板型与分区。';label='选择 .pkg 固件';nextAction='package';}
  else if(!s.pkg.compatibility.supported){title='固件检查未通过';hint=s.pkg.compatibility.reason;label='重新选择固件';nextAction='package';}
  else if(pendingSession()){
    const d=s.directoryStatus;
    if(d.status==='invalid'){title='备份记录需要检查';hint=d.reason+'。请保留原文件，重新选择原备份目录。';label='重新选择会话文件夹';nextAction='recovery-directory';}
    else if(d.status==='awaiting-verification'){title='上次已写入，可以重新烧录';hint='版本核对是可选操作。点击重新烧录，工具将保留原记录，在所选总目录内为新烧录创建独立文件夹。';label='重新烧录';nextAction='reflash';}
    else if(d.record.digest!==s.pkg.digest){title='请先选择上次使用的固件';hint='此目录有待处理的升级。请选择原 .pkg，SHA-256：'+d.record.digest;label='选择原 .pkg 固件';nextAction='package';}
    else{title='上次升级中断，请继续原会话';hint='工具会自动读取此目录中的原记录和备份。请保留原固件，让原设备回到 ROM 下载模式后继续。';label='继续上次升级';nextAction='resolve-session';}
  }
  else if(quick()&&!s.base){title='第 2 步：选择备份总目录';hint='选择一次总目录，每次下载自动新建独立备份文件夹。';label='选择备份总目录';nextAction='directory';}
  else if(!liveAT()||!s.identity){title=quick()?'第 3 步：连接运行中的设备':'第 2 步：连接运行中的设备';hint='先停止日志工具，再选择设备。'+(selectedChecks().board?'将核对设备板型。':'硬件适用性由你确认。');label='连接设备';nextAction='connect-at';}
  else if(!compatible()){title='设备板型与固件不匹配';hint='固件要求 '+target().board+'，设备版本：'+s.identity.version+'。请选择正确固件或连接正确设备。';label='重新选择固件';nextAction='package';}
  else if(!s.base){title='第 3 步：选择备份总目录';hint='选择电脑上的 ML307H 备份总目录。每次烧录自动新建带时间、板型和设备信息的文件夹，无需手动新建。';label='选择备份总目录';nextAction='directory';}
  else if(activationReason){title='请先完成授权配置';hint=activationReason;label='等待授权配置';nextAction=null;}
  else if(!confirmationReady()){title='第 4 步：确认目标与分区计划';hint='确认固件与这块硬件一致，勾选下方确认项。分区明细可展开查看。';label='前往确认';nextAction='consent';}
  else{title='准备就绪，可以开始烧录';hint='点击后自动切换模式、重连已授权设备、备份并写入。首次使用下载模式时，只需按提示授权一次。';label='开始下载';nextAction='prepare';}
  if(s.error&&!s.busy){title='操作已停止，请处理后重试';hint=s.error;if(nextAction==='prepare')label='重试：进入下载模式';}
  $('guide-title').textContent=title;$('next-hint').textContent=hint;$('next-action').textContent=label;$('next-action').disabled=!nextAction;$('next-action').hidden=['prepare','flash','reflash'].includes(nextAction);
  if(nextAction==='reflash')$('reflash').hidden=false;
  if(!s.busy&&nextAction!=='prepare')$('prepare').hidden=true;
  $('prepare-reason').textContent=s.verified?'烧录和重启核对均已完成。':s.written?'固件写入完成，连接已释放，可换包继续。':s.prepared?'已进入下载流程，请按上方“下一步”继续。':ready&&!s.error?'准备条件已完成。':hint;
  const items=[['固件检查',!!s.pkg],['设备连接',compatible()],['备份目录',directoryReady()||s.prepared],...(requireConfirmation?[['操作确认',$('consent').checked]]:[]),['写入完成',s.written]];
  if(!quick()&&s.identity?.imei)items.push(['重启核对（可选）',s.verified]);
  $('checklist').replaceChildren(...items.map(([label,done])=>{const li=document.createElement('li');li.dataset.done=String(done);li.textContent=(done?'已完成 · ':'待完成 · ')+label;return li;}));
}
async function action(fn){if(s.busy)return;s.busy=true;s.error=null;update();try{await fn();}catch(e){const msg=e.selectionCanceled?(s.prepared?'未选择下载设备。请保持连接，按“下一步”重新选择后继续。':'已取消选择，尚未开始烧录；按“下一步”可重试。'):connectionMessage(e);s.waitingDownload=false;s.error=msg;message(msg,'error');log(msg);const activation=s.store?.state?.activation;$('state').textContent=activation&&activation.status!=='complete'?'固件完成 · 激活待核对':s.written?'写入完成 · 重启待确认':s.mutated?'已暂停 · 保留连接继续':'操作未完成';if(s.written)finishRun(activation&&activation.status!=='complete'?'固件完成 · 激活待核对':'写入完成 · 重启待确认');if(!s.prepared){activationRun?.dispose();activationRun=null;}hooks.onError?.(e);}finally{s.busy=false;update();hooks.onSettled?.(snapshot());}}
function download(name,data,type){const url=URL.createObjectURL(new Blob([data],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function lease(){if(!s.release)s.release=await acquireDeviceLease();}
async function choose(fn){try{return await fn();}catch(e){if(['NotFoundError','AbortError'].includes(e.name))e.selectionCanceled=true;throw e;}}
async function openAT(){
  // Refuse a competing Toolbox session before touching its device.
  await lease();
  if($('at-transport').value==='usb'){
    if(!navigator.usb)throw Error('浏览器不支持 WebUSB');
    const devices=(await navigator.usb.getDevices()).filter(d=>d.vendorId===0x3563&&d.productId===0x2000);
    if(devices.length>1)throw Error('检测到多个已授权运行设备，请只连接目标设备');
    const d=devices[0]||await choose(()=>navigator.usb.requestDevice({filters:[{vendorId:0x3563,productId:0x2000}]}));
    const at=await UsbTransport.open(d,{pid:0x2000,interfaceNumber:4});return at;
  }
  if(!navigator.serial)throw Error('浏览器不支持 Web Serial，可尝试 USB AT 接口');
  const ports=await navigator.serial.getPorts?.()||[];
  const p=ports.includes(s.runtimePort)?s.runtimePort:await choose(()=>navigator.serial.requestPort({filters:[{usbVendorId:0x3563,usbProductId:0x2000}]}));
  const at=await SerialTransport.open(p);s.runtimePort=p;return at;
}
async function identity(at){return {...parseIdentity(await atCommand(at,'AT+CGMR'),await atCommand(at,'AT+CGSN=1'),null),usbSerial:at.device?.serialNumber||''};}
async function connectionIdentity(at){
  const checks=selectedChecks();
  if(checks.board||checks.reread)return {...await identity(at),mode:$('flash-mode').value,flashChecks:checks};
  await atCommand(at,'AT');
  return {identification:'download-uid',version:'',imei:'',usbSerial:at.device?.serialNumber||'',mode:$('flash-mode').value,flashChecks:checks};
}
for(const id of ['flash-mode','check-board','check-reread','check-usb'])$(id).addEventListener('change',()=>{
  if(id==='flash-mode'){const checked=!quick();for(const key of ['check-board','check-reread','check-usb'])$(key).checked=checked;}
  $('consent').checked=false;
  void action(async()=>{if(s.written)await resetRound();await dropAT();refreshCompatibility();message('下载选项已更新，请重新连接设备并确认硬件。');});
});
$('package').addEventListener('change',()=>action(async()=>{
  if(s.prepared&&!s.written)throw Error('当前下载尚未完成，请使用原固件继续或恢复');
  if(s.written)await resetRound();
  s.pkg=null;s.verified=false;s.firmwareName='';$('consent').checked=false;$('version').textContent='—';$('digest').textContent='—';$('package-status').textContent='尚未通过固件检查';$('compatibility').textContent='等待有效固件';$('partitions').replaceChildren();const f=$('package').files[0];if(!f)return;if(f.size>MAX_PACKAGE)throw Error('固件超过 64 MiB');message('正在检查固件…');const p=await parsePackage(await f.arrayBuffer(),{inspectOnly:true});s.pkg=p;s.firmwareName=f.name;refreshCompatibility();
  $('version').textContent=p.version||'未填写';$('digest').textContent=p.digest;$('package-status').textContent=`${p.project} · ${(p.byteLength/1048576).toFixed(2)} MiB · ${p.auth===0?'未提供包校验，仅验证结构':p.auth===1?'MD5 已校验':'CRC16 已校验'}`;
  const rows=p.entries.filter(e=>e.type==='CODE').map(e=>{const tr=document.createElement('tr');for(const t of [e.name,`${e.size.toLocaleString()} B`,e.selected?'写入':e.backup===2?'擦除':p.protectedEntries.includes(e)?'备份并保留':'保留']){const td=document.createElement('td');td.textContent=t;tr.append(td);}return tr;});$('partitions').replaceChildren(...rows);message('固件检查通过。请连接设备并选择备份文件夹。');log('固件检查通过：'+p.version);
}));
$('connect-at').addEventListener('click',()=>action(async()=>{
  if(s.written)await resetRound();
  if(s.at)await s.at.close();s.at=null;s.identity=null;
  try{s.at=await openAT();s.identity=await connectionIdentity(s.at);$('identity').textContent=describeIdentity(s.identity);$('state').textContent='设备已识别';message('设备已识别。准备烧录前请核对分区清单。');log(s.identity.identification==='download-uid'?'端口通信正常；跳过版本与 IMEI 读取，备份将绑定下载 UID':'已读取运行身份；板型检查：'+(flashChecks(s.identity).board?'开启':'关闭'));if(!compatible()&&target())message('已连接，但设备版本与目标板型不匹配。请按上方提示处理。','error');}
  catch(e){await dropAT();throw e;}
}));
$('directory').addEventListener('click',()=>action(async()=>{
  if(s.written)await resetRound();
  s.base=await choose(()=>window.showDirectoryPicker({mode:'readwrite',id:'ml307h-backup'}));s.root=null;s.store=null;
  await scanDirectory();message('总目录已选择。开始烧录时将自动新建本次备份文件夹，旧记录不影响新烧录。');log('已选择备份总目录：'+(s.base.name||'所选文件夹'));
}));
$('recovery-directory').addEventListener('click',()=>action(async()=>{
  if(s.written)await resetRound();
  const root=await choose(()=>window.showDirectoryPicker({mode:'readwrite',id:'ml307h-recovery'}));s.base=null;s.root=root;s.store=null;
  await scanDirectory();
  if(s.directoryStatus.status==='empty'){const reason='此目录没有会话记录。请选择某次烧录的文件夹（内含 preparation.json），不要选择总目录或 UID 子目录';s.directoryStatus={status:'invalid',reason};throw Error(reason);}
  message('已读取所选会话，请按上方提示恢复或核对。');log('已打开历史备份会话：'+(root.name||'所选文件夹'));
}));
$('consent').addEventListener('change',update);
$('prepare').addEventListener('click',()=>action(async()=>{
  if(!s.pkg||!liveAT()||!s.base||!compatible()||!confirmationReady())throw Error('准备条件未满足');
  const reason=hooks.guard?.();if(reason)throw Error(reason);
  if(pendingSession())throw Error('当前打开的是历史会话，请恢复原会话，或选择备份总目录开始新烧录');
  if(!quick()&&!confirm(`即将更新 ${target().board||s.pkg.project}。进入下载模式后请继续完成整包写入，不要拔线。确认只连接这一台目标设备？`))return;
  // Version replies can contain echo, whitespace and unsolicited text. Never
  // compare entire CGMR responses as proof that the physical device changed.
  if(flashChecks(s.identity).reread){
    try{
      const current={...await identity(s.at),mode:s.identity.mode,flashChecks:flashChecks(s.identity)};
      if(current.imei!==s.identity.imei)throw Error('设备 IMEI 与连接时不同，请重新连接目标设备');
      if(!packageMatchesDevice(s.pkg,current))throw Error('设备版本未包含目标板型，请核对固件或关闭可选板型检查');
      s.identity=current;
    }catch(e){await dropAT();throw e;}
  }
  await hooks.onRunStart?.(snapshot());
  activationRun?.dispose();activationRun=await hooks.prepareActivation?.()||null;
  const created=await BackupStore.createSession(s.base,s.pkg,s.identity,{firmwareName:s.firmwareName});s.store=created.store;s.root=created.store.root;s.identity=created.identity;
  $('backup').textContent=`本次备份文件夹：${s.base.name||'备份总目录'}/${created.name}。备份与记录均保存在此文件夹。`;
  log('已创建本次独立备份文件夹：'+created.name+'；已保存设备/固件信息与准备记录');
  s.startedAt=Date.now();s.finishedAt=0;$('progress').value=0;$('progress-text').textContent='准备下载';
  s.mutated=true;s.prepared=true;message('下载正在进行：自动切换模式、连接下载设备、备份并写入。完成前请保持页面与 USB 连接。');$('state').textContent='正在进入下载模式';log('发送固件工具使用的 AT^AUTODL 入口');
  try{
    let reply;
    try{reply=await atCommand(s.at,'AT^AUTODL',{timeout:10000,disconnectOK:true});}
    catch(e){if(e.commandRejected){await s.store.rejectPreparation(s.identity);s.prepared=false;s.mutated=false;await scanDirectory();log('下载命令被明确拒绝；设备仍在运行模式，可稍后重新识别并准备');}throw e;}
    if(reply.split(/[\r\n]+/).some(line=>line.trim()==='OK')){
      log('下载入口已应答，等待模式切换');const deadline=Date.now()+8000;let downloadSeen=false;
      while(liveAT()&&Date.now()<deadline){
        downloadSeen=(await navigator.usb.getDevices()).some(d=>d.vendorId===0x3563&&d.productId===0x1000);
        if(downloadSeen)break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      let stillRuntime=false;if(!downloadSeen)try{await atCommand(s.at,'AT',{timeout:1500});stillRuntime=true;}catch{}
      if(stillRuntime){log('设备仍响应 AT，请求系统复位以进入 ROM');await atCommand(s.at,'AT^RESET=normal',{timeout:3000,disconnectOK:true});}
    }
  }finally{await s.at.close();s.at=null;}
  await reconnectDownload();
}));
// Automatic reconnection uses only existing permission. A chooser is invoked
// only by an explicit click, preserving browser user activation.
async function reconnectDownload(){
  const wait={selection:null,wake:null};downloadWait=wait;
  const manual=new Promise(resolve=>wait.wake=resolve);
  let timer,timedOut=false;const expired=new Promise(resolve=>timer=setTimeout(()=>{timedOut=true;resolve();},2000));
  s.waitingDownload=true;update();$('state').textContent='自动连接下载设备';
  $('phase').textContent='自动连接中 · 也可立即手动选择';
  message('正在连接已授权的下载设备。设备已出现时，可立即点击“手动选择下载设备”。');
  let device;
  try{
    while(!device){
      if(wait.selection){
        const result=await wait.selection;if(result.error)throw result.error;
        device=result.device;break;
      }
      if(timedOut)break;
      // Manual takeover and the deadline also interrupt a slow getDevices().
      // Late enumeration results never open a device or start a second burn.
      const found=await Promise.race([navigator.usb.getDevices(),manual,expired]);
      if(wait.selection)continue;
      if(!found)break;
      const devices=found.filter(d=>d.vendorId===0x3563&&d.productId===0x1000);
      if(devices.length>1)throw Error('检测到多个已授权下载设备，请只连接目标设备后继续');
      if(devices.length===1){device=devices[0];log('已找到已授权下载设备，自动连接并继续烧录');break;}
      let poll;try{await Promise.race([new Promise(resolve=>poll=setTimeout(resolve,250)),manual,expired]);}finally{clearTimeout(poll);}
    }
  }finally{clearTimeout(timer);downloadWait=null;s.waitingDownload=false;update();}
  if(device){await flashDevice(device);return;}
  $('state').textContent='等待下载设备授权';
  $('phase').textContent='请选择下载模式 ML307H，连接后自动继续';
  message('未自动连接，请点击“手动选择下载设备”。选择后自动备份并写入。');
}
$('flash').addEventListener('click',()=>{
  if(s.waitingDownload&&downloadWait){
    const wait=downloadWait;s.waitingDownload=false;
    // Invoke the chooser directly in the click, before any await. Keep the
    // original action as the sole owner of device opening and flashing.
    wait.selection=choose(()=>navigator.usb.requestDevice({filters:[{vendorId:0x3563,productId:0x1000}]})).then(device=>({device}),error=>({error}));
    wait.wake();update();$('state').textContent='请选择下载设备';
    $('phase').textContent='等待浏览器中的设备选择';log('已切换为手动选择下载设备');
    return;
  }
  void action(async()=>{
    if(!s.prepared||s.written)throw Error('当前没有等待继续的下载');
    await lease();
    const d=await choose(()=>navigator.usb.requestDevice({filters:[{vendorId:0x3563,productId:0x1000}]}));
    await flashDevice(d);
  });
});
async function flashDevice(d){
  if(!s.prepared||s.written||!s.pkg||!compatible()||!s.root)throw Error('缺少烧录准备信息');
  const reason=hooks.guard?.();if(reason)throw Error(reason);
  await hooks.onRunStart?.(snapshot());
  if(!activationRun)activationRun=await hooks.prepareActivation?.()||null;
  await lease();if(!s.startedAt){s.startedAt=Date.now();s.finishedAt=0;}
  if(flashChecks(s.identity).usbSerial&&s.identity.usbSerial&&d.serialNumber!==s.identity.usbSerial)throw Error('下载设备 USB 序列号与运行设备不同，拒绝继续');
  if(flashChecks(s.identity).usbSerial&&!s.identity.usbSerial&&!confirm('串口未提供跨模式 USB 序列号，网页无法自动证明是同一块板。请确认电脑只连接原来的这一台测试板，再继续。'))return;
  const connected=(await navigator.usb.getDevices()).filter(d=>d.vendorId===0x3563);if(connected.filter(d=>d.productId===0x1000).length!==1||connected.some(d=>d.productId===0x2000))throw Error('检测到多个已授权 ML307H，请只连接目标设备');
  const wake=await navigator.wakeLock?.request('screen').catch(()=>null);
  try{
    s.usb=await UsbTransport.open(d);s.store=new BackupStore(s.root);$('state').textContent='烧录中';message('正在备份并写入，请保持当前页面和 USB 连接。');
    const dl=new Downloader(s.usb,{log,progress:(name,done,total)=>{$('task-device').textContent=s.store?.state?.uid||s.identity?.uid||'等待下载 UID';const stage=name.startsWith('备份 ')?'自动备份设备数据':s.pkg.loaders.some(e=>e.name===name)?'准备下载程序':s.pkg.protectedEntries.some(e=>e.name===name)?'恢复设备专属数据':'自动写入固件';$('guide-title').textContent=stage;$('next-hint').textContent=`${name} · ${Math.round(done/total*100)}%，请保持 USB 连接，备份和写入会自动继续。`;$('phase').textContent=stage+' · '+name;$('progress').value=done/total*100;$('progress-text').textContent=`${name} · ${Math.round(done/total*100)}%`;}});
    await burn(dl,s.pkg,s.store,s.identity,{activate:activationRun?.run});s.written=true;s.mutated=false;const activated=s.store.state.activation?.status==='complete';finishRun(activated?'下载完成 · 功能激活完成':'下载完成');$('progress').value=100;$('progress-text').textContent='全部写入完成';$('phase').textContent='备份已保存 · 已请求重启';$('state').textContent=activated?'下载完成 · 功能激活完成':quick()?'下载完成 · 已请求重启':'写入完成 · 待验证';message(activated?'固件下载完成，功能激活完成，已请求设备重启。':'下载完成，备份已保存。可以直接更换固件继续下载，或打开日志工具查看启动。','success');
    hooks.onComplete?.({activated,...snapshot()});
  }finally{if(s.store?.state?.phase==='awaiting-verification'){s.written=true;s.mutated=false;}await s.usb?.close();s.usb=null;await wake?.release();if(s.written){activationRun?.dispose();activationRun=null;s.release?.();s.release=null;$('identity').textContent='本次下载连接已释放，可连接设备进行下一次下载。';}}
}
async function verifyResult(at,store,expected){
  const found=await identity(at);
  if(!expected.imei)throw Error('本次未读取运行身份，请使用日志工具检查启动结果');
  found.flashChecks=flashChecks(expected);
  if(found.imei!==expected.imei||!packageMatchesDevice(s.pkg,found))throw Error('重启后的设备身份或板型不匹配');
  if(!versionMatches(found.version,s.pkg.version))throw Error(`版本无法匹配：设备报告“${found.version}”，固件包版本“${s.pkg.version}”。本次仅进行了核对，没有重新烧录；如需重写，请点击“重新烧录”。`);
  store.state.phase='verified';store.state.verifiedAt=new Date().toISOString();await store.saveState();
  log('设备重启后身份与版本验证通过');return found;
}
$('verify').addEventListener('click',()=>action(async()=>{
  let at;try{at=liveAT()?s.at:await openAT();await verifyResult(at,s.store,s.identity);s.mutated=false;s.verified=true;await scanDirectory();$('state').textContent='设备已启动 · 验证通过';message('设备已返回运行模式，项目、版本和 IMEI 核对通过。','success');}
  finally{await at?.close();s.at=null;if(!s.mutated){s.release?.();s.release=null;}}
}));
async function resolveSession(){
  const previous=s.directoryStatus;
  if(!pendingSession()||!previous.record||previous.record.digest!==s.pkg?.digest||!s.pkg.compatibility.supported)throw Error('请先选择原固件和原备份目录');
  if(previous.status==='awaiting-verification'){
    try{
      // Request a device from the click before hashing backups. Reuse a live AT connection.
      if(!liveAT())s.at=await openAT();
      await scanDirectory();
      if(s.directoryStatus.status!=='awaiting-verification')throw Error('原目录状态发生变化，请按新的提示处理');
      const store=new BackupStore(s.root),expected=await store.recover(previous.record,s.pkg);
      const found=await verifyResult(s.at,store,expected);s.identity=found;s.store=null;
      await scanDirectory();$('identity').textContent=`已识别 ${found.version} · IMEI 尾号 ${found.imei.slice(-4)}`;
      $('state').textContent='上次验证通过 · 可开始新一轮';message('上次烧录已核对完成，原备份已保留。此目录可以继续用于新一轮烧录。','success');
    }catch(e){await dropAT();throw e;}
  }else{
    await lease();
    try{
      await scanDirectory();const store=new BackupStore(s.root),found=await store.recover(previous.record,s.pkg);
      await s.at?.close();s.at=null;s.store=store;s.identity=found;applySavedChecks(found);s.prepared=true;s.mutated=true;s.written=store.state?.phase==='awaiting-verification';$('consent').checked=true;
      $('identity').textContent='恢复会话 · '+describeIdentity(found);$('state').textContent='已读取原会话';message('已读取并核对原备份，请按“下一步”继续。');
    }catch(e){if(!s.at){s.release?.();s.release=null;}throw e;}
  }
}
$('check-previous').addEventListener('click',()=>action(resolveSession));
async function resetRound(){
  if(s.prepared&&!s.written)throw Error('尚未完整写入的会话需使用原备份恢复');
  activationRun?.dispose();activationRun=null;
  await s.at?.close();s.at=null;s.identity=null;s.release?.();s.release=null;
  s.root=null;s.store=null;s.prepared=false;s.written=false;s.verified=false;s.mutated=false;s.startedAt=0;s.finishedAt=0;
  refreshCompatibility();$('consent').checked=false;$('identity').textContent='等待连接运行设备';
  $('progress').value=0;$('progress-text').textContent='等待开始';$('phase').textContent='选择固件并连接设备后开始下载';
  await scanDirectory();$('state').textContent='准备下一次烧录';
}
$('reflash').addEventListener('click',()=>action(async()=>{
  if(!s.written&&!['awaiting-verification','verified','archived-unverified'].includes(s.directoryStatus?.status))throw Error('尚未完整写入的会话需使用原备份恢复');
  await resetRound();message((s.base?'备份总目录已保留。':'请选择备份总目录。')+'可更换固件或继续使用当前固件，连接设备后开始下一次下载。');log('准备新一轮烧录，保留原会话文件');
}));
function finishRun(result){
  if(s.finishedAt)return;s.finishedAt=Date.now();
  const record={firmware:s.firmwareName,folder:s.root?.name||'—',result,elapsed:Math.round((s.finishedAt-s.startedAt)/1000)};
  s.history.unshift(record);s.history.length=Math.min(s.history.length,20);
  $('history').replaceChildren(...s.history.map(r=>{const tr=document.createElement('tr');for(const t of [r.firmware,r.result,r.elapsed+' 秒',r.folder]){const td=document.createElement('td');td.textContent=t;tr.append(td);}return tr;}));
  $('history-panel').hidden=false;
}
$('recovery').addEventListener('change',()=>action(async()=>{
  const f=$('recovery').files[0];if(!f||f.size>65536)throw Error('会话记录过大/未选择');if(!s.pkg||!s.root)throw Error('先选择原固件与备份目录');const r=JSON.parse(await f.text());
  if(r.schema!==1||!r.preparationId||r.digest!==s.pkg.digest||!r.identity||!validDeviceIdentity(r.identity)||!s.pkg.compatibility.supported||!packageMatchesDevice(s.pkg,r.identity))throw Error('恢复记录与固件/目标不匹配');
  await lease();const recoveredStore=new BackupStore(s.root);let recoveredIdentity;try{recoveredIdentity=await recoveredStore.recover(r,s.pkg);}catch(e){if(!s.at){s.release?.();s.release=null;}throw e;}await s.at?.close();s.at=null;s.store=recoveredStore;s.identity=recoveredIdentity;applySavedChecks(recoveredIdentity);s.verified=false;s.written=s.store.state?.phase==='awaiting-verification';s.prepared=true;s.mutated=true;$('identity').textContent='恢复会话 · '+describeIdentity(s.identity);$('state').textContent=s.written?'写入完成 · 待验证':'等待 ROM 下载设备';$('consent').checked=true;message(s.written?'已读取完整写入记录，请先连接运行设备验证。':'已核对原备份目录。请让原设备回到 ROM，再选择下载设备继续；备份阶段不会擦除数据。');
}));
$('report').addEventListener('click',()=>download('ml307h-operation.txt',s.records.join('\n'),'text/plain'));
$('release').addEventListener('click',()=>action(async()=>{
  if(s.mutated&&!confirm('设备可能尚未恢复正常启动。结束网页会话不会修复设备；请保留原固件及备份用于恢复。仍要结束？'))return;
  activationRun?.dispose();activationRun=null;
  await s.at?.close();await s.usb?.close();s.at=null;s.usb=null;s.identity=null;s.prepared=false;s.written=false;s.verified=false;s.mutated=false;s.release?.();s.release=null;$('state').textContent='会话已结束';$('identity').textContent='未连接';if(s.base){s.root=null;s.store=null;}if(s.root||s.base)await scanDirectory();message('连接已释放。已保存到本机的备份继续保留。');
}));
$('next-action').addEventListener('click',()=>{
  if(!nextAction||s.busy)return;
  if(nextAction==='resolve-session'){void action(resolveSession);return;}
  if(nextAction==='consent'){$('consent').scrollIntoView({block:'center'});$('consent').focus();return;}
  $(nextAction).click();
});
setInterval(()=>{
  $('elapsed').textContent=s.startedAt?Math.round(((s.finishedAt||Date.now())-s.startedAt)/1000)+' 秒':'—';
  if(s.busy||s.prepared||!s.at||liveAT())return;
  void action(async()=>{await dropAT();throw Error('设备连接已断开或失效，已停止后续操作。请关闭其他串口工具，再重新连接。');});
},250);
window.addEventListener('beforeunload',e=>{if(s.busy||s.mutated){e.preventDefault();e.returnValue='';}});
update();
return {releaseIdle:async()=>{if(s.busy||s.mutated)throw Error('单板 ML307H 仍有未结束的任务');await dropAT();update();},refresh:update, snapshot:()=>snapshot(), start:()=>{if($('prepare').disabled)throw Error('ML307H 准备条件尚未满足');$('prepare').click();}};
}
