// Launches the packaged application in an isolated user-data directory; never opens hardware.
const {_electron}=require('playwright');
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
const {spawnSync}=require('node:child_process');
(async()=>{
 const version=require('../package.json').version;const executable=process.argv[2];if(!executable)throw Error('Packaged executable required');
 const guard=path.resolve(__dirname,'../build/pkg-scripts/preinstall');
 const out=path.resolve(__dirname,'../../test-evidence/install-'+version);await fs.mkdir(out,{recursive:true});
 let app;
 try{
  app=await _electron.launch({executablePath:executable,args:['--test-session'],env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
  const page=await app.firstWindow();await page.waitForFunction(()=>window.ringhiReady);
  const info=await page.evaluate(()=>window.ringhi.appInfo());assert.equal(info.version,version);assert.equal(info.packaged,true);assert.match(info.applicationPath,/RingHi Flasher\.app$/);
  await page.locator('[data-page=help]').click();assert.match(await page.locator('#app-version').textContent(),new RegExp(version.replaceAll('.', '\\.')));
  assert.equal(await page.locator('#app-location').textContent(),info.applicationPath);
  const blocked=spawnSync(guard,[],{encoding:'utf8'});assert.equal(blocked.status,1);assert.match(blocked.stderr,/RingHi Flasher is running/);
  const quitGuard=await app.evaluate(({app,ipcMain,BrowserWindow,dialog})=>{
   const w=BrowserWindow.getAllWindows()[0];let prevented=false,prompts=0;const original=dialog.showMessageBox;
   dialog.showMessageBox=async()=>{prompts++;return {response:0};};
   const event={sender:w.webContents,senderFrame:w.webContents.mainFrame};
   ipcMain.emit('busy',event,true);app.emit('before-quit',{preventDefault(){prevented=true;}});
   ipcMain.emit('busy',event,false);dialog.showMessageBox=original;
   return {prevented,prompts};
  });assert.deepEqual(quitGuard,{prevented:true,prompts:1});
  const smoke=await page.evaluate(()=>window.ringhiSmoke());assert.equal(smoke.passed,true);
  await page.screenshot({path:path.join(out,'version-and-updates.png')});
  await app.close();app=null;
  const allowed=spawnSync(guard,[],{encoding:'utf8'});assert.equal(allowed.status,0,allowed.stderr);
  const report={passed:true,info,installerWhileRunning:'refused',installerAfterQuit:'allowed',quitDuringFlashing:'blocked',smoke};
  await fs.writeFile(path.join(out,'lifecycle.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }finally{if(app)await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
