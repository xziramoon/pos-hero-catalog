'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('qrlockPhone', {
  load: () => ipcRenderer.invoke('qrlock:phone-load'),
  save: (p) => ipcRenderer.invoke('qrlock:phone-save', p),
  install: () => ipcRenderer.invoke('qrlock:phone-install'),
  pair: (addr, code) => ipcRenderer.invoke('qrlock:phone-pair', addr, code),
  connect: (addr) => ipcRenderer.invoke('qrlock:phone-connect', addr),
  apps: () => ipcRenderer.invoke('qrlock:phone-apps'),
  openPay: () => ipcRenderer.invoke('qrlock:phone-open-pay'),
  openDisplay: () => ipcRenderer.invoke('qrlock:phone-open-display')
});
