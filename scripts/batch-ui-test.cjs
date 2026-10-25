const {_electron}=require('playwright');const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
(async()=>{let app;try{
 const {packageFixture}=await import('../tests/ml307h-fixtures.mjs');
 app=await _electron.launch({args:[path.resolve(__dirname,'..'),'--test-session'],env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>window.ringhiReady);await page.evaluate(()=>window.ringhiAccountReady);await page.locator('#activate').uncheck();await page.locator('#batch-production').uncheck();
 // CSV chooser is simulated here; native file persistence has its own tests.
 await app.evaluate(({ipcMain})=>{ipcMain.removeHandler('batch-csv');ipcMain.handle('batch-csv',async(_e,action)=>({ok:true,data:action==='prepare'?{id:'00000000-0000-4000-8000-000000000013',csvPath:'simulated-batch.csv'}:{saved:true,rows:0}}));});
 // Replace only the native hardware IPC in this isolated test process.
 await app.evaluate(({ipcMain})=>{globalThis.boards=[];globalThis.accepting=false;ipcMain.removeHandler('native-batch');ipcMain.handle('native-batch',async(_e,action,payload)=>{let data=true;if(action==='arm')globalThis.accepting=true;if(action==='stop')globalThis.accepting=false;if(action==='arm'||action==='scan')data={boards:globalThis.boards};if(action==='claim'){if(!globalThis.accepting)return {ok:false,error:'stopped'};data={lease:payload.id};}return {ok:true,data};});});
 await page.evaluate(async()=>{
  window.testWrites=[];window.testEvents=[];
  class Dir{constructor(name='batch-backups'){this.name=name;}}
  window.showDirectoryPicker=async()=>new Dir();
  const {EspFlasher}=await import('/renderer/esp.mjs'),{MlBatchFlasher}=await import('/renderer/ml-batch.mjs');
  EspFlasher.prototype.connect=async function(chip,_baud,port){this.n=port.endpoint.n;this.mac=`A0:B1:C2:D3:E4:${String(this.n).padStart(2,'0')}`;this.chip=chip;testEvents.push(['mac',this.n]);};
  EspFlasher.prototype.disconnect=async function(){};
  EspFlasher.prototype.flash=async function(){testWrites.push(['esp',this.n]);for(let n=1;n<=5;n++){this.progress(n*20);await new Promise(r=>setTimeout(r,200));}return {mac:this.mac,chip:this.chip,verification:'md5-passed',reset:'requested'};};
  MlBatchFlasher.prototype.probe=async function(lease){this.n=Number(lease.split(':')[1].split('@')[0]);this.identity={imei:String(123456789012340+this.n)};};
  MlBatchFlasher.prototype.disconnect=async function(){};
  MlBatchFlasher.prototype.flash=async function({beforeSwitch}){await beforeSwitch({backup:`backup-${this.n}`,imei:this.identity.imei});testWrites.push(['ml',this.n]);for(let n=1;n<=5;n++){this.progress(n*20);this.stage(n<3?'自动备份保护分区':'写入固件');await new Promise(r=>setTimeout(r,250));}if(this.n===3)throw Error('模拟 ML307H 断开');return {uid:String(this.n).repeat(32),verification:'protocol-ack',reset:'requested',backup:`backup-${this.n}`,activation:'not-requested'};};
 });
 const make=(n,ready=true,epoch=1)=>({id:`1:${n}@${epoch}`,hubKey:`1:${n}`,label:`Hub 1:${n}`,ready,reason:ready?'':'等待 ML307H 接口',esp:{n,vid:0x303a,pid:0x1001,path:`COM${n*2}`},ml:{key:`1:${n}.2`,pid:0x2000,path:`COM${n*2+1}`}});
 assert.equal(await page.locator('#batch-start').isDisabled(),true);
 await page.locator('#esp-files input[type=file]').setInputFiles({name:'RingHi-ESP32.bin',mimeType:'application/octet-stream',buffer:Buffer.from([1,2,3,4])});await page.locator('#esp-consent').check();
 await page.locator('#batch-ml-file').setInputFiles({name:'RingHi-ML307H.pkg',mimeType:'application/octet-stream',buffer:Buffer.from(packageFixture())});await page.locator('#batch-backup').click();await page.locator('#batch-ml-consent').check();
 await app.evaluate((_e,boards)=>globalThis.boards=boards,[make(1,false)]);
 await page.locator('#batch-start').click();await page.waitForFunction(()=>document.querySelector('#batch-devices tr')?.dataset.state==='waiting');assert.equal(await page.evaluate(()=>testWrites.length),0);
 await app.evaluate((_e,boards)=>globalThis.boards=boards,[make(1),make(2),make(3)]);
 await page.waitForFunction(()=>document.querySelectorAll('#batch-devices tr[data-state=flashing]').length===3);
 assert.equal(await page.locator('#batch-devices progress').count(),6);assert.equal(await page.locator('#batch-ml-fields').evaluate(el=>el.disabled),true);
 const out=path.resolve(__dirname,'../../test-evidence/dual-0.3.14');await fs.mkdir(out,{recursive:true});await page.locator('#batch-devices').screenshot({path:path.join(out,'dual-in-progress.png')});
 await page.waitForFunction(()=>document.querySelectorAll('#batch-devices tr[data-state=passed]').length===2&&document.querySelectorAll('#batch-devices tr[data-state=failed]').length===1&&document.querySelectorAll('#batch-finished tr').length===0);
 await app.evaluate(()=>globalThis.boards=[]);await page.waitForTimeout(1700);
 await app.evaluate((_e,boards)=>globalThis.boards=boards,[make(1,true,2),make(4)]);
 await page.waitForFunction(()=>document.querySelectorAll('#batch-finished tr').length===3&&document.querySelectorAll('#batch-devices tr[data-state=passed]').length===2);
 assert.equal(await page.evaluate(()=>testWrites.length),10);
 const evidence=await page.evaluate(async()=>({writes:testWrites,events:testEvents,records:await window.ringhi.history()}));
 for(const [chip,n] of evidence.writes)assert(evidence.events.some(e=>e[0]==='mac'&&e[1]===n));
 const passed=evidence.records.filter(r=>r.status==='completed');assert.equal(passed.length,4);for(const r of passed){assert.equal(r.mode,'dual');assert.equal(r.steps.length,2);assert(r.steps.every(s=>s.status==='passed'));assert(r.serial.startsWith('A0:'));assert(r.hub&&r.batchId);}
 const failed=evidence.records.find(r=>r.status==='failed');assert.equal(failed.steps.find(s=>s.id==='esp32').status,'passed');assert.equal(failed.steps.find(s=>s.id==='ml307h').status,'failed');
 await page.locator('#batch-stop').click();await page.waitForFunction(()=>!document.getElementById('batch-start').disabled);
 await page.locator('#batch-finished').screenshot({path:path.join(out,'dual-results.png')});await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'ui.json'),JSON.stringify({passed:true,hardware:'simulated-only',checks:['incomplete hub waits','one row per board','two progress bars','dual parallel writes','independent chip failure','whole-board success requires both','replug creates a new attempt and retains old results','per-board backup metadata','MAC and dual journal','locked configuration'],...evidence},null,2));
 console.log('Dual-chip batch Electron UI passed. No physical hardware accessed.');
 }finally{if(app)app.process().kill('SIGKILL');}})().catch(e=>{console.error(e);process.exitCode=1;});
