'use strict';
// Data-safety behaviour of catalog-sync against an in-memory fake Worker (no network, no Electron).
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createStore } = require('../catalog/catalog-store');
const { createOutbox } = require('../catalog/catalog-outbox');
const { createImages } = require('../catalog/catalog-images');
const { createSync } = require('../catalog/catalog-sync');
const { createFakeWorker } = require('./fake-worker');

const KEY = 'k'.repeat(40);
const TOKEN = 'T'.repeat(20);
const dirs = [];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mk(worker, o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-safety-'));
  dirs.push(dir);
  const store = createStore(dir, { deviceId: o.deviceId || 'dev-a' }).load();
  const outbox = createOutbox(dir, { retryMs: 20 }).load();
  const images = createImages(path.join(dir, 'images'));
  const cfg = { worker: Object.assign({ url: 'https://fake.example', key: KEY, writeToken: o.token === undefined ? TOKEN : o.token }, o.worker) };
  const sync = createSync({ store, outbox, images, getConfig: () => cfg, fetch: worker.fetch, warn: () => {}, log: () => {}, isVisible: () => true });
  return { dir, store, outbox, images, sync, cfg };
}
const calls = (w, method, rest) => w.log.filter((l) => l.method === method && (rest instanceof RegExp ? rest.test(l.rest) : l.rest === rest));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('409 skew restamps only items that are too far in the future', async () => {
  const w = createFakeWorker();
  const c = mk(w);
  c.store.setClockOffset(-3600000); const old = c.store.put({ name: 'เก่า offline', code: '1' });
  c.store.setClockOffset(30 * 60000); const fut = c.store.put({ name: 'นาฬิกาเร็ว', code: '2' });
  c.store.setClockOffset(0);
  const oldStamp = old.updatedAt;
  assert.ok(fut.updatedAt > Date.now() + 25 * 60000);
  await c.sync._cycle();
  assert.strictEqual(c.outbox.size(), 0, 'all delivered');
  assert.strictEqual(w.items.get(old.id).updatedAt, oldStamp, 'correctly stamped old edit untouched');
  assert.ok(w.items.get(fut.id).updatedAt < Date.now() + 60000, 'future edit clamped to corrected clock');
  assert.ok(calls(w, 'POST', '/items').length >= 2, 'first POST got 409, then retried');
});

test('clock offset is re-measured from serverTime and reset to 0 when the clock is right', async () => {
  const w = createFakeWorker();
  const c = mk(w);
  c.store.setClockOffset(-90000); // stale offset from a time when the Windows clock was wrong
  await c.sync._cycle();
  assert.strictEqual(c.store.clockOffset, 0, 'reset to 0 once the device clock matches the server');
  w.clockSkewMs = 20 * 60000;     // now the server is 20 min ahead of this machine
  await c.sync._cycle();
  assert.ok(Math.abs(c.store.clockOffset - 20 * 60000) < 3000, 'follows a real skew: ' + c.store.clockOffset);
  w.clockSkewMs = 1000;
  await c.sync._cycle();
  assert.strictEqual(c.store.clockOffset, 0, 'small difference means offset 0');
});

test('server wiped (since > rev): local copies are kept, backed up and re-queued', async () => {
  const w = createFakeWorker();
  const c = mk(w);
  const a = c.store.put({ name: 'A', code: '1' }), b = c.store.put({ name: 'B', code: '2' });
  await c.sync._cycle();
  await c.sync._cycle(); // second pull learns the server rev (as in normal polling)
  assert.strictEqual(w.itemCount(), 2);
  assert.ok(c.store.lastRev > 0);
  w.reset();                       // the Worker lost everything
  await c.sync._cycle();
  assert.ok(fs.readdirSync(path.join(c.dir, 'backups')).some((f) => f.startsWith('db-reset-')), 'db.json backed up before resetAll');
  assert.ok(c.store.get(a.id) && c.store.get(b.id), 'local items survive');
  assert.strictEqual(w.itemCount(), 2, 'and are pushed back to the server');
  assert.strictEqual(c.outbox.size(), 0);
});

