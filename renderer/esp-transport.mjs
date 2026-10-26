import {Transport} from './upstream/vendor/esptool-js-0.6.0.js';
// Upstream 0.6.0 retains a writer lock when write rejects. Its disconnect then
// waits forever for that lock, hiding the original device error.
export class EspTransport extends Transport {
 // Propagate a disconnected stream to protocol waits instead of waiting for
 // the loader's long MD5 timeout. Each read owns/releases exactly one reader.
 async readLoop(){
  while(this.device.readable&&!this.readError){const reader=this.device.readable.getReader();this.reader=reader;
   try{const {value,done}=await reader.read();if(done){this.readError??=Error('ESP32 串口已关闭');break;}if(value?.length)this.buffer=this.appendArray(this.buffer,Uint8Array.from(value));}
   catch(e){if(['BufferOverrunError','FramingError','BreakError','ParityError'].includes(e.name))continue;this.readError=e;break;}
   finally{reader.releaseLock();if(this.reader===reader)this.reader=undefined;}
  }
 }
 async connect(...args){this.readError=null;return super.connect(...args);}
 async read(timeout){
  let packet=null,escaped=false;const end=Date.now()+timeout;
  while(Date.now()<end){
   if(this.readError)throw this.readError;
   if(!this.buffer.length){await new Promise(r=>setTimeout(r,1));continue;}
   const bytes=this.buffer;this.buffer=new Uint8Array(0);
   for(let i=0;i<bytes.length;i++){const byte=bytes[i];
    if(packet===null){if(byte!==this.SLIP_END){this.detectPanicHandler(bytes);throw Error(`Invalid head of packet (0x${byte.toString(16)}): Possible serial noise or corruption.`);}packet=[];}
    else if(escaped){escaped=false;if(byte===this.SLIP_ESC_END)packet.push(this.SLIP_END);else if(byte===this.SLIP_ESC_ESC)packet.push(this.SLIP_ESC);else throw Error('Invalid SLIP escape');}
    else if(byte===this.SLIP_ESC)escaped=true;
    else if(byte===this.SLIP_END){if(i+1<bytes.length)this.buffer=this.appendArray(bytes.slice(i+1),this.buffer);return Uint8Array.from(packet);}
    else packet.push(byte);
   }
  }
  throw Error('No serial data received.');
 }
 async disconnect(){this.readError??=Error('ESP32 串口已关闭');return super.disconnect();}
 async write(bytes){
  const packet=this.slipWriter(bytes),stream=this.device.writable;
  if(!stream)throw Error('ESP32 串口已关闭');
  const writer=stream.getWriter();
  try{await writer.write(packet);}finally{writer.releaseLock();}
 }
}
