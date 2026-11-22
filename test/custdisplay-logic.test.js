'use strict';
// custdisplay/logic.js: parse แถบเหลือง + state machine (fixture จาก docs/customer-display-plan.md)
const assert = require('assert');
const L = require('../custdisplay/logic');

const SERUM = '8850822011676/เค.เอ. ไฮยาอินเทนส์เซรั่ม 7กรัม/แพ็ค/@ 1.00 x 225.00 = 225.00';
const SERUM2 = 'เพิ่ม : 8850822011676/เค.เอ. ไฮยาอินเทนส์เซรั่ม 7กรัม/แพ็ค/@ 2.00 x 225.00 = 450.00';
const DEL = 'ลบ : 8850822011676/เค.เอ. ไฮยาอินเทนส์เซรั่ม 7กรัม/แพ็ค/@ 2.00 x 225.00 = 450.00';
const SLASH = '1234567/ครีม A/B 10 มล./ซอง/@ 3.00 x 1,200.50 = 3,601.50';

// ---- parseBar ----
let p = L.parseBar(SERUM);
assert.deepStrictEqual(p, { action: 'upsert', barcode: '8850822011676', name: 'เค.เอ. ไฮยาอินเทนส์เซรั่ม 7กรัม', unit: 'แพ็ค', qty: 1, price: 225, amount: 225 });
p = L.parseBar(SERUM2);
assert.strictEqual(p.action, 'upsert'); assert.strictEqual(p.qty, 2); assert.strictEqual(p.amount, 450);
p = L.parseBar(DEL);
assert.strictEqual(p.action, 'remove'); assert.strictEqual(p.barcode, '8850822011676');
p = L.parseBar('เพิ่ม: ' + SERUM); // ช่องว่างรอบ ":" ยืดหยุ่น
assert.strictEqual(p.action, 'upsert'); assert.strictEqual(p.barcode, '8850822011676');
p = L.parseBar(SLASH); // ชื่อมี "/" และตัวเลขมี comma
assert.strictEqual(p.name, 'ครีม A/B 10 มล.'); assert.strictEqual(p.unit, 'ซอง');
assert.strictEqual(p.price, 1200.5); assert.strictEqual(p.amount, 3601.5);
for (const bad of [null, undefined, '', 'POS02', '265.00', 'POS02261122-00065', 'abc/def', '123/ชื่อ/@ x']) {
  assert.strictEqual(L.parseBar(bad), null, `should not parse: ${bad}`);
}

// ---- state machine ----
const main = (receipt, total, line) => ({ t: 'main', receipt, total, line });
const run = (st, evs, t0 = 1000) => { let t = t0; for (const e of evs) { L.reduce(st, e, t); t += 300; } return t; };

// เริ่มโปรแกรมตอนบิลใหม่ แถบเหลืองยังค้างจากบิลก่อน → baseline ไม่นับ
let st = L.createState();
run(st, [main('POS02261122-00070', 0, SERUM)]);
assert.deepStrictEqual(L.view(st, 2000), { type: 'idle' });
assert.strictEqual(st.items.length, 0);

// ยิงสินค้าใหม่
run(st, [main('POS02261122-00070', 225, SLASH)]);
let v = L.view(st, 2000);
assert.strictEqual(v.type, 'cart');
assert.strictEqual(v.fallback, true, 'ยอด 3601.50 ≠ 225 → fallback');
st = L.createState();
run(st, [main('R1', 0, SERUM), main('R1', 225, SLASH)]);
v = L.view(st, 2000);
assert.strictEqual(v.fallback, true); // sum 3601.50 ≠ total 225
assert.strictEqual(v.items.length, 1);

