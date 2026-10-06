'use strict';
// catalog-backup: naming, rotation (keeps `keep` daily files), db-reset-* is never touched.
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../catalog/catalog-store');
const { createBackup, dateStamp } = require('../catalog/catalog-backup');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-backup-'));
const store = createStore(dir, { deviceId: 'dev-b' }).load();
let clock = new Date(2026, 0, 1, 9, 5, 7);
let cfg = { backup: { daily: true, keep: 14, keepManual: 3 } };
const bk = createBackup({ dir, store, getConfig: () => cfg, now: () => clock });
const bdir = path.join(dir, 'backups');
const names = () => fs.readdirSync(bdir).sort();

// no db.json yet -> a clear failure, nothing created
assert.strictEqual(bk.backupNow('x').ok, false);
assert.strictEqual(bk.ensureDaily().skipped, true);

store.put({ code: '1', name: 'a' });
store.flush();

// naming
let r = bk.backupNow();
assert.strictEqual(r.name, 'db-20260101.json');
r = bk.backupNow('Before Import!');
assert.strictEqual(r.name, 'db-20260101-090507-before-import.json');
assert.strictEqual(JSON.parse(fs.readFileSync(r.file, 'utf8')).items && Object.keys(JSON.parse(fs.readFileSync(r.file, 'utf8')).items).length, 1);
assert.ok(!names().some((n) => n.endsWith('.tmp')));
assert.strictEqual(dateStamp(new Date(2026, 11, 31)), '20261231');

// db-reset-* and unrelated files are never removed; daily rotation keeps the newest 14
fs.writeFileSync(path.join(bdir, 'db-reset-1700000000000.json'), '{}');
fs.writeFileSync(path.join(bdir, 'notes.txt'), 'keep me');
for (let d = 0; d < 30; d++) {
  clock = new Date(2026, 0, 2 + d, 10, 0, 0);
  assert.ok(bk.ensureDaily().ok);
  assert.ok(bk.ensureDaily().skipped, 'second call on the same day does nothing');
}
const daily = names().filter((n) => /^db-\d{8}\.json$/.test(n));
assert.strictEqual(daily.length, 14);
assert.strictEqual(daily[daily.length - 1], 'db-20260131.json');
assert.strictEqual(daily[0], 'db-20260118.json', 'oldest kept = 14th newest');
assert.ok(names().includes('db-reset-1700000000000.json'));
assert.ok(names().includes('notes.txt'));

// manual (reason) backups have their own cap (keepManual = 3); daily files are untouched by it
for (let i = 0; i < 6; i++) { clock = new Date(2026, 1, 5, 12, 0, i); assert.ok(bk.backupNow('reprocess').ok); }
const manual = names().filter((n) => /^db-\d{8}-\d{6}-/.test(n));
assert.strictEqual(manual.length, 3);
assert.strictEqual(names().filter((n) => /^db-\d{8}\.json$/.test(n)).length, 14);

// keep is read from config; daily=false disables the automatic backup
cfg = { backup: { daily: false, keep: 2, keepManual: 3 } };
clock = new Date(2026, 5, 1);
assert.strictEqual(bk.ensureDaily().skipped, true);
assert.ok(!names().includes('db-20260601.json'));
bk.rotate();
assert.strictEqual(names().filter((n) => /^db-\d{8}\.json$/.test(n)).length, 2);
assert.ok(names().includes('db-reset-1700000000000.json'));

// export to a user path
const out = path.join(dir, 'out', 'export.json');
fs.mkdirSync(path.dirname(out));
assert.ok(bk.exportTo(out).ok);
assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(out, 'utf8')).items).length, 1);

// restore: backup items come back as NEW edits (fresh stamp), deleted ones are undeleted, later items stay
{
  const snap = path.join(dir, 'snap.json');
  assert.ok(bk.exportTo(snap).ok);                       // state: item 'a' only
  const a = store.list()[0];
  store.put({ id: a.id, name: 'changed' });              // edit after the snapshot
  store.remove([a.id]);                                  // and delete it
  const extra = store.put({ code: '2', name: 'later' }); // item created after the snapshot
  const before = store.get(a.id).updatedAt;
  clock = new Date(2026, 6, 1, 8, 0, 0);
  const r = bk.restoreFrom(snap);
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.undeleted, 1);
  assert.ok(/before-restore/.test(r.backup));
  const back = store.get(a.id);
  assert.strictEqual(back.deleted, false);
  assert.strictEqual(back.name, 'a');
  assert.ok(back.updatedAt >= before, 'restored item is a fresh edit so it wins over older server copies');
  assert.strictEqual(store.get(extra.id).name, 'later', 'items missing from the backup are left alone');
  assert.strictEqual(bk.restoreFrom(snap).restored, 0, 'restoring twice changes nothing');
  assert.strictEqual(bk.restoreFrom(path.join(dir, 'nope.json')).ok, false);
  fs.writeFileSync(path.join(dir, 'junk.json'), '{"hello":1}');
  assert.strictEqual(bk.restoreFrom(path.join(dir, 'junk.json')).ok, false);
}

console.log('backup.test.js OK');
