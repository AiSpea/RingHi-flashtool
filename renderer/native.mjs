import {ByteQueue} from './upstream/ml307h/transport.mjs';
export async function nativeCall(action,payload={}){const result=await window.ringhi.nativeBatch(action,payload);if(!result.ok)throw Error(result.error);return result.data;}
export class NativeSerialPort {
 constructor(lease,endpoint){this.lease=lease;this.endpoint=endpoint;this.handle=null;this.readable=null;this.writable=null;}
 getInfo(){return {usbVendorId:this.endpoint.vid,usbProductId:this.endpoint.pid};}
 async open({baudRate}){
  if(this.handle)throw Error('串口已打开');const {handle}=await nativeCall('open',{lease:this.lease,role:'esp',baud:baudRate});this.handle=handle;let canceled=false;
  this.readable=new ReadableStream({pull:async controller=>{try{while(!canceled){const bytes=await nativeCall('read',{handle,timeout:1000});if(canceled)return;if(bytes.length){controller.enqueue(new Uint8Array(bytes));return;}}}catch(e){if(!canceled)controller.error(e);}},cancel:()=>{canceled=true;}});
  this.writable=new WritableStream({write:bytes=>nativeCall('write',{handle,bytes:new Uint8Array(bytes)})});
 }
 async close(){const handle=this.handle;this.handle=null;this.readable=null;this.writable=null;if(handle)await nativeCall('close',{handle});}
 async setSignals(signals){await nativeCall('signals',{handle:this.handle,signals});}
}
export class NativeMlTransport {
 constructor(handle){this.handle=handle;this.queue=new ByteQueue();this.closed=false;this.failed=false;this.pump();}
 static async open(lease,mode){return new NativeMlTransport((await nativeCall('open',{lease,role:'ml',mode,baud:115200})).handle);}
 async pump(){try{while(!this.closed){const bytes=await nativeCall('read',{handle:this.handle,timeout:1000});if(!this.closed)this.queue.push(new Uint8Array(bytes));}}catch(e){if(!this.closed){this.failed=true;this.queue.fail(e);}}}
 read(timeout){return this.queue.read(timeout);}
 async write(bytes){if(this.closed||this.failed)throw Error('ML307H 接口已断开');await nativeCall('write',{handle:this.handle,bytes:new Uint8Array(bytes)});}
 async close(){if(this.closed)return;this.closed=true;this.queue.fail(Error('ML307H 会话已关闭'));await nativeCall('close',{handle:this.handle});}
}
