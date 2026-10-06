'use strict';
const assert = require('node:assert');
const { MAX_FUTURE_SKEW_MS, isNewer, mergeItem, exceedsSkew, normalizeItem, validateItem } = require('../catalog/shared/merge.js');

const it = (o) => Object.assign({ id: 'A', code: '001', name: 'x', updatedAt: 1000, updatedBy: 'dev-a', deleted: false }, o);

// newer updatedAt wins, regardless of argument order
{
  const a = it({ name: 'old', updatedAt: 1000 }), b = it({ name: 'new', updatedAt: 2000, updatedBy: 'dev-b' });
  assert.strictEqual(mergeItem(a, b), b);
  assert.strictEqual(mergeItem(b, a), b);
  assert.ok(isNewer(b, a) && !isNewer(a, b));
}
// equal updatedAt: larger updatedBy wins, deterministic both ways
{
  const a = it({ updatedBy: 'dev-a', name: 'A' }), b = it({ updatedBy: 'dev-b', name: 'B' });
  assert.strictEqual(mergeItem(a, b), b);
  assert.strictEqual(mergeItem(b, a), b);
}
// fully identical: not newer, local kept
{
  const a = it(), b = it();
  assert.ok(!isNewer(a, b) && !isNewer(b, a));
  assert.strictEqual(mergeItem(a, b), a);
}
// tombstone follows the same rules: newer delete wins, older delete loses to a later edit
{
  const live = it({ updatedAt: 1000 });
  const del = it({ deleted: true, updatedAt: 2000 });
  assert.strictEqual(mergeItem(live, del).deleted, true);
  const revived = it({ deleted: false, updatedAt: 3000 });
  assert.strictEqual(mergeItem(del, revived).deleted, false);
  const staleLive = it({ deleted: false, updatedAt: 1500 });
  assert.strictEqual(mergeItem(del, staleLive).deleted, true);
}
// missing sides
assert.strictEqual(mergeItem(null, it()).id, 'A');
assert.strictEqual(mergeItem(it(), undefined).id, 'A');
assert.strictEqual(mergeItem(null, null), null);

// clock skew helper
{
  const now = 1_000_000_000_000;
  assert.strictEqual(MAX_FUTURE_SKEW_MS, 600000);
  assert.ok(!exceedsSkew(now + MAX_FUTURE_SKEW_MS, now));
  assert.ok(exceedsSkew(now + MAX_FUTURE_SKEW_MS + 1, now));
  assert.ok(!exceedsSkew(now - 86400000, now));
}

// normalize / validate
{
  const n = normalizeItem({ id: 7, code: 101, name: 'n', legacyId: 5, updatedAt: '1234', updatedBy: 'd' });
  assert.strictEqual(n.id, '7');
  assert.strictEqual(n.code, '101');
  assert.strictEqual(n.cat, 'ทั่วไป');
  assert.strictEqual(n.fav, false);
  assert.deepStrictEqual(n.barcodes, []);
  assert.strictEqual(n.image, null);
  assert.strictEqual(n.updatedAt, 1234);
  assert.strictEqual(n.legacyId, 5);
  assert.strictEqual(normalizeItem(it({ code: '00101' })).code, '00101');
  assert.strictEqual(validateItem(n), null);
  assert.strictEqual(validateItem(normalizeItem({})), 'bad_id');
  assert.strictEqual(validateItem(normalizeItem({ id: 'a', updatedBy: 'd' })), 'bad_updatedAt');
  assert.strictEqual(validateItem(normalizeItem({ id: 'a', updatedAt: 5 })), 'bad_updatedBy');
  assert.strictEqual(validateItem(normalizeItem(it({ image: { hash: 'zz' } }))), 'bad_image');
  assert.strictEqual(validateItem(normalizeItem(it({ image: { hash: 'a'.repeat(64), ver: 1 } }))), null);
  assert.strictEqual(validateItem(null), 'not_an_object');
}

console.log('merge.test.js: all passed');
