'use strict';
// catalog-sheet-import (spec 9.2): CSV-wrapped JSON parse, idempotent import, never overwrites local edits, image fetcher.
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jpeg = require('jpeg-js');
const { createStore } = require('../catalog/catalog-store');
const sheet = require('../catalog/catalog-sheet-import');
const migrate = require('../catalog/catalog-migrate');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-sheet-'));

function tinyJpeg(r, g, b) {
  const w = 8, h = 8, data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  return jpeg.encode({ data, width: w, height: h }, 80).data;
}

const IMG_OK = 'https://i.ibb.co/ok/a.jpg';
const IMG_404 = 'https://i.ibb.co/gone/b.jpg';
const IMG_HTML = 'https://i.ibb.co/page/c.jpg';
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/TEST/pub?gid=0&single=true&output=csv';

// 5 products covering spec 9.2's test cases (escaped quotes, leading-zero 14-digit code, dataURL, broken link, extra spaces)
const catalog = {
  items: [
    { id: 1770000000001, name: 'แชมพู "เคลียร์" 70มล.', code: '8851234567890', cat: 'แชมพู', img: IMG_OK },
    { id: 1770000000002, name: 'นมกล่อง ลัง', code: '08851234567891', cat: 'นม', img: IMG_404 },
    { id: 1770000000003, name: 'ครีม', code: '8850000000003', cat: 'โลชั่น', img: 'data:image/jpeg;base64,' + tinyJpeg(10, 200, 10).toString('base64') },
    { id: 1770000000004, name: '  หอมเจียว   ( 85 บาท) ', code: '8850000000004', cat: 'ของกิน', img: IMG_HTML },
    { id: 1770000000005, name: 'ไม่มีรูป', code: '8850000000005', cat: '', img: '' },
    { id: 1770000000006 } // no name, no code -> skipped
  ],
  categories: ['ของกิน', 'นม', 'แชมพู', 'โลชั่น']
};
const toCsv = (obj) => '"' + JSON.stringify(obj).replace(/"/g, '""') + '"\r\n';
assert.ok(toCsv(catalog).startsWith('"{""items"":'), 'fixture really has CSV-escaped quotes');

// fake fetch: url -> { status, body, type }
function makeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response('not found', { status: 404 });
    if (r.throws) throw new Error('network down');
    return new Response(r.body, { status: r.status || 200, headers: { 'content-type': r.type || 'application/octet-stream' } });
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  // 1. parsing
  const p = sheet.parseSheetCsv(toCsv(catalog));
  assert.ok(p.ok);
  assert.strictEqual(p.data.items[0].name, 'แชมพู "เคลียร์" 70มล.');
  assert.ok(sheet.parseSheetCsv(JSON.stringify(catalog)).ok, 'an unquoted cell is accepted too');
  assert.strictEqual(sheet.parseSheetCsv('').ok, false);
  assert.strictEqual(sheet.parseSheetCsv('<!DOCTYPE html><html>sign in</html>').ok, false);
  assert.strictEqual(sheet.parseSheetCsv('"{not json"').ok, false);
  assert.strictEqual(sheet.parseSheetCsv('"{""hello"":1}"').ok, false);

  const n = sheet.normalizeSheet(p.data);
  assert.strictEqual(n.counts.items, 5);
  assert.strictEqual(n.warnings.invalid, 1);
  assert.strictEqual(n.counts.imageLinks, 3);
  assert.strictEqual(n.counts.imageData, 1);
  const byLid = Object.fromEntries(n.items.map((i) => [i.legacyId, i]));
  assert.strictEqual(byLid['sheet:1770000000002'].code, '08851234567891', 'leading zero kept (string code)');
  assert.strictEqual(byLid['sheet:1770000000004'].name, 'หอมเจียว ( 85 บาท)', 'trimmed + collapsed spaces');
  assert.strictEqual(byLid['sheet:1770000000005'].cat, 'ทั่วไป');
  assert.deepStrictEqual(n.categories, ['ของกิน', 'นม', 'แชมพู', 'โลชั่น', 'ทั่วไป']);
  assert.strictEqual(sheet.normalizeSheet({ items: [{ id: 1, name: 'x', code: '1', img: 'http://plain.example/a.jpg' }] }).warnings.badImage, 1, 'http (not https) image link refused');

  // 2. fetching the sheet (redirects are followed by fetch itself)
  const routes = {
    [SHEET_URL]: { body: toCsv(catalog), type: 'text/csv' },
    [IMG_OK]: { body: tinyJpeg(200, 10, 10), type: 'image/jpeg' },
    [IMG_HTML]: { body: '<html>not an image</html>', type: 'text/html' }
  };
  const f1 = makeFetch(routes);
  const pv = await sheet.previewSheet({ url: SHEET_URL, fetchFn: f1 });
  assert.ok(pv.ok);
  assert.strictEqual(pv.counts.items, 5);
  assert.strictEqual((await sheet.previewSheet({ url: 'http://docs.google.com/x', fetchFn: f1 })).ok, false, 'https only');
  assert.strictEqual((await sheet.previewSheet({ url: 'https://docs.google.com/missing', fetchFn: f1 })).ok, false, '404');
  assert.strictEqual((await sheet.previewSheet({ url: SHEET_URL, fetchFn: makeFetch({ [SHEET_URL]: { throws: true } }) })).ok, false, 'network error');

  // 3. import into an empty store
  const dir = path.join(tmp, 'data');
  fs.mkdirSync(dir);
  const store = createStore(dir, { deviceId: 'dev-t' }).load();
  const prog = [];
  const r1 = await sheet.importSheet({ store, dir, url: SHEET_URL, fetchFn: f1, onProgress: (x) => prog.push(x) });
  assert.ok(r1.ok, r1.error);
  assert.deepStrictEqual([r1.summary.added, r1.summary.updated, r1.summary.unchanged, r1.summary.skipped], [5, 0, 0, 1]);
  assert.strictEqual(store.list().length, 5);
  assert.ok(prog.length && prog[prog.length - 1].done === 5);
  assert.deepStrictEqual(store.getMeta().categories, ['ของกิน', 'นม', 'แชมพู', 'โลชั่น', 'ทั่วไป'], 'sheet category order leads');
  const nom = store.list().find((i) => i.legacyId === 'sheet:1770000000002');
  assert.strictEqual(nom.code, '08851234567891');
  assert.strictEqual(nom.legacyImageUrl, IMG_404, 'link kept for a later retry');
  assert.strictEqual(r1.jobs.length, 4, '3 links + 1 dataURL; the item without a picture has no job');
  const dataJob = r1.jobs.find((j) => j.file);
  assert.ok(dataJob && migrate.readStaged(dir, dataJob.file)[0] === 0xff, 'dataURL staged like the legacy import');
  assert.ok(r1.jobs.filter((j) => j.url).every((j) => store.get(j.itemId).legacyImageUrl === j.url));

  // 4. image fetcher: by index only, prefetches ahead, failures reported per image
  const f2 = makeFetch(routes);
  const urls = r1.jobs.map((j) => j.url || null);
  const fetcher = sheet.createImageFetcher(urls, { fetchFn: f2, concurrency: 4 });
  const results = [];
  for (let i = 0; i < r1.jobs.length; i++) results.push(r1.jobs[i].url ? await fetcher.get(i) : null);
  const at = (u) => results[r1.jobs.findIndex((j) => j.url === u)];
  assert.ok(at(IMG_OK).ok && at(IMG_OK).mime === 'image/jpeg' && at(IMG_OK).bytes[0] === 0xff);
  assert.strictEqual(at(IMG_404).ok, false);
  assert.strictEqual(at(IMG_HTML).ok, false, 'a web page is not an image');
  assert.strictEqual(f2.calls.length, 3, 'each link downloaded once (prefetch is reused)');
  assert.strictEqual((await fetcher.get(99)).ok, false);
  assert.strictEqual((await fetcher.get(r1.jobs.indexOf(dataJob))).ok, false, 'staged jobs are not fetchable');
  migrate.cleanupTmp(dir);

  // 5. re-import: nothing duplicated or re-stamped; items still without an image get their jobs again (resume)
  const ids = store.list().map((i) => i.id).sort();
  const stamps = store.list().map((i) => i.updatedAt).sort();
  const r2 = await sheet.importSheet({ store, dir, url: SHEET_URL, fetchFn: f1 });
  assert.deepStrictEqual([r2.summary.added, r2.summary.updated, r2.summary.unchanged], [0, 0, 5]);
  assert.deepStrictEqual(store.list().map((i) => i.id).sort(), ids);
  assert.deepStrictEqual(store.list().map((i) => i.updatedAt).sort(), stamps);
  assert.strictEqual(r2.jobs.length, 4);
  const done = store.get(r2.jobs[0].itemId);
  store.put(Object.assign({}, done, { image: { hash: 'a'.repeat(64), ver: 1, edit: {}, quality: 'ok', w: 10, h: 10 } }));
  assert.strictEqual((await sheet.importSheet({ store, dir, url: SHEET_URL, fetchFn: f1 })).jobs.length, 3);

  // 6. local edits win, deletes stay deleted, an item made by hand is matched by code (not duplicated)
  const dir2 = path.join(tmp, 'data2');
  fs.mkdirSync(dir2);
  const s2 = createStore(dir2, { deviceId: 'dev-u' }).load();
  const manual = s2.put({ name: 'แชมพูเคลียร์ (ชื่อที่ Boss แก้)', code: '8851234567890', cat: 'ของใช้', image: { hash: 'b'.repeat(64), ver: 1, edit: {}, quality: 'ok', w: 9, h: 9 } });
  const empty = s2.put({ name: '', code: '8850000000005', cat: 'ทั่วไป' });
  const gone = s2.put({ name: 'นม', code: '08851234567891', cat: 'นม' });
  s2.remove([gone.id]);
  const r3 = await sheet.importSheet({ store: s2, dir: dir2, url: SHEET_URL, fetchFn: f1 });
  assert.ok(r3.ok);
  assert.strictEqual(r3.summary.added, 2, 'ครีม + หอมเจียว');
  assert.strictEqual(r3.summary.updated, 2, 'manual (legacyId + link) and empty (name)');
  assert.strictEqual(r3.summary.skippedDeleted, 1, 'a product deleted by hand (matched by code) is not brought back');
  assert.ok(!s2.list().some((i) => i.code === '08851234567891'));
  const m = s2.get(manual.id);
  assert.strictEqual(m.name, 'แชมพูเคลียร์ (ชื่อที่ Boss แก้)', 'name not overwritten');
  assert.strictEqual(m.cat, 'ของใช้', 'category not overwritten');
  assert.strictEqual(m.image.hash, 'b'.repeat(64), 'image not overwritten');
  assert.strictEqual(m.legacyId, 'sheet:1770000000001');
  assert.ok(!r3.jobs.some((j) => j.itemId === manual.id), 'no image job for an item that already has one');
  assert.strictEqual(s2.get(empty.id).name, 'ไม่มีรูป', 'empty name filled in');
  assert.strictEqual(s2.list().filter((i) => i.code === '8851234567890').length, 1, 'no duplicate by code');
  const r4 = await sheet.importSheet({ store: s2, dir: dir2, url: SHEET_URL, fetchFn: f1 });
  assert.strictEqual(r4.summary.added, 0, 'second import adds nothing');
  const cream = s2.list().find((i) => i.legacyId === 'sheet:1770000000003');
  s2.remove([cream.id]);
  const r5 = await sheet.importSheet({ store: s2, dir: dir2, url: SHEET_URL, fetchFn: f1 });
  assert.strictEqual(r5.summary.skippedDeleted, 2, 'deleting an imported item keeps it deleted on re-import');
  assert.strictEqual(r5.summary.added, 0);

  console.log('migrate-sheet.test.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
