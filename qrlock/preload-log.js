'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('qrlockLog', { today: () => ipcRenderer.invoke('qrlock:log-today') });
