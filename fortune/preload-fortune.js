const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fortuneApi', {
  getState: () => ipcRenderer.invoke('fortune:get-state'),
  setSettings: (next) => ipcRenderer.invoke('fortune:set-settings', next),
  testPrint: () => ipcRenderer.invoke('fortune:test-print'),
  exportReport: () => ipcRenderer.invoke('fortune:export-report'),
  listPrinters: () => ipcRenderer.invoke('fortune:list-printers'),
  promoSearch: (q) => ipcRenderer.invoke('fortune:promo-search', q),
  couponCheck: (code) => ipcRenderer.invoke('fortune:coupon-check', code),
  couponUse: (code) => ipcRenderer.invoke('fortune:coupon-use', code),
  onState: (cb) => ipcRenderer.on('fortune:state', (_e, s) => cb(s))
});
