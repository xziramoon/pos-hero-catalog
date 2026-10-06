'use strict';
// Catalog Hero entry point. main.js touches ONLY this module (try/catch wrapped):
//   registerSchemes()  - synchronously at top level, before app.whenReady
//   init({ app, getMainWindow, userDataDir, config })
//   toggleCatalog()/openCatalog()/shutdown()
// Nothing in here may throw into the caller; everything logs with "[catalog]".
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { protocol, ipcMain, clipboard, net } = require('electron');
const { createConfigStore } = require('./catalog-config');
const { createStore } = require('./catalog-store');
const { createCatalogWindow } = require('./catalog-window');

let inited = false;
let store = null;
let configStore = null;
let cwin = null;
let imagesDir = null;

function registerSchemes() {
  try {
    protocol.registerSchemesAsPrivileged([
      { scheme: 'catimg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
    ]);
  } catch (e) {
    console.warn('[catalog] registerSchemes failed:', e.message);
  }
}

const HASH_RE = /^[A-Za-z0-9_-]{8,128}$/;
const FILE_RE = /^(orig|thumb|full)(-v\d+)?\.jpg$/;

function registerImageProtocol() {
  protocol.handle('catimg', async (req) => {
    try {
      const u = new URL(req.url);
      const hash = u.hostname;
      const file = decodeURIComponent(u.pathname.replace(/^\//, ''));
      if (!HASH_RE.test(hash) || !FILE_RE.test(file)) return new Response('bad request', { status: 400 });
      const p = path.join(imagesDir, hash, file);
      // Phase 4 turns this 404 into a lazy download from R2.
      if (!fs.existsSync(p)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(p).toString());
    } catch (e) {
      console.warn('[catalog] catimg error:', e.message);
      return new Response('error', { status: 500 });
    }
  });
}

// Wrap a handler so it only runs for the catalog window and never throws.
function guarded(handler, fallback) {
  return (event, ...args) => {
    try {
      if (!cwin || !cwin.isOwnSender(event.sender)) return fallback;
      return handler(...args);
    } catch (e) {
      console.warn('[catalog] ipc error:', e.message);
      return fallback;
    }
  };
}

function registerIpc() {
  const h = (ch, fn, fb) => ipcMain.handle('catalog:' + ch, guarded(fn, fb));
  const on = (ch, fn) => ipcMain.on('catalog:' + ch, guarded(fn));

  h('list', () => ({ items: store.list(), meta: store.getMeta() }), { items: [], meta: null });
  h('get', (id) => { const it = store.get(String(id)); return it && !it.deleted ? it : null; }, null);
  h('save', (item) => {
    if (!item || typeof item !== 'object') throw new Error('bad item');
    // Never trust renderer-supplied bookkeeping fields.
    const clean = Object.assign({}, item);
    delete clean.updatedAt; delete clean.updatedBy; delete clean.rev;
    return store.put(clean);
  }, null);
  h('remove', (ids) => { store.remove((Array.isArray(ids) ? ids : [ids]).map(String)); }, undefined);
  h('setFav', (ids, fav) => {
    const list = (ids || []).map((id) => store.get(String(id))).filter((i) => i && !i.deleted)
      .map((i) => Object.assign({}, i, { fav: !!fav }));
    store.putMany(list);
  }, undefined);
  h('moveCategory', (ids, cat) => {
    const c = String(cat || '').trim();
    if (!c) return;
    const list = (ids || []).map((id) => store.get(String(id))).filter((i) => i && !i.deleted)
      .map((i) => Object.assign({}, i, { cat: c }));
    store.putMany(list);
  }, undefined);
  h('getMeta', () => store.getMeta(), null);
  h('setMeta', (patch) => store.setMeta(patch), null);
  h('getConfig', () => configStore.publicConfig(), null);
  h('setConfig', (patch) => {
    if (patch && patch.window) { patch = Object.assign({}, patch); patch.window = Object.assign({}, patch.window); delete patch.window.hotkey; }
    configStore.update(patch);
    return configStore.publicConfig();
  }, null);
  h('copyText', (text) => { clipboard.writeText(String(text == null ? '' : text)); }, undefined);
  h('togglePin', () => cwin.togglePin(), false);
  h('getPinState', () => cwin.getPinState(), false);
  h('getHotkey', () => cwin.getHotkey(), null);
  h('setHotkey', (accel) => {
    const r = cwin.registerHotkey(String(accel || '').trim());
    return Object.assign({}, r, cwin.getHotkey());
  }, { ok: false, error: 'invalid' });
  on('hide', () => cwin.hide());

  // Theme forwarded from the main POS window (renderer/hero-chrome.js selectTheme).
  ipcMain.on('catalog:theme-from-main', (_e, name) => {
    try { if (cwin && typeof name === 'string' && name.length < 40) cwin.setTheme(name); } catch (e) { console.warn('[catalog] theme error', e.message); }
  });
}

function init(opts) {
  if (inited) return;
  try {
    const { app, getMainWindow, userDataDir, config } = opts;
    const dir = process.env.CATALOG_DATA_DIR || path.join(userDataDir, 'catalog');
    fs.mkdirSync(dir, { recursive: true });
    imagesDir = path.join(dir, 'images');
    configStore = createConfigStore(dir);
    configStore.load();
    if (config && Object.keys(config).length) configStore.update(config);
    store = createStore(dir).load();
    cwin = createCatalogWindow({ getMainWindow, configStore });

    registerImageProtocol();
    registerIpc();
    store.on('changed', ({ ids }) => cwin.send('catalog:changed', { ids }));
    cwin.initHotkey();
    app.on('before-quit', () => shutdown());
    inited = true;
    console.log('[catalog] ready, dir =', dir, ', items =', store.list().length);
    devHooks();
  } catch (e) {
    console.warn('[catalog] init failed (POS unaffected):', e && e.stack || e);
  }
}

// Developer helpers (env flags). CATALOG_OPEN_ON_START=1 opens the window at startup;
// CATALOG_SCREENSHOT=<png> captures it after load (CATALOG_SCREENSHOT_JS runs first,
// CATALOG_QUIT_AFTER_SHOT=1 quits afterwards).
function devHooks() {
  if (process.env.CATALOG_OPEN_ON_START !== '1') return;
  setTimeout(() => {
    cwin.show();
    const shot = process.env.CATALOG_SCREENSHOT;
    if (!shot) return;
    setTimeout(async () => {
      try {
        const w = cwin.getWindow();
        w.webContents.on('console-message', (_e, lvl, msg) => console.log('[catalog:renderer]', lvl, msg));
        if (process.env.CATALOG_SCREENSHOT_JS) {
          await w.webContents.executeJavaScript(process.env.CATALOG_SCREENSHOT_JS);
          await new Promise((r) => setTimeout(r, 900));
        }
        const img = await w.webContents.capturePage();
        fs.writeFileSync(shot, img.toPNG());
        console.log('[catalog] screenshot saved', shot);
      } catch (e) { console.warn('[catalog] screenshot failed', e.message); }
      if (process.env.CATALOG_QUIT_AFTER_SHOT === '1') require('electron').app.quit();
    }, 2500);
  }, 800);
}

function openCatalog() { try { if (cwin) cwin.show(); } catch (e) { console.warn('[catalog] open failed', e.message); } }
function toggleCatalog() { try { if (cwin) cwin.toggle(); } catch (e) { console.warn('[catalog] toggle failed', e.message); } }

function shutdown() {
  try { if (cwin) cwin.dispose(); } catch (e) { console.warn('[catalog] dispose failed', e.message); }
  try { if (store) store.flush(); } catch (e) { console.warn('[catalog] flush failed', e.message); }
}

module.exports = { registerSchemes, init, openCatalog, toggleCatalog, shutdown };
