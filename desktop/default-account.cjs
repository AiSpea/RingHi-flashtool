const fs=require('node:fs/promises'),path=require('node:path');
const {prepareRequest}=require('./spark.cjs');
// Credentials stay outside the application bundle and are encrypted by the host OS.
class DefaultAccount {
 constructor(directory,storage){this.file=path.join(directory,'ml307h-default.enc');this.projectFile=path.join(directory,'ml307h-default-project.json');this.storage=storage;this.queue=Promise.resolve();}
 async available(){if(!await this.storage.isAsyncEncryptionAvailable())throw Error('系统安全存储不可用，无法读取或保存默认账号');}
 async read(){
  let bytes;try{bytes=await fs.readFile(this.file);}catch(e){if(e.code==='ENOENT')return null;throw Error('无法读取本机默认账号');}
  try{await this.available();const {result}=await this.storage.decryptStringAsync(bytes);const credentials=JSON.parse(result);prepareRequest('login',credentials);return credentials;}
  catch{throw Error('无法解密本机默认账号，请允许系统钥匙串访问或重新配置');}
 }
 async status(){
  const c=await this.read();if(!c)return {configured:false};const status={configured:true,username:c.username};
  try{const p=JSON.parse(await fs.readFile(this.projectFile,'utf8'));if(p.username===c.username&&Number.isInteger(p.projectId)&&p.projectId>0)status.projectId=p.projectId;}catch{}
  return status;
 }
 async selectProject({username,projectId}={}){
  if(typeof username!=='string'||!Number.isInteger(projectId)||projectId<1||projectId>2147483647)throw Error('授权项目配置无效');
  const c=await this.read();if(!c||c.username!==username)throw Error('只可为本机默认账号保存授权项目');
  const temp=this.projectFile+'.tmp';try{await fs.writeFile(temp,JSON.stringify({username,projectId}),{mode:0o600});await fs.rename(temp,this.projectFile);}finally{await fs.rm(temp,{force:true});}
  return {projectId};
 }
 save(credentials){
  prepareRequest('login',credentials);
  const value={username:credentials.username.trim(),password:credentials.password,pccode:credentials.pccode.replace(/\s/g,'')};
  const operation=this.queue.then(async()=>{
   await this.available();const encrypted=await this.storage.encryptStringAsync(JSON.stringify(value));
   await fs.mkdir(path.dirname(this.file),{recursive:true});const temp=this.file+'.tmp';
   try{await fs.writeFile(temp,encrypted,{mode:0o600});await fs.rename(temp,this.file);}finally{await fs.rm(temp,{force:true});}
   return {configured:true,username:value.username};
  });this.queue=operation.catch(()=>{});return operation;
 }
 async clear(){await this.queue;await fs.rm(this.file,{force:true});await fs.rm(this.projectFile,{force:true});return {configured:false};}
}
module.exports={DefaultAccount};
