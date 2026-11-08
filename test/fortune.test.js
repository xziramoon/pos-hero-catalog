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
assert.strictEqual(logic.decideAction('document', on), 'slip');
assert.strictEqual(logic.decideAction('POS Hero Receipt', on), 'skip');
assert.strictEqual(logic.decideAction('Z-Report', on), 'cut');
assert.strictEqual(logic.decideAction('Local Downlevel Document', on), 'cut'); // มีคำว่า document แต่ไม่ใช่ใบเสร็จ
assert.strictEqual(logic.decideAction('DOCUMENT', on), 'slip');
assert.strictEqual(logic.matchesReceipt('Sea & Hill #1', 'Sea*'), true);
assert.strictEqual(logic.matchesReceipt('my receipt', '*receipt'), true);
assert.strictEqual(logic.matchesReceipt('my receipt x', '*receipt'), false);
assert.strictEqual(logic.matchesReceipt('a Hill b', '*hill*'), true);
assert.strictEqual(logic.matchesReceipt('x', '*'), false);
assert.strictEqual(logic.decideAction('Z-Report', { ...on, cutOthers: false }), 'skip');
assert.strictEqual(logic.decideAction('document', { ...on, mode: 'record' }), 'skip');
assert.strictEqual(logic.decideAction('document', { ...on, mode: 'off' }), 'skip');
// นอกช่วงวันที่ → ตัดอย่างเดียว (ใบเสร็จต้องถูกตัดเสมอ)
const jan = new Date(2027, 0, 15);
assert.strictEqual(logic.decideAction('document', { ...on, startDate: '2027-02-01' }, jan), 'cut');
assert.strictEqual(logic.decideAction('document', { ...on, endDate: '2027-01-14' }, jan), 'cut');
assert.strictEqual(logic.decideAction('document', { ...on, startDate: '2027-01-15', endDate: '2027-01-15' }, jan), 'slip');

// ---- ตั้งค่า / dedup ----
assert.strictEqual(logic.normalizeSettings({ mode: 'zzz' }).mode, 'off');
assert.strictEqual(logic.normalizeSettings({ startDate: 'bad' }).startDate, '');
assert.strictEqual(logic.DEFAULT_SETTINGS.skipUnlucky, true);
let clock = 0;
const d = logic.makeDedup(200, 600000, () => clock);
for (let i = 0; i < 250; i++) d.add(i);
assert.strictEqual(d.seen(0), false); assert.strictEqual(d.seen(249), true); assert.strictEqual(d.seen(50), true);
clock = 600001; // เลขงานวนกลับหลังผ่านไปนาน → ต้องไม่ถูกมองว่าซ้ำ
assert.strictEqual(d.seen(249), false);

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

// ---- ธีมใบเซียมซี ----
{
  const base = logic.normalizeSettings({ mode: 'on', krathongStart: '2026-11-22', krathongEnd: '2026-11-26' });
  assert.strictEqual(logic.activeTheme(base, new Date(2026, 10, 8)), 'newyear');
  assert.strictEqual(logic.activeTheme(base, new Date(2026, 10, 22)), 'krathong'); // รวมวันเริ่ม
  assert.strictEqual(logic.activeTheme(base, new Date(2026, 10, 26)), 'krathong'); // รวมวันจบ
  assert.strictEqual(logic.activeTheme(base, new Date(2026, 10, 27)), 'newyear');
  assert.strictEqual(logic.activeTheme({ ...base, theme: 'krathong' }, new Date(2026, 0, 1)), 'krathong');
  assert.strictEqual(logic.activeTheme({ ...base, theme: 'newyear' }, new Date(2026, 10, 24)), 'newyear');
  assert.strictEqual(logic.activeTheme({ ...base, krathongStart: '' }, new Date(2026, 10, 24)), 'newyear');
  assert.strictEqual(logic.normalizeSettings({ theme: 'zzz' }).theme, 'auto');
  const ro = logic.renderOptions(base, new Date(2026, 10, 24));
  assert.strictEqual(ro.theme, 'krathong'); assert.ok(ro.footer.includes('ลอยกระทง'));
  assert.ok(logic.renderOptions(base, new Date(2026, 10, 8)).footer.includes('ปีใหม่'));
}

