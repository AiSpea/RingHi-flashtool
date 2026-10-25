import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeSerialPort} from '../renderer/native.mjs';
test('native ESP stream keeps an outstanding read alive across idle timeouts',async()=>{
 let polls=0,closed=false;
 globalThis.window={ringhi:{nativeBatch:async action=>{
  if(action==='open')return {ok:true,data:{handle:'test'}};
  if(action==='close'){closed=true;return {ok:true};}
  if(action==='read'){polls++;if(polls<=3)return {ok:true,data:[]};if(polls===4)return {ok:true,data:[0xc0,1,0xc0]};return new Promise(()=>{});}
  throw Error('unexpected operation');
 }}};
 const port=new NativeSerialPort('lease',{});await port.open({baudRate:115200});const reader=port.readable.getReader();let timer;
 try{const result=await Promise.race([reader.read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('idle timeout incorrectly stopped serial reads')),200);})]);assert.deepEqual([...result.value],[0xc0,1,0xc0]);assert(polls>=4);}finally{clearTimeout(timer);await reader.cancel();await port.close();delete globalThis.window;}
 assert(closed);
});
