const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {digest}=require('./updates.cjs');
const psQuote=s=>"'"+s.replace(/'/g,"''")+"'";
async function launchInstall({platform=process.platform,update,directory,executable=process.env.PORTABLE_EXECUTABLE_FILE,pid=process.pid,openPath,spawnImpl=spawn,digestImpl=digest,readyTimeoutMs=15000}){
 if(await digestImpl(update.file)!==update.sha256)throw Error('更新包校验失败，拒绝启动安装');
 if(platform==='darwin'){const error=await openPath(update.file);if(error)throw Error(error);return;}
 if(platform!=='win32'||!executable||!path.win32.isAbsolute(executable)||!executable.toLowerCase().endsWith('.exe'))throw Error('请使用 Windows 便携版运行，才能覆盖原 EXE');
 const target=executable,oldSha256=await digestImpl(target);await fs.mkdir(directory,{recursive:true});
 const nonce=randomUUID(),script=path.join(directory,'install-portable.ps1'),config=path.join(directory,'install-portable.json'),readyFile=path.join(directory,`install-ready-${nonce}.json`),logFile=path.join(directory,'install-portable.log');
 await fs.copyFile(path.join(__dirname,'install-portable.ps1'),script);
 await fs.writeFile(config,JSON.stringify({source:update.file,version:update.version,target,pid,sha256:update.sha256,oldSha256,result:path.join(directory,'last-install.json'),readyFile,nonce}),{mode:0o600});
 const command=`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${psQuote(script)}))) -ConfigPath ${psQuote(config)}`;
 const log=await fs.open(logFile,'a',0o600);let child,exited=false,launchError;
 try{
  // The portable EXE removes its extraction directory on exit. Start in a
  // durable directory and wait for the script itself, not only CreateProcess.
  const powershell=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  child=spawnImpl(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{cwd:directory,detached:true,stdio:['ignore',log.fd,log.fd],windowsHide:true});
  child.on('error',e=>{launchError=e;});child.on('exit',()=>{exited=true;});
  const start=Date.now();
  while(Date.now()-start<readyTimeoutMs){
   if(launchError)throw launchError;
   if(exited)throw Error('安装器在就绪前退出');
   try{const ready=JSON.parse((await fs.readFile(readyFile,'utf8')).replace(/^\ufeff/,''));if(ready.nonce===nonce&&Number.isInteger(ready.pid)&&ready.pid!==pid){child.unref();return;}}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
   await new Promise(r=>setTimeout(r,50));
  }
  throw Error('等待安装器就绪超时');
 }catch(e){if(child&&!exited)child.kill();throw Error(`${e.message}；原程序保留，安装日志：${logFile}`);}
 finally{await log.close();await fs.rm(readyFile,{force:true});}
}
module.exports={launchInstall,psQuote};
