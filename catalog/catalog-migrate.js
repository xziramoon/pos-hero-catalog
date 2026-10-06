'use strict';
// Import from the legacy "Catalog Hero" app (spec section 9). Pure Node (no Electron) so it is testable.
//
// Legacy file `catalog-data.json`: { items:[{id,name,code,cat,img}], categories:[...], favoriteIds:[...], shopName, auth }
//   id  numeric from Date.now() (sometimes a string), img = dataURL (JPEG <= 500px) or '' , auth = scrypt record.
// The legacy file is only ever READ. Flow:
//   1. findCandidates()            -> where catalog-data.json might be
//   2. readLegacy(file)            -> lenient parse + normalize (+ counted warnings)
//   3. importLegacy({store, ...})  -> text data goes into the store at once (fast); images are staged as files in
//                                     <dir>/import-tmp/ and returned as jobs. The renderer runs each job through the
//                                     OpenCV worker (CatalogPhotoEditor.processFile) and then saveImage().
//   4. cleanupTmp(dir)             -> remove the staged images.
// Re-import is idempotent: items are matched on `legacyId` and updated instead of duplicated.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CAT = 'ทั่วไป';
const LEGACY_FILE = 'catalog-data.json';
const MAX_FILE_BYTES = 1024 * 1024 * 1024; // refuse silly sizes (legacy files are JSON with embedded 500px JPEGs)
const MAX_TEXT = 300;   // same clamps as sanitize.js (the Worker enforces them too)
const MAX_CAT = 60;
const MAX_SHOP = 120;
const CHUNK = 500;      // items per store.putMany (keeps the event loop responsive, one 'changed' per chunk)
const SYNC_CONFIG_NAMES = ['sync-config.json', 'syncConfig.json'];

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// ------------------------------------------------------------------ discovery
function statOf(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? { path: p, size: st.size, mtime: st.mtimeMs } : null;
  } catch (_) { return null; }
}

// Every string value (depth <= 3) of the legacy sync-config.json that could be a folder or a file path.
function pathStrings(obj, depth = 0, out = []) {
  if (obj == null || depth > 3) return out;
  if (typeof obj === 'string') { if (obj.length > 2 && obj.length < 600) out.push(obj); return out; }
  if (Array.isArray(obj)) { obj.forEach((v) => pathStrings(v, depth + 1, out)); return out; }
  if (typeof obj === 'object') Object.keys(obj).forEach((k) => pathStrings(obj[k], depth + 1, out));
  return out;
}

/**
 * findCandidates({ appData, extraDirs }) -> [{ path, size, mtime, source:'appdata'|'shared'|'extra' }]
 * appData = %APPDATA% (the folder that contains "Catalog Hero"). Lenient: the shared folder can be named under any key
 * of sync-config.json (folder / sharedFolder / path / ...), and may point at the folder or at the json file itself.
 */
