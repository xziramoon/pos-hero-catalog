# Catalog — integration contracts (for parallel implementation)

The full spec is `docs/CATALOG_HERO_SPEC.md` (Thai). This file pins down the
interfaces between the pieces so they can be built on separate branches in
parallel and merged without guesswork. If you must deviate, update this file
in the same commit and say why.

## Ground rules (from spec §3.1 / §14)
- Catalog code lives ONLY in `catalog/`, `renderer/catalog/`, `preload-catalog.js`,
  `cloudflare-inbox/src/catalog.js`, tests, docs. Hooks into existing files
  (`main.js`, `preload.js`, `renderer/index.html`, `renderer/app.js`,
  `cloudflare-inbox/src/index.js`, `package.json`) must be minimal, wrapped in
  try/catch, and must never change money-in / inbox / LAN / UDP / print behavior.
- Every catalog module logs with prefix `[catalog]` and never throws into main.
- Catalog modules never reach for globals of `main.js`. Entry point is
  `require('./catalog').init({ app, getMainWindow, userDataDir, config })`.
- UI text Thai; code/comments English.
- Config values come from `catalog/defaults.js` (deep-merged with
  `userData/catalog/config.json`) — no scattered magic numbers.

## Shared modules (CommonJS, no Electron/Node-only APIs → usable by Worker via esbuild)
- `catalog/shared/merge.js` — **Phase 1 owns**
  - `mergeItem(local, remote) → winner` (returns one of the two objects, never a mix)
  - `isNewer(a, b) → boolean` (a beats b by updatedAt, tie → updatedBy string compare, larger wins)
  - `MAX_FUTURE_SKEW_MS = 10 * 60 * 1000`
  - `normalizeItem(raw) → Item` (coerce `code` to string, defaults for missing fields)
  - `validateItem(item) → string|null` (error reason or null)
- `catalog/shared/ulid.js` — **Phase 2 owns** — `ulid(now = Date.now()) → string` (Crockford base32, 26 chars, monotonic within same ms). Must work in Node and browser (`crypto.getRandomValues` fallback to `require('crypto')`).

## Item / Meta shape
Exactly spec §4.1 / §4.2. Extra fields allowed (`legacyId`, `schemaVersion`).
`image.hash` = sha256 hex of the **orig** variant bytes.

## Local storage layout (`userData/catalog/`) — spec §6.1
```
config.json   db.json   outbox.json   images/{hash}/{variant}-v{ver}.jpg   backups/
```
`orig` is stored as `images/{hash}/orig.jpg` (never versioned). thumb/full are versioned.

## Main-process modules
- `catalog/index.js` — `init(opts)`, `registerSchemes()` (must be called by main.js
  synchronously at top level, before `app.whenReady`), `openCatalog()`, `toggleCatalog()`.
- `catalog/defaults.js` — spec §11 object, plus `deepMerge(defaults, user)`.
- `catalog/catalog-config.js` — load/save `config.json` (tmp+rename).
- `catalog/catalog-store.js` — **Phase 2 creates, Phase 4 extends**
  - `createStore(dir, { deviceId? })` → `{ load(), get(id), put(item), putMany(items), list({includeDeleted}), remove(id) /*tombstone*/, getMeta(), setMeta(patch), changesSince(rev), lastRev, setLastRev(n), deviceId, clockOffset, setClockOffset(ms), now() /*Date.now()+clockOffset*/, on('changed', fn) }`
  - `put` stamps `updatedAt = now()`, `updatedBy = deviceId`. Writes are debounced (≤300ms) tmp+rename.
  - Phase 4 adds `applyRemote(items)` (uses mergeItem) and the outbox (`catalog/catalog-outbox.js`).
- `catalog/catalog-images.js` — **Phase 3 owns** — `saveVariants(hash, ver, { orig?, thumb, full })` (Buffers), `path(hash, variant, ver)`, `has(hash, variant, ver)`.
- `catalog/catalog-sync.js` — **Phase 4 owns.**
- `catalog/catalog-migrate.js` — **Phase 5 owns.**

## Image protocol
Images are served to the catalog renderer via a privileged custom scheme
`catimg://{hash}/{variant}-v{ver}.jpg` (orig: `catimg://{hash}/orig.jpg`),
registered in `catalog/index.js` (`protocol.registerSchemesAsPrivileged` in
`registerSchemes()`, `protocol.handle` in `init`). Missing file → 404 (Phase 4
later turns a 404 into a lazy download from R2). CSP of `renderer/catalog/index.html`:
`default-src 'self'; img-src 'self' data: blob: catimg:; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self' https:`