test('tombstone horizon reset: purged synced items go, never-synced and rejected items stay', async () => {
  const w = createFakeWorker();
  const c = mk(w);
  const t = c.store.put({ name: 'T', code: '1' });
  await c.sync._cycle();
  c.store.remove(t.id);
  await c.sync._cycle();
  assert.ok(w.items.get(t.id).deleted);
  // server purges the tombstone and moves the horizon past our lastRev
  w.items.delete(t.id); w.rev += 3; w.horizonRev = w.rev; w.seed({ id: 'OTHER', code: '9', name: 'other', updatedAt: Date.now(), updatedBy: 'dev-z', deleted: false });
  const bad = c.store.put({ name: 'rejected', code: '2' });
  w.rejectIds.set(bad.id, 'bad_image');
  await c.sync._cycle();
  assert.ok(c.store.get('OTHER'), 'server item pulled');
  assert.strictEqual(c.store.get(t.id), null, 'purged synced tombstone dropped');
  assert.ok(c.store.get(bad.id), 'rejected item is never erased by a re-pull');
  const st = c.sync.getStatus();
  assert.strictEqual(st.problemCount, 1);
  assert.strictEqual(st.problems[0].id, bad.id);
  assert.ok(/บันทึกใหม่/.test(st.problems[0].reason), 'Thai instruction: ' + st.problems[0].reason);
  // editing the item clears the problem and retries
  w.rejectIds.clear();
  c.store.put({ id: bad.id, name: 'rejected fixed' });
  await c.sync._cycle();
  assert.strictEqual(c.sync.getStatus().problemCount, 0);
  assert.strictEqual(w.items.get(bad.id).name, 'rejected fixed');
});

test('different catalog with items: nothing is merged until the user confirms; images are re-queued', async () => {
  const w = createFakeWorker();
  for (let i = 0; i < 3; i++) w.seed({ id: 'S' + i, code: String(i), name: 's' + i, updatedAt: Date.now() - 1000, updatedBy: 'dev-z', deleted: false });
  const c = mk(w);
  const orig = Buffer.from('orig-bytes'), thumb = Buffer.from('thumb-bytes'), full = Buffer.from('full-bytes');
  const hash = sha(orig);
  c.images.write(hash, 'orig', null, orig); c.images.write(hash, 'thumb', 1, thumb); c.images.write(hash, 'full', 1, full); // files exist, no 'saved' event
  const l1 = c.store.put({ name: 'L1', code: 'L1', image: { hash, ver: 1 } });
  c.store.put({ name: 'L2', code: 'L2' });
  await c.sync._cycle();
  let st = c.sync.getStatus();
  assert.strictEqual(st.state, 'confirm-target');
  assert.strictEqual(st.target.itemCount, 3);
  assert.strictEqual(calls(w, 'POST', '/items').length, 0, 'no write before confirmation');
  assert.strictEqual(calls(w, 'GET', /^\/changes/).length, 0, 'no pull merged before confirmation');
  assert.strictEqual(c.store.list().length, 2);
  assert.strictEqual(c.sync.confirmTarget().ok, true);
  await c.sync.syncNow();
  assert.strictEqual(w.itemCount(), 5, 'local items merged into the catalog');
  assert.strictEqual(c.store.list().length, 5, 'server items pulled');
  assert.ok(w.items.get(l1.id));
  assert.deepStrictEqual(Array.from(w.imgs.keys()).sort(), [hash + '/full-v1', hash + '/orig', hash + '/thumb-v1'].sort(), 'referenced images uploaded');
  assert.strictEqual(c.sync.getStatus().state, 'ok');
  // no prompt when the local store is empty
  const w2 = createFakeWorker(); w2.seed({ id: 'S', code: '1', name: 's', updatedAt: 1, updatedBy: 'd', deleted: false });
  const e = mk(w2);
  await e.sync._cycle();
  assert.strictEqual(e.store.list().length, 1);
  assert.notStrictEqual(e.sync.getStatus().state, 'confirm-target');
});

