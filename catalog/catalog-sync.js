'use strict';
// Catalog sync with the Cloudflare Worker (spec §6.2). Runs in Electron main OR plain Node:
// it only needs a store, an outbox, an image store and a config getter (global fetch).
//   pull  GET changes?since=lastRev (paged) -> store.applyRemote (mergeItem) -> setLastRev
//   push  outbox: images first, meta, then items in batches (<=200); accepted -> rev,
//         stale -> merge `current`, 409 clock_skew -> fix offset + restamp + retry, 401 -> stop writes
// Status model: { state:'ok'|'pending'|'offline'|'unconfigured'|'readonly', pending, lastOkAt, lastError, ... }
const os = require('os');
const { EventEmitter } = require('events');
const { defaults } = require('./defaults');

const KEY_RE = /^[A-Za-z0-9_-]{32,128}$/;
const URL_RE = /^https?:\/\/[^\s/?#]+/i;
const MSG = {
  network: 'ต่อ Worker ไม่ได้ ตรวจอินเทอร์เน็ตและ Worker URL ระบบจะลองใหม่เอง',
  noConfig: 'ยังไม่ได้ตั้งค่า Cloudflare เปิด "ตั้งค่า Cloudflare" แล้วใส่ Worker URL กับ Catalog Key',
  badUrl: 'Worker URL ไม่ถูกต้อง ต้องขึ้นต้นด้วย https:// (คัดลอกจากช่อง Database URL ของระบบรับเงินโอน)',
  badKey: 'Catalog Key ไม่ถูกต้อง ต้องยาว 32-128 ตัว ใช้ A-Z a-z 0-9 _ - เท่านั้น กดสุ่มคีย์ใหม่ หรือคัดลอกจากเครื่องหลัก',
  noEndpoint: 'Worker นี้ยังไม่มีระบบ Catalog อัปเดตและ deploy Worker ตามคู่มือ docs/cloudflare-setup.md แล้วลองใหม่',
  badToken: 'write token ไม่ถูกต้อง เปิด "ตั้งค่า Cloudflare" แล้วใส่ write token ที่ตั้งไว้ตอนเริ่มใช้งานคีย์ (ต้องเหมือนกันทุกเครื่องที่แก้ไขได้)',
  noToken: 'เครื่องนี้ยังไม่มี write token จึงดูข้อมูลได้อย่างเดียว ใส่ write token ใน "ตั้งค่า Cloudflare" ถ้าต้องการแก้ไข',
  server: (s) => 'Worker ตอบผิดพลาด (HTTP ' + s + ') ระบบจะลองใหม่เอง',
  skew: 'นาฬิกาเครื่องนี้ไม่ตรงกับเซิร์ฟเวอร์ ตั้งเวลาเครื่องให้ตรง (เปิดซิงก์เวลาอัตโนมัติของ Windows)'
};

class NetError extends Error {}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

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
  let running = null;
  let rerun = false;
  let online = true;          // result of the last network attempt
  let everTried = false;
  let lastOkAt = 0;
  let lastError = null;
  let pullFailSince = 0;
  let writeBlocked = false;   // 401 seen: stop retrying writes until config changes
  let reconciled = false;
  let lastStatusJson = '';
  const imgInflight = new Map();
  const imgFailUntil = new Map();

  // ------------------------------------------------------------ config / status
  function wcfg(override) {
    const c = (getConfig() || {}).worker || {};
    return Object.assign({}, defaults.worker, c, override || {});
  }
  function configProblem(w) {
    if (!w.url && !w.key) return 'noConfig';
    if (!URL_RE.test(w.url || '')) return 'badUrl';
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
    else if (!online) state = 'offline';
    else if (!hasWriteToken) state = 'readonly';
    else if (pending > 0 || writeBlocked) state = 'pending';
    else state = 'ok';
    const warnBar = !!(configured && pullFailSince && clock() - pullFailSince > w.warnAfterMs);
    return {
      state, pending, lastOkAt, lastError,
      configured, hasWriteToken, writeBlocked,
      canEdit: !configured || hasWriteToken, // read-only mode: key without write token
      warn: warnBar
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
  // o: {query, json, body, headers, write, binary, timeoutMs, worker(override cfg)}
  async function request(method, pathname, o = {}) {
    const w = wcfg(o.worker);
    const problem = configProblem(w);
    if (problem) throw new HttpError(0, MSG[problem]);
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), o.timeoutMs || w.requestTimeoutMs);
    try {
      const headers = Object.assign({}, o.headers);
      if (o.write) headers['X-Catalog-Write'] = w.writeToken;
      let body = o.body;
      if (o.json !== undefined) { body = JSON.stringify(o.json); headers['Content-Type'] = 'application/json'; }
      const res = await fetchFn(baseOf(w) + pathname + (o.query || ''), { method, headers, body, signal: ctl.signal });
      if (o.binary && res.ok) {
        return { status: res.status, ok: true, buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || '' };
      }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { /* not json */ }
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
    everTried = true;
  }

  // ------------------------------------------------------------ pull
  function dropStalePending(appliedIds) {
    for (const id of appliedIds) outbox.remove('item:' + id);
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

  async function fullRepull() {
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
    store.resetAll(all, { keepIds: new Set(outbox.itemIds()) });
    // a pending edit that lost to the server copy during the reset is obsolete
    for (const id of outbox.itemIds()) {
      const cur = store.get(id), e = outbox.getItem(id);
      if (!cur || cur.updatedAt !== e.payload.updatedAt || cur.updatedBy !== e.payload.updatedBy) outbox.remove('item:' + id);
    }
    if (meta) onRemoteMeta(meta);
    store.setLastRev(rev);
    log('full re-pull done,', all.length, 'items');
  }

  async function pull() {
    let since = store.lastRev;
    for (let guard = 0; guard < 2000; guard++) {
      const d = await getChanges(since);
      if (d.resetRequired) { await fullRepull(); return; }
      applyPage(d);
      since = d.rev;
      store.setLastRev(since);
      if (!d.more) return;
    }
  }

  // After the first good pull: anything without a server rev that is not queued was made before
  // sync existed (or against another catalog) -> queue it.
  function reconcile() {
    reconciled = true;
    if (!wcfg().writeToken) return;
    let n = 0;
    for (const it of store.list({ includeDeleted: true })) {
      if (!it.rev && !outbox.hasItem(it.id)) { outbox.enqueueItem(it); n++; }
    }
    const m = store.getMeta();
    if (!m.rev && !outbox.getMeta() && (m.updatedAt || (m.categories || []).length > 1 || m.shopName)) outbox.enqueueMeta(pickMeta(m));
    if (n) log('queued', n, 'items that were never synced');
  }

  // ------------------------------------------------------------ push
  const pickMeta = (m) => ({ categories: (m.categories || []).slice(), shopName: m.shopName || '', updatedAt: m.updatedAt || store.now() });
  const imgPath = (p) => '/img/' + p.hash + '/' + p.variant + (p.variant === 'orig' || p.ver == null ? '' : '-v' + p.ver);

  class StopPush extends Error {}

  function blockWrites() {
    writeBlocked = true;
    lastError = MSG.badToken;
    throw new StopPush('401');
  }

  function handleSkew(serverTime) {
    const offset = Math.round(Number(serverTime) - Date.now());
    store.setClockOffset(Number.isFinite(offset) ? offset : 0);
    for (const it of store.restamp(outbox.itemIds())) outbox.enqueueItem(it);
    if (outbox.getMeta()) { store.restampMeta(); outbox.enqueueMeta(pickMeta(store.getMeta())); }
    warn('clock skew, offset set to', store.clockOffset, 'ms; pending edits re-stamped');
  }

  async function pushImages() {
    for (const e of outbox.ready(clock()).img) {
      const key = outbox.keyOf(e);
      const p = e.payload;
      const buf = images && images.read(p.hash, p.variant, p.ver);
      if (!buf) { warn('image file missing, dropping upload', key); outbox.remove(key); continue; }
      let r;
      try {
        r = await request('PUT', imgPath(p), { write: true, body: buf, headers: { 'Content-Type': 'image/jpeg' }, timeoutMs: wcfg().imageTimeoutMs });
      } catch (err) { outbox.fail(key, clock()); throw err; }
      if (r.ok) { outbox.remove(key); continue; }
      if (r.status === 401) blockWrites();
      if (r.status === 400 || r.status === 413 || r.status === 415) { warn('image rejected permanently', key, r.status); outbox.remove(key); continue; }
      outbox.fail(key, clock());
      throw failFromResponse(r);
    }
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
      const cur = store.get(a.id);
      if (cur && cur.updatedAt === p.updatedAt && cur.updatedBy === p.updatedBy) store.setRev(a.id, a.rev);
      outbox.remove('item:' + a.id, p);
    }
    for (const rj of r.data.rejected || []) {
      const p = sent.get(rj.id);
      if (!p) continue;
      if (rj.reason === 'stale' && rj.current) {
        store.applyRemote([rj.current]); // server copy is newer: mergeItem decides (local edits made meanwhile survive)
      } else {
        warn('item', rj.id, 'rejected by server:', rj.reason, '(dropped from queue)');
      }
      outbox.remove('item:' + rj.id, p);
    }
    return 'ok';
  }

  async function push() {
    const w = wcfg();
    if (!w.writeToken || writeBlocked) return;
    let skews = 0;
    for (let round = 0; round < 500; round++) {
      await pushImages();
      let res = await pushMeta();
      if (res !== 'skew') res = await pushItems();
      if (res === 'skew') { if (++skews > 2) throw new HttpError(409, MSG.skew); continue; }
      if (res === 'none' && !outbox.ready(clock()).item.length) break;
    }
  }

  // ------------------------------------------------------------ cycle / scheduling
  async function cycle() {
    if (stopped) return;
    const w = wcfg();
    if (configProblem(w)) { emitStatus(); return; }
    const id = identity(w);
    if (store.syncId !== id) {
      if (store.syncId) { warn('catalog changed, resetting local sync state'); store.resetSyncState(id); } else store.setSyncId(id);
      reconciled = false;
    }
    try {
      await pull();
      markOnline(true);
      lastOkAt = clock();
      pullFailSince = 0;
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
    if (e instanceof NetError || (e instanceof HttpError && e.status >= 500) || (e instanceof HttpError && e.status === 0)) markOnline(false, msg);
    else if (isPull) markOnline(false, msg);
    else lastError = msg;
    if (isPull && !pullFailSince) pullFailSince = clock();
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

  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (stopped || !started) return;
    const w = wcfg();
    let wait = visible ? w.pollMsVisible : w.pollMsHidden;
    if (w.writeToken && !writeBlocked) {
      const due = outbox.nextDueAt(clock());
      if (due != null) wait = Math.min(wait, Math.max(250, due - clock()));
    }
    timer = setTimeout(() => { timer = null; run(); }, wait);
    if (timer.unref) timer.unref();
  }

  // Debounced "something local changed": push soon.
  function kick(ms = 300) {
    if (stopped || !started || kickTimer) { emitStatusSoon(); return; }
    kickTimer = setTimeout(() => { kickTimer = null; run(); }, ms);
    if (kickTimer.unref) kickTimer.unref();
    emitStatusSoon();
  }

  function syncNow() {
    outbox.resetBackoff();
    return run();
  }

  function setVisible(v) {
    v = !!v;
    if (v === visible) return;
    visible = v;
    if (v) syncNow(); else schedule();
  }

  // Call after url / key / write token changed.
  function configChanged() {
    writeBlocked = false;
    lastError = null;
    pullFailSince = 0;
    online = true;
    reconciled = false;
    outbox.resetBackoff();
    emitStatus();
    return run();
  }

  function netFingerprint() {
    try {
      const out = [];
      for (const [name, list] of Object.entries(os.networkInterfaces())) {
        for (const a of list || []) if (!a.internal) out.push(name + '/' + a.family + '/' + a.address);
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
        if (p !== netPrint) { netPrint = p; log('network changed, syncing now'); syncNow(); }
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
      for (const id of ids || []) { const it = store.get(id); if (it) outbox.enqueueItem(it); }
      if (meta) outbox.enqueueMeta(pickMeta(store.getMeta()));
      kick();
    } catch (e) { warn('enqueue failed', e.message); }
  });
  if (images && images.on) {
    images.on('saved', ({ hash, ver, orig }) => {
      try {
        if (orig) outbox.enqueueImage(hash, 'orig', null);
        outbox.enqueueImage(hash, 'thumb', ver);
        outbox.enqueueImage(hash, 'full', ver);
        kick();
      } catch (e) { warn('enqueue image failed', e.message); }
    });
  }

  // ------------------------------------------------------------ images (lazy download)
  // Returns the local file path (downloading from R2 when missing) or null. Concurrent callers
  // for the same file share one request; misses are remembered for 15s.
  function ensureImage(hash, variant, ver) {
    if (images.has(hash, variant, ver)) return Promise.resolve(images.path(hash, variant, ver));
    if (!isConfigured()) return Promise.resolve(null);
    const key = hash + '/' + variant + '/' + (ver == null ? '' : ver);
    if (imgInflight.has(key)) return imgInflight.get(key);
    if ((imgFailUntil.get(key) || 0) > clock()) return Promise.resolve(null);
    const p = (async () => {
      try {
        const r = await request('GET', imgPath({ hash, variant, ver }), { binary: true, timeoutMs: wcfg().imageTimeoutMs });
        if (r.ok && r.buf.length && /^image\//i.test(r.type)) return images.write(hash, variant, ver, r.buf);
      } catch (e) { /* offline or missing: fall through */ }
      imgFailUntil.set(key, clock() + 15000);
      return null;
    })().finally(() => imgInflight.delete(key));
    imgInflight.set(key, p);
    return p;
  }

  // ------------------------------------------------------------ settings helpers
  // cfg: {url, key} typed in the settings dialog (not necessarily saved yet). Uses the saved write token.
  async function testConnection(cfg) {
    const override = { url: String((cfg && cfg.url) || '').trim(), key: String((cfg && cfg.key) || '').trim() };
    const problem = configProblem(Object.assign({}, wcfg(), override));
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
    const hasToken = !!wcfg().writeToken;
    if (d.initialized && hasToken) {
      try {
        const t = await request('POST', '/items', { worker: override, write: true, json: { items: [] }, timeoutMs: 10000 });
        out.tokenOk = t.ok;
      } catch (_) { out.tokenOk = null; }
    }
    if (!d.initialized) out.message = 'ต่อ Worker ได้ แต่คีย์นี้ยังไม่ได้เริ่มใช้งาน ใส่ write token (ตั้งเองได้ 16 ตัวขึ้นไป) แล้วกด "เริ่มใช้งานคีย์ใหม่"';
    else if (!hasToken) out.message = 'เชื่อมต่อสำเร็จ (มีสินค้า ' + d.itemCount + ' ชิ้น) เครื่องนี้ดูได้อย่างเดียว ถ้าต้องการแก้ไขให้ใส่ write token';
    else if (out.tokenOk === false) out.message = MSG.badToken;
    else out.message = 'เชื่อมต่อสำเร็จ มีสินค้า ' + d.itemCount + ' ชิ้นบน Worker' + (hasToken ? ' write token ใช้ได้' : '');
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
    start, stop, syncNow, kick, setVisible, configChanged, getStatus, ensureImage, testConnection, initWorker,
    isConfigured, on: (ev, fn) => { emitter.on(ev, fn); }, off: (ev, fn) => { emitter.off(ev, fn); },
    // exposed for tests
    _cycle: cycle, _pull: pull, _push: push
  };
}

module.exports = { createSync, MSG, KEY_RE };
