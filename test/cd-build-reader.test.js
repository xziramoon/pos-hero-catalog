'use strict';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { findCsc, ensureReader } = require('../customerdisplay/build-reader');

if (process.platform !== 'win32' || !findCsc()) { console.log('cd-build-reader: skipped (no csc)'); process.exit(0); }
(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-reader-'));
  const src = path.join(__dirname, '..', 'customerdisplay', 'posreader.cs');
  const exe = await ensureReader({ srcPath: src, outDir });
  assert.ok(exe && fs.existsSync(exe), 'exe built');
  const m1 = fs.statSync(exe).mtimeMs;
  const again = await ensureReader({ srcPath: src, outDir });
  assert.strictEqual(again, exe); assert.strictEqual(fs.statSync(exe).mtimeMs, m1, 'not rebuilt when source unchanged');
  assert.strictEqual(await ensureReader({ srcPath: path.join(outDir, 'missing.cs'), outDir: path.join(outDir, 'x') }), null, 'bad source → null, no throw');
  // รันจริง 1.5 วินาที: ไม่มี POS ต้องส่ง pos_missing (ถ้าเครื่องนี้เปิด POS อยู่ก็ยอมรับ main) และไม่ crash
  const out = await new Promise((resolve) => {
    const c = spawn(exe, []); let s = ''; let exited = null;
    c.stdout.on('data', (d) => { s += d; }); c.on('exit', (code) => { exited = code; });
    setTimeout(() => { c.kill(); resolve({ s, exited }); }, 1500);
  });
  assert.strictEqual(out.exited, null, 'still running (no crash)');
  const lines = out.s.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.length >= 1 && lines.every((l) => ['pos_missing', 'main', 'pay', 'pay_closed'].includes(l.t)), out.s);
  console.log('cd-build-reader: ok (' + lines.map((l) => l.t).join(',') + ')');
})().catch((e) => { console.error(e); process.exit(1); });

// คอมไพล์ล้มเหลวชั่วคราว (ไฟล์ถูกล็อก/สแกนไวรัส) ต้องลองใหม่ได้ ไม่ใช่ยอมแพ้ตั้งแต่ครั้งแรก
(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-retry-'));
  const src = path.join(__dirname, '..', 'customerdisplay', 'posreader.cs');
  let calls = 0; const real = require('child_process').execFile;
  const flaky = (bin, args, opts, cb) => { calls++; if (calls === 1) return cb(new Error('CS1569 locked')); return real(bin, args, opts, cb); };
  const exe = await ensureReader({ srcPath: src, outDir, exec: flaky, retryMs: 10 });
  assert.ok(exe && fs.existsSync(exe), 'built after one transient failure'); assert.strictEqual(calls, 2);
  const always = (bin, args, opts, cb) => cb(new Error('nope'));
  assert.strictEqual(await ensureReader({ srcPath: src, outDir: path.join(outDir, 'z'), exec: always, retryMs: 10 }), null, 'gives up after retries');
  console.log('cd-build-reader retry: ok');
})().catch((e) => { console.error(e); process.exit(1); });

// พาธที่มี / ปนกับ \ (csc อ่านผิด) ต้องยังคอมไพล์ได้
(async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-slash-'));
  const BS = String.fromCharCode(92);
  const mixed = path.join(__dirname, '..', 'customerdisplay') + '/posreader.cs'; // โฟลเดอร์ใช้ \ ท้ายพาธใช้ /
  assert.ok(mixed.includes('/') && mixed.includes(BS));
  const exe = await ensureReader({ srcPath: mixed, outDir: outDir + '/sub', retryMs: 10 });
  assert.ok(exe && fs.existsSync(exe), 'builds with forward-slash paths');
  console.log('cd-build-reader slash: ok');
})().catch((e) => { console.error(e); process.exit(1); });
