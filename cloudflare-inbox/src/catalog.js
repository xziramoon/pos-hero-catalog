// Catalog Hero sync on Cloudflare: Durable Object `Catalog` (SQLite) + R2 images.
// Spec: docs/CATALOG_HERO_SPEC.md section 5, contracts: docs/catalog-contracts.md
//
//   GET  /catalog/{key}/health
//   POST /catalog/{key}/init                  header X-Catalog-Write: <token>  (first time only, else 409)
//   GET  /catalog/{key}/changes?since=&limit=
//   POST /catalog/{key}/items                 {items:[...]} <= 200, needs write token
//   PUT  /catalog/{key}/meta                  needs write token
//   PUT  /catalog/{key}/img/{hash}/{variant}  needs write token; variant = orig | thumb[-vN] | full[-vN]
//   GET  /catalog/{key}/img/{hash}/{variant}
//   GET  /catalog/{key}/export

import merge from '../../catalog/shared/merge.js';

const { MAX_FUTURE_SKEW_MS, mergeItem, exceedsSkew, normalizeItem, validateItem } = merge;

const CATALOG_PATH_RE = /^\/catalog\/([A-Za-z0-9_-]{32,128})(\/.*)?$/;
const HASH_RE = /^[A-Za-z0-9_-]{8,128}$/;
const VARIANT_RE = /^(orig|(?:thumb|full)(?:-v\d{1,9})?)$/;
const VERSIONED_RE = /^(?:thumb|full)-v\d+$/;
const MAX_ITEMS_PER_POST = 200;
const MAX_ITEM_JSON = 64 * 1024;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_CHANGES_LIMIT = 500;
const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const PURGE_EVERY_MS = 60 * 60 * 1000;
const DEFAULT_CAT = 'ทั่วไป';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Catalog-Write'
};
const json = (data, status = 200, extra) => new Response(JSON.stringify(data), {
  status,
  headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS, extra)
});
const err = (status, error, message, extra) => json(Object.assign({ error, message }, extra), status);

async function sha256Hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Called from index.js before the inbox routing. Returns a Response, or null if not a catalog path.
export async function handleCatalogRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== '/catalog' && !url.pathname.startsWith('/catalog/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: Object.assign({ 'Access-Control-Max-Age': '86400' }, CORS) });
  const m = url.pathname.match(CATALOG_PATH_RE);
  if (!m) return err(400, 'invalid_key', 'Catalog Key ต้องยาว 32-128 ตัว ใช้ A-Z a-z 0-9 _ - เท่านั้น');
  if (!env.CATALOG) return err(500, 'not_configured', 'Worker ยังไม่ได้ผูก Durable Object CATALOG');
  return env.CATALOG.get(env.CATALOG.idFromName(m[1])).fetch(request);
}

