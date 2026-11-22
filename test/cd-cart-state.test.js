'use strict';
const assert = require('assert');
const { createCartState, composeView } = require('../customerdisplay/cart-state');

const L = (bc, name, qty, price, pre) => (pre ? pre + ' : ' : '') + bc + '/' + name + '/ชิ้น/@ ' + qty.toFixed(2) + ' x ' + price.toFixed(2) + ' = ' + (qty * price).toFixed(2);
const main = (receipt, total, line) => ({ t: 'main', machine: 'POS02', receipt, total, line });
function mk() { let t = 0; const logs = []; const c = createCartState({ now: () => t, log: (s) => logs.push(s) }); return { c, logs, tick: (ms) => { t += ms; } }; }

// baseline: แถบเหลืองเก่าที่ค้างจากบิลก่อนต้องไม่ถูกนับ
{ const { c } = mk(); const old = L('111', 'เก่า', 1, 50);
  c.handle(main('R1', 0, old)); assert.strictEqual(c.view().type, 'idle');
  c.handle(main('R1', 20, L('222', 'ใหม่', 1, 20))); const v = c.view();
  assert.strictEqual(v.type, 'cart'); assert.strictEqual(v.items.length, 1); assert.strictEqual(v.items[0].barcode, '222'); assert.strictEqual(v.total, 20); assert.strictEqual(v.last.barcode, '222'); }

// upsert / ยิงซ้ำ / ลบ / ลบที่ไม่มี
{ const { c } = mk(); c.handle(main('R1', 0, ''));
  c.handle(main('R1', 20, L('A', 'a', 1, 20))); c.handle(main('R1', 30, L('B', 'b', 1, 10)));
  c.handle(main('R1', 50, L('A', 'a', 2, 20, 'เพิ่ม')));
  let v = c.view(); assert.strictEqual(v.items.length, 2); assert.strictEqual(v.items[0].qty, 2); assert.strictEqual(v.hidden, false);
  c.handle(main('R1', 20, 'ลบ : B/b/ชิ้น/@ 1.00 x 10.00 = 10.00'));
  v = c.view(); assert.deepStrictEqual(v.items.map((i) => i.barcode), ['A']);
  assert.doesNotThrow(() => c.handle(main('R1', 20, 'ลบ : ZZZ'))); }

// ใบเสร็จเปลี่ยน → ล้างรายการ
{ const { c } = mk(); c.handle(main('R1', 0, '')); c.handle(main('R1', 20, L('A', 'a', 1, 20)));
  c.handle(main('R2', 0, L('A', 'a', 1, 20))); assert.strictEqual(c.view().type, 'idle');
  c.handle(main('R2', 5, L('C', 'c', 1, 5))); assert.deepStrictEqual(c.view().items.map((i) => i.barcode), ['C']); }

// mismatch → ซ่อนรายการ + log; ใกล้เคียงภายใน 0.01 ไม่ซ่อน
{ const { c, logs } = mk(); c.handle(main('R1', 0, '')); c.handle(main('R1', 15, L('A', 'a', 1, 20)));
  const v = c.view(); assert.strictEqual(v.hidden, true); assert.strictEqual(v.total, 15); assert.strictEqual(v.last.barcode, 'A'); assert.ok(logs.length >= 1);
  const m2 = mk(); m2.c.handle(main('R1', 0, '')); m2.c.handle(main('R1', 20.005, L('A', 'a', 1, 20))); assert.strictEqual(m2.c.view().hidden, false); }

// Pay เปิด → pay; ปิด + ใบเสร็จเปลี่ยน → thanks 8 วิ แล้ว idle; billSaved
{ const { c, tick } = mk(); c.handle(main('R1', 0, '')); c.handle(main('R1', 225, L('A', 'a', 1, 225)));
  c.handle({ t: 'pay', due: 225, cash: 500, change: 275, transfer: null });
  assert.deepStrictEqual(c.view(), { type: 'pay', machine: 'POS02', due: 225, cash: 500, change: 275, transfer: null });
  assert.strictEqual(c.handle({ t: 'pay_closed' }).billSaved, false); // ยังไม่รู้ว่าบันทึกไหม
  const r = c.handle(main('R2', 0, L('A', 'a', 1, 225))); assert.strictEqual(r.billSaved, true);
  assert.deepStrictEqual(c.view(), { type: 'thanks', machine: 'POS02', change: 275 });
  tick(7999); assert.strictEqual(c.view().type, 'thanks'); tick(2); assert.strictEqual(c.view().type, 'idle'); }

