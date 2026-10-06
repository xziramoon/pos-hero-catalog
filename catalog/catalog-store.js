'use strict';
// Local catalog store: userData/catalog/db.json (spec §6.1).
// Interface is deliberately small (get/put/list/changesSince) so it can later be
// swapped for SQLite. Phase 4 extends this with applyRemote() and the outbox.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { ulid } = require('./shared/ulid');
const { mergeItem } = require('./shared/merge');
const { migrateItem, CURRENT_SCHEMA } = require('./migrations');

const DEFAULT_CAT = 'ทั่วไป';
const WRITE_DEBOUNCE_MS = 300;

function newDeviceId() {
  return 'dev-' + crypto.randomBytes(6).toString('hex');
}

function normalizeLocalItem(raw) {
  const it = Object.assign({}, raw);
  it.code = it.code == null ? '' : String(it.code);
  it.name = it.name == null ? '' : String(it.name);
  it.shortName = it.shortName == null ? '' : String(it.shortName);
  it.cat = it.cat ? String(it.cat) : DEFAULT_CAT;
  it.fav = !!it.fav;
  it.barcodes = Array.isArray(it.barcodes) ? it.barcodes.map(String).filter(Boolean) : [];
  it.tags = Array.isArray(it.tags) ? it.tags : [];
  if (it.image === undefined) it.image = null;
  it.deleted = !!it.deleted;
  if (it.schemaVersion == null) it.schemaVersion = CURRENT_SCHEMA;
  return it;
}

