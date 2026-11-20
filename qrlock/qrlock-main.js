'use strict';
// QR-LOCK (ระยะ 1): หน้าต่างรับยอด + สร้าง QR + จอลูกค้า + ปุ่มยืนยันเอง/ยกเลิก
// โมดูลแยก ปิดได้ด้วย qrlock-config.json → enabled:false (ใน userData ไม่ลง git) พังตรงนี้ต้องไม่กระทบ POS
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { BrowserWindow, globalShortcut, ipcMain } = require('electron');
const { buildQr, validateTemplate, formatAmount } = require('./qr-builder');
const { createSessions } = require('./session');
const { createDisplayServer } = require('./display-server');

const DEFAULTS = { enabled: false, machineName: 'เครื่อง 1', bank: '', qrTemplate: '', shopName: '', expirySec: 180, warnAmountOver: 10000, hotkey: 'F9', transferCodes: ['02'], displayPort: 8080 };
let ctx = null, cfg = { ...DEFAULTS }, win = null, server = null, sessions = null, timer = null, lastMsg = { type: 'idle' }, active = false;
let cfgPath = null, logPath = null;

function loadConfig() { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) }; } catch (e) { return { ...DEFAULTS }; } }
function saveConfig() { try { fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); } catch (e) { /* ignore */ } }
function log(s) {
  try { fs.appendFileSync(logPath, JSON.stringify({ startedAt: new Date(s.startedAt).toISOString(), machine: s.machine, staff: s.staff, amount: s.amount, status: s.status, endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null, matchedText: s.matchedText || null, autoTyped: false }) + '\n'); } catch (e) { /* ignore */ }
}
function send(msg) { lastMsg = msg; if (server) server.broadcast(msg); }
function push(state) { if (win && !win.isDestroyed()) win.webContents.send('qrlock:state', state); }
function hideWin() { if (win && !win.isDestroyed()) win.hide(); }

function openWin() {
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({ width: 380, height: 520, alwaysOnTop: true, autoHideMenuBar: true, title: 'QR ล็อกยอด', show: false,
      webPreferences: { preload: path.join(__dirname, 'preload-qrlock.js'), contextIsolation: true, nodeIntegration: false } });
    win.on('closed', () => { win = null; });
    win.loadFile(path.join(__dirname, 'ui.html'));
  }
  return win;
}
function showInput() {
  const w = openWin();
  const go = () => { push({ mode: 'input' }); w.show(); w.focus(); };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go();
}
function showWaiting(s) {
  const w = openWin();
  const go = () => { push({ mode: 'waiting', amount: s.amount, payload: s.payload, expiresAt: s.expiresAt, onDisplay: !!(server && server.clientCount() > 0) }); w.show(); w.focus(); };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go); else go();
}

function onSessionChange(s) {
  if (s.status === 'WAITING') return;
  log(s);
  if (s.status === 'PAID' || s.status === 'PAID_MANUAL') send({ type: 'paid', amount: s.amount });
  else if (s.status === 'EXPIRED') send({ type: 'expired' });
  else if (s.status === 'CANCELLED') { if (s.note !== 'replaced') send({ type: 'cancelled' }); }
  if (s.note !== 'replaced') { hideWin(); setTimeout(() => { if (!sessions.waiting()) send({ type: 'idle' }); }, 5000); }
}

async function start() {
  if (active) return;
  sessions = createSessions({ expirySec: cfg.expirySec, onChange: onSessionChange });
  server = createDisplayServer({ port: cfg.displayPort, getLastMessage: () => lastMsg, assetsDir: __dirname });
  try { await server.start(); } catch (e) { console.warn('[qrlock] display server failed:', e && e.message); server = null; }
  try { if (cfg.hotkey) globalShortcut.register(cfg.hotkey, () => { if (sessions.waiting()) showWaiting(sessions.waiting()); else showInput(); }); } catch (e) { console.warn('[qrlock] hotkey failed:', e && e.message); }
  timer = setInterval(() => { try { sessions.tick(); } catch (e) { /* ignore */ } }, 1000);
  active = true;
}
async function stop() {
  if (!active) return;
  active = false;
  clearInterval(timer); timer = null;
  try { if (cfg.hotkey) globalShortcut.unregister(cfg.hotkey); } catch (e) { /* ignore */ }
  try { sessions.cancel(); } catch (e) { /* ignore */ }
  if (server) { try { await server.stop(); } catch (e) { /* ignore */ } server = null; }
  hideWin();
}

