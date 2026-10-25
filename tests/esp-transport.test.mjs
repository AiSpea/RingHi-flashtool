import test from 'node:test';
import assert from 'node:assert/strict';
import {EspTransport} from '../renderer/esp-transport.mjs';
test('write rejection releases the real stream lock and disconnect terminates without retry',async()=>{
 let writes=0,closes=0;const error=Error('native write disconnected');
 const device={readable:null,writable:new WritableStream({write(){writes++;throw error;}}),async close(){closes++;}};
 const transport=new EspTransport(device,false);
 await assert.rejects(transport.write(new Uint8Array([0xc0,0xdb])),e=>e===error);
 assert.equal(device.writable.locked,false);assert.equal(writes,1);
 let timer;try{await Promise.race([transport.disconnect(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('disconnect hung')),1000);})]);}finally{clearTimeout(timer);}
 assert.equal(closes,1);
});
test('write preserves SLIP escaping and releases lock on success',async()=>{
 let packet;const device={writable:new WritableStream({write(bytes){packet=bytes;}})};
 const transport=new EspTransport(device,false);await transport.write(new Uint8Array([0xc0,0xdb,1]));
 assert.deepEqual(Array.from(packet),[0xc0,0xdb,0xdc,0xdb,0xdd,1,0xc0]);assert.equal(device.writable.locked,false);
});
