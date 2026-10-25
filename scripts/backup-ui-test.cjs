const {_electron}=require('playwright'),assert=require('node:assert/strict'),path=require('node:path');
(async()=>{let app;try{
 app=await _electron.launch({args:[path.resolve(__dirname,'..'),'--test-session'],env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
 const p=await app.firstWindow();await p.waitForFunction(()=>window.ringhiReady);await p.evaluate(()=>window.ringhiBackupReady);
 const first=await p.locator('#batch-backup-label').textContent();assert.match(first,/已验证可写/);
 await app.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});});
 await p.locator('#batch-backup').click();assert.equal(await p.locator('#batch-backup-label').textContent(),first);
 const chosen=path.join(await app.evaluate(({app})=>app.getPath('userData')),'selected-backup');await require('node:fs/promises').mkdir(chosen);await app.evaluate(({dialog},chosen)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[chosen]});},chosen);
 await p.locator('#batch-backup').click();await p.waitForFunction(()=>document.getElementById('batch-backup-label').textContent.includes('selected-backup'));
 const saved=await p.evaluate(async()=>{const {defaultBackupDirectory}=await import('/renderer/backup.mjs');const root=await defaultBackupDirectory(),dir=await root.getDirectoryHandle('IMEI-test',{create:true}),f=await dir.getFileHandle('calibration.bin',{create:true}),w=await f.createWritable();await w.write(Uint8Array.of(0,1,128,255));await w.close();return [...new Uint8Array(await (await f.getFile()).arrayBuffer())];});assert.deepEqual(saved,[0,1,128,255]);
 await p.reload();await p.waitForFunction(()=>window.ringhiReady);await p.evaluate(()=>window.ringhiBackupReady);assert((await p.locator('#batch-backup-label').textContent()).includes(chosen));
 console.log(JSON.stringify({passed:true,checks:['native default write check','cancel retains selection','native selection updates label','persistent directory after reload','renderer IPC bytes roundtrip']}));
 }finally{if(app)await app.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
