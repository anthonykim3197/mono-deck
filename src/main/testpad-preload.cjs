const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('testpad',{start:rect=>ipcRenderer.invoke('testpad:start',rect),finish:evidence=>ipcRenderer.invoke('testpad:finish',evidence),close:()=>ipcRenderer.invoke('testpad:close')});
