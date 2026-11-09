'use strict';
// โมดูลเซียมซีต่อท้ายใบเสร็จ — ทุกจุดครอบ try/catch: ถ้าพลาด ต้องตัดกระดาษให้ใบเสร็จเสมอ และห้ามกระทบ POS Hero
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { BrowserWindow, Notification, ipcMain, clipboard, shell } = require('electron');
const logic = require('./logic');
const slipRenderer = require('./slip-renderer');

const FORTUNES = require('./fortunes.json');
const MASCOTS = require('./mascot.json'); // น้องริสุซัง (กระรอก) 6 ท่า + คำพูด
const HEARTBEAT_STALE_MS = 30 * 1000;
const WATCHER_RESTART_MS = 2000;
const LOG_MAX_BYTES = 512 * 1024;

let ctx = null;            // { app, getMainWindow, buildRaster }
let settings = logic.normalizeSettings(null);
let settingsFile = '';
let logFile = '';
let cacheKey = '';        // ตัวเลือกการเรนเดอร์ของแคชปัจจุบัน (ธีม/กลอน/ข้อความท้ายใบ)
let themeTimer = null;
let mascotCache = null;    // Buffer[6] บล็อกมาสคอตต่อท่า (null ถ้าปิดมาสคอตหรือยังไม่เสร็จ)
let cache = null;          // Buffer[100] หรือ null ถ้ายังเรนเดอร์ไม่เสร็จ
let renderToken = 0;
let rendering = false;
let watcher = null;
let watcherPrinter = '';
let restartTimer = null;
let heartbeatTimer = null;
let lastHeartbeat = 0;
let staleNotified = false;
let stopping = false;
let queue = Promise.resolve();
const batcher = logic.makeBatcher({
  onFlush: (evts) => {
    // timeout รวมต่อชุด กันชุดเดียวค้างแล้วคิวทั้งแถวติด
    queue = queue.then(() => withTimeout(handleBatch(evts), 45000, 'handler jobs ' + evts.map((e) => e.id).join(',')))
      .catch((e) => log(`# handler error: ${e && e.message}`));
  }
});
const dedup = logic.makeDedup(200);
let stats = { date: logic.localDateStr(new Date()), count: 0 };
let settingsWin = null;
let onChange = () => {};

function log(line) {
  try {
    if (!logFile) return;
    try { if (fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, logFile + '.old'); } catch (e) { /* ยังไม่มีไฟล์ */ }
    // หมายเหตุของโปรแกรม (# ...) ใส่เวลากำกับ เพื่อให้รายงานบอกได้ว่าเกิดเมื่อไร
    const out = line.startsWith('# ') ? '# ' + new Date().toISOString() + ' ' + line.slice(2) : line;
    fs.appendFileSync(logFile, out + '\n');
  } catch (e) { /* ignore */ }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timeout ' + ms + 'ms')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function notify(title, body) {
  try { new Notification({ title, body }).show(); } catch (e) { /* ignore */ }
}

function loadSettings() {
  try { settings = logic.normalizeSettings(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); }
  catch (e) { settings = logic.normalizeSettings(null); }
}

function saveSettings() {
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (e) { console.warn('[fortune] save settings failed:', e && e.message); }
}

function bumpStats() {
  const today = logic.localDateStr(new Date());
  if (stats.date !== today) stats = { date: today, count: 0 };
  stats.count++;
  onChange();
}

function todayCount() {
  return stats.date === logic.localDateStr(new Date()) ? stats.count : 0;
}

// ---------- ส่ง bytes เข้าเครื่องพิมพ์ (ใช้ raw-print.ps1 ตัวเดิม — ชื่อเอกสาร "POS Hero Receipt" ซึ่ง watcher ข้ามอยู่แล้ว) ----------
function unpackedPath(...parts) {
  return ctx.app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', ...parts)
    : path.join(__dirname, '..', ...parts);
}

