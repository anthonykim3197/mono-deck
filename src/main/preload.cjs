const {contextBridge,ipcRenderer}=require('electron');
const invoke=async(name,...args)=>{try{return await ipcRenderer.invoke(`deck:${name}`,...args);}catch(error){throw new Error(String(error.message||error).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,''));}};
contextBridge.exposeInMainWorld('deck',{
  previewProfileDeletion:id=>invoke('previewProfileDeletion',id),deleteProfile:(id,hash)=>invoke('deleteProfile',id,hash),
  getState:()=>invoke('getState'),navigatePage:(operation,id)=>invoke('navigatePage',operation,id),saveConfig:config=>invoke('saveConfig',config),readOnboardBank:layer=>invoke('readOnboardBank',layer),
  saveZeroPreset:(entries,options)=>invoke('saveZeroPreset',entries,options),applyZeroPreset:(layer,hash)=>invoke('applyZeroPreset',layer,hash),importZeroPreset:layer=>invoke('importZeroPreset',layer),
  refreshDevice:()=>invoke('refreshDevice'),backupDevice:()=>invoke('backupDevice'),provisionDevice:layers=>invoke('provisionDevice',layers),restoreDevice:layers=>invoke('restoreDevice',layers),
  testAction:action=>invoke('testAction',action),exportConfig:()=>invoke('exportConfig'),importConfig:()=>invoke('importConfig'),setLogin:enabled=>invoke('setLogin',enabled),openDataFolder:()=>invoke('openDataFolder'),
  previewPreset:source=>invoke('previewPreset',source),addPreset:(token,ids)=>invoke('addPreset',token,ids),exportPreset:ids=>invoke('exportPreset',ids),inspectObs:()=>invoke('inspectObs'),saveObsTargets:targets=>invoke('saveObsTargets',targets),
  runMacro:(action,options)=>invoke('runMacro',action,options),stopMacro:()=>invoke('stopMacro'),startRecording:options=>invoke('startRecording',options),stopRecording:()=>invoke('stopRecording'),
  getCursor:delayMs=>invoke('getCursor',delayMs),getPixel:(x,y,monitorId)=>invoke('getPixel',x,y,monitorId),getMonitors:()=>invoke('getMonitors'),
  getLightingCapabilities:()=>invoke('getLightingCapabilities'),setLighting:settings=>invoke('setLighting',settings),
  openTestPad:()=>invoke('openTestPad'),readOnboard:()=>invoke('readOnboard'),planOnboard:entries=>invoke('planOnboard',entries),uploadOnboard:(entries,options)=>invoke('uploadOnboard',entries,options),restoreAppSlots:slots=>invoke('restoreAppSlots',slots),
  onEvent:callback=>{const listener=(_event,data)=>callback(data);ipcRenderer.on('deck:event',listener);return()=>ipcRenderer.removeListener('deck:event',listener);}
});
