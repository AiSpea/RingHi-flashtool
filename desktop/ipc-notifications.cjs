// ipcRenderer.send has no rejection channel. Late notifications are expected
// during shutdown; drop them instead of throwing from an EventEmitter listener.
function registerRendererNotifications(ipcMain,{isTrusted,isClosing,chooseDevice,setBusy,exitSnapshot}){
 for(const [channel,handler,allowClosing] of [['choose-device',chooseDevice,false],['busy',setBusy,false],['exit-snapshot',exitSnapshot,true]]){
  ipcMain.on(channel,(event,payload)=>{
   if(!isTrusted(event)||(!allowClosing&&isClosing()))return;
   handler(payload);
  });
 }
}
module.exports={registerRendererNotifications};
