'use strict';
// catalog-migrate: lenient parse of the legacy catalog-data.json, idempotent import, legacy file untouched.
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const jpeg = require('jpeg-js');
const { createStore } = require('../catalog/catalog-store');
const migrate = require('../catalog/catalog-migrate');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-migrate-'));

function tinyJpegDataUrl(r, g, b) {
  const w = 8, h = 8, data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  return 'data:image/jpeg;base64,' + jpeg.encode({ data, width: w, height: h }, 80).data.toString('base64');
}

// Fixture: numeric ids/codes, favorites (mixed number/string), missing fields, duplicates, bad images
const legacy = {
  items: [
    { id: 1700000000001, name: 'น้ำดื่ม', code: '00101', cat: 'เครื่องดื่ม', img: tinyJpegDataUrl(200, 30, 30) },
    { id: 1700000000002, name: 'ขนม', code: 4710088, cat: 'ขนม' },
    { id: '1700000000003', name: 'สบู่', code: '77', img: tinyJpegDataUrl(30, 30, 200) },
    { id: 1700000000004, name: 'รูปเสีย', code: '88', cat: 'ทั่วไป', img: 'data:image/jpeg;base64,AAAA' },
    { id: 1700000000002, name: 'ขนม (ซ้ำ)', code: '4710088', cat: 'ขนม' },
    { name: 'ไม่มีไอดี', code: '5' },
    { id: 1700000000009 },
    null,
    { id: 1700000000010, name: 'เห็ดหอม', code: '', cat: 'ของสด', img: '' }
  ],
  categories: ['เครื่องดื่ม', 'ขนม', 'หมวดว่าง', 5],
  favoriteIds: [1700000000001, '1700000000003'],
  shopName: 'ร้านทดสอบ',
  auth: { salt: 'abc', hash: 'def', N: 16384, r: 8, p: 1 }
};
const legacyDir = path.join(tmp, 'Catalog Hero');
fs.mkdirSync(legacyDir, { recursive: true });
const legacyFile = path.join(legacyDir, 'catalog-data.json');
fs.writeFileSync(legacyFile, JSON.stringify(legacy));
const legacySha = () => crypto.createHash('sha256').update(fs.readFileSync(legacyFile)).digest('hex');
const before = legacySha();
const mtimeBefore = fs.statSync(legacyFile).mtimeMs;

