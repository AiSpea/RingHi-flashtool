const fs=require('node:fs/promises'),path=require('node:path');
const {digest,REPOSITORY,validateManifest}=require('../desktop/updates.cjs');
async function main(){const directory=path.resolve(process.argv[2]||'dist'),version=require('../package.json').version,artifacts={};
 for(const [key,suffix] of [['darwin-arm64','macOS-arm64.pkg'],['win32-x64','Windows-x64.exe']]){const name=`RingHi-Flasher-${version}-${suffix}`,file=path.join(directory,name);artifacts[key]={name,url:`https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`,size:(await fs.stat(file)).size,sha256:await digest(file)};}
 const manifest={schema:1,appId:'com.aispea.ringhi.flasher',version,publishedAt:new Date().toISOString(),notes:await fs.readFile(path.join(__dirname,'../release-notes.txt'),'utf8'),artifacts};
 for(const [platform,arch] of [['darwin','arm64'],['win32','x64']])validateManifest(manifest,{platform,arch,currentVersion:'0.0.0'});
 await fs.writeFile(path.join(directory,'ringhi-update.json'),JSON.stringify(manifest,null,2)+'\n');console.log(`Validated update manifest v${version}`);
}main().catch(e=>{console.error(e.message);process.exitCode=1;});
