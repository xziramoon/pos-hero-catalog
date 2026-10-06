/**
 * Safe Electron harness for the catalog window (does NOT load the app's main.js, so there is no
 * autostart registration, no LAN server, no tray):
 *
 *   npm run harness:catalog
 *
 * Env (all optional; ELECTRON_RUN_AS_NODE must be unset):
 *   CATALOG_HARNESS_DIR   userData dir (default: fresh temp dir). Catalog data lives in <dir>/catalog.
 *   HARNESS_SEED=<n>      seed n demo items (catalog/tools/seed-demo.js) before opening
 *   HARNESS_FIXTURES=1    write synthetic fixture photos to <dir>/fixtures/*.jpg
 *   HARNESS_JS=<code>     JS run inside the catalog window once loaded (awaited; result is logged)
 *   HARNESS_STEPS=<file>  node module run in the main process: module.exports = async (h) => {...}
 *                         h = { win, dir, catalogDir, fixturesDir, js(code), shot(name), sleep(ms), log(...) }
 *   HARNESS_SHOT=<dir>    screenshot dir (default <dir>/shots); a final "final.png" is always taken when set
 *   HARNESS_KEEP=1        do not quit at the end (close the window yourself)
 *   HARNESS_CONFIG=<json> config patch passed to init (e.g. {"worker":{"url":"...","key":"..."}})
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
if (process.env.ELECTRON_RUN_AS_NODE) { console.log('HARNESS: unset ELECTRON_RUN_AS_NODE'); process.exit(2); }

const dir = path.resolve(process.env.CATALOG_HARNESS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-harness-')));
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', dir);
app.disableHardwareAcceleration();

const catalog = require(path.join(ROOT, 'catalog'));
catalog.registerSchemes();

const catalogDir = process.env.CATALOG_DATA_DIR || path.join(dir, 'catalog');
const shotDir = path.resolve(process.env.HARNESS_SHOT || path.join(dir, 'shots'));
const fixturesDir = path.join(dir, 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[harness]', ...a);

function seed(n) {
  fs.mkdirSync(catalogDir, { recursive: true });
  const r = spawnSync(process.execPath, [path.join(ROOT, 'catalog', 'tools', 'seed-demo.js'), String(n), '--dir', catalogDir, '--reset'],
    { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), encoding: 'utf8' });
  log('seed:', (r.stdout || '').trim(), r.status ? 'FAILED ' + r.stderr : '');
}

function fixtures() {
  fs.mkdirSync(fixturesDir, { recursive: true });
  require(path.join(ROOT, 'test', 'fixtures', 'make-synthetic.js')).writeAll(fixturesDir);
  log('fixtures:', fs.readdirSync(fixturesDir).join(', '));
}

app.whenReady().then(async () => {
  let code = 0;
  const timer = setTimeout(() => { log('timeout'); app.exit(3); }, +process.env.HARNESS_TIMEOUT_MS || 180000);
  try {
    if (process.env.HARNESS_SEED) seed(parseInt(process.env.HARNESS_SEED, 10) || 0);
    if (process.env.HARNESS_FIXTURES === '1') fixtures();
    let config = {};
    try { if (process.env.HARNESS_CONFIG) config = JSON.parse(process.env.HARNESS_CONFIG); } catch (e) { log('bad HARNESS_CONFIG', e.message); }
    catalog.init({ app, getMainWindow: () => null, userDataDir: dir, config });
    catalog.openCatalog();
    await sleep(500);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('catalog window was not created');
    win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 1 || process.env.HARNESS_VERBOSE) log('renderer', ['log', 'info', 'warn', 'error'][lvl] || lvl, msg); });
    win.webContents.on('preload-error', (_e, p, err) => log('PRELOAD ERROR', p, err && err.message));
    await new Promise((resolve) => { if (!win.webContents.isLoading()) resolve(); else win.webContents.once('did-finish-load', resolve); });
    await sleep(1500); // boot()
    const h = {
      win, dir, catalogDir, fixturesDir, log, sleep,
      js: (c) => win.webContents.executeJavaScript(c, true),
      shot: async (name) => {
        fs.mkdirSync(shotDir, { recursive: true });
        const f = path.join(shotDir, name.endsWith('.png') ? name : name + '.png');
        const img = await Promise.race([win.webContents.capturePage(), sleep(8000).then(() => { throw new Error('capturePage timed out (window hidden?)'); })]);
        fs.writeFileSync(f, img.toPNG());
        log('shot', f);
        return f;
      }
    };
    if (process.env.HARNESS_JS) { const r = await h.js(process.env.HARNESS_JS); log('HARNESS_JS ->', typeof r === 'string' ? r : JSON.stringify(r)); await sleep(500); }
    if (process.env.HARNESS_STEPS) await require(path.resolve(process.env.HARNESS_STEPS))(h);
    if (process.env.HARNESS_SHOT) await h.shot('final');
  } catch (e) {
    log('FAILED', e && e.stack || e);
    code = 1;
  }
  clearTimeout(timer);
  if (process.env.HARNESS_KEEP === '1') return;
  try { catalog.shutdown(); } catch (_) { /* ignore */ }
  setTimeout(() => app.exit(code), 300);
});
