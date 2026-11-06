'use strict';
// เซียมซี: ข้อมูล 100 ใบ + ตรรกะตัดสินใจ + ไบต์ใบเสร็จเดิมต้องไม่เปลี่ยน
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const logic = require('../fortune/logic');
const fortunes = require('../fortune/fortunes.json');

// ---- ข้อมูล ----
assert.strictEqual(fortunes.length, 100);
const counts = { 上签: 0, 中签: 0, 下签: 0 };
fortunes.forEach((f, i) => {
  assert.strictEqual(f.n, i + 1);
  assert.ok(counts[f.level] !== undefined, 'level ' + f.level);
  counts[f.level]++;
  assert.strictEqual(f.zh.length, 4); assert.strictEqual(f.th.length, 4);
  assert.ok(f.meaning && f.money);
});
assert.deepStrictEqual(counts, { 上签: 23, 中签: 60, 下签: 17 });

// ---- สุ่ม: ปิดใบโชคร้าย = ไม่มี 下签 เลย (สุ่มจาก 83 ใบ) ----
const s = logic.normalizeSettings({ mode: 'on' });
assert.strictEqual(logic.allowedIndexes(fortunes, s).length, 83);
assert.strictEqual(logic.allowedIndexes(fortunes, { ...s, skipUnlucky: false }).length, 100);
for (let i = 0; i < 2000; i++) assert.notStrictEqual(fortunes[logic.pickIndex(fortunes, s)].level, '下签');

// ---- การตัดสินใจ ----
const on = logic.normalizeSettings({ mode: 'on' });
assert.strictEqual(logic.decideAction('Sea & Hill receipt #12', on), 'slip');
assert.strictEqual(logic.decideAction('POS Hero Receipt', on), 'skip');
assert.strictEqual(logic.decideAction('Z-Report', on), 'cut');
assert.strictEqual(logic.decideAction('Z-Report', { ...on, cutOthers: false }), 'skip');
assert.strictEqual(logic.decideAction('Sea & Hill', { ...on, mode: 'record' }), 'skip');
assert.strictEqual(logic.decideAction('Sea & Hill', { ...on, mode: 'off' }), 'skip');
// นอกช่วงวันที่ → ตัดอย่างเดียว (ใบเสร็จต้องถูกตัดเสมอ)
const jan = new Date(2027, 0, 15);
assert.strictEqual(logic.decideAction('Sea & Hill', { ...on, startDate: '2027-02-01' }, jan), 'cut');
assert.strictEqual(logic.decideAction('Sea & Hill', { ...on, endDate: '2027-01-14' }, jan), 'cut');
assert.strictEqual(logic.decideAction('Sea & Hill', { ...on, startDate: '2027-01-15', endDate: '2027-01-15' }, jan), 'slip');

// ---- ตั้งค่า / dedup ----
assert.strictEqual(logic.normalizeSettings({ mode: 'zzz' }).mode, 'off');
assert.strictEqual(logic.normalizeSettings({ startDate: 'bad' }).startDate, '');
assert.strictEqual(logic.DEFAULT_SETTINGS.skipUnlucky, true);
const d = logic.makeDedup(200);
for (let i = 0; i < 250; i++) d.add(i);
assert.strictEqual(d.seen(0), false); assert.strictEqual(d.seen(249), true); assert.strictEqual(d.seen(50), true);

// ---- buildEscPosRaster: ค่าเริ่มต้นต้องได้ไบต์เหมือนฉบับเดิมใน HEAD ทุกไบต์ ----
function extractFn(src) {
  const m = src.replace(/\r\n/g, '\n').match(/function buildEscPosRaster[\s\S]*?\n}\n/);
  assert.ok(m, 'buildEscPosRaster not found');
  return new vm.Script(`(${m[0]})`).runInNewContext({ Buffer, Math });
}
const root = path.join(__dirname, '..');
const current = extractFn(fs.readFileSync(path.join(root, 'main.js'), 'utf8'));
let original = null;
try { original = extractFn(execFileSync('git', ['show', 'origin/main:main.js'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 }).toString('utf8')); } catch (e) { /* ไม่มี git/origin — ข้ามส่วนเทียบ */ }
const W = 576, H = 300;
const bmp = Buffer.alloc(W * H * 4);
let seed = 12345;
for (let i = 0; i < bmp.length; i += 4) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const v = (seed >> 8) & 255; bmp[i] = bmp[i + 1] = bmp[i + 2] = v; bmp[i + 3] = 255; }
const cur = current(bmp, W, H);
if (original) assert.ok(cur.equals(original(bmp, W, H)), 'receipt bytes changed');
assert.deepStrictEqual([...cur.subarray(0, 2)], [0x1b, 0x40]);
assert.deepStrictEqual([...cur.subarray(cur.length - 7)], [0x1b, 0x64, 0x02, 0x1d, 0x56, 0x41, 0x00]);
const slip = current(bmp, W, H, { init: false, finish: false });
assert.deepStrictEqual([...slip.subarray(0, 3)], [0x1d, 0x76, 0x30]);
assert.strictEqual(slip.length, cur.length - 2 - 7);

console.log('fortune.test.js OK' + (original ? '' : ' (skipped HEAD compare)'));
