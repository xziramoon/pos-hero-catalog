'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('qrlock', {
  submit: (code, amount, force) => ipcRenderer.invoke('qrlock:submit', { code, amount, force }),
  confirmManual: () => ipcRenderer.send('qrlock:confirm-manual'),
  cancel: () => ipcRenderer.send('qrlock:cancel'),
  close: () => ipcRenderer.send('qrlock:close'),
  onState: (cb) => ipcRenderer.on('qrlock:state', (_e, s) => cb(s))
});
