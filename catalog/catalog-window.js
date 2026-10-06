'use strict';
// The inventory ("กระเป๋าสินค้า") BrowserWindow: frameless, hide-not-destroy,
// docks left of the POS Hero window, remembers bounds, owns the global hotkey.
const path = require('path');
const { BrowserWindow, screen, globalShortcut, Notification } = require('electron');

const { defaults } = require('./defaults');
const { hasModifier } = require('./sanitize');

const PRELOAD = path.join(__dirname, '..', 'preload-catalog.js');
const PAGE = path.join(__dirname, '..', 'renderer', 'catalog', 'index.html');

function createCatalogWindow({ getMainWindow, configStore, onVisibility, onFocus }) {
  let win = null;
  let ready = false;
  let quitting = false;
  let pinned = true;
  let lastTheme = null;
  let activeKey = null; // accelerator currently registered by us
  let lastError = null;
  let boundsTimer = null;

  const cfg = () => configStore.get();

  function boundsVisible(b) {
    return screen.getAllDisplays().some((d) => {
      const w = d.workArea;
      return b.x + 80 < w.x + w.width && b.x + b.width - 80 > w.x && b.y + 20 < w.y + w.height && b.y + 20 > w.y;
    });
  }

  // Left of the POS Hero window (bottom-aligned); centered on the display if there is no room.
  function dockBounds(width, height) {
    const c = cfg().window;
    const mw = getMainWindow && getMainWindow();
    let display = screen.getPrimaryDisplay();
    let anchor = null;
    if (mw && !mw.isDestroyed() && mw.isVisible()) {
      anchor = mw.getBounds();
      display = screen.getDisplayMatching(anchor);
    }
    const wa = display.workArea;
    width = Math.min(width, wa.width);
    height = Math.min(height, wa.height);
    if (anchor && c.dockSide === 'left') {
      const x = anchor.x - width - c.dockGap;
      if (x >= wa.x) {
        const y = Math.max(wa.y, Math.min(anchor.y + anchor.height - height, wa.y + wa.height - height));
        return { x, y, width, height };
      }
    }
    return {
      x: Math.round(wa.x + (wa.width - width) / 2),
      y: Math.round(wa.y + (wa.height - height) / 2),
      width, height
    };
  }

  function computeInitialBounds() {
    const c = cfg().window;
    const s = c.bounds;
    if (s && Number.isFinite(s.x) && Number.isFinite(s.y) && s.width >= c.minWidth && s.height >= c.minHeight && boundsVisible(s)) {
      return s;
    }
    return dockBounds(c.width, c.height);
  }

  function saveBoundsSoon() {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      try { configStore.update({ window: { bounds: win.getBounds() } }); } catch (e) { console.warn('[catalog] save bounds failed', e.message); }
    }, 400);
  }

  function sendFocusSearch() {
    if (win && !win.isDestroyed() && ready) {
      win.focus();
      win.webContents.focus();
      win.webContents.send('catalog:focus-search');
    }
  }

  const notifyVis = (v) => { try { if (onVisibility) onVisibility(v); } catch (e) { console.warn('[catalog] visibility cb', e.message); } };

  const notifyFocus = (f) => { try { if (onFocus) onFocus(f); } catch (e) { console.warn('[catalog] focus cb', e.message); } };

  function create() {
    const c = cfg().window;
    const b = computeInitialBounds();
    pinned = !!c.alwaysOnTop;
    win = new BrowserWindow({
      ...b,
      minWidth: c.minWidth,
      minHeight: c.minHeight,
      frame: false,
      resizable: true,
      show: false,
      skipTaskbar: true,
      fullscreenable: false,
      alwaysOnTop: pinned,
      backgroundColor: '#120d09',
      icon: path.join(__dirname, '..', 'build', 'icon.ico'),
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    });
    if (pinned) win.setAlwaysOnTop(true, 'floating');
    win.on('close', (e) => {
      if (!quitting) { e.preventDefault(); win.hide(); }
    });
    win.on('resize', saveBoundsSoon);
    win.on('move', saveBoundsSoon);
    win.on('show', sendFocusSearch);
    win.on('show', () => notifyVis(true));
    win.on('focus', () => notifyFocus(true));
    win.on('blur', () => notifyFocus(false));
    win.on('hide', () => notifyVis(false));
    win.on('minimize', () => notifyVis(false));
    win.on('restore', () => notifyVis(true));
    win.on('closed', () => { win = null; ready = false; notifyVis(false); });
    win.webContents.on('render-process-gone', (_e, d) => {
      console.warn('[catalog] renderer gone:', d && d.reason);
      // Recreate lazily on next open; never touch the main POS window.
      try { win.destroy(); } catch (_) { /* ignore */ }
      win = null; ready = false; notifyVis(false);
    });
    win.webContents.on('did-finish-load', () => {
      ready = true;
      if (lastTheme) win.webContents.send('catalog:theme', lastTheme);
      if (win.isVisible()) sendFocusSearch();
    });
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.loadFile(PAGE).catch((e) => console.warn('[catalog] load failed', e.message));
  }

  function show() {
    if (!win || win.isDestroyed()) create();
    if (win.isMinimized()) win.restore();
    win.show();
    sendFocusSearch();
  }
  function hide() { if (win && !win.isDestroyed()) win.hide(); }
  function toggle() {
    const alive = win && !win.isDestroyed();
    if (alive && win.isVisible() && win.isFocused()) hide();
    else if (alive && win.isVisible()) sendFocusSearch();
    else show();
  }

  // Global-shortcut callback: nothing may escape into the main process.
  function safeToggle() {
    try { toggle(); } catch (e) { console.warn('[catalog] hotkey toggle failed:', e && e.message); }
  }

  function togglePin() {
    pinned = !pinned;
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(pinned, 'floating');
    try { configStore.update({ window: { alwaysOnTop: pinned } }); } catch (_) { /* ignore */ }
    return pinned;
  }

  function setTheme(name) {
    lastTheme = name;
    if (win && !win.isDestroyed() && ready) win.webContents.send('catalog:theme', name);
  }

  function send(channel, payload) {
    if (win && !win.isDestroyed() && ready) win.webContents.send(channel, payload);
  }

  // ---- global hotkey ----
  // Returns { ok, error }. On failure the previously working key (if any) stays active.
  // '' turns the hotkey off. A key without Ctrl/Alt is refused: it would be
  // grabbed system-wide and stolen from the POS program (e.g. F2 in Sea & Hill).
  function registerHotkey(accelerator) {
    if (!accelerator) {
      if (activeKey) { try { globalShortcut.unregister(activeKey); } catch (_) { /* ignore */ } }
      activeKey = null;
      lastError = null;
      if (cfg().window.hotkey !== '') configStore.update({ window: { hotkey: '' } });
      return { ok: true, error: null };
    }
    if (!hasModifier(accelerator)) { lastError = 'needs_modifier'; return { ok: false, error: 'needs_modifier' }; }
    if (accelerator === activeKey && globalShortcut.isRegistered(accelerator)) {
      lastError = null;
      return { ok: true, error: null };
    }
    let ok = false;
    let error = null;
    try {
      ok = globalShortcut.register(accelerator, safeToggle);
      if (!ok) error = 'in_use';
    } catch (e) {
      error = 'invalid';
      console.warn('[catalog] hotkey error:', e.message);
    }
    if (ok) {
      if (activeKey) { try { globalShortcut.unregister(activeKey); } catch (_) { /* ignore */ } }
      activeKey = accelerator;
      lastError = null;
      if (accelerator !== cfg().window.hotkey) configStore.update({ window: { hotkey: accelerator } });
    } else {
      lastError = error;
    }
    return { ok, error };
  }

  function initHotkey() {
    let key = cfg().window.hotkey;
    if (!key) return { ok: true, error: null }; // turned off by the user
    // Older configs may hold a bare F-key (the old F2 default) — move to the safe default.
    if (!hasModifier(key)) key = defaults.window.hotkey;
    const r = registerHotkey(key);
    if (!r.ok) {
      console.warn('[catalog] hotkey', key, 'could not be registered:', r.error);
      try {
        new Notification({
          title: 'กระเป๋าสินค้า',
          body: `ปุ่มลัด ${key} ใช้ไม่ได้ (โปรแกรมอื่นใช้อยู่) เปิดกระเป๋าจากปุ่มบนแถบหัว แล้วเลือกปุ่มใหม่ในตั้งค่า`
        }).show();
      } catch (_) { /* ignore */ }
    }
    return r;
  }

  function dispose() {
    quitting = true;
    try { if (activeKey) globalShortcut.unregister(activeKey); } catch (_) { /* ignore */ }
    activeKey = null;
    if (boundsTimer) { clearTimeout(boundsTimer); boundsTimer = null; }
    try { if (win && !win.isDestroyed()) configStore.update({ window: { bounds: win.getBounds() } }); } catch (_) { /* ignore */ }
  }

  return {
    show, hide, toggle, togglePin, setTheme, send, initHotkey, registerHotkey, dispose,
    getPinState: () => pinned,
    isFocused: () => !!(win && !win.isDestroyed() && win.isFocused()),
    isVisible: () => !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()),
    getHotkey: () => ({ accelerator: activeKey || cfg().window.hotkey || '', active: !!activeKey, disabled: !cfg().window.hotkey, error: lastError }),
    getWindow: () => (win && !win.isDestroyed() ? win : null),
    isOwnSender: (wc) => !!(win && !win.isDestroyed() && wc === win.webContents)
  };
}

module.exports = { createCatalogWindow };
