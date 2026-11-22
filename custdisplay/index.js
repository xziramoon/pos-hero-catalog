'use strict';
// จอลูกค้าแสดงรายการสินค้า: รัน pos-reader.ps1 (อ่านจอ Sea & Hill POS อย่างเดียว) → logic.js → qrlock.showCart()
// โมดูลแยก ปิดได้ (ค่าเริ่มต้น = ปิด) พัง/ปิดแล้วต้องไม่กระทบ POS Hero / รับเงิน / QR ล็อกยอด
// ไม่ require electron ตรงนี้ (รับ app/qrlock/spawn ผ่าน init) เพื่อให้เขียนเทสต์ได้
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const logic = require('./logic');

const LOG_MAX = 2 * 1024 * 1024; // เกินนี้ตัดไฟล์ log ใหม่ (ข้อมูลอยู่ในเครื่อง ไม่ขึ้น git)
let ctx = null, qrlock = null, spawnFn = null, enabled = false, running = false;
let cfgPath = null, logPath = null, onChange = null;
let child = null, rl = null, restartTimer = null, wakeTimer = null, failures = 0, spawnedAt = 0;
let st = logic.createState(), lastKey = null, replayTimers = [], starting = false;

function readCfg() { try { return { enabled: false, ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')) }; } catch (e) { return { enabled: false }; } }
function saveCfg(c) { try { fs.writeFileSync(cfgPath, JSON.stringify(c, null, 2)); } catch (e) { /* ignore */ } }

function readerPath() {
  return ctx.app && ctx.app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'custdisplay', 'pos-reader.ps1')
    : path.join(__dirname, 'pos-reader.ps1');
}

function appendLog(ev) {
  if (!logPath) return;
  try {
    try { if (fs.statSync(logPath).size > LOG_MAX) fs.writeFileSync(logPath, ''); } catch (e) { /* ยังไม่มีไฟล์ */ }
    fs.appendFileSync(logPath, JSON.stringify({ ts: Date.now(), ev }) + '\n');
  } catch (e) { /* ignore */ }
}

// ส่งไปที่จอเฉพาะตอนข้อความเปลี่ยน แล้วตั้ง timer ให้หน้าขอบคุณกลับหน้าต้อนรับเอง
function push() {
  try {
    const now = Date.now();
    const v = logic.view(st, now);
    const key = JSON.stringify(v);
    if (key !== lastKey) { lastKey = key; qrlock.showCart(v); }
    clearTimeout(wakeTimer); wakeTimer = null;
    const w = logic.nextWakeup(st, now);
    if (w) wakeTimer = setTimeout(push, Math.max(50, w - now) + 20);
  } catch (e) { console.warn('[custdisplay] push failed:', e && e.message); }
}

function onEvent(ev, record = true) {
  try {
    if (record) appendLog(ev);
    logic.reduce(st, ev, Date.now());
    push();
  } catch (e) { console.warn('[custdisplay] event failed:', e && e.message); }
}

function onLine(line) {
  const s = String(line).replace(/^﻿/, '').trim();
  if (!s || s[0] !== '{') return;
  let ev; try { ev = JSON.parse(s); } catch (e) { return; }
  onEvent(ev);
}

function spawnReader() {
  if (!running) return;
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', readerPath(), '-ParentPid', String(process.pid)];
  try {
    child = spawnFn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { console.warn('[custdisplay] spawn failed:', e && e.message); child = null; failures++; return scheduleRestart(); }
  spawnedAt = Date.now();
  const me = child;
  if (me.stdout) { me.stdout.setEncoding && me.stdout.setEncoding('utf8'); rl = readline.createInterface({ input: me.stdout }); rl.on('line', onLine); }
  if (me.stderr) me.stderr.on('data', () => {}); // กันบัฟเฟอร์เต็ม
  me.on('error', (e) => { console.warn('[custdisplay] reader error:', e && e.message); });
  me.on('exit', () => {
    if (child === me) { child = null; if (rl) { try { rl.close(); } catch (e) { /* ignore */ } rl = null; } }
    if (!running) return;
    onEvent({ t: 'pos_missing' }, false); // reader ตาย: เคลียร์จอ ไม่ให้ค้างรายการเก่า
    failures = Date.now() - spawnedAt > 10000 ? 0 : failures + 1; // รันนานพอแล้วค่อยนับใหม่
    scheduleRestart();
  });
}
function scheduleRestart() {
  if (!running) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(spawnReader, Math.min(30000, 1000 * Math.pow(2, Math.min(Math.max(failures - 1, 0), 5))));
}
function killReader() {
  clearTimeout(restartTimer); restartTimer = null;
  if (rl) { try { rl.close(); } catch (e) { /* ignore */ } rl = null; }
  if (child) { const c = child; child = null; try { c.kill(); } catch (e) { /* ignore */ } }
}

// โหมดเล่นซ้ำ: ตั้ง "replayFile" ใน custdisplay-config.json เป็นไฟล์ log.jsonl เพื่อพัฒนาหน้าเว็บโดยไม่ต้องยิงสินค้าจริง
function startReplay(file) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { console.warn('[custdisplay] replay failed:', e && e.message); return false; }
  if (!lines.length) return false;
  const t0 = lines[0].ts;
  lines.forEach((r) => replayTimers.push(setTimeout(() => onEvent(r.ev, false), Math.min(r.ts - t0, 10 * 60 * 1000))));
  return true;
}

async function start() {
  if (running || starting) return;
  starting = true;
  let port = null;
  try { port = await qrlock.enableCartDisplay(true); } finally { starting = false; }
  if (!port) { console.warn('[custdisplay] display server unavailable'); await qrlock.enableCartDisplay(false); return false; }
  if (!enabled) { await qrlock.enableCartDisplay(false); return false; } // ถูกปิดระหว่างรอเซิร์ฟเวอร์
  running = true; failures = 0; st = logic.createState(); lastKey = null;
  const c = readCfg();
  if (c.replayFile && startReplay(c.replayFile)) return true;
  spawnReader();
  return true;
}
async function stop() {
  if (!running) return;
  running = false;
  killReader();
  replayTimers.forEach(clearTimeout); replayTimers = [];
  clearTimeout(wakeTimer); wakeTimer = null;
  try { await qrlock.enableCartDisplay(false); } catch (e) { /* ignore */ }
}

function init(context) {
  ctx = context; qrlock = context.qrlock; onChange = context.onChange || null;
  spawnFn = context.spawn || require('child_process').spawn;
  const dir = ctx.app.getPath('userData');
  cfgPath = path.join(dir, 'custdisplay-config.json');
  logPath = path.join(dir, 'custdisplay-log.jsonl');
  enabled = !!readCfg().enabled;
  if (enabled) start().catch((e) => console.warn('[custdisplay] start failed:', e && e.message));
}
function shutdown() { try { running = false; killReader(); replayTimers.forEach(clearTimeout); clearTimeout(wakeTimer); } catch (e) { /* ignore */ } }
function trayItems() {
  return [{ label: 'จอลูกค้า: แสดงรายการสินค้า (เปิด/ปิด)', type: 'checkbox', checked: enabled, click: async () => {
    enabled = !enabled;
    const c = readCfg(); c.enabled = enabled; saveCfg(c);
    try { if (enabled) await start(); else await stop(); } catch (e) { console.warn('[custdisplay] toggle failed:', e && e.message); }
    try { if (onChange) onChange(); } catch (e) { /* ignore */ }
  } }];
}
module.exports = { init, shutdown, trayItems, _state: () => ({ running, enabled }) };