let printerCache = '';
async function resolvePrinter() {
  if (settings.printerName) return settings.printerName;
  if (watcherPrinter) return watcherPrinter; // ใช้เครื่องเดียวกับที่ตัวเฝ้าคิวเฝ้าอยู่ ไม่ต้องถามระบบทุกครั้ง
  const mw = ctx.getMainWindow();
  if (!mw) return '';
  const printers = await withTimeout(mw.webContents.getPrintersAsync(), 5000, 'getPrinters');
  const target = printers.find((p) => p.isDefault) || printers[0];
  if (target) printerCache = target.name;
  return target ? target.name : '';
}

async function sendBytes(buf) {
  let printer = '';
  try { printer = await resolvePrinter(); } catch (e) { printer = printerCache; if (!printer) throw e; }
  if (!printer) throw new Error('ไม่พบเครื่องพิมพ์ในระบบ');
  const tmp = path.join(os.tmpdir(), `pos-hero-fortune-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
  fs.writeFileSync(tmp, buf);
  try {
    await new Promise((resolve, reject) => {
      execFile('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', unpackedPath('build', 'raw-print.ps1'),
        '-PrinterName', printer, '-FilePath', tmp
      ], { windowsHide: true, timeout: 15000, killSignal: 'SIGKILL' }, (error, _o, stderr) => (error ? reject(new Error((stderr || error.message).trim())) : resolve()));
    });
  } finally {
    fs.unlink(tmp, () => {});
  }
}

// ---------- จัดการงานที่พิมพ์จบ ----------
// จัดการงานที่จบเป็นชุด: ใบเสร็จ 1 ใบ = เซียมซี 1 ใบ (ต่อกันบนแถบเดียว) แล้วตัดครั้งเดียวท้ายชุด
async function handleBatch(evts) {
  const actions = evts.map((e) => logic.decideAction(e.doc, settings));
  const slipCount = Math.min(actions.filter((a) => a === 'slip').length, 5);
  const ids = evts.map((e) => e.id).join(',');
  log(`# batch jobs [${ids}] ${evts.map((e) => '"' + e.doc + '"').join(' + ')} → ${slipCount ? slipCount + ' slip + cut' : 'cut'}`);
  if (!actions.some((a) => a !== 'skip')) return;

  if (slipCount > 0) {
    try {
      const parts = [];
      const picked = [];
      for (let i = 0; i < slipCount; i++) {
        const idx = logic.pickIndex(FORTUNES, settings);
        const r = await getSlipBytes(idx);
        picked.push(r.mascot >= 0 ? (idx + 1) + '+m' + r.mascot : String(idx + 1));
        parts.push(r.bytes);
      }
      parts.push(logic.FEED_AND_CUT);
      await sendBytes(Buffer.concat(parts));
      for (let i = 0; i < slipCount; i++) bumpStats();
      log(`# slip #${picked.join(',#')} sent for jobs [${ids}]`);
      return;
    } catch (e) {
      log(`# slip failed for jobs [${ids}] (${e && e.message}) → cut only`);
      notify('POS Hero: ส่งเซียมซีไม่สำเร็จ', 'ตัดกระดาษให้อย่างเดียว — ' + (e && e.message ? e.message : ''));
      // ตกลงมาตัดกระดาษอย่างเดียว — ใบเสร็จต้องถูกตัดเสมอ
    }
  }
  try { await sendBytes(logic.FEED_AND_CUT); log(`# cut sent for jobs [${ids}]`); }
  catch (e) { log(`# cut failed for jobs [${ids}]: ${e && e.message}`); notify('POS Hero: ตัดกระดาษไม่สำเร็จ', 'ตรวจสอบเครื่องพิมพ์ หรือตั้งไดรเวอร์ Paper Cut กลับเป็น Cut'); }
}

function onWatcherEvent(evt) {
  if (evt.e === 'hb' || evt.e === 'start') { lastHeartbeat = Date.now(); staleNotified = false; }
  if (evt.e !== 'hb') log(JSON.stringify(evt));
  if (settings.mode !== 'on') return; // โหมดบันทึกอย่างเดียว: ไม่ทำอะไรกับงาน

  if (evt.doc === logic.OWN_DOC_NAME) return; // งานของ POS Hero เอง (มีคำสั่งตัดในตัว) — ไม่นับ ไม่ลงบันทึก
  if (evt.e === 'added') { batcher.added(evt.id); return; }

  let finished = false;
  if (evt.e === 'done') finished = true;
  else if (evt.e === 'gone') finished = !evt.done && !/Error|Delet|Offline|Paperout|UserIntervention/i.test(evt.lastStatus || '');
  if (evt.e === 'gone' && !finished) batcher.dropped(evt.id); // จบแบบพลาด/ถูกยกเลิก หรือจบไปแล้ว: เลิกรอ
  if (!finished) return;
  if (dedup.seen(evt.id)) { log(`# skip job ${evt.id} "${evt.doc}" (already handled within 10 min)`); batcher.dropped(evt.id); return; }
  dedup.add(evt.id);
  batcher.finished(evt); // รอคิวเงียบ แล้วค่อยตัด/พิมพ์เซียมซีเป็นชุด (handleBatch)
}

// ---------- watcher (PowerShell ตัวเดียวรันค้าง) ----------
async function startWatcher() {
  stopWatcher(false);
  batcher.reset(); // ตัวเฝ้าใหม่เริ่มจำงานค้างในคิวใหม่
  stopping = false;
  if (settings.mode === 'off') return;
  let printer = '';
  try { printer = await resolvePrinter(); } catch (e) { /* ลองใหม่ด้านล่าง */ }
  if (!printer) { restartTimer = setTimeout(startWatcher, 5000); return; }
  watcherPrinter = printer;
  try {
    watcher = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', unpackedPath('fortune', 'job-watcher.ps1'),
      '-PrinterName', printer, '-IntervalMs', '120'
    ], { windowsHide: true });
  } catch (e) { log(`# spawn failed: ${e && e.message}`); restartTimer = setTimeout(startWatcher, WATCHER_RESTART_MS); return; }

  const child = watcher;
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { onWatcherEvent(JSON.parse(line)); } catch (e) { log(`# bad line: ${line.slice(0, 200)}`); }
    }
  });
  child.stderr.on('data', (d) => log(`# stderr: ${String(d).trim().slice(0, 300)}`));
  child.on('exit', (code) => {
    // ตัวที่เราสั่งปิดเองเพื่อแทนที่ (stopWatcher/startWatcher) ห้ามกลับมาสั่งรีสตาร์ท ไม่งั้นวนฆ่า-เปิดใหม่ทุก 2 วินาที
    if (child.replacedByUs) return;
    if (watcher === child) watcher = null;
    if (stopping || settings.mode === 'off') return;
    if (restartTimer) return;
    log(`# watcher exited (${code}) → restart`);
    restartTimer = setTimeout(() => { restartTimer = null; startWatcher().catch(() => {}); }, WATCHER_RESTART_MS);
  });
  lastHeartbeat = Date.now();
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      if (!watcher || settings.mode === 'off') return;
      if (Date.now() - lastHeartbeat > HEARTBEAT_STALE_MS && !staleNotified) {
        staleNotified = true;
        notify('POS Hero: ตัวเฝ้าเครื่องพิมพ์หยุดทำงาน', 'ใบเสร็จอาจไม่ถูกตัดกระดาษ — ลองเปิดโปรแกรมใหม่ หรือตั้งไดรเวอร์ Paper Cut = Cut');
      }
    }, 5000);
  }
}