// Cancel: pay_closed แล้วใบเสร็จเดิม → กลับ cart ไม่ billSaved
{ const { c } = mk(); c.handle(main('R1', 0, '')); c.handle(main('R1', 225, L('A', 'a', 1, 225)));
  c.handle({ t: 'pay', due: 225, cash: null, change: null, transfer: null }); c.handle({ t: 'pay_closed' });
  const r = c.handle(main('R1', 225, L('A', 'a', 1, 225))); assert.strictEqual(r.billSaved, false); assert.strictEqual(c.view().type, 'cart'); }

// POS หาย → idle + ล้าง
{ const { c } = mk(); c.handle(main('R1', 0, '')); c.handle(main('R1', 20, L('A', 'a', 1, 20))); c.handle({ t: 'pos_missing' });
  assert.strictEqual(c.view().type, 'idle'); }

// composeView: QR ชนะทุกอย่าง
const cart = { type: 'pay', machine: 'POS02' };
assert.strictEqual(composeView({ type: 'show_qr', payload: 'x' }, cart).type, 'show_qr');
for (const ty of ['paid', 'expired', 'cancelled']) assert.strictEqual(composeView({ type: ty }, cart).type, ty);
assert.strictEqual(composeView({ type: 'idle' }, cart), cart); assert.strictEqual(composeView(null, cart), cart);
console.log('cd-cart-state: ok');

// ---- ผลรีวิวรอบสุดท้าย ----
const ev = (r, tot, line) => ({ t: 'main', machine: 'POS02', receipt: r, total: tot, line });
const LL = (bc, q, p) => bc + '/x/ชิ้น/@ ' + q.toFixed(2) + ' x ' + p.toFixed(2) + ' = ' + (q * p).toFixed(2);
// เงินทอนบิลก่อนต้องไม่โผล่ในบิลถัดไป (จ่ายโอน/จ่ายพอดี → เงินทอนว่าง)
{ const { c } = mk(); c.handle(ev('R1', 0, '')); c.handle(ev('R1', 225, LL('A', 1, 225)));
  c.handle({ t: 'pay', due: 225, cash: 500, change: 275, transfer: null }); c.handle({ t: 'pay_closed' }); c.handle(ev('R2', 0, LL('A', 1, 225)));
  assert.strictEqual(c.view().change, 275);
  c.handle(ev('R2', 100, LL('B', 1, 100))); c.handle({ t: 'pay', due: 100, cash: null, change: null, transfer: 100 }); c.handle({ t: 'pay_closed' }); c.handle(ev('R3', 0, LL('B', 1, 100)));
  assert.strictEqual(c.view().type, 'thanks'); assert.strictEqual(c.view().change, null, 'change not carried over'); }
// Total อ่านไม่ได้ (null) → ห้ามแสดงยอดเดิม/0.00: ซ่อนรายการ ไม่มี total แล้วกลับมาเมื่ออ่านได้
{ const { c } = mk(); c.handle(ev('R1', 0, '')); c.handle(ev('R1', null, LL('A', 1, 20)));
  let v = c.view(); assert.strictEqual(v.type, 'cart'); assert.strictEqual(v.total, null); assert.strictEqual(v.hidden, true); assert.strictEqual(v.last.barcode, 'A');
  c.handle(ev('R1', 20, LL('A', 1, 20))); v = c.view(); assert.strictEqual(v.total, 20); assert.strictEqual(v.hidden, false);
  c.handle(ev('R1', null, LL('A', 1, 20))); assert.strictEqual(c.view().total, null, 'stale total not kept'); }
// ใบเสร็จเปลี่ยนตอน Pay ยังเปิด แล้วมี pay อีกอีเวนต์ → ยังต้อง billSaved ตอนปิด
{ const { c } = mk(); c.handle(ev('R1', 0, '')); c.handle(ev('R1', 225, LL('A', 1, 225)));
  c.handle({ t: 'pay', due: 225, cash: 500, change: 275, transfer: null }); c.handle(ev('R2', 0, LL('A', 1, 225)));
  c.handle({ t: 'pay', due: 225, cash: 500, change: 275, transfer: null }); // ช่องเปลี่ยนตอนกำลังปิด
  assert.strictEqual(c.handle({ t: 'pay_closed' }).billSaved, true); assert.strictEqual(c.view().type, 'thanks'); }
console.log('cd-cart-state (review fixes): ok');
