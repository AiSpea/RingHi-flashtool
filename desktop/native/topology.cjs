const {execFile}=require('node:child_process');
const {promisify}=require('node:util');const exec=promisify(execFile);
const path=require('node:path');
const physicalKey=d=>`${d.bus}:${d.ports.join('.')}`;
const routeKey=d=>d.ports.join('.');
function windowsRows(rows){return (Array.isArray(rows)?rows:[rows]).filter(Boolean).flatMap(row=>{
 const match=String(row.instance||'').match(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i);
 const locations=Array.isArray(row.locations)?row.locations:[row.locations];
 const location=locations.find(x=>typeof x==='string'&&/#USB\(\d+\)/i.test(x));
 if(!match||!location||!/^COM\d+$/i.test(row.path||''))return [];
 return [{path:row.path,vid:parseInt(match[1],16),pid:parseInt(match[2],16),ports:[...location.matchAll(/#USB\((\d+)\)/ig)].map(m=>Number(m[1])),controller:location.split(/#USB\(/i)[0],iface:row.iface==null?null:Number(row.iface)}];
 });}
function macRows(roots){const result=[],seen=new Set();
 function walk(node,device=null,iface=null){
  if(node.idVendor!=null&&node.idProduct!=null&&node.locationID!=null){const location=Number(node.locationID)>>>0;device={vid:Number(node.idVendor),pid:Number(node.idProduct),bus:location>>>24,ports:[]};for(let shift=20;shift>=0;shift-=4){const p=(location>>>shift)&15;if(p)device.ports.push(p);}iface=null;}
  if(node.bInterfaceNumber!=null)iface=Number(node.bInterfaceNumber);
  if(device&&node.IOCalloutDevice&&!seen.has(node.IOCalloutDevice)){seen.add(node.IOCalloutDevice);result.push({...device,path:node.IOCalloutDevice,iface});}
  for(const child of node.IORegistryEntryChildren||[])walk(child,device,iface);
 }
 for(const root of roots||[])walk(root);return result;
}
function mapSerial(devices,rows,platform){const map=new Map();
 for(const row of rows){
  // Windows libusb bus numbers are not PnP controller IDs. Require a unique
  // full port route across controllers before joining either representation.
  const peers=rows.filter(r=>r.vid===row.vid&&r.pid===row.pid&&routeKey(r)===routeKey(row));
  if(platform==='win32'&&new Set(peers.map(r=>r.controller)).size!==1)continue;
  const matches=devices.filter(d=>d.vid===row.vid&&d.pid===row.pid&&routeKey(d)===routeKey(row)&&(platform!=='darwin'||d.bus===row.bus));
  if(matches.length!==1)continue;
  const id=physicalKey(matches[0]);if(!map.has(id))map.set(id,[]);if(!map.get(id).some(p=>p.path===row.path))map.get(id).push(row);
 }
 return map;
}
function pairBoards(devices,serial,filters,mode='dual'){
 const hubs=new Map(devices.filter(d=>d.class===9).map(d=>[physicalKey(d),d]));const groups=new Map();
 for(const d of devices){if(d.ports.length<1)continue;const isML=d.vid===0x3563&&[0x1000,0x2000].includes(d.pid),isESP=filters.some(f=>d.vid===f.vendorId&&d.pid===f.productId);if(!isML&&!isESP)continue;
  const hubKey=physicalKey({...d,ports:d.ports.slice(0,-1)});if(!groups.has(hubKey))groups.set(hubKey,{hubKey,esp:[],ml:[]});groups.get(hubKey)[isML?'ml':'esp'].push(d);
 }
 return [...groups.values()].map(g=>{
  const hub=hubs.get(g.hubKey),esp=g.esp[0],ml=g.ml[0];let reason='';
  if(!hub)reason='未发现独立板载 Hub，无法证明是同一块板';
  else if(g.esp.length>1||g.ml.length>1)reason='同一 Hub 下存在多个同类芯片，无法唯一配对';
  else if(mode!=='ml307h'&&!esp)reason='等待 ESP32 接口';
  else if(mode!=='esp32'&&!ml)reason='等待 ML307H 接口';
  else if(mode!=='esp32'&&ml?.pid!==0x2000)reason='ML307H 已在下载模式：请用原备份恢复，不能作为新板自动烧录';
  const espPorts=esp?serial.get(physicalKey(esp))||[]:[],mlPorts=ml?serial.get(physicalKey(ml))||[]:[];
  if(!reason&&mode!=='ml307h'&&espPorts.length!==1)reason=espPorts.length?'ESP32 串口不唯一':'等待 ESP32 串口驱动 / 物理路径映射';
  const at=mlPorts.length===1?mlPorts[0]:mlPorts.filter(p=>p.iface===4).length===1?mlPorts.find(p=>p.iface===4):null;
  return {id:hub?`${g.hubKey}@${hub.epoch}`:`unpaired:${g.hubKey}`,hubKey:g.hubKey,label:`Hub ${g.hubKey}`,ready:!reason,reason,esp:esp?{key:physicalKey(esp),pid:esp.pid,vid:esp.vid,path:espPorts.length===1?espPorts[0].path:null}:null,ml:ml?{key:physicalKey(ml),pid:ml.pid,path:at?.path||null,ambiguousAT:mlPorts.length>1&&!at}:null};
 });
}
async function osSerialRows(platform=process.platform){
 if(platform==='win32'){let stdout;try{({stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'windows-ports.ps1').replace(/app\.asar([\\/])/,'app.asar.unpacked$1')],{windowsHide:true,timeout:20000,maxBuffer:4*1024*1024,encoding:'utf8'}));}catch(e){throw Error(e.killed?'Windows 端口枚举超时（20 秒），请检查设备驱动':`Windows 端口枚举失败：${String(e.stderr||e.message).trim()}`);}return windowsRows(JSON.parse(stdout.replace(/^\uFEFF/,'').trim()||'[]'));}
 // -l includes descendant properties (IOCalloutDevice and bInterfaceNumber);
 // -c alone emits properties only for matching USB device nodes.
 if(platform==='darwin'){const {stdout}=await exec('/usr/sbin/ioreg',['-a','-l','-r','-c','IOUSBHostDevice'],{timeout:10000,maxBuffer:32*1024*1024});if(!stdout.trim())return [];const {parse}=await import('plist');return macRows(parse(stdout));}
 throw Error('批量原生拓扑仅支持 Windows 和 macOS');
}
module.exports={physicalKey,windowsRows,macRows,mapSerial,pairBoards,osSerialRows};
