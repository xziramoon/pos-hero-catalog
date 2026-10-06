'use strict';
// Catalog Hero entry point. main.js touches ONLY this module (try/catch wrapped):
//   registerSchemes()  - synchronously at top level, before app.whenReady
//   init({ app, getMainWindow, userDataDir, config })
//   toggleCatalog()/openCatalog()/shutdown()
// Nothing in here may throw into the caller; everything logs with "[catalog]".
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { protocol, ipcMain, clipboard, net, powerMonitor, dialog } = require('electron');
const { createConfigStore } = require('./catalog-config');
const { createStore } = require('./catalog-store');
const { createImages, HASH_RE: IMG_HASH_RE } = require('./catalog-images');
const { saveImageForItem, removeImageForItem, thaiSaveError } = require('./catalog-image-save');
const { createOutbox } = require('./catalog-outbox');
const { createSync } = require('./catalog-sync');
const migrate = require('./catalog-migrate');
const { createBackup } = require('./catalog-backup');
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
let backup = null;
let dataDir = null;
let appRef = null;
const legacyAllowed = new Set(); // legacy files the renderer may import (auto-detected or picked in the open dialog)
let importState = { running: false };

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
  // Phase 3b: image editor. The only path that may set Item.image (sanitizeItemInput forbids it).
  // Returns the item, or { error: <Thai message> } so the UI can tell the user what to do.
  h('saveImage', (itemId, payload) => {
    try {
      requireEditable();
      return saveImageForItem({ store, images }, itemId, payload);
    } catch (e) {
      console.warn('[catalog] saveImage failed:', e.message);
      return { error: thaiSaveError(e) };
    }
  }, { error: 'บันทึกรูปไม่สำเร็จ ลองอีกครั้ง' });
  // Detaches the image from the item (files stay on disk / R2). The only other path that touches Item.image.
  h('removeImage', (itemId) => {
    try {
      requireEditable();
      return removeImageForItem({ store }, itemId);
    } catch (e) {
      console.warn('[catalog] removeImage failed:', e.message);
      return { error: thaiSaveError(e).replace('บันทึกรูปไม่สำเร็จ', 'ลบรูปไม่สำเร็จ') };
    }
  }, { error: 'ลบรูปไม่สำเร็จ ลองอีกครั้ง' });
  h('hasOrig', (hash) => { hash = String(hash || ''); return IMG_HASH_RE.test(hash) && images.has(hash, 'orig'); }, false);
  // orig bytes for re-editing; downloads it from R2 first when it is not on this machine.
  h('readOrig', async (hash) => {
    hash = String(hash || '');
    if (!IMG_HASH_RE.test(hash)) return null;
    if (!images.has(hash, 'orig') && sync) await sync.ensureImage(hash, 'orig', null);
    return images.read(hash, 'orig', null);
  }, null);
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
  // ---- Phase 5: import from the legacy Catalog Hero, backups
  h('findLegacy', () => {
    const list = migrate.findCandidates({ appData: appRef ? appRef.getPath('appData') : undefined });
    legacyAllowed.clear();
    list.forEach((c) => legacyAllowed.add(c.path));
    return list;
  }, []);
  h('pickLegacyFile', async () => {
    const r = await dialog.showOpenDialog(cwin.getWindow(), {
      title: 'เลือกไฟล์ catalog-data.json จาก Catalog Hero เดิม',
      properties: ['openFile'],
      filters: [{ name: 'Catalog Hero (json)', extensions: ['json'] }, { name: 'ทุกไฟล์', extensions: ['*'] }]
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    legacyAllowed.add(r.filePaths[0]);
    return r.filePaths[0];
  }, null);
  h('previewLegacy', (file) => {
    file = String(file || '');
    if (!legacyAllowed.has(file)) return { ok: false, error: 'ไฟล์นี้ยังไม่ได้เลือก' };
    return migrate.previewLegacy(file);
  }, { ok: false, error: 'อ่านไฟล์ไม่สำเร็จ' });
  // Text data goes into the store now; image jobs [{itemId, legacyId, name, file}] are returned for the renderer
  // to process through the OpenCV worker (readImportImage -> processFile -> saveImage).
  h('importLegacy', async (file) => {
    requireEditable();
    file = String(file || '');
    if (!legacyAllowed.has(file)) return { ok: false, error: 'ไฟล์นี้ยังไม่ได้เลือก' };
    if (importState.running) return { ok: false, error: 'กำลังนำเข้าอยู่แล้ว' };
    importState.running = true;
    try {
      const b = backup.backupNow('before-import');
      if (!b.ok && fs.existsSync(path.join(dataDir, 'db.json'))) return { ok: false, error: 'สำรองข้อมูลก่อนนำเข้าไม่สำเร็จ: ' + b.error };
      const r = await migrate.importLegacy({ store, dir: dataDir, file, onProgress: (p) => cwin.send('catalog:import-progress', p) });
      if (r.ok) cwin.send('catalog:import-progress', { phase: 'text-done', done: r.summary.total, total: r.summary.total });
      return r;
    } finally { importState.running = false; }
  }, { ok: false, error: 'นำเข้าไม่สำเร็จ' });
  h('readImportImage', (name) => migrate.readStaged(dataDir, name), null);
  h('finishImport', () => { migrate.cleanupTmp(dataDir); return true; }, false);
  h('backupNow', (reason) => {
    const r = backup.backupNow(typeof reason === 'string' ? reason : '');
    return { ok: r.ok, name: r.name, error: r.error };
  }, { ok: false, error: 'สำรองข้อมูลไม่สำเร็จ' });
  // Export: a JSON file chosen by the user. source 'cloud' = Worker GET /export, otherwise a copy of the local db.json.
  h('exportJson', async (source) => {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const r = await dialog.showSaveDialog(cwin.getWindow(), {
      title: 'ส่งออกข้อมูลสินค้า (JSON)', defaultPath: 'catalog-export-' + stamp + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    if (source === 'cloud') {
      const x = await sync.exportAll();
      if (!x.ok) return { ok: false, error: x.message };
      fs.writeFileSync(r.filePath, JSON.stringify(x.data));
      return { ok: true, file: r.filePath, source: 'cloud' };
    }
    return Object.assign(backup.exportTo(r.filePath), { source: 'local' });
  }, { ok: false, error: 'ส่งออกไม่สำเร็จ' });
  // Restore from a backup file chosen by the user: re-applied as new edits (see catalog-backup restoreFrom).
  h('restoreBackup', async () => {
    requireEditable();
    const r = await dialog.showOpenDialog(cwin.getWindow(), {
      title: 'เลือกไฟล์สำรอง (db-....json)', defaultPath: path.join(dataDir, 'backups'), properties: ['openFile'],
      filters: [{ name: 'ไฟล์สำรอง (json)', extensions: ['json'] }, { name: 'ทุกไฟล์', extensions: ['*'] }]
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    return backup.restoreFrom(r.filePaths[0]);
  }, { ok: false, error: 'กู้คืนไม่สำเร็จ' });
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
    dataDir = dir;
    appRef = app;
    imagesDir = path.join(dir, 'images');
    configStore = createConfigStore(dir);
    configStore.load();
    if (config && Object.keys(config).length) configStore.update(config);
    store = createStore(dir).load();
    migrate.cleanupTmp(dir); // leftovers of an interrupted import
    backup = createBackup({ dir, store, getConfig: () => configStore.get() });
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
    backup.startDaily();
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
  try { if (backup) backup.stop(); } catch (e) { console.warn('[catalog] backup stop failed', e.message); }
  try { if (sync) sync.stop(); } catch (e) { console.warn('[catalog] sync stop failed', e.message); }
  try { if (outbox) outbox.flush(); } catch (e) { console.warn('[catalog] outbox flush failed', e.message); }
  try { if (store) store.flush(); } catch (e) { console.warn('[catalog] flush failed', e.message); }
}

module.exports = { registerSchemes, init, openCatalog, toggleCatalog, shutdown };
