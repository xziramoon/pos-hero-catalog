'use strict';
// Sync status model with a fake fetch/clock (no network): offline -> warn bar after 3 min -> recovery, read-only, unconfigured.
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../catalog/catalog-store');
const { createOutbox } = require('../catalog/catalog-outbox');
const { createImages } = require('../catalog/catalog-images');
const { createSync } = require('../catalog/catalog-sync');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-syncoff-'));
const KEY = 'k'.repeat(40);

(async () => {
  try {
    let t = 1000000;
    let down = true;
    let cfg = { worker: { url: 'https://example.invalid', key: KEY, writeToken: 'x'.repeat(20) } };
    const calls = [];
    const store = createStore(tmp, { deviceId: 'dev-a' }).load();
    const outbox = createOutbox(tmp, { now: () => t }).load();
    const sync = createSync({
      store, outbox, images: createImages(path.join(tmp, 'images')), now: () => t, warn: () => {}, log: () => {},
      getConfig: () => cfg,
      fetch: async (url, o) => {
        calls.push(o.method + ' ' + url.replace(/^.*\/catalog\/[^/]+/, ''));
        if (down) throw new TypeError('fetch failed');
        const body = url.includes('/changes') ? { items: [], rev: 0, more: false, serverTime: Date.now() } : { accepted: [], rejected: [], rev: 0, serverTime: Date.now() };
        return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } };
      }
    });
    const states = [];
    sync.on('status', (s) => states.push(s.state));

    cfg = { worker: { url: '', key: '' } };
    assert.strictEqual(sync.getStatus().state, 'unconfigured');
    assert.strictEqual(sync.getStatus().canEdit, true, 'local-only mode keeps editing enabled');
    cfg = { worker: { url: 'https://example.invalid', key: KEY, writeToken: '' } };
    assert.strictEqual(sync.getStatus().state, 'readonly');
    assert.strictEqual(sync.getStatus().canEdit, false, 'key without write token is read-only');
    cfg = { worker: { url: 'https://example.invalid', key: KEY, writeToken: 'x'.repeat(20) } };

    store.put({ name: 'ค้างส่ง', code: '1' });
    assert.strictEqual(sync.getStatus().pending, 1);
    await sync._cycle();
    let s = sync.getStatus();
    assert.strictEqual(s.state, 'offline'); assert.ok(/ต่อ Worker ไม่ได้/.test(s.lastError)); assert.strictEqual(s.warn, false);
    assert.deepStrictEqual(calls, ['GET /health'], 'nothing is pushed while the target cannot be checked');
    t += 4 * 60 * 1000;
    await sync._cycle();
    s = sync.getStatus();
    assert.strictEqual(s.warn, true, 'warning bar after 3 minutes of failed pulls');
    down = false;
    await sync._cycle();
    s = sync.getStatus();
    assert.strictEqual(s.warn, false); assert.strictEqual(s.lastError, null);
    assert.ok(s.lastOkAt > 0);
    assert.ok(calls.includes('POST /items'), 'queue is flushed after recovery');
    assert.ok(states.includes('offline'));
    console.log('sync-offline.test.js ok');
  } catch (e) { console.error(e); process.exitCode = 1; }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
})();
