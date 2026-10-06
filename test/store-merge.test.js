'use strict';
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../catalog/catalog-store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-merge-'));
let n = 0;
const mk = () => createStore(path.join(tmp, 's' + (n++)), { deviceId: 'dev-a' }).load();
const remoteItem = (o) => Object.assign({ id: 'R1', code: '1', name: 'remote', cat: 'ทั่วไป', updatedAt: 5000, updatedBy: 'dev-b', rev: 7, deleted: false }, o);

try {
  // new remote item is applied, emits changed but NOT local
  {
    const s = mk(); const ch = [], lo = [];
    s.on('changed', (e) => ch.push(e)); s.on('local', (e) => lo.push(e));
    const r = s.applyRemote([remoteItem()]);
    assert.deepStrictEqual(r.applied, ['R1']);
    assert.strictEqual(s.get('R1').rev, 7);
    assert.strictEqual(s.get('R1').name, 'remote');
    assert.strictEqual(ch.length, 1); assert.strictEqual(lo.length, 0, 'remote apply must not look like a local edit');
  }
  // local edit newer than remote is never clobbered; older local loses
  {
    const s = mk();
    const mine = s.put({ id: 'X', name: 'mine', code: '2' });           // stamped now
    const r1 = s.applyRemote([remoteItem({ id: 'X', name: 'theirs-old', updatedAt: mine.updatedAt - 1000 })]);
    assert.deepStrictEqual(r1.kept, ['X']); assert.strictEqual(s.get('X').name, 'mine');
    const r2 = s.applyRemote([remoteItem({ id: 'X', name: 'theirs-new', updatedAt: mine.updatedAt + 1000 })]);
    assert.deepStrictEqual(r2.applied, ['X']); assert.strictEqual(s.get('X').name, 'theirs-new');
  }
  // same stamp: keep local content, just adopt rev
  {
    const s = mk();
    const mine = s.put({ id: 'Y', name: 'same', code: '3' });
    const r = s.applyRemote([Object.assign({}, mine, { rev: 42 })]);
    assert.deepStrictEqual(r.applied, []); assert.strictEqual(s.get('Y').rev, 42);
  }
  // tie on updatedAt -> larger updatedBy wins
  {
    const s = mk();
    const mine = s.put({ id: 'T', name: 'a', code: '4' });
    s.applyRemote([remoteItem({ id: 'T', name: 'b-wins', updatedAt: mine.updatedAt, updatedBy: 'dev-b' })]);
    assert.strictEqual(s.get('T').name, 'b-wins');
    s.applyRemote([remoteItem({ id: 'T', name: '0-loses', updatedAt: mine.updatedAt, updatedBy: 'dev-0' })]);
    assert.strictEqual(s.get('T').name, 'b-wins');
  }
  // tombstones: newer delete wins, older delete loses, remote tombstone of unknown id is stored
  {
    const s = mk();
    const it = s.put({ id: 'D', name: 'del', code: '5' });
    s.applyRemote([remoteItem({ id: 'D', deleted: true, updatedAt: it.updatedAt - 10 })]);
    assert.strictEqual(s.get('D').deleted, false, 'older delete loses to newer local edit');
    s.applyRemote([remoteItem({ id: 'D', deleted: true, updatedAt: it.updatedAt + 10 })]);
    assert.strictEqual(s.get('D').deleted, true);
    assert.ok(!s.list().some((i) => i.id === 'D'));
    s.applyRemote([remoteItem({ id: 'D', deleted: false, name: 'revived', updatedAt: it.updatedAt + 20 })]);
    assert.strictEqual(s.get('D').deleted, false, 'a newer edit revives');
    s.applyRemote([remoteItem({ id: 'Z', deleted: true })]);
    assert.strictEqual(s.get('Z').deleted, true);
    // local delete is a local event
    const lo = []; s.on('local', (e) => lo.push(e));
    s.remove('Z'); // already deleted -> nothing
    s.remove('D');
    assert.deepStrictEqual(lo.map((e) => e.ids), [['D']]);
  }
  // local events: put/putMany/setMeta; new category flags meta
  {
    const s = mk(); const lo = [];
    s.on('local', (e) => lo.push(e));
    s.put({ name: 'a', code: '1', cat: 'ใหม่' });
    assert.strictEqual(lo[0].meta, true);
    s.put({ name: 'b', code: '2', cat: 'ใหม่' });
    assert.strictEqual(lo[1].meta, false);
    s.setMeta({ shopName: 'ร้าน' });
    assert.deepStrictEqual(lo[2], { ids: [], meta: true });
  }
  // resetAll: server wins everywhere except unsent local edits
  {
    const s = mk();
    const keep = s.put({ id: 'K', name: 'unsent', code: '1' });
    s.put({ id: 'GONE', name: 'synced-but-purged', code: '2' });
    s.put({ id: 'OLD', name: 'old-local', code: '3' });
    const ch = []; s.on('changed', (e) => ch.push(e));
    s.resetAll([
      remoteItem({ id: 'K', name: 'srv-older', updatedAt: keep.updatedAt - 500 }),
      remoteItem({ id: 'OLD', name: 'srv-OLD', updatedAt: 1 }),
      remoteItem({ id: 'N', name: 'brand new' })
    ], { keepIds: new Set(['K']) });
    assert.strictEqual(s.get('K').name, 'unsent', 'unsent local edit kept');
    assert.strictEqual(s.get('GONE'), null, 'unknown non-pending item dropped');
    assert.strictEqual(s.get('OLD').name, 'srv-OLD', 'non-pending local replaced by server copy even if server is older');
    assert.strictEqual(s.get('N').name, 'brand new');
    assert.deepStrictEqual(ch[0], { ids: null });
    // keep id absent from the server stays
    s.resetAll([], { keepIds: ['K'] });
    assert.deepStrictEqual(s.list({ includeDeleted: true }).map((i) => i.id), ['K']);
  }
  // meta: LWW, never clobbers a newer local meta; union keeps categories in use
  {
    const s = mk();
    s.setMeta({ categories: ['ทั่วไป', 'A'], shopName: 'local' });
    const t = s.getMeta().updatedAt;
    assert.strictEqual(s.applyRemoteMeta({ categories: ['ทั่วไป'], shopName: 'old', updatedAt: t - 5, rev: 3 }).applied, false);
    assert.strictEqual(s.getMeta().shopName, 'local');
    s.put({ name: 'x', code: '1', cat: 'A' });
    const r = s.applyRemoteMeta({ categories: ['ทั่วไป', 'B'], shopName: 'remote', updatedAt: s.now() + 5000, rev: 9 }, { union: true });
    assert.strictEqual(r.applied, true); assert.strictEqual(r.needsPush, true);
    assert.deepStrictEqual(s.getMeta().categories, ['ทั่วไป', 'B', 'A']);
    assert.strictEqual(s.getMeta().shopName, 'remote'); assert.strictEqual(s.getMeta().rev, 9);
    const r2 = s.applyRemoteMeta({ categories: ['ทั่วไป'], shopName: 'x', updatedAt: s.getMeta().updatedAt, rev: 10 });
    assert.strictEqual(r2.applied, false); assert.strictEqual(s.getMeta().rev, 10);
  }
  // restamp + resetSyncState + persistence of syncId
  {
    const dir = path.join(tmp, 'persist');
    const s = createStore(dir, { deviceId: 'dev-a' }).load();
    const oldAt = s.put({ id: 'P', name: 'p', code: '1' }).updatedAt; s.setRev('P', 5); s.setLastRev(5); s.setSyncId('u|k');
    s.setClockOffset(-60000);
    const [re] = s.restamp(['P']);
    assert.ok(re.updatedAt < Date.now() - 50000 && re.updatedAt !== oldAt);
    s.flush();
    const s2 = createStore(dir).load();
    assert.strictEqual(s2.syncId, 'u|k'); assert.strictEqual(s2.lastRev, 5); assert.strictEqual(s2.get('P').rev, 5);
    s2.resetSyncState('u2-k2');
    assert.strictEqual(s2.lastRev, 0); assert.strictEqual(s2.get('P').rev, undefined); assert.strictEqual(s2.syncId, 'u2-k2');
  }
  console.log('store-merge.test.js ok');
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}
