/**
 * image-worker.js protocol test. The real file is evaluated in Node with a mocked
 * Worker environment (self, importScripts, createImageBitmap, OffscreenCanvas via
 * jpeg-js) and the real OpenCV.js, so the message protocol, caching, cancel/coalescing,
 * orig/hash handling and blob outputs are exercised end to end. (Real-browser behaviour
 * of createImageBitmap/OffscreenCanvas is NOT covered; see docs/catalog-contracts.md.)
 */
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const jpeg = require('jpeg-js');
const { loadCv } = require('../renderer/catalog/image/tools/load-cv');
const { makeAll } = require('./fixtures/make-synthetic');

const WORKER_DIR = path.join(__dirname, '..', 'renderer', 'catalog', 'image');

class ImageDataMock { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } }

function resample(src, sw, sh, dw, dh) { // box filter
  const out = new Uint8ClampedArray(dw * dh * 4), fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.min(sh, Math.ceil((y + 1) * fy)));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.min(sw, Math.ceil((x + 1) * fx)));
      const a = [0, 0, 0, 0]; let n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const o = (yy * sw + xx) * 4; a[0] += src[o]; a[1] += src[o + 1]; a[2] += src[o + 2]; a[3] += src[o + 3]; n++; }
      const o2 = (y * dw + x) * 4; for (let k = 0; k < 4; k++) out[o2 + k] = a[k] / n;
    }
  }
  return out;
}

class OffscreenCanvasMock {
  constructor(w, h) { this.width = w; this.height = h; this.buf = new Uint8ClampedArray(w * h * 4); }
  getContext() {
    const c = this;
    return {
      imageSmoothingEnabled: true, imageSmoothingQuality: 'low', fillStyle: '#000000',
      fillRect(x, y, w, h) { const v = parseInt(this.fillStyle.slice(1), 16); for (let i = 0; i < c.width * c.height; i++) { c.buf[i * 4] = v >> 16; c.buf[i * 4 + 1] = (v >> 8) & 255; c.buf[i * 4 + 2] = v & 255; c.buf[i * 4 + 3] = 255; } },
      drawImage(src, dx, dy, dw, dh) { c.buf.set(resample(src.buf || src._data, src.width, src.height, dw, dh)); },
      putImageData(id) { c.buf.set(id.data); },
      getImageData() { return new ImageDataMock(new Uint8ClampedArray(c.buf), c.width, c.height); }
    };
  }
  async convertToBlob(opts) {
    const q = Math.round((opts.quality || 0.9) * 100);
    const enc = jpeg.encode({ data: Buffer.from(this.buf), width: this.width, height: this.height }, q);
    return new Blob([enc.data], { type: opts.type });
  }
}

async function createImageBitmapMock(blob) {
  const j = jpeg.decode(Buffer.from(await blob.arrayBuffer()), { useTArray: true, formatAsRGBA: true });
  return { width: j.width, height: j.height, _data: j.data, close() {} };
}

