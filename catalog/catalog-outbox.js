'use strict';
// Persistent queue of unsent local edits: userData/catalog/outbox.json (spec §6.1).
//   entry = { op:'item'|'meta'|'img', payload, tries, nextAt }
//   item payload = full Item snapshot; meta payload = {categories, shopName, updatedAt};
//   img payload = {hash, variant:'orig'|'thumb'|'full', ver|null}
// Rules: one entry per item id / per meta / per image file (later edits replace the payload,
// i.e. coalesce to the latest); an item referencing an image that still has a pending `img`
// entry is not handed out until that upload is done; failures back off 2s, 4s, ... max 5min.
const fs = require('fs');
const path = require('path');

const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const WRITE_DEBOUNCE_MS = 200;

function backoffMs(tries) {
  if (!(tries > 0)) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, tries - 1));
}

function imgSuffix(p) { return p.variant === 'orig' || p.ver == null ? '' : '-v' + p.ver; }

function keyOf(e) {
  if (e.op === 'item') return 'item:' + e.payload.id;
  if (e.op === 'meta') return 'meta';
  if (e.op === 'img') return 'img:' + e.payload.hash + '/' + e.payload.variant + imgSuffix(e.payload);
  throw new Error('bad outbox op: ' + e.op);
}

function createOutbox(dir, opts = {}) {
  const file = path.join(dir, 'outbox.json');
  const clock = opts.now || Date.now;
  const entries = new Map(); // key -> entry (insertion ordered)
  let timer = null;
  let dirty = false;

  function load() {
    entries.clear();
    try {
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const e of Array.isArray(arr) ? arr : []) {
        try {
          const entry = { op: e.op, payload: e.payload, tries: Number(e.tries) || 0, nextAt: Number(e.nextAt) || 0 };
          entries.set(keyOf(entry), entry);
        } catch (_) { /* skip bad entry */ }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.warn('[catalog] outbox.json unreadable, keeping a copy and starting empty:', e.message);
        try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch (_) { /* ignore */ }
      }
    }
    return api;
  }

  function scheduleWrite() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, WRITE_DEBOUNCE_MS);
    if (timer.unref) timer.unref();
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty) return true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Array.from(entries.values())));
      fs.renameSync(tmp, file);
      dirty = false;
      return true;
    } catch (e) {
      console.warn('[catalog] outbox.json write failed:', e.message);
      return false;
    }
  }

  function enqueue(op, payload) {
    payload = JSON.parse(JSON.stringify(payload)); // snapshot: store objects are mutated in place
    const probe = { op, payload };
    const key = keyOf(probe);
    const cur = entries.get(key);
    if (cur) { cur.payload = payload; cur.tries = 0; cur.nextAt = 0; } // coalesce: latest wins, retry now
    else entries.set(key, { op, payload, tries: 0, nextAt: 0 });
    scheduleWrite();
    return entries.get(key);
  }

  const enqueueItem = (item) => enqueue('item', item);
  const enqueueMeta = (meta) => enqueue('meta', meta);
  const enqueueImage = (hash, variant, ver) => enqueue('img', { hash, variant, ver: variant === 'orig' ? null : (ver == null ? null : ver) });

  // Entries that may be sent right now: images first, then meta, then items whose image is uploaded.
  function ready(at = clock()) {
    const pendingImgHashes = new Set();
    for (const e of entries.values()) if (e.op === 'img') pendingImgHashes.add(e.payload.hash);
    const imgs = [], metas = [], items = [];
    for (const e of entries.values()) {
      if (e.nextAt > at) continue;
      if (e.op === 'img') imgs.push(e);
      else if (e.op === 'meta') metas.push(e);
      else if (e.op === 'item') {
        const im = e.payload.image;
        if (im && im.hash && pendingImgHashes.has(im.hash)) continue;
        items.push(e);
      }
    }
    return { img: imgs, meta: metas, item: items };
  }

  function get(key) { return entries.get(key) || null; }
  const getItem = (id) => entries.get('item:' + id) || null;
  const hasItem = (id) => entries.has('item:' + id);
  const getMeta = () => entries.get('meta') || null;

  // Remove an entry. If `expect` (the payload that was sent) is given, only remove when the
  // entry still holds that payload (an edit that arrived during the request must survive).
  function remove(key, expect) {
    const cur = entries.get(key);
    if (!cur) return false;
    if (expect !== undefined && cur.payload !== expect && !sameStamp(cur, expect)) return false;
    entries.delete(key);
    scheduleWrite();
    return true;
  }

  function sameStamp(cur, sent) {
    if (cur.op === 'item') return cur.payload.updatedAt === sent.updatedAt && cur.payload.updatedBy === sent.updatedBy;
    if (cur.op === 'meta') return cur.payload.updatedAt === sent.updatedAt;
    return true;
  }

  function fail(key, at = clock()) {
    const cur = entries.get(key);
    if (!cur) return null;
    cur.tries += 1;
    cur.nextAt = at + backoffMs(cur.tries);
    scheduleWrite();
    return cur;
  }

  // Retry everything immediately (manual "sync now", network came back).
  function resetBackoff() {
    let n = 0;
    for (const e of entries.values()) if (e.nextAt || e.tries) { e.nextAt = 0; e.tries = 0; n++; }
    if (n) scheduleWrite();
  }

  // Earliest future retry time (entries already due are ignored), or null.
  function nextDueAt(at = clock()) {
    let min = Infinity;
    for (const e of entries.values()) if (e.nextAt > at && e.nextAt < min) min = e.nextAt;
    return min === Infinity ? null : min;
  }

  const size = () => entries.size;
  const list = () => Array.from(entries.values());
  function itemIds() { const out = []; for (const e of entries.values()) if (e.op === 'item') out.push(e.payload.id); return out; }

  const api = { load, flush, enqueue, enqueueItem, enqueueMeta, enqueueImage, ready, get, getItem, hasItem, getMeta, remove, fail, resetBackoff, nextDueAt, size, list, itemIds, keyOf, file };
  return api;
}

module.exports = { createOutbox, backoffMs, keyOf, BACKOFF_BASE_MS, BACKOFF_MAX_MS };
