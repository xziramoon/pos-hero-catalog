'use strict';
// Pure whitelisting of renderer-supplied input (no Electron). Used by catalog IPC handlers.

const DEFAULT_CAT = 'ทั่วไป';
const MAX_CAT = 60;
const MAX_SHOP = 120;
const MAX_TEXT = 300;

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const strArr = (v, max, maxLen) => (Array.isArray(v) ? v : [])
  .filter((x) => typeof x === 'string' || typeof x === 'number')
  .map((x) => str(x, maxLen)).filter(Boolean).slice(0, max);

// Only categories (non-empty trimmed strings <= 60, deduped, always has DEFAULT_CAT) and shopName.
function sanitizeMetaPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  if (Array.isArray(patch.categories)) {
    const seen = new Set();
    const cats = [];
    for (const c of patch.categories) {
      if (typeof c !== 'string') continue;
      const t = c.trim();
      if (!t || t.length > MAX_CAT || seen.has(t)) continue;
      seen.add(t); cats.push(t);
    }
    if (!seen.has(DEFAULT_CAT)) cats.unshift(DEFAULT_CAT);
    out.categories = cats;
  }
  if (typeof patch.shopName === 'string' && patch.shopName.length <= MAX_SHOP) out.shopName = patch.shopName.trim();
  return out;
}

// Only user-editable fields. `id` is passed through (caller verifies it exists);
// deleted/rev/updatedAt/updatedBy/image are never accepted from the renderer.
function sanitizeItemInput(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.id === 'string' && raw.id) out.id = raw.id;
  if ('name' in raw) out.name = str(raw.name, MAX_TEXT);
  if ('shortName' in raw) out.shortName = str(raw.shortName, MAX_TEXT);
  if ('code' in raw) out.code = str(raw.code, MAX_TEXT);
  if ('cat' in raw) out.cat = str(raw.cat, MAX_CAT) || DEFAULT_CAT;
  if ('fav' in raw) out.fav = raw.fav === true;
  if ('barcodes' in raw) out.barcodes = strArr(raw.barcodes, 50, 64);
  if ('tags' in raw) out.tags = strArr(raw.tags, 50, 40);
  return out;
}

// Strip secrets / hotkey from a renderer config patch (returns a new object).
function sanitizeConfigPatch(patch) {
  if (!patch || typeof patch !== 'object') return {};
  const p = JSON.parse(JSON.stringify(patch));
  if (p.window) delete p.window.hotkey; // use setHotkey
  // TODO(Phase 4): the write token is set via a dedicated main-process handler, never through setConfig.
  if (p.worker) delete p.worker.writeToken;
  delete p.hasWriteToken;
  return p;
}

module.exports = { sanitizeMetaPatch, sanitizeItemInput, sanitizeConfigPatch, DEFAULT_CAT };