// ยิงใหม่ → ยิงซ้ำ (จำนวนรวม) → +1/-1 → ลบ
st = L.createState();
const MILK = '111/นม/กล่อง/@ 1.00 x 20.00 = 20.00';
const MILK2 = 'เพิ่ม : 111/นม/กล่อง/@ 2.00 x 20.00 = 40.00';
const MILK3 = '111/นม/กล่อง/@ 3.00 x 20.00 = 60.00';
const MILKDEL = 'ลบ : 111/นม/กล่อง/@ 3.00 x 20.00 = 60.00';
run(st, [main('R1', 0, null), main('R1', 225, SERUM)]);
v = L.view(st, 2000);
assert.deepStrictEqual([v.type, v.fallback, v.items.length, v.total], ['cart', false, 1, 225]);
run(st, [main('R1', 245, MILK)]);
v = L.view(st, 2000);
assert.deepStrictEqual([v.fallback, v.items.length], [false, 2]);
assert.strictEqual(v.items.find((i) => i.id === v.last).barcode, '111');
run(st, [main('R1', 265, MILK2)]);
v = L.view(st, 2000);
assert.strictEqual(v.items.length, 2); // upsert ไม่เพิ่มบรรทัดใหม่
assert.strictEqual(v.items[1].qty, 2);
run(st, [main('R1', 285, MILK3)]);
assert.strictEqual(L.view(st, 2000).items[1].qty, 3);
run(st, [main('R1', 225, MILKDEL)]);
v = L.view(st, 2000);
assert.deepStrictEqual([v.fallback, v.items.length], [false, 1]);
assert.strictEqual(v.items.find((i) => i.id === v.last).barcode, '8850822011676');

// ยอดไม่ตรง (เช่น ส่วนลด) → fallback แสดงรายการล่าสุด + Total จาก POS
run(st, [main('R1', 200, SERUM2.replace('เพิ่ม : ', ''))]);
v = L.view(st, 2000);
assert.strictEqual(v.fallback, true); assert.strictEqual(v.total, 200);

// ยิงตัวเดียวกับที่ค้างบนแถบเหลืองเป๊ะๆ ในบิลใหม่ (ข้อความไม่เปลี่ยน แต่ยอดขยับ) ต้องนับ
st = L.createState();
run(st, [main('R1', 225, SERUM), main('R2', 0, SERUM)]);
assert.strictEqual(L.view(st, 2000).type, 'idle');
run(st, [main('R2', 225, SERUM)]);
v = L.view(st, 2000);
assert.deepStrictEqual([v.type, v.fallback, v.items.length], ['cart', false, 1]);

// ---- หน้า Pay / ขอบคุณ / Cancel ----
const PAY = { t: 'pay', due: 225, cash: 500, change: 275, transfer: null };
st = L.createState();
let t = run(st, [main('R1', 0, SERUM), main('R1', 225, SERUM2.replace('เพิ่ม : ', '').replace('2.00', '1.00').replace('450.00', '225.00')), PAY]);
assert.deepStrictEqual(L.view(st, t), { type: 'pay', due: 225, cash: 500, change: 275 });

// Cancel: Pay ปิด เลขที่ใบเสร็จเดิม → กลับหน้ารายการ และไม่ขึ้นขอบคุณแม้ใบเสร็จเปลี่ยนทีหลัง (นอกกรอบเวลา)
L.reduce(st, { t: 'pay_closed' }, t);
assert.strictEqual(L.view(st, t).type, 'cart');
L.reduce(st, main('R2', 0, SERUM), t + L.SAVE_WINDOW_MS + 1);
assert.notStrictEqual(L.view(st, t + L.SAVE_WINDOW_MS + 1).type, 'thanks');

// Save: Pay ปิด แล้วใบเสร็จเปลี่ยน → ขอบคุณ + เงินทอน ค้าง ~8 วินาที แล้วกลับ idle
st = L.createState();
t = run(st, [main('R1', 0, SERUM), main('R1', 225, SERUM), PAY]);
L.reduce(st, { t: 'pay_closed' }, t);
L.reduce(st, main('R2', 0, SERUM), t + 600);
assert.deepStrictEqual(L.view(st, t + 700), { type: 'thanks', change: 275 });
assert.strictEqual(L.nextWakeup(st, t + 700), t + 600 + L.THANKS_MS);
assert.deepStrictEqual(L.view(st, t + 600 + L.THANKS_MS), { type: 'idle' });
assert.strictEqual(L.nextWakeup(st, t + 600 + L.THANKS_MS), null);

