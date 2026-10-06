'use strict';
// Backups of db.json (spec section 6.1): backups/db-YYYYMMDD.json (daily, newest `keep` kept) and
// backups/db-YYYYMMDD-HHMMSS-<reason>.json (manual / before risky jobs, newest `keepManual` kept).
// `db-reset-*` files (written by the sync reset logic, store.snapshot) are NEVER touched here.
// Pure Node: the store only needs flush().
const fs = require('fs');
const path = require('path');

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

  return { backupNow, ensureDaily, rotate, startDaily, stop, exportTo, list, dir: bdir };
}

module.exports = { createBackup, DAILY_RE, MANUAL_RE, dateStamp };
