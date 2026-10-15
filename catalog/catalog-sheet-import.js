'use strict';
// Import from the Google Sheet of the old "catalognew" web app (spec 9.2). Pure Node (no Electron) so it is testable;
// the caller passes fetchFn (electron net.fetch in the app).
//
// The sheet is published as CSV with ONE cell holding the whole catalog as JSON ({items:[{id,name,code,cat,img}],
// categories:[...]}), CSV-escaped ("" for "). img = https://i.ibb.co/... link (or, rarely, a dataURL).
// The sheet is only ever READ. Flow:
//   1. previewSheet(url)            -> counts for the confirmation dialog
//   2. importSheet({store, ...})    -> text data goes into the store at once; images come back as jobs:
//                                      dataURL images are staged in <dir>/import-tmp/ (same as catalog-migrate),
//                                      link images are fetched on demand with createImageFetcher (prefetching ahead).
// Re-import is idempotent: items match on legacyId ("sheet:<id>") first, then on code. An existing item only gets
// its EMPTY fields filled in (names/categories/images edited in the new app are never overwritten), and only items
// that still have no image get an image job, so running the import again resumes where a stopped one left off.
// The sheet URL is user config (import.sheetCsvUrl) — the repo is public, never hardcode it.
const fs = require('fs');
const path = require('path');
const migrate = require('./catalog-migrate');

const DEFAULT_CAT = migrate.DEFAULT_CAT;
const MAX_TEXT = 300; // same clamps as sanitize.js
const MAX_CAT = 60;
const MAX_CSV_BYTES = 20 * 1024 * 1024;
const MAX_URL = 2000;
const CHUNK = 500;

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const cleanName = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const tick = () => new Promise((r) => setImmediate(r));

function isHttpsUrl(s) {
  if (typeof s !== 'string' || !s || s.length > MAX_URL) return false;
  try { return new URL(s).protocol === 'https:'; } catch (_) { return false; }
}

// ------------------------------------------------------------------ parsing
/**
 * parseSheetCsv(text) -> { ok, data } | { ok:false, error }
 * trim -> strip the surrounding quotes -> "" -> " -> JSON.parse. Also accepts an unquoted cell (plain JSON).
 */
function parseSheetCsv(text) {
  let t = String(text == null ? '' : text);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  t = t.trim();
  if (!t) return { ok: false, error: 'ชีตว่างเปล่า ไม่มีข้อมูล' };
  if (/^\s*<(!doctype|html)/i.test(t)) return { ok: false, error: 'ลิงก์นี้ไม่ใช่ CSV (ได้หน้าเว็บกลับมา) ให้ใช้ลิงก์ "เผยแพร่ไปยังเว็บ" แบบ CSV' };
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') t = t.slice(1, -1).replace(/""/g, '"');
  let raw;
  try { raw = JSON.parse(t); } catch (_) { return { ok: false, error: 'อ่านข้อมูลในชีตไม่ได้ (ไม่ใช่ข้อมูลสินค้าที่ถูกต้อง)' }; }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return { ok: false, error: 'ไม่พบรายการสินค้าในชีตนี้' };
  return { ok: true, data: raw };
}

/**
 * normalizeSheet(raw) -> { items:[{legacyId,name,code,cat,img:{bytes,mime}|null,imgUrl}], categories, warnings, counts }
 * Never throws for odd content; rows without name AND code are dropped (warnings.invalid).
 */
function normalizeSheet(raw) {
  const warnings = { invalid: 0, dupIds: 0, badImage: 0, noId: 0, numericCodes: 0 };
  const byId = new Map();
  for (const r of Array.isArray(raw && raw.items) ? raw.items : []) {
    if (!r || typeof r !== 'object') { warnings.invalid++; continue; }
    if (typeof r.code === 'number') warnings.numericCodes++; // leading zeros already lost in the sheet
    const name = cleanName(r.name);
    const code = clip(r.code, MAX_TEXT);
    if (!name && !code) { warnings.invalid++; continue; }
    let id = r.id == null ? '' : String(r.id).trim();
    if (!id) { id = 'code-' + (code || name); warnings.noId++; }
    const legacyId = 'sheet:' + id;
    if (byId.has(legacyId)) warnings.dupIds++;
    let img = null;
    let imgUrl = null;
    const src = typeof r.img === 'string' ? r.img.trim() : '';
    if (src) {
      if (/^data:/i.test(src)) img = migrate.decodeDataUrl(src);
      else if (isHttpsUrl(src)) imgUrl = src;
      if (!img && !imgUrl) warnings.badImage++;
    }
    byId.set(legacyId, { legacyId, name: name || code, code, cat: clip(r.cat, MAX_CAT) || DEFAULT_CAT, img, imgUrl });
  }
  const items = Array.from(byId.values());
  const cats = [];
  const addCat = (c) => { const t = clip(c, MAX_CAT); if (t && !cats.includes(t)) cats.push(t); };
  (Array.isArray(raw && raw.categories) ? raw.categories : []).forEach((c) => { if (typeof c === 'string' || typeof c === 'number') addCat(c); });
  items.forEach((it) => addCat(it.cat));
  return {
    items, categories: cats, warnings,
    counts: {
      items: items.length, categories: cats.length,
      withImage: items.filter((i) => i.img || i.imgUrl).length,
      imageLinks: items.filter((i) => i.imgUrl).length,
      imageData: items.filter((i) => i.img).length
    }
  };
}

