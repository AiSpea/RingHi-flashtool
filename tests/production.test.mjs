import test from 'node:test';import assert from 'node:assert/strict';
import {evaluateFactory,ProductionRunner,productionReady} from '../core/production.mjs';
import {FactoryConsole} from '../renderer/production.mjs';
const sample=(stage='passed')=>({active:true,done:true,cloudRegistered:false,pendingUpload:false,upload:'uploaded',report:{runId:'new-run',ledPolicy:'volte-card-v3',stage,sequence:5,checks:['wifi','volte','sim'].map(id=>({id,status:'passed',detail:'ok'}))}});
test('v3 requires final stage plus every measured check; cloud registration is independent',()=>{const s=sample();assert.equal(evaluateFactory(s).state,'passed');assert.equal(evaluateFactory(s).cloudRegistered,false);s.report.stage='sim_check';assert.equal(evaluateFactory(s).state,'running');s.report.stage='passed';s.report.checks.pop();assert.equal(evaluateFactory(s).state,'review');});
test('persistent done alone, cancellation, failures and unknown protocol cannot pass',()=>{assert.equal(evaluateFactory({done:true}).state,'running');let s=sample();s.report.cancelled=true;assert.equal(evaluateFactory(s).state,'cancelled');s=sample();s.report.checks[0]={id:'wifi',status:'failed',detail:'no AP'};assert.match(evaluateFactory(s).reason,/no AP/);s=sample();s.report.ledPolicy='future';assert.equal(evaluateFactory(s).state,'review');});
test('legacy report needs required checks, both slots and does not invent cloud support',()=>{const s={done:true,report:{runId:'legacy',ledPolicy:'module-card-v2',profile:'sim_optional',simSlots:[{status:'empty'},{status:'empty'}],checks:['storage','at','modem','spi','wifi','rf'].map(id=>({id,status:'passed'}))}};assert.equal(evaluateFactory(s).state,'passed');assert.equal(evaluateFactory(s).cloudRegistered,null);s.report.checks.pop();assert.equal(evaluateFactory(s).state,'running');s.report.simSlots[0].status='locked';assert.equal(evaluateFactory(s).state,'failed');});
function harness(statuses,extra={}){let now=0,closed=0,retests=0;const updates=[];const port={status:async()=>statuses.length>1?statuses.shift():statuses[0],retest:async()=>{retests++;return 'armed';},close:async()=>{closed++;}};const runner=new ProductionRunner({connect:async()=>port,change:x=>updates.push(x),now:()=>now,sleep:async ms=>{now+=ms;},poll:1,bootTimeout:5,testTimeout:15,cloudTimeout:3,...extra});return {runner,updates,get closed(){return closed;},get retests(){return retests;}};}
const empty=()=>({active:false,done:false,pendingUpload:false,report:null});
test('starts a fresh run once, rejects old success, waits for cloud result',async()=>{const old=sample();old.report.runId='old';const pending=sample();pending.pendingUpload=true;const done=sample();done.cloudRegistered=true;const h=harness([old,old,pending,done]);const out=await h.runner.run({});assert.equal(out.state,'passed');assert.equal(out.runId,'new-run');assert.equal(out.cloudRegistered,true);assert.equal(h.retests,1);assert.equal(h.closed,1);});
test('old success after RETEST never becomes a fresh success',async()=>{const h=harness([sample()]);assert.equal((await h.runner.run({})).state,'review');assert.equal(h.retests,1);});
test('missing AP yields actionable review, never a hardware pass',async()=>{const h=harness([empty()]);const out=await h.runner.run({});assert.equal(out.state,'review');assert.match(out.reason,/AiSpea_Factory/);});
test('pending old report and retest refusal are preserved without destructive clearing',async()=>{const s=sample();s.pendingUpload=true;let h=harness([s]);assert.equal((await h.runner.run({})).state,'review');assert.equal(h.retests,0);h=harness([empty()],{connect:async()=>({status:async()=>empty(),retest:async()=>'refused',close:async()=>{}})});assert.match((await h.runner.run({})).reason,/拒绝/);});
test('changed run, sequence rollback and unplug cannot pass',async()=>{const running=sample('sim_check'),other=sample();other.report.runId='other';let h=harness([empty(),running,other]);assert.match((await h.runner.run({})).reason,/轮次/);const older=sample();older.report.sequence=2;h=harness([empty(),running,older]);assert.match((await h.runner.run({})).reason,/序号/);let n=0;h=harness([],{connect:async()=>({status:async()=>{if(n++)throw Error('unplugged');return empty();},retest:async()=>'armed',close:async()=>{}})});assert.match((await h.runner.run({})).reason,/通信中断/);});
test('hardware pass survives bounded cloud upload failure without claiming registration',async()=>{const s=sample();s.pendingUpload=true;s.upload='HTTP 403';const h=harness([empty(),s]);const out=await h.runner.run({});assert.equal(out.state,'passed');assert.equal(out.cloudRegistered,false);assert.equal(out.pendingUpload,true);assert.equal(out.phase,'review');assert.equal(productionReady(out),false);});
test('USB console parses split JSON amid logs and uses fixed commands',async()=>{const sent=[],data=['boot log\n'+JSON.stringify(sample()).slice(0,40),JSON.stringify(sample()).slice(40)+'\n'];const io=async(action,p)=>{if(action==='write')sent.push(new TextDecoder().decode(p.bytes));if(action==='read')return new TextEncoder().encode(data.shift());};const c=new FactoryConsole(io,'h');assert.equal((await c.status()).report.runId,'new-run');assert.deepEqual(sent,['FACTORY STATUS\n']);await c.close();});

