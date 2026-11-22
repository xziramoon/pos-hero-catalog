'use strict';
// qrlock/cart-gate.js: QR มีสิทธิ์ก่อนเสมอ — รายการสินค้าไม่ทับ QR ที่รอจ่ายหรือหน้าผลที่เพิ่งขึ้น
const assert = require('assert');
const { createCartGate } = require('../qrlock/cart-gate');

let t = 1000, waiting = false; const sent = [];
const g = createCartGate({ send: (m) => sent.push(m), isWaiting: () => waiting, now: () => t, holdMs: 5000 });

g.offer({ type: 'cart', n: 1 });
assert.deepStrictEqual(sent, [{ type: 'cart', n: 1 }], 'ไม่มี QR → ส่งทันที');

waiting = true;
g.offer({ type: 'cart', n: 2 }); g.offer({ type: 'pay', n: 3 });
assert.strictEqual(sent.length, 1, 'กำลังโชว์ QR → ห้ามส่งทับ');
assert.strictEqual(g.release(), false);

waiting = false; g.qrEnded(); // paid/expired/cancelled เพิ่งขึ้น
g.offer({ type: 'cart', n: 4 });
assert.strictEqual(sent.length, 1, 'ภายใน 5 วินาทีหลังจบ QR → ห้ามส่งทับ');
t += 4999; assert.strictEqual(g.release(), false);
t += 2; assert.strictEqual(g.release(), true, 'พ้นช่วง hold → ส่งข้อความล่าสุดที่ค้างไว้');
assert.deepStrictEqual(sent[sent.length - 1], { type: 'cart', n: 4 }, 'ส่งเฉพาะข้อความล่าสุด');

g.clear(); assert.strictEqual(g.hasPending(), false); assert.strictEqual(g.release(), false);
console.log('custdisplay-gate: ok');
