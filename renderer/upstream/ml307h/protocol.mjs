// AICXTEK download wire format. No hardware or browser dependencies.
export const CMD = Object.freeze({CONNECT:0, START:1, DATA:2, END:3, EXEC:4, ERASE_PART:10, UPDATE_TABLE:14, CHECK_TABLE:15, RESET:16, UID:18, BACKUP_START:32, BACKUP_DATA:33, BACKUP_END:34});
export const bytes = value => value instanceof Uint8Array ? value : new Uint8Array(value);
export const hex = data => Array.from(bytes(data), b => b.toString(16).padStart(2,'0')).join('');
export function concat(...items) { const out=new Uint8Array(items.reduce((n,b)=>n+b.length,0));let at=0;for(const b of items){out.set(b,at);at+=b.length;}return out; }
export function u32(n){if(!Number.isInteger(n)||n<0||n>0xffffffff)throw Error('u32 越界');const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n,true);return b;}
export function crc16(data){let c=0;for(const b of data){c^=b<<8;for(let j=0;j<8;j++)c=((c<<1)^((c&0x8000)?0x1021:0))&65535;}return c;}
export function checksum16(data){let s=0;for(let i=0;i<data.length;i+=2)s+=data[i]+((data[i+1]||0)<<8);s=(s&65535)+(s>>>16);return ~((s&65535)+(s>>>16))&65535;}
export function frame(cmd,payload=new Uint8Array(),crc=false){
  payload=bytes(payload);if(!Number.isInteger(cmd)||cmd<0||cmd>65535||payload.length>65535)throw Error('下载帧长度/命令越界');
  const b=new Uint8Array(payload.length+11),v=new DataView(b.buffer);v.setUint32(0,0x5c6d8e9f,true);v.setUint16(4,cmd,true);v.setUint16(6,payload.length,true);b.set(payload,8);v.setUint16(b.length-3,(crc?crc16:checksum16)(b.subarray(4,b.length-3)),true);b[b.length-1]=0x7e;return b;
}
export class DownloadDecoder {
  constructor(crc=false){this.crc=crc;this.buffer=new Uint8Array();this.invalid=0;}
  feed(chunk){
    this.buffer=concat(this.buffer,bytes(chunk));const out=[];let at=0;
    while(this.buffer.length-at>=11){
      const b=this.buffer,v=new DataView(b.buffer,b.byteOffset+at);if(v.getUint32(0,true)!==0x5c6d8e9f){at++;continue;}
      const n=v.getUint16(6,true)+11;if(b.length-at<n)break;
      const end=at+n,check=v.getUint16(n-3,true);
      if(b[end-1]!==0x7e||check!==(this.crc?crc16:checksum16)(b.subarray(at+4,end-3))){this.invalid++;at++;continue;}
      out.push({cmd:v.getUint16(4,true),payload:b.slice(at+8,end-3)});at=end;
    }
    this.buffer=this.buffer.slice(at);if(this.buffer.length>65546)throw Error('下载接收缓存越界');return out;
  }
}
export function partitionPayload(name,size=0){
  if(!/^[a-zA-Z0-9_]{1,35}$/.test(name)||!Number.isSafeInteger(size)||size<0)throw Error('分区名称或长度无效');
  const b=new Uint8Array(88),v=new DataView(b.buffer);for(let i=0;i<name.length;i++)v.setUint16(i*2,name.charCodeAt(i),true);v.setBigUint64(72,BigInt(size),true);return b;
}
export async function sha256(data){return hex(await globalThis.crypto.subtle.digest('SHA-256',bytes(data)));}

// MD5 is used solely for legacy PKG integrity, never passwords/signatures.
export function md5(input){
  input=bytes(input);const n=Math.ceil((input.length+9)/64)*64,b=new Uint8Array(n);b.set(input);b[input.length]=128;
  const v=new DataView(b.buffer);v.setBigUint64(n-8,BigInt(input.length)*8n,true);
  let h=[0x67452301,0xefcdab89,0x98badcfe,0x10325476];const shifts=[7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
  for(let off=0;off<n;off+=64){let [a,c,d,e]=h;
    for(let i=0;i<64;i++){let f,g;if(i<16){f=(c&d)|(~c&e);g=i;}else if(i<32){f=(e&c)|(~e&d);g=(5*i+1)%16;}else if(i<48){f=c^d^e;g=(3*i+5)%16;}else{f=d^(c|~e);g=(7*i)%16;}
      const k=Math.floor(Math.abs(Math.sin(i+1))*4294967296)>>>0,s=shifts[Math.floor(i/16)*4+i%4],x=(a+f+k+v.getUint32(off+g*4,true))>>>0;
      [a,c,d,e]=[e,(c+((x<<s)|(x>>>(32-s))))>>>0,c,d];}
    h=[(h[0]+a)>>>0,(h[1]+c)>>>0,(h[2]+d)>>>0,(h[3]+e)>>>0];
  }
  const out=new Uint8Array(16),ov=new DataView(out.buffer);h.forEach((x,i)=>ov.setUint32(i*4,x,true));return hex(out);
}
