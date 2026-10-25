const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('ringhi',Object.freeze({
 platform:process.platform,
 updates:action=>ipcRenderer.invoke('app-update',action),
 onUpdateState:callback=>{const handler=(_event,state)=>callback(state);ipcRenderer.on('update-state',handler);return()=>ipcRenderer.removeListener('update-state',handler);},
 onPrepareExit:callback=>{const handler=(_event,id)=>{let records=[];try{records=callback()||[];}catch{}ipcRenderer.send('exit-snapshot',{id,records});};ipcRenderer.on('prepare-exit',handler);return()=>ipcRenderer.removeListener('prepare-exit',handler);},
 backupFiles:(action,payload)=>ipcRenderer.invoke('backup-files',action,payload),
 defaultAccount:(action,payload)=>ipcRenderer.invoke('default-account',action,payload),
 batchCsv:(action,payload)=>ipcRenderer.invoke('batch-csv',action,payload),
 appInfo:()=>ipcRenderer.invoke('app-info'),
 nativeBatch:(action,payload)=>ipcRenderer.invoke('native-batch',action,payload),
 batchAccess:filters=>ipcRenderer.invoke('batch-access',filters),
 official:(action,payload)=>ipcRenderer.invoke('official',action,payload),
 saveJob:record=>ipcRenderer.invoke('save-job',record),
 history:()=>ipcRenderer.invoke('history'),
 exportHistory:()=>ipcRenderer.invoke('export-history'),
 chooseDevice:id=>ipcRenderer.send('choose-device',id),
 onDevices:callback=>{const handler=(_event,data)=>callback(data);ipcRenderer.on('devices',handler);return()=>ipcRenderer.removeListener('devices',handler);},
 setBusy:busy=>ipcRenderer.send('busy',Boolean(busy))
}));
