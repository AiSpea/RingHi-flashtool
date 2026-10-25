// Ported from ToolBox/toolbox/ml307h_account.py at 11c80ab. No automatic retries.
const https = require('node:https');
const BASE = 'https://spark.aicxtek.com:7702';
const ENDPOINTS = {'login':'pclogin','logout':'pclogout','projects':'getauthorize','features':'getfeaturelist','project-keys':'getkey','private-key':'getprivatekey','activation-key':'getactivekey','third-party-key':'get3rdactivekey','activation-report':'activated'};
const projectActions = new Set(['features','project-keys','private-key','activation-key','third-party-key','activation-report']);
const deviceActions = new Set(['activation-key','third-party-key','activation-report']);
function fail(message, code='official_response_invalid') { throw Object.assign(Error(message), {code}); }
function number(v, min=0, max=Number.MAX_SAFE_INTEGER) {if(typeof v==='string' && /^\d{1,16}$/.test(v))v=Number(v);if(!Number.isSafeInteger(v)||v<min||v>max)fail('官方数值响应无效');return v;}
function str(v,max=512){if(typeof v!=='string'||v.length>max)fail('官方文本响应无效');return v;}
function wire(v){if(typeof v!=='string'||! /^[\x20-\x7e]{1,65535}$/.test(v))fail('官方授权材料格式无效');return v;}
function token(v){if(typeof v!=='string'||! /^[\x21-\x7e]{1,4096}$/.test(v))fail('官方会话无效，请重新登录','official_session_expired');return v;}
function prepareRequest(action,payload) {
 if(!Object.hasOwn(ENDPOINTS,action))fail('不支持此官方操作','unsupported_action');
 const required=action==='login'?['username','password','pccode']:['token'];
 if(projectActions.has(action))required.push('project_id');if(deviceActions.has(action))required.push('cpucode');
 if(!payload||typeof payload!=='object'||Object.keys(payload).sort().join()!==required.sort().join())fail('请求字段无效','invalid_request');
 const headers={Client:'PC','User-Agent':'RingHi-Flasher/desktop','Content-Type':'application/json',Accept:'application/json'};let body={};
 if(action==='login'){
  const {username,password}=payload,pccode=typeof payload.pccode==='string'?payload.pccode.replace(/\s/g,''):'';
  if(typeof username!=='string'||!username.trim()||username.length>128||/[\x00-\x1f]/.test(username)||typeof password!=='string'||!password.length||password.length>512)fail('请填写有效账号和密码','invalid_credentials');
  if(!/^[A-Za-z0-9+/]{107}=$/.test(pccode)||Buffer.from(pccode,'base64').length!==80)fail('PC 注册码格式不正确，请完整复制官方工具已登记的注册码','invalid_pccode');
  body={username:username.trim(),password,pccode};
 }else{
  headers.Authorization='Bearer '+token(payload.token);
  if(projectActions.has(action))body.project_id=number(payload.project_id,1,2147483647);
  if(deviceActions.has(action)){
   if(typeof payload.cpucode!=='string'||! /^[\x20-\x7e]{1,4096}$/.test(payload.cpucode))fail('设备产品标识无效','invalid_device_code');body.cpucode=payload.cpucode;
  }
 }
 const method=['projects','logout'].includes(action)?'GET':'POST';
 return {url:BASE+'/api/'+ENDPOINTS[action]+'/',method,headers,body:method==='POST'?JSON.stringify(body):undefined};
}
function normalize(action,status,envelope){
 if(status>=300&&status<400)fail('官方接口重定向已被阻止','official_redirect_blocked');
 if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))fail('官方响应格式无效');
 if(status<200||status>=300||![200,'200'].includes(envelope.code)){
  const msg=String(envelope.msg||'').toLowerCase();
  if(/pc code|pccode|机器码|注册码/.test(msg))fail('官方拒绝 PC 注册码，请核对该电脑的登记状态','pc_not_authorized');
  if(action!=='login'&&([401,403].includes(status)||[401,403,'401','403'].includes(envelope.code)||/token.*(expired|invalid|missing|required)/.test(msg)))fail('官方会话已失效，请重新登录','official_session_expired');
  if(deviceActions.has(action)&&[201,'201'].includes(envelope.code))fail('官方授权额度不足','official_quota_exhausted');
  if(status===405||/method.*not allowed/.test(msg))fail('官方接口不支持本次请求方式，请联系维护人员核对接口','official_method_not_allowed');
  if(action==='login'&&([401,403].includes(status)||/password|username|密码/.test(msg)))fail('官方登录未通过，请核对账号、密码和 PC 注册码','official_login_rejected');
  const suffix=/^\d{1,6}$/.test(String(envelope.code))?'（业务码 '+envelope.code+'）':'';
  fail('官方未接受本次请求'+suffix+'，请核对接口与账号状态；不会自动重试','official_rejected');
 }
 const data=envelope.data;
 if(action==='login')return {token:token(data?.token)};
 if(action==='logout')return {logged_out:true};
 if(action==='activation-report')return {reported:true};
 if(action==='projects'||action==='features'){
  const items=Array.isArray(data)?data:data?.[action];if(!Array.isArray(items)||items.length>5000)fail('官方列表格式无效');
  const seen=new Set();
  return {[action]:items.map(item=>{
   if(action==='features')return {feature_id:str(String(typeof item==='object'?item.feature_id:item),128),name:str(typeof item==='object'?(item.name??item.feature_name??''):'')};
   const id=number(item.project_id,1,2147483647);if(seen.has(id))fail('官方项目编号重复');seen.add(id);
   const total=number(item.authorized_count),remaining=number(item.nonactivated_count,0,total);
   return {project_id:id,name:str(item.name),authorized_count:total,nonactivated_count:remaining,activated_count:total-remaining};
  })};
 }
 if(action==='project-keys')return {AES:wire(data?.AES),rsa_n:wire(data?.rsa_n),rsa_e:wire(data?.rsa_e)};
 if(action==='private-key')return {rsa_d:wire(data?.rsa_d)};
 const result={cdkey:wire(data?.cdkey)};
 if(action==='activation-key'){
  if(![0,1,true,false].includes(data?.has3rd))fail('官方第三方授权标记无效');
  Object.assign(result,{has3rd:Boolean(data.has3rd),surplus:number(data.surplus)});
 }
 return result;
}
function request(options){return new Promise((resolve,reject)=>{
 const req=https.request(options.url,{method:options.method,headers:options.headers},res=>{
  const chunks=[];let size=0;
  res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){res.destroy();reject(Error('官方响应超出大小限制'));}else chunks.push(chunk);});
  res.on('end',()=>{try{if(res.statusCode>=300&&res.statusCode<400)fail('官方接口重定向已被阻止','official_redirect_blocked');resolve({status:res.statusCode,envelope:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{reject(Error('官方响应无效或发生重定向；请求未重试'));}});
  res.on('error',()=>reject(Error('官方连接中断；请求未重试')));
 });
 const timer=setTimeout(()=>req.destroy(Error('timeout')),18000);req.on('close',()=>clearTimeout(timer));
 req.on('error',()=>reject(Error('无法连接归芯官方服务；请求未重试，请手动核对结果')));
 req.end(options.body);
});}
async function perform(action,payload,transport=request){const result=await transport(prepareRequest(action,payload));return normalize(action,result.status,result.envelope);}
module.exports={prepareRequest,normalize,perform};
