'use strict';
const assert = require('assert');
const { parseLine } = require('../customerdisplay/parse-line');

const base = '8850822011676/เค.เอ. ไฮยาอินเทนส์เซรั่ม 7กรัม/แพ็ค/@ 1.00 x 225.00 = 225.00';
assert.deepStrictEqual(parseLine(base), { action: 'upsert', barcode: '8850822011676', name: 'เค.เอ. ไฮยาอินเทนส์เซรั่ม 7กรัม', unit: 'แพ็ค', qty: 1, price: 225, amount: 225 });
const add = parseLine('เพิ่ม : 8850822011676/เค.เอ. ไฮยาอินเทนส์เซรั่ม 7กรัม/แพ็ค/@ 2.00 x 225.00 = 450.00');
assert.strictEqual(add.action, 'upsert'); assert.strictEqual(add.qty, 2); assert.strictEqual(add.amount, 450);
for (const t of ['ลบ : 8850822011676/เค.เอ./แพ็ค/@ 1.00 x 225.00 = 225.00', 'ลบ: 8850822011676/เค.เอ./แพ็ค/@ 1.00 x 225.00 = 225.00', 'ลบ : 8850822011676']) {
  const r = parseLine(t); assert.strictEqual(r.action, 'remove', t); assert.strictEqual(r.barcode, '8850822011676', t);
}
const slash = parseLine('123/น้ำ 1/2 ลิตร/ขวด/@ 1.00 x 10.00 = 10.00');
assert.strictEqual(slash.name, 'น้ำ 1/2 ลิตร'); assert.strictEqual(slash.unit, 'ขวด'); assert.strictEqual(slash.barcode, '123');
const comma = parseLine('123/ข้าว/ถุง/@ 3.00 x 1,250.50 = 3,751.50');
assert.strictEqual(comma.price, 1250.5); assert.strictEqual(comma.amount, 3751.5); assert.strictEqual(comma.qty, 3);
for (const t of ['', 'garbage', null, undefined, 42]) assert.strictEqual(parseLine(t), null, String(t));
console.log('cd-parse-line: ok');