export class Catalog {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, rev INTEGER, updated_at INTEGER, updated_by TEXT, deleted INTEGER, data TEXT)');
    // written_at = server time of the last write (tombstone retention must not trust client clocks)
    if (!this.sql.exec('PRAGMA table_info(items)').toArray().some(c => c.name === 'written_at')) {
      this.sql.exec('ALTER TABLE items ADD COLUMN written_at INTEGER');
      this.sql.exec('UPDATE items SET written_at = ?', Date.now());
    }
    this.sql.exec('CREATE INDEX IF NOT EXISTS items_rev ON items(rev)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
  }

  // ---- kv helpers ----
  kvGet(k) {
    const row = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    return row ? row.v : null;
  }
  kvSet(k, v) { this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, String(v)); }
  currentRev() { return Number(this.kvGet('rev')) || 0; }
  nextRev() { const r = this.currentRev() + 1; this.kvSet('rev', r); return r; }
  getMeta() { const v = this.kvGet('meta'); return v ? JSON.parse(v) : null; }
  itemCount() { return this.sql.exec('SELECT COUNT(*) AS n FROM items WHERE deleted = 0').one().n; }

  async fetch(request) {
    const url = new URL(request.url);
    const m = url.pathname.match(CATALOG_PATH_RE);
    const key = m[1];
    const rest = m[2] || '/';
    const method = request.method;
    try {
      const res = await this.route(request, url, key, rest, method);
      // Replying before the request body was read can abort the stream on the runtime; drain it first.
      const declared = Number(request.headers.get('Content-Length'));
      if (request.body && !request.bodyUsed) {
        if (declared > 0 && declared <= MAX_IMAGE + 65536) await request.arrayBuffer().catch(() => {});
        else await request.body.cancel().catch(() => {});
      }
      return res;
    } catch (e) {
      console.log('[catalog] error', (e && e.stack) || e);
      return err(500, 'internal', 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์ ลองใหม่อีกครั้ง');
    }
  }

  async route(request, url, key, rest, method) {
      this.maybePurge();
      if (rest === '/health' && method === 'GET') return this.health();
      if (rest === '/init' && method === 'POST') return await this.init(request);
      if (rest === '/changes' && method === 'GET') return this.changes(url.searchParams);
      if (rest === '/items' && method === 'POST') return await this.postItems(request);
      if (rest === '/meta' && method === 'PUT') return await this.putMeta(request);
      if (rest === '/export' && method === 'GET') return this.exportAll();
      const im = rest.match(/^\/img\/([^/]+)\/([^/]+)$/);
      if (im) {
        if (!HASH_RE.test(im[1]) || !VARIANT_RE.test(im[2])) return err(400, 'bad_image_path', 'hash หรือ variant ไม่ถูกต้อง (orig, thumb-vN, full-vN)');
        const r2key = (await sha256Hex(key)) + '/' + im[1] + '/' + im[2] + '.jpg';
        if (method === 'PUT') return await this.putImage(request, r2key, im[2]);
        if (method === 'GET') return await this.getImage(r2key, im[2]);
        return err(405, 'method_not_allowed', 'ใช้ GET หรือ PUT เท่านั้น');
      }
      return err(404, 'not_found', 'ไม่พบ endpoint นี้ หรือใช้ method ไม่ถูกต้อง');
  }

  async bodyOrError(request) {
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return { res: err(413, 'too_large', 'ข้อมูลใหญ่เกินไป') };
      return { body: JSON.parse(text) };
    } catch (e) {
      return { res: err(400, 'bad_json', 'อ่าน JSON ไม่ได้') };
    }
  }

  // Returns a Response on failure, null when the write token is valid.
  async requireWrite(request) {
    const token = request.headers.get('X-Catalog-Write');
    const stored = this.kvGet('writeTokenHash');
    if (!token || !stored) return err(401, 'unauthorized', 'ต้องมี write token (ตั้งค่าด้วย init ก่อน)');
    if (!safeEqual(await sha256Hex(token), stored)) return err(401, 'unauthorized', 'write token ไม่ถูกต้อง');
    return null;
  }

  health() {
    return json({ ok: true, rev: this.currentRev(), itemCount: this.itemCount(), initialized: !!this.kvGet('writeTokenHash'), serverTime: Date.now() });
  }

  async init(request) {
    let token = request.headers.get('X-Catalog-Write');
    if (!token) {
      const { body } = await this.bodyOrError(request);
      if (body && typeof body.writeToken === 'string') token = body.writeToken;
    }
    if (!token || token.length < 16 || token.length > 256) return err(400, 'bad_token', 'write token ต้องยาว 16-256 ตัวอักษร (ส่งใน header X-Catalog-Write)');
    const hash = await sha256Hex(token);
    // check-and-set with no await in between, so concurrent inits cannot both succeed
    if (this.kvGet('writeTokenHash')) return err(409, 'already_initialized', 'Catalog Key นี้ตั้ง write token ไว้แล้ว');
    this.kvSet('writeTokenHash', hash);
    if (!this.kvGet('schemaVersion')) this.kvSet('schemaVersion', 1);
    return json({ ok: true, rev: this.currentRev(), serverTime: Date.now() });
  }

  changes(params) {
    const since = Math.max(0, Math.floor(Number(params.get('since')) || 0));
    const limit = Math.min(MAX_CHANGES_LIMIT, Math.max(1, Math.floor(Number(params.get('limit')) || MAX_CHANGES_LIMIT)));
    const rev = this.currentRev();
    const serverTime = Date.now();
    const horizon = Number(this.kvGet('tombstoneHorizonRev')) || 0;
    if (since > rev || (since > 0 && since < horizon)) return json({ resetRequired: true, items: [], rev, more: false, serverTime });
    const rows = this.sql.exec('SELECT data, rev FROM items WHERE rev > ? ORDER BY rev LIMIT ?', since, limit + 1).toArray();
    const more = rows.length > limit;
    if (more) rows.pop();
    const items = rows.map(r => Object.assign(JSON.parse(r.data), { rev: r.rev }));
    const out = { items, rev: more ? rows[rows.length - 1].rev : rev, more, serverTime };
    const meta = this.getMeta();
    if (meta && meta.rev > since) out.meta = meta;
    return json(out);
  }

  async postItems(request) {
    const denied = await this.requireWrite(request);
    if (denied) return denied;
    const { body, res } = await this.bodyOrError(request);
    if (res) return res;
    if (!body || !Array.isArray(body.items)) return err(400, 'bad_body', 'ต้องส่ง {items:[...]}');
    if (body.items.length > MAX_ITEMS_PER_POST) return err(400, 'too_many_items', `ส่งได้สูงสุด ${MAX_ITEMS_PER_POST} ชิ้นต่อครั้ง`);
    const now = Date.now();
    const incoming = [];
    const rejected = [];
    for (const raw of body.items) {
      const item = normalizeItem(raw);
      const bad = validateItem(item);
      if (bad) { rejected.push({ id: item.id || null, reason: bad }); continue; }
      if (exceedsSkew(item.updatedAt, now)) {
        return err(409, 'clock_skew', 'นาฬิกาเครื่องนี้เร็วกว่าเซิร์ฟเวอร์เกินไป ปรับเวลาแล้วส่งใหม่', { serverTime: now, maxFutureSkewMs: MAX_FUTURE_SKEW_MS });
      }
      delete item.rev;
      if (JSON.stringify(item).length > MAX_ITEM_JSON) { rejected.push({ id: item.id, reason: 'too_large' }); continue; }
      incoming.push(item);
    }
    const accepted = [];
    this.ctx.storage.transactionSync(() => {
      for (const item of incoming) {
        const row = this.sql.exec('SELECT data, rev FROM items WHERE id = ?', item.id).toArray()[0];
        if (row) {
          const current = Object.assign(JSON.parse(row.data), { rev: row.rev });
          // Exact resend (outbox retry): acknowledge without bumping rev.
          const sameStamp = current.updatedAt === item.updatedAt && current.updatedBy === item.updatedBy;
          if (sameStamp) {
            const { rev: _r, ...stored } = current;
            const a = JSON.stringify(stored), b = JSON.stringify(item);
            if (a === b) { accepted.push({ id: item.id, rev: row.rev }); continue; }
            // same timestamp + device, different content: deterministic tie-break on serialized data
            if (b < a) { rejected.push({ id: item.id, reason: 'stale', current }); continue; }
          } else if (mergeItem(current, item) !== item) { rejected.push({ id: item.id, reason: 'stale', current }); continue; }
        }
        const rev = this.nextRev();
        this.sql.exec('INSERT OR REPLACE INTO items (id, rev, updated_at, updated_by, deleted, data, written_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          item.id, rev, item.updatedAt, item.updatedBy, item.deleted ? 1 : 0, JSON.stringify(item), now);
        accepted.push({ id: item.id, rev });
      }
    });
    return json({ accepted, rejected, rev: this.currentRev(), serverTime: now });
  }

  async putMeta(request) {
    const denied = await this.requireWrite(request);
    if (denied) return denied;
    const { body, res } = await this.bodyOrError(request);
    if (res) return res;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return err(400, 'bad_body', 'ต้องส่ง object ของ meta');
    const now = Date.now();
    const updatedAt = Number(body.updatedAt) || now;
    if (exceedsSkew(updatedAt, now)) return err(409, 'clock_skew', 'นาฬิกาเครื่องนี้เร็วกว่าเซิร์ฟเวอร์เกินไป ปรับเวลาแล้วส่งใหม่', { serverTime: now, maxFutureSkewMs: MAX_FUTURE_SKEW_MS });
    const current = this.getMeta();
    if (current && current.updatedAt > updatedAt) return err(409, 'stale', 'meta บนเซิร์ฟเวอร์ใหม่กว่า ดึงข้อมูลล่าสุดก่อน', { meta: current, serverTime: now });
    let categories = Array.isArray(body.categories) ? body.categories.map(String).filter(Boolean) : (current ? current.categories : []);
    categories = Array.from(new Set(categories));
    if (!categories.includes(DEFAULT_CAT)) categories.unshift(DEFAULT_CAT);
    const meta = {
      categories,
      shopName: typeof body.shopName === 'string' ? body.shopName : (current ? current.shopName : ''),
      schemaVersion: 1,
      updatedAt,
      rev: this.nextRev()
    };
    this.kvSet('meta', JSON.stringify(meta));
    return json({ ok: true, meta, serverTime: now });
  }

  async putImage(request, r2key, variant) {
    const denied = await this.requireWrite(request);
    if (denied) return denied;
    if (!this.env.CATALOG_IMAGES) return err(500, 'no_r2', 'Worker ยังไม่ได้ผูก R2 bucket CATALOG_IMAGES');
    const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'image/jpeg' && type !== 'image/webp') return err(415, 'bad_content_type', 'รับเฉพาะ image/jpeg หรือ image/webp');
    const declared = Number(request.headers.get('Content-Length'));
    if (declared > MAX_IMAGE) return err(413, 'too_large', 'รูปใหญ่เกิน 5MB');
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_IMAGE) return err(413, 'too_large', 'รูปใหญ่เกิน 5MB');
    if (!bytes.byteLength) return err(400, 'empty', 'ไม่มีข้อมูลรูป');
    await this.env.CATALOG_IMAGES.put(r2key, bytes, { httpMetadata: { contentType: type } });
    return json({ ok: true, size: bytes.byteLength, variant });
  }

  async getImage(r2key, variant) {
    if (!this.env.CATALOG_IMAGES) return err(500, 'no_r2', 'Worker ยังไม่ได้ผูก R2 bucket CATALOG_IMAGES');
    const obj = await this.env.CATALOG_IMAGES.get(r2key);
    if (!obj) return err(404, 'not_found', 'ไม่พบรูปนี้');
    // orig and versioned thumb/full never change; an unversioned thumb/full may be replaced.
    const immutable = variant === 'orig' || VERSIONED_RE.test(variant);
    return new Response(obj.body, {
      headers: Object.assign({
        'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg',
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        ETag: obj.httpEtag
      }, CORS)
    });
  }

  exportAll() {
    const items = this.sql.exec('SELECT data, rev FROM items ORDER BY rev').toArray()
      .map(r => Object.assign(JSON.parse(r.data), { rev: r.rev }));
    return json({ exportedAt: Date.now(), rev: this.currentRev(), meta: this.getMeta(), items }, 200, {
      'Content-Disposition': 'attachment; filename="catalog-export.json"'
    });
  }

  // Drop tombstones older than 90 days (at most hourly) and remember the horizon rev.
  maybePurge() {
    const now = Date.now();
    if (now - (Number(this.kvGet('lastPurge')) || 0) < PURGE_EVERY_MS) return;
    this.kvSet('lastPurge', now);
    const cutoff = now - TOMBSTONE_RETENTION_MS;
    const top = this.sql.exec('SELECT MAX(rev) AS r FROM items WHERE deleted = 1 AND written_at < ?', cutoff).one().r;
    if (top == null) return;
    this.sql.exec('DELETE FROM items WHERE deleted = 1 AND written_at < ?', cutoff);
    const horizon = Number(this.kvGet('tombstoneHorizonRev')) || 0;
    if (top > horizon) this.kvSet('tombstoneHorizonRev', top);
  }
}
