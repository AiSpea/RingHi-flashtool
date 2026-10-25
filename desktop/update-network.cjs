const {Readable}=require('node:stream');
// Electron net.fetch rejects manual redirects. Preserve the update service's
// per-hop URL validation while retaining Chromium's system proxy support.
function updateFetch(net,url,{headers,signal}={}){
 return new Promise((resolve,reject)=>{
  const request=net.request({url,method:'GET',headers,redirect:'manual',credentials:'omit',useSessionCookies:false});
  let settled=false,response;
  const fail=error=>{if(!settled){settled=true;reject(error);}else response?.destroy(error);};
  const abort=()=>{fail(signal?.reason||new Error('更新请求已取消'));request.abort();};
  const clean=()=>signal?.removeEventListener('abort',abort);
  request.on('error',fail);request.on('close',clean);
  request.on('redirect',(status,_method,location)=>{
   if(settled)return;settled=true;clean();
   resolve(new Response(null,{status,headers:{location}}));
   // Do not follow here: UpdateService validates the next HTTPS destination.
  });
  request.on('response',incoming=>{
   if(settled){incoming.destroy();return;}
   response=incoming;settled=true;
   const h=new Headers();for(const [key,value] of Object.entries(incoming.headers))for(const v of Array.isArray(value)?value:[value])h.append(key,v);
   incoming.on('aborted',()=>incoming.destroy(new Error('更新下载连接中断')));
   resolve(new Response(Readable.toWeb(incoming),{status:incoming.statusCode,headers:h}));
  });
  if(signal?.aborted){abort();return;}
  signal?.addEventListener('abort',abort,{once:true});request.end();
 });
}
module.exports={updateFetch};
