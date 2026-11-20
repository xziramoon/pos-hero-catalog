'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('qrlockLink', {
  getInfo: () => ipcRenderer.invoke('qrlock:link-info'),
  firewall: () => ipcRenderer.invoke('qrlock:link-firewall')
});
