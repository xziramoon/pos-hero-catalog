'use strict';
const assert = require('node:assert');
const { ulid, ALPHABET } = require('../catalog/shared/ulid');

// format
const a = ulid();
assert.strictEqual(a.length, 26);
assert.ok([...a].every((c) => ALPHABET.includes(c)), 'Crockford alphabet only');

// time prefix decodes to the given timestamp
const t = Date.now() + 3600000; // in the future so the generator state from the call above does not clamp it
const u = ulid(t);
let dec = 0;
for (const c of u.slice(0, 10)) dec = dec * 32 + ALPHABET.indexOf(c);
assert.strictEqual(dec, t);

// monotonic and unique within the same ms
const ids = [];
for (let i = 0; i < 5000; i++) ids.push(ulid(t + 1000));
assert.strictEqual(new Set(ids).size, ids.length, 'unique');
for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], 'monotonic at ' + i);

// later time sorts after earlier time
assert.ok(ulid(t + 5000) > ids[ids.length - 1]);

// clock going backwards never yields a smaller id
const x = ulid(t + 9000);
const y = ulid(t + 8000);
assert.ok(y > x);

console.log('ulid.test.js ok');