test('a failing image never blocks meta/items; the item goes after N tries; problem is surfaced and cleared', async () => {
  const w = createFakeWorker();
  const c = mk(w);
  w.failures.push({ test: (m, r) => m === 'PUT' && r.startsWith('/img/'), status: 500, times: -1 });
  const b = Buffer.from('x'.repeat(50)); const hash = sha(b);
  c.images.saveVariants(hash, 1, { orig: b, thumb: b, full: b });
  const withImg = c.store.put({ name: 'มีรูป', code: 'I', image: { hash, ver: 1 } });
  const plain = c.store.put({ name: 'ธรรมดา', code: 'P', cat: 'หมวดใหม่' });
  await c.sync._cycle();
  assert.ok(w.items.get(plain.id), 'plain item pushed despite image failure');
  assert.ok(w.meta && w.meta.categories.includes('หมวดใหม่'), 'meta pushed despite image failure');
  assert.ok(!w.items.get(withImg.id), 'image item waits for its images at first');
  for (let i = 0; i < 6; i++) { for (const e of c.outbox.list()) e.nextAt = 0; await c.sync._cycle(); } // wait out the backoff, keep the tries
  assert.ok(w.items.get(withImg.id), 'after N failed tries the item is pushed anyway');
  assert.ok(c.outbox.list().some((e) => e.op === 'img'), 'image stays queued for later');
  const st = c.sync.getStatus();
  assert.ok(st.problems.some((p) => p.kind === 'image' && /รูป/.test(p.reason)), 'image problem surfaced');
  w.failures.length = 0;
  c.outbox.resetBackoff(); await c.sync._cycle();
  assert.strictEqual(w.imgs.size, 3, 'image uploaded once the Worker recovers');
  assert.strictEqual(c.sync.getStatus().problemCount, 0);
  assert.strictEqual(c.outbox.size(), 0);
});

test('image 413 is permanent (dropped + reported) and does not stop the push', async () => {
  const w = createFakeWorker();
  const c = mk(w);
  w.failures.push({ test: (m, r) => m === 'PUT' && r.startsWith('/img/'), status: 413, times: -1 });
  const b = Buffer.from('y'.repeat(30)); const hash = sha(b);
  c.images.saveVariants(hash, 1, { orig: b, thumb: b, full: b });
  const it = c.store.put({ name: 'big', code: 'B', image: { hash, ver: 1 } });
  await c.sync._cycle();
  assert.ok(w.items.get(it.id), 'item delivered');
  assert.strictEqual(c.outbox.list().filter((e) => e.op === 'img').length, 0);
  assert.strictEqual(c.sync.getStatus().problemCount, 3);
});

test('applyRemoteMeta restamps with max(now, remote+1)', async () => {
  const c = mk(createFakeWorker());
  c.store.put({ name: 'x', code: '1', cat: 'ใช้อยู่' });
  const future = c.store.now() + 60000;
  const r = c.store.applyRemoteMeta({ categories: ['ทั่วไป'], shopName: 'r', updatedAt: future, rev: 3 }, { union: true });
  assert.ok(r.needsPush);
  assert.strictEqual(c.store.getMeta().updatedAt, future + 1);
});

