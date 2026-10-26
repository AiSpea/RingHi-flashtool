// Real Electron shutdown regression, isolated user data and no hardware IO.
const {_electron}=require('playwright'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises'),{randomUUID}=require('node:crypto');
(async()=>{const results=[];for(const busy of [false,true]){let app;try{
 app=await _electron.launch({args:[path.resolve(__dirname,'..'),'--test-session'],env:Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase()!=='ELECTRON_RUN_AS_NODE')),timeout:30000});
 const child=app.process(),stderr=[];child.stderr.on('data',d=>stderr.push(String(d)));const exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));const page=await app.firstWindow();
 const data=await app.evaluate(({app,dialog})=>{const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path');const data=app.getPath('userData');global.closeResponses=[];dialog.showMessageBox=async()=>({response:global.closeResponses.shift()??0});dialog.showSaveDialog=async()=>({canceled:false,filePath:path.join(data,'shutdown.csv')});dialog.showErrorBox=(title,content)=>fs.appendFileSync(path.join(data,'unexpected-error.txt'),title+'\n'+content);return data;});
 await page.addInitScript(()=>{window.ringhi.onPrepareExit(()=>{window.ringhi.chooseDevice('late-selection');window.ringhi.setBusy(false);return [];});});
 await page.reload();await page.waitForFunction(()=>window.ringhiReady);
 let id;
 if(busy){id=randomUUID();await page.evaluate(async id=>{const r=await window.ringhi.batchCsv('prepare',{mode:'dual'});if(!r.ok)throw Error(JSON.stringify(r));await window.ringhi.saveJob({schema:1,id,batchId:r.data.id,mode:'dual',serial:'02:00:00:00:00:01',status:'running',startedAt:new Date().toISOString(),steps:[{id:'esp32',status:'running'},{id:'ml307h',status:'passed'}]});window.ringhi.setBusy(true);},id);
 await app.evaluate(({BrowserWindow})=>{global.closeResponses.push(0);BrowserWindow.getAllWindows()[0].close();});await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>Boolean(window.ringhiReady)),true);assert.equal(JSON.parse(await fs.readFile(path.join(data,'jobs',id+'.json'))).status,'running');
 }
 await app.evaluate(({BrowserWindow})=>{global.closeResponses.push(1);setTimeout(()=>BrowserWindow.getAllWindows()[0].close(),10);});
 const result=await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('Shutdown timeout')),15000).unref())]);assert.equal(result.code,0);assert.equal(result.signal,null);await assert.rejects(fs.access(path.join(data,'unexpected-error.txt')));assert(!stderr.join('').includes('Uncaught Exception'));
 if(busy){const record=JSON.parse(await fs.readFile(path.join(data,'jobs',id+'.json')));assert.equal(record.status,'interrupted');assert.equal(record.steps[1].status,'passed');const csv=await fs.readFile(path.join(data,'shutdown.csv'),'utf8');assert(csv.includes('已中断'));assert(csv.includes('02:00:00:00:00:01'));}
 results.push({busy,cancelPreserved:busy,lateNotificationsIgnored:true,exitCode:result.code,csvSaved:busy});app=null;
 }finally{if(app)await app.close();}}
 const out=process.env.RINGHI_SHUTDOWN_REPORT;if(out)await fs.writeFile(out,JSON.stringify({platform:process.platform,results},null,2));console.log(JSON.stringify({platform:process.platform,results},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
