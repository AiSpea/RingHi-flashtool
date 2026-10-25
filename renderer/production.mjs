import {nativeCall} from './native.mjs';
import {ProductionRunner} from '../core/production.mjs';
// Only fixed commands; never collect SECURITY INFO or persist arbitrary logs.
export class FactoryConsole {
 constructor(io,handle){this.io=io;this.handle=handle;this.tail='';this.decoder=new TextDecoder();}
 static async open({lease},io=nativeCall){const {handle}=await io('open',{lease,role:'esp',baud:115200});return new FactoryConsole(io,handle);}
 async command(command,accept,timeout=12000){
  this.tail='';await this.io('write',{handle:this.handle,bytes:new TextEncoder().encode(command+'\n')});
  const end=Date.now()+timeout;
  while(Date.now()<end){const bytes=await this.io('read',{handle:this.handle,timeout:Math.min(1000,Math.max(1,end-Date.now()))});this.tail+=this.decoder.decode(new Uint8Array(bytes),{stream:true});
   if(this.tail.length>65536)throw Error('控制台响应超出长度限制');
   let i;while((i=this.tail.indexOf('\n'))>=0){const line=this.tail.slice(0,i).trim();this.tail=this.tail.slice(i+1);const result=accept(line);if(result!==undefined)return result;}
  }return null;
 }
 status(){return this.command('FACTORY STATUS',line=>{try{const v=JSON.parse(line);if(v&&typeof v.active==='boolean'&&typeof v.done==='boolean'&&Object.hasOwn(v,'report'))return v;}catch{}});}
 retest(){return this.command('FACTORY RETEST',line=>line.startsWith('Factory scan armed')?'armed':line.startsWith('Refused:')?'refused':undefined);}
 async close(){if(this.handle){const handle=this.handle;this.handle=null;await this.io('close',{handle});}}
}
export const createProduction=change=>new ProductionRunner({connect:context=>FactoryConsole.open(context),change});
