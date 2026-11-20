'use strict';
const assert = require('assert');
const { matchPayment, createMatcher } = require('../qrlock/matcher');
const { createSessions } = require('../qrlock/session');
let t = 10000;
const S = createSessions({ now: () => t });
const s = S.create({ amount: '360.00', payload: 'x', machine: 'm1' });
const ev = (o) => ({ amount: 360, text: 'แม่มณี เงินเข้า 360.00 บาท', ts: t + 500, ...o });
assert.ok(matchPayment(ev(), s, 'maemanee').ok);
assert.strictEqual(matchPayment(ev({ amount: 360.01 }), s, 'maemanee').reason, 'amount-mismatch');
assert.strictEqual(matchPayment(ev({ amount: '360' }), s, 'maemanee').ok, true);
assert.strictEqual(matchPayment(ev({ text: 'SCB EASY โอนเข้า 360.00' }), s, 'maemanee').reason, 'bank-mismatch'); // แอปของอีกเครื่อง
assert.strictEqual(matchPayment(ev({ ts: t - 1 }), s, 'maemanee').reason, 'before-qr');
assert.ok(matchPayment(ev({ text: 'กรุงเทพ BBL 360.00' }), s, 'bbl').ok);
assert.ok(matchPayment(ev({ text: 'อะไรก็ได้' }), s, 'other').ok); // ไม่ได้ผูกธนาคาร
// ไม่มี QR รอ / จบแล้ว
S.cancel();
assert.strictEqual(matchPayment(ev(), s, 'maemanee').reason, 'no-waiting-session');
assert.strictEqual(matchPayment(ev(), null, 'maemanee').reason, 'no-waiting-session');
// ใช้ซ้ำไม่ได้
const s2 = S.create({ amount: '360.00', payload: 'x', machine: 'm1' });
const M = createMatcher({ getBank: () => 'maemanee' });
const e = ev({ id: 'a1' });
assert.ok(M(e, s2).ok); assert.strictEqual(M(e, s2).reason, 'already-used');
// แจ้งเตือนที่ไม่ตรง ไม่ทำให้ QR ปิด
const s3 = S.create({ amount: '50.00', payload: 'x', machine: 'm1' });
assert.strictEqual(M(ev({ amount: 49, id: 'b' }), s3).ok, false); assert.strictEqual(s3.status, 'WAITING');
console.log('qrlock-matcher: all tests passed');
