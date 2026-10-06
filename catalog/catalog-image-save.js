'use strict';
// Validate + persist an image produced by the renderer's photo editor / pipeline.
// Pure Node (no Electron) so it is unit-testable. Order matters (contracts, Phase 4 notes):
// variants are written (images.saveVariants -> 'saved' event -> sync queues uploads) BEFORE the
// item that references them is put, so the outbox never holds back/uploads a dangling reference.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HASH_RE } = require('./catalog-images');

const MAX_BYTES = 5 * 1024 * 1024;
const QUALITIES = ['ok', 'check', 'retake'];
const MAX_STROKES = 300;
const MAX_PTS = 4000;
const MAX_EDIT_JSON = 150 * 1024;

function toBuf(x, what) {
  let b = null;
  if (Buffer.isBuffer(x)) b = x;
  else if (x instanceof ArrayBuffer) b = Buffer.from(x);
  else if (ArrayBuffer.isView(x)) b = Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  if (!b || !b.length) throw new Error(what + ' is empty');
  if (b.length > MAX_BYTES) throw new Error(what + ' is larger than 5 MB');
  if (!(b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)) throw new Error(what + ' is not a JPEG');
  return b;
}

const num = (v, lo, hi, dflt) => {
  v = Number(v);
  if (!Number.isFinite(v)) return dflt;
  return Math.max(lo, Math.min(hi, v));
};
const r1 = (v) => Math.round(v * 10) / 10;

function sanitizeCrop(c) {
  c = c && typeof c === 'object' ? c : {};
  return { x: r1(num(c.x, -5000, 5000, 0)), y: r1(num(c.y, -5000, 5000, 0)), z: Math.round(num(c.z, 0.1, 20, 1) * 1000) / 1000 };
}

// Whitelist of spec section 8.4 image.edit. maskEdits are in analyze-size px (see contracts).
function sanitizeEdit(e) {
  e = e && typeof e === 'object' ? e : {};
  const strokes = [];
  for (const s of Array.isArray(e.maskEdits) ? e.maskEdits.slice(0, MAX_STROKES) : []) {
    if (!s || (s.mode !== 'add' && s.mode !== 'erase') || !Array.isArray(s.pts)) continue;
    const pts = [];
    for (const p of s.pts.slice(0, MAX_PTS)) {
      if (Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1])) pts.push([r1(num(p[0], -10000, 10000, 0)), r1(num(p[1], -10000, 10000, 0))]);
    }
    if (pts.length) strokes.push({ mode: s.mode, r: r1(num(s.r, 1, 300, 8)), pts });
  }
  const out = {
    pipelineVersion: Math.trunc(num(e.pipelineVersion, 1, 1000, 1)),
    bgRemove: e.bgRemove !== false,
    autoStraighten: e.autoStraighten !== false,
    rotate: r1(num(e.rotate, -3600, 3600, 0)),
    brightness: Math.round(num(e.brightness, -50, 50, 0)),
    sharpen: Math.round(num(e.sharpen, 0, 100, 35)),
    maskEdits: strokes,
    thumbCrop: sanitizeCrop(e.thumbCrop),
    fullCrop: sanitizeCrop(e.fullCrop)
  };
  if (JSON.stringify(out).length > MAX_EDIT_JSON) throw new Error('edit is too large');
  return out;
}

// Next free thumb/full version for a hash: never overwrite a versioned file another item may still show.
function nextVer(imagesDir, hash) {
  let max = 0;
  try {
    for (const f of fs.readdirSync(path.join(imagesDir, hash))) {
      const m = /^(?:thumb|full)-v(\d+)\.jpg$/.exec(f);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch (_) { /* no dir yet */ }
  return max + 1;
}

/**
 * saveImageForItem({ store, images }, itemId, payload) -> updated item
 * payload: { orig?: bytes, thumb: bytes, full: bytes, hash, edit, quality, w, h }
 * Throws Error('...') on invalid input.
 */
function saveImageForItem({ store, images }, itemId, payload) {
  if (!payload || typeof payload !== 'object') throw new Error('bad payload');
  const cur = store.get(String(itemId));
  if (!cur || cur.deleted) throw new Error('unknown item id');
  const hash = String(payload.hash || '');
  if (!HASH_RE.test(hash)) throw new Error('bad hash');
  const thumb = toBuf(payload.thumb, 'thumb');
  const full = toBuf(payload.full, 'full');
  const quality = QUALITIES.includes(payload.quality) ? payload.quality : null;
  if (!quality) throw new Error('bad quality');
  const w = Math.trunc(Number(payload.w)), h = Math.trunc(Number(payload.h));
  if (!(w >= 1 && w <= 8192 && h >= 1 && h <= 8192)) throw new Error('bad size');
  let orig = null;
  if (payload.orig != null) {
    orig = toBuf(payload.orig, 'orig');
    if (crypto.createHash('sha256').update(orig).digest('hex') !== hash) throw new Error('hash does not match orig bytes');
  } else if (!images.has(hash, 'orig')) {
    throw new Error('orig is missing for this hash');
  }
  const edit = sanitizeEdit(payload.edit);
  const sameHash = cur.image && cur.image.hash === hash && Number.isInteger(cur.image.ver);
  const ver = Math.max(nextVer(images.dir, hash), sameHash ? cur.image.ver + 1 : 1);
  images.saveVariants(hash, ver, { orig, thumb, full });
  return store.put(Object.assign({}, cur, { image: { hash, ver, edit, quality, w, h } }));
}

module.exports = { saveImageForItem, sanitizeEdit, nextVer, MAX_BYTES };
