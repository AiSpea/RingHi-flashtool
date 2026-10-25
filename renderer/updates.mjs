export function mountUpdates({native,document,openHelp,onState=()=>{}}){
 const $=id=>document.getElementById(id);let state={phase:'idle'},busy=false;
 function render(value=state){state=value;const active=['checking','downloading','installing'].includes(state.phase);$('update-status').textContent=state.message||'尚未检查更新';$('update-notes').textContent=state.notes||'';$('update-checked').textContent=state.checkedAt?'上次检查：'+new Date(state.checkedAt).toLocaleString():'';$('update-check').disabled=active;$('update-download').hidden=!['available','downloading'].includes(state.phase);$('update-download').disabled=active||busy;$('update-install').hidden=state.phase!=='downloaded';$('update-install').disabled=busy;$('update-progress').hidden=state.phase!=='downloading';$('update-progress').value=state.progress||0;$('update-busy').hidden=!busy;$('update-banner').hidden=!['available','downloading','downloaded'].includes(state.phase);$('update-banner-text').textContent=`RingHi v${state.version||''} 已发布`;onState();
 }
 async function call(action){try{const result=await native.updates(action);if(!result.ok)throw Error(result.error);if(result.data)render(result.data);}catch(e){$('update-status').textContent=e.message;}}
 $('update-check').onclick=()=>call('check');$('update-download').onclick=()=>call('download');$('update-install').onclick=()=>call('install');$('update-banner-open').onclick=openHelp;
 native.onUpdateState?.(render);void call('status');
 return {get locked(){return ['downloading','installing'].includes(state.phase);},setBusy(value){if(busy!==value){busy=value;render();}}};
}
