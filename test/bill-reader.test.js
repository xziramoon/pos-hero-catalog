'use strict';
// ทดสอบตัวอ่านบิลด้วย EMF จำลองที่สร้างขึ้นเอง (ไม่ใส่ไฟล์บิลจริงของร้านลงในโค้ด)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../fortune/bill-reader');
const { createBillSource } = require('../fortune/bill-source');

// ---- ตัวสร้าง EMF จำลอง: นำหน้า 44 ไบต์ (หัว spool) + EMR_HEADER (มี ' EMF' ที่ offset 40) + ข้อความ + EOF
function rec(type, body) { const b = Buffer.alloc(8 + body.length); b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length, 4); body.copy(b, 8); return b; }
function emfHeader() { const body = Buffer.alloc(96); body.write(' EMF', 32, 'latin1'); return rec(1, body); }
function extTextW(x, y, ids, glyph) { // EMR_EXTTEXTOUTW
  const body = Buffer.alloc(68 + ids.length * 2);
  body.writeInt32LE(x, 28); body.writeInt32LE(y, 32); body.writeUInt32LE(ids.length, 36); body.writeUInt32LE(76, 40); body.writeUInt32LE(glyph ? 0x10 : 0, 44);
  ids.forEach((v, i) => body.writeUInt16LE(v, 68 + i * 2));
  return rec(84, body);
}
function smallText(x, y, ids) { // EMR_SMALLTEXTOUT (glyph index, no rect)
  const body = Buffer.alloc(28 + ids.length * 2);
  body.writeInt32LE(x, 0); body.writeInt32LE(y, 4); body.writeUInt32LE(ids.length, 8); body.writeUInt32LE(0x110, 12);
  ids.forEach((v, i) => body.writeUInt16LE(v, 28 + i * 2));
  return rec(108, body);
}
const u = (s) => [...s].map((c) => c.charCodeAt(0));
const emf = (records) => Buffer.concat([Buffer.alloc(44), emfHeader(), ...records, rec(14, Buffer.alloc(12))]);

// ---- 1) ข้อความ Unicode ตรง ๆ (EXTTEXTOUTW): แยกบรรทัด จับรายการ จำนวน ยอดรวม เลขที่บิล
const plain = emf([
  extTextW(4, 25, u('UNG LUK SENG')),
  extTextW(4, 104, u('ไทลินอล 500มก.')),
  extTextW(4, 134, u('17.00 X 2')), extTextW(481, 134, u('34.00')),
  extTextW(4, 164, u('สําลีก้านใหญ่ ตราพยาบาล')),
  extTextW(4, 194, u('28.00 X 1')), extTextW(481, 194, u('28.00')),
  extTextW(4, 230, u('2 รายการ 3.00 ชิ้น')), extTextW(481, 230, u('62.00')),
  extTextW(4, 260, u('ชําระด้วยเงินโอน')), extTextW(481, 260, u('62.00')),
  extTextW(4, 290, u('เลขที่:POS01261118-00157')),
  extTextW(4, 320, u('วันที่:18-11-2569@12:18'))
]);
const bill = R.readBill(plain, { cmaps: {} });
assert.ok(bill, 'ต้องอ่านเป็นบิลได้');
assert.strictEqual(bill.items.length, 2);
assert.deepStrictEqual(bill.items[0], { name: 'ไทลินอล 500มก.', unit: 17, qty: 2, total: 34 });
assert.strictEqual(bill.items[1].qty, 1);
assert.strictEqual(bill.total, 62);
assert.strictEqual(bill.payment, 'transfer');
assert.strictEqual(bill.billNo, 'POS01261118-00157');
assert.strictEqual(bill.date, '18-11-2569 12:18');

// ---- 2) ไม่ใช่บิล: คำสั่งเปิดลิ้นชัก / ไฟล์เปล่า / ขยะ → null ไม่ throw
assert.strictEqual(R.readBill(Buffer.from([0x1b, 0x70, 0, 0x19, 0xfa])), null);
assert.strictEqual(R.readBill(Buffer.alloc(65536)), null);
assert.strictEqual(R.readBill(Buffer.from('hello world, not an emf at all')), null);
assert.strictEqual(R.readBill(emf([extTextW(4, 10, u('no items here'))])), null);
// ไฟล์ถูกตัดกลางคัน (ยังเขียนไม่เสร็จ) ต้องไม่ throw
assert.doesNotThrow(() => R.readBill(plain.subarray(0, plain.length - 40), { cmaps: {} }));

