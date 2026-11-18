'use strict';
const assert = require('assert');
const { encode, BARS } = require('../fortune/code128');

// ตัวถอดรหัสเล็ก ๆ ไว้ตรวจว่า encode → decode ได้ข้อความเดิมและ checksum ถูก
function decode(bits) {
  const syms = [];
  for (let i = 0; i < bits.length - 13; i += 11) syms.push(BARS.indexOf(bits.slice(i, i + 11)));
  syms.push(106); // stop (ตรวจรูปแบบด้านล่าง)
  assert.ok(syms.every((v) => v >= 0), 'ทุกสัญลักษณ์ต้องอยู่ในตาราง');
  assert.strictEqual(bits.slice(-13), BARS[106], 'ลงท้ายด้วย stop');
  assert.strictEqual(syms[0], 104, 'เริ่มด้วย start B');
  const data = syms.slice(1, -2), chk = syms[syms.length - 2];
  const sum = 104 + data.reduce((s, v, i) => s + v * (i + 1), 0);
  assert.strictEqual(chk, sum % 103, 'checksum');
  return data.map((v) => String.fromCharCode(v + 32)).join('');
}

// ตารางต้องสมบูรณ์: 107 รูปแบบ, ทุกอันขึ้นต้นด้วยแท่งดำ, ยาว 11 โมดูล (stop ยาว 13)
assert.strictEqual(BARS.length, 107);
BARS.forEach((b, i) => { assert.strictEqual(b.length, i === 106 ? 13 : 11, 'len ' + i); assert.strictEqual(b[0], '1'); });
assert.strictEqual(new Set(BARS).size, 107, 'ไม่ซ้ำกัน');

for (const t of ['SHABC234', 'SHK7M2XQ', 'A', 'ZZZZZZZZZZ', 'SH-ABC234 ~']) {
  const bits = encode(t);
  assert.strictEqual(bits.length, 11 * (t.length + 3) + 2, 'ความยาว ' + t);
  assert.strictEqual(decode(bits), t, 'round trip ' + t);
}
// ค่าอ้างอิงที่เทียบกับไลบรารี JsBarcode แล้ว (SHABC234 = 123 โมดูล)
assert.strictEqual(encode('SHABC234').length, 123);
assert.strictEqual(encode(''), null);
assert.strictEqual(encode('สวัสดี'), null);
assert.strictEqual(encode('a\nb'), null);
console.log('code128: ok');
