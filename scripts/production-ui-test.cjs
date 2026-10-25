const {_electron}=require('playwright');const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
(async()=>{let app;try{
 const {packageFixture}=await import('../tests/ml307h-fixtures.mjs');
 app=await _electron.launch({args:[path.resolve(__dirname,'..'),'--test-session'],env:{...process.env,ELECTRON_RUN_AS_NODE:''}});
 const page=await app.firstWindow(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.waitForFunction(()=>window.ringhiReady);await page.evaluate(()=>window.ringhiAccountReady);assert.equal(await page.locator('#activate').isChecked(),true);assert.equal(await page.locator('#batch-production').isChecked(),true);await page.locator('#activate').uncheck();
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

 await page.evaluate(async()=>{
  const {ProductionRunner}=await import('/core/production.mjs'),{MlBatchFlasher}=await import('/renderer/ml-batch.mjs');
  MlBatchFlasher.prototype.waitReady=async function(){testEvents.push(['ready',this.n]);};
  ProductionRunner.prototype.run=async function({board}){const n=board.esp.n;testEvents.push(['production',n]);await this.change({state:'running',reason:'检查测试卡',cloudRegistered:false});await new Promise(r=>setTimeout(r,400));return n===1?{state:'passed',runId:'test1',reason:'自动检查通过',cloudRegistered:true,upload:'uploaded'}:n===2?{state:'failed',runId:'test2',reason:'sim: 未检测到测试卡',cloudRegistered:false,upload:'uploaded'}:{state:'review',reason:'未连接 AiSpea_Factory 工厂 Wi-Fi',cloudRegistered:null};};
 });
 const make=n=>({id:`1:${n}@1`,hubKey:`1:${n}`,label:`Hub 1:${n}`,ready:true,esp:{n,vid:0x303a,pid:0x1001,path:`COM${n*2}`},ml:{key:`1:${n}.2`,pid:0x2000,path:`COM${n*2+1}`}});
 await page.locator('#esp-files input[type=file]').setInputFiles({name:'RingHi-ESP32.bin',mimeType:'application/octet-stream',buffer:Buffer.from([1,2,3,4])});await page.locator('#esp-consent').check();
 await page.locator('#batch-ml-file').setInputFiles({name:'RingHi-ML307H.pkg',mimeType:'application/octet-stream',buffer:Buffer.from(packageFixture())});await page.locator('#batch-backup').click();await page.locator('#batch-ml-consent').check();
 await app.evaluate((_e,boards)=>globalThis.boards=boards,[1,2,3,4].map(make));await page.locator('#batch-start').click();
 await page.waitForFunction(()=>document.getElementById('batch-running').textContent==='0'&&document.querySelectorAll('#batch-devices tr').length===4);
 assert.equal(await page.locator('#batch-devices tr[data-state=passed]').count(),1);assert.equal(await page.locator('#batch-devices tr[data-state=failed]').count(),2);assert.equal(await page.locator('#batch-devices tr[data-state=review]').count(),1);
 const result=await page.evaluate(async()=>({events:testEvents,records:await window.ringhi.history(),text:document.getElementById('batch-devices').innerText}));
 assert.match(result.text,/云端已登记/);assert.match(result.text,/未检测到测试卡/);assert.match(result.text,/AiSpea_Factory/);assert(!result.events.some(e=>e[0]==='production'&&e[1]===3));assert.equal(result.records.find(r=>r.productionTest==='passed').production.cloudRegistered,true);assert.equal(result.records.find(r=>r.productionTest==='review').production.cloudRegistered,null);
 await page.locator('#batch-stop').click();const out=path.resolve(__dirname,'../../test-evidence/windows-0.3.9');await fs.mkdir(out,{recursive:true});await page.screenshot({path:path.join(out,'production-ui.png'),fullPage:true});
 await page.locator('[data-page=records]').click();await page.waitForFunction(()=>document.getElementById('records').textContent.includes('产测通过'));assert.match(await page.locator('#records').textContent(),/云端已登记/);await page.locator('#export').isEnabled();assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(out,'production-ui.json'),JSON.stringify({passed:true,hardware:'simulated',defaults:{activation:true,production:true},...result},null,2));console.log('Production UI pass/fail/review/cloud status and persisted history passed; hardware simulated.');
 }finally{if(app)app.process().kill('SIGKILL');}})().catch(e=>{console.error(e);process.exitCode=1;});
