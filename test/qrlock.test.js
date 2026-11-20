'use strict';
const assert = require('assert');
const { crc16, validateTemplate, formatAmount, buildQr, parseTlv } = require('../qrlock/qr-builder');

// ค่าทดสอบจาก QR-LOCK-SPEC (เบอร์สมมติ ไม่ใช่ของร้าน)
const TEMPLATE = '00020101021129370016A0000006770101110113006681234567853037645802TH6304823E';
const EXPECT_360 = '00020101021229370016A0000006770101110113006681234567853037645406360.005802TH63046740';

assert.strictEqual(crc16('123456789'), '29B1');
assert.deepStrictEqual(validateTemplate(TEMPLATE), { ok: true });
assert.strictEqual(buildQr(TEMPLATE, '360.00'), EXPECT_360);
assert.strictEqual(buildQr(TEMPLATE, 360), EXPECT_360);
assert.strictEqual(buildQr(TEMPLATE, '360'), EXPECT_360);

// รหัส 29 ต้องไม่ถูกแตะ
const t29 = (s) => parseTlv(s).find((x) => x.tag === '29').value;
assert.strictEqual(t29(buildQr(TEMPLATE, '1')), t29(TEMPLATE));

// ต้นแบบที่ CRC ผิดถูกปฏิเสธ
const bad = TEMPLATE.slice(0, -4) + '0000';
assert.strictEqual(validateTemplate(bad).ok, false);
assert.throws(() => buildQr(bad, '1'));
assert.strictEqual(validateTemplate('').ok, false);
assert.strictEqual(validateTemplate('not a qr').ok, false);

// ต้นแบบที่มีรหัส 54 อยู่แล้วต้องถูกแทนที่ ไม่ซ้ำ
const withAmt = EXPECT_360;
const rebuilt = buildQr(withAmt, '1.5');
assert.strictEqual(parseTlv(rebuilt).filter((x) => x.tag === '54').length, 1);
assert.strictEqual(parseTlv(rebuilt).find((x) => x.tag === '54').value, '1.50');
assert.strictEqual(parseTlv(rebuilt).find((x) => x.tag === '01').value, '12');

// ยอดไม่ถูกต้อง
for (const a of ['0', '0.00', '-5', 'abc', '1.234', '', '1e3']) assert.throws(() => formatAmount(a), a);
assert.strictEqual(formatAmount('1,250.5'), '1250.50');

console.log('qrlock: all tests passed');
