import {Transport} from './upstream/vendor/esptool-js-0.6.0.js';
// Upstream 0.6.0 retains a writer lock when write rejects. Its disconnect then
// waits forever for that lock, hiding the original device error.
export class EspTransport extends Transport {
 async write(bytes){
  const packet=this.slipWriter(bytes),stream=this.device.writable;
  if(!stream)throw Error('ESP32 串口已关闭');
  const writer=stream.getWriter();
  try{await writer.write(packet);}finally{writer.releaseLock();}
 }
}