test('durability: outbox is on disk before the edit call returns; lost outbox entries are re-queued from synced stamps', async () => {
  const w = createFakeWorker();
  const c = mk(w);
  const it = c.store.put({ name: 'dur', code: '1' });
  const onDisk = JSON.parse(fs.readFileSync(path.join(c.dir, 'outbox.json'), 'utf8'));
  assert.ok(onDisk.some((e) => e.op === 'item' && e.payload.id === it.id), 'outbox.json already written');
  await c.sync._cycle();
  assert.ok(c.store.isSynced(c.store.get(it.id)));
  // simulate: edit reached db.json but the outbox write never happened
  const edited = c.store.put({ id: it.id, name: 'dur2' });
  c.outbox.remove('item:' + it.id);
  assert.strictEqual(c.outbox.size(), 0);
  assert.strictEqual(c.store.isSynced(edited), false);
  c.sync._problems.clear();
  await c.sync._cycle();
  assert.strictEqual(w.items.get(it.id).name, 'dur', 'not yet: reconcile runs once per start / config change');
  const c2 = mk(w); // fresh process on the same data dir
  fs.copyFileSync(path.join(c.dir, 'outbox.json'), path.join(c2.dir, 'outbox.json'));
  c.store.flush();
  const s2 = createStore(c.dir, { deviceId: 'dev-a' }).load();
  const sy2 = createSync({ store: s2, outbox: createOutbox(c.dir).load(), images: c.images, getConfig: () => c.cfg, fetch: w.fetch, warn: () => {}, log: () => {} });
  await sy2._cycle();
  assert.strictEqual(w.items.get(it.id).name, 'dur2', 'unsynced stamp re-queued after restart');
});

test('outbox/db flush failure is retried (EPERM from antivirus)', async () => {
  const c = mk(createFakeWorker());
  const real = fs.renameSync;
  let fails = 2;
  fs.renameSync = function (a, b) { if (String(b).endsWith('outbox.json') && fails-- > 0) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } return real.apply(fs, arguments); };
  try {
    c.outbox.enqueueItem({ id: 'Q', code: '1', name: 'q', updatedAt: 1, updatedBy: 'd' });
    assert.strictEqual(c.outbox.flush(), false);
    await sleep(200);
  } finally { fs.renameSync = real; }
  assert.ok(JSON.parse(fs.readFileSync(path.join(c.dir, 'outbox.json'), 'utf8')).length === 1, 'written by the retry timer');
});

