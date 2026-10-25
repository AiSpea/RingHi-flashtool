// Future production tests register as additional ordered steps, using the same journal.
export class Job {
 constructor(mode,serial=''){
  if(!['dual','ml307h','esp32'].includes(mode))throw Error('无效任务模式');
  this.record={schema:1,id:crypto.randomUUID(),serial:String(serial).trim().slice(0,128),mode,startedAt:new Date().toISOString(),status:'running',steps:(mode==='dual'?['ml307h','esp32']:[mode]).map(id=>({id,status:'pending'})),productionTest:'not-run'};
 }
 start(id){const steps=this.record.steps,step=steps.find(s=>s.id===id);if(this.record.status!=='running'||!step||step.status!=='pending'||steps.slice(0,steps.indexOf(step)).some(s=>s.status!=='passed'))throw Error('任务步骤顺序无效');step.status='running';step.startedAt=new Date().toISOString();return this.snapshot();}
 finish(id,result){const step=this.record.steps.find(s=>s.id===id);if(this.record.status!=='running'||step?.status!=='running')throw Error('任务步骤未运行');Object.assign(step,result,{id,status:'passed',finishedAt:new Date().toISOString()});if(this.record.steps.every(s=>s.status==='passed')){this.record.status='completed';this.record.finishedAt=new Date().toISOString();}return this.snapshot();}
 fail(id,message,details={}){const step=this.record.steps.find(s=>s.id===id);if(!step||this.record.status!=='running')return this.snapshot();Object.assign(step,details,{status:'failed',message:String(message).slice(0,600),finishedAt:new Date().toISOString()});for(const s of this.record.steps)if(s.status==='pending')s.status='skipped';this.record.status='failed';this.record.finishedAt=new Date().toISOString();return this.snapshot();}
 snapshot(){return structuredClone(this.record);}
}
