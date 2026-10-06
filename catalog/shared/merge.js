'use strict';
// Per-item last-write-wins merge, shared by the Worker (bundled by esbuild) and the app.
// Pure CommonJS: no Node-only or Electron APIs. See docs/CATALOG_HERO_SPEC.md section 4.3.

const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

const str = (v, d = '') => (v == null ? d : String(v));

// a beats b: larger updatedAt wins; on a tie the larger updatedBy (string compare) wins.
// Exactly equal (same updatedAt and updatedBy) -> false, so merge is stable and deterministic.
function isNewer(a, b) {
  if (!b) return !!a;
  if (!a) return false;
  const ta = Number(a.updatedAt) || 0;
  const tb = Number(b.updatedAt) || 0;
  if (ta !== tb) return ta > tb;
  return str(a.updatedBy) > str(b.updatedBy);
}

// Returns one of the two objects (never a mix). Tombstones are ordinary edits.
function mergeItem(local, remote) {
  if (!local) return remote || null;
  if (!remote) return local;
  return isNewer(remote, local) ? remote : local;
}

// True when updatedAt is further in the future than the allowed clock skew.
function exceedsSkew(updatedAt, now) {
  return Number(updatedAt) > Number(now) + MAX_FUTURE_SKEW_MS;
}

// Coerce a raw object into the Item shape (extra fields are preserved).
function normalizeItem(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = Object.assign({}, r);
  out.id = str(r.id);
  out.code = str(r.code);
  out.name = str(r.name);
  out.shortName = str(r.shortName);
  out.cat = str(r.cat, '') || 'ทั่วไป';
  out.fav = !!r.fav;
  out.barcodes = Array.isArray(r.barcodes) ? r.barcodes.map(String) : [];
  out.tags = Array.isArray(r.tags) ? r.tags.map(String) : [];
  out.image = r.image && typeof r.image === 'object' ? r.image : null;
  out.updatedAt = Number(r.updatedAt) || 0;
  out.updatedBy = str(r.updatedBy);
  out.deleted = !!r.deleted;
  if (r.rev != null) out.rev = Number(r.rev) || 0;
  return out;
}

// Returns an error reason string, or null when the item is acceptable.
function validateItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'not_an_object';
  if (typeof item.id !== 'string' || !item.id || item.id.length > 64) return 'bad_id';
  if (typeof item.code !== 'string') return 'bad_code';
  if (typeof item.name !== 'string') return 'bad_name';
  if (!Number.isFinite(item.updatedAt) || item.updatedAt <= 0) return 'bad_updatedAt';
  if (typeof item.updatedBy !== 'string' || !item.updatedBy) return 'bad_updatedBy';
  if (item.image !== null && item.image !== undefined) {
    if (typeof item.image !== 'object' || typeof item.image.hash !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(item.image.hash)) return 'bad_image';
  }
  return null;
}

module.exports = { MAX_FUTURE_SKEW_MS, isNewer, mergeItem, exceedsSkew, normalizeItem, validateItem };