test('testConnection: token only for the saved URL, redirect:error everywhere, plain http rejected except localhost', async () => {
  const w = createFakeWorker();
  const c = mk(w);
  let r = await c.sync.testConnection({ url: 'https://other.example', key: KEY });
  assert.ok(r.ok);
  assert.strictEqual(calls(w, 'POST', '/items').length, 0, 'token not sent to a URL the user just typed');
  assert.ok(!w.log.some((l) => l.host === 'other.example' && l.headers['X-Catalog-Write']));
  r = await c.sync.testConnection({ url: 'https://fake.example/', key: KEY });
  assert.strictEqual(r.tokenOk, true);
  const posts = calls(w, 'POST', '/items');
  assert.strictEqual(posts.length, 1); assert.strictEqual(posts[0].headers['X-Catalog-Write'], TOKEN);
  assert.ok(w.log.length > 0 && w.log.every((l) => l.redirect === 'error'), 'redirect: error on every Worker fetch');
  r = await c.sync.testConnection({ url: 'http://evil.example', key: KEY });
  assert.ok(!r.ok && r.code === 'httpUrl' && /https:\/\//.test(r.message));
  r = await c.sync.testConnection({ url: 'http://127.0.0.1:8787', key: KEY });
  assert.ok(r.ok, 'http://127.0.0.1 allowed for wrangler dev');
  c.cfg.worker.url = 'http://evil.example';
  assert.strictEqual(c.sync.getStatus().state, 'unconfigured', 'saved plain-http URL is not used');
});

test('lazy downloads: concurrency cap, size cap, normalized keys', async () => {
  const w = createFakeWorker();
  const c = mk(w, { worker: { maxConcurrentDownloads: 2 } });
  const body = Buffer.from('jpegbytes');
  w.imgBody = { buf: body, contentLength: body.length }; w.imgDelayMs = 30;
  const hashes = Array.from({ length: 8 }, (_, i) => sha('h' + i));
  const got = await Promise.all(hashes.map((h) => c.sync.ensureImage(h, 'thumb', 1)));
  assert.ok(got.every(Boolean));
  assert.ok(w.imgMaxActive <= 2, 'max concurrent downloads: ' + w.imgMaxActive);
  assert.strictEqual(w.imgGets, 8);
  w.imgGets = 0;
  const h = sha('norm');
  const [p1, p2, p3] = await Promise.all([c.sync.ensureImage(h.toUpperCase(), 'thumb', '2'), c.sync.ensureImage(h, 'thumb', 2), c.sync.ensureImage(h, 'thumb', 2)]);
  assert.ok(p1 && p1 === p2 && p2 === p3);
  assert.strictEqual(w.imgGets, 1, 'one request for equivalent keys');
  assert.strictEqual(await c.sync.ensureImage('not-a-hash', 'thumb', 1), null);
  // size cap: declared and undeclared
  const big = Buffer.alloc(5 * 1024 * 1024 + 10, 1);
  w.imgBody = { buf: big, contentLength: big.length };
  assert.strictEqual(await c.sync.ensureImage(sha('big1'), 'full', 1), null, 'declared too large');
  w.imgBody = { buf: big, contentLength: null };
  assert.strictEqual(await c.sync.ensureImage(sha('big2'), 'full', 1), null, 'undeclared too large');
  assert.ok(!c.images.has(sha('big2'), 'full', 1));
});

test('poll interval: focused / unfocused / hidden, backoff while pulls fail, warning unaffected', async () => {
  const w = createFakeWorker();
  let t = 5000000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-poll-')); dirs.push(dir);
  const store = createStore(dir, { deviceId: 'dev-a' }).load();
  const outbox = createOutbox(dir).load();
  const cfg = { worker: { url: 'https://fake.example', key: KEY, writeToken: TOKEN } };
  const sync = createSync({ store, outbox, images: createImages(path.join(dir, 'images')), getConfig: () => cfg, fetch: w.fetch, now: () => t, warn: () => {}, log: () => {}, isVisible: () => true, isFocused: () => true });
  assert.strictEqual(sync._nextWait(), 5000);
  sync.setFocused(false); await sleep(20);
  assert.strictEqual(sync._nextWait(), 15000);
  sync.setVisible(false); await sleep(20);
  assert.strictEqual(sync._nextWait(), 60000);
  sync.setVisible(true); sync.setFocused(true); await sleep(30);
  assert.strictEqual(sync._nextWait(), 5000);
  w.failures.push({ test: () => true, status: 'throw', times: -1 });
  const waits = [];
  for (let i = 0; i < 5; i++) { await sync._cycle(); waits.push(sync._nextWait()); t += 1000; }
  assert.deepStrictEqual(waits, [10000, 20000, 40000, 60000, 60000]);
  t += 4 * 60000;
  await sync._cycle();
  assert.strictEqual(sync.getStatus().warn, true, 'warning bar still driven by time since first failure');
  w.failures.length = 0;
  await sync._cycle();
  assert.strictEqual(sync._nextWait(), 5000, 'backoff resets after a good pull');
  sync.stop();
});

test('orig downloaded from R2 is verified against its sha256 before it is stored', async () => {
  const w = createFakeWorker();
  const good = Buffer.from('good-orig-bytes'), hash = sha(good);
  w.imgs.set(hash + '/orig', good);
  const c = mk(w);
  const p = await c.sync.ensureImage(hash, 'orig', null);
  assert.ok(p && c.images.has(hash, 'orig'), 'matching bytes are stored');
  const bad = sha(Buffer.from('something else'));
  w.imgs.set(bad + '/orig', Buffer.from('corrupted download'));
  assert.strictEqual(await c.sync.ensureImage(bad, 'orig', null), null, 'mismatching bytes are rejected');
  assert.ok(!c.images.has(bad, 'orig'), 'and nothing is left on disk');
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ok -', name); } catch (e) { failed++; console.error('  FAIL -', name, '\n', e && e.stack || e); }
  }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
  if (failed) { console.error(failed + ' sync-safety test(s) failed'); process.exit(1); }
  console.log('sync-safety.test.js ok');
  process.exit(0);
})();