function stopWatcher(final = true) {
  if (final) stopping = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (watcher) { watcher.replacedByUs = true; try { watcher.kill(); } catch (e) { /* ignore */ } watcher = null; }
  if (final && heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ---------- เรนเดอร์แคช ----------
async function rebuildCache() {
  const token = ++renderToken;
  const cacheOpts = logic.renderOptions(settings);
  cacheKey = JSON.stringify(cacheOpts);
  cache = null;
  mascotCache = null;
  rendering = true;
  onChange();
  try {
    const result = await slipRenderer.renderAll(
      FORTUNES,
      cacheOpts,
      ctx.buildRaster,
      () => token !== renderToken
    );
    let mascots = null;
    if (result && cacheOpts.mascot) {
      try { mascots = await slipRenderer.renderMascotAll(MASCOTS, cacheOpts, ctx.buildRaster, () => token !== renderToken); }
      catch (e) { log(`# mascot render failed: ${e && e.message} (พิมพ์เซียมซีโดยไม่มีมาสคอต)`); }
    }
    if (token === renderToken && result) {
      mascotCache = mascots;
      cache = result;
      rebuildFailures = 0;
      log(`# slip cache ready (theme ${cacheOpts.theme}, zh ${cacheOpts.showZh}, th ${cacheOpts.showTh}, mascot ${mascotCache ? MASCOTS.length + ' poses' : 'off'})`);
    }
  } catch (e) {
    console.warn('[fortune] render failed:', e && e.message);
    log(`# render failed: ${e && e.message}`);
    if (token === renderToken) scheduleRebuildRetry();
  } finally {
    if (token === renderToken) { rendering = false; onChange(); }
  }
}

// เรนเดอร์แคชพลาด: ลองใหม่เอง (15, 30, 45 … สูงสุด 120 วินาที) ไม่ทิ้งให้แคชว่างไปจนกว่าจะปิดเปิดโปรแกรม
let retryTimer = null;
let rebuildFailures = 0;
function scheduleRebuildRetry() {
  rebuildFailures++;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (settings.mode === 'on' && !cache && !rendering) rebuildCache().catch(() => {});
  }, Math.min(15000 * rebuildFailures, 120000));
}

