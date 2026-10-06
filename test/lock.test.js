'use strict';
// catalog/catalog-lock.js: only one POS Hero process may own userData/catalog.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLock, pidAlive } = require('../catalog/catalog-lock');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catlock-'));
const file = path.join(dir, '.lock');

assert.ok(pidAlive(process.pid));
assert.ok(!pidAlive(0) && !pidAlive(-1) && !pidAlive(NaN));

// first owner wins, a live second process is refused
const a = createLock(dir);
assert.strictEqual(a.acquire(), true);
assert.strictEqual(fs.readFileSync(file, 'utf8'), String(process.pid));
const liveOther = process.ppid; // parent (run-all / shell) is alive and not us
const b = createLock(dir, liveOther);
assert.strictEqual(b.acquire(), false, 'second live process must not get the catalog');

// release removes the file only for the owner
b.release();
assert.ok(fs.existsSync(file));
a.release();
assert.ok(!fs.existsSync(file));

// a stale lock from a dead process is taken over
fs.writeFileSync(file, '999999999');
const c = createLock(dir);
assert.strictEqual(c.acquire(), true);
assert.strictEqual(c.owner(), process.pid);
c.release();

// garbage lock content counts as stale
fs.writeFileSync(file, 'not-a-pid');
const d = createLock(dir);
assert.strictEqual(d.acquire(), true);
d.release();

fs.rmSync(dir, { recursive: true, force: true });
console.log('lock.test.js ok');