function findCandidates(o = {}) {
  const found = [];
  const seen = new Set();
  const add = (p, source) => {
    if (!p) return;
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return;
    const st = statOf(p);
    if (!st) return;
    seen.add(key);
    found.push(Object.assign(st, { source }));
  };
  const appData = o.appData || process.env.APPDATA || '';
  const dirs = [];
  if (appData) dirs.push(path.join(appData, 'Catalog Hero'));
  for (const d of o.extraDirs || []) dirs.push(d);
  for (const dir of dirs) {
    add(path.join(dir, LEGACY_FILE), dir === dirs[0] && appData ? 'appdata' : 'extra');
    for (const name of SYNC_CONFIG_NAMES) {
      let cfg = null;
      try { cfg = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (_) { /* absent or unreadable */ }
      if (!cfg) continue;
      for (const s of pathStrings(cfg)) {
        if (/^https?:/i.test(s)) continue;
        if (/\.json$/i.test(s)) add(s, 'shared');
        add(path.join(s, LEGACY_FILE), 'shared');
      }
    }
  }
  return found;
}

// ------------------------------------------------------------------ parsing
function emptyWarnings() { return { badImage: 0, dupIds: 0, invalid: 0, noId: 0, numericCodes: 0 }; }

// 'data:image/jpeg;base64,....' -> Buffer, or null when it is not a decodable-looking image.
function decodeDataUrl(s) {
  if (typeof s !== 'string' || s.length < 40) return null;
  const m = /^data:(image\/(?:jpeg|jpg|png|webp|gif|bmp));base64,/i.exec(s);
  if (!m) return null;
  let b;
  try { b = Buffer.from(s.slice(m[0].length), 'base64'); } catch (_) { return null; }
  if (b.length < 20) return null;
  const jpg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const webp = b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';
  const gif = b.toString('latin1', 0, 3) === 'GIF';
  const bmp = b[0] === 0x42 && b[1] === 0x4d;
  if (!(jpg || png || webp || gif || bmp)) return null;
  return { bytes: b, mime: m[1].toLowerCase().replace('jpg', 'jpeg') };
}

// Stable fallback id for legacy items that have no id at all.
function fallbackId(name, code) {
  return 'h' + crypto.createHash('sha1').update(name + '\u0000' + code).digest('hex').slice(0, 12);
}

/**
 * normalizeLegacy(raw) -> { items:[{legacyId,name,code,cat,fav,img:{bytes,mime}|null,hadImg}], categories, shopName, auth,
 *                           warnings, counts:{items, withImage, categories, favorites} }
 * Never throws for odd content; items without name AND code are dropped (warning.invalid).
 */
function normalizeLegacy(raw) {
  const warnings = emptyWarnings();
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const favSet = new Set((Array.isArray(data.favoriteIds) ? data.favoriteIds : []).filter((x) => x != null).map(String));
  const rawItems = Array.isArray(data.items) ? data.items : [];
  const byId = new Map(); // legacyId -> item (later duplicates win, like a Map-based legacy loader)
  rawItems.forEach((r) => {
    if (!r || typeof r !== 'object') { warnings.invalid++; return; }
    if (typeof r.code === 'number') warnings.numericCodes++;
    const name = clip(r.name, MAX_TEXT);
    const code = clip(r.code, MAX_TEXT);
    if (!name && !code) { warnings.invalid++; return; }
    let legacyId = r.id == null || r.id === '' ? '' : String(r.id).trim();
    if (!legacyId) { legacyId = fallbackId(name, code); warnings.noId++; }
    if (byId.has(legacyId)) warnings.dupIds++;
    const cat = clip(r.cat, MAX_CAT) || DEFAULT_CAT;
    let img = null;
    const hadImg = typeof r.img === 'string' && r.img.length > 0;
    if (hadImg) {
      img = decodeDataUrl(r.img);
      if (!img) warnings.badImage++;
    }
    byId.set(legacyId, { legacyId, name: name || code, code, cat, fav: favSet.has(legacyId), img, hadImg });
  });
  const items = Array.from(byId.values());
  const cats = [DEFAULT_CAT];
  const addCat = (c) => { const t = clip(c, MAX_CAT); if (t && !cats.includes(t)) cats.push(t); };
  (Array.isArray(data.categories) ? data.categories : []).forEach((c) => { if (typeof c === 'string' || typeof c === 'number') addCat(c); });
  items.forEach((it) => addCat(it.cat));
  return {
    items, categories: cats, shopName: clip(data.shopName, MAX_SHOP),
    auth: data.auth && typeof data.auth === 'object' ? data.auth : null,
    warnings,
    counts: {
      items: items.length, withImage: items.filter((i) => i.img).length, categories: cats.length,
      favorites: items.filter((i) => i.fav).length
    }
  };
}

// Reads + parses the legacy file (read-only). -> { ok, error?, data? }
function readLegacy(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { ok: false, error: 'ไม่ใช่ไฟล์' };
    if (st.size > MAX_FILE_BYTES) return { ok: false, error: 'ไฟล์ใหญ่เกินไป' };
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    let raw;
    try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: 'อ่านไฟล์ไม่ได้ (ไม่ใช่ JSON ที่ถูกต้อง)' }; }
    if (!raw || typeof raw !== 'object' || (!Array.isArray(raw.items) && !Array.isArray(raw))) {
      return { ok: false, error: 'ไฟล์นี้ไม่ใช่ข้อมูล Catalog Hero (ไม่พบรายการสินค้า)' };
    }
    return { ok: true, data: normalizeLegacy(Array.isArray(raw) ? { items: raw } : raw) };
  } catch (e) {
    return { ok: false, error: 'เปิดไฟล์ไม่ได้: ' + (e && e.message || e) };
  }
}

// Counts only (no image bytes kept) for the confirmation dialog.
function previewLegacy(file) {
  const r = readLegacy(file);
  if (!r.ok) return r;
  const d = r.data;
  return { ok: true, counts: d.counts, warnings: d.warnings, shopName: d.shopName, hasAuth: !!d.auth };
}

// ------------------------------------------------------------------ import
function tmpDir(dir) { return path.join(dir, 'import-tmp'); }

function cleanupTmp(dir) {
  try { fs.rmSync(tmpDir(dir), { recursive: true, force: true }); } catch (e) { console.warn('[catalog] import-tmp cleanup failed:', e.message); }
}

const tick = () => new Promise((r) => setImmediate(r));

