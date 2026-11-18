'use strict';
const assert = require('assert');
const P = require('../fortune/promo-core');

const items = [
  { id: 'a1', name: 'ปลาหมึกแห้ง', code: '1001', barcodes: ['8850000000011'] },
  { id: 'a2', name: 'ปลาทูเค็ม', code: '1002', barcodes: [] },
  { id: 'a3', name: 'กุ้งแห้ง', code: 'K-3', barcodes: ['8850000000033'] }
];

// ---- normalizeRules
assert.deepStrictEqual(P.normalizeRules('x'), []);
const r = P.normalizeRules([
  { itemId: 'a1', name: 'ปลาหมึกแห้ง', minQty: 3, kind: 'baht', value: 10 },
  { itemId: 'a1', name: 'ซ้ำ', minQty: 2, kind: 'percent', value: 5 },      // ซ้ำสินค้า → ตัวหลังชนะ
  { itemId: 'a2', minQty: -4, kind: 'percent', value: 150 },                 // % เกิน 100 → ทิ้ง
  { itemId: '', kind: 'baht', value: 5 },                                    // ไม่มีสินค้า → ทิ้ง
  { itemId: 'a3', kind: 'baht', value: 0 },                                  // ลด 0 → ทิ้ง
  { itemId: 'a3', minQty: 999, kind: 'weird', value: '7.555' },              // kind ผิด → baht, qty ถูกจำกัด 99
  null, 5
]);
assert.strictEqual(r.length, 2);
assert.deepStrictEqual(r[0], { itemId: 'a1', name: 'ซ้ำ', minQty: 2, kind: 'percent', value: 5 });
assert.deepStrictEqual(r[1], { itemId: 'a3', name: 'a3', minQty: 99, kind: 'baht', value: 7.56 });
assert.strictEqual(P.rewardText(r[0]), 'ลด 5%');
assert.strictEqual(P.rewardText(r[1]), 'ลด 7.56 บาท');

// ---- findItem: บาร์โค้ด/รหัส/id ตรงตัว, ชื่อบางส่วน, หลายตัวเลือก
assert.strictEqual(P.findItem(items, '8850000000011').item.id, 'a1');
assert.strictEqual(P.findItem(items, ' 1002 ').item.id, 'a2');
assert.strictEqual(P.findItem(items, 'k-3').item.id, 'a3');
assert.strictEqual(P.findItem(items, 'กุ้ง').item.id, 'a3');
const sug = P.findItem(items, 'ปลา');
assert.strictEqual(sug.status, 'suggest'); assert.strictEqual(sug.choices.length, 2);
assert.strictEqual(P.findItem(items, 'ไม่มีของ').status, 'notfound');
assert.strictEqual(P.findItem(items, '').status, 'notfound');
assert.strictEqual(P.findItem(null, 'x').status, 'notfound');
assert.strictEqual(P.searchItems(items, 'ปลา').length, 2);
assert.strictEqual(P.searchItems(items, '').length, 0);

// ---- basket: นับชิ้น, ลด, หมดอายุ, take ใช้ครั้งเดียว
let t = 1000;
const b = P.createBasket({ now: () => t, ttlMs: 60000 });
assert.strictEqual(b.add('a1', 'ปลาหมึกแห้ง'), 1);
assert.strictEqual(b.add('a1', 'ปลาหมึกแห้ง'), 2);
b.add('a3', 'กุ้งแห้ง');
b.dec('a3');
assert.deepStrictEqual(b.items().map((x) => [x.itemId, x.qty]), [['a1', 2]]);
t += 59000; b.add('a1', 'x'); // ยิงใหม่ → นับเวลาใหม่
t += 59000;
assert.strictEqual(b.items()[0].qty, 3, 'ยังไม่หมดอายุเพราะเพิ่งยิง');
const taken = b.take();
assert.strictEqual(taken[0].qty, 3); assert.deepStrictEqual(b.take(), [], 'take ครั้งเดียว');
b.add('a2', 'ปลาทู'); t += 61000;
assert.deepStrictEqual(b.items(), [], 'หมดอายุเอง');
b.add('a2', 'ปลาทู'); assert.strictEqual(b.items().length, 1, 'หลังหมดอายุเริ่มใหม่ได้');
for (let i = 0; i < 150; i++) b.add('a2', 'ปลาทู');
assert.strictEqual(b.items()[0].qty, 99, 'จำกัด 99');

// ---- evaluate: ครบเงื่อนไข = 1 กฎ 1 คูปอง ไม่ว่าซื้อเกินกี่ชิ้น; ไม่ครบ = ยังไม่ได้; สินค้าไม่มีกฎ = ไม่นับ
const rules = [{ itemId: 'a1', name: 'ปลาหมึกแห้ง', minQty: 3, kind: 'baht', value: 10 }, { itemId: 'a3', name: 'กุ้งแห้ง', minQty: 1, kind: 'percent', value: 5 }];
let e = P.evaluate(rules, [{ itemId: 'a1', qty: 2 }]);
assert.strictEqual(e.earned.length, 0); assert.strictEqual(e.progress[0].done, false);
e = P.evaluate(rules, [{ itemId: 'a1', qty: 7 }, { itemId: 'a3', qty: 1 }, { itemId: 'zz', qty: 5 }]);
assert.deepStrictEqual(e.earned.map((x) => x.itemId), ['a1', 'a3']);
assert.strictEqual(P.evaluate([], [{ itemId: 'a1', qty: 9 }]).earned.length, 0);
assert.strictEqual(P.evaluate(rules, []).earned.length, 0);
console.log('promo-core: ok');