for(const registered of [false,null])test(`registration ${registered} cannot pass even when report upload succeeded`,async()=>{
 const s=sample();s.cloudRegistered=registered;const h=harness([empty(),s]);const out=await h.runner.run({});
 assert.equal(out.state,'passed');assert.equal(productionReady(out),false);assert.equal(out.phase,'review');assert.match(out.phaseReason,/登记/);assert(h.updates.some(v=>v.phase==='registration'));
});
test('registration can precede final report; upload wait is explicit and bounded',async()=>{
 const s=sample();s.cloudRegistered=true;s.pendingUpload=true;const h=harness([empty(),s]);const out=await h.runner.run({});
 assert.equal(productionReady(out),false);assert.equal(out.phase,'review');assert.match(out.phaseReason,/报告上传超时/);assert(h.updates.some(v=>v.phase==='upload'));
});
test('registration, upload and console closing are separate stages before completion',async()=>{
 const registration=sample(),upload={...sample(),cloudRegistered:true,pendingUpload:true},done={...sample(),cloudRegistered:true};
 let release;const gate=new Promise(r=>release=r);let closing=false;const statuses=[empty(),registration,upload,done];
 const h=harness([],{connect:async()=>({status:async()=>statuses.shift(),retest:async()=>'armed',close:async()=>{closing=true;await gate;}})});
 let finished=false;const run=h.runner.run({}).then(v=>{finished=true;return v;});
 for(let i=0;i<50&&!closing;i++)await new Promise(r=>setImmediate(r));
 assert.equal(closing,true);assert.equal(finished,false);assert.equal(h.updates.at(-1).phase,'closing');assert.deepEqual(h.updates.filter(v=>v.phase).map(v=>v.phase),['registration','upload','closing']);
 release();const out=await run;assert.equal(out.phase,'complete');assert.equal(productionReady(out),true);
});
test('test deadline and registration rejection never bypass cloud gate',async()=>{
 let s=sample();s.pendingUpload=true;let h=harness([empty(),s],{cloudTimeout:99,testTimeout:2});assert.equal(productionReady(await h.runner.run({})),false);
 for(const code of [403,409]){s={...sample(),upload:`HTTP ${code}`};h=harness([empty(),s]);const out=await h.runner.run({});assert.equal(productionReady(out),false);assert.match(out.phaseReason,/拒绝/);}
});
