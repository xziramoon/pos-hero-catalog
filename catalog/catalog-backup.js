'use strict';
// Backups of db.json (spec section 6.1): backups/db-YYYYMMDD.json (daily, newest `keep` kept) and
// backups/db-YYYYMMDD-HHMMSS-<reason>.json (manual / before risky jobs, newest `keepManual` kept).
// `db-reset-*` files (written by the sync reset logic, store.snapshot) are NEVER touched here.
// Pure Node: the store only needs flush().
const fs = require('fs');
const path = require('path');
const { normalizeItem, validateItem } = require('./shared/merge');

const DAILY_RE = /^db-(\d{8})\.json$/;
const MANUAL_RE = /^db-\d{8}-\d{6}-[a-z0-9-]+\.json$/;
const HOUR_MS = 60 * 60 * 1000;

const p2 = (n) => String(n).padStart(2, '0');
function dateStamp(d) { return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()); }
function timeStamp(d) { return p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()); }

function cleanReason(r) {
  const s = String(r || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return s;
}

/**
 * createBackup({ dir, store, getConfig, now }) -> { backupNow(reason), ensureDaily(), rotate(), startDaily(), stop(), exportTo(file), list() }
 *   dir        catalog data dir (contains db.json and backups/)
 *   store      needs flush() -> boolean
 *   getConfig  () => ({ backup:{ daily, keep, keepManual } })
 *   now        () => Date (tests)
 */
function createBackup(o) {
  const { dir, store } = o;
  const getConfig = o.getConfig || (() => ({}));
  const nowFn = o.now || (() => new Date());
  const bdir = path.join(dir, 'backups');
  const dbFile = path.join(dir, 'db.json');
  let timer = null;

  const cfg = () => Object.assign({ daily: true, keep: 14, keepManual: 30 }, (getConfig() || {}).backup || {});

  function copyDb(dest) {
    if (store && typeof store.flush === 'function' && store.flush() === false) throw new Error('บันทึกข้อมูลลงดิสก์ไม่สำเร็จ');
    if (!fs.existsSync(dbFile)) throw new Error('ยังไม่มีไฟล์ข้อมูลให้สำรอง');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.tmp';
    fs.copyFileSync(dbFile, tmp);
    fs.renameSync(tmp, dest);
  }

  function list() {
    try { return fs.readdirSync(bdir); } catch (_) { return []; }
  }

  function prune(names, keep) {
    const sorted = names.slice().sort(); // names embed the timestamp, so lexical order == chronological
    while (sorted.length > Math.max(0, keep)) {
      const n = sorted.shift();
      try { fs.unlinkSync(path.join(bdir, n)); } catch (e) { console.warn('[catalog] backup prune failed:', n, e.message); }
    }
  }

  // Keep the newest `keep` daily files and `keepManual` reason files. Anything else (db-reset-*, tmp, user files) is left alone.
  function rotate() {
    const c = cfg();
    const names = list();
    prune(names.filter((n) => DAILY_RE.test(n)), c.keep);
    prune(names.filter((n) => MANUAL_RE.test(n)), c.keepManual);
  }

  /**
   * backupNow(reason) -> { ok, file?, name?, error? }
   * No reason: today's daily file db-YYYYMMDD.json (overwritten if it already exists, so it holds the latest state of the day).
   * With reason: db-YYYYMMDD-HHMMSS-reason.json.
   */
  function backupNow(reason) {
    try {
      const d = nowFn();
      const r = cleanReason(reason);
      const name = r ? 'db-' + dateStamp(d) + '-' + timeStamp(d) + '-' + r + '.json' : 'db-' + dateStamp(d) + '.json';
      const dest = path.join(bdir, name);
      copyDb(dest);
      rotate();
      return { ok: true, file: dest, name };
    } catch (e) {
      console.warn('[catalog] backup failed:', e.message);
      return { ok: false, error: e.message };
    }
  }

  // Daily backup: created once per calendar day (first run of the day), then rotated.
  function ensureDaily() {
    try {
      if (!cfg().daily) return { ok: true, skipped: true };
      const name = 'db-' + dateStamp(nowFn()) + '.json';
      if (fs.existsSync(path.join(bdir, name))) { rotate(); return { ok: true, skipped: true, name }; }
      if (!fs.existsSync(dbFile)) return { ok: true, skipped: true };
      return backupNow();
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // On start and then every hour (cheap check): writes at most one file per calendar day, so a machine left on
  // across midnight still gets its backup. (Spec says "every 24h"; this is the same effect without drifting.)
  function startDaily() {
    stop();
    ensureDaily();
    timer = setInterval(ensureDaily, HOUR_MS);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  // Copy of the current db.json to a user-chosen path.
  function exportTo(file) {
    try { copyDb(file); return { ok: true, file }; } catch (e) { return { ok: false, error: e.message }; }
  }

  const CONTENT = ['name', 'shortName', 'code', 'cat', 'fav', 'barcodes', 'tags', 'image'];

  /**
   * restoreFrom(file) -> { ok, restored, added, updated, undeleted, skipped, backup?, error? }
   * Safe restore of a db-*.json / export file. Copying the file over db.json would NOT work with sync on (old lastRev,
   * stale outbox, newer server copies win), so the backup's items are re-applied as NEW local edits (fresh updatedAt)
   * which then sync normally. Items missing from the backup are left alone; deleted backup items are ignored.
   * Always takes a 'before-restore' backup first and aborts if that fails.
   */
  function restoreFrom(file) {
    try {
      let data;
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { ok: false, error: 'อ่านไฟล์ไม่ได้ หรือไม่ใช่ไฟล์สำรองของกระเป๋าสินค้า' }; }
      const raw = data && (Array.isArray(data.items) ? data.items : data.items && typeof data.items === 'object' ? Object.values(data.items) : null);
      if (!raw) return { ok: false, error: 'ไฟล์นี้ไม่ใช่ไฟล์สำรองของกระเป๋าสินค้า (ไม่พบรายการสินค้า)' };
      const b = fs.existsSync(dbFile) ? backupNow('before-restore') : { ok: true };
      if (!b.ok) return { ok: false, error: 'สำรองข้อมูลปัจจุบันก่อนกู้คืนไม่สำเร็จ: ' + b.error };
      const out = []; let added = 0, updated = 0, undeleted = 0, skipped = 0;
      const same = (a, c) => JSON.stringify(a) === JSON.stringify(c);
      for (const r of raw) {
        const it = normalizeItem(r);
        if (validateItem(it) || it.deleted) { skipped++; continue; }
        const cur = store.get(it.id);
        const next = {};
        for (const k of CONTENT) next[k] = it[k];
        if (cur && !cur.deleted && CONTENT.every((k) => same(cur[k], next[k]))) continue; // already identical
        if (!cur) added++; else if (cur.deleted) undeleted++; else updated++;
        out.push(Object.assign({}, cur || {}, next, { id: it.id, deleted: false }));
      }
      if (out.length) store.putMany(out);
      const cats = data.meta && Array.isArray(data.meta.categories) ? data.meta.categories.filter((c) => typeof c === 'string' && c.trim()) : [];
      const have = new Set(store.getMeta().categories || []);
      const missing = cats.filter((c) => !have.has(c));
      if (missing.length) store.setMeta({ categories: (store.getMeta().categories || []).concat(missing) });
      store.flush();
      return { ok: true, restored: out.length, added, updated, undeleted, skipped, backup: b.name || null };
    } catch (e) {
      console.warn('[catalog] restore failed:', e.message);
      return { ok: false, error: e.message };
    }
  }

  return { backupNow, ensureDaily, rotate, startDaily, stop, exportTo, restoreFrom, list, dir: bdir };
}

module.exports = { createBackup, DAILY_RE, MANUAL_RE, dateStamp };
