import {bytes,concat} from './protocol.mjs';
export async function acquireDeviceLease(){
  if(!navigator.locks)throw Error('浏览器不支持设备独占锁，请使用最新版桌面 Chrome');
  let release;const held=new Promise(r=>release=r);
  await new Promise((resolve,reject)=>{navigator.locks.request('ml307h-device',{ifAvailable:true},async lock=>{if(!lock){const e=Error('设备正被另一个 ML307H 工具页面占用。请先在日志或其他烧录页面停止接收/结束连接，再重试。');e.code='DEVICE_BUSY';reject(e);return;}resolve();await held;}).catch(reject);});
  return release;
}
export function deviceAccessError(error){
  if(error.code==='DEVICE_BUSY')return error;
  if(['NotReadableError','NetworkError','InvalidStateError'].includes(error.name)||/claim.*interface|access denied|\bbusy\b/i.test(error.message)){
    const result=new Error('无法独占访问设备接口，可能被其他程序占用或设备已断开。请先关闭其他日志工具、串口助手或烧录软件，再重新连接。');result.cause=error;return result;
  }
  return error;
}
export class ByteQueue {
  constructor(limit=1024*1024){this.chunks=[];this.size=0;this.limit=limit;this.pending=null;this.error=null;}
  push(value){const b=bytes(value);if(!b.length)return;if(this.error)return;if(this.size+b.length>this.limit){this.fail(Error('接收缓存已满，已停止会话'));return;}this.chunks.push(b.slice());this.size+=b.length;if(this.pending){const p=this.pending;this.pending=null;clearTimeout(p.timer);p.resolve(this.take());}}
  take(){const b=this.chunks.shift();this.size-=b.length;return b;}
  read(timeout=3000){if(this.error)return Promise.reject(this.error);if(this.chunks.length)return Promise.resolve(this.take());if(this.pending)return Promise.reject(Error('禁止并发读取同一接口'));return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending=null;reject(Error('设备响应超时；结果未知，不自动重发'));},timeout);this.pending={resolve,reject,timer};});}
  fail(error){this.error=error;if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}}
  clear(){this.chunks=[];this.size=0;}
}
const bounded=(promise,ms,label)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(`${label}超时；结果未知`)),ms);})]).finally(()=>clearTimeout(timer));};
export class UsbTransport {
  constructor(device,iface,input,output){this.device=device;this.iface=iface;this.input=input;this.output=output;this.queue=new ByteQueue();this.closed=false;this.failed=false;this.pump();}
  static async open(device,{pid=0x1000,interfaceNumber=0}={}){
    if(device.vendorId!==0x3563||device.productId!==pid)throw Error('所选 USB 设备模式不匹配');
    try{
      await device.open();if(!device.configuration){const c=device.configurations[0];if(!c)throw Error('设备没有 USB 配置');await device.selectConfiguration(c.configurationValue);}
      const iface=device.configuration.interfaces.find(i=>i.interfaceNumber===interfaceNumber);
      const alt=iface?.alternates.find(a=>a.interfaceClass===255&&a.endpoints.some(e=>e.type==='bulk'&&e.direction==='in')&&a.endpoints.some(e=>e.type==='bulk'&&e.direction==='out'));
      if(!alt)throw Error(`USB 接口 ${interfaceNumber} 不是可用的厂商 Bulk 接口；请检查连接模式/驱动`);
      await device.claimInterface(interfaceNumber);if(iface.alternate.alternateSetting!==alt.alternateSetting)await device.selectAlternateInterface(interfaceNumber,alt.alternateSetting);
      return new UsbTransport(device,interfaceNumber,alt.endpoints.find(e=>e.direction==='in'&&e.type==='bulk'),alt.endpoints.find(e=>e.direction==='out'&&e.type==='bulk'));
    }catch(e){await bounded(device.close().catch(()=>{}),1500,'关闭 USB').catch(()=>{});throw e;}
  }
  async pump(){try{while(!this.closed){const r=await this.device.transferIn(this.input.endpointNumber,4096);if(r.status!=='ok')throw Error(`USB 接收失败：${r.status}`);if(r.data?.byteLength)this.queue.push(new Uint8Array(r.data.buffer,r.data.byteOffset,r.data.byteLength));}}catch(e){if(!this.closed){this.failed=true;this.queue.fail(e);}}}
  async read(timeout){try{return await this.queue.read(timeout);}catch(e){this.failed=true;void this.close();throw e;}}
  async write(data){
    if(this.closed||this.failed)throw Error('USB 会话已失效，需要重新连接');const b=bytes(data),size=this.output.packetSize;
    if(!Number.isInteger(size)||size<1)throw Error('USB packetSize 无效');
    const send=async chunk=>{const r=await bounded(this.device.transferOut(this.output.endpointNumber,chunk),60000,'USB 写入');if(r.status!=='ok'||r.bytesWritten!==chunk.length)throw Error('USB 短写/状态异常，结果未知，不重发');};
    try{for(let at=0;at<b.length;at+=size)await send(b.subarray(at,at+size));if(b.length%size===0)await send(new Uint8Array());}
    catch(e){this.failed=true;void this.close();throw e;}
  }
  async close(){if(this.closed)return;this.closed=true;this.queue.fail(Error('USB 已断开'));await bounded(this.device.close().catch(()=>{}),1500,'关闭 USB').catch(()=>{});}
}
export class SerialTransport {
  constructor(port){this.port=port;this.queue=new ByteQueue(65536);this.reader=port.readable.getReader();this.writer=port.writable.getWriter();this.closed=false;this.pump();}
  static async open(port){const i=port.getInfo();if(i.usbVendorId!==0x3563||i.usbProductId!==0x2000)throw Error('请选择 ML307H 运行模式的 AT 端口');await port.open({baudRate:115200,bufferSize:65536});return new SerialTransport(port);}
  async pump(){try{while(!this.closed){const {value,done}=await this.reader.read();if(done)break;if(value)this.queue.push(value);}if(!this.closed)this.queue.fail(Error('串口已断开'));}catch(e){this.queue.fail(e);}}
  read(timeout){return this.queue.read(timeout);}
  async write(data){if(this.closed)throw Error('串口已断开');await bounded(this.writer.write(data),3000,'串口发送');}
  async close(){if(this.closed)return;this.closed=true;this.queue.fail(Error('串口已关闭'));await this.reader.cancel().catch(()=>{});this.reader.releaseLock();this.writer.releaseLock();await this.port.close().catch(()=>{});}
}
export async function atCommand(transport,command,{timeout=5000,disconnectOK=false}={}){
  if(!/^AT[^\r\n]*$/.test(command))throw Error('AT 命令格式无效');transport.queue.clear();let reply=new Uint8Array();
  await transport.write(new TextEncoder().encode(command+'\r'));const deadline=Date.now()+timeout;
  while(Date.now()<deadline){try{reply=concat(reply,await transport.read(Math.max(1,deadline-Date.now())));}catch(e){if(disconnectOK)return new TextDecoder().decode(reply);throw e;}
    if(reply.length>65536)throw Error('AT 回复过长');const s=new TextDecoder().decode(reply),lines=s.split(/\r\n|\n|\r/);
    if(lines.some(l=>l.trim()==='OK'))return s;
    const error=lines.find(l=>/^(ERROR|\+CME ERROR:|\+CMS ERROR:)/.test(l.trim()));if(error){const e=Error(`设备拒绝命令：${error}`);e.commandRejected=true;throw e;}
  }throw Error('AT 回复超时');
}
export function boardMatches(version,board){return typeof version==='string'&&typeof board==='string'&&version.toLowerCase().split(/[^a-z0-9_-]+/).includes(board.toLowerCase());}
export function parseIdentity(version,imeiReply,board=null){if(board&&!boardMatches(version,board))throw Error(`设备版本未包含目标板型 ${board}，拒绝烧录`);const imei=imeiReply.match(/(?:^|\D)(\d{15})(?=\D|$)/)?.[1];if(!imei)throw Error('无法读取设备 IMEI，拒绝开始');return {version:version.replace(/\bOK\b/g,'').trim(),imei};}

export function versionMatches(reply,expected){
  if(!expected)return false;
  return reply.split(/[\s,;:=\"']+/).some(token=>token===expected);
}
