'use strict';
const assert = require('node:assert');
const F = require('../renderer/catalog/filters');

const n = F.normalize;

// case / whitespace
assert.strictEqual(n('  Clear  Men '), 'clearmen');
assert.strictEqual(n('A\tB\nC'), 'abc');
// Thai tone marks and diacritics are ignored
assert.strictEqual(n('น้ำ'), n('นำ'));
assert.strictEqual(n('ข้าว'), n('ขาว'));
assert.strictEqual(n('เก๋'), n('เก'));
assert.strictEqual(n('การ์ตูน'), n('การตูน'));
// sara am written as nikhahit + sara aa equals sara am
assert.strictEqual(n('นํา'), n('นำ'));
// NFC: composed and decomposed Latin are equal, and Latin accents dropped
assert.strictEqual(n('é'), n('é'));
assert.strictEqual(n('Café'), 'cafe');
// null-safe, numeric
assert.strictEqual(n(null), '');
assert.strictEqual(n(101), '101');
// zero-width chars
assert.strictEqual(n('a​b'), 'ab');

const item = { name: 'เคลียร์ เมน ดีพโอเชี่ยน', shortName: 'เคลียร์ ดีพโอเชี่ยน 450', code: '00101', barcodes: ['8851234567890'] };
const e = F.buildIndexEntry(item);
assert.ok(F.matchesQuery(e, n('เคลียร์')));
assert.ok(F.matchesQuery(e, n('เคลียร เมน')), 'tone + space insensitive');
assert.ok(F.matchesQuery(e, n('ดีพโอเชียน')), 'tone insensitive');
assert.ok(F.matchesQuery(e, n('00101')));
assert.ok(F.matchesQuery(e, n('567890')));
assert.ok(F.matchesQuery(e, ''));
assert.ok(!F.matchesQuery(e, n('ไม่มีอันนี้')));
// no cross-field matches (end of shortName + start of code)
assert.ok(!F.matchesQuery(e, n('45000101')));
// exact code/barcode
assert.ok(F.isExactCodeOrBarcode(e, '00101'));
assert.ok(F.isExactCodeOrBarcode(e, '8851234567890'));
assert.ok(!F.isExactCodeOrBarcode(e, '0010'));
assert.ok(!F.isExactCodeOrBarcode(e, ''));
assert.ok(!F.isExactCodeOrBarcode(e, '101'), 'leading zeros matter');

// filters
const items = [
  { id: 1, cat: 'ก', fav: true, image: null },
  { id: 2, cat: 'ข', fav: false, image: { hash: 'h', quality: 'ok' } },
  { id: 3, cat: 'ข', fav: false, image: { hash: 'h', quality: 'check' } },
  { id: 4, cat: 'ก', fav: false, image: { hash: 'h', quality: 'retake' } }
];
const tabs = F.buildTabs({ categories: ['ทั่วไป', 'ก', 'ข'] }, { showNoImage: true, showNeedsCheck: true, showFavorites: true });
assert.deepStrictEqual(tabs.map((t) => t.id), ['all', 'cat:ทั่วไป', 'cat:ก', 'cat:ข', 'fav', 'noimage', 'check']);
const count = (id) => items.filter(tabs.find((t) => t.id === id).match).length;
assert.strictEqual(count('all'), 4);
assert.strictEqual(count('cat:ข'), 2);
assert.strictEqual(count('fav'), 1);
assert.strictEqual(count('noimage'), 1);
assert.strictEqual(count('check'), 2);
const t2 = F.buildTabs({ categories: ['ทั่วไป'] }, { showNoImage: false, showNeedsCheck: false, showFavorites: false });
assert.deepStrictEqual(t2.map((t) => t.id), ['all', 'cat:ทั่วไป']);

console.log('search.test.js ok');
