const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('amountApi', {
  get: () => ipcRenderer.invoke('fortune:amount-get'),
  set: (raw) => ipcRenderer.invoke('fortune:amount-set', raw),
  clear: () => ipcRenderer.invoke('fortune:amount-clear'),
  scan: (text) => ipcRenderer.invoke('fortune:basket-scan', text),
  addItem: (id) => ipcRenderer.invoke('fortune:basket-add', id),
  decItem: (id) => ipcRenderer.invoke('fortune:basket-dec', id)
});
