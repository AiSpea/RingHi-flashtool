const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const MAX=64*1024*1024;
class BackupFiles {
 constructor(configFile,defaultPath){this.configFile=configFile;this.defaultPath=defaultPath;this.roots=new Map();}
 async grant(folder,{remember=false}={}){
  const root=await fs.realpath(folder);if(!(await fs.stat(root)).isDirectory())throw Error('请选择备份文件夹');
  const probe=path.join(root,'.ringhi-write-check-'+randomUUID());const bytes=Buffer.from(randomUUID());
  try{await fs.writeFile(probe,bytes,{flag:'wx'});if(!(await fs.readFile(probe)).equals(bytes))throw Error('备份目录写入校验失败');}finally{await fs.unlink(probe).catch(()=>{});}
  if(remember){await fs.mkdir(path.dirname(this.configFile),{recursive:true});const tmp=this.configFile+'.tmp';await fs.writeFile(tmp,JSON.stringify({path:root}));await fs.rename(tmp,this.configFile);}
  const existing=[...this.roots].find(([,v])=>v===root);const token=existing?.[0]||randomUUID();this.roots.set(token,root);return {token,name:path.basename(root),path:root};
 }
 async defaultRoot(){let folder;try{folder=JSON.parse(await fs.readFile(this.configFile,'utf8')).path;if(typeof folder!=='string'||!path.isAbsolute(folder))throw Error('已保存的备份目录无效');}catch(e){if(e.code!=='ENOENT')throw e;folder=this.defaultPath;await fs.mkdir(folder,{recursive:true});}return this.grant(folder,{remember:true});}
 async resolve(token,parts){
  const root=this.roots.get(token);if(!root)throw Error('备份目录授权已失效，请重新选择');
  if(!Array.isArray(parts)||parts.length>12||parts.some(p=>typeof p!=='string'||!p||p.length>240||/[\\/:\x00-\x1f]/.test(p)||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('备份文件路径无效');
  if(await fs.realpath(root)!==root)throw Error('备份目录已变化，请重新选择');
  let target=root;
  for(let i=0;i<parts.length;i++){target=path.join(target,parts[i]);try{if((await fs.lstat(target)).isSymbolicLink())throw Error('备份目录不允许符号链接');}catch(e){if(e.code!=='ENOENT'||i!==parts.length-1)throw e;}}
  return target;
 }
 async call(action,p){
  const target=await this.resolve(p.token,p.parts);
  if(action==='directory'){if(p.create)await fs.mkdir(target).catch(e=>{if(e.code!=='EEXIST')throw e;});if(!(await fs.stat(target)).isDirectory())throw Error('备份路径不是文件夹');return true;}
  if(action==='file'){if(p.create){const h=await fs.open(target,'a');await h.close();}if(!(await fs.stat(target)).isFile())throw Error('备份路径不是文件');return true;}
  if(action==='read'){if((await fs.stat(target)).size>MAX)throw Error('备份文件过大');return new Uint8Array(await fs.readFile(target));}
  if(action==='write'){
   if(!(p.bytes instanceof Uint8Array)||p.bytes.length>MAX||!p.parts.length)throw Error('备份写入数据无效');
   const tmp=target+'.'+randomUUID()+'.tmp';try{await fs.writeFile(tmp,p.bytes,{flag:'wx'});await fs.rename(tmp,target);}finally{await fs.unlink(tmp).catch(()=>{});}return true;
  }
  throw Error('无效备份操作');
 }
}
module.exports={BackupFiles};
