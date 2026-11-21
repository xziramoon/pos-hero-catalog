'use strict';
// ควบคุมมือถือ Android จากคอมผ่าน ADB (WiFi) — สลับไปแอปรับเงิน (ถุงเงิน/ไทยช่วยไทย) และกลับมาหน้าจอลูกค้า
// ใช้ adb ตัวทางการของ Google (platform-tools) ดาวน์โหลดมาไว้ใน userData ครั้งเดียว ไม่แตะ POS/ช่องทางรับเงิน
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const ZIP_URL = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
const ADDR_RE = /^[\w.\-]+:\d{2,5}$/;
const PKG_RE = /^[a-zA-Z][\w]*(\.[\w]+)+$/;

function parseDevices(out) {
  return String(out || '').split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2 && p[0])
    .map((p) => ({ id: p[0], state: p[1] }));
}
function parsePackages(out) {
  return String(out || '').split(/\r?\n/).map((l) => /^package:(.+)$/.exec(l.trim())).filter(Boolean).map((m) => m[1]).sort();
}
// คำสั่ง shell ที่ส่งเข้ามือถือ (แยกออกมาให้เทสต์ได้)
function launchArgs(pkg) { return ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']; }
function displayArgs(url) {
  // application_id ทำให้ Chrome ใช้แท็บเดิมแทนเปิดแท็บใหม่ทุกครั้ง
  return ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, '--es', 'com.android.browser.application_id', 'poshero.qrdisplay'];
}

function createPhone({ dir, getCfg, exec = execFile }) {
  const localAdb = () => path.join(dir, 'platform-tools', 'adb.exe');
  function adbPath() {
    const c = getCfg() || {};
    if (c.adbPath && fs.existsSync(c.adbPath)) return c.adbPath;
    if (fs.existsSync(localAdb())) return localAdb();
    return null;
  }
  function run(args, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const bin = adbPath();
      if (!bin) return resolve({ ok: false, out: '', error: 'ยังไม่มีโปรแกรม adb (กด "ดาวน์โหลด adb" ก่อน)' });
      exec(bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        const out = (String(stdout || '') + String(stderr || '')).trim();
        if (err) return resolve({ ok: false, out, error: err.killed ? 'หมดเวลา' : (out || err.message) });
        resolve({ ok: true, out });
      });
    });
  }
  async function install() {
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, 'platform-tools.zip');
    await new Promise((resolve, reject) => {
      const get = (url, hops) => https.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) { res.resume(); return get(res.headers.location, hops + 1); }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('ดาวน์โหลดไม่สำเร็จ (HTTP ' + res.statusCode + ')')); }
        const f = fs.createWriteStream(zip);
        res.pipe(f); f.on('finish', () => f.close(resolve)); f.on('error', reject);
      }).on('error', reject);
      get(ZIP_URL, 0);
    });
    await new Promise((resolve, reject) => {
      exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Expand-Archive -LiteralPath '" + zip + "' -DestinationPath '" + dir + "' -Force"],
        { timeout: 120000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    });
    try { fs.unlinkSync(zip); } catch (e) { /* ignore */ }
    if (!fs.existsSync(localAdb())) throw new Error('แตกไฟล์แล้วไม่พบ adb.exe');
    return { ok: true };
  }
  async function pair(addr, code) {
    if (!ADDR_RE.test(String(addr || ''))) return { ok: false, error: 'ที่อยู่ต้องเป็นรูปแบบ IP:พอร์ต เช่น 192.168.1.50:37123' };
    if (!/^\d{6}$/.test(String(code || ''))) return { ok: false, error: 'รหัสจับคู่ต้องเป็นตัวเลข 6 หลัก' };
    const r = await run(['pair', addr, String(code)], 15000);
    if (r.ok && !/successfully paired/i.test(r.out)) return { ok: false, error: r.out || 'จับคู่ไม่สำเร็จ' };
    return r;
  }
  async function connect(addr) {
    if (!ADDR_RE.test(String(addr || ''))) return { ok: false, error: 'ที่อยู่ต้องเป็นรูปแบบ IP:พอร์ต เช่น 192.168.1.50:5555' };
    const r = await run(['connect', addr], 10000);
    if (r.ok && !/connected to/i.test(r.out)) return { ok: false, error: r.out || 'เชื่อมต่อไม่สำเร็จ' };
    return r;
  }
  async function status() {
    const bin = adbPath();
    if (!bin) return { adb: false, devices: [] };
    const r = await run(['devices'], 6000);
    return { adb: true, devices: r.ok ? parseDevices(r.out) : [] };
  }
  // ถ้าเชื่อมอยู่แล้วใช้เลย ไม่งั้นลองต่อใหม่ 1 ครั้ง (WiFi หลุดบ่อยเมื่อมือถือหลับ)
  async function ensure() {
    const c = getCfg() || {};
    if (!c.address) return { ok: false, error: 'ยังไม่ได้ตั้งที่อยู่มือถือ' };
    const st = await status();
    if (!st.adb) return { ok: false, error: 'ยังไม่มีโปรแกรม adb' };
    if (st.devices.some((d) => d.id === c.address && d.state === 'device')) return { ok: true };
    const r = await connect(c.address);
    if (!r.ok) return { ok: false, error: r.error };
    const st2 = await status();
    return st2.devices.some((d) => d.id === c.address && d.state === 'device') ? { ok: true } : { ok: false, error: 'มือถือยังไม่อนุญาต (เปิดจอมือถือแล้วกดอนุญาต)' };
  }
  async function onPhone(args) {
    const e = await ensure();
    if (!e.ok) return e;
    const c = getCfg();
    return run(['-s', c.address, ...args], 10000);
  }
  async function listApps() { const r = await onPhone(['shell', 'pm', 'list', 'packages', '-3']); return r.ok ? { ok: true, apps: parsePackages(r.out) } : r; }
  async function openPay() {
    const c = getCfg() || {};
    if (!PKG_RE.test(String(c.payPackage || ''))) return { ok: false, error: 'ยังไม่ได้เลือกแอปรับเงินบนมือถือ' };
    return onPhone(launchArgs(c.payPackage));
  }
  async function openDisplay(url) {
    if (!/^https?:\/\/[\w.\-:]+\/display$/.test(String(url || ''))) return { ok: false, error: 'ที่อยู่จอลูกค้าไม่ถูกต้อง' };
    const r = await onPhone(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
    if (!r.ok) return r;
    return onPhone(displayArgs(url));
  }
  return { adbPath, install, pair, connect, status, listApps, openPay, openDisplay };
}

module.exports = { createPhone, parseDevices, parsePackages, launchArgs, displayArgs, ADDR_RE, PKG_RE };
