const {_electron}=require('playwright'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
(async()=>{let app;try{
 app=await _electron.launch({args:[path.resolve(__dirname,'..'),'--test-session'],env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
 const page=await app.firstWindow();await page.waitForFunction(()=>window.ringhiReady);await page.evaluate(()=>window.ringhiAccountReady);
 assert.equal(await page.locator('#activate').isChecked(),true);
 await app.evaluate(({ipcMain})=>{
  globalThis.accountCalls=[];globalThis.failLogin=false;globalThis.failFeatures=false;
  ipcMain.removeHandler('default-account');ipcMain.handle('default-account',async(_e,action)=>{accountCalls.push(action);if(action==='status')return {ok:true,data:{configured:true,username:'simulation-account'}};if(action==='login')return failLogin?{ok:false,error:{message:'模拟登录失败'}}:{ok:true,data:{username:'simulation-account',token:'simulation-token'}};throw Error('Unexpected action');});
  ipcMain.removeHandler('official');ipcMain.handle('official',async(_e,action)=>{accountCalls.push(action);if(action==='projects')return {ok:true,data:{projects:[{project_id:1,name:'RingHi 测试项目',authorized_count:100,activated_count:10,nonactivated_count:90}]}};if(action==='features')return failFeatures?{ok:false,error:{message:'模拟授权查询失败'}}:{ok:true,data:{features:[{feature_id:'1',name:'测试功能'}]}};if(action==='logout')return {ok:true,data:{logged_out:true}};throw Error('Unexpected activation or credential request');});
 });
 await page.reload();await page.waitForFunction(()=>window.ringhiReady);await page.evaluate(()=>window.ringhiAccountReady);
 assert.match(await page.locator('#account-status').textContent(),/授权就绪/);assert.match(await page.locator('#quota').textContent(),/剩余 90/);
 assert.deepEqual(await app.evaluate(()=>accountCalls),['status','login','status','projects','features']);
 for(const width of [1000,1440]){
  await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,1000),width);
  const left=await page.locator('#batch-ml-column').boundingBox(),right=await page.locator('#batch-firmware').boundingBox();assert(Math.abs(left.y-right.y)<2);assert(left.x+left.width<right.x);assert(await page.locator('#account-status').isVisible());
 }
 const {packageFixture}=await import('../tests/ml307h-fixtures.mjs');await page.evaluate(()=>window.showDirectoryPicker=async()=>({name:'simulation-backups'}));
 await page.locator('#esp-files input[type=file]').setInputFiles({name:'test.bin',mimeType:'application/octet-stream',buffer:Buffer.from([1,2,3,4])});await page.locator('#esp-consent').check();
 await page.locator('#batch-ml-file').setInputFiles({name:'test.pkg',mimeType:'application/octet-stream',buffer:Buffer.from(packageFixture())});await page.locator('#batch-backup').click();await page.locator('#batch-ml-consent').check();await page.waitForFunction(()=>!document.getElementById('batch-start').disabled);
 const out=path.resolve(__dirname,'../../test-evidence/account-0.3.2');await fs.mkdir(out,{recursive:true});await page.locator('#batch-config').screenshot({path:path.join(out,'side-by-side.png')});
 await app.evaluate(()=>globalThis.failFeatures=true);await page.locator('#refresh-projects').click();await page.waitForFunction(()=>document.getElementById('account-message').textContent.includes('模拟授权查询失败'));assert(await page.locator('#batch-start').isDisabled());assert.match(await page.locator('#account-status').textContent(),/授权未就绪/);
 await page.locator('#logout').click();await page.waitForFunction(()=>!document.getElementById('account-fields').disabled);await app.evaluate(()=>globalThis.failLogin=true);await page.locator('#default-login').click();await page.waitForFunction(()=>document.getElementById('account-message').textContent.includes('模拟登录失败'));assert(await page.locator('#batch-start').isDisabled());assert(await page.locator('#activate').isChecked());
 await page.locator('#batch-mode').selectOption('esp32');await page.waitForFunction(()=>!document.getElementById('batch-start').disabled);assert(!await page.locator('#batch-ml-column').isVisible());
 await page.locator('#batch-mode').selectOption('dual');assert(await page.locator('#batch-start').isDisabled());await page.locator('[data-page=flash]').click();
 const left=await page.locator('#ml-section').boundingBox(),right=await page.locator('#esp-section').boundingBox();assert(Math.abs(left.y-right.y)<2);assert(left.x+left.width<right.x);
 const report={passed:true,checks:['automatic default login','project quota and features visible','activation default enabled','firmware ready plus authorization enables start','failed feature query blocks ML','failed login blocks ML without disabling activation','ESP-only remains available','batch and single chip columns side by side','1000px and 1440px layouts'],officialRequests:'mocked; no license requests'};
 await fs.writeFile(path.join(out,'ui.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{if(app)app.process().kill('SIGKILL');}})().catch(e=>{console.error(e);process.exitCode=1;});