// Cancel แล้วทำอะไรต่อในบิลเดิม (ยอดขยับ) ก่อนจะ Hold ใบเสร็จเปลี่ยน → ไม่ใช่ขอบคุณ
st = L.createState();
t = run(st, [main('R1', 0, SERUM), main('R1', 225, SERUM), PAY]);
L.reduce(st, { t: 'pay_closed' }, t);
L.reduce(st, main('R1', 245, MILK), t + 300);
L.reduce(st, main('R2', 0, MILK), t + 900);
assert.notStrictEqual(L.view(st, t + 1000).type, 'thanks');

// บิลใหม่ระหว่างขอบคุณ: ยิงสินค้าได้ตามปกติหลัง baseline (ขอบคุณยังค้างจนครบเวลา)
// POS ปิด → รีเซ็ตทั้งหมด
L.reduce(st, { t: 'pos_missing' }, t + 2000);
assert.deepStrictEqual(L.view(st, t + 2000), { type: 'idle' });

console.log('custdisplay-logic.test.js: all passed');

// ---- จาก log จริงบน POS04 (14:33): บิลถูกเคลียร์ (line ว่าง total ว่าง) แล้วยิงสินค้าคนละชนิด ----
{
  const A = '8851989036274/ไฟน์ไลน์ ปรับผ้านุ่มสีขาว 1300มล./ถุง/@ 7.00 x 39.00 = 273.00';
  const B = '8809382884275/เคียวร์ซิส แผ่นดูดซับสิว ทีทรีอยล์ 18ชิ้น/ซอง/@ 1.00 x 99.00 = 99.00';
  const s = L.createState();
  L.reduce(s, main('POS04261122-00001', 0, A), 1000);
  L.reduce(s, main('POS04261122-00001', 273, A), 1300); // ข้อความเท่า baseline แต่ยอดขยับ → นับ
  assert.strictEqual(L.view(s, 1400).items.length, 1);
  L.reduce(s, { t: 'main', receipt: 'POS04261122-00001', total: null, line: '' }, 1600);
  assert.deepStrictEqual(L.view(s, 1700), { type: 'idle' });
  L.reduce(s, main('POS04261122-00001', 99, B), 1900);
  const v2 = L.view(s, 2000);
  assert.deepStrictEqual([v2.fallback, v2.items.length, v2.total], [false, 1, 99]);
}
console.log('custdisplay-logic.test.js: real-log case passed');

// สินค้าคนละชนิดที่รหัสซ้ำกัน (POS จริงมีสินค้ารหัส "..") ต้องไม่ทับกัน
{
  const D1 = '../ใบมีดโกน โลเล็กซ์ 10โหล/กล่อง/@ 1.00 x 190.00 = 190.00';
  const D2 = '../สบู่ก้อน/ก้อน/@ 1.00 x 10.00 = 10.00';
  const s = L.createState();
  L.reduce(s, main('R9', 0, null), 1000);
  L.reduce(s, main('R9', 190, D1), 1300);
  L.reduce(s, main('R9', 200, D2), 1600);
  const v3 = L.view(s, 1700);
  assert.deepStrictEqual([v3.fallback, v3.items.length, v3.total], [false, 2, 200]);
  assert.strictEqual(v3.items.find((i) => i.id === v3.last).name, 'สบู่ก้อน');
  L.reduce(s, main('R9', 190, 'ลบ : ' + D2), 1900);
  assert.strictEqual(L.view(s, 2000).items.length, 1);
}
console.log('custdisplay-logic.test.js: duplicate-barcode case passed');