// ---- 3) glyph index: ใช้ cmap ของ Tahoma จริงถ้ามีในเครื่อง (ข้ามถ้าไม่มี) — สร้าง glyph จากตารางย้อนกลับ
const fonts = R.loadFonts();
if (fonts['tahoma.ttf'] && fonts['tahoma.ttf'].size > 1000) {
  const uni2g = new Map(); for (const [g, c] of fonts['tahoma.ttf']) if (!uni2g.has(c)) uni2g.set(c, g);
  const gl = (s) => [...s].map((c) => uni2g.get(c.codePointAt(0)));
  // smallText ต้องเป็นตัวอักษรต่อ record: แยกเป็นทีละตัวเพื่อเลียนแบบ POS จริง
  const perChar = (x0, y, str) => [...str].map((c, i) => smallText(x0 + i * 13, y, [uni2g.get(c.codePointAt(0))]));
  const g2 = emf([...perChar(4, 104, 'ทิชชู่ 90'), smallText(4, 134, gl('10.00 X 3')), smallText(481, 134, gl('30.00')),
    extTextW(4, 164, gl('เลขที่:POS01261118-00200'), true), ...perChar(4, 200, '1 รายการ 3.00 ชิ้น'), smallText(481, 200, gl('30.00'))]);
  const b2 = R.readBill(g2);
  assert.ok(b2, 'glyph bill');
  assert.strictEqual(R.normThai(b2.items[0].name), R.normThai('ทิชชู่ 90'));
  assert.strictEqual(b2.items[0].qty, 3); assert.strictEqual(b2.total, 30); assert.strictEqual(b2.billNo, 'POS01261118-00200');
} else console.log('ข้ามเทสต์ glyph (ไม่พบฟอนต์ Tahoma)');

// ---- 4) จับคู่ชื่อกับแคตตาล็อก: ทนสระ/วรรณยุกต์ที่เพี้ยน, ห้ามจับคู่ผิดตัวเมื่อกำกวม
const catalog = [
  { id: 'c1', name: 'ไทลินอล 500มก.' },
  { id: 'c2', name: 'ลอรีเอะ ซอฟท์แอนด์เซฟ แม็กซ์ 20ชิ้น' },
  { id: 'c3', name: 'ฟาร์มเฮ้าส์ ขนมปังไส้เนยน้ำตาล 45กรัม' },
  { id: 'c4', name: 'ฟาร์มเฮ้าส์ ขนมปังไส้ถั่วแดง 50กรัม' }
];
const m = R.createMatcher(catalog);
assert.strictEqual(m('ไทลินอล 500มก.').id, 'c1');
assert.strictEqual(m('ลอรเีอะ ซอฟทแ์อนดเ์ซฟ แม็กซ ี�20ชนิ�').id, 'c2', 'ชื่อเพี้ยนจาก glyph ยังจับคู่ได้');
assert.strictEqual(m('ฟารม์เฮา้ส ์ขนมปังไสถ้ั�วแดง 50กรัม').id, 'c4');
assert.strictEqual(m('ฟาร์มเฮ้าส์'), null, 'สั้นไป/กำกวม → ไม่เดา');
assert.strictEqual(m('สินค้าที่ไม่มีในแคตตาล็อก'), null);
assert.strictEqual(m(''), null);
const bk = R.billToBasket({ items: [{ name: 'ไทลินอล 500มก.', qty: 2 }, { name: 'ไทลินอล 500มก.', qty: 1 }, { name: 'ของแปลก', qty: 1 }] }, catalog);
assert.deepStrictEqual(bk.matched, [{ itemId: 'c1', name: 'ไทลินอล 500มก.', qty: 3 }]);
assert.deepStrictEqual(bk.unmatched, ['ของแปลก']);

// ---- 5) bill-source: ไฟล์ที่ยังเปลี่ยนอยู่ไม่ถูกคิว, นิ่งแล้วถึงคิว, เลขที่บิลซ้ำไม่ออกซ้ำ, ไฟล์ขยะข้าม
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billsrc-'));
let t = 1e9; const readBill = (b) => R.readBill(b, { cmaps: {} });
const src = createBillSource({ dir, readBill, now: () => t, settleMs: 1000 });
fs.writeFileSync(path.join(dir, 'a-FP1.SPL'), Buffer.alloc(65536)); // จองเป็นศูนย์
fs.writeFileSync(path.join(dir, 'a-00240.SPL'), Buffer.from([0x1b, 0x70, 0, 0x19, 0xfa]));
src.poll(); assert.strictEqual(src.pending(), 0);
fs.writeFileSync(path.join(dir, 'a-FP1.SPL'), Buffer.concat([plain, Buffer.alloc(2000)]));
t += 100; src.poll(); assert.strictEqual(src.pending(), 0, 'ยังไม่นิ่ง'); assert.strictEqual(src.unsettled(), 1);
t += 1200; src.poll(); assert.strictEqual(src.pending(), 1);
t += 100; src.poll(); assert.strictEqual(src.pending(), 1, 'ไม่คิวซ้ำ');
assert.strictEqual(src.last().billNo, 'POS01261118-00157');
const got = src.take(5); assert.strictEqual(got.length, 1); assert.strictEqual(got[0].total, 62); assert.strictEqual(src.pending(), 0);
// พิมพ์ซ้ำ (เลขที่บิลเดิม) ไฟล์ใหม่ → ไม่ออกซ้ำ
fs.writeFileSync(path.join(dir, 'b-FP2.SPL'), Buffer.concat([plain, Buffer.alloc(3000)]));
t += 100; src.poll(); t += 1500; src.poll(); assert.strictEqual(src.pending(), 0, 'บิลเดิมไม่ถูกใช้ซ้ำ');
// หมดอายุ
const src2 = createBillSource({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'billsrc2-')), readBill, now: () => t, settleMs: 10, ttlMs: 1000 });
assert.strictEqual(src2.heartbeatAgeMs(), Infinity);
console.log('bill-reader: ok');
