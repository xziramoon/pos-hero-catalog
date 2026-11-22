'use strict';
// QR-LOCK (ระยะ 1): หน้าต่างรับยอด + สร้าง QR + จอลูกค้า + ปุ่มยืนยันเอง/ยกเลิก
// โมดูลแยก ปิดได้ด้วย qrlock-config.json → enabled:false (ใน userData ไม่ลง git) พังตรงนี้ต้องไม่กระทบ POS
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { BrowserWindow, globalShortcut, ipcMain, Notification } = require('electron');
const { buildQr, validateTemplate, formatAmount } = require('./qr-builder');
const { createSessions } = require('./session');
const { createDisplayServer } = require('./display-server');
const { createMatcher } = require('./matcher');
const { runAutoType } = require('./autotype');
const { createPhone, ADDR_RE, PKG_RE } = require('./phone');
// จอลูกค้าแบบมีรายการสินค้า (อ่านจาก POS) — โหลดพังต้องไม่ทำให้ QR-LOCK เดิมหายไป
let cd = null;
try {
  cd = { createCartState: require('../customerdisplay/cart-state').createCartState, ...require('../customerdisplay/feed'),
    createReaderHost: require('../customerdisplay/reader-host').createReaderHost, ensureReader: require('../customerdisplay/build-reader').ensureReader,
    migrateConfig: require('../customerdisplay/migrate').migrateConfig };
} catch (e) { console.warn('[customerdisplay] load failed:', e && e.message); cd = null; }

const DEFAULTS = { enabled: false, machineName: 'เครื่อง 1', bank: '', qrTemplate: '', shopName: '', expirySec: 180, warnAmountOver: 10000, hotkey: 'F9', transferCodes: ['02'], displayPort: 8790, portMigrated: false, autoType: { enabled: false, windowTitleContains: '', keys: [] },
  phone: { enabled: false, adbPath: '', address: '', payPackage: '', payHotkey: 'Ctrl+F10', displayHotkey: 'Ctrl+F11', autoDisplayOnQr: false, autoDisplayAfterBill: false } };
const phoneCfg = () => ({ ...DEFAULTS.phone, ...(cfg.phone || {}) });
let phone = null, phoneKeys = [];
let ctx = null, cfg = { ...DEFAULTS }, win = null, server = null, sessions = null, timer = null, lastMsg = { type: 'idle' }, active = false;
let cfgPath = null, logPath = null, feed = null, reader = null;

function loadConfig() { try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) }; } catch (e) { return { ...DEFAULTS }; } }
function saveConfig() { try { fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); } catch (e) { /* ignore */ } }
function log(s, autoTyped) {
  try { fs.appendFileSync(logPath, JSON.stringify({ startedAt: new Date(s.startedAt).toISOString(), machine: s.machine, staff: s.staff, amount: s.amount, status: s.status, endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null, matchedText: s.matchedText || null, autoTyped: !!autoTyped }) + '\n'); } catch (e) { /* ignore */ }
}
function send(msg) { msg = { shopName: cfg.shopName || undefined, ...msg }; lastMsg = msg; if (feed) feed.setQr(msg); else if (server) server.broadcast(msg); }
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
  if (!(s.status === 'PAID' && cfg.autoType && cfg.autoType.enabled)) log(s, false);
  if (s.status === 'PAID' || s.status === 'PAID_MANUAL') send({ type: 'paid', amount: s.amount });
  else if (s.status === 'EXPIRED') send({ type: 'expired' });
  else if (s.status === 'CANCELLED') { if (s.note !== 'replaced') send({ type: 'cancelled' }); }
  if (s.status === 'PAID' && cfg.autoType && cfg.autoType.enabled) {
    hideWin();
    setTimeout(() => {
      runAutoType({ windowTitleContains: cfg.autoType.windowTitleContains, keys: cfg.autoType.keys, amount: s.amount }).then((r) => {
        log(s, r.ok);
        if (!r.ok) { try { new Notification({ title: 'เงินเข้าแล้ว ' + s.amount + ' ฿', body: 'กรุณากดรับชำระเอง (' + r.reason + ')' }).show(); } catch (e) { /* ignore */ } }
      }).catch(() => log(s, false));
    }, 150);
  }
  if (s.note !== 'replaced') { hideWin(); setTimeout(() => { if (!sessions.waiting()) send({ type: 'idle' }); }, 5000); }
}

