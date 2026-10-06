/**
 * Standalone Electron harness (does NOT load the app's main.js, so no autostart side effects):
 *   npm run smoke:pipeline      (== npx electron test/electron/pipeline-smoke/main.js)
 * Opens a hidden sandboxed window on renderer/catalog/dev/worker-smoke.html (which carries the
 * exact catalog CSP), runs the real image worker on a synthetic photo, exits 0 on success.
 * Make sure ELECTRON_RUN_AS_NODE is unset.
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const timer = setTimeout(() => { console.log('SMOKE: timeout'); app.exit(2); }, 120000);
  win.webContents.on('console-message', (e, level, message) => {
    if (message.startsWith('SMOKE_CSP:')) console.log(message);
    if (!message.startsWith('SMOKE_RESULT:')) { if (level >= 2) console.log('[renderer]', message); return; }
    const r = JSON.parse(message.slice('SMOKE_RESULT:'.length));
    console.log('SMOKE result:', JSON.stringify(r));
    clearTimeout(timer);
    app.exit(r.ok && r.quality ? 0 : 1);
  });
  win.loadFile(path.join(__dirname, '..', '..', '..', 'renderer', 'catalog', 'dev', 'worker-smoke.html'));
});