## IPC — `window.catalogAPI` (preload-catalog.js; all channels prefixed `catalog:`)
Phase 2 creates the bridge; later phases ADD methods (append, don't rename).
```
list() → {items:[Item], meta}           // non-deleted
get(id) → Item|null
save(item) → Item                        // create (no id → ulid) or update
remove(ids:[id]) → void                  // tombstone
setFav(ids, bool), moveCategory(ids, cat)
getMeta(), setMeta(patch)
copyText(text) → void                    // main-process clipboard
hide(), togglePin() → bool, getPinState()
getConfig() → config (WITHOUT worker.writeToken; has `hasWriteToken:boolean`)
setConfig(patch)
onChanged(cb)        // 'catalog:changed' {ids?:[...]|null}
onTheme(cb)          // 'catalog:theme' themeName
onFocusSearch(cb)    // sent each time window is shown
// Phase 3 adds: saveImage(itemId, {orig:ArrayBuffer, thumb:ArrayBuffer, full:ArrayBuffer, hash, edit, quality, w, h}) → Item
//               readOrig(hash) → ArrayBuffer|null
// Phase 4 adds: getSyncStatus(), onSyncStatus(cb), testConnection(cfg), initWorker(), syncNow()
// Phase 5 adds: importLegacy(filePath?) , onImportProgress(cb), backupNow()
```
Main window (`preload.js`) gets ONE new method: `heroWindow.toggleCatalog()` and
the theme is forwarded by `heroWindow.notifyTheme(name)` (IPC `catalog:theme-from-main`).
The catalog window ALSO listens to the `storage` event / reads the same
localStorage key the main window uses for theme, as a fallback.

## Renderer layout (`renderer/catalog/`)
```
index.html  catalog.css  catalog-app.js  icons.js  filters.js (spec §12.1)
photo-editor.js           (Phase 3)
image/pipeline/*.js       (Phase 3; pure functions of (cv, ctx, cfg, edit))
image/image-worker.js     (Phase 3; Web Worker, importScripts('../vendor/opencv.js'))
vendor/opencv.js          (Phase 3)
```
`renderer/catalog/index.html` links `../theme-hero.css` (and `../base.css` only if needed) and `../assets/fonts/*`.

## Worker endpoints — spec §5.3, implemented in `cloudflare-inbox/src/catalog.js`
Error JSON shape: `{ error: "code", message: "..." }`. Clock-skew reject: HTTP 409
`{ error:"clock_skew", serverTime }`. Missing/wrong write token: 401.

## Tests
- Root `package.json` gets `"test": "node test/run-all.js"` which runs every
  `test/*.test.js` (plain `node:assert`, no framework) — create it in whichever
  branch lands first; others just drop new `*.test.js` files in `test/`.
- `cloudflare-inbox`: `npm test` runs `smoke.js` and `catalog-smoke.js`
  against `$BASE` (default `http://127.0.0.1:8787` from `wrangler dev`).

## Phase 2 notes (window / local data) — additions and deviations
- `window.catalogAPI` extra methods (append-only): `getHotkey() -> {accelerator, active, error}`,
  `setHotkey(accel) -> {ok, error:'in_use'|'invalid'|null, ...}`. `setConfig` ignores `window.hotkey`
  (use `setHotkey`, which re-registers the global shortcut). `hide()` is fire-and-forget (`ipcRenderer.send`).
- `catalog:changed` payload is `{ids:[...]|null}` (null = reload everything, e.g. meta changed).
- `store.get(id)` returns tombstones too (IPC `get` filters them); `store.remove(idOrIds)` accepts a single id or an array;
  `store.flush()` writes synchronously (called on quit); `store.off()` exists.
- Window bounds and pin state persist in `config.json` (`window.bounds`, `window.alwaysOnTop`).
- Search normalization and the tab/filter list live in `renderer/catalog/filters.js` (UMD: browser global
  `CatalogFilters`, also `require()`-able in node tests). It is NOT in `catalog/shared/` because the renderer
  cannot load files outside `renderer/` under the CSP.
- Dev/env flags: `CATALOG_DATA_DIR` (use this dir instead of `userData/catalog`), `CATALOG_OPEN_ON_START=1`,
  `CATALOG_SCREENSHOT=<png>` (+ `CATALOG_SCREENSHOT_JS`, `CATALOG_QUIT_AFTER_SHOT=1`).
  `node catalog/tools/seed-demo.js [count] [--dir d] [--images n] [--reset]` fills a store (default `.catalog-dev/`, gitignored).
- `catimg://` serves `userData/catalog/images/{hash}/{orig|thumb|full}[-v{n}].jpg`; 404 when missing, 400 on bad names.
- Renderer uses the theme's semantic vars `--warning/--danger` (badges, alert tabs) besides `--hero-*`.
- Phase 4 note: `init()` creates the store with `createStore(dir)`; to add sync, subscribe in `catalog/index.js`
  next to the `store.on('changed')` line.
