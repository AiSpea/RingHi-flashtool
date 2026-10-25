import {resetEsp} from './esp-reset.mjs';
import {EspLoader as ESPLoader} from './esp-loader.mjs';
import {planFlashEntries} from './upstream/esp-flash-core.mjs';
import {md5} from './upstream/ml307h/protocol.mjs';
import {EspTransport as Transport} from './esp-transport.mjs';
export class EspFlasher{
 constructor({log=()=>{},progress=()=>{},stage=()=>{}}={}){this.log=log;this.progress=progress;this.stage=stage;this.loader=null;this.transport=null;this.chip='';this.mac='';this.busy=false;}
 async connect(expected,baud,selectedPort){
  if(this.busy)throw Error('ESP32 正忙');this.busy=true;
  try{await this.disconnect();const port=selectedPort||await navigator.serial.requestPort();
   const info=port.getInfo();if(info.usbVendorId===0x3563)throw Error('这是 ML307H 端口，请选择 ESP32 端口');
   this.transport=new Transport(port,false);const loader=new ESPLoader({transport:this.transport,baudrate:baud,romBaudrate:115200,terminal:{clean(){},write:this.log,writeLine:this.log},debugLogging:false,enableTracing:false});
   const chip=await loader.main();const actual=loader.chip.CHIP_NAME;
   if(actual!==expected)throw Error(`芯片不匹配：期望 ${expected}，识别到 ${actual}`);
   const mac=String(await loader.chip.readMac(loader)).toUpperCase();
   if(!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)||mac==='00:00:00:00:00:00'||mac==='FF:FF:FF:FF:FF:FF')throw Error('无法读取有效的 ESP32 MAC，未写入固件');
   this.loader=loader;this.chip=chip;this.mac=mac;return chip;
  }catch(e){await this.disconnect();throw e;}finally{this.busy=false;}
 }
 async resetAfterProbe(){if(this.loader)await resetEsp(this.loader,this.transport);}
 async disconnect(){const transport=this.transport;this.loader=null;this.transport=null;this.chip='';this.mac='';if(transport)await transport.disconnect().catch(()=>{});}
 async flash(entries,{deferReset=false}={}){if(this.busy||!this.loader)throw Error('ESP32 尚未连接');const plan=planFlashEntries(entries),chip=this.chip,mac=this.mac;this.busy=true;this.loader.checksumRetries=0;
  let verified=false;
  try{
   const info=this.transport?.device?.getInfo?.()||{};
   if(this.loader.chip?.CHIP_NAME==='ESP32-S3'&&info.usbVendorId===0x303a&&info.usbProductId===0x1001){
    // Reduce each acknowledged compressed block on the board's native USB.
    // This bounds transfer bursts; explicit stub checksum rejections have bounded retries.
    this.loader.FLASH_WRITE_SIZE=4096;this.log('ESP32-S3 USB：使用 4 KiB 分块，逐块确认并最终校验 MD5');
   }
   await this.loader.writeFlash({fileArray:plan.map(p=>({data:p.bytes,address:p.address})),flashSize:'keep',flashMode:'keep',flashFreq:'keep',eraseAll:false,compress:true,calculateMD5Hash:bytes=>md5(bytes),reportProgress:(index,done,total)=>{this.progress(Math.min(99,Math.round((index+(total?done/total:0))/plan.length*100)));this.stage(done>=total?'数据已发送 · 等待写入应答与 MD5 校验':'正在写入');}});verified=true;
   if(!deferReset){this.stage('MD5 校验通过 · 正在复位');await this.resetAfterProbe();}this.progress(100);
   return {chip,mac,firmware:plan.map(p=>`${p.name}@0x${p.address.toString(16)}`).join(', '),checksumRetries:this.loader.checksumRetries||0,verification:'md5-passed',reset:deferReset?'deferred':'requested'};
  }catch(e){e.checksumRetries=this.loader?.checksumRetries||0;if(/failed with status 193,0\b/.test(e.message))e.message='ESP32 数据块校验失败（0xC1），本次未通过。请等待其他芯片完成后，仅补烧 ESP32；若重复出现请检查 USB 线、连接和供电。原始错误：'+e.message;e.verification=verified?'md5-passed':'unconfirmed';e.reset=verified?'unconfirmed':'not-requested';throw e;}finally{if(!deferReset||!verified)await this.disconnect();this.busy=false;}
 }
}
