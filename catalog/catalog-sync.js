'use strict';
// Catalog sync with the Cloudflare Worker (spec §6.2). Runs in Electron main OR plain Node:
// it only needs a store, an outbox, an image store and a config getter (global fetch).
//   pull  GET changes?since=lastRev (paged) -> store.applyRemote (mergeItem) -> setLastRev
//   push  outbox: images first, meta, then items in batches (<=200); accepted -> synced stamp,
//         stale -> merge `current`, 409 clock_skew -> fix offset + restamp offenders + retry, 401 -> stop writes
// Status model: { state:'ok'|'pending'|'offline'|'unconfigured'|'readonly'|'confirm-target', pending, lastOkAt, lastError, problems, ... }
const os = require('os');
const { EventEmitter } = require('events');
const { defaults } = require('./defaults');
const { exceedsSkew } = require('./shared/merge');
const { PERMANENT_TRIES } = require('./catalog-outbox');

const KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const HTTPS_RE = /^https:\/\/[^\s/?#]+/i;
const LOCAL_HTTP_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;
const CLOCK_OK_MS = 3000;       // |server - local| below this = clock is fine, offset 0
const MAX_PROBLEMS = 50;
const MSG = {
  network: 'ต่อ Worker ไม่ได้ ตรวจอินเทอร์เน็ตและ Worker URL ระบบจะลองใหม่เอง',
  noConfig: 'ยังไม่ได้ตั้งค่า Cloudflare เปิด "ตั้งค่า Cloudflare" แล้วใส่ Worker URL กับ Catalog Key',
  badUrl: 'Worker URL ไม่ถูกต้อง ต้องขึ้นต้นด้วย https:// (คัดลอกจากช่อง Database URL ของระบบรับเงินโอน)',
  httpUrl: 'Worker URL ต้องขึ้นต้นด้วย https:// (ใช้ http:// ได้เฉพาะ localhost เพื่อทดสอบ) เพราะ write token จะถูกส่งไปกับทุกคำขอ',
  badKey: 'Catalog Key ไม่ถูกต้อง ต้องยาว 32-128 ตัว ใช้ A-Z a-z 0-9 _ - เท่านั้น กดสุ่มคีย์ใหม่ หรือคัดลอกจากเครื่องหลัก',
  noEndpoint: 'Worker นี้ยังไม่มีระบบ Catalog อัปเดตและ deploy Worker ตามคู่มือ docs/cloudflare-setup.md แล้วลองใหม่',
  badToken: 'write token ไม่ถูกต้อง เปิด "ตั้งค่า Cloudflare" แล้วใส่ write token ที่ตั้งไว้ตอนเริ่มใช้งานคีย์ (ต้องเหมือนกันทุกเครื่องที่แก้ไขได้)',
  noToken: 'เครื่องนี้ยังไม่มี write token จึงดูข้อมูลได้อย่างเดียว ใส่ write token ใน "ตั้งค่า Cloudflare" ถ้าต้องการแก้ไข',
  server: (s) => 'Worker ตอบผิดพลาด (HTTP ' + s + ') ระบบจะลองใหม่เอง',
  skew: 'นาฬิกาเครื่องนี้ไม่ตรงกับเซิร์ฟเวอร์ ตั้งเวลาเครื่องให้ตรง (เปิดซิงก์เวลาอัตโนมัติของ Windows)',
  tooBig: 'ไฟล์ใหญ่เกินกำหนด'
};
const ITEM_REASON = {
  bad_image: 'ข้อมูลรูปของสินค้าไม่ถูกต้อง เปิดสินค้านี้ แก้ไขรูป แล้วกดบันทึกใหม่',
  too_large: 'ข้อมูลสินค้ายาวเกินไป ลดข้อความ (ชื่อ/บาร์โค้ด/แท็ก) แล้วกดบันทึกใหม่'
};
const itemReason = (r) => ITEM_REASON[r] || 'Worker ไม่รับสินค้านี้ (' + r + ') เปิดสินค้าแล้วกดบันทึกใหม่ ถ้ายังไม่ได้ให้ติดต่อผู้ดูแลระบบ';

class NetError extends Error {}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
class StopPush extends Error {}

function urlProblem(url) {
  const u = String(url || '');
  if (HTTPS_RE.test(u) || LOCAL_HTTP_RE.test(u)) return null;
  return /^http:\/\//i.test(u) ? 'httpUrl' : 'badUrl';
}
const normUrl = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();

function createSync(opts) {
  const { store, outbox, images } = opts;
  const getConfig = opts.getConfig;
  const fetchFn = opts.fetch || ((...a) => globalThis.fetch(...a));
  const clock = opts.now || Date.now;
  const log = opts.log || ((...a) => console.log('[catalog]', ...a));
  const warn = opts.warn || ((...a) => console.warn('[catalog]', ...a));
  const emitter = new EventEmitter();

  let started = false;
  let stopped = false;
  let timer = null;
  let kickTimer = null;
  let netTimer = null;
  let statusTimer = null;
  let netPrint = null;
  let visible = typeof opts.isVisible === 'function' ? !!opts.isVisible() : false;
  let focused = typeof opts.isFocused === 'function' ? !!opts.isFocused() : true;
  let running = null;
  let rerun = false;
  let online = true;          // result of the last network attempt
  let lastOkAt = 0;
  let lastError = null;
  let pullFailSince = 0;
  let failStreak = 0;         // consecutive failed pulls (poll backoff)
  let writeBlocked = false;   // 401 seen: stop retrying writes until config changes
  let reconciled = false;
  let imagesRequeue = false;  // re-queue uploads of every locally referenced image (new/changed target)
  let awaiting = null;        // {id, itemCount}: target catalog already has items, waiting for the user
  let confirmedFor = null;
  let lastStatusJson = '';
  const problems = new Map(); // key -> {id, kind:'item'|'image', reason}
  const imgInflight = new Map();
  const imgFailUntil = new Map();
  let dlActive = 0;
  const dlQueue = [];

  // ------------------------------------------------------------ config / status
  function wcfg(override) {
    const c = (getConfig() || {}).worker || {};
    return Object.assign({}, defaults.worker, c, override || {});
  }
  function configProblem(w) {
    if (!w.url && !w.key) return 'noConfig';
    const up = urlProblem(w.url);
    if (up) return up;
    if (!KEY_RE.test(w.key || '')) return 'badKey';
    return null;
  }
  const isConfigured = () => !configProblem(wcfg());
  const baseOf = (w) => String(w.url).replace(/\/+$/, '') + '/catalog/' + w.key;
  const identity = (w) => String(w.url).replace(/\/+$/, '') + '|' + w.key;

  function status() {
    const w = wcfg();
    const configured = !configProblem(w);
    const hasWriteToken = !!w.writeToken;
    const pending = outbox.size();
    let state;
    if (!configured) state = 'unconfigured';
    else if (awaiting) state = 'confirm-target';
    else if (!online) state = 'offline';
    else if (!hasWriteToken) state = 'readonly';
    else if (pending > 0 || writeBlocked) state = 'pending';
    else state = 'ok';
    const warnBar = !!(configured && pullFailSince && clock() - pullFailSince > w.warnAfterMs);
    return {
      state, pending, lastOkAt, lastError,
      configured, hasWriteToken, writeBlocked,
      canEdit: !configured || hasWriteToken, // read-only mode: key without write token
      warn: warnBar,
      target: awaiting ? { itemCount: awaiting.itemCount } : null,
      problemCount: problems.size,
      problems: Array.from(problems.values()).slice(0, MAX_PROBLEMS).map((p) => ({ id: p.id, kind: p.kind, reason: p.reason }))
    };
  }
  function getStatus() { return status(); }

  function emitStatus() {
    const s = status();
    const j = JSON.stringify(s);
    if (j === lastStatusJson) return;
    lastStatusJson = j;
    try { emitter.emit('status', s); } catch (e) { warn('status listener error', e.message); }
  }
  function emitStatusSoon() {
    if (statusTimer || stopped) return;
    statusTimer = setTimeout(() => { statusTimer = null; emitStatus(); }, 50);
    if (statusTimer.unref) statusTimer.unref();
  }

  // ------------------------------------------------------------ http
  // Keep the device clock offset close to the server's: sample = serverTime - request midpoint.
  function noteServerTime(serverTime, t0, t1) {
    const st = Number(serverTime);
    const rtt = t1 - t0;
    if (!Number.isFinite(st) || rtt < 0 || rtt > 5000) return;
    const sample = Math.round(st - (t0 + t1) / 2);
    const cur = store.clockOffset;
    if (Math.abs(sample) < CLOCK_OK_MS) { if (cur !== 0) store.setClockOffset(0); return; }
    if (Math.abs(sample - cur) > CLOCK_OK_MS) store.setClockOffset(sample);
  }

  async function readCapped(res, max) {
    const cl = res.headers && res.headers.get ? Number(res.headers.get('content-length')) : 0;
    if (cl > max) { try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (_) { /* ignore */ } throw new HttpError(413, MSG.tooBig); }
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = []; let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > max) { try { await reader.cancel(); } catch (_) { /* ignore */ } throw new HttpError(413, MSG.tooBig); }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new HttpError(413, MSG.tooBig);
    return buf;
  }

  // o: {query, json, body, headers, write, binary, maxBytes, timeoutMs, worker(override cfg)}
  async function request(method, pathname, o = {}) {
    const w = wcfg(o.worker);
    const problem = configProblem(w);
    if (problem) throw new HttpError(0, MSG[problem]);
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), o.timeoutMs || w.requestTimeoutMs);
    const t0 = Date.now();
    try {
      const headers = Object.assign({}, o.headers);
      if (o.write) headers['X-Catalog-Write'] = w.writeToken;
      let body = o.body;
      if (o.json !== undefined) { body = JSON.stringify(o.json); headers['Content-Type'] = 'application/json'; }
      // redirect:'error' - never forward the write token to a different host
      const res = await fetchFn(baseOf(w) + pathname + (o.query || ''), { method, headers, body, signal: ctl.signal, redirect: 'error' });
      if (o.binary && res.ok) {
        const buf = await readCapped(res, o.maxBytes || w.maxImageBytes);
        return { status: res.status, ok: true, buf, type: (res.headers && res.headers.get && res.headers.get('content-type')) || '' };
      }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { /* not json */ }
      if (res.ok && data && !o.worker) noteServerTime(data.serverTime, t0, Date.now());
      return { status: res.status, ok: res.ok, data };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new NetError(e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'network');
    } finally {
      clearTimeout(to);
    }
  }

  // Message for a failed (non-2xx) response.
  function describe(r) {
    const code = r.data && r.data.error;
    if (r.status === 400 && code === 'invalid_key') return MSG.badKey;
    if (r.status === 401) return MSG.badToken;
    if (r.status === 404 && code !== 'not_found') return MSG.noEndpoint;
    if (r.status === 409 && code === 'clock_skew') return MSG.skew;
    if (r.data && r.data.message) return r.data.message;
    return MSG.server(r.status);
  }
  function failFromResponse(r) { return new HttpError(r.status, describe(r)); }

  function markOnline(ok, err) {
    online = ok;
    if (ok) { lastError = null; } else if (err) lastError = err;
  }

  // ------------------------------------------------------------ pull
  function dropStalePending(appliedIds) {
    for (const id of appliedIds) { outbox.remove('item:' + id); problems.delete('item:' + id); }
  }

  function onRemoteMeta(meta) {
    const r = store.applyRemoteMeta(meta, { union: !!wcfg().writeToken });
    if (r.applied) outbox.remove('meta');
    if (r.needsPush) outbox.enqueueMeta(pickMeta(store.getMeta()));
  }

  function applyPage(d) {
    const { applied } = store.applyRemote(d.items || []);
    dropStalePending(applied);
    if (d.meta) onRemoteMeta(d.meta);
  }

  async function getChanges(since) {
    const r = await request('GET', '/changes', { query: '?since=' + since + '&limit=500' });
    if (!r.ok || !r.data) throw failFromResponse(r);
    return r.data;
  }

  // wiped: the server is BEHIND our lastRev (its data was lost/reset). Then local copies are the only
  // copies: they are kept and re-queued. Otherwise (tombstone horizon) only never-synced, pending and
  // rejected items are kept. A backup of db.json is written first in every case.
  async function fullRepull(wiped) {
    const all = [];
    let since = 0, meta = null, rev = 0;
    for (let guard = 0; guard < 2000; guard++) {
      const d = await getChanges(since);
      if (d.resetRequired) throw new HttpError(500, 'Worker ขอให้ดึงใหม่ซ้ำ ลองอีกครั้ง');
      for (const it of d.items || []) all.push(it);
      if (d.meta) meta = d.meta;
      rev = d.rev; since = d.rev;
      if (!d.more) break;
    }
    const bak = store.snapshot('reset');
    if (!bak) throw new HttpError(500, 'สำรองข้อมูลก่อนดึงใหม่ไม่สำเร็จ ระบบจะลองใหม่ ข้อมูลในเครื่องยังอยู่ครบ');
    const keep = new Set(outbox.itemIds());
    for (const p of problems.values()) if (p.kind === 'item') keep.add(p.id);
    for (const it of store.list({ includeDeleted: true })) {
      if (wiped || !store.isSynced(it)) keep.add(it.id);
    }
    store.resetAll(all, { keepIds: keep });
    // a pending edit that lost to the server copy during the reset is obsolete
    for (const id of outbox.itemIds()) {
      const cur = store.get(id), e = outbox.getItem(id);
      if (!cur || cur.updatedAt !== e.payload.updatedAt || cur.updatedBy !== e.payload.updatedBy) outbox.remove('item:' + id);
    }
    if (meta) onRemoteMeta(meta); else if (wiped) store.setMetaRev(0);
    store.setLastRev(rev);
    reconciled = false;           // reconcile re-queues every kept item the server does not have
    if (wiped) imagesRequeue = true;
    log('full re-pull done,', all.length, 'items', wiped ? '(server was reset: local copies re-queued)' : '', 'backup', bak);
  }

  async function pull() {
    let since = store.lastRev;
    for (let guard = 0; guard < 2000; guard++) {
      const d = await getChanges(since);
      if (d.resetRequired) { await fullRepull(since > (Number(d.rev) || 0)); return; }
      applyPage(d);
      since = d.rev;
      store.setLastRev(since);
      if (!d.more) return;
    }
  }

  // Re-queue anything whose current stamp is not known to be on the server (never pushed, lost
  // outbox, edited while the outbox write failed...) and, when needed, every referenced image.
  function reconcile() {
    reconciled = true;
    if (!wcfg().writeToken) return;
    let n = 0;
    for (const it of store.list({ includeDeleted: true })) {
      if (!store.isSynced(it) && !outbox.hasItem(it.id)) { outbox.enqueueItem(it); n++; }
    }
    const m = store.getMeta();
    if (!m.rev && !outbox.getMeta() && (m.updatedAt || (m.categories || []).length > 1 || m.shopName)) outbox.enqueueMeta(pickMeta(m));
    if (imagesRequeue) { imagesRequeue = false; requeueImages(); }
    if (n) log('queued', n, 'items the server does not have yet');
    outbox.flush();
  }

  function requeueImages() {
    const seen = new Set();
    let n = 0;
    for (const it of store.list({ includeDeleted: true })) {
      const im = it.image;
      if (!im || !im.hash) continue;
      const ver = Number.isInteger(im.ver) && im.ver > 0 ? im.ver : 1;
      for (const variant of ['orig', 'thumb', 'full']) {
        const v = variant === 'orig' ? null : ver;
        const k = im.hash + '/' + variant + '/' + v;
        if (seen.has(k)) continue;
        seen.add(k);
        let have = false;
        try { have = images.has(im.hash, variant, v); } catch (_) { have = false; }
        if (!have) continue;
        if (!outbox.get(outbox.keyOf({ op: 'img', payload: { hash: im.hash, variant, ver: v } }))) { outbox.enqueueImage(im.hash, variant, v); n++; }
      }
    }
    if (n) log('queued', n, 'image uploads for the new target');
  }

  // ------------------------------------------------------------ push
  const pickMeta = (m) => ({ categories: (m.categories || []).slice(), shopName: m.shopName || '', updatedAt: m.updatedAt || store.now() });
  const imgPath = (p) => '/img/' + p.hash + '/' + p.variant + (p.variant === 'orig' || p.ver == null ? '' : '-v' + p.ver);

  function blockWrites() {
    writeBlocked = true;
    lastError = MSG.badToken;
    throw new StopPush('401');
  }

  // 409 clock_skew: fix the offset from serverTime, then re-stamp ONLY the pending edits that are
  // too far in the future; correctly stamped (older, offline) edits keep their time.
  function handleSkew(serverTime) {
    const server = Number(serverTime);
    const offset = Math.round(server - Date.now());
    store.setClockOffset(Number.isFinite(offset) ? offset : 0);
    const bad = outbox.list().filter((e) => e.op === 'item' && exceedsSkew(e.payload.updatedAt, server)).map((e) => e.payload.id);
    for (const it of store.restamp(bad)) outbox.enqueueItem(it);
    const m = outbox.getMeta();
    if (m && exceedsSkew(m.payload.updatedAt, server)) { store.restampMeta(); outbox.enqueueMeta(pickMeta(store.getMeta())); }
    warn('clock skew, offset set to', store.clockOffset, 'ms;', bad.length, 'pending edits re-stamped');
  }

  const imgProblemKey = (p) => 'img:' + p.hash + '/' + p.variant + (p.ver == null ? '' : '-v' + p.ver);
  function imgProblem(p, reason) { problems.set(imgProblemKey(p), { id: p.hash, kind: 'image', reason }); }

  // Never throws on a transient/HTTP failure of one image (items and meta must still go out);
  // returns the first such error so the cycle can report it. Network errors / 401 abort the push.
  async function pushImages() {
    let firstErr = null;
    for (const e of outbox.ready(clock()).img) {
      const key = outbox.keyOf(e);
      const p = e.payload;
      let buf = null;
      try { buf = images && images.read(p.hash, p.variant, p.ver); } catch (_) { buf = null; }
      if (!buf) { warn('image file missing, dropping upload', key); imgProblem(p, 'ไม่พบไฟล์รูปในเครื่องนี้ ถ่ายหรือปรับรูปสินค้านี้ใหม่'); outbox.remove(key); continue; }
      let r;
      try {
        r = await request('PUT', imgPath(p), { write: true, body: buf, headers: { 'Content-Type': 'image/jpeg' }, timeoutMs: wcfg().imageTimeoutMs });
      } catch (err) {
        outbox.fail(key, clock());
        if (err instanceof NetError || err instanceof StopPush) throw err;
        firstErr = firstErr || err;
        continue;
      }
      if (r.ok) { outbox.remove(key); problems.delete(imgProblemKey(p)); continue; }
      if (r.status === 401) blockWrites();
      if (r.status === 400 || r.status === 413 || r.status === 415) {
        warn('image rejected permanently', key, r.status);
        imgProblem(p, 'Worker ไม่รับไฟล์รูปนี้ (ใหญ่เกิน 5MB หรือชนิดไม่รองรับ) ปรับรูปสินค้านี้ใหม่แล้วบันทึก');
        outbox.remove(key);
        continue;
      }
      // 429 / 403 / 404 / 5xx: back off; after PERMANENT_TRIES the item is pushed without waiting
      // and the image stays queued (retried every few minutes) - shown as a problem meanwhile.
      const cur = outbox.fail(key, clock());
      if (cur && cur.tries >= PERMANENT_TRIES) imgProblem(p, 'อัปโหลดรูปไม่สำเร็จหลายครั้ง (HTTP ' + r.status + ') ระบบจะลองใหม่เอง ระหว่างนี้เครื่องอื่นจะยังไม่เห็นรูปนี้');
      firstErr = firstErr || failFromResponse(r);
    }
    return firstErr;
  }

  async function pushMeta() {
    const e = outbox.getMeta();
    if (!e || e.nextAt > clock()) return 'none';
    const sent = e.payload;
    let r;
    try { r = await request('PUT', '/meta', { write: true, json: sent }); } catch (err) { outbox.fail('meta', clock()); throw err; }
    if (r.ok) {
      if (r.data && r.data.meta && r.data.meta.rev != null) store.setMetaRev(r.data.meta.rev);
      outbox.remove('meta', sent);
      return 'ok';
    }
    if (r.status === 401) blockWrites();
    if (r.status === 409 && r.data && r.data.error === 'clock_skew') { handleSkew(r.data.serverTime); return 'skew'; }
    if (r.status === 409 && r.data && r.data.error === 'stale' && r.data.meta) {
      outbox.remove('meta', sent);
      onRemoteMeta(r.data.meta);
      return 'ok';
    }
    outbox.fail('meta', clock());
    throw failFromResponse(r);
  }

  async function pushItems() {
    const batch = outbox.ready(clock()).item.slice(0, wcfg().batchSize);
    if (!batch.length) return 'none';
    const sent = new Map(batch.map((e) => [e.payload.id, e.payload]));
    let r;
    try { r = await request('POST', '/items', { write: true, json: { items: batch.map((e) => e.payload) } }); } catch (err) {
      for (const e of batch) outbox.fail(outbox.keyOf(e), clock());
      throw err;
    }
    if (r.status === 401) blockWrites();
    if (r.status === 409 && r.data && r.data.error === 'clock_skew') { handleSkew(r.data.serverTime); return 'skew'; }
    if (!r.ok || !r.data) {
      for (const e of batch) outbox.fail(outbox.keyOf(e), clock());
      throw failFromResponse(r);
    }
    for (const a of r.data.accepted || []) {
      const p = sent.get(a.id);
      if (!p) continue;
      store.markSynced(a.id, p.updatedAt + '|' + p.updatedBy);
      const cur = store.get(a.id);
      if (cur && cur.updatedAt === p.updatedAt && cur.updatedBy === p.updatedBy) store.setRev(a.id, a.rev);
      outbox.remove('item:' + a.id, p);
      problems.delete('item:' + a.id);
    }
    for (const rj of r.data.rejected || []) {
      const p = sent.get(rj.id);
      if (!p) continue;
      if (rj.reason === 'stale' && rj.current) {
        store.applyRemote([rj.current]); // server copy is newer: mergeItem decides (local edits made meanwhile survive)
        problems.delete('item:' + rj.id);
      } else {
        warn('item', rj.id, 'rejected by server:', rj.reason);
        problems.set('item:' + rj.id, { id: rj.id, kind: 'item', reason: itemReason(rj.reason) });
      }
      outbox.remove('item:' + rj.id, p);
    }
    return 'ok';
  }

  async function push() {
    const w = wcfg();
    if (!w.writeToken || writeBlocked) return;
    let skews = 0;
    let softErr = null;
    for (let round = 0; round < 500; round++) {
      softErr = softErr || await pushImages();
      let res;
      try { res = await pushMeta(); } catch (e) {
        if (e instanceof NetError || e instanceof StopPush) throw e;
        softErr = softErr || e; res = 'none';
      }
      if (res !== 'skew') res = await pushItems();
      if (res === 'skew') { if (++skews > 2) throw new HttpError(409, MSG.skew); continue; }
      if (res === 'none' && !outbox.ready(clock()).item.length) break;
    }
    if (softErr) throw softErr;
  }

  // ------------------------------------------------------------ target (catalog identity) safety
  function adopt(id) {
    if (store.syncId) { warn('catalog changed, resetting local sync state'); store.resetSyncState(id); } else store.setSyncId(id);
    reconciled = false;
    imagesRequeue = true;
    awaiting = null;
    return true;
  }

  // First use of a different Worker URL/key: when the target already holds items and we have local
  // data (and may write), ask the user before anything is merged into it.
  async function decideTarget(id) {
    const w = wcfg();
    const localHas = store.list({ includeDeleted: true }).length > 0 || outbox.size() > 0;
    if (confirmedFor === id || !localHas || !w.writeToken) return adopt(id);
    let r;
    try { r = await request('GET', '/health', { timeoutMs: 10000 }); } catch (e) { handleFailure(e, true); return false; }
    if (!r.ok || !r.data) { handleFailure(failFromResponse(r), true); return false; }
    if (r.data.initialized && Number(r.data.itemCount) > 0) {
      awaiting = { id, itemCount: Number(r.data.itemCount) };
      return false;
    }
    return adopt(id);
  }

  function confirmTarget() {
    if (!awaiting) return { ok: false, message: 'ไม่มีรายการรอยืนยัน' };
    confirmedFor = awaiting.id;
    awaiting = null;
    emitStatus();
    run();
    return { ok: true };
  }

  // ------------------------------------------------------------ cycle / scheduling
  async function cycle() {
    if (stopped) return;
    const w = wcfg();
    if (configProblem(w)) { emitStatus(); return; }
    const id = identity(w);
    if (store.syncId !== id) {
      if (!(await decideTarget(id))) { emitStatus(); return; }
    }
    try {
      await pull();
      markOnline(true);
      lastOkAt = clock();
      pullFailSince = 0;
      failStreak = 0;
    } catch (e) {
      handleFailure(e, true);
      emitStatus();
      return;
    }
    try {
      if (!reconciled) reconcile();
      await push();
    } catch (e) {
      if (!(e instanceof StopPush)) handleFailure(e, false);
    }
    emitStatus();
  }

  function handleFailure(e, isPull) {
    const msg = e instanceof NetError ? MSG.network : (e && e.message) || MSG.network;
    if (e instanceof NetError || (e instanceof HttpError && (e.status >= 500 || e.status === 0))) markOnline(false, msg);
    else if (isPull) markOnline(false, msg);
    else lastError = msg;
    if (isPull) { failStreak++; if (!pullFailSince) pullFailSince = clock(); }
    warn(isPull ? 'pull failed:' : 'push failed:', e && e.message);
  }

  function run() {
    if (stopped) return Promise.resolve();
    if (running) { rerun = true; return running; }
    running = (async () => {
      do { rerun = false; try { await cycle(); } catch (e) { warn('cycle error', e && e.stack || e); } } while (rerun && !stopped);
    })().finally(() => { running = null; schedule(); });
    return running;
  }

  // Poll interval: focused+visible = pollMsVisible, visible but unfocused = pollMsUnfocused,
  // hidden = pollMsHidden; doubled per consecutive failed pull up to pollBackoffMaxMs.
  function nextWait() {
    const w = wcfg();
    const base = visible ? (focused ? w.pollMsVisible : w.pollMsUnfocused) : w.pollMsHidden;
    let wait = base;
    if (failStreak > 0) wait = Math.max(base, Math.min(w.pollBackoffMaxMs, base * Math.pow(2, Math.min(failStreak, 10))));
    if (w.writeToken && !writeBlocked) {
      const due = outbox.nextDueAt(clock());
      if (due != null) wait = Math.min(wait, Math.max(250, due - clock()));
    }
    return wait;
  }

  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (stopped || !started) return;
    timer = setTimeout(() => { timer = null; run(); }, nextWait());
    if (timer.unref) timer.unref();
  }

  // Debounced "something local changed": push soon.
  function kick(ms = 300) {
    if (stopped || !started || kickTimer) { emitStatusSoon(); return; }
    kickTimer = setTimeout(() => { kickTimer = null; run(); }, ms);
    if (kickTimer.unref) kickTimer.unref();
    emitStatusSoon();
  }

  // o.soft: automatic triggers (network change, resume, focus) leave permanently failing entries' backoff alone.
  function syncNow(o = {}) {
    outbox.resetBackoff({ soft: !!o.soft });
    return run();
  }

  function setVisible(v) {
    v = !!v;
    if (v === visible) return;
    visible = v;
    if (v) syncNow({ soft: true }); else schedule();
  }
  function setFocused(f) {
    f = !!f;
    if (f === focused) return;
    focused = f;
    if (f && visible) syncNow({ soft: true }); else schedule();
  }

  // Call after url / key / write token changed.
  function configChanged() {
    writeBlocked = false;
    lastError = null;
    pullFailSince = 0;
    failStreak = 0;
    online = true;
    reconciled = false;
    awaiting = null;
    outbox.resetBackoff();
    emitStatus();
    return run();
  }

  function netFingerprint() {
    try {
      const out = [];
      for (const [name, list] of Object.entries(os.networkInterfaces())) {
        for (const a of list || []) {
          const v4 = a.family === 'IPv4' || a.family === 4;
          if (v4 && !a.internal && !String(a.address).startsWith('169.254.')) out.push(name + '/' + a.address);
        }
      }
      return out.sort().join(',');
    } catch (_) { return ''; }
  }

  function start(o = {}) {
    if (started) return;
    started = true; stopped = false;
    if (o.watchNetwork) {
      netPrint = netFingerprint();
      netTimer = setInterval(() => {
        const p = netFingerprint();
        if (p !== netPrint) { netPrint = p; log('network changed, syncing now'); syncNow({ soft: true }); }
      }, 5000);
      if (netTimer.unref) netTimer.unref();
    }
    run();
  }

  function stop() {
    stopped = true;
    for (const t of [timer, kickTimer, netTimer, statusTimer]) if (t) { clearTimeout(t); clearInterval(t); }
    timer = kickTimer = netTimer = statusTimer = null;
    try { outbox.flush(); } catch (_) { /* ignore */ }
  }

  // ------------------------------------------------------------ local edits -> outbox
  store.on('local', ({ ids, meta }) => {
    try {
      for (const id of ids || []) {
        const it = store.get(id);
        problems.delete('item:' + id);
        if (it) outbox.enqueueItem(it);
      }
      if (meta) outbox.enqueueMeta(pickMeta(store.getMeta()));
      outbox.flush(); // durable before the IPC call returns to the UI (outbox is small)
      kick();
    } catch (e) { warn('enqueue failed', e.message); }
  });
  if (images && images.on) {
    images.on('saved', ({ hash, ver, orig }) => {
      try {
        if (orig) outbox.enqueueImage(hash, 'orig', null);
        outbox.enqueueImage(hash, 'thumb', ver);
        outbox.enqueueImage(hash, 'full', ver);
        outbox.flush();
        kick();
      } catch (e) { warn('enqueue image failed', e.message); }
    });
  }

  // ------------------------------------------------------------ images (lazy download)
  async function acquireSlot() {
    const max = Math.max(1, Number(wcfg().maxConcurrentDownloads) || 4);
    if (dlActive < max) { dlActive++; return; }
    await new Promise((res) => dlQueue.push(res));
  }
  function releaseSlot() {
    const next = dlQueue.shift();
    if (next) next(); else dlActive--;
  }

  // Returns the local file path (downloading from R2 when missing) or null. Concurrent callers
  // for the same file share one request; at most maxConcurrentDownloads run at once; misses are
  // remembered for 15s; each file is capped at maxImageBytes.
  function ensureImage(hash, variant, ver) {
    try {
      hash = String(hash).toLowerCase();
      if (variant === 'orig') ver = null; else ver = ver == null ? null : Number(ver);
      if (images.has(hash, variant, ver)) return Promise.resolve(images.path(hash, variant, ver));
    } catch (_) { return Promise.resolve(null); }
    if (!isConfigured()) return Promise.resolve(null);
    const key = hash + '/' + variant + '/' + (ver == null ? '' : ver);
    if (imgInflight.has(key)) return imgInflight.get(key);
    if ((imgFailUntil.get(key) || 0) > clock()) return Promise.resolve(null);
    const p = (async () => {
      await acquireSlot();
      try {
        const r = await request('GET', imgPath({ hash, variant, ver }), { binary: true, timeoutMs: wcfg().imageTimeoutMs });
        if (r.ok && r.buf.length && /^image\//i.test(r.type)) return images.write(hash, variant, ver, r.buf);
      } catch (e) { /* offline, missing or too large: fall through */ } finally { releaseSlot(); }
      imgFailUntil.set(key, clock() + 15000);
      return null;
    })().finally(() => imgInflight.delete(key));
    imgInflight.set(key, p);
    return p;
  }

  // ------------------------------------------------------------ settings helpers
  // cfg: {url, key} typed in the settings dialog (not necessarily saved yet). The saved write token is
  // only used when the URL is the saved one (never sent to a URL the user just typed).
  async function testConnection(cfg) {
    const override = { url: String((cfg && cfg.url) || '').trim(), key: String((cfg && cfg.key) || '').trim() };
    const saved = wcfg();
    const problem = configProblem(Object.assign({}, saved, override));
    if (problem) return { ok: false, code: problem, message: MSG[problem] };
    let r;
    try { r = await request('GET', '/health', { worker: override, timeoutMs: 10000 }); } catch (e) {
      return { ok: false, code: 'network', message: e instanceof HttpError ? e.message : MSG.network };
    }
    if (!r.ok || !r.data || r.data.ok !== true) return { ok: false, code: 'http_' + r.status, message: describe(r) };
    const d = r.data;
    const out = {
      ok: true, initialized: !!d.initialized, rev: d.rev, itemCount: d.itemCount,
      clockSkewMs: Math.round(Number(d.serverTime) - Date.now()), tokenOk: null
    };
    const sameUrl = normUrl(override.url) === normUrl(saved.url);
    const hasToken = !!saved.writeToken;
    if (d.initialized && hasToken && sameUrl) {
      try {
        const t = await request('POST', '/items', { worker: override, write: true, json: { items: [] }, timeoutMs: 10000 });
        out.tokenOk = t.ok;
      } catch (_) { out.tokenOk = null; }
    }
    if (!d.initialized) out.message = 'ต่อ Worker ได้ แต่คีย์นี้ยังไม่ได้เริ่มใช้งาน ใส่ write token (ตั้งเองได้ 16 ตัวขึ้นไป) แล้วกด "เริ่มใช้งานคีย์ใหม่"';
    else if (!hasToken) out.message = 'เชื่อมต่อสำเร็จ (มีสินค้า ' + d.itemCount + ' ชิ้น) เครื่องนี้ดูได้อย่างเดียว ถ้าต้องการแก้ไขให้ใส่ write token';
    else if (!sameUrl) out.message = 'เชื่อมต่อสำเร็จ มีสินค้า ' + d.itemCount + ' ชิ้นบน Worker (ยังไม่ตรวจ write token กับ URL ใหม่ กด "บันทึก" ก่อนแล้วทดสอบอีกครั้ง)';
    else if (out.tokenOk === false) out.message = MSG.badToken;
    else out.message = 'เชื่อมต่อสำเร็จ มีสินค้า ' + d.itemCount + ' ชิ้นบน Worker write token ใช้ได้';
    if (Math.abs(out.clockSkewMs) > 5 * 60 * 1000) out.message += ' (คำเตือน: นาฬิกาเครื่องคลาดจากเซิร์ฟเวอร์เกิน 5 นาที ' + MSG.skew + ')';
    return out;
  }

  // Sets the write token on a brand-new key (POST /init) using the saved config.
  async function initWorker() {
    const w = wcfg();
    const problem = configProblem(w);
    if (problem) return { ok: false, message: MSG[problem] };
    if (!w.writeToken || w.writeToken.length < 16) return { ok: false, message: 'ใส่ write token ก่อน (ยาว 16 ตัวอักษรขึ้นไป) แล้วกดบันทึก จากนั้นจึงเริ่มใช้งานคีย์' };
    let r;
    try { r = await request('POST', '/init', { write: true, timeoutMs: 10000 }); } catch (e) {
      return { ok: false, message: e instanceof HttpError ? e.message : MSG.network };
    }
    if (r.ok) { configChanged(); return { ok: true, message: 'เริ่มใช้งานคีย์แล้ว เครื่องอื่นใส่ Worker URL, Catalog Key และ write token เดียวกันเพื่อแก้ไขร่วมกัน' }; }
    if (r.status === 409) return { ok: false, message: 'คีย์นี้เริ่มใช้งานไปแล้ว ใส่ write token เดิมที่ตั้งไว้ หรือสุ่มคีย์ใหม่ถ้าต้องการแยกร้าน' };
    return { ok: false, message: describe(r) };
  }

  return {
    start, stop, syncNow, kick, setVisible, setFocused, configChanged, getStatus, ensureImage, testConnection, initWorker, confirmTarget,
    isConfigured, on: (ev, fn) => { emitter.on(ev, fn); }, off: (ev, fn) => { emitter.off(ev, fn); },
    // exposed for tests
    _cycle: cycle, _pull: pull, _push: push, _nextWait: nextWait, _problems: problems
  };
}

module.exports = { createSync, MSG, KEY_RE, urlProblem };
