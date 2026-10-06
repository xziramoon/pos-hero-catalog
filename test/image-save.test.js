'use strict';
// saveImageForItem: validation, variants-before-item ordering (outbox holds an img op ahead of the item op),
// version numbering; plus a drift guard for the duplicated image defaults.
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createStore } = require('../catalog/catalog-store');
const { createOutbox } = require('../catalog/catalog-outbox');
const { createImages } = require('../catalog/catalog-images');
const { createSync } = require('../catalog/catalog-sync');
const { saveImageForItem, removeImageForItem, thaiSaveError, sanitizeEdit } = require('../catalog/catalog-image-save');
const { defaults } = require('../catalog/defaults');
const pipelineDefaults = require('../renderer/catalog/image/pipeline/defaults-image');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-imgsave-'));
const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(n)]);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// 0. the pipeline's fallback defaults must equal the main-process config defaults
assert.deepStrictEqual(pipelineDefaults.imageDefaults, defaults.image, 'defaults-image.js drifted from catalog/defaults.js image');

const store = createStore(tmp, { deviceId: 'dev-a' }).load();
const images = createImages(path.join(tmp, 'images'));
const outbox = createOutbox(tmp).load();
const sync = createSync({
  store, outbox, images, warn: () => {}, log: () => {},
  getConfig: () => ({ worker: { url: 'https://example.invalid', key: 'k'.repeat(40), writeToken: 'x'.repeat(20) } }),
  fetch: async () => { throw new TypeError('fetch failed'); }
});
sync.start({ watchNetwork: false });

const item = store.put({ id: 'ITEM1', code: '001', name: 'a', shortName: '', cat: 'ทั่วไป', fav: false, barcodes: [], image: null });
const orig = jpeg(3000), hash = sha(orig);
const base = { orig, thumb: jpeg(500), full: jpeg(900), hash, edit: { rotate: 5, thumbCrop: { x: 1, y: 2, z: 1.5 }, junk: 1 }, quality: 'check', w: 800, h: 600 };

assert.throws(() => saveImageForItem({ store, images }, 'NOPE', base), /unknown item/);
assert.throws(() => saveImageForItem({ store, images }, 'ITEM1', Object.assign({}, base, { hash: sha(Buffer.from('x')) })), /hash does not match/);
assert.throws(() => saveImageForItem({ store, images }, 'ITEM1', Object.assign({}, base, { thumb: Buffer.from('not a jpeg') })), /not a JPEG/);
assert.throws(() => saveImageForItem({ store, images }, 'ITEM1', Object.assign({}, base, { full: Buffer.alloc(5 * 1024 * 1024 + 1, 0xff) })), /5 MB/);
assert.throws(() => saveImageForItem({ store, images }, 'ITEM1', Object.assign({}, base, { quality: 'great' })), /quality/);
assert.throws(() => saveImageForItem({ store, images }, 'ITEM1', Object.assign({}, base, { orig: undefined })), /orig is missing/);
assert.strictEqual(store.get('ITEM1').image, null, 'rejected saves must not touch the item');

// ordering: img ops are queued (from the 'saved' event) before the item put lands
const order = [];
images.on('saved', () => order.push('saved'));
store.on('local', () => order.push('item'));
const saved = saveImageForItem({ store, images }, 'ITEM1', base);
assert.deepStrictEqual(order, ['saved', 'item']);
assert.strictEqual(saved.image.hash, hash);
assert.strictEqual(saved.image.ver, 1);
assert.strictEqual(saved.image.quality, 'check');
assert.strictEqual(saved.image.edit.rotate, 5);
assert.strictEqual(saved.image.edit.junk, undefined);
assert.deepStrictEqual(saved.image.edit.thumbCrop, { x: 1, y: 2, z: 1.5 });
for (const f of ['orig.jpg', 'thumb-v1.jpg', 'full-v1.jpg']) assert.ok(fs.existsSync(path.join(tmp, 'images', hash, f)), f);

// re-edit without orig bytes (already stored) bumps ver; a different item sharing the hash never overwrites v1/v2
const again = saveImageForItem({ store, images }, 'ITEM1', Object.assign({}, base, { orig: undefined, thumb: jpeg(400) }));
assert.strictEqual(again.image.ver, 2);
store.put({ id: 'ITEM2', code: '002', name: 'b', shortName: '', cat: 'ทั่วไป', fav: false, barcodes: [], image: null });
const other = saveImageForItem({ store, images }, 'ITEM2', Object.assign({}, base, { orig: undefined }));
assert.strictEqual(other.image.ver, 3);

// ver also counts versions of this hash seen on ANY item (e.g. synced from another device; files not on this disk)
store.put({ id: 'ITEM3', code: '003', name: 'c', shortName: '', cat: 'x', fav: false, barcodes: [], image: { hash, ver: 9, edit: {}, quality: 'ok', w: 1, h: 1 } });
assert.strictEqual(saveImageForItem({ store, images }, 'ITEM1', Object.assign({}, base, { orig: undefined })).image.ver, 10);

// removeImage: only clears item.image; unknown/deleted items throw; files stay
const rem = removeImageForItem({ store }, 'ITEM1');
assert.strictEqual(rem.image, null);
assert.strictEqual(store.get('ITEM1').image, null);
assert.ok(fs.existsSync(path.join(tmp, 'images', hash, 'orig.jpg')), 'files stay on disk');
assert.strictEqual(removeImageForItem({ store }, 'ITEM1').image, null, 'idempotent');
assert.throws(() => removeImageForItem({ store }, 'NOPE'), /unknown item/);

// Thai user messages
assert.ok(/write token/.test(thaiSaveError(new Error('read-only: no write token'))));
assert.ok(/5 MB/.test(thaiSaveError(new Error('full is larger than 5 MB'))));
assert.ok(/[฀-๿]/.test(thaiSaveError(new Error('something odd'))));

// edit sanitizer
const e = sanitizeEdit({ brightness: 999, sharpen: -4, rotate: 'x', maskEdits: [{ mode: 'add', r: 9999, pts: [[1, 2], ['a', 3], [4, 5]] }, { mode: 'bad', pts: [[1, 1]] }], thumbCrop: { z: -1 } });
assert.strictEqual(e.brightness, 50); assert.strictEqual(e.sharpen, 0); assert.strictEqual(e.rotate, 0);
assert.strictEqual(e.maskEdits.length, 1); assert.strictEqual(e.maskEdits[0].r, 300); assert.strictEqual(e.maskEdits[0].pts.length, 2);
assert.strictEqual(e.thumbCrop.z, 0.1);

sync.stop();
console.log('image-save.test.js ok');
process.exit(0);
