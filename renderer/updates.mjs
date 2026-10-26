export function mountUpdates({native,document,onState=()=>{}}){
 const $=id=>document.getElementById(id);let state={phase:'idle'},busy=false,applying=false,error='';
 function render(value=state){
  state=value;const active=applying||['checking','downloading','installing'].includes(state.phase),offer=Boolean(state.version)&&state.phase!=='current';
  $('update-status').textContent=error||state.message||'尚未检查更新';$('update-notes').textContent=state.notes||'';$('update-checked').textContent=state.checkedAt?'上次检查：'+new Date(state.checkedAt).toLocaleString():'';
  $('update-check').disabled=active;$('update-apply').hidden=!offer;$('update-apply').disabled=active||busy;$('update-apply').textContent=state.phase==='downloaded'?'安装更新':'立即更新';
  $('update-progress').hidden=state.phase!=='downloading';$('update-progress').value=state.progress||0;$('update-busy').hidden=!busy;
  $('sidebar-update').hidden=!offer;$('sidebar-update-button').disabled=active||busy;$('sidebar-update-version').textContent=`新版本 v${state.version||''}`;
  const label=state.phase==='downloading'?`正在下载 · ${state.progress||0}%`:state.phase==='installing'?'正在安装…':applying?'准备更新…':state.phase==='checking'?'正在检查…':error?'重试更新':state.phase==='downloaded'?'安装更新':'立即更新';
  $('sidebar-update-action').textContent=label;
  $('sidebar-update-hint').textContent=error|| (busy?'请先停止接收并等待任务完成':state.phase==='downloading'?(native.platform==='darwin'?'下载完成后打开系统安装器':'下载完成后自动安装'):state.phase==='installing'?'正在保存记录并退出':state.phase==='downloaded'?'已下载，点击安装':native.platform==='darwin'?'自动下载后打开系统安装器':'点击后下载、覆盖并重新打开');
  $('sidebar-update-progress').hidden=state.phase!=='downloading';$('sidebar-update-progress').value=state.progress||0;onState();
 }
 async function request(action){const result=await native.updates(action);if(!result.ok)throw Error(result.error);if(result.data)render(result.data);return result.data;}
 async function call(action){try{error='';await request(action);}catch(e){error=e.message;render();}}
 async function apply(){
  if(applying||busy||['checking','downloading','installing'].includes(state.phase))return;
  applying=true;error='';render();
  try{
   if(!['available','downloaded'].includes(state.phase))await request('check');
   if(state.phase==='available'){const downloaded=await request('download');if(downloaded?.phase!=='downloaded'){error=downloaded?.message||'更新未下载完成，请重试';return;}}
   if(state.phase!=='downloaded')return;
   if(busy)throw Error('任务正在执行，更新已下载，请结束任务后点击安装');
   await request('install');
  }catch(e){error=e.message;}finally{applying=false;render();}
 }
 $('update-check').onclick=()=>call('check');$('update-apply').onclick=apply;$('sidebar-update-button').onclick=apply;
 native.onUpdateState?.(value=>{error='';render(value);});void call('status');
 return {get locked(){return applying||['downloading','installing'].includes(state.phase);},setBusy(value){if(busy!==value){busy=value;render();}}};
}
