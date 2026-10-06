'use strict';
const assert = require('node:assert');
const { sanitizeMetaPatch, sanitizeItemInput, sanitizeConfigPatch } = require('../catalog/sanitize');

// ---- meta
let m = sanitizeMetaPatch({ categories: ['  ก ', 'ก', '', 5, 'x'.repeat(61), 'ข'], shopName: ' ร้าน ', evil: 1, rev: 9 });
assert.deepStrictEqual(m, { categories: ['ทั่วไป', 'ก', 'ข'], shopName: 'ร้าน' });
m = sanitizeMetaPatch({ categories: ['ทั่วไป', 'ก'] });
assert.deepStrictEqual(m.categories, ['ทั่วไป', 'ก']);
assert.deepStrictEqual(sanitizeMetaPatch({ shopName: 'x'.repeat(121) }), {}, 'overlong shopName rejected');
assert.deepStrictEqual(sanitizeMetaPatch({ categories: 'nope', schemaVersion: 99, updatedAt: 1 }), {});
assert.deepStrictEqual(sanitizeMetaPatch(null), {});

// ---- item
const it = sanitizeItemInput({
  id: 'abc', name: ' น้ำ ', shortName: 's', code: 101, cat: '', fav: 'yes', barcodes: ['1', 2, {}, ' '], tags: ['t'],
  deleted: true, rev: 5, updatedAt: 1, updatedBy: 'evil', image: { hash: 'x' }, schemaVersion: 7, legacyId: 'z'
});
assert.deepStrictEqual(it, { id: 'abc', name: 'น้ำ', shortName: 's', code: '101', cat: 'ทั่วไป', fav: false, barcodes: ['1', '2'], tags: ['t'] });
for (const k of ['deleted', 'rev', 'updatedAt', 'updatedBy', 'image', 'schemaVersion']) assert.ok(!(k in it), k + ' must not pass');
// partial update only carries given fields
assert.deepStrictEqual(sanitizeItemInput({ id: 'a', fav: true }), { id: 'a', fav: true });
assert.deepStrictEqual(sanitizeItemInput({ id: 5, name: 'n' }), { name: 'n' }, 'non-string id dropped');
assert.deepStrictEqual(sanitizeItemInput('x'), {});

// ---- config
const c = sanitizeConfigPatch({ worker: { url: 'https://x', writeToken: 'secret' }, window: { hotkey: 'F9', alwaysOnTop: false }, hasWriteToken: true });
assert.deepStrictEqual(c, { worker: { url: 'https://x' }, window: { alwaysOnTop: false } });

// global hotkeys need Ctrl/Alt so they never steal a bare key from the POS program
const { hasModifier } = require('../catalog/sanitize');
for (const k of ['Ctrl+Alt+B', 'Alt+Q', 'Ctrl+F2', 'CommandOrControl+Shift+K']) assert.ok(hasModifier(k), k);
for (const k of ['F2', 'Shift+F2', 'B', '', null, 'Shift+Alt']) assert.ok(!hasModifier(k), String(k));
assert.ok(hasModifier(require('../catalog/defaults').defaults.window.hotkey), 'default hotkey has a modifier');

console.log('sanitize.test.js ok');
