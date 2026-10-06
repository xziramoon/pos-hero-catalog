'use strict';
// End-to-end sync test: two (or more) sync clients in plain Node against a real Worker.
//   cd cloudflare-inbox && npx wrangler dev        (default http://127.0.0.1:8787)
//   CATALOG_E2E_BASE=http://127.0.0.1:8787 node test/sync.e2e.test.js
// Skipped (exit 0) when CATALOG_E2E_BASE is not set, so `npm test` works offline.
const BASE = process.env.CATALOG_E2E_BASE;
if (!BASE) { console.log('sync.e2e.test.js skipped (set CATALOG_E2E_BASE to run)'); process.exit(0); }

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createStore } = require('../catalog/catalog-store');
const { createOutbox } = require('../catalog/catalog-outbox');
const { createImages } = require('../catalog/catalog-images');
const { createSync } = require('../catalog/catalog-sync');

const rnd = (n) => crypto.randomBytes(n).toString('base64url').replace(/[^A-Za-z0-9_-]/g, 'x').slice(0, n);
const KEY = rnd(40);
const TOKEN = 'tok-' + rnd(28);
const dirs = [];
const clients = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = false; }
    if (v) return Date.now() - t0;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for: ' + label);
    await sleep(40);
  }
}

function makeClient(name, o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-e2e-' + name + '-'));
  dirs.push(dir);
  const store = createStore(dir, { deviceId: 'dev-' + name }).load();
  const outbox = createOutbox(dir).load();
  const images = createImages(path.join(dir, 'images'));
  const c = { name, dir, store, outbox, images, offline: false, token: o.token === undefined ? TOKEN : o.token };
  const realFetch = (...a) => globalThis.fetch(...a);
  c.sync = createSync({
    store, outbox, images,
    fetch: (...a) => (c.offline ? Promise.reject(new TypeError('fetch failed (simulated offline)')) : realFetch(...a)),
    getConfig: () => ({ worker: { url: BASE, key: o.key || KEY, writeToken: c.token, pollMsVisible: 150, pollMsHidden: 150, requestTimeoutMs: 5000, imageTimeoutMs: 8000 } }),
    isVisible: () => true,
    warn: () => {}, log: () => {}
  });
  c.names = () => store.list().map((i) => i.name).sort();
  clients.push(c);
  return c;
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const jpeg = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-' + tag + '-' + rnd(200)), Buffer.from([0xff, 0xd9])]);

async function main() {
  const A = makeClient('a');
  const B = makeClient('b');

  // ---- connection test + init of a fresh key
  {
    const noTok = makeClient('nt', { token: '' });
    let r = await A.sync.testConnection({ url: BASE, key: KEY });
    assert.ok(r.ok && r.initialized === false, 'fresh key not initialized: ' + JSON.stringify(r));
    r = await A.sync.testConnection({ url: BASE, key: 'short' });
    assert.ok(!r.ok && /32-128/.test(r.message), 'bad key explained in Thai: ' + r.message);
    r = await A.sync.testConnection({ url: 'http://127.0.0.1:9', key: KEY });
    assert.ok(!r.ok && r.code === 'network', 'unreachable worker');
    r = await A.sync.initWorker();
    assert.ok(r.ok, 'init: ' + JSON.stringify(r));
    r = await A.sync.initWorker();
    assert.ok(!r.ok && /เริ่มใช้งานไปแล้ว/.test(r.message), 'second init is 409: ' + r.message);
    r = await A.sync.testConnection({ url: BASE, key: KEY });
    assert.ok(r.ok && r.initialized && r.tokenOk === true, 'token verified: ' + JSON.stringify(r));
    clients.pop(); // noTok: read-only checked below
    var R = noTok;
  }

  A.sync.start(); B.sync.start(); R.sync.start();

  // ---- both see each other's edits <= 10s
  const a1 = A.store.put({ name: 'น้ำดื่ม A1', code: '00101', cat: 'เครื่องดื่ม' });
  let ms = await waitFor(() => B.store.get(a1.id) && B.store.get(a1.id).name === 'น้ำดื่ม A1', 10000, 'B sees A1');
  assert.ok(ms <= 10000);
  console.log('  A->B propagation ms:', ms);
  assert.strictEqual(B.store.get(a1.id).code, '00101', 'leading zeros kept');
  assert.ok(B.store.getMeta().categories.includes('เครื่องดื่ม'), 'category meta propagated');
  B.store.put({ id: a1.id, name: 'แก้โดย B' });
  ms = await waitFor(() => A.store.get(a1.id).name === 'แก้โดย B', 10000, 'A sees B edit');
  console.log('  B->A propagation ms:', ms);
  await waitFor(() => A.sync.getStatus().state === 'ok' && B.sync.getStatus().state === 'ok', 5000, 'status ok');
  assert.strictEqual(A.sync.getStatus().pending, 0);
  assert.ok(A.sync.getStatus().lastOkAt > 0);
  assert.ok(A.store.get(a1.id).rev > 0, 'rev assigned by server');

  // ---- read-only client: sees data, cannot write, status readonly
  await waitFor(() => R.store.get(a1.id), 10000, 'reader pulls');
  let st = R.sync.getStatus();
  assert.strictEqual(st.state, 'readonly'); assert.strictEqual(st.canEdit, false);

  // ---- tombstone propagation
  const del = A.store.put({ name: 'จะถูกลบ', code: '9' });
  await waitFor(() => B.store.get(del.id), 10000, 'B sees to-be-deleted');
  A.store.remove(del.id);
  await waitFor(() => B.store.get(del.id) && B.store.get(del.id).deleted, 10000, 'B sees tombstone');
  assert.ok(!B.store.list().some((i) => i.id === del.id));
  // an older edit cannot resurrect it
  B.store.applyRemote([Object.assign({}, B.store.get(del.id), { deleted: false, updatedAt: 1, updatedBy: 'dev-zzz' })]);
  assert.strictEqual(B.store.get(del.id).deleted, true);

  // ---- offline edit then reconnect: no loss, no clobber
  const z = B.store.put({ name: 'Z-ก่อน', code: 'Z' });
  await waitFor(() => A.store.get(z.id), 10000, 'A sees Z');
  A.offline = true;
  await waitFor(() => A.sync.getStatus().state === 'offline', 10000, 'A offline state');
  const y = A.store.put({ name: 'Y-ออฟไลน์', code: 'Y' });
  A.store.put({ id: a1.id, name: 'A1-แก้ตอนออฟไลน์' });
  A.store.remove(z.id);
  await sleep(300);
  assert.ok(A.sync.getStatus().pending >= 3, 'pending count visible: ' + A.sync.getStatus().pending);
  assert.strictEqual(A.sync.getStatus().state, 'offline');
  const x = B.store.put({ name: 'X-ใหม่จาก B', code: 'X' }); // B keeps working meanwhile
  B.store.put({ id: z.id, name: 'Z-แก้โดย B ก่อน A ลบ' }); // older than A's delete -> delete wins
  await sleep(300);
  assert.strictEqual(A.store.get(x.id), null, 'offline A does not see B yet');
  A.offline = false;
  A.sync.syncNow();
  await waitFor(() => A.store.get(x.id) && B.store.get(y.id) && B.store.get(a1.id).name === 'A1-แก้ตอนออฟไลน์', 10000, 'reconnect converges');
  await waitFor(() => A.sync.getStatus().state === 'ok' && A.sync.getStatus().pending === 0, 10000, 'A drained');
  assert.strictEqual(B.store.get(y.id).name, 'Y-ออฟไลน์');
  assert.strictEqual(A.store.get(x.id).name, 'X-ใหม่จาก B');
  // z: A deleted it after B's... A.remove happened BEFORE B's rename (B edited later) -> B's edit is newer and wins on both
  await waitFor(() => A.store.get(z.id).updatedAt === B.store.get(z.id).updatedAt, 10000, 'z converged');
  assert.strictEqual(A.store.get(z.id).name, B.store.get(z.id).name);
  assert.strictEqual(A.store.get(z.id).deleted, B.store.get(z.id).deleted);

  // ---- conflict while both offline -> last write wins, both converge
  const c1 = A.store.put({ name: 'C-เดิม', code: 'C' });
  await waitFor(() => B.store.get(c1.id), 10000, 'B sees C');
  A.offline = true; B.offline = true;
  A.store.put({ id: c1.id, name: 'C จาก A (เก่ากว่า)' });
  await sleep(30);
  B.store.put({ id: c1.id, name: 'C จาก B (ใหม่กว่า)' });
  await sleep(200);
  B.offline = false; A.offline = false;
  A.sync.syncNow(); B.sync.syncNow();
  await waitFor(() => A.store.get(c1.id).name === 'C จาก B (ใหม่กว่า)' && B.store.get(c1.id).name === 'C จาก B (ใหม่กว่า)', 10000, 'LWW converged');
  await waitFor(() => A.sync.getStatus().pending === 0 && B.sync.getStatus().pending === 0, 10000, 'both drained');
  // reverse arrival order (loser pushes last) gives the same winner
  A.offline = true; B.offline = true;
  B.store.put({ id: c1.id, name: 'C2 จาก B (เก่ากว่า)' });
  await sleep(30);
  A.store.put({ id: c1.id, name: 'C2 จาก A (ใหม่กว่า)' });
  await sleep(100);
  A.offline = false; A.sync.syncNow(); await waitFor(() => A.sync.getStatus().pending === 0, 10000, 'A pushed first');
  B.offline = false; B.sync.syncNow();
  await waitFor(() => B.store.get(c1.id).name === 'C2 จาก A (ใหม่กว่า)' && A.store.get(c1.id).name === 'C2 จาก A (ใหม่กว่า)', 10000, 'stale rejection merges current');
  await waitFor(() => B.sync.getStatus().pending === 0, 10000, 'B drained after stale');

  // ---- images: upload before item, lazy download on another machine
  {
    const orig = jpeg('orig'), thumb = jpeg('thumb'), full = jpeg('full');
    const hash = sha(orig);
    A.offline = true; // make sure the order is decided by the outbox, not timing
    A.images.saveVariants(hash, 1, { orig, thumb, full });
    const withImg = A.store.put({ name: 'มีรูป', code: 'IMG', image: { hash, ver: 1, quality: 'ok', w: 512, h: 512 } });
    await sleep(300);
    assert.strictEqual(A.outbox.ready().item.length, 0 + A.outbox.ready().item.filter((e) => !e.payload.image).length, 'image item blocked behind img ops');
    assert.ok(!A.outbox.ready().item.some((e) => e.payload.id === withImg.id));
    A.offline = false; A.sync.syncNow();
    await waitFor(() => B.store.get(withImg.id), 10000, 'B sees image item');
    // item visible on B => its images must already be on the server
    for (const v of ['orig', 'thumb-v1', 'full-v1']) {
      const r = await fetch(BASE + '/catalog/' + KEY + '/img/' + hash + '/' + v);
      assert.strictEqual(r.status, 200, 'R2 has ' + v + ' by the time the item is visible');
    }
    assert.ok(!B.images.has(hash, 'thumb', 1), 'B has no local copy yet (lazy)');
    const [p1, p2] = await Promise.all([B.sync.ensureImage(hash, 'thumb', 1), B.sync.ensureImage(hash, 'thumb', 1)]);
    assert.ok(p1 && p1 === p2, 'concurrent fetches coalesce');
    assert.ok(Buffer.compare(fs.readFileSync(p1), thumb) === 0, 'downloaded thumb equals uploaded');
    assert.ok(B.images.has(hash, 'thumb', 1));
    assert.ok(Buffer.compare(fs.readFileSync(await B.sync.ensureImage(hash, 'orig', null)), orig) === 0, 'orig downloads too');
    assert.ok(!B.outbox.list().some((e) => e.op === 'img'), 'lazy downloads are not re-uploaded');
    assert.strictEqual(await B.sync.ensureImage(hash, 'full', 9), null, 'missing remote image -> null');
  }

  // ---- 401: wrong token stops writes until config changes
  {
    const W = makeClient('w', { token: 'wrong-token-0123456789abc' });
    W.sync.start();
    const w1 = W.store.put({ name: 'W-ส่งไม่ได้', code: 'W' });
    await waitFor(() => W.sync.getStatus().writeBlocked, 10000, 'W blocked');
    st = W.sync.getStatus();
    assert.ok(/write token/.test(st.lastError), st.lastError);
    assert.strictEqual(st.state, 'pending');
    await sleep(600);
    assert.strictEqual(W.outbox.getItem(w1.id).tries, 0, 'no retries while blocked');
    assert.strictEqual(B.store.get(w1.id), null);
    W.token = TOKEN; W.sync.configChanged();
    await waitFor(() => B.store.get(w1.id), 10000, 'delivered after token fixed');
    assert.strictEqual(W.sync.getStatus().writeBlocked, false);
    W.sync.stop();
  }

  // ---- clock skew: device clock 20 min fast -> 409 -> offset corrected, edit restamped and accepted
  {
    const K = makeClient('k');
    K.store.setClockOffset(20 * 60 * 1000);
    K.sync.start();
    const k1 = K.store.put({ name: 'K-นาฬิกาเร็ว', code: 'K' });
    assert.ok(k1.updatedAt > Date.now() + 19 * 60 * 1000);
    await waitFor(() => B.store.get(k1.id), 10000, 'skewed edit delivered');
    assert.ok(Math.abs(K.store.clockOffset) < 5000, 'offset corrected: ' + K.store.clockOffset);
    assert.ok(B.store.get(k1.id).updatedAt < Date.now() + 5000, 'item restamped with corrected clock');
    assert.strictEqual(K.outbox.size(), 0);
    K.sync.stop();
  }

  // ---- resetRequired: client's lastRev is ahead of the server -> full re-pull, unsent edits kept
  {
    const D = makeClient('d');
    D.sync.start();
    await waitFor(() => D.store.get(a1.id), 10000, 'D has a1');
    D.sync.stop();
    const unsent = D.store.put({ name: 'D-ยังไม่ส่ง', code: 'DD' });
    const serverNames = B.store.list().map((i) => i.name);
    D.store.setLastRev(999999);
    D.store.applyRemote([{ id: 'ghost', code: '1', name: 'ghost', updatedAt: 1, updatedBy: 'dev-x', rev: 5, deleted: false }]);
    // restart a sync loop on the same (now inconsistent) state
    const s2 = createSync({
      store: D.store, outbox: D.outbox, images: D.images, isVisible: () => true, warn: () => {}, log: () => {},
      getConfig: () => ({ worker: { url: BASE, key: KEY, writeToken: TOKEN, pollMsVisible: 150, pollMsHidden: 150, requestTimeoutMs: 5000 } })
    });
    s2.start();
    await waitFor(() => B.store.get(unsent.id), 10000, 'unsent edit delivered after reset');
    // the server is behind our lastRev (as if it had been wiped): the only copies are local, so they are kept and re-pushed
    await waitFor(() => A.store.get('ghost'), 10000, 'ghost re-queued to the server');
    assert.ok(D.store.get('ghost'), 'local-only item survives the reset');
    assert.ok(D.store.lastRev > 0 && D.store.lastRev < 999999, 'lastRev reset: ' + D.store.lastRev);
    for (const n of serverNames) assert.ok(D.store.list().some((i) => i.name === n), 'D has ' + n);
    s2.stop();
  }

  // ---- final convergence: A and B identical
  await waitFor(() => A.sync.getStatus().pending === 0 && B.sync.getStatus().pending === 0, 10000, 'drained');
  await sleep(500);
  const norm = (c) => JSON.stringify(c.store.list({ includeDeleted: true }).map((i) => [i.id, i.name, i.deleted, i.updatedAt]).sort());
  await waitFor(() => norm(A) === norm(B), 10000, 'A and B identical');
  console.log('  items on server:', A.store.list({ includeDeleted: true }).length);
}

main().then(() => {
  console.log('sync.e2e.test.js ok');
}).catch((e) => {
  console.error('sync.e2e.test.js FAILED:', e && e.stack || e);
  process.exitCode = 1;
}).finally(() => {
  for (const c of clients) { try { c.sync.stop(); } catch (_) { /* ignore */ } }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
  setTimeout(() => process.exit(process.exitCode || 0), 100);
});