// ใบเซียมซีที่จะพิมพ์: ใช้แคช ถ้ายังไม่พร้อมให้เรนเดอร์ใบนั้นใบเดียวทันที (ราว 0.3 วินาที) แทนที่จะไม่ออกเซียมซี
async function getSlipBytes(idx) {
  const opts = logic.renderOptions(settings);
  const m = opts.mascot ? logic.pickMascot(settings, MASCOTS.length) : -1;
  let body = cache && cache[idx];
  if (!body) {
    log(`# cache not ready → render slip #${idx + 1} on demand`);
    if (!rendering && settings.mode === 'on') rebuildCache().catch(() => {});
    body = await withTimeout(slipRenderer.renderSingle(FORTUNES[idx], opts, ctx.buildRaster), 10000, 'render slip');
  }
  if (m < 0) return { bytes: body, mascot: -1 };
  let block = mascotCache && mascotCache[m];
  if (!block) {
    try { block = await withTimeout(slipRenderer.renderMascotSingle(MASCOTS[m], opts, ctx.buildRaster), 10000, 'render mascot'); }
    catch (e) { log(`# mascot render failed: ${e && e.message}`); return { bytes: body, mascot: -1 }; }
  }
  return { bytes: Buffer.concat([body, block]), mascot: m };
}

function applySettings(next) {
  const prev = settings;
  settings = logic.normalizeSettings(Object.assign({}, prev, next));
  saveSettings();
  const needsSlips = settings.mode === 'on';
  const lookChanged = JSON.stringify(logic.renderOptions(settings)) !== cacheKey;
  if (needsSlips && (lookChanged || prev.mode !== 'on' || (!cache && !rendering))) rebuildCache().catch(() => {});
  if (!needsSlips) { renderToken++; cache = null; mascotCache = null; rendering = false; }
  if (prev.mode !== settings.mode || prev.printerName !== settings.printerName) {
    if (settings.mode === 'off') stopWatcher(); else startWatcher().catch(() => {});
  }
  onChange();
  return getState();
}

async function testPrint() {
  const idx = logic.pickIndex(FORTUNES, settings);
  const r = await getSlipBytes(idx);
  await sendBytes(Buffer.concat([r.bytes, logic.FEED_AND_CUT]));
  return { success: true, n: idx + 1 };
}

// รายงานสรุปงานพิมพ์: เขียนไฟล์ + คัดลอกลงคลิปบอร์ด (วางส่งได้ทันที) + เปิดโฟลเดอร์ + ถ้ามีโฟลเดอร์ Google Drive ในเครื่องก็คัดลอกไปให้
function driveFolders() {
  const home = os.homedir();
  return [path.join(home, 'Google Drive'), path.join(home, 'My Drive'), 'G:\\My Drive', 'H:\\My Drive']
    .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } });
}

function readLogLines() {
  let lines = [];
  for (const f of [logFile + '.old', logFile]) { try { lines = lines.concat(fs.readFileSync(f, 'utf8').split(/\r?\n/)); } catch (e) { /* ไม่มีไฟล์ */ } }
  return lines.filter(Boolean);
}

