'use strict';
// Local catalog store: userData/catalog/db.json (spec §6.1).
// Interface is deliberately small (get/put/list/changesSince) so it can later be
// swapped for SQLite. Phase 4 extends this with applyRemote() and the outbox.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { ulid } = require('./shared/ulid');
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
  let timer = null;
  let dirty = false;

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
      const obj = { items: Object.fromEntries(items), meta, lastRev, deviceId, clockOffset };
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

  function noteCategory(cat) {
    if (cat && !meta.categories.includes(cat)) { meta.categories.push(cat); meta.updatedAt = now(); }
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
    return it;
  }

  function putMany(list) {
    const out = list.map(stamp);
    if (out.length) { scheduleWrite(); emitChanged(out.map((i) => i.id)); }
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
    if (done.length) { scheduleWrite(); emitChanged(done); }
    return done;
  }

  function getMeta() { return meta; }
  function setMeta(patch) {
    meta = Object.assign({}, meta, patch || {}, { updatedAt: now() });
    ensureCategories();
    scheduleWrite();
    emitChanged(null);
    return meta;
  }

  function changesSince(rev) {
    const out = [];
    for (const it of items.values()) if ((it.rev || 0) > rev) out.push(it);
    return out;
  }

  const api = {
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
