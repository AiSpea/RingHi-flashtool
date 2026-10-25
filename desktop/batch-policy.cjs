// Exact VID/PID opt-in, limited to this armed session. Never grant ML307H here.
function filters(input){
 if(!Array.isArray(input)||input.length<1||input.length>16)throw Error('请选择 ESP32 下载接口');
 return input.map(f=>{if(!Number.isInteger(f.vendorId)||!Number.isInteger(f.productId)||f.vendorId<1||f.vendorId>65535||f.productId<0||f.productId>65535||f.vendorId===0x3563)throw Error('批量 ESP32 接口配置无效');return {vendorId:f.vendorId,productId:f.productId};});
}
function permits(list,type,device){return type==='serial'&&list.some(f=>f.vendorId===Number(device.vendorId)&&f.productId===Number(device.productId));}
module.exports={filters,permits};
