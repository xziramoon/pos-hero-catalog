'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const { migrateConfig } = require('../customerdisplay/migrate');
const { createDisplayFeed, autoReturnEnabled } = require('../customerdisplay/feed');
const { createCartState } = require('../customerdisplay/cart-state');

// ---- ย้ายพอร์ต 8080 → 8790 ครั้งเดียว ----
assert.deepStrictEqual(migrateConfig({ displayPort: 8080 }), { displayPort: 8790, portMigrated: true });
assert.deepStrictEqual(migrateConfig({}), { displayPort: 8790, portMigrated: true });
assert.deepStrictEqual(migrateConfig({ displayPort: 9000 }), { displayPort: 9000, portMigrated: true });
assert.deepStrictEqual(migrateConfig({ displayPort: 8080, portMigrated: true }), { displayPort: 8080, portMigrated: true }); // ผู้ใช้ตั้งกลับเอง
assert.deepStrictEqual(migrateConfig({ displayPort: '8080' }).displayPort, 8790);
assert.deepStrictEqual(migrateConfig(null), { displayPort: 8790, portMigrated: true });

// ค่าเริ่มต้นในโค้ดต้องเป็น 8790 และไม่มี 8080 ฝังตายเหลือ
for (const f of ['qrlock/qrlock-main.js', 'qrlock/display-server.js']) {
  const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); assert.ok(!/\b8080\b/.test(s), f + ' still has 8080');
}
assert.ok(/displayPort: 8790/.test(fs.readFileSync(path.join(__dirname, '..', 'qrlock/qrlock-main.js'), 'utf8')));

// ---- autoReturnEnabled ----
assert.strictEqual(autoReturnEnabled({ enabled: true, autoDisplayAfterBill: true }), true);
assert.strictEqual(autoReturnEnabled({ enabled: true, autoDisplayAfterBill: false }), false);
assert.strictEqual(autoReturnEnabled({ enabled: false, autoDisplayAfterBill: true }), false);
assert.strictEqual(autoReturnEnabled(undefined), false);

// ---- feed ----
function mk() {
  let t = 0; const sent = []; let saved = 0;
  const cart = createCartState({ now: () => t });
  const feed = createDisplayFeed({ cart, send: (v) => sent.push(v), shopName: () => 'ร้าน', onBillSaved: () => { saved++; } });
  return { feed, sent, saved: () => saved, tick: (ms) => { t += ms; } };
}
const main = (r, tot, line) => ({ t: 'main', machine: 'POS02', receipt: r, total: tot, line });
const L = (n, q, p) => n + '/ชื่อ/ชิ้น/@ ' + q.toFixed(2) + ' x ' + p.toFixed(2) + ' = ' + (q * p).toFixed(2);
{
  const { feed, sent, saved, tick } = mk();
  assert.strictEqual(feed.current().type, 'idle');
  feed.onReaderEvent(main('R1', 0, '')); feed.onReaderEvent(main('R1', 20, L('A', 1, 20)));
  assert.strictEqual(sent[sent.length - 1].type, 'cart'); assert.strictEqual(sent[sent.length - 1].shopName, 'ร้าน');
  const n = sent.length; feed.tick(); feed.tick(); assert.strictEqual(sent.length, n, 'tick without change does not resend');
  // QR ทับ pay; ลูกค้าต่อใหม่กลางบิลเห็นสถานะรวม
  feed.onReaderEvent({ t: 'pay', due: 20, cash: 50, change: 30, transfer: null });
  assert.strictEqual(feed.current().type, 'pay');
  feed.setQr({ type: 'show_qr', payload: 'p', amount: '20.00' }); assert.strictEqual(feed.current().type, 'show_qr');
  const m = sent.length; feed.setQr({ type: 'show_qr', payload: 'p', amount: '20.00' }); assert.strictEqual(sent.length, m + 1, 'identical QR message still sent');
  feed.setQr({ type: 'idle' }); assert.strictEqual(feed.current().type, 'pay');
  // บันทึกบิล → onBillSaved ครั้งเดียว → thanks หมดเวลาแล้ว tick ส่ง idle
  feed.onReaderEvent({ t: 'pay_closed' }); assert.strictEqual(saved(), 0);
  feed.onReaderEvent(main('R2', 0, L('A', 1, 20))); assert.strictEqual(saved(), 1); assert.strictEqual(feed.current().type, 'thanks');
  tick(8001); feed.tick(); assert.strictEqual(sent[sent.length - 1].type, 'idle');
}
// ข้อผิดพลาดใน callback/อีเวนต์เสียต้องไม่หลุดออกมา
{
  const cart = createCartState(); const feed = createDisplayFeed({ cart, send: () => { throw new Error('boom'); }, onBillSaved: () => { throw new Error('boom2'); } });
  assert.doesNotThrow(() => { feed.onReaderEvent(null); feed.onReaderEvent({ t: 'main', receipt: 'R1', total: 5, line: '' }); feed.setQr({ type: 'paid' }); feed.tick(); });
}
console.log('cd-integration: ok');