// ---- ควบคุมมือถือ (ADB ผ่าน WiFi): ปุ่มลัดสลับไปแอปรับเงิน / กลับหน้าจอลูกค้า ----
function displayUrl() {
  const p = phoneCfg();
  const ips = lanIps();
  const peer = String(p.address || '').split(':')[0].split('.').slice(0, 3).join('.');
  const ip = ips.find((x) => peer && x.startsWith(peer + '.')) || ips[0];
  return ip ? 'http://' + ip + ':' + cfg.displayPort + '/display' : null;
}
function notifyPhoneFail(what, r) {
  try { new Notification({ title: 'สั่งมือถือไม่สำเร็จ', body: what + ': ' + ((r && r.error) || 'ไม่ทราบสาเหตุ') }).show(); } catch (e) { /* ignore */ }
}
async function phoneOpenPay() { const r = await phone.openPay(); if (!r.ok) notifyPhoneFail('เปิดแอปรับเงิน', r); return r; }
async function phoneOpenDisplay() {
  const u = displayUrl();
  const r = u ? await phone.openDisplay(u) : { ok: false, error: 'ไม่พบ IP ของคอม' };
  if (!r.ok) notifyPhoneFail('กลับหน้าจอลูกค้า', r);
  return r;
}
function registerPhoneKeys() {
  unregisterPhoneKeys();
  const p = phoneCfg();
  const failed = [];
  if (!p.enabled || !phone) return failed;
  [[p.payHotkey, phoneOpenPay], [p.displayHotkey, phoneOpenDisplay]].forEach(([k, fn]) => {
    if (!k) return;
    try { if (globalShortcut.register(k, () => { fn().catch(() => {}); })) phoneKeys.push(k); else failed.push(k); } catch (e) { failed.push(k); console.warn('[qrlock] phone hotkey failed:', e && e.message); }
  });
  return failed;
}
function unregisterPhoneKeys() { phoneKeys.forEach((k) => { try { globalShortcut.unregister(k); } catch (e) { /* ignore */ } }); phoneKeys = []; }
let phoneWin = null;
function openPhone() {
  if (phoneWin && !phoneWin.isDestroyed()) { phoneWin.show(); phoneWin.focus(); return; }
  phoneWin = new BrowserWindow({ width: 440, height: 860, autoHideMenuBar: true, title: 'ควบคุมมือถือ',
    webPreferences: { preload: path.join(__dirname, 'preload-phone.js'), contextIsolation: true, nodeIntegration: false } });
  phoneWin.on('closed', () => { phoneWin = null; });
  phoneWin.loadFile(path.join(__dirname, 'phone.html'));
}
async function savePhone(input) {
  const p = { ...phoneCfg(), ...(input || {}) };
  p.enabled = !!p.enabled; p.autoDisplayOnQr = !!p.autoDisplayOnQr; p.autoDisplayAfterBill = !!p.autoDisplayAfterBill;
  p.address = String(p.address || '').trim(); p.payPackage = String(p.payPackage || '').trim();
  p.payHotkey = String(p.payHotkey || '').trim(); p.displayHotkey = String(p.displayHotkey || '').trim();
  if (p.address && !ADDR_RE.test(p.address)) return { ok: false, error: 'ที่อยู่มือถือต้องเป็นรูปแบบ IP:พอร์ต' };
  if (p.payPackage && !PKG_RE.test(p.payPackage)) return { ok: false, error: 'ชื่อแพ็กเกจแอปไม่ถูกต้อง' };
  if (p.enabled && p.payHotkey && p.payHotkey === p.displayHotkey) return { ok: false, error: 'ปุ่มลัดสองปุ่มต้องไม่ซ้ำกัน' };
  if ([p.payHotkey, p.displayHotkey].includes(cfg.hotkey)) return { ok: false, error: 'ปุ่มลัดซ้ำกับปุ่มกรอกยอด (' + cfg.hotkey + ')' };
  cfg.phone = p; saveConfig();
  const failed = active ? registerPhoneKeys() : [];
  if (failed.length) return { ok: true, warn: 'ปุ่ม ' + failed.join(', ') + ' ใช้ไม่ได้ (โปรแกรมอื่นใช้อยู่) ลองเปลี่ยนปุ่ม' };
  if (p.enabled && !active) return { ok: true, warn: 'บันทึกแล้ว แต่ปุ่มลัดจะทำงานเมื่อเปิด "QR ล็อกยอด"' };
  return { ok: true };
}

