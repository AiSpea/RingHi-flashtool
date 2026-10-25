const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process');
const {digest}=require('./updates.cjs');
const psQuote=s=>"'"+s.replace(/'/g,"''")+"'";
async function launchInstall({platform=process.platform,update,directory,executable=process.env.PORTABLE_EXECUTABLE_FILE,pid=process.pid,openPath,spawnImpl=spawn}){
 if(await digest(update.file)!==update.sha256)throw Error('更新包校验失败，拒绝启动安装');
 if(platform==='darwin'){const error=await openPath(update.file);if(error)throw Error(error);return;}
 if(platform!=='win32'||!executable||!path.win32.isAbsolute(executable)||!executable.toLowerCase().endsWith('.exe'))throw Error('请使用 Windows 便携版运行，才能覆盖原 EXE');
 const target=executable,oldSha256=await digest(target);await fs.mkdir(directory,{recursive:true});
 const script=path.join(directory,'install-portable.ps1'),config=path.join(directory,'install-portable.json');
 await fs.copyFile(path.join(__dirname,'install-portable.ps1'),script);
 await fs.writeFile(config,JSON.stringify({source:update.file,version:update.version,target,pid,sha256:update.sha256,oldSha256,result:path.join(directory,'last-install.json')}),{mode:0o600});
 const command=`& ([ScriptBlock]::Create([IO.File]::ReadAllText(${psQuote(script)}))) -ConfigPath ${psQuote(config)}`;
 const child=spawnImpl('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{detached:true,stdio:'ignore',windowsHide:true});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
}
module.exports={launchInstall,psQuote};