/**
 * importLegacy({ store, dir, file, onProgress, shouldStop }) -> Promise<result>
 *   result: { ok, error?, summary:{added, updated, unchanged, skippedDeleted, skipped, total},
 *             warnings, counts, jobs:[{itemId, legacyId, name, file}], shopName, authSaved }
 * - text data is written first; images become `jobs` (staged in <dir>/import-tmp/<n>.img). Only items that have NO image yet
 *   get a job (so an interrupted import resumes, and an image edited in the new app is never overwritten by the old one).
 * - an item deleted in the new app stays deleted (counted in skippedDeleted).
 * - the legacy file is never written.
 */
async function importLegacy(o) {
  const { store, dir, file } = o;
  const onProgress = o.onProgress || (() => {});
  const read = readLegacy(file);
  if (!read.ok) return { ok: false, error: read.error };
  const data = read.data;

  // legacyId -> existing item (including tombstones)
  const byLegacy = new Map();
  for (const it of store.list({ includeDeleted: true })) if (it.legacyId != null) byLegacy.set(String(it.legacyId), it);

  const summary = { added: 0, updated: 0, unchanged: 0, skippedDeleted: 0, skipped: data.warnings.invalid, total: data.items.length };
  const jobs = [];
  cleanupTmp(dir);
  let tmpMade = false;
  let jobSeq = 0;
  const stage = (itemId, it) => {
    if (!it.img) return;
    if (!tmpMade) { fs.mkdirSync(tmpDir(dir), { recursive: true }); tmpMade = true; }
    const name = (++jobSeq) + '.img';
    fs.writeFileSync(path.join(tmpDir(dir), name), it.img.bytes);
    jobs.push({ itemId, legacyId: it.legacyId, name: it.name, file: name, mime: it.img.mime });
  };

  // meta first (so the legacy category order leads): union of categories, shopName only when none is set yet
  const meta = store.getMeta();
  const cats = Array.isArray(meta.categories) ? meta.categories.slice() : [DEFAULT_CAT];
  let metaChanged = false;
  for (const c of data.categories) if (!cats.includes(c)) { cats.push(c); metaChanged = true; }
  const patch = {};
  if (metaChanged) patch.categories = cats;
  if (data.shopName && !clip(meta.shopName, MAX_SHOP)) patch.shopName = data.shopName;
  if (Object.keys(patch).length) store.setMeta(patch);

  let done = 0;
  for (let i = 0; i < data.items.length; i += CHUNK) {
    if (o.shouldStop && o.shouldStop()) break;
    const batch = [];
    const staged = []; // [legacy item, existing item|null]
    for (const it of data.items.slice(i, i + CHUNK)) {
      const cur = byLegacy.get(it.legacyId);
      if (cur && cur.deleted) { summary.skippedDeleted++; continue; }
      if (cur) {
        const changed = cur.name !== it.name || cur.code !== it.code || cur.cat !== it.cat || !!cur.fav !== it.fav;
        if (changed) { batch.push(Object.assign({}, cur, { name: it.name, code: it.code, cat: it.cat, fav: it.fav })); summary.updated++; }
        else summary.unchanged++;
        if (!cur.image) stage(cur.id, it);
      } else {
        batch.push({ name: it.name, shortName: '', code: it.code, cat: it.cat, fav: it.fav, barcodes: [], tags: [], image: null, legacyId: it.legacyId });
        staged.push(it);
        summary.added++;
      }
    }
    const saved = batch.length ? store.putMany(batch) : [];
    // new items come back in the same order as the `batch` entries without an id
    let k = 0;
    for (let b = 0; b < batch.length; b++) {
      if (batch[b].legacyId != null && !batch[b].id) { stage(saved[b].id, staged[k++]); }
    }
    done += Math.min(CHUNK, data.items.length - i);
    onProgress({ phase: 'text', done, total: data.items.length });
    await tick();
  }

  const authSaved = data.auth ? saveAuth(dir, data.auth) : false;
  store.flush();
  return { ok: true, summary, warnings: data.warnings, counts: data.counts, jobs, shopName: data.shopName, authSaved };
}

// The legacy edit-lock record stays LOCAL (never in db.json / never synced).
function saveAuth(dir, auth) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'auth.json');
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ legacy: true, importedAt: Date.now(), auth }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
    return true;
  } catch (e) { console.warn('[catalog] could not save auth.json:', e.message); return false; }
}

// Read a staged image (name must be "<n>.img"); null when missing/invalid.
function readStaged(dir, name) {
  if (!/^\d{1,9}\.img$/.test(String(name))) return null;
  try { return fs.readFileSync(path.join(tmpDir(dir), name)); } catch (_) { return null; }
}

module.exports = {
  findCandidates, readLegacy, previewLegacy, normalizeLegacy, decodeDataUrl, importLegacy,
  readStaged, cleanupTmp, tmpDir, saveAuth, LEGACY_FILE, DEFAULT_CAT
};