const FW_RULE = 'POS Hero QR Display';
function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}
let linkWin = null;
function openLink() {
  if (linkWin && !linkWin.isDestroyed()) { linkWin.show(); linkWin.focus(); return; }
  linkWin = new BrowserWindow({ width: 360, height: 560, alwaysOnTop: true, autoHideMenuBar: true, title: 'เชื่อมจอลูกค้า',
    webPreferences: { preload: path.join(__dirname, 'preload-link.js'), contextIsolation: true, nodeIntegration: false } });
  linkWin.on('closed', () => { linkWin = null; });
  linkWin.loadFile(path.join(__dirname, 'link.html'));
}
let setWin = null;
function openSettings() {
  if (setWin && !setWin.isDestroyed()) { setWin.show(); setWin.focus(); return; }
  setWin = new BrowserWindow({ width: 460, height: 720, autoHideMenuBar: true, title: 'ตั้งค่า QR ล็อกยอด',
    webPreferences: { preload: path.join(__dirname, 'preload-settings.js'), contextIsolation: true, nodeIntegration: false } });
  setWin.on('closed', () => { setWin = null; });
  setWin.loadFile(path.join(__dirname, 'settings.html'));
}
async function applyConfig(input) {
  const n = { ...cfg, ...input };
  n.expirySec = Math.max(30, parseInt(n.expirySec, 10) || 180);
  n.warnAmountOver = Math.max(0, parseFloat(n.warnAmountOver) || 0);
  n.displayPort = parseInt(n.displayPort, 10);
  if (!(n.displayPort > 0 && n.displayPort < 65536)) return { ok: false, error: 'พอร์ตไม่ถูกต้อง' };
  n.hotkey = String(n.hotkey || '').trim();
  n.qrTemplate = String(n.qrTemplate || '').trim();
  n.transferCodes = (n.transferCodes || []).map(String);
  if (n.transferCodes.some((c) => !/^\d{2}$/.test(c))) return { ok: false, error: 'รหัสประเภทต้องเป็นตัวเลข 2 หลัก' };
  if (n.enabled) {
    const v = validateTemplate(n.qrTemplate);
    if (!v.ok) return { ok: false, error: 'ต้นแบบ QR ใช้ไม่ได้: ' + v.error };
    if (!n.transferCodes.length) return { ok: false, error: 'ต้องมีรหัสเงินโอนอย่างน้อย 1 รหัส' };
  }
  await stop();
  cfg = n; saveConfig();
  if (cfg.enabled) await start();
  try { if (ctx && ctx.onChange) ctx.onChange(); } catch (e) { /* ignore */ }
  return { ok: true };
}
function registerIpc() {
  ipcMain.handle('qrlock:cfg-load', () => cfg);
  ipcMain.handle('qrlock:cfg-validate', (_e, t) => { const v = validateTemplate(t); if (!v.ok) return v; try { return { ok: true, sample: buildQr(t, '1.00') }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('qrlock:cfg-save', (_e, c) => applyConfig(c || {}).catch((e) => ({ ok: false, error: e.message })));
  ipcMain.handle('qrlock:link-info', () => ({ ips: lanIps(), port: cfg.displayPort }));
  // กฎไฟร์วอลล์ TCP ของจอลูกค้าโดยเฉพาะ (แยกจากกฎ UDP ของช่องทางรับเงินเข้า ไม่แตะของเดิม)
  ipcMain.handle('qrlock:link-firewall', () => new Promise((resolve) => {
    const inner = "Remove-NetFirewallRule -DisplayName '" + FW_RULE + "' -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName '" + FW_RULE + "' -Direction Inbound -Protocol TCP -LocalPort " + (parseInt(cfg.displayPort, 10) || 8080) + " -Action Allow -Profile Any | Out-Null";
    const enc = Buffer.from(inner, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-Command', "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','" + enc + "'"], { timeout: 120000, windowsHide: true }, (err, _o, se) => {
      if (err) resolve({ ok: false, reason: /cancel/i.test(String(se)) ? 'ยกเลิกการขอสิทธิ์ admin' : String(se || err.message).trim() });
      else resolve({ ok: true });
    });
  }));
  ipcMain.handle('qrlock:submit', (_e, { code, amount, force } = {}) => {
    if (!active) return { error: 'ปิดอยู่' };
    if (!/^\d{2}$/.test(String(code))) return { error: 'รหัสต้องเป็นตัวเลข 2 หลัก' };
    if (!cfg.transferCodes.includes(String(code))) return { error: 'รหัส ' + code + ' ไม่ใช่เงินโอน' };
    let amt;
    try { amt = formatAmount(amount); } catch (e) { return { error: e.message }; }
    if (!force && cfg.warnAmountOver && parseFloat(amt) > cfg.warnAmountOver) return { warn: 'ยอด ' + amt + ' เกินเพดาน ' + cfg.warnAmountOver };
    let payload;
    try { payload = buildQr(cfg.qrTemplate, amt); } catch (e) { return { error: e.message }; }
    const s = sessions.create({ amount: amt, payload, machine: cfg.machineName });
    send({ type: 'show_qr', payload, amount: amt, shopName: cfg.shopName, expiresInSec: cfg.expirySec });
    showWaiting(s);
    return { ok: true };
  });
  ipcMain.on('qrlock:confirm-manual', () => { if (active) sessions.confirmManual(); });
  ipcMain.on('qrlock:cancel', () => { if (active) sessions.cancel(); });
  ipcMain.on('qrlock:close', () => { hideWin(); });
}

function init(context) {
  ctx = context;
  cfgPath = path.join(ctx.app.getPath('userData'), 'qrlock-config.json');
  logPath = path.join(ctx.app.getPath('userData'), 'qrlock-log.jsonl');
  cfg = loadConfig();
  registerIpc();
  if (cfg.enabled) {
    const v = validateTemplate(cfg.qrTemplate);
    if (!v.ok) { console.warn('[qrlock] ต้นแบบ QR ใช้ไม่ได้ ไม่เปิดระบบ:', v.error); return; }
    start();
  }
}
function shutdown() { try { stop(); } catch (e) { /* ignore */ } }
function trayItems() {
  return [{ label: '⚙️ ตั้งค่า QR ล็อกยอด', click: () => openSettings() },
  { label: '📱 เชื่อมจอลูกค้า (สแกนด้วยมือถือ)', click: () => {
    if (!active) { require('electron').dialog.showErrorBox('QR ล็อกยอด', 'ต้องเปิด "QR ล็อกยอด" ก่อน'); return; }
    openLink();
  } },
  { label: 'QR ล็อกยอด (เปิด/ปิด)', type: 'checkbox', checked: active, click: async () => {
    if (active) { cfg.enabled = false; saveConfig(); await stop(); return; }
    const v = validateTemplate(cfg.qrTemplate);
    if (!v.ok) { require('electron').dialog.showErrorBox('QR ล็อกยอด', 'ยังตั้งต้นแบบ QR ไม่ได้ (' + v.error + ')\nแก้ไฟล์ ' + cfgPath); return; }
    cfg.enabled = true; saveConfig(); await start();
  } }];
}
module.exports = { init, shutdown, trayItems };