async function start() {
  if (active) return;
  sessions = createSessions({ expirySec: cfg.expirySec, onChange: onSessionChange });
  feed = null; reader = null;
  if (cd) {
    try {
      feed = cd.createDisplayFeed({ cart: cd.createCartState({ log: (s) => console.warn('[customerdisplay]', s) }), send: (v) => { if (server) server.broadcast(v); },
        shopName: () => cfg.shopName || undefined,
        onBillSaved: () => { if (phone && cd.autoReturnEnabled(phoneCfg())) phoneOpenDisplay().catch(() => {}); } });
    } catch (e) { feed = null; console.warn('[customerdisplay] feed failed:', e && e.message); }
  }
  server = createDisplayServer({ port: cfg.displayPort, getLastMessage: () => (feed ? feed.current() : lastMsg), assetsDir: __dirname });
  try { await server.start(); } catch (e) { console.warn('[qrlock] display server failed:', e && e.message); server = null; }
  try { if (cfg.hotkey) globalShortcut.register(cfg.hotkey, () => { if (sessions.waiting()) showWaiting(sessions.waiting()); else showInput(); }); } catch (e) { console.warn('[qrlock] hotkey failed:', e && e.message); }
  timer = setInterval(() => { try { sessions.tick(); } catch (e) { /* ignore */ } try { if (feed) feed.tick(); } catch (e) { /* ignore */ } }, 1000);
  active = true;
  if (cd && feed && server) {
    try {
      const src = path.join(__dirname, '..', 'customerdisplay', 'posreader.cs').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
      reader = cd.createReaderHost({ resolveExe: () => cd.ensureReader({ srcPath: src, outDir: path.join(ctx.app.getPath('userData'), 'customerdisplay') }),
        onEvent: (e) => feed.onReaderEvent(e), onLog: (s) => console.warn('[customerdisplay]', s) });
      reader.start().catch(() => {});
    } catch (e) { reader = null; console.warn('[customerdisplay] reader failed:', e && e.message); }
  }
  registerPhoneKeys();
}
async function stop() {
  if (!active) return;
  active = false;
  clearInterval(timer); timer = null;
  try { if (reader) reader.stop(); } catch (e) { /* ignore */ } reader = null; feed = null;
  try { if (cfg.hotkey) globalShortcut.unregister(cfg.hotkey); } catch (e) { /* ignore */ }
  unregisterPhoneKeys();
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
  setWin = new BrowserWindow({ width: 460, height: 860, autoHideMenuBar: true, title: 'ตั้งค่า QR ล็อกยอด',
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
  const at = { ...DEFAULTS.autoType, ...(cfg.autoType || {}), ...(input.autoType || {}) };
  at.enabled = !!at.enabled; at.windowTitleContains = String(at.windowTitleContains || '').trim();
  at.keys = (Array.isArray(at.keys) ? at.keys : []).map((k) => String(k).trim()).filter(Boolean);
  n.autoType = at;
  if (at.enabled) {
    if (!at.windowTitleContains) return { ok: false, error: 'ต้องใส่ชื่อหน้าต่าง Sea & Hill' };
    try { require('./autotype').buildSteps(at.keys, '1.00'); } catch (e) { return { ok: false, error: 'ลำดับปุ่ม: ' + e.message }; }
  }
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
let logWin = null;
function openLog() {
  if (logWin && !logWin.isDestroyed()) { logWin.show(); logWin.focus(); return; }
  logWin = new BrowserWindow({ width: 640, height: 480, autoHideMenuBar: true, title: 'รายการ QR วันนี้',
    webPreferences: { preload: path.join(__dirname, 'preload-log.js'), contextIsolation: true, nodeIntegration: false } });
  logWin.on('closed', () => { logWin = null; });
  logWin.loadFile(path.join(__dirname, 'log.html'));
}
const matcher = createMatcher({ getBank: () => cfg.bank });
function registerIpc() {
  // แจ้งเตือนเงินเข้า (หลังกันซ้ำของ POS Hero แล้ว) → จับคู่กับ QR ที่รออยู่ ถ้าไม่ตรง/ไม่มี QR ไม่ทำอะไรเลย
  ipcMain.on('qrlock:payment', (_e, evt) => {
    try {
      if (!active || !evt || !sessions) return;
      const w = sessions.waiting();
      if (!w) return;
      const r = matcher({ amount: evt.amount, text: String(evt.text || '').slice(0, 300), ts: Number(evt.ts) || Date.now(), id: evt.id }, w);
      if (r.ok) sessions.markPaid(String(evt.text || '').trim().slice(0, 200));
    } catch (e) { /* ignore */ }
  });
  ipcMain.handle('qrlock:log-today', () => {
    try {
      const d = new Date().toDateString();
      return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
        .filter((r) => r && new Date(r.startedAt).toDateString() === d).reverse();
    } catch (e) { return []; }
  });
  ipcMain.handle('qrlock:cfg-load', () => cfg);
  ipcMain.handle('qrlock:cfg-validate', (_e, t) => { const v = validateTemplate(t); if (!v.ok) return v; try { return { ok: true, sample: buildQr(t, '1.00') }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle('qrlock:cfg-save', (_e, c) => applyConfig(c || {}).catch((e) => ({ ok: false, error: e.message })));
  ipcMain.handle('qrlock:link-info', () => ({ ips: lanIps(), port: cfg.displayPort }));
  // กฎไฟร์วอลล์ TCP ของจอลูกค้าโดยเฉพาะ (แยกจากกฎ UDP ของช่องทางรับเงินเข้า ไม่แตะของเดิม)
  ipcMain.handle('qrlock:link-firewall', () => new Promise((resolve) => {
    const inner = "Remove-NetFirewallRule -DisplayName '" + FW_RULE + "' -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName '" + FW_RULE + "' -Direction Inbound -Protocol TCP -LocalPort " + (parseInt(cfg.displayPort, 10) || 8790) + " -Action Allow -Profile Any | Out-Null";
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
    if (phone && phoneCfg().enabled && phoneCfg().autoDisplayOnQr) phoneOpenDisplay().catch(() => {});
    showWaiting(s);
    return { ok: true };
  });
  const guard = (fn) => async (_e, ...a) => { try { return await fn(...a); } catch (e) { return { ok: false, error: e.message }; } };
  ipcMain.handle('qrlock:phone-load', async () => ({ cfg: phoneCfg(), status: await phone.status() }));
  ipcMain.handle('qrlock:phone-save', guard((p) => savePhone(p)));
  ipcMain.handle('qrlock:phone-install', guard(() => phone.install()));
  ipcMain.handle('qrlock:phone-pair', guard((a, c) => phone.pair(a, c)));
  ipcMain.handle('qrlock:phone-connect', guard((a) => phone.connect(a)));
  ipcMain.handle('qrlock:phone-apps', guard(() => phone.listApps()));
  ipcMain.handle('qrlock:phone-open-pay', guard(() => phone.openPay()));
  ipcMain.handle('qrlock:phone-open-display', guard(() => { const u = displayUrl(); return u ? phone.openDisplay(u) : { ok: false, error: 'ไม่พบ IP ของคอม' }; }));
  ipcMain.on('qrlock:confirm-manual', () => { if (active) sessions.confirmManual(); });
  ipcMain.on('qrlock:cancel', () => { if (active) sessions.cancel(); });
  ipcMain.on('qrlock:close', () => { hideWin(); });
}

function init(context) {
  ctx = context;
  cfgPath = path.join(ctx.app.getPath('userData'), 'qrlock-config.json');
  logPath = path.join(ctx.app.getPath('userData'), 'qrlock-log.jsonl');
  cfg = loadConfig();
  if (cd) { // ย้ายพอร์ตเดิมไปพอร์ตใหม่ครั้งเดียว (ดู migrate.js; บันทึกเฉพาะเมื่อมีไฟล์ตั้งค่าอยู่แล้ว)
    try { const had = fs.existsSync(cfgPath); cfg = { ...cfg, ...cd.migrateConfig(cfg) }; if (had) saveConfig(); } catch (e) { /* ignore */ }
  }
  phone = createPhone({ dir: path.join(ctx.app.getPath('userData'), 'adb'), getCfg: phoneCfg });
  registerIpc();
  if (cfg.enabled) {
    const v = validateTemplate(cfg.qrTemplate);
    if (!v.ok) { console.warn('[qrlock] ต้นแบบ QR ใช้ไม่ได้ ไม่เปิดระบบ:', v.error); return; }
    start();
  }
}
function shutdown() { try { stop(); } catch (e) { /* ignore */ } }
function trayItems() {
  return [{ label: '📒 รายการ QR วันนี้', click: () => openLog() },
  { label: '⚙️ ตั้งค่า QR ล็อกยอด', click: () => openSettings() },
  { label: '📲 ควบคุมมือถือ (สลับแอปรับเงิน)', click: () => openPhone() },
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
