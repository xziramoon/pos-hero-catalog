'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const inv = (ch, ...a) => ipcRenderer.invoke('catalog:' + ch, ...a);
const sub = (ch, cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on('catalog:' + ch, fn);
  return () => ipcRenderer.removeListener('catalog:' + ch, fn);
};

contextBridge.exposeInMainWorld('catalogAPI', {
  list: () => inv('list'),
  get: (id) => inv('get', id),
  save: (item) => inv('save', item),
  remove: (ids) => inv('remove', ids),
  setFav: (ids, fav) => inv('setFav', ids, fav),
  moveCategory: (ids, cat) => inv('moveCategory', ids, cat),
  getMeta: () => inv('getMeta'),
  setMeta: (patch) => inv('setMeta', patch),
  copyText: (text) => inv('copyText', text),
  hide: () => ipcRenderer.send('catalog:hide'),
  togglePin: () => inv('togglePin'),
  getPinState: () => inv('getPinState'),
  getConfig: () => inv('getConfig'),
  setConfig: (patch) => inv('setConfig', patch),
  getHotkey: () => inv('getHotkey'),
  setHotkey: (accel) => inv('setHotkey', accel),
  onChanged: (cb) => sub('changed', cb),
  onTheme: (cb) => sub('theme', cb),
  onFocusSearch: (cb) => sub('focus-search', cb),
  // Phase 4 (sync)
  getSyncStatus: () => inv('getSyncStatus'),
  onSyncStatus: (cb) => sub('sync-status', cb),
  testConnection: (cfg) => inv('testConnection', cfg),
  initWorker: () => inv('initWorker'),
  syncNow: () => inv('syncNow'),
  setWriteToken: (token) => inv('set-write-token', token)
});
