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
`default-src 'self'; img-src 'self' data: blob: catimg:; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'` (Phase 4)

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

### Phase 3a — image pipeline core (landed; UI = Phase 3b)
Files: `image/pipeline/{defaults-image,util,steps,index}.js` (UMD: `require()` in Node,
`importScripts` in the worker, namespace `self.CatalogPipeline.index`),
`image/image-worker.js`, `image/tools/{load-cv,run-on-file}.js`, `vendor/opencv.js` (+README, Apache-2.0).
Full API, crop definition and coordinate spaces are documented in the header comments of
`image/pipeline/index.js` and `image/image-worker.js` (the source of truth). Summary for Phase 3b:
- Worker: `postMessage({id, type:'process'|'preview'|'cancel', sourceId, file|bitmap|arrayBuffer, cfg, edit})`.
  `process` -> `{id, ok, thumb:Blob, full:Blob, orig:Blob, hash, quality, reasons, w, h, edit, info}`;
  `preview` -> raw RGBA buffers `{thumb:{width,height,buffer}, full:{...}, ...}` at analyze size.
  Send `sourceId` once with the image; later previews may omit the image. Pass `isOrig:true`
  when re-processing a stored orig so `hash` stays identical.
- `edit.maskEdits` coords: analyze-size pixels of the image after manual rotate, before auto-straighten
  (size = `info.analyzeW x info.analyzeH`). `thumbCrop/fullCrop {x,y,z}`: z = zoom vs the default 86% fit,
  x/y = pan of the content centre in tile px at 512 reference scale (+x right, +y down).
- `quality` reasons: `too_small`(retake), `mask_area_low|mask_area_high|touches_edges|mask_broken|dark|tilt_too_large`(check).
- **CSP verified in real Electron** (Electron 32 / Chromium, sandboxed hidden window, `npm run smoke:pipeline`,
  harness `test/electron/pipeline-smoke/main.js` + `renderer/catalog/dev/worker-smoke.{html,js}`, excluded from the
  build): the worker + OpenCV.js (embind `new Function`) run under EXACTLY the CSP above, `script-src 'self'
  'wasm-unsafe-eval'`, with no EvalError and no CSP violation events. A file:// classic worker does not inherit the
  document CSP, so **no `'unsafe-eval'` is needed; final decision = keep the CSP unchanged.** Re-run the smoke test
  if the CSP, Electron version or opencv.js changes (never run `electron .`: it registers autostart).
- Worker cache: keyed by sourceId + content fingerprint + cfg.origMax; data-carrying requests that get coalesced
  or cancelled still populate it; previews are coalesced only per sourceId; preview's analyze size equals final's.
- TODO(Phase 3b): `image/pipeline/defaults-image.js` duplicates spec §11 `image` defaults (the worker
  cannot require main-process `catalog/defaults.js`). Dedupe: have the renderer pass `config.image` as
  `cfg` on every worker message (already supported) and delete the copy.
- Also required in renderer HTML: nothing beyond the CSP above; the worker is a classic worker
  (`new Worker('image/image-worker.js')`), `worker-src 'self' blob:` is enough.
`renderer/catalog/index.html` links `../theme-hero.css` (and `../base.css` only if needed) and `../assets/fonts/*`.

## Worker endpoints — spec §5.3, implemented in `cloudflare-inbox/src/catalog.js`
Details pinned by Phase 1: write token is sent in header `X-Catalog-Write` for `/init`, `/items`, `/meta` and `PUT /img`
(16-256 chars; `/init` also accepts body `{writeToken}`). Bad key -> 400 `invalid_key`. `POST /items` -> `{accepted:[{id,rev}], rejected:[{id,reason,current?}], rev, serverTime}`;
exact resend of an already-stored version is *accepted* (same rev), a losing edit is rejected with reason `stale` + `current`. `changes` returns
`{items, meta?, rev, more, serverTime}` or `{resetRequired:true, ...}` when `0 < since < tombstoneHorizonRev` (client then re-pulls with `since=0`). `PUT /meta` body
`{categories, shopName, updatedAt?}`, 409 `clock_skew` or 409 `stale` (+ `meta`). Image variants: `orig`, `thumb-vN`, `full-vN` (plain `thumb`/`full` also accepted but get a short cache, only
`orig` and versioned names are `immutable`). Extra export of `merge.js`: `exceedsSkew(updatedAt, now)`. `health` also returns `initialized`.

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

