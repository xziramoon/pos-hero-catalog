'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('qrlockSet', {
  load: () => ipcRenderer.invoke('qrlock:cfg-load'),
  validate: (t) => ipcRenderer.invoke('qrlock:cfg-validate', t),
  save: (c) => ipcRenderer.invoke('qrlock:cfg-save', c)
});