(async () => {
  // 1. discovery: appdata + a shared folder named under an unexpected key
  const shared = path.join(tmp, 'shared');
  fs.mkdirSync(shared);
  fs.copyFileSync(legacyFile, path.join(shared, 'catalog-data.json'));
  fs.writeFileSync(path.join(legacyDir, 'sync-config.json'), JSON.stringify({ enabled: true, nested: { sharedFolder: shared }, url: 'https://x.invalid/a' }));
  const cands = migrate.findCandidates({ appData: tmp });
  assert.deepStrictEqual(cands.map((c) => c.source).sort(), ['appdata', 'shared']);
  assert.ok(cands.every((c) => c.size > 0));
  assert.deepStrictEqual(migrate.findCandidates({ appData: path.join(tmp, 'nothing') }), []);

  // 2. normalize
  const pv = migrate.previewLegacy(legacyFile);
  assert.ok(pv.ok);
  assert.strictEqual(pv.counts.items, 6, 'dup merged, invalid + null dropped');
  assert.strictEqual(pv.counts.withImage, 2);
  assert.strictEqual(pv.counts.favorites, 2);
  assert.strictEqual(pv.warnings.badImage, 1);
  assert.strictEqual(pv.warnings.dupIds, 1);
  assert.strictEqual(pv.warnings.invalid, 2);
  assert.strictEqual(pv.warnings.noId, 1);
  assert.strictEqual(pv.warnings.numericCodes, 1);
  assert.ok(pv.hasAuth);
  assert.strictEqual(pv.shopName, 'ร้านทดสอบ');
  const nd = migrate.readLegacy(legacyFile).data;
  assert.deepStrictEqual(nd.categories, ['ทั่วไป', 'เครื่องดื่ม', 'ขนม', 'หมวดว่าง', '5', 'ของสด']);
  const byLid = Object.fromEntries(nd.items.map((i) => [i.legacyId, i]));
  assert.strictEqual(byLid['1700000000001'].code, '00101', 'leading zeros kept for string codes');
  assert.strictEqual(byLid['1700000000002'].code, '4710088');
  assert.strictEqual(byLid['1700000000002'].name, 'ขนม (ซ้ำ)');
  assert.strictEqual(byLid['1700000000003'].cat, 'ทั่วไป');
  assert.strictEqual(byLid['1700000000003'].fav, true, 'String compare of favoriteIds');
  assert.strictEqual(byLid['1700000000002'].fav, false);
  assert.ok(byLid['1700000000001'].img && byLid['1700000000001'].img.bytes[0] === 0xff);
  assert.strictEqual(byLid['1700000000004'].img, null);
  assert.strictEqual(migrate.readLegacy(path.join(tmp, 'missing.json')).ok, false);
  fs.writeFileSync(path.join(tmp, 'bad.json'), '{not json');
  assert.strictEqual(migrate.readLegacy(path.join(tmp, 'bad.json')).ok, false);
  fs.writeFileSync(path.join(tmp, 'other.json'), '{"hello":1}');
  assert.strictEqual(migrate.readLegacy(path.join(tmp, 'other.json')).ok, false);

  // 3. import into a store
  const dir = path.join(tmp, 'data');
  fs.mkdirSync(dir);
  const store = createStore(dir, { deviceId: 'dev-t' }).load();
  const prog = [];
  const r1 = await migrate.importLegacy({ store, dir, file: legacyFile, onProgress: (p) => prog.push(p) });
  assert.ok(r1.ok);
  assert.deepStrictEqual([r1.summary.added, r1.summary.updated, r1.summary.unchanged], [6, 0, 0]);
  assert.strictEqual(r1.summary.skipped, 2);
  assert.strictEqual(store.list().length, 6);
  assert.ok(prog.length >= 1 && prog[prog.length - 1].done === 6);
  assert.ok(store.list().every((i) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(i.id) && i.legacyId), 'ULID ids + legacyId');
  const fav = store.list().filter((i) => i.fav).map((i) => i.legacyId).sort();
  assert.deepStrictEqual(fav, ['1700000000001', '1700000000003']);
  assert.deepStrictEqual(store.getMeta().categories, nd.categories);
  assert.strictEqual(store.getMeta().shopName, 'ร้านทดสอบ');
  assert.strictEqual(r1.jobs.length, 2);
  assert.ok(r1.authSaved);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).auth.hash, 'def');
  store.flush();
  assert.ok(!fs.readFileSync(store.file, 'utf8').includes('"hash":"def"'), 'auth is not in db.json');
  for (const j of r1.jobs) {
    const b = migrate.readStaged(dir, j.file);
    assert.ok(b && b[0] === 0xff, 'staged image readable');
    assert.strictEqual(store.get(j.itemId).legacyId, j.legacyId);
  }
  assert.strictEqual(migrate.readStaged(dir, '../db.json'), null);
  migrate.cleanupTmp(dir);
  assert.ok(!fs.existsSync(migrate.tmpDir(dir)));

  // 4. re-import: nothing duplicated or re-stamped; jobs come again for items still without an image
  const idsBefore = store.list().map((i) => i.id).sort();
  const stampBefore = store.list().map((i) => i.updatedAt).sort();
  const r2 = await migrate.importLegacy({ store, dir, file: legacyFile });
  assert.deepStrictEqual([r2.summary.added, r2.summary.updated, r2.summary.unchanged], [0, 0, 6]);
  assert.deepStrictEqual(store.list().map((i) => i.id).sort(), idsBefore);
  assert.deepStrictEqual(store.list().map((i) => i.updatedAt).sort(), stampBefore, 'unchanged items are not re-stamped');
  assert.strictEqual(r2.jobs.length, 2, 'images not attached yet -> resumable');
  const withImg = store.get(r2.jobs[0].itemId);
  store.put(Object.assign({}, withImg, { image: { hash: 'a'.repeat(64), ver: 1, edit: {}, quality: 'ok', w: 10, h: 10 } }));
  const r3 = await migrate.importLegacy({ store, dir, file: legacyFile });
  assert.strictEqual(r3.jobs.length, 1);
  assert.strictEqual(r3.summary.unchanged, 6);

  // 5. changed legacy data -> update in place; a locally deleted item stays deleted; local-only fields are kept
  const l2 = JSON.parse(JSON.stringify(legacy));
  l2.items[0].name = 'น้ำดื่ม (ใหม่)';
  l2.favoriteIds = [1700000000002];
  l2.items.push({ id: 1700000000011, name: 'ใหม่', code: '9' });
  const file2 = path.join(tmp, 'v2.json');
  fs.writeFileSync(file2, JSON.stringify(l2));
  const goneId = store.list().find((i) => i.legacyId === '1700000000010').id;
  store.remove([goneId]);
  const lid3 = store.list().find((i) => i.legacyId === '1700000000003');
  store.put(Object.assign({}, lid3, { shortName: 'สบู่สั้น' }));
  const r4 = await migrate.importLegacy({ store, dir, file: file2 });
  assert.strictEqual(r4.summary.added, 1);
  assert.strictEqual(r4.summary.updated, 3, 'name change + 2 fav changes');
  assert.strictEqual(r4.summary.skippedDeleted, 1);
  assert.strictEqual(store.list().length, 6 - 1 + 1);
  assert.strictEqual(store.list().find((i) => i.legacyId === '1700000000001').name, 'น้ำดื่ม (ใหม่)');
  assert.strictEqual(store.get(lid3.id).shortName, 'สบู่สั้น');
  assert.strictEqual(store.get(lid3.id).fav, false);
  assert.strictEqual(store.list().find((i) => i.legacyId === '1700000000002').fav, true);
  assert.ok(!store.list().some((i) => i.id === goneId));

  // 6. the legacy file is never touched
  assert.strictEqual(legacySha(), before);
  assert.strictEqual(fs.statSync(legacyFile).mtimeMs, mtimeBefore);
  console.log('migrate.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