// ------------------------------------------------------------------ fetching
async function fetchWithTimeout(fetchFn, url, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await fetchFn(url, { signal: ctl.signal, redirect: 'follow' }); } finally { clearTimeout(t); }
}

async function readLimited(res, maxBytes) {
  const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (len && len > maxBytes) throw new Error('too large');
  const b = Buffer.from(await res.arrayBuffer());
  if (b.length > maxBytes) throw new Error('too large');
  return b;
}

// The published-CSV link answers with a 302 to *.googleusercontent.com; fetch follows it.
async function fetchSheet(url, o = {}) {
  if (!isHttpsUrl(url)) return { ok: false, error: 'ลิงก์ต้องขึ้นต้นด้วย https://' };
  try {
    const res = await fetchWithTimeout(o.fetchFn || fetch, url, o.timeoutMs || 30000);
    if (!res.ok) return { ok: false, error: 'โหลดชีตไม่สำเร็จ (HTTP ' + res.status + ') ตรวจว่าชีตยังเผยแพร่อยู่' };
    return { ok: true, text: (await readLimited(res, MAX_CSV_BYTES)).toString('utf8') };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'โหลดชีตไม่สำเร็จ (หมดเวลา) ตรวจอินเทอร์เน็ต' : 'โหลดชีตไม่สำเร็จ ตรวจอินเทอร์เน็ตและลิงก์' };
  }
}

async function loadSheet(o) {
  const text = typeof o.text === 'string' ? o.text : null;
  const got = text != null ? { ok: true, text } : await fetchSheet(o.url, o);
  if (!got.ok) return got;
  const parsed = parseSheetCsv(got.text);
  if (!parsed.ok) return parsed;
  return { ok: true, data: normalizeSheet(parsed.data) };
}

async function previewSheet(o) {
  const r = await loadSheet(o);
  if (!r.ok) return r;
  return { ok: true, counts: r.data.counts, warnings: r.data.warnings };
}

// ------------------------------------------------------------------ import
/**
 * importSheet({ store, dir, url|text, fetchFn, onProgress, shouldStop }) -> Promise<result>
 *   result: { ok, error?, summary:{added, updated, unchanged, skippedDeleted, skipped, total}, warnings, counts,
 *             jobs:[{itemId, legacyId, name, file?, url?, mime?}] }
 * file = staged dataURL image (read with migrate.readStaged), url = image link (download with createImageFetcher).
 */
