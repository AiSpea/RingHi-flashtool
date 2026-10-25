import {bytes,crc16,md5,sha256} from './protocol.mjs';
import {boardMatches} from './transport.mjs';
export const MAX_PACKAGE=64*1024*1024;
const text=new TextDecoder('utf-8',{fatal:true});
function fail(message){throw Error(`PKG：${message}`);}
function cstr(b,label){const end=b.indexOf(0);if(end<0)fail(`${label} 缺少结束符`);try{return text.decode(b.subarray(0,end));}catch{fail(`${label} 不是 UTF-8`);}}
function safe64(v,offset){const n=v.getBigUint64(offset,true);if(n>BigInt(Number.MAX_SAFE_INTEGER))fail('64 位字段超出安全整数范围');return Number(n);}
function disjoint(ranges,label){ranges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])fail(`${label} 重叠：${ranges[i-1][2]} / ${ranges[i][2]}`);}
function contains(haystack,needle){outer:for(let i=0;i<=haystack.length-needle.length;i++){for(let j=0;j<needle.length;j++)if(haystack[i+j]!==needle[j])continue outer;return true;}return false;}
export const DEFAULT_PROFILE=Object.freeze({schema:1,protocol:'ml307h-rom-v1',project:'e_badge',board:'test0817',requiredImages:['ap','ap_extend','ap_extflash']});
export function validateProfile(value,pkg){
  if(!value||value.schema!==1||value.protocol!=='ml307h-rom-v1')fail('适配配置需要 schema=1、protocol=ml307h-rom-v1');
  for(const key of ['project','board'])if(typeof value[key]!=='string'||!/^[a-zA-Z0-9_-]{1,63}$/.test(value[key]))fail(`适配配置 ${key} 无效`);
  if(!/^[a-f0-9]{64}$/.test(value.firmwareSha256||'')||value.firmwareSha256!==pkg.digest)fail('适配配置的 firmwareSha256 与当前固件不一致');
  if(value.project!==pkg.project)fail('适配配置与固件项目不一致');
  if(!Array.isArray(value.requiredImages)||!value.requiredImages.length||value.requiredImages.length>64||!value.requiredImages.includes('ap')||value.requiredImages.some(n=>typeof n!=='string'||!/^[a-zA-Z0-9_]{1,35}$/.test(n)))fail('适配配置 requiredImages 必须包含 ap 和所有必需镜像名');
  return {schema:1,protocol:value.protocol,project:value.project,board:value.board,firmwareSha256:value.firmwareSha256,requiredImages:[...new Set(value.requiredImages)]};
}
// Exact released package identity; future boards under the same project are not pinned here.
const RELEASE_PROFILES={
  '009494c9f0533e93978387bf30e53dc48b762167e98b2759eb5df0a88fc6d464':
    {...DEFAULT_PROFILE,project:'super_badge'},
};
function automaticProfile(pkg){
  const known=RELEASE_PROFILES[pkg.digest]||(pkg.project===DEFAULT_PROFILE.project?DEFAULT_PROFILE:null);
  if(known)return {...known};
  // PKG v1 has no authoritative target-board field. Do not guess one from
  // arbitrary binary strings or from the firmware currently on the device.
  return packageProfile(pkg);
}
function packageProfile(pkg){
  return {schema:1,protocol:'ml307h-rom-v1',project:pkg.project,board:null,
    firmwareSha256:pkg.digest,requiredImages:['ap'],source:'package'};
}
export function flashChecks(identity){
  if(!identity?.flashChecks)return {board:true,reread:true,usbSerial:true};
  const c=identity.flashChecks;
  if(!['board','reread','usbSerial'].every(k=>typeof c[k]==='boolean'))throw Error('烧录检查选项无效');
  return {board:c.board,reread:c.reread,usbSerial:c.usbSerial};
}
export function validDeviceIdentity(identity){
  if(!identity || typeof identity.version!=='string')return false;
  try{
    const c=flashChecks(identity);
    if(identity.identification==='download-uid')return !!identity.flashChecks && !c.board && !c.reread && identity.imei==='' && identity.version==='';
    return /^\d{15}$/.test(identity.imei||'') && !!identity.version.trim();
  }catch{return false;}
}
export function sameSavedIdentity(a,b){
  return validDeviceIdentity(a)&&validDeviceIdentity(b)&&a.imei===b.imei&&a.identification===b.identification&&
    JSON.stringify(flashChecks(a))===JSON.stringify(flashChecks(b));
}
export function packageMatchesDevice(pkg,identity){
  return !!(pkg?.compatibility?.supported && validDeviceIdentity(identity) &&
    (!flashChecks(identity).board || !pkg.compatibility.profile.board || boardMatches(identity.version,pkg.compatibility.profile.board)));
}
export function matchPackageProfile(pkg,custom=null,{checkBoard=true}={}){
  try{
    const profile=custom?validateProfile(custom,pkg):(checkBoard?automaticProfile(pkg):packageProfile(pkg));
    for(const name of profile.requiredImages)if(!pkg.writes.some(e=>e.name===name&&e.target===name))throw Error(`适配配置要求 ${name} 镜像，当前包缺失`);
    if(!custom&&profile.board&&!pkg.entries.some(e=>e.name==='factory_bak'))throw Error('电子吧唧包缺少 factory_bak 保护分区');
    const marker=profile.board?new TextEncoder().encode(profile.board):null;
    if(marker&&!pkg.writes.filter(e=>['ap','ap_extend','ap_extflash','romfs'].includes(e.name)).some(e=>contains(pkg.payload(e),marker)))throw Error(`固件中没有找到 ${profile.board} 板型标记，不能确认适配；请固件开发者检查构建产物`);
    return {supported:true,profile,reason:profile.board?`${profile.project} / ${profile.board} · ${custom?'已读取原会话适配信息':'自动识别'}。请确认固件适用于当前硬件。`:`${profile.project} · PKG 格式与分区检查通过。包内没有标准板型字段，请确认固件适用于当前硬件。`};
  }catch(e){return {supported:false,profile:null,reason:e.message};}
}
export function restoreSavedProfile(pkg,record){
  if(record.digest!==pkg.digest)throw Error('恢复记录的固件摘要不匹配');
  if(JSON.stringify(record.profile)===JSON.stringify(pkg.compatibility.profile))return;
  const automatic=automaticProfile(pkg);
  if(![automatic,packageProfile(pkg)].some(p=>JSON.stringify(pkg.compatibility.profile)===JSON.stringify(p)))throw Error('恢复记录的板型配置不匹配');
  if(!record.profile){
    if(pkg.project!==DEFAULT_PROFILE.project)throw Error('旧记录缺少目标信息，不能确认原会话');
    return;
  }
  if(record.identity?.flashChecks?.board===false && JSON.stringify(record.profile)===JSON.stringify(packageProfile(pkg))){pkg.compatibility=matchPackageProfile(pkg,null,{checkBoard:false});return;}
  if(JSON.stringify(record.profile)===JSON.stringify(automatic)){pkg.compatibility=matchPackageProfile(pkg);return;}
  const restored=matchPackageProfile(pkg,record.profile);
  if(!restored.supported || (automatic.board && restored.profile.board!==automatic.board))throw Error('恢复记录的板型配置不匹配');
  pkg.compatibility=restored;
}
export async function parsePackage(source,{inspectOnly=false,profile=null}={}){
  const raw=bytes(source).slice();if(raw.length<136||raw.length>MAX_PACKAGE)fail('文件大小不在 136 bytes～64 MiB 内');
  const v=new DataView(raw.buffer);if(v.getUint32(0,true)!==0x5c6d8e9f)fail('魔数不匹配');
  if(v.getUint32(4,true)!==1)fail('仅支持格式版本 1');if(safe64(v,8)!==raw.length)fail('文件总长度不匹配');
  const project=cstr(raw.subarray(16,48),'项目'),version=cstr(raw.subarray(48,80),'版本');
  if(!/^[a-zA-Z0-9_-]{1,31}$/.test(project))fail('固件项目名称无效');
  const offset=v.getUint32(80,true),count=v.getUint32(84,true),auth=v.getUint32(88,true),end=offset+count*464;
  if(offset<136||count<1||count>128||end>raw.length)fail('分区表范围无效');
  if(![0,1,2].includes(auth))fail('未知包校验类型');
  if(auth===1){const expected=text.decode(raw.subarray(96,128)).toLowerCase();if(!/^[a-f0-9]{32}$/.test(expected)||md5(raw.subarray(offset))!==expected)fail('MD5 校验失败');}
  if(auth===2&&crc16(raw.subarray(offset))!==v.getUint32(92,true))fail('CRC16 校验失败');
  const entries=[],names=new Set(),targets=new Set(),dataRanges=[],flashRanges=[];
  for(let i=0;i<count;i++){
    const at=offset+i*464,eview=new DataView(raw.buffer,at,464),str=(a,b,label)=>cstr(raw.subarray(at+a,at+b),label);
    const e={name:str(0,32,'分区名'),type:str(32,64,'分区类型'),file:str(64,320,'文件名'),offset:safe64(eview,320),size:safe64(eview,328),address:safe64(eview,336),capacity:safe64(eview,344),target:str(352,388,'目标分区'),flag:eview.getUint32(424,true),selected:eview.getUint32(428,true),backup:eview.getUint32(432,true)};
    e.target=e.target||e.name;
    if(!/^[a-zA-Z0-9_]{1,35}$/.test(e.name)||names.has(e.name))fail('分区名非法或重复');names.add(e.name);
    if(!['INIT','MDL','DL','CODE'].includes(e.type)||e.flag>3||e.selected>1||e.backup>2)fail(`${e.name} 类型或标记未知`);
    if((e.flag&2)&&!e.selected)fail(`${e.name} 必选但未选择`);
    if(e.size){if(e.offset<end||e.size>raw.length-e.offset||e.offset>raw.length)fail(`${e.name} 数据越界`);dataRanges.push([e.offset,e.offset+e.size,e.name]);}
    if(e.type==='INIT'&&e.size)fail('INIT 不应含镜像');
    if(e.type!=='CODE'&&e.backup)fail('loader 不允许备份/擦除标记');
    if(['MDL','DL'].includes(e.type)&&(!e.size||!e.selected||e.address>0xffffffff||e.size>0xffffffff))fail('MDL/DL 缺失或地址超范围');
    if(e.type==='CODE'){
      if(!/^[a-zA-Z0-9_]{1,35}$/.test(e.target)||targets.has(e.target))fail('目标分区重复/非法');targets.add(e.target);
      if(!e.capacity||e.size>e.capacity||(e.selected&&!e.size)||!Number.isSafeInteger(e.address+e.capacity))fail(`${e.name} 容量不匹配`);
      flashRanges.push([e.address,e.address+e.capacity,e.name]);
    }
    entries.push(e);
  }
  disjoint(dataRanges,'镜像');disjoint(flashRanges,'Flash 分区');
  const loaders=entries.filter(e=>e.type==='MDL'||e.type==='DL');if(loaders.map(e=>e.type).join(',')!=='MDL,DL')fail('需要按顺序包含一个 MDL 和一个 DL');
  const writes=entries.filter(e=>e.type==='CODE'&&e.selected&&e.size);
  if(writes.at(-1)?.target!=='mbl')fail('最后一个写入分区必须是 MBL');
  for(const name of ['ap','calibration','factory'])if(!entries.some(e=>e.type==='CODE'&&e.name===name&&e.target===name))fail(`当前下载协议需要 ${name} 分区，此布局尚不支持`);
  if(!writes.some(e=>e.name==='ap'))fail('缺少 ap 镜像');
  const protectedEntries=entries.filter(e=>e.type==='CODE'&&(e.backup===1||['calibration','factory','factory_bak'].includes(e.name)));
  if(protectedEntries.some(e=>e.selected||e.backup===2))fail('保护分区不能来自固件镜像或请求擦除');
  const factoryBak=entries.find(e=>e.name==='factory_bak');
  if(factoryBak&&factoryBak.target!=='factory_bak')fail('factory_bak 目标分区名不一致');
  if(factoryBak&&entries.find(e=>e.name==='factory').capacity!==factoryBak.capacity)fail('factory 与备份容量不一致');
  const digest=await sha256(raw);
  const pkg={project,version,auth,digest,byteLength:raw.length,entries,loaders,writes,protectedEntries,payload:e=>raw.slice(e.offset,e.offset+e.size)};
  pkg.compatibility=matchPackageProfile(pkg,profile);
  if(!inspectOnly&&!pkg.compatibility.supported)fail(pkg.compatibility.reason);
  return pkg;
}
