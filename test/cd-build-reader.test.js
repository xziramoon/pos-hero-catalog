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
