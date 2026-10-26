const {randomUUID}=require('node:crypto');
const {physicalKey,mapSerial,pairBoards,osSerialRows}=require('./topology.cjs');
const {filters:validateFilters}=require('../batch-policy.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(operation,ms,message){let timer;try{return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]);}finally{clearTimeout(timer);}}
class InputQueue {
 constructor(){this.items=[];this.bytes=0;this.pending=null;this.error=null;this.waiters=new Set();}
 push(data){if(this.error)return;const b=Buffer.from(data);if(!b.length)return;if(this.bytes+b.length>2*1024*1024)return this.fail(Error('设备接收缓冲溢出，已停止'));if(this.pending){const p=this.pending;this.pending=null;clearTimeout(p.timer);p.resolve(b);}else{this.items.push(b);this.bytes+=b.length;}}
 read(ms){if(this.error)return Promise.reject(this.error);if(this.items.length){const b=this.items.shift();this.bytes-=b.length;return Promise.resolve(b);}if(this.pending)return Promise.reject(Error('同一接口不能并发读取'));return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending=null;resolve(Buffer.alloc(0));},ms);this.pending={resolve,reject,timer};});}
 guard(operation,ms,message){if(this.error)return Promise.reject(this.error);return new Promise((resolve,reject)=>{let timer;const finish=(fn,value)=>{clearTimeout(timer);this.waiters.delete(fail);fn(value);},fail=e=>finish(reject,e);this.waiters.add(fail);timer=setTimeout(()=>this.fail(Error(message)),ms);Promise.resolve().then(()=>{if(this.error)throw this.error;return operation();}).then(v=>finish(resolve,v),e=>finish(reject,e));});}
 fail(e){if(this.error)return;this.error=e;for(const fail of [...this.waiters])fail(e);if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(e);this.pending=null;}}
}
function callback(fn){return new Promise((resolve,reject)=>fn(e=>e?reject(e):resolve()));}
class NativeService {
 constructor({usb=require('usb'),SerialPort=require('serialport').SerialPort,rows=osSerialRows,platform=process.platform,downloadTimeout=45000,pollInterval=250,ioTimeout=15000,closeTimeout=5000,serialWait=3000}={}){
  Object.assign(this,{usb,SerialPort,rows,platform,downloadTimeout,pollInterval,ioTimeout,closeTimeout,serialWait});this.config=null;this.leases=new Map();this.handles=new Map();this.epochs=new Map();this.pendingScan=null;
  this.hotplug=d=>{const key=physicalKey({bus:d.busNumber,ports:d.portNumbers||[]});this.epochs.set(key,(this.epochs.get(key)||0)+1);for(const l of this.leases.values())if(l.board.hubKey===key){l.revoked=Error('原板载 Hub 已断开或被替换，任务已中断');for(const id of l.handles)this.handles.get(id)?.q.fail(l.revoked);}};
  usb.usb.on('attach',this.hotplug);usb.usb.on('detach',this.hotplug);
 }
 inventory(){return this.usb.getDeviceList().map(device=>{const d={device,bus:device.busNumber,ports:device.portNumbers||[],vid:device.deviceDescriptor.idVendor,pid:device.deviceDescriptor.idProduct,class:device.deviceDescriptor.bDeviceClass};d.key=physicalKey(d);d.epoch=`${device.deviceAddress}-${this.epochs.get(d.key)||0}`;return d;});}
 async diagnose(config){const filters=validateFilters(config.filters),devices=this.inventory(),rows=await this.rows(this.platform);return {available:true,platform:this.platform,usbDevices:devices.length,serialInterfaces:rows.length,boards:pairBoards(devices,mapSerial(devices,rows,this.platform),filters,config.mode||'dual')};}
 async arm(config){if(this.disposed)throw Error('软件正在关闭');if(this.leases.size)throw Error('请等待当前设备任务释放后再开启新批次');if(!['dual','esp32','ml307h'].includes(config?.mode))throw Error('无效批量模式');this.config={mode:config.mode,filters:validateFilters(config.filters),accepting:true};return this.scan();}
 stop(){if(this.config)this.config.accepting=false;return {stopped:true};}
 async scan(){if(!this.config)return {boards:[],available:true};if(this.pendingScan)return this.pendingScan;this.pendingScan=(async()=>{const rows=await this.rows(this.platform),devices=this.inventory(),serial=mapSerial(devices,rows,this.platform);return {available:true,presentHubIds:devices.filter(d=>d.class===9).map(d=>`${d.key}@${d.epoch}`),boards:pairBoards(devices,serial,this.config.filters,this.config.mode)};})().finally(()=>this.pendingScan=null);return this.pendingScan;}
 async claim(id){if(!this.config?.accepting)throw Error('批次已停止接收');const board=(await this.scan()).boards.find(b=>b.id===id);if(!board?.ready)throw Error(board?.reason||'设备已变化，请重新配对');if([...this.leases.values()].some(l=>l.board.id===id))throw Error('该板已被占用');if(this.disposed||!this.config?.accepting)throw Error('软件正在关闭');const lease=randomUUID();this.leases.set(lease,{board,opening:new Set(),handles:new Set()});return {lease};}
 validate(lease){if(this.disposed)throw Error('软件正在关闭');const l=this.leases.get(lease);if(!l)throw Error('板卡会话已失效');if(l.revoked)throw l.revoked;const hub=this.inventory().find(d=>d.key===l.board.hubKey&&d.class===9);if(!hub||`${hub.key}@${hub.epoch}`!==l.board.id)throw Error('原板载 Hub 已断开或被替换，拒绝继续');return l;}
 async open({lease,role,mode='runtime',baud=115200}){
  if(!['esp','ml'].includes(role)||!['runtime','download'].includes(mode))throw Error('无效设备角色');
  if(!Number.isInteger(baud)||baud<9600||baud>2000000)throw Error('波特率无效');
  const l=this.validate(lease);if((this.config.mode==='esp32'&&role==='ml')||(this.config.mode==='ml307h'&&role==='esp'))throw Error('该芯片不在当前批次范围内');
  if(l.opening.has(role)||[...l.handles].some(id=>this.handles.get(id)?.role===role))throw Error('芯片接口已经打开');l.opening.add(role);
  try{
   const endpoint=l.board[role];if(!endpoint)throw Error('缺少目标芯片');let device;
   if(role==='ml'&&mode==='download'){
    const end=Date.now()+this.downloadTimeout;
    while(Date.now()<end){this.validate(lease);device=this.inventory().find(d=>d.key===endpoint.key&&d.vid===0x3563&&d.pid===0x1000);if(device)break;await sleep(this.pollInterval);}
    if(!device)throw Error('原 Hub 分支未出现 ML307H 下载接口，请保留备份恢复');
   }else device=this.inventory().find(d=>d.key===endpoint.key&&d.vid===(role==='ml'?0x3563:endpoint.vid)&&d.pid===(role==='ml'?0x2000:endpoint.pid));
   if(!device)throw Error('原芯片接口已断开');
   const q=new InputQueue();let resource;
   if(role==='ml'&&mode==='download'&&this.platform==='win32'){
    // The official AICXTEK driver exposes PID 1000 as a virtual COM port.
    // Wait for its PnP registration and re-map the original USB branch;
    // never reuse the runtime AT COM number or select the first Download port.
    const end=Date.now()+this.downloadTimeout;
    while(Date.now()<end){
     const rows=await this.rows(this.platform),current=this.inventory();this.validate(lease);
     const target=current.find(d=>d.key===endpoint.key&&d.vid===0x3563&&d.pid===0x1000);
     if(!target)throw Error('原 ML307H 下载设备已断开，请保留备份恢复');
     const ports=mapSerial(current,rows,this.platform).get(endpoint.key)||[];
     if(ports.length>1)throw Error('原 ML307H 下载串口不唯一，拒绝打开');
     if(ports.length===1){resource=await this.openSerial(ports[0].path,115200,q,{allowUnsupportedDrain:true});break;}
     await sleep(this.pollInterval);
    }
    // Preserve support for boards explicitly bound to WinUSB.
    if(!resource){device=this.inventory().find(d=>d.key===endpoint.key&&d.vid===0x3563&&d.pid===0x1000);this.validate(lease);if(!device)throw Error('原 ML307H 下载设备已断开');resource=await this.openUSB(device.device,0,q);}
   }else if(role==='esp'||(mode==='runtime'&&this.platform==='win32')){
    if(!endpoint.path||endpoint.ambiguousAT)throw Error('未找到唯一的目标串口，请检查 AT 接口和驱动');
    // Re-resolve path immediately before opening; COM numbers can be reused.
    const end=Date.now()+this.serialWait;let candidate;
    do{
     const rows=await this.rows(this.platform),current=this.inventory();this.validate(lease);
     const mapped=mapSerial(current,rows,this.platform).get(endpoint.key)||[];
     const candidates=role==='esp'||mapped.length===1?mapped:mapped.filter(p=>p.iface===4);
     if(candidates.length>1)throw Error('目标串口路径不唯一，拒绝打开');
     if(candidates.length===1){candidate=candidates[0];break;}
     if(Date.now()<end)await sleep(this.pollInterval);
    }while(Date.now()<end);
    if(!candidate)throw Error('目标串口暂未出现，请检查 USB 连接和驱动后重新插入');
    this.validate(lease);resource=await this.openSerial(candidate.path,baud,q,{allowUnsupportedDrain:role==='ml'&&this.platform==='win32'});
   }else resource=await this.openUSB(device.device,mode==='download'?0:4,q);
   try{this.validate(lease);}catch(e){q.fail(e);await bounded(()=>resource.close(),this.closeTimeout,'设备接口关闭超时').catch(()=>{});throw e;}
   const handle=randomUUID();this.handles.set(handle,{...resource,q,lease,role});l.handles.add(handle);return {handle};
  }finally{l.opening.delete(role);}
 }
 async openSerial(path,baud,q,{allowUnsupportedDrain=false}={}){
  const port=new this.SerialPort({path,baudRate:baud,autoOpen:false,lock:true,highWaterMark:65536});
  port.on('data',data=>q.push(data));port.on('error',error=>q.fail(error));port.on('close',()=>q.fail(Error('串口已断开')));
  let openingFailed=false;try{await q.guard(()=>callback(cb=>port.open(e=>{if(openingFailed&&port.isOpen)port.close(()=>{});cb(e);})),this.ioTimeout,'串口打开超时，请重新插入设备');}catch(e){openingFailed=true;if(port.isOpen)port.close(()=>{});throw e;}let drainSupported=true;
  // AICXTEK's virtual COM driver can return ERROR_INVALID_FUNCTION for
  // FlushFileBuffers. WriteFile completion plus the protocol response remains
  // mandatory; never resend bytes, and never ignore write/disconnect errors.
  return {write:async bytes=>{if(q.error)throw q.error;await q.guard(()=>callback(cb=>port.write(bytes,cb)),this.ioTimeout,'串口写入超时，结果未确认，未自动重试');if(drainSupported)try{await q.guard(()=>callback(cb=>port.drain(cb)),this.ioTimeout,'串口发送确认超时，结果未确认，未自动重试');}catch(e){if(!allowUnsupportedDrain||!/^Draining connection \(FlushFileBuffers\): Unknown error code 1$/.test(e.message))throw e;drainSupported=false;}},signals:async signals=>{const set={};if(typeof signals.dataTerminalReady==='boolean')set.dtr=signals.dataTerminalReady;if(typeof signals.requestToSend==='boolean')set.rts=signals.requestToSend;await q.guard(()=>callback(cb=>port.set(set,cb)),this.ioTimeout,'串口控制超时');},close:async()=>{q.fail(Error('会话已关闭'));if(port.isOpen)await bounded(()=>callback(cb=>port.close(cb)),this.closeTimeout,'串口关闭超时，请重新插入设备');}};
 }
 async openUSB(device,number,q){let iface,input,output,claimed=false,opened=false,firstError;
  // usb 2.19.1 Interface.id is a descriptor-array index, but libusb expects
  // bInterfaceNumber. ML307H runtime descriptors are numbered 2, 3, 4.
  const sparse=()=>Number.isInteger(iface?.id)&&iface.id!==number;
  const release=async()=>{if(!claimed)return;claimed=false;await callback(cb=>sparse()?device.__releaseInterface(number,cb):iface.release(true,cb));};
  const cleanup=async()=>{if(input?.pollActive)await new Promise(r=>input.stopPoll(r));await release().catch(()=>{});if(opened){opened=false;device.close();}};
  try{
   device.open();opened=true;iface=device.interfaces.find(i=>i.interfaceNumber===number);if(!iface)throw Error(`缺少 USB 接口 ${number}`);
   const alternates=device.configDescriptor.interfaces.flat().filter(d=>d.bInterfaceNumber===number&&d.bInterfaceClass===255&&d.endpoints.some(e=>(e.bmAttributes&3)===2&&(e.bEndpointAddress&128))&&d.endpoints.some(e=>(e.bmAttributes&3)===2&&!(e.bEndpointAddress&128)));
   if(alternates.length!==1)throw Error('USB Bulk 接口不唯一或不可用');if(sparse())device.__claimInterface(number);else iface.claim();claimed=true;
   if(iface.descriptor.bAlternateSetting!==alternates[0].bAlternateSetting){
    if(sparse()){await callback(cb=>device.__setInterface(number,alternates[0].bAlternateSetting,cb));iface.altSetting=device.configDescriptor.interfaces[iface.id].findIndex(a=>a.bAlternateSetting===alternates[0].bAlternateSetting);iface.refresh();}
    else await callback(cb=>iface.setAltSetting(alternates[0].bAlternateSetting,cb));
   }
   input=iface.endpoints.find(e=>e.direction==='in'&&e.transferType===2);output=iface.endpoints.find(e=>e.direction==='out'&&e.transferType===2);if(!input||!output)throw Error('缺少 Bulk 端点');
   input.on('data',d=>q.push(d));input.on('error',e=>{firstError??=e;q.fail(e);});input.startPoll(2,4096);if(firstError)throw firstError;output.timeout=60000;
   return {write:async bytes=>{if(q.error)throw q.error;const size=output.descriptor.wMaxPacketSize&0x7ff;if(!size)throw Error('USB packetSize 无效');const send=chunk=>new Promise((resolve,reject)=>output.transfer(chunk,(error,actual)=>error?reject(error):actual!==chunk.length?reject(Error('USB 短写，结果未知，禁止重试')):resolve()));for(let i=0;i<bytes.length;i+=size){if(q.error)throw q.error;await send(bytes.subarray(i,i+size));}if(q.error)throw q.error;if(bytes.length%size===0)await send(Buffer.alloc(0));},signals:async()=>{},close:async()=>{q.fail(Error('USB 会话已关闭'));await cleanup();}};
  }catch(e){try{await cleanup();}catch{}const cause=firstError||e;throw new Error(`ML307H USB 接口 ${number} 打开失败（${this.platform==='win32'?'请检查 WinUSB 驱动/接口占用':'请检查 USB 连接/接口占用'}）：${cause.message}`,{cause});}
 }
 handle(id){const h=this.handles.get(id);if(!h)throw Error('接口已关闭');this.validate(h.lease);return h;}
 async read({handle,timeout=1000}){if(!Number.isInteger(timeout)||timeout<1||timeout>60000)throw Error('读取超时参数无效');return new Uint8Array(await this.handle(handle).q.read(timeout));}
 async write({handle,bytes}){if(!(bytes instanceof Uint8Array)||bytes.length>1024*1024)throw Error('写入数据无效');await this.handle(handle).write(Buffer.from(bytes));return true;}
 async signals({handle,signals}){await this.handle(handle).signals(signals||{});return true;}
 async close(handle){const h=this.handles.get(handle);if(!h)return;if(h.closing)return h.closing;h.q.fail(Error('会话已关闭'));h.closing=bounded(()=>h.close(),this.closeTimeout,'设备接口关闭超时，请重新插入设备').finally(()=>{this.handles.delete(handle);this.leases.get(h.lease)?.handles.delete(handle);});return h.closing;}
 async release(lease){const l=this.leases.get(lease);if(!l)return;if(l.releasing)return l.releasing;l.revoked??=Error('板卡会话已结束');for(const id of l.handles)this.handles.get(id)?.q.fail(l.revoked);l.releasing=(async()=>{try{const results=await Promise.allSettled([...l.handles].map(id=>this.close(id)));const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;}finally{this.leases.delete(lease);}})();return l.releasing;}
 async dispose(){this.disposed=true;this.stop();for(const h of this.handles.values())h.q.fail(Error('用户关闭软件，设备任务已停止'));const closing=[...this.handles.keys()].map(id=>this.close(id));this.handles.clear();this.leases.clear();this.usb.usb.removeListener('attach',this.hotplug);this.usb.usb.removeListener('detach',this.hotplug);await Promise.allSettled(closing);}
 async call(action,payload={}){switch(action){case 'diagnose':return this.diagnose(payload);case 'arm':return this.arm(payload);case 'stop':return this.stop();case 'scan':return this.scan();case 'claim':return this.claim(payload.id);case 'open':return this.open(payload);case 'read':return this.read(payload);case 'write':return this.write(payload);case 'signals':return this.signals(payload);case 'close':await this.close(payload.handle);return true;case 'release':await this.release(payload.lease);return true;default:throw Error('无效原生设备操作');}}
}
module.exports={NativeService,InputQueue};
