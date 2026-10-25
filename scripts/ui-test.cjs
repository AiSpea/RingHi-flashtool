const {_electron}=require('playwright');const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
const mock=require('../tests/ui-hardware-mock.cjs');
(async()=>{const {packageFixture}=await import('../tests/ml307h-fixtures.mjs');let app;
 try{
 app=await _electron.launch({args:[path.resolve(__dirname,'..'),'--test-session'],env:{...process.env,ELECTRON_RUN_AS_NODE:''},timeout:30000});
 app.process().stderr.on('data',d=>process.stderr.write(d));const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.waitForFunction(()=>window.ringhiReady);await page.locator('[data-page=flash]').click();await page.evaluate(()=>window.ringhiAccountReady);await page.locator('#activate').uncheck();
 await page.locator('#esp-connect').click();await page.locator('#device-dialog').waitFor({state:'visible'});await page.locator('#device-cancel').click();
 await page.waitForFunction(()=>!document.getElementById('esp-connect').disabled);
 await page.evaluate(()=>{window.usbSelection=navigator.usb.requestDevice({filters:[{vendorId:0x3563,productId:0x1000}]}).then(()=>false,e=>e.name==='NotFoundError');});
 await page.locator('#device-dialog').waitFor({state:'visible'});await page.locator('#device-cancel').click();assert.equal(await page.evaluate(()=>window.usbSelection),true);
 console.log('Native USB/serial chooser cancellation passed; no port opened.');
 await page.addInitScript(mock);
 const report=[];const runId=Date.now();
 for(const scenario of ['success','ml-failure','esp-failure','ml-only','esp-only']){ console.log('Scenario:',scenario);
  await page.reload();await page.waitForFunction(()=>window.ringhiReady);await page.locator('[data-page=flash]').click();await page.evaluate(()=>window.ringhiAccountReady);await page.locator('#activate').uncheck();
  await page.evaluate(async scenario=>{window.failML=scenario==='ml-failure';window.failESP=scenario==='esp-failure';
   const {EspFlasher}=await import('/renderer/esp.mjs');
   EspFlasher.prototype.connect=async function(){this.chip='ESP32-S3 (simulation)';this.loader={async writeFlash(opts){ops.push('esp:write');if(failESP)throw Error('Simulated ESP disconnect');if(typeof opts.calculateMD5Hash!=='function')throw Error('MD5 callback missing');ops.push('esp:verified');},async after(){ops.push('esp:reset');}};this.transport={async disconnect(){ops.push('esp:close');}};return this.chip;};
  },scenario);
  const root=page.locator('#ml-workbench');
  await root.locator('#package').setInputFiles({name:'simulation.pkg',mimeType:'application/octet-stream',buffer:Buffer.from(packageFixture())});
  await page.waitForFunction(()=>document.getElementById('ml-workbench').shadowRoot.getElementById('package-status').textContent.includes('MiB'));
  await root.locator('#directory').click();await root.locator('#at-transport').selectOption('serial');await root.locator('#connect-at').click();
  await page.waitForFunction(()=>document.getElementById('ml-workbench').shadowRoot.getElementById('identity').textContent.includes('已连接'));
  await root.locator('#consent').check();
  await page.locator('#esp-files input[type=file]').setInputFiles({name:'simulation.bin',mimeType:'application/octet-stream',buffer:Buffer.from([1,2,3,4])});
  await page.locator('#esp-consent').check();await page.locator('#esp-connect').click();
  await page.locator('#serial').fill('SIM-'+scenario+'-'+runId);
  if(scenario==='ml-only')await page.locator('[data-mode=ml307h]').click();
  if(scenario==='esp-only')await page.locator('[data-mode=esp32]').click();
  await page.waitForFunction(()=>!document.getElementById('run').disabled);await page.locator('#run').click();console.log('Started:',scenario);
  let result;
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
   result=await page.evaluate(async serial=>({record:(await window.ringhi.history()).find(r=>r.serial===serial),ops:window.ops}),'SIM-'+scenario+'-'+runId);
   if(result.record&&['completed','failed'].includes(result.record.status))break;
   await page.waitForTimeout(100);
  }
  assert.equal(result.record.status,scenario.includes('failure')?'failed':'completed');
  if(scenario==='success'){assert.equal(result.record.steps[1].verification,'md5-passed');assert(result.ops.indexOf('esp:write')>result.ops.indexOf('partition:mbl'));assert.equal(result.record.steps[0].activation,'not-requested');}
  if(scenario==='ml-failure'){assert.equal(result.record.steps[1].status,'skipped');assert(!result.ops.includes('esp:write'));}
  if(scenario==='esp-failure'){assert.equal(result.record.steps[0].status,'passed');assert.equal(result.ops.filter(x=>x==='esp:write').length,1);assert(!result.ops.includes('esp:reset'));}
  if(scenario==='ml-only'){assert.equal(result.record.steps.length,1);assert(!result.ops.includes('esp:write'));}
  if(scenario==='esp-only'){assert.equal(result.record.steps.length,1);assert(!result.ops.includes('AT^AUTODL'));}
  assert.equal(result.record.productionTest,'not-run');report.push({scenario,passed:true});
  // Explicitly release the simulated ML session before reloading.
  if(scenario==='esp-only')await page.locator('[data-mode=dual]').click();
  await root.locator('#release').click();await page.waitForTimeout(400);
 }
 assert.deepEqual(errors,[]);
 await fs.mkdir(path.resolve(__dirname,'../.smoke'),{recursive:true});await fs.writeFile(path.resolve(__dirname,'../.smoke/ui-integration.json'),JSON.stringify({passed:true,scenarios:report,errors,hardware:'simulated-only'},null,2));
 console.log(JSON.stringify(report));
 }catch(e){console.error('UI test failed:',e);if(app){const p=await app.firstWindow();console.error(await p.evaluate(()=>({notice:document.getElementById('run-hint').textContent,esp:document.getElementById('esp-message').textContent,ml:document.getElementById('ml-workbench').shadowRoot.getElementById('message').textContent,ops:window.ops})).catch(()=>null));}throw e;}finally{if(app)app.process().kill('SIGKILL');}
})().catch(e=>{console.error(e);process.exitCode=1;});