function exportReport() {
  const lines = readLogLines();
  if (!lines.length) return { success: false, reason: 'ยังไม่มีไฟล์บันทึก — เปิดโหมด "บันทึกอย่างเดียว" แล้วขายสักบิลก่อน' };
  const text = logic.buildReportText(lines, {
    'เวอร์ชัน': ctx.app.getVersion(), 'โหมด': settings.mode, 'เครื่องพิมพ์': watcherPrinter || settings.printerName || '(เริ่มต้น)',
    'ตัวกรอง': settings.docFilter, 'สร้างเมื่อ': new Date().toISOString()
  });
  const file = path.join(path.dirname(logFile), 'fortune-report.txt');
  fs.writeFileSync(file, text, 'utf8');
  try { clipboard.writeText(text); } catch (e) { /* ignore */ }
  let drive = '';
  for (const d of driveFolders()) {
    try {
      const dir = path.join(d, 'pos-hero-logs'); fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(file, path.join(dir, 'fortune-report.txt'));
      fs.copyFileSync(logFile, path.join(dir, 'fortune-jobs.log'));
      drive = dir; break;
    } catch (e) { /* ลองโฟลเดอร์ถัดไป */ }
  }
  try { shell.showItemInFolder(file); } catch (e) { /* ignore */ }
  return { success: true, file, drive, chars: text.length };
}

function getState() {
  return {
    settings, todayCount: todayCount(), ready: !!cache, rendering,
    watcherRunning: !!watcher, watcherPrinter, logFile
  };
}

function trayItems() {
  const modeText = { off: 'ปิด', record: 'บันทึกอย่างเดียว', on: 'เปิด' }[settings.mode];
  return [
    { label: `🔮 เซียมซี: ${modeText} · วันนี้ ${todayCount()} ใบ`, click: () => openSettings() },
    { type: 'separator' }
  ];
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 460, height: 720, title: 'ตั้งค่าเซียมซี', autoHideMenuBar: true, resizable: true,
    webPreferences: { preload: path.join(__dirname, 'preload-fortune.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

function init(context) {
  ctx = context;
  const dir = ctx.app.getPath('userData');
  settingsFile = path.join(dir, 'fortune-settings.json');
  logFile = path.join(dir, 'fortune-jobs.log');
  loadSettings();
  onChange = () => {
    try { if (ctx.onChange) ctx.onChange(); } catch (e) { /* ignore */ }
    try { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('fortune:state', getState()); } catch (e) { /* ignore */ }
  };

  ipcMain.handle('fortune:get-state', () => getState());
  ipcMain.handle('fortune:set-settings', (_e, next) => { try { return applySettings(next || {}); } catch (e) { return getState(); } });
  ipcMain.handle('fortune:test-print', async () => {
    try { return await testPrint(); } catch (e) { return { success: false, reason: e && e.message ? e.message : String(e) }; }
  });
  ipcMain.handle('fortune:export-report', () => { try { return exportReport(); } catch (e) { return { success: false, reason: e && e.message ? e.message : String(e) }; } });
  ipcMain.handle('fortune:list-printers', async () => {
    try { const mw = ctx.getMainWindow(); return mw ? (await mw.webContents.getPrintersAsync()).map((p) => p.name) : []; } catch (e) { return []; }
  });

  if (settings.mode === 'on') rebuildCache().catch(() => {});
  // ข้ามวันแล้วธีมอาจเปลี่ยน (auto ตามช่วงวันที่) — ตรวจทุก 10 นาที ถ้าเปลี่ยนให้เรนเดอร์แคชใหม่
  themeTimer = setInterval(() => {
    if (settings.mode === 'on' && !rendering && (!cache || JSON.stringify(logic.renderOptions(settings)) !== cacheKey)) rebuildCache().catch(() => {});
  }, 10 * 60 * 1000);
  if (settings.mode !== 'off') startWatcher().catch(() => {});
}

function shutdown() { if (themeTimer) clearInterval(themeTimer); stopWatcher(true); slipRenderer.closeAll(); }

module.exports = { init, shutdown, trayItems, openSettings };
