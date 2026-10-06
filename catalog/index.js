'use strict';
// Catalog Hero entry point. main.js touches ONLY this module (try/catch wrapped):
//   registerSchemes()  - synchronously at top level, before app.whenReady
//   init({ app, getMainWindow, userDataDir, config })
//   toggleCatalog()/openCatalog()/shutdown()
// Nothing in here may throw into the caller; everything logs with "[catalog]".
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { protocol, ipcMain, clipboard, net, powerMonitor } = require('electron');
const { createConfigStore } = require('./catalog-config');
const { createStore } = require('./catalog-store');
const { createImages } = require('./catalog-images');
const { createOutbox } = require('./catalog-outbox');
const { createSync } = require('./catalog-sync');
const { createCatalogWindow } = require('./catalog-window');
const { sanitizeItemInput, sanitizeMetaPatch, sanitizeConfigPatch, sanitizeWriteToken } = require('./sanitize');

let inited = false;
let store = null;
let configStore = null;
let cwin = null;
let imagesDir = null;
let images = null;
let outbox = null;
let sync = null;

function registerSchemes() {
  try {
    protocol.registerSchemesAsPrivileged([
      { scheme: 'catimg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
    ]);
  } catch (e) {
    console.warn('[catalog] registerSchemes failed:', e.message);
  }
}

const HASH_RE = /^[0-9a-f]{64}$/; // lowercase sha256 hex
const FILE_RE = /^(orig|thumb|full)(-v(\d+))?\.jpg$/;

function registerImageProtocol() {
  protocol.handle('catimg', async (req) => {
    try {
      const u = new URL(req.url);
      const hash = u.hostname.toLowerCase();
      const file = decodeURIComponent(u.pathname.replace(/^\//, ''));
      const fm = FILE_RE.exec(file);
      if (!HASH_RE.test(hash) || !fm) return new Response('bad request', { status: 400 });
      const variant = fm[1];
      const ver = fm[3] ? parseInt(fm[3], 10) : null;
      let p = images.has(hash, variant, ver) ? images.path(hash, variant, ver) : null;
      // Missing locally: lazy download from R2 (coalesced per file) when sync is configured.
      if (!p && sync) p = await sync.ensureImage(hash, variant, ver);
      if (!p) return new Response('not found', { status: 404 });
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

// Read-only mode (Catalog Key without a write token): refuse edits in the main process too.
function requireEditable() {
  if (sync && !sync.getStatus().canEdit) throw new Error('read-only: no write token');
}

function registerIpc() {
  const h = (ch, fn, fb) => ipcMain.handle('catalog:' + ch, guarded(fn, fb));
  const on = (ch, fn) => ipcMain.on('catalog:' + ch, guarded(fn));

  h('list', () => ({ items: store.list(), meta: store.getMeta() }), { items: [], meta: null });
  h('get', (id) => { const it = store.get(String(id)); return it && !it.deleted ? it : null; }, null);
  h('save', (item) => {
    requireEditable();
    const clean = sanitizeItemInput(item);
    if (clean.id) {
      const cur = store.get(clean.id);
      if (!cur || cur.deleted) throw new Error('unknown item id');
    }
    return store.put(clean);
  }, null);
  h('remove', (ids) => { requireEditable(); store.remove((Array.isArray(ids) ? ids : [ids]).map(String)); }, undefined);
  h('setFav', (ids, fav) => {
    requireEditable();
    const list = (ids || []).map((id) => store.get(String(id))).filter((i) => i && !i.deleted)
      .map((i) => Object.assign({}, i, { fav: !!fav }));
    store.putMany(list);
  }, undefined);
  h('moveCategory', (ids, cat) => {
    requireEditable();
    const c = String(cat || '').trim();
    if (!c) return;
    const list = (ids || []).map((id) => store.get(String(id))).filter((i) => i && !i.deleted)
      .map((i) => Object.assign({}, i, { cat: c }));
    store.putMany(list);
  }, undefined);
  h('getMeta', () => store.getMeta(), null);
  h('setMeta', (patch) => { requireEditable(); return store.setMeta(sanitizeMetaPatch(patch)); }, null);
  h('getConfig', () => configStore.publicConfig(), null);
  h('setConfig', (patch) => {
    const clean = sanitizeConfigPatch(patch);
    configStore.update(clean);
    if (clean.worker && sync) sync.configChanged();
    return configStore.publicConfig();
  }, null);
  // ---- sync (Phase 4)
  h('getSyncStatus', () => sync.getStatus(), null);
  h('testConnection', (cfg) => sync.testConnection(cfg), { ok: false, message: 'ทดสอบไม่สำเร็จ ลองอีกครั้ง' });
  h('initWorker', () => sync.initWorker(), { ok: false, message: 'เริ่มใช้งานคีย์ไม่สำเร็จ ลองอีกครั้ง' });
  h('confirmTarget', () => sync.confirmTarget(), { ok: false });
  h('syncNow', () => { sync.syncNow(); return sync.getStatus(); }, null);
  // The write token lives only in main-process config; it is never returned to the renderer.
  h('set-write-token', (token) => {
    const t = sanitizeWriteToken(token);
    if (t === null) return { ok: false, message: 'write token ต้องยาว 16-256 ตัวอักษร (ตัวอักษรอังกฤษ ตัวเลข หรือสัญลักษณ์ ห้ามเว้นวรรค)' };
    configStore.update({ worker: { writeToken: t } });
    sync.configChanged();
    return { ok: true, hasWriteToken: !!t };
  }, { ok: false });
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
    images = createImages(imagesDir);
    outbox = createOutbox(dir).load();
    sync = createSync({
      store, outbox, images,
      getConfig: () => configStore.get(),
      isVisible: () => !!(cwin && cwin.isVisible()),
      isFocused: () => !!(cwin && cwin.isFocused())
    });
    cwin = createCatalogWindow({ getMainWindow, configStore, onVisibility: (v) => sync && sync.setVisible(v), onFocus: (f) => sync && sync.setFocused(f) });

    registerImageProtocol();
    registerIpc();
    store.on('changed', ({ ids }) => cwin.send('catalog:changed', { ids }));
    sync.on('status', (s) => cwin.send('catalog:sync-status', s));
    try {
      powerMonitor.on('resume', () => sync.syncNow({ soft: true }));
      powerMonitor.on('unlock-screen', () => sync.syncNow({ soft: true }));
    } catch (e) { console.warn('[catalog] powerMonitor unavailable:', e.message); }
    sync.start({ watchNetwork: true }); // also listens for network interface changes (hotspot switch)
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
  try { if (sync) sync.stop(); } catch (e) { console.warn('[catalog] sync stop failed', e.message); }
  try { if (outbox) outbox.flush(); } catch (e) { console.warn('[catalog] outbox flush failed', e.message); }
  try { if (store) store.flush(); } catch (e) { console.warn('[catalog] flush failed', e.message); }
}

module.exports = { registerSchemes, init, openCatalog, toggleCatalog, shutdown };