## Phase 4 notes (sync) — additions and deviations
- `catalog/catalog-images.js` was created in Phase 4 (Phase 3's pipeline is renderer-only). `createImages(imagesDir)` ->
  `{saveVariants(hash, ver, {orig?, thumb, full}), write(hash, variant, ver, buf), path, has, read, on('saved')}`.
  `ver` is `null` for `orig`. **Phase 3 must call `saveVariants` BEFORE `store.put` of the item that references `image.hash/ver`**:
  `saveVariants` emits `saved`, sync queues `img` uploads (orig only when newly written, thumb/full per ver), and the outbox
  holds back every item whose `image.hash` still has a pending `img` entry. `write()` (used by lazy downloads) does not queue uploads.
- `catimg://` now lazily downloads a missing file from R2 through `sync.ensureImage(hash, variant, ver)` (coalesced per file,
  a miss is remembered 15 s) and 404s only when sync is unconfigured / the image is not on the server.
- Store additions: `applyRemote(items) -> {applied, kept}`, `resetAll(items, {keepIds})`, `applyRemoteMeta(meta, {union}) -> {applied, needsPush}`,
  `setRev`, `setMetaRev`, `restamp(ids)`, `restampMeta()`, `syncId` / `setSyncId` / `resetSyncState(id)` (a different Worker URL/key resets lastRev + revs),
  and a new event `on('local', {ids, meta})` fired only for edits made on this device (`put/putMany/remove/setMeta`). `'changed'` still fires for both.
  `meta` category union: when a remote meta wins and local items use categories it lacks, those are kept and the meta is re-queued.
- Outbox (`catalog/catalog-outbox.js`, `outbox.json`): entries `{op, payload, tries, nextAt}`; item payload = full Item snapshot; one entry per item id / `meta` /
  image file (latest wins). Images first, then meta, then items (<= `worker.batchSize`=200 per POST). Backoff 2s,4s,...,5min.
- Sync (`catalog/catalog-sync.js`): `createSync({store, outbox, images, getConfig, fetch?, now?, isVisible?})` runs in plain Node (used by `test/sync.e2e.test.js`).
  `start({watchNetwork})`, `stop()`, `syncNow()`, `setVisible(bool)`, `configChanged()`, `getStatus()`, `on('status')`, `ensureImage`, `testConnection({url,key})`, `initWorker()`.
  Status: `{state:'ok'|'pending'|'offline'|'unconfigured'|'readonly', pending, lastOkAt, lastError, configured, hasWriteToken, writeBlocked, canEdit, warn}`.
  `canEdit` is false only for "key configured, no write token" (read-only machine): main refuses `save/remove/setFav/moveCategory/setMeta` and the UI disables editing.
  Unconfigured = local-only mode, editing stays enabled. `warn` = pulls have failed continuously for `worker.warnAfterMs` (180000).
  401 on a write -> `writeBlocked`, no write retries until `configChanged()` (setConfig with `worker`, or `set-write-token`).
  409 `clock_skew` -> `store.setClockOffset(serverTime - Date.now())`, all pending items/meta restamped with the corrected clock, retried (max 2).
  Items never synced (no `rev`, not queued) are queued once after the first successful pull (so Phase 2 / Phase 5 data uploads).
  Network change = `os.networkInterfaces()` fingerprint every 5 s + `powerMonitor` resume/unlock (main.js untouched).
- New config defaults in `worker`: `requestTimeoutMs` 20000, `imageTimeoutMs` 60000, `batchSize` 200, `warnAfterMs` 180000.
  `setConfig` only accepts `worker.url` and `worker.key` from the renderer (key validated); the write token only via `set-write-token`.
- New IPC (all `catalog:`-prefixed, catalog window only): `getSyncStatus`, `testConnection({url,key})` (uses the saved write token to also verify it via an empty POST /items),
  `initWorker()` (POST /init with the saved token), `syncNow()`, `set-write-token(token)` -> `{ok, hasWriteToken}` (never returns the token; '' clears). Event `catalog:sync-status`.
  Preload: `getSyncStatus, onSyncStatus, testConnection, initWorker, syncNow, setWriteToken`.
- CSP of the catalog page is now `connect-src 'self'` (the renderer never talks to the Worker; all HTTP is in the main process).
- Tests: `test/outbox.test.js`, `test/store-merge.test.js`, `test/sync-offline.test.js` (fake fetch/clock), and `test/sync.e2e.test.js`
  (skipped unless `CATALOG_E2E_BASE`, e.g. `cd cloudflare-inbox && npx wrangler dev` then `CATALOG_E2E_BASE=http://127.0.0.1:8787 node test/sync.e2e.test.js`).

## Phase 4 review fixes — pinned behaviour
- **Clock**: `store.clockOffset` is re-measured from `serverTime` on every successful JSON response (sample = serverTime - request midpoint, ignored when RTT > 5 s):
  `|sample| < 3 s` -> offset 0; otherwise the offset follows the sample when it moved by more than 3 s. A 409 `clock_skew` sets the offset and re-stamps ONLY pending
  items/meta whose `updatedAt` exceeds `serverTime + 10 min`; older, correctly stamped offline edits keep their time. `applyRemoteMeta` re-stamps with `max(now, remote.updatedAt + 1)`.
- **Resets** (`resetRequired`): `db.json` is first copied to `backups/db-reset-<ts>.json` (newest 5 kept; Phase 6's daily `db-YYYYMMDD.json` rotation must ignore this prefix).
  If the server's `rev` is BEHIND our `lastRev` (server wiped) every local item is kept and re-queued (`reconcile`, plus image re-upload); for a tombstone-horizon reset only pending, never-synced
  and rejected items are kept. The store tracks `synced[id] = 'updatedAt|updatedBy'` (persisted in db.json): anything whose current stamp differs and is not queued is re-queued on start / config change / reset.
- **Target safety**: after a Worker URL/Key change, if this device has local items and a write token and the target is initialized with `itemCount > 0`, status becomes `state:'confirm-target'`
  (`target:{itemCount}`); no pull/push happens until IPC `confirmTarget()` (preload `confirmTarget`). The UI shows "แคตตาล็อกนี้มีสินค้าอยู่แล้ว N ชิ้น จะรวมสินค้าในเครื่องเข้าไปไหม".
  On adopting a new target all locally referenced images (orig/thumb/full that exist on disk) are re-queued for upload. Known gap: a read-only device (no token) adopts without asking;
  if a token is added later its old local-only items are queued without a prompt.
- **Problems**: status has `problemCount` and `problems:[{id, kind:'item'|'image', reason(Thai)}]` (max 50). Items rejected with a non-`stale` reason and images rejected (400/413/415) or failing
  `PERMANENT_TRIES` (5) times are listed; editing the item / a later successful upload clears them. A failing image no longer aborts the push (meta and items still go); after 5 failed tries its items
  are pushed without waiting and the image stays queued with 2s..5min backoff.
- **Security**: all Worker fetches use `redirect:'error'`; `testConnection` only attaches the saved write token when the URL equals the saved URL; `http://` Worker URLs are rejected except `localhost`/`127.0.0.1`/`[::1]`.
- **Downloads**: lazy image downloads are capped at `worker.maxConcurrentDownloads` (4) concurrent and `worker.maxImageBytes` (5 MB, checked on Content-Length and while streaming); in-flight keys are normalized (lowercase hash, `orig` has no ver).
- **Durability**: the outbox is written synchronously inside the local-edit handler (before the IPC call returns); db.json stays debounced (300 ms) and is covered by the `synced` re-queue above. Failed writes of
  `db.json` / `outbox.json` retry with 1s..30s backoff.
- **Polling and request math** (config `worker.*`): visible + focused `pollMsVisible` 5 s; visible but unfocused `pollMsUnfocused` 15 s; hidden `pollMsHidden` 60 s. Consecutive failed pulls double the interval
  (`base * 2^n`, capped at `pollBackoffMaxMs` 60 s); the "fails > warnAfterMs" warning bar is unaffected. Gaining focus/visibility, network change (IPv4 interface fingerprint, 5 s check), power resume and
  manual "sync now" trigger an immediate cycle; automatic triggers use `soft` retry (do not reset the backoff of entries with >= 5 failed tries), the manual button resets everything.
  Per machine and day with 4 h focused (2,880 pulls) + 6 h unfocused (1,440) + 14 h hidden (840) = about 5,200 pulls; four machines about 21k Worker requests and 21k Durable Object requests per day
  (+ pushes/images, a few hundred). Worst case, 4 machines focused 24 h = 69k/day. Cloudflare's free quota is, to our knowledge, 100k requests/day each for Workers and Durable Objects; re-check the dashboard. Inbox adds about 290/day.
  Note: a catalog window that stays visible but unfocused next to the POS syncs every 15 s, so edits can take up to ~15 s to show there (they appear immediately when it is focused).
- Tests: `test/sync-safety.test.js` (fake Worker in `test/fake-worker.js`) covers each item above; `test/sync.e2e.test.js` now expects the wiped-server case to keep and re-push local-only items.