// ---- batcher: ตัดครั้งเดียวตอนคิวเงียบ ----
{
  let t = 0; const timers = [];
  const flushes = [];
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const nxt = timers.find((x) => x.at <= end);
      if (!nxt) break;
      timers.splice(timers.indexOf(nxt), 1); t = nxt.at; nxt.fn();
    }
    t = end;
  };
  const mk = () => logic.makeBatcher({
    now: () => t, setT: (fn, ms) => { const o = { fn, at: t + ms }; timers.push(o); return o; },
    clearT: (o) => { const i = timers.indexOf(o); if (i >= 0) timers.splice(i, 1); }, onFlush: (e) => flushes.push(e.map((x) => x.id))
  });
  // 1) งานเดียว: ตัดหลังเงียบ 600 มิลลิวินาที
  let b = mk(); b.added(1); b.finished({ id: 1 }); advance(599); assert.deepStrictEqual(flushes, []); advance(2); assert.deepStrictEqual(flushes, [[1]]);
  // 2) งานแทรก (149) ซ้อนกับใบเสร็จ (150): ชุดเดียว ตัดครั้งเดียวหลังใบเสร็จจบ
  flushes.length = 0; b = mk();
  b.added(149); b.added(150); advance(10); b.finished({ id: 149 }); advance(900); assert.deepStrictEqual(flushes, [], 'ต้องรอเพราะ 150 ยังพิมพ์อยู่');
  b.finished({ id: 150 }); advance(700); assert.deepStrictEqual(flushes, [[149, 150]]);
  // 3) งานค้างไม่จบ: รอไม่เกิน maxWait แล้วตัดอยู่ดี
  flushes.length = 0; b = mk();
  b.added(1); b.added(2); b.finished({ id: 1 }); advance(7000); assert.deepStrictEqual(flushes, []); advance(2000); assert.deepStrictEqual(flushes, [[1]]);
  // 4) งานเข้าคิวหลังจบแต่ก่อนครบเวลาเงียบ: รวมชุดเดียวกัน
  flushes.length = 0; b = mk();
  b.finished({ id: 1 }); advance(300); b.added(2); advance(300); b.finished({ id: 2 }); advance(700); assert.deepStrictEqual(flushes, [[1, 2]]);
  console.log('batcher OK');
}

console.log('fortune.test.js OK' + (original ? '' : ' (skipped HEAD compare)'));

// ---- รายงานงานพิมพ์ ----
{
  const t0 = '2026-11-06T08:06:00.0000000+07:00', t1 = '2026-11-06T08:06:03.5000000+07:00';
  const rep = logic.buildReportText([
    JSON.stringify({ e: 'added', id: 7, doc: 'Receipt POS01261106-00043', status: 'Spooling', t: t0 }),
    JSON.stringify({ e: 'gone', id: 7, doc: 'Receipt POS01261106-00043', lastStatus: 'Printing', done: false, t: t1 }),
    '# slip failed', 'not json'
  ], { 'โหมด': 'record' });
  assert.ok(rep.includes('Receipt POS01261106-00043') && rep.includes('3.5') && rep.includes('โหมด: record'));
  // เลขงานวนกลับ: id 7 จบแล้ว แล้วมี id 7 ใหม่ภายหลัง ต้องไม่ได้เวลาติดลบ และนับเป็น 2 งาน
  const t2 = '2026-11-06T12:00:00.0000000+07:00', t3 = '2026-11-06T12:00:01.0000000+07:00';
  const rep2 = logic.buildReportText([
    JSON.stringify({ e: 'added', id: 7, doc: 'document', t: t0 }), JSON.stringify({ e: 'gone', id: 7, doc: 'document', lastStatus: 'Spooling', t: t1 }),
    JSON.stringify({ e: 'added', id: 7, doc: 'document', t: t2 }), JSON.stringify({ e: 'gone', id: 7, doc: 'document', lastStatus: 'Spooling', t: t3 })
  ]);
  assert.ok(!rep2.includes('| -'), 'negative duration');
  assert.ok(rep2.includes('"document" → 2'));
  console.log('report OK');
}
