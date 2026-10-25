import {ESPLoader} from './upstream/vendor/esptool-js-0.6.0.js';
// esptool 4.12 loader.py flash_defl_block retries rejected blocks. Limit our
// recovery to the stub's explicit checksum rejection; never retry ambiguous IO.
export class EspLoader extends ESPLoader {
 async flashDeflBlock(data,seq,timeout){
  for(let attempt=0;;attempt++){
   try{return await super.flashDeflBlock(data,seq,timeout);}
   catch(error){
    const rejected=this.IS_STUB===true&&error.message===`Failed to write compressed data to flash after seq ${seq} failed with status 193,0`;
    if(!rejected||attempt>=2)throw error;
    this.checksumRetries=(this.checksumRetries||0)+1;
    this.info(`ESP32 数据块 ${seq} 校验拒绝，重传 ${attempt+1}/2；仍需最终 MD5 校验`);
    await new Promise(resolve=>setTimeout(resolve,50));
   }
  }
 }
}