function createStore(dir, opts = {}) {
  const file = path.join(dir, 'db.json');
  const emitter = new EventEmitter();
  let items = new Map();
  let meta = { categories: [DEFAULT_CAT], shopName: '', schemaVersion: CURRENT_SCHEMA, updatedAt: 0, rev: 0 };
  let lastRev = 0;
  let deviceId = opts.deviceId || null;
  let clockOffset = 0;
  let syncId = null; // identity (worker url + key) that lastRev/rev values belong to
  let timer = null;
  let dirty = false;
  let metaTouched = false; // a local item edit added a category (meta must be pushed too)

  const now = () => Date.now() + clockOffset;

  function load() {
    items = new Map();
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.warn('[catalog] db.json unreadable, keeping a copy and starting empty:', e.message);
        try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch (_) { /* ignore */ }
      }
    }
    if (data && typeof data === 'object') {
      for (const [id, raw] of Object.entries(data.items || {})) {
        try { items.set(id, normalizeLocalItem(migrateItem(raw))); } catch (e) { console.warn('[catalog] skipped bad item', id, e.message); }
      }
      if (data.meta) meta = Object.assign(meta, data.meta);
      if (Number.isFinite(data.lastRev)) lastRev = data.lastRev;
      if (!deviceId && data.deviceId) deviceId = data.deviceId;
      if (Number.isFinite(data.clockOffset)) clockOffset = data.clockOffset;
      if (typeof data.syncId === 'string') syncId = data.syncId;
    }
    if (!deviceId) { deviceId = newDeviceId(); scheduleWrite(); }
    ensureCategories();
    return api;
  }

  function ensureCategories() {
    if (!Array.isArray(meta.categories)) meta.categories = [];
    if (!meta.categories.includes(DEFAULT_CAT)) meta.categories.unshift(DEFAULT_CAT);
  }

  function scheduleWrite() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, WRITE_DEBOUNCE_MS);
    if (timer.unref) timer.unref();
  }

  // Synchronous tmp+rename write. Safe to call on quit.
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const obj = { items: Object.fromEntries(items), meta, lastRev, deviceId, clockOffset, syncId };
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, file);
      dirty = false;
      return true;
    } catch (e) {
      console.warn('[catalog] db.json write failed:', e.message);
      return false;
    }
  }

  function emitChanged(ids) { try { emitter.emit('changed', { ids }); } catch (e) { console.warn('[catalog] listener error', e.message); } }
  // 'local' = edits made on this device (sync queues them); remote applies only emit 'changed'.
  function emitLocal(ids, metaToo) {
    const m = !!metaToo || metaTouched; metaTouched = false;
    try { emitter.emit('local', { ids, meta: m }); } catch (e) { console.warn('[catalog] listener error', e.message); }
  }

  function noteCategory(cat) {
    if (cat && !meta.categories.includes(cat)) { meta.categories.push(cat); meta.updatedAt = now(); metaTouched = true; }
  }

  function stamp(raw) {
    const prev = raw.id ? items.get(raw.id) : null;
    const it = normalizeLocalItem(Object.assign({}, prev || {}, raw));
    if (!it.id) it.id = ulid();
    it.updatedAt = now();
    it.updatedBy = deviceId;
    noteCategory(it.cat);
    items.set(it.id, it);
    return it;
  }

  function put(item) {
    const it = stamp(item);
    scheduleWrite();
    emitChanged([it.id]);
    emitLocal([it.id]);
    return it;
  }

  function putMany(list) {
    const out = list.map(stamp);
    if (out.length) { scheduleWrite(); emitChanged(out.map((i) => i.id)); emitLocal(out.map((i) => i.id)); }
    return out;
  }

  function get(id) { return items.get(id) || null; }

  function list(o = {}) {
    const out = [];
    for (const it of items.values()) if (o.includeDeleted || !it.deleted) out.push(it);
    return out;
  }

  // Tombstone (never physically deleted so deletes can sync later).
  function remove(idOrIds) {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    const done = [];
    for (const id of ids) {
      const it = items.get(id);
      if (!it || it.deleted) continue;
      it.deleted = true;
      it.updatedAt = now();
      it.updatedBy = deviceId;
      done.push(id);
    }
    if (done.length) { scheduleWrite(); emitChanged(done); emitLocal(done); }
    return done;
  }

  function getMeta() { return meta; }
  function setMeta(patch) {
    meta = Object.assign({}, meta, patch || {}, { updatedAt: now() });
    ensureCategories();
    scheduleWrite();
    emitChanged(null);
    emitLocal([], true);
    return meta;
  }

  function changesSince(rev) {
    const out = [];
    for (const it of items.values()) if ((it.rev || 0) > rev) out.push(it);
    return out;
  }

  // ---- remote (sync) side ----
  const sameStamp = (a, b) => a.updatedAt === b.updatedAt && a.updatedBy === b.updatedBy;
  function normRemote(raw) {
    try {
      const it = normalizeLocalItem(migrateItem(raw));
      return it && typeof it.id === 'string' && it.id ? it : null;
    } catch (e) { console.warn('[catalog] skipped bad remote item', e.message); return null; }
  }

  // Merge server items into the local store with mergeItem (a newer local edit is never clobbered).
  // Returns { applied:[ids where remote won], kept:[ids where local was newer] }.
  function applyRemote(list) {
    const applied = [], kept = [];
    let revOnly = false;
    for (const raw of list || []) {
      const remote = normRemote(raw);
      if (!remote) continue;
      const local = items.get(remote.id);
      if (!local) { items.set(remote.id, remote); applied.push(remote.id); continue; }
      if (sameStamp(local, remote)) {
        if (remote.rev != null && local.rev !== remote.rev) { local.rev = remote.rev; revOnly = true; }
        continue;
      }
      if (mergeItem(local, remote) === remote) { items.set(remote.id, remote); applied.push(remote.id); } else kept.push(remote.id);
    }
    if (applied.length) { scheduleWrite(); emitChanged(applied); } else if (revOnly) scheduleWrite();
    return { applied, kept };
  }

  // Full re-pull (server said resetRequired): server state replaces local, except ids in keepIds
  // (unsent local edits), which are merged normally.
  function resetAll(list, o = {}) {
    const keep = o.keepIds instanceof Set ? o.keepIds : new Set(o.keepIds || []);
    const next = new Map();
    for (const raw of list || []) {
      const remote = normRemote(raw);
      if (!remote) continue;
      const local = items.get(remote.id);
      next.set(remote.id, keep.has(remote.id) && local ? mergeItem(local, remote) : remote);
    }
    for (const id of keep) if (!next.has(id) && items.has(id)) next.set(id, items.get(id));
    items = next;
    scheduleWrite();
    emitChanged(null);
    return { count: items.size };
  }

  // Remote meta is last-write-wins as a whole. With o.union a winning remote meta keeps categories
  // that local items still use (so a category never vanishes); returns needsPush when it added any.
  function applyRemoteMeta(remote, o = {}) {
    if (!remote || typeof remote !== 'object') return { applied: false, needsPush: false };
    const lt = Number(meta.updatedAt) || 0, rt = Number(remote.updatedAt) || 0;
    if (rt < lt) return { applied: false, needsPush: false };
    if (rt === lt) {
      if (remote.rev != null && meta.rev !== remote.rev) { meta.rev = remote.rev; scheduleWrite(); }
      return { applied: false, needsPush: false };
    }
    let needsPush = false;
    const cats = Array.isArray(remote.categories) ? remote.categories.map(String) : [];
    if (o.union) {
      for (const it of items.values()) if (!it.deleted && it.cat && !cats.includes(it.cat)) { cats.push(it.cat); needsPush = true; }
    }
    meta = Object.assign({}, meta, remote, { categories: cats });
    ensureCategories();
    if (needsPush) meta.updatedAt = now();
    scheduleWrite();
    emitChanged(null);
    return { applied: true, needsPush };
  }

  function setRev(id, rev) {
    const it = items.get(id);
    if (it && it.rev !== rev) { it.rev = rev; scheduleWrite(); }
  }
  // Pointing at a different catalog: forget server revisions so the next pull starts from 0 and
  // everything not on that server is re-queued by sync.
  function resetSyncState(id) {
    syncId = id;
    lastRev = 0;
    meta.rev = 0;
    for (const it of items.values()) delete it.rev;
    scheduleWrite();
  }
  function setSyncId(id) { if (syncId !== id) { syncId = id; scheduleWrite(); } }
  function setMetaRev(rev) { if (meta.rev !== rev) { meta.rev = rev; scheduleWrite(); } }

  // Clock-skew recovery: re-stamp items with the corrected clock. Returns the updated items.
  function restamp(ids) {
    const out = [];
    for (const id of ids) {
      const it = items.get(id);
      if (!it) continue;
      it.updatedAt = now();
      out.push(it);
    }
    if (out.length) scheduleWrite();
    return out;
  }
  function restampMeta() { meta.updatedAt = now(); scheduleWrite(); return meta; }

  const api = {
    resetSyncState, setSyncId, get syncId() { return syncId; },
    applyRemote, resetAll, applyRemoteMeta, setRev, setMetaRev, restamp, restampMeta,
    load, get, put, putMany, list, remove, getMeta, setMeta, changesSince, flush, now,
    get lastRev() { return lastRev; },
    setLastRev(n) { lastRev = n; scheduleWrite(); },
    get deviceId() { return deviceId; },
    get clockOffset() { return clockOffset; },
    setClockOffset(ms) { clockOffset = ms; scheduleWrite(); },
    on: (ev, fn) => { emitter.on(ev, fn); return api; },
    off: (ev, fn) => { emitter.off(ev, fn); return api; },
    file, DEFAULT_CAT
  };
  return api;
}

module.exports = { createStore, DEFAULT_CAT };
