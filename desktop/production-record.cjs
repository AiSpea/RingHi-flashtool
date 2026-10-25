function cleanProduction(p){
 if(!p||typeof p!=='object')return undefined;
 const out={};for(const k of ['state','reason','runId','policy','stage','firmware','upload','phase','phaseReason'])if(typeof p[k]==='string')out[k]=p[k].slice(0,2000);
 out.cloudRegistered=typeof p.cloudRegistered==='boolean'?p.cloudRegistered:null;out.pendingUpload=p.pendingUpload===true;
 out.checks=Array.isArray(p.checks)?p.checks.slice(0,32).map(c=>Object.fromEntries(['id','status','detail'].filter(k=>typeof c[k]==='string').map(k=>[k,c[k].slice(0,512)]))):[];return out;
}
module.exports={cleanProduction};