async function importSheet(o) {
  const { store, dir } = o;
  const onProgress = o.onProgress || (() => {});
  const loaded = await loadSheet(o);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const data = loaded.data;

  // code matching prefers a live item; a deleted one only counts when no live item has that code (so a product
  // Boss deleted is not brought back by the import)
  const byLegacy = new Map();
  const byCode = new Map();
  const byCodeDeleted = new Map();
  for (const it of store.list({ includeDeleted: true })) {
    if (it.legacyId != null) byLegacy.set(String(it.legacyId), it);
    if (it.code) (it.deleted ? byCodeDeleted : byCode).set(it.code, it);
  }

  const summary = { added: 0, updated: 0, unchanged: 0, skippedDeleted: 0, skipped: data.warnings.invalid, total: data.items.length };
  const jobs = [];
  migrate.cleanupTmp(dir);
  let tmpMade = false;
  let seq = 0;
  const addJob = (itemId, it) => {
    if (it.img) {
      if (!tmpMade) { fs.mkdirSync(migrate.tmpDir(dir), { recursive: true }); tmpMade = true; }
      const file = (++seq) + '.img';
      fs.writeFileSync(path.join(migrate.tmpDir(dir), file), it.img.bytes);
      jobs.push({ itemId, legacyId: it.legacyId, name: it.name, file, mime: it.img.mime });
    } else if (it.imgUrl) {
      jobs.push({ itemId, legacyId: it.legacyId, name: it.name, url: it.imgUrl });
    }
  };

  // categories: the sheet's order first, then the ones already in the app (no duplicates)
  const meta = store.getMeta();
  const have = Array.isArray(meta.categories) ? meta.categories : [DEFAULT_CAT];
  const cats = data.categories.concat(have.filter((c) => !data.categories.includes(c)));
  if (cats.length !== have.length || cats.some((c, i) => c !== have[i])) store.setMeta({ categories: cats });

  let done = 0;
  for (let i = 0; i < data.items.length; i += CHUNK) {
    if (o.shouldStop && o.shouldStop()) break;
    const batch = [];
    const fresh = []; // sheet rows of the new items, in batch order
    for (const it of data.items.slice(i, i + CHUNK)) {
      const cur = byLegacy.get(it.legacyId) || (it.code ? byCode.get(it.code) || byCodeDeleted.get(it.code) : null);
      if (cur && cur.deleted) { summary.skippedDeleted++; continue; }
      if (cur) {
        const patch = {};
        if (!cur.name) patch.name = it.name;
        if (!cur.code && it.code) patch.code = it.code;
        if (cur.legacyId == null) patch.legacyId = it.legacyId;
        if (it.imgUrl && !cur.legacyImageUrl) patch.legacyImageUrl = it.imgUrl;
        if (Object.keys(patch).length) { batch.push(Object.assign({ id: cur.id }, patch)); summary.updated++; } else summary.unchanged++;
        if (!cur.image) addJob(cur.id, it);
        continue;
      }
      const item = { name: it.name, shortName: '', code: it.code, cat: it.cat, fav: false, barcodes: [], tags: [], image: null, legacyId: it.legacyId };
      if (it.imgUrl) item.legacyImageUrl = it.imgUrl;
      batch.push(item);
      fresh.push(it);
      summary.added++;
    }
    const saved = batch.length ? store.putMany(batch) : [];
    let k = 0;
    for (let b = 0; b < batch.length; b++) {
      if (batch[b].id) continue;
      const it = fresh[k++];
      byLegacy.set(it.legacyId, saved[b]);
      if (it.code) byCode.set(it.code, saved[b]);
      addJob(saved[b].id, it);
    }
    done += Math.min(CHUNK, data.items.length - i);
    onProgress({ phase: 'text', done, total: data.items.length });
    await tick();
  }
  store.flush();
  return { ok: true, summary, warnings: data.warnings, counts: data.counts, jobs };
}

// ------------------------------------------------------------------ image downloads
// Starts up to `concurrency` downloads ahead of the one asked for, so the (sequential) OpenCV step never waits long.
// get(i) -> Promise<{ ok:true, bytes, mime } | { ok:false, error }>. Only URLs from `urls` (the job list made in the main
// process) are ever fetched — the renderer passes an index, never a URL.
function createImageFetcher(urls, o = {}) {
  const fetchFn = o.fetchFn || fetch;
  const concurrency = Math.max(1, Math.min(8, o.concurrency || 4));
  const timeoutMs = o.timeoutMs || 30000;
  const maxBytes = o.maxBytes || 15 * 1024 * 1024;
  const pending = new Map();

  async function download(url) {
    if (!isHttpsUrl(url)) return { ok: false, error: 'bad url' };
    try {
      const res = await fetchWithTimeout(fetchFn, url, timeoutMs);
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      const bytes = await readLimited(res, maxBytes);
      const mime = sniffImage(bytes);
      if (!mime) return { ok: false, error: 'not an image' };
      return { ok: true, bytes, mime };
    } catch (e) {
      return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : String(e && e.message || e) };
    }
  }

  function start(i) {
    if (i < 0 || i >= urls.length || pending.has(i) || !urls[i]) return;
    pending.set(i, download(urls[i]));
  }

  async function get(i) {
    if (!Number.isInteger(i) || i < 0 || i >= urls.length || !urls[i]) return { ok: false, error: 'no such image' };
    for (let j = i; j < i + concurrency; j++) start(j);
    const r = await pending.get(i);
    pending.delete(i);
    return r;
  }

  return { get };
}

function sniffImage(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return null;
}

module.exports = {
  parseSheetCsv, normalizeSheet, fetchSheet, previewSheet, importSheet, createImageFetcher, sniffImage, isHttpsUrl
};
