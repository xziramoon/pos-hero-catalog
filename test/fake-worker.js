'use strict';
// In-memory stand-in for the catalog Worker (just enough of the contract) for offline unit tests.
// Not a *.test.js file, so test/run-all.js does not run it.
const { isNewer, exceedsSkew } = require('../catalog/shared/merge');

function createFakeWorker(o = {}) {
  const w = {
    items: new Map(), rev: 0, meta: null, initialized: o.initialized !== false,
    token: o.token || 'T'.repeat(20), imgs: new Map(), horizonRev: 0,
    clockSkewMs: 0,          // server clock = Date.now() + clockSkewMs
    log: [],                 // {method, rest, headers, redirect}
    failures: [],            // {test(method, rest), status, times}
    rejectIds: new Map(),    // id -> reason (permanent rejection)
    imgDelayMs: 0, imgActive: 0, imgMaxActive: 0, imgGets: 0,
    imgBody: null,           // override GET /img body: {buf, contentLength}
    now: () => Date.now() + w.clockSkewMs
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const resp = (status, data) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: () => null },
    text: async () => JSON.stringify(data),
    arrayBuffer: async () => new ArrayBuffer(0)
  });

  w.reset = () => { w.items.clear(); w.rev = 0; w.meta = null; w.imgs.clear(); w.horizonRev = 0; };
  w.itemCount = () => Array.from(w.items.values()).filter((i) => !i.deleted).length;
  w.seed = (item) => { w.rev += 1; w.items.set(item.id, Object.assign({}, item, { rev: w.rev })); };

  w.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const m = u.pathname.match(/^\/catalog\/[^/]+(\/.*)$/);
    const rest = m ? m[1] : u.pathname;
    const method = init.method || 'GET';
    w.log.push({ method, rest, headers: Object.assign({}, init.headers), redirect: init.redirect, host: u.host });
    const f = w.failures.find((x) => x.times !== 0 && x.test(method, rest));
    if (f) { if (f.times > 0) f.times--; if (f.status === 'throw') throw new TypeError('fetch failed'); return resp(f.status, { error: 'x', message: 'fail' }); }
    const writeOk = () => (init.headers || {})['X-Catalog-Write'] === w.token && w.initialized;

    if (rest === '/health') return resp(200, { ok: true, rev: w.rev, itemCount: w.itemCount(), initialized: w.initialized, serverTime: w.now() });
    if (rest === '/init' && method === 'POST') {
      if (w.initialized) return resp(409, { error: 'already_initialized' });
      w.initialized = true; w.token = init.headers['X-Catalog-Write'];
      return resp(200, { ok: true, rev: w.rev, serverTime: w.now() });
    }
    if (rest === '/changes') {
      const since = Number(u.searchParams.get('since')) || 0;
      if (since > w.rev || (since > 0 && since < w.horizonRev)) return resp(200, { resetRequired: true, items: [], rev: w.rev, more: false, serverTime: w.now() });
      const rows = Array.from(w.items.values()).filter((i) => i.rev > since).sort((a, b) => a.rev - b.rev);
      const out = { items: rows, rev: w.rev, more: false, serverTime: w.now() };
      if (w.meta && w.meta.rev > since) out.meta = w.meta;
      return resp(200, out);
    }
    if (rest === '/items' && method === 'POST') {
      if (!writeOk()) return resp(401, { error: 'unauthorized' });
      const body = JSON.parse(init.body);
      const now = w.now();
      for (const it of body.items) if (exceedsSkew(it.updatedAt, now)) return resp(409, { error: 'clock_skew', serverTime: now });
      const accepted = [], rejected = [];
      for (const it of body.items) {
        if (w.rejectIds.has(it.id)) { rejected.push({ id: it.id, reason: w.rejectIds.get(it.id) }); continue; }
        const cur = w.items.get(it.id);
        if (cur && cur.updatedAt === it.updatedAt && cur.updatedBy === it.updatedBy) { accepted.push({ id: it.id, rev: cur.rev }); continue; }
        if (cur && !isNewer(it, cur)) { rejected.push({ id: it.id, reason: 'stale', current: cur }); continue; }
        w.rev += 1; w.items.set(it.id, Object.assign({}, it, { rev: w.rev })); accepted.push({ id: it.id, rev: w.rev });
      }
      return resp(200, { accepted, rejected, rev: w.rev, serverTime: now });
    }
    if (rest === '/meta' && method === 'PUT') {
      if (!writeOk()) return resp(401, { error: 'unauthorized' });
      const body = JSON.parse(init.body);
      const now = w.now();
      if (exceedsSkew(body.updatedAt, now)) return resp(409, { error: 'clock_skew', serverTime: now });
      if (w.meta && w.meta.updatedAt > body.updatedAt) return resp(409, { error: 'stale', meta: w.meta });
      w.rev += 1; w.meta = Object.assign({}, body, { rev: w.rev });
      return resp(200, { ok: true, meta: w.meta, serverTime: now });
    }
    const im = rest.match(/^\/img\/([^/]+)\/([^/]+)$/);
    if (im) {
      const k = im[1] + '/' + im[2];
      if (method === 'PUT') {
        if (!writeOk()) return resp(401, { error: 'unauthorized' });
        w.imgs.set(k, Buffer.from(init.body));
        return resp(200, { ok: true });
      }
      w.imgGets++;
      w.imgActive++; w.imgMaxActive = Math.max(w.imgMaxActive, w.imgActive);
      try {
        if (w.imgDelayMs) await sleep(w.imgDelayMs);
        const buf = w.imgBody ? w.imgBody.buf : w.imgs.get(k);
        if (!buf) return resp(404, { error: 'not_found' });
        const cl = w.imgBody && w.imgBody.contentLength != null ? String(w.imgBody.contentLength) : null;
        return {
          ok: true, status: 200,
          headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : h.toLowerCase() === 'content-length' ? cl : null) },
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
          text: async () => ''
        };
      } finally { w.imgActive--; }
    }
    return resp(404, { error: 'not_found' });
  };
  return w;
}

module.exports = { createFakeWorker };
