const {app,BrowserWindow,ipcMain,dialog,Menu,powerSaveBlocker,safeStorage,shell,net}=require('electron');
const path=require('node:path'),fs=require('node:fs/promises'),http=require('node:http');
const {perform}=require('./spark.cjs');
const {DefaultAccount}=require('./default-account.cjs');
const {BackupFiles}=require('./backup-files.cjs');
const {cleanProduction}=require('./production-record.cjs');
const {BatchCsv}=require('./batch-csv.cjs');
const {ShutdownCoordinator,saveInterruptedJobs}=require('./shutdown.cjs');
const {randomUUID}=require('node:crypto');
const {UpdateService}=require('./updates.cjs');
const {launchInstall}=require('./install-update.cjs');
let updater,pendingUpdate=null,updateTimer,updateInterval;
const updateBusy=()=>busy||Boolean(batchCsv?.active.size)||Boolean(nativeService?.leases.size);
let shutdown,exitSnapshot;const sessionJobs=new Set(),backupOperations=new Set();
let batchCsv;
let defaultAccount;
const batchPolicy=require('./batch-policy.cjs');let batchFilters=[];
const smoke=process.argv.includes('--smoke-test');
if(smoke||process.argv.includes('--test-session'))app.setPath('userData',path.join(app.getPath('temp'),'ringhi-smoke-'+process.pid));
let win,server,origin,busy=false,choice=null;const grants=new Set();
let nativeService,wakeBlocker;
const ROOT=path.resolve(__dirname,'..');
const trusted=event=>Boolean(win&&!win.isDestroyed()&&!win.webContents.isDestroyed()&&event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&event.senderFrame?.url?.startsWith(origin+'/'));
function sameOrigin(value){try{return new URL(value).origin===origin;}catch{return false;}}
function check(event){if(!trusted(event))throw Error('拒绝非应用窗口请求');if(shutdown?.blocked||updater?.state.phase==='installing')throw Error('软件正在关闭，设备任务已停止');}
function deviceKey(type,d){return `${type}:${d.deviceId||d.portId||d.serialNumber||''}:${d.vendorId||''}:${d.productId||''}`;}
function publish(){if(choice)win.webContents.send('devices',{kind:choice.kind,items:choice.items.map(d=>({id:d.deviceId||d.portId,label:choice.kind==='usb'?`${d.productName||'ML307H USB'} · ${Number(d.vendorId).toString(16)}:${Number(d.productId).toString(16)} · ${d.serialNumber||'无序列号'}`:`${d.portName||d.displayName||'串口'} · ${d.displayName||''}`}))});}
function select(kind,list,callback){if(choice)choice.callback('');choice={kind,items:list,callback};publish();}
function cleanRecord(input){
 if(!input||input.schema!==1||! /^[0-9a-f-]{36}$/.test(input.id)||!['dual','ml307h','esp32'].includes(input.mode)||!['running','completed','failed','skipped'].includes(input.status)||!Array.isArray(input.steps)||input.steps.length>20)throw Error('任务记录无效');
 const pick=(src,keys)=>Object.fromEntries(keys.filter(k=>typeof src[k]==='string').map(k=>[k,src[k].slice(0,1000)]));
 const out={schema:1,...pick(input,['id','serial','mode','startedAt','finishedAt','status','productionTest','batchId','hub','message'])};
 if(input.production)out.production=cleanProduction(input.production);
 out.steps=input.steps.map(s=>({...pick(s,['id','status','startedAt','finishedAt','message','firmware','digest','uid','backup','activation','chip','verification','reset','mac','port','imei']),...(Number.isSafeInteger(s.checksumRetries)&&s.checksumRetries>=0?{checksumRetries:s.checksumRetries}:{})}));return out;
}
const jobDir=()=>path.join(app.getPath('userData'),'jobs');
let journal=Promise.resolve();
async function history(){await journal;await fs.mkdir(jobDir(),{recursive:true});const names=(await fs.readdir(jobDir())).filter(n=>n.endsWith('.json'));const rows=[];for(const name of names){try{const row=JSON.parse(await fs.readFile(path.join(jobDir(),name),'utf8'));if(row.status==='running'&&(row.batchId?!batchCsv?.active.has(row.batchId):!busy)){row.status='interrupted';if(['starting','running'].includes(row.productionTest)){row.productionTest='interrupted';row.production={...row.production,state:'interrupted',reason:'应用异常退出，产测未完成'};}}rows.push(row);}catch{}}return rows.sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,200);}
async function serve(){server=http.createServer(async(req,res)=>{
 try{
  if(req.headers.host!==new URL(origin).host||!['GET','HEAD'].includes(req.method)){res.writeHead(403).end();return;}
  const url=new URL(req.url,origin),rel=decodeURIComponent(url.pathname==='/'?'/renderer/index.html':url.pathname);
  const file=path.resolve(ROOT,'.'+rel);
  if(!(file.startsWith(path.join(ROOT,'renderer')+path.sep)||file.startsWith(path.join(ROOT,'core')+path.sep))){res.writeHead(403).end();return;}
  const type={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'}[path.extname(file)]||'application/octet-stream';
  const data=await fs.readFile(file);res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"});res.end(req.method==='HEAD'?undefined:data);
 }catch{res.writeHead(404).end('Not found');}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;}
if(!app.requestSingleInstanceLock()&&!smoke)app.quit();else app.whenReady().then(async()=>{
 if(process.platform==='win32')app.setAppUserModelId('com.aispea.ringhi.flasher');
 await serve();
 batchCsv=new BatchCsv(path.join(app.getPath('userData'),'batches'),jobDir());
 await batchCsv.recover();
 Menu.setApplicationMenu(process.platform==='darwin'?Menu.buildFromTemplate([
  {label:'RingHi Flasher',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{role:'quit'}]},
  {role:'editMenu'},{role:'windowMenu'}
 ]):null);
 app.setAboutPanelOptions({applicationName:'RingHi Flasher',applicationVersion:app.getVersion(),copyright:'AiSpea',credits:'更新：退出工具后运行新版 RingHi 安装包，覆盖原应用并保留生产记录。'});
 win=new BrowserWindow({width:1440,height:1000,minWidth:1000,minHeight:720,show:!smoke,title:'RingHi Flasher',icon:path.join(ROOT,'renderer/assets',process.platform==='win32'?'ringhi.ico':'ringhi.png'),backgroundColor:'#f4f6f8',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,partition:'ringhi-session'}});
 const ses=win.webContents.session;
 ses.setPermissionCheckHandler((wc,permission,requestOrigin)=>{return wc===win.webContents&&sameOrigin(requestOrigin)&&['serial','usb','fileSystem','file-system','wakeLock','screen-wake-lock'].includes(permission);});
 ses.setPermissionRequestHandler((wc,permission,callback,details)=>callback(wc===win.webContents&&(details.requestingUrl||wc.getURL()).startsWith(origin+'/')&&['serial','usb','fileSystem','file-system','wakeLock','screen-wake-lock'].includes(permission)));
 ses.setDevicePermissionHandler(details=>sameOrigin(details.origin)&&(grants.has(deviceKey(details.deviceType,details.device))||batchPolicy.permits(batchFilters,details.deviceType,details.device)));
 ses.on('select-usb-device',(event,details,callback)=>{event.preventDefault();if(details.frame===win.webContents.mainFrame)select('usb',details.deviceList.filter(d=>d.vendorId===0x3563&&[0x1000,0x2000].includes(d.productId)),callback);else callback('');});
 ses.on('select-serial-port',(event,list,wc,callback)=>{event.preventDefault();if(wc===win.webContents)select('serial',list,callback);else callback('');});
 for(const [event,kind,add] of [['usb-device-added','usb',true],['usb-device-removed','usb',false],['serial-port-added','serial',true],['serial-port-removed','serial',false]])ses.on(event,(_e,d)=>{
  if(choice?.kind!==kind)return;
  if(kind==='usb'&&(d.vendorId!==0x3563||![0x1000,0x2000].includes(d.productId)))return;
  const id=d.deviceId||d.portId;choice.items=choice.items.filter(x=>(x.deviceId||x.portId)!==id);if(add)choice.items.push(d);publish();
 });
 ipcMain.on('choose-device',(event,id)=>{check(event);if(!choice)return;const selected=choice.items.find(d=>(d.deviceId||d.portId)===id);const pending=choice;choice=null;if(selected)grants.add(deviceKey(pending.kind,selected));pending.callback(selected?id:'');});
 ipcMain.handle('native-batch',async(event,action,payload)=>{check(event);try{if(['arm','claim'].includes(action)&&updater?.state.phase==='downloading')throw Error('更新下载中，请稍后开启烧录批次');if(!nativeService){const {NativeService}=require('./native/service.cjs');nativeService=new NativeService();}return {ok:true,data:await nativeService.call(action,payload)};}catch(e){return {ok:false,error:e.message};}});
 ipcMain.handle('batch-access',(event,filters)=>{check(event);batchFilters=filters===null?[]:batchPolicy.filters(filters);return {enabled:batchFilters.length>0};});
 ipcMain.on('busy',(event,value)=>{check(event);busy=Boolean(value);if(busy&&wakeBlocker===undefined)wakeBlocker=powerSaveBlocker.start('prevent-app-suspension');if(!busy&&wakeBlocker!==undefined){powerSaveBlocker.stop(wakeBlocker);wakeBlocker=undefined;}});
 const backupFiles=new BackupFiles(path.join(app.getPath('userData'),'backup-directory.json'),path.join(smoke||process.argv.includes('--test-session')?app.getPath('userData'):app.getPath('documents'),'RingHi Backups'));
 ipcMain.handle('backup-files',async(event,action,payload={})=>{
  check(event);try{
   if(['select','default'].includes(action)&&busy)throw Error('烧录期间不能切换备份目录');
   if(action==='default')return {ok:true,data:await backupFiles.defaultRoot()};
   if(action==='select'){const selected=await dialog.showOpenDialog(win,{title:'选择 ML307H 备份目录',properties:['openDirectory','createDirectory']});return {ok:true,data:selected.canceled?null:await backupFiles.grant(selected.filePaths[0],{remember:payload.remember===true})};}
   const operation=backupFiles.call(action,payload);backupOperations.add(operation);try{return {ok:true,data:await operation};}finally{backupOperations.delete(operation);}
  }catch(e){return {ok:false,error:{name:e.name,code:e.code,message:e.message}};}
 });
 defaultAccount=new DefaultAccount(app.getPath('userData'),safeStorage);
 ipcMain.handle('default-account',async(event,action,payload)=>{
  check(event);try{
   if(action==='status')return {ok:true,data:await defaultAccount.status()};
   if(busy)throw Error('烧录期间不能切换或修改授权账号');
   if(action==='save')return {ok:true,data:await defaultAccount.save(payload)};
   if(action==='select-project')return {ok:true,data:await defaultAccount.selectProject(payload)};
   if(action==='clear')return {ok:true,data:await defaultAccount.clear()};
   if(action==='login'){const credentials=await defaultAccount.read();if(!credentials)throw Error('尚未配置默认账号，请先登录并保存为本机默认账号');const result=await perform('login',credentials);return {ok:true,data:{...result,username:credentials.username}};}
   throw Error('不支持的默认账号操作');
  }catch(e){return {ok:false,error:{code:e.code||'default_account_error',message:e.message}};}
 });
 ipcMain.handle('official',async(event,action,payload)=>{check(event);try{return {ok:true,data:await perform(action,payload)};}catch(e){return {ok:false,error:{code:e.code||'request_failed',message:e.message}};}});
 ipcMain.handle('save-job',async(event,input)=>{check(event);const data=cleanRecord(input);sessionJobs.add(data.id);const write=journal.then(async()=>{await fs.mkdir(jobDir(),{recursive:true});const file=path.join(jobDir(),data.id+'.json'),tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(data,null,2));await fs.rename(tmp,file);let csv;try{csv=await batchCsv.update(data);}catch(e){csv={saved:false,error:'CSV 更新失败：'+e.message+'；本机任务记录已保留'};}return {saved:true,csv};});journal=write.catch(()=>{});return write;});
 ipcMain.handle('batch-csv',async(event,action,payload={})=>{check(event);try{
  await journal;
  if(action==='list')return {ok:true,data:await batchCsv.list()};
  if(action==='end')return {ok:true,data:await batchCsv.end(payload.id)};
  if(action==='prepare'){
   const date=new Date(),local=new Intl.DateTimeFormat('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date).replace(/[^0-9]/g,'');
   const chosen=await dialog.showSaveDialog(win,{title:'选择本批次 CSV 保存文件',defaultPath:path.join(app.getPath('documents'),'RingHi-'+local+'.csv'),filters:[{name:'批次 CSV',extensions:['csv']}],properties:['showOverwriteConfirmation','createDirectory']});
   return {ok:true,data:chosen.canceled||shutdown?.blocked?null:await batchCsv.create(chosen.filePath,payload.mode)};
  }
  if(action==='export'){
   batchCsv.id(payload.id);const m=await batchCsv.meta(payload.id);
   const chosen=await dialog.showSaveDialog(win,{title:'导出本批次 CSV',defaultPath:m?.csvPath||path.join(app.getPath('documents'),'RingHi-'+payload.id.slice(0,8)+'.csv'),filters:[{name:'批次 CSV',extensions:['csv']}],properties:['showOverwriteConfirmation','createDirectory']});
   return {ok:true,data:chosen.canceled?null:await batchCsv.export(payload.id,chosen.filePath)};
  }
  throw Error('无效批次记录操作');
 }catch(e){return {ok:false,error:e.message};}});
 updater=new UpdateService({directory:path.join(app.getPath('userData'),'updates'),currentVersion:app.getVersion(),enabled:app.isPackaged&&!smoke&&!process.argv.includes('--test-session'),isBusy:updateBusy,fetchImpl:(...args)=>net.fetch(...args),onChange:state=>{if(win&&!win.isDestroyed())win.webContents.send('update-state',state);}});
 ipcMain.handle('app-update',async(event,action)=>{check(event);try{
  if(action==='status')return {ok:true,data:updater.snapshot()};
  if(action==='check')return {ok:true,data:await updater.check()};
  if(action==='download')return {ok:true,data:await updater.download()};
  if(action==='install'){
   if(!app.isPackaged)throw Error('开发模式不安装更新');
   const prepared=await updater.prepareInstall();
   if(process.platform==='win32'&&!process.env.PORTABLE_EXECUTABLE_FILE)throw Error('请运行便携版 EXE 后覆盖更新');
   pendingUpdate=prepared;updater.publish({phase:'installing',message:'正在保存记录并退出，随后启动更新…'});await shutdown.request();return {ok:true};
  }throw Error('无效更新操作');
 }catch(e){return {ok:false,error:e.message};}});
 ipcMain.handle('app-info',event=>{check(event);return {version:app.getVersion(),packaged:app.isPackaged,applicationPath:app.isPackaged&&process.platform==='darwin'?path.resolve(process.execPath,'../../..'):process.env.PORTABLE_EXECUTABLE_FILE||app.getAppPath(),dataPath:app.getPath('userData')};});
 ipcMain.handle('history',event=>{check(event);return history();});
 ipcMain.handle('export-history',async event=>{check(event);const rows=await history();const chosen=await dialog.showSaveDialog(win,{defaultPath:'RingHi-records.json',filters:[{name:'JSON',extensions:['json']}]});if(chosen.canceled)return {canceled:true};await fs.writeFile(chosen.filePath,JSON.stringify({schema:1,exportedAt:new Date().toISOString(),records:rows},null,2));return {saved:true};});
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
 ipcMain.on('exit-snapshot',(event,payload)=>{
  if(!trusted(event)||!exitSnapshot||payload?.id!==exitSnapshot.id)return;
  try{if(!Array.isArray(payload.records)||payload.records.length>10000)throw Error('退出记录过多');exitSnapshot.resolve(payload.records.map(cleanRecord));}catch{exitSnapshot.resolve([]);}
 });
 shutdown=new ShutdownCoordinator({
  isBusy:()=>busy||batchCsv.active.size>0||Boolean(nativeService?.leases.size),
  confirm:async()=>{const result=await dialog.showMessageBox(win,{type:'warning',title:'关闭 RingHi',message:'当前仍有烧录、产测任务或正在接收设备的批次。',detail:'停止并关闭会中断未完成任务，自动保存任务结果和批次 CSV。中断的设备可能需要重新烧录；已发出的授权或云端请求结果可能仍需核对。',buttons:['取消','停止并关闭'],defaultId:0,cancelId:0,noLink:true});return result.response===1;},
  block:()=>{batchFilters=[];if(choice){const pending=choice;choice=null;pending.callback('');}},
  stopDevices:()=>nativeService?.dispose(),
  snapshot:()=>new Promise(resolve=>{
   if(!win||win.isDestroyed()||win.webContents.isDestroyed())return resolve([]);
   const id=randomUUID(),timer=setTimeout(()=>{exitSnapshot=null;resolve([]);},1500);
   exitSnapshot={id,resolve:records=>{clearTimeout(timer);exitSnapshot=null;resolve(records);}};
   win.webContents.send('prepare-exit',id);
  }),
  stopRenderer:()=>{if(win&&!win.isDestroyed())win.destroy();},
  save:async records=>{
   await journal;await Promise.allSettled([...backupOperations]);await batchCsv.queue;
   // Retry journal writes before quitting; never silently discard an interrupted job.
   while(true){try{await saveInterruptedJobs({jobs:jobDir(),ids:sessionJobs,records});break;}catch(e){
    const answer=await dialog.showMessageBox({type:'error',title:'退出记录尚未保存',message:'设备任务已停止，但本机任务记录保存失败。',detail:e.message+'\n可另存恢复记录；直接退出只保留之前已保存的进度。',buttons:['重试保存','另存恢复记录','仅保留已有记录并退出'],defaultId:0,cancelId:0,noLink:true});
    if(answer.response===2)break;
    if(answer.response===1){const chosen=await dialog.showSaveDialog({title:'另存退出恢复记录',defaultPath:path.join(app.getPath('documents'),'RingHi-exit-recovery.json'),filters:[{name:'JSON',extensions:['json']}],properties:['showOverwriteConfirmation','createDirectory']});
     if(!chosen.canceled)try{const {atomicWrite}=require('./batch-csv.cjs');await atomicWrite(chosen.filePath,JSON.stringify({schema:1,reason:'用户关闭软件，任务结果需核对',records},null,2));break;}catch(error){await dialog.showMessageBox({type:'error',message:'恢复记录另存失败',detail:error.message,buttons:['返回重试']});}
    }
   }}
   for(const id of [...batchCsv.active]){
    while(true){let result;try{result=await batchCsv.end(id);}catch(e){result={saved:false,error:e.message};}
     if(!result||result.saved)break;
     const choice=await dialog.showMessageBox({type:'warning',title:'CSV 尚未保存',message:'设备任务已停止，但批次 CSV 保存失败。',detail:(result.error||'')+'\n本机任务记录已保留。请重试，或另存 CSV 后退出。',buttons:['重试保存','另存 CSV','仅保留本机记录并退出'],defaultId:0,cancelId:0,noLink:true});
     if(choice.response===2)break;
     if(choice.response===1){const chosen=await dialog.showSaveDialog({title:'另存退出时的批次 CSV',defaultPath:path.join(app.getPath('documents'),'RingHi-'+id.slice(0,8)+'-interrupted.csv'),filters:[{name:'CSV',extensions:['csv']}],properties:['showOverwriteConfirmation','createDirectory']});
      if(!chosen.canceled)try{const saved=await batchCsv.export(id,chosen.filePath);const meta=await batchCsv.meta(id);meta.csvPath=saved.path;meta.lastError='';await batchCsv.store(meta);break;}catch(e){await dialog.showMessageBox({type:'error',message:'CSV 另存失败',detail:e.message,buttons:['返回重试']});}
     }
    }
   }
   await journal;await batchCsv.queue;
  },
  quit:async()=>{clearTimeout(updateTimer);clearInterval(updateInterval);if(pendingUpdate){try{await launchInstall({update:pendingUpdate,directory:path.join(app.getPath('userData'),'updates'),openPath:file=>shell.openPath(file)});}catch(e){await dialog.showMessageBox({type:'error',title:'更新未能启动',message:'记录已保存，但更新安装未能启动。',detail:e.message+'\n原工具保留，请重新打开后重试。',buttons:['关闭']});}}if(wakeBlocker!==undefined){powerSaveBlocker.stop(wakeBlocker);wakeBlocker=undefined;}server?.close();app.exit(0);}
 });
 win.on('close',event=>{if(!smoke){event.preventDefault();void shutdown.request();}});
 win.webContents.on('will-prevent-unload',event=>{if(!busy)event.preventDefault();});
 const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});win.webContents.on('render-process-gone',()=>{if(shutdown?.blocked)return;busy=false;batchFilters=[];if(wakeBlocker!==undefined){powerSaveBlocker.stop(wakeBlocker);wakeBlocker=undefined;}void nativeService?.dispose();nativeService=null;});
 await win.loadURL(origin+'/');
 if(app.isPackaged&&!smoke&&!process.argv.includes('--test-session')){updateTimer=setTimeout(()=>{void updater.check();},5000);updateInterval=setInterval(()=>{void updater.check();},6*60*60*1000);}
 if(smoke){
  const out=process.env.RINGHI_SMOKE_DIR||path.join(ROOT,'.smoke');await fs.mkdir(out,{recursive:true});let result;
  try{result=await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const start=Date.now();const timer=setInterval(()=>{if(window.ringhiReady){clearInterval(timer);resolve(window.ringhiSmoke());}else if(Date.now()-start>20000){clearInterval(timer);reject(Error('UI 初始化超时'));}},100);})`);await fs.writeFile(path.join(out,'screenshot.png'),(await win.webContents.capturePage()).toPNG());result={...result,platform:process.platform,electron:process.versions.electron,errors};}catch(e){result={passed:false,error:e.message,errors};}
  await fs.writeFile(path.join(out,'smoke.json'),JSON.stringify(result,null,2));app.exit(result.passed&&errors.length===0?0:1);
 }
});
app.on('second-instance',()=>{win?.show();win?.focus();});
app.on('window-all-closed',()=>{if(shutdown?.blocked)return;server?.close();app.quit();});

// Cmd+Q and native menu quits must honor the same flash-session guard as window close.
app.on('before-quit',event=>{if(shutdown&&!shutdown.finished&&!smoke){event.preventDefault();void shutdown.request();}});