async function main() {
  const realCv = await loadCv();
  const posted = [], waiters = [];
  const fakeSelf = {
    cv: realCv,
    postMessage(m) { posted.push(m); waiters.splice(0).forEach((w) => w()); }
  };
  function importScripts(...files) {
    for (const f of files) {
      if (/opencv\.js$/.test(f)) continue; // use the already-loaded cv (same file)
      const code = fs.readFileSync(path.join(WORKER_DIR, f), 'utf8');
      new Function('self', code).call(fakeSelf, fakeSelf);
    }
  }
  const src = fs.readFileSync(path.join(WORKER_DIR, 'image-worker.js'), 'utf8');
  new Function('self', 'importScripts', 'createImageBitmap', 'OffscreenCanvas', 'crypto', 'Blob', 'ImageData', src)(
    fakeSelf, importScripts, createImageBitmapMock, OffscreenCanvasMock, nodeCrypto.webcrypto, Blob, ImageDataMock);

  const send = (m) => fakeSelf.onmessage({ data: m });
  const waitFor = async (pred, ms = 60000) => {
    const t0 = Date.now();
    for (;;) {
      const m = posted.find(pred);
      if (m) return m;
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for message');
      await new Promise((r) => { waiters.push(r); setTimeout(r, 200); });
    }
  };

  await waitFor((m) => m.type === 'ready');
  const img = makeAll()['phone-tilted'];
  const jpgBytes = jpeg.encode({ data: Buffer.from(img.data), width: img.width, height: img.height }, 92).data;
  const file = new Blob([jpgBytes], { type: 'image/jpeg' });
  let failed = 0;
  const t = async (name, fn) => { try { await fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e)); } };

  let proc;
  await t('process -> thumb/full/orig blobs, hash, quality', async () => {
    send({ id: 1, type: 'process', sourceId: 's1', file, cfg: { jpegQuality: 0.86 }, edit: {} });
    proc = await waitFor((m) => m.id === 1);
    assert.strictEqual(proc.ok, true, proc.error);
    assert.strictEqual(proc.quality, 'ok');
    for (const k of ['thumb', 'full', 'orig']) assert.strictEqual(proc[k].type, 'image/jpeg');
    const th = jpeg.decode(Buffer.from(await proc.thumb.arrayBuffer()), { useTArray: true });
    const fu = jpeg.decode(Buffer.from(await proc.full.arrayBuffer()), { useTArray: true });
    assert.deepStrictEqual([th.width, th.height, fu.width, fu.height], [512, 512, 1024, 1024]);
    assert.deepStrictEqual([proc.w, proc.h], [1600, 1200]);
    const want = nodeCrypto.createHash('sha256').update(Buffer.from(await proc.orig.arrayBuffer())).digest('hex');
    assert.strictEqual(proc.hash, want);
    assert.strictEqual(proc.edit.pipelineVersion, 1);
  });

  await t('orig is downscaled to origMax', async () => {
    send({ id: 2, type: 'process', sourceId: 's2', file, cfg: { origMax: 800 }, edit: {} });
    const r = await waitFor((m) => m.id === 2);
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual([r.w, r.h], [800, 600]);
  });

  await t('isOrig keeps the stored bytes (hash stable on re-process)', async () => {
    send({ id: 3, type: 'process', sourceId: 's3', file: proc.orig, isOrig: true, edit: { rotate: 0 } });
    const r = await waitFor((m) => m.id === 3);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.hash, proc.hash);
  });

  await t('preview reuses cached source, returns transferable RGBA', async () => {
    send({ id: 4, type: 'preview', sourceId: 's3', edit: { brightness: 10 } });
    const r = await waitFor((m) => m.id === 4);
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.type, 'preview');
    assert.strictEqual(r.thumb.width, 512);
    assert.strictEqual(r.thumb.buffer.byteLength, 512 * 512 * 4);
    assert.ok(r.info.analyzeW > 0);
  });

  await t('queued previews are coalesced, queued process can be cancelled', async () => {
    send({ id: 10, type: 'preview', sourceId: 's3', edit: {} });
    send({ id: 11, type: 'preview', sourceId: 's3', edit: { brightness: 5 } });
    send({ id: 12, type: 'process', sourceId: 's3', edit: {} });
    send({ id: 13, type: 'preview', sourceId: 's3', edit: { brightness: 9 } });
    send({ type: 'cancel', id: 12 });
    const r13 = await waitFor((m) => m.id === 13);
    assert.strictEqual(r13.ok, true, r13.error);
    for (const id of [10, 11, 12]) { const m = posted.find((x) => x.id === id); assert.ok(m && m.cancelled, 'id ' + id + ' should be cancelled'); }
  });

  await t('a coalesced/cancelled request that carries the image still feeds the cache', async () => {
    send({ id: 30, type: 'preview', sourceId: 'A', file, edit: {} });
    send({ id: 31, type: 'preview', sourceId: 'A', edit: { brightness: 3 } });
    const r = await waitFor((m) => m.id === 31);
    assert.strictEqual(r.ok, true, r.error);
    assert.ok(posted.find((m) => m.id === 30).cancelled);
    // previews of a DIFFERENT source are not coalesced away
    send({ id: 32, type: 'preview', sourceId: 'A', edit: {} });
    send({ id: 33, type: 'preview', sourceId: 'B', file, edit: {} });
    const r33 = await waitFor((m) => m.id === 33);
    assert.strictEqual(r33.ok, true, r33.error);
    assert.strictEqual(posted.find((m) => m.id === 32).ok, true);
  });

  await t('new bytes under the same sourceId are re-decoded; origMax change re-renders', async () => {
    const other = makeAll()['web-white'];
    const bytes2 = jpeg.encode({ data: Buffer.from(other.data), width: other.width, height: other.height }, 90).data;
    send({ id: 40, type: 'process', sourceId: 'A', file: new Blob([bytes2], { type: 'image/jpeg' }), edit: {} });
    const r = await waitFor((m) => m.id === 40);
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual([r.w, r.h], [800, 800]);
    send({ id: 41, type: 'process', sourceId: 'A', cfg: { origMax: 400 }, edit: {} });
    const r2 = await waitFor((m) => m.id === 41);
    assert.strictEqual(r2.ok, true, r2.error);
    assert.deepStrictEqual([r2.w, r2.h], [400, 400]);
  });

  await t('preview and process share the same analyze size', async () => {
    send({ id: 50, type: 'process', sourceId: 'A', cfg: {}, edit: {} });
    const p = await waitFor((m) => m.id === 50);
    send({ id: 51, type: 'preview', sourceId: 'A', cfg: {}, edit: {} });
    const v = await waitFor((m) => m.id === 51);
    assert.deepStrictEqual([v.info.analyzeW, v.info.analyzeH], [p.info.analyzeW, p.info.analyzeH]);
  });

  await t('errors are reported per request', async () => {
    send({ id: 20, type: 'preview', sourceId: 'nope', edit: {} });
    const r = await waitFor((m) => m.id === 20);
    assert.strictEqual(r.ok, false);
    assert.ok(/sourceId/.test(r.error));
  });

  console.log(failed ? `${failed} failed` : 'worker protocol ok');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
