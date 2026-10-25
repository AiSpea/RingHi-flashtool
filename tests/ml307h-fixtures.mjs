import {crc16,md5} from '../renderer/upstream/ml307h/protocol.mjs';
export function packageFixture(auth=2,{project="e_badge",board="test0817",omit=[]}={}){
  const specs=[['mdl','MDL',1,0],['dl','DL',1,0],['ap','CODE',1,0],['ap_extend','CODE',1,0],['ap_extflash','CODE',1,0],['calibration','CODE',0,1],['factory','CODE',0,0],['factory_bak','CODE',0,0],['normdata','CODE',0,2],['mbl','CODE',1,0]].filter(([name])=>!omit.includes(name));
  const end=136+specs.length*464,b=new Uint8Array(end+specs.filter(e=>e[2]).length*32),v=new DataView(b.buffer),enc=new TextEncoder();
  v.setUint32(0,0x5c6d8e9f,true);v.setUint32(4,1,true);v.setBigUint64(8,BigInt(b.length),true);b.set(enc.encode(project),16);b.set(enc.encode('v1.2.3'),48);v.setUint32(80,136,true);v.setUint32(84,specs.length,true);v.setUint32(88,auth,true);
  let data=end;specs.forEach(([name,type,selected,backup],i)=>{const off=136+i*464;b.set(enc.encode(name),off);b.set(enc.encode(type),off+32);b.set(enc.encode(name+'.bin'),off+64);b.set(enc.encode(name),off+352);v.setBigUint64(off+320,BigInt(selected?data:0),true);v.setBigUint64(off+328,BigInt(selected?32:0),true);v.setBigUint64(off+336,BigInt(type==='CODE'?0x11000000+i*4096:0x20003000+i*0x8000),true);v.setBigUint64(off+344,32n,true);v.setUint32(off+428,selected,true);v.setUint32(off+432,backup,true);if(selected){b.fill(i+1,data,data+32);if(name==='ap')b.set(enc.encode(board+' v1.2.3'),data);data+=32;}});
  if(auth===2)v.setUint32(92,crc16(b.subarray(136)),true);if(auth===1)b.set(enc.encode(md5(b.subarray(136))),96);return b;
}
