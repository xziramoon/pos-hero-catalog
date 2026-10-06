'use strict';
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../catalog/catalog-store');
const { deepMerge, getDefaults } = require('../catalog/defaults');
const { createConfigStore } = require('../catalog/catalog-config');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-test-'));
function cleanup() { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ } }

try {
  // ---- store
  const s = createStore(tmp, { deviceId: 'dev-a' }).load();
  const events = [];
  s.on('changed', (e) => events.push(e));
  assert.strictEqual(s.deviceId, 'dev-a');

  const it = s.put({ name: 'น้ำดื่ม', code: 101, cat: 'เครื่องดื่ม' });
  assert.strictEqual(it.id.length, 26, 'ulid assigned');
  assert.strictEqual(it.code, '101', 'code coerced to string');
  assert.strictEqual(it.updatedBy, 'dev-a');
  assert.ok(Math.abs(it.updatedAt - Date.now()) < 2000);
  assert.deepStrictEqual(events[0].ids, [it.id]);
  assert.ok(s.getMeta().categories.includes('เครื่องดื่ม'), 'category auto-added');
  assert.ok(s.getMeta().categories.includes('ทั่วไป'), 'default category always present');

  const code0 = s.put({ name: 'x', code: '00101' });
  assert.strictEqual(code0.code, '00101', 'leading zeros kept');

  // update merges onto existing
  const upd = s.put({ id: it.id, name: 'น้ำดื่มใหญ่' });
  assert.strictEqual(upd.code, '101');
  assert.strictEqual(upd.name, 'น้ำดื่มใหญ่');
  assert.ok(upd.updatedAt >= it.updatedAt);

  // clock offset
  s.setClockOffset(60000);
  assert.ok(s.now() - Date.now() >= 59000);
  const shifted = s.put({ id: it.id, fav: true });
  assert.ok(shifted.updatedAt - Date.now() >= 59000, 'put uses offset clock');
  s.setClockOffset(0);

  // putMany emits once
  const before = events.length;
  const many = s.putMany([{ name: 'a', code: '1' }, { name: 'b', code: '2' }]);
  assert.strictEqual(many.length, 2);
  assert.strictEqual(events.length, before + 1);

  // tombstone
  s.remove(code0.id);
  assert.strictEqual(s.list().some((i) => i.id === code0.id), false);
  assert.strictEqual(s.list({ includeDeleted: true }).some((i) => i.id === code0.id), true);
  assert.strictEqual(s.get(code0.id).deleted, true);

  // meta
  s.setMeta({ shopName: 'ร้านทดสอบ', categories: ['ก'] });
  assert.ok(s.getMeta().categories.includes('ทั่วไป'), 'default category re-added');
  assert.strictEqual(s.getMeta().shopName, 'ร้านทดสอบ');

  // changesSince
  s.setLastRev(7);
  assert.strictEqual(s.lastRev, 7);
  assert.strictEqual(s.changesSince(0).length, 0, 'locally-created items have no rev yet');

  // persistence (tmp + rename, reload)
  s.flush();
  assert.ok(fs.existsSync(path.join(tmp, 'db.json')));
  assert.ok(!fs.existsSync(path.join(tmp, 'db.json.tmp')), 'no tmp left behind');
  const s2 = createStore(tmp).load();
  assert.strictEqual(s2.deviceId, 'dev-a', 'deviceId persisted');
  assert.strictEqual(s2.get(it.id).name, 'น้ำดื่มใหญ่');
  assert.strictEqual(s2.list().length, s.list().length);
  assert.strictEqual(s2.lastRev, 7);
  assert.strictEqual(s2.getMeta().shopName, 'ร้านทดสอบ');
  assert.strictEqual(s2.get(it.id).schemaVersion, 1);

  // corrupt db.json does not throw and is preserved
  fs.writeFileSync(path.join(tmp, 'db.json'), '{not json');
  const s3 = createStore(tmp).load();
  assert.strictEqual(s3.list().length, 0);
  assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('db.json.corrupt-')));

  // ---- defaults + config
  const d = getDefaults();
  assert.strictEqual(d.window.hotkey, 'Ctrl+Alt+B');
  assert.strictEqual(d.grid.slotW, 100);
  const m = deepMerge(d, { window: { hotkey: 'F3' }, image: { wbGainClamp: [1, 1] }, extra: 1 });
  assert.strictEqual(m.window.hotkey, 'F3');
  assert.strictEqual(m.window.width, 920, 'untouched defaults kept');
  assert.deepStrictEqual(m.image.wbGainClamp, [1, 1], 'arrays replaced');
  assert.strictEqual(m.extra, 1);
  assert.strictEqual(getDefaults().window.hotkey, 'Ctrl+Alt+B', 'defaults not mutated');

  const cdir = path.join(tmp, 'cfg');
  const c = createConfigStore(cdir);
  c.load();
  c.update({ worker: { writeToken: 'secret', url: 'https://x' } });
  const pub = c.publicConfig();
  assert.strictEqual(pub.worker.writeToken, undefined, 'token never exposed');
  assert.strictEqual(pub.hasWriteToken, true);
  const c2 = createConfigStore(cdir);
  c2.load();
  assert.strictEqual(c2.get().worker.writeToken, 'secret');
  assert.strictEqual(c2.get().copy.onSlotActivate, 'copyCode');

  // debounced write happens on its own (<= ~300ms)
  const dir2 = path.join(tmp, 'deb');
  const s4 = createStore(dir2, { deviceId: 'dev-d' }).load();
  s4.put({ name: 'late', code: '9' });
  setTimeout(() => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir2, 'db.json'), 'utf8'));
      assert.strictEqual(Object.keys(raw.items).length, 1, 'debounced flush wrote on its own');
      console.log('store.test.js ok');
    } finally { cleanup(); }
  }, 700);
} catch (e) {
  cleanup();
  throw e;
}
