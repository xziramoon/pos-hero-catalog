/**
 * Catalog image Web Worker.
 *
 *   const w = new Worker('image/image-worker.js');   // classic worker (uses importScripts)
 *   w.onmessage = (e) => ...;
 *
 * The worker posts `{ type:'ready' }` once OpenCV is initialised (or
 * `{ type:'fatal', error }` if it could not start). Requests sent before that are queued.
 *
 * REQUEST  { id, type, sourceId?, file | bitmap | arrayBuffer, isOrig?, cfg?, edit?, variants?, sizes? }
 *   id         caller-chosen number/string, echoed back
 *   type       'process'  final: thumb 512 + full 1024 JPEG blobs + orig blob + sha256
 *              'preview'  fast live preview at analyze size (<= cfg.analyzeMax), raw RGBA back
 *              'cancel'   { id: <id of a request still queued> } -> that request is answered
 *                         { id, ok:false, cancelled:true }. A running job cannot be interrupted
 *                         (single-threaded wasm); queued 'preview's older than the newest queued
 *                         preview are auto-cancelled the same way (so dragging a slider is cheap).
 *   source     exactly one of: file (Blob/File), bitmap (ImageBitmap, transferred), arrayBuffer.
 *              Decoded with createImageBitmap(blob, { imageOrientation:'from-image' }) so EXIF
 *              rotation is applied. Then downscaled to cfg.origMax (long side) = the "orig".
 *              Send `sourceId` with the first request; the worker keeps the last decoded source,
 *              so later requests with the same sourceId may omit file/bitmap/arrayBuffer.
 *   isOrig     true when the bytes are an already-stored orig variant: if it is <= origMax the
 *              orig blob/hash are the unchanged input bytes (hash stays stable on re-process).
 *   cfg        spec section 11 `image` config (missing keys -> pipeline defaults)
 *   edit       spec section 8.4 `image.edit` (missing keys -> defaults)
 *   variants / sizes   optional overrides forwarded to runPipeline (preview only: {thumb,full} px)
 *
 * RESPONSE (process)
 *   { id, ok:true, type:'process', thumb:Blob, full:Blob, orig:Blob, hash, quality, reasons,
 *     w, h, edit, info }
 *     hash    sha256 hex of the orig blob bytes (== Item.image.hash)
 *     w, h    pixel size of the orig variant
 *     quality 'ok'|'check'|'retake'; reasons: reason codes (see pipeline/index.js)
 *     edit    normalised edit actually applied (save this as Item.image.edit)
 *     thumb/full/orig are image/jpeg Blobs (quality cfg.jpegQuality; orig 0.92 when re-encoded)
 * RESPONSE (preview)
 *   { id, ok:true, type:'preview', thumb:{width,height,buffer:ArrayBuffer RGBA},
 *     full:{...same}, quality, reasons, w, h, edit, info }       (buffers are transferred)
 *     -> new ImageData(new Uint8ClampedArray(buffer), width, height)
 *     info.analyzeW/analyzeH is the coordinate space of edit.maskEdits.
 * RESPONSE (error)  { id, ok:false, error:'message' }   |   { id, ok:false, cancelled:true }
 */
/* global self, importScripts, createImageBitmap, OffscreenCanvas, crypto */
'use strict';

importScripts(
  '../vendor/opencv.js',
  'pipeline/defaults-image.js',
  'pipeline/util.js',
  'pipeline/steps.js',
  'pipeline/index.js'
);

(function () {
  var P = self.CatalogPipeline.index;
  var ORIG_JPEG_Q = 0.92;
  var cv = null;
  var fatalError = null;
  var queue = [];
  var running = false;
  var cancelled = new Set();
  var cache = null; // { sourceId, canvas, w, h, origBlob, hash, previewCache:{} }

  var ready = (async function () {
    var c = self.cv;
    if (c && typeof c.then === 'function') c = await c; // Promise-returning build
    if (!c.Mat) await new Promise(function (res) { c.onRuntimeInitialized = res; });
    cv = c;
    self.postMessage({ type: 'ready' });
  })().catch(function (e) {
    fatalError = String(e && e.message || e);
    self.postMessage({ type: 'fatal', error: fatalError });
  });

  function hex(buf) {
    var a = new Uint8Array(buf), s = '';
    for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
    return s;
  }

  async function toBitmap(msg) {
    if (msg.bitmap) return { bitmap: msg.bitmap, blob: null };
    var blob = msg.file || (msg.arrayBuffer ? new Blob([msg.arrayBuffer]) : null);
    if (!blob) throw new Error('no image source (file | bitmap | arrayBuffer)');
    return { bitmap: await createImageBitmap(blob, { imageOrientation: 'from-image' }), blob: blob };
  }

  /** Decode (or reuse cached) source and downscale to origMax. */
  async function getSource(msg, cfg) {
    var hasSrc = msg.file || msg.bitmap || msg.arrayBuffer;
    if (!hasSrc) {
      if (cache && msg.sourceId !== undefined && cache.sourceId === msg.sourceId) return cache;
      throw new Error('unknown sourceId and no image data supplied');
    }
    if (cache && msg.sourceId !== undefined && cache.sourceId === msg.sourceId && !msg.force) return cache;
    var src = await toBitmap(msg);
    var bw = src.bitmap.width, bh = src.bitmap.height, s = Math.min(1, cfg.origMax / Math.max(bw, bh));
    var w = Math.max(1, Math.round(bw * s)), h = Math.max(1, Math.round(bh * s));
    var canvas = new OffscreenCanvas(w, h), g = canvas.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(src.bitmap, 0, 0, w, h);
    if (src.bitmap.close) src.bitmap.close();
    var keepBytes = msg.isOrig && s === 1 && src.blob;
    cache = { sourceId: msg.sourceId, canvas: canvas, w: w, h: h, origBlob: keepBytes ? src.blob : null, hash: null, previewCache: {} };
    return cache;
  }

  async function ensureOrig(src, cfg) {
    if (!src.origBlob) src.origBlob = await src.canvas.convertToBlob({ type: 'image/jpeg', quality: Math.max(ORIG_JPEG_Q, cfg.jpegQuality || 0) });
    if (!src.hash) src.hash = hex(await crypto.subtle.digest('SHA-256', await src.origBlob.arrayBuffer()));
    return src;
  }

  function rgbaOf(canvas, w, h) {
    var d = canvas.getContext('2d').getImageData(0, 0, w, h);
    return { data: d.data, width: w, height: h };
  }

  async function tileToBlob(tile, quality) {
    var c = new OffscreenCanvas(tile.width, tile.height);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(tile.data), tile.width, tile.height), 0, 0);
    return c.convertToBlob({ type: 'image/jpeg', quality: quality });
  }

  async function doProcess(msg) {
    var cfg = P.mergeImageCfg(msg.cfg);
    var src = await getSource(msg, cfg);
    var r = P.runPipeline(cv, rgbaOf(src.canvas, src.w, src.h), cfg, msg.edit, { mode: 'final', variants: msg.variants, sizes: msg.sizes });
    await ensureOrig(src, cfg);
    var thumb = await tileToBlob(r.tiles.thumb, cfg.jpegQuality), full = await tileToBlob(r.tiles.full, cfg.jpegQuality);
    return {
      id: msg.id, ok: true, type: 'process', thumb: thumb, full: full, orig: src.origBlob, hash: src.hash,
      quality: r.quality, reasons: r.reasons, w: src.w, h: src.h, edit: r.edit, info: r.info
    };
  }

  async function doPreview(msg) {
    var cfg = P.mergeImageCfg(msg.cfg);
    var src = await getSource(msg, cfg);
    var key = cfg.analyzeMax, pv = src.previewCache[key];
    if (!pv) {
      var s = Math.min(1, cfg.analyzeMax / Math.max(src.w, src.h));
      var pw = Math.max(1, Math.round(src.w * s)), ph = Math.max(1, Math.round(src.h * s));
      if (s === 1) pv = rgbaOf(src.canvas, pw, ph);
      else {
        var c = new OffscreenCanvas(pw, ph), g = c.getContext('2d');
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.drawImage(src.canvas, 0, 0, pw, ph);
        pv = rgbaOf(c, pw, ph);
      }
      src.previewCache = {}; src.previewCache[key] = pv;
    }
    var r = P.runPipeline(cv, pv, cfg, msg.edit, { mode: 'preview', variants: msg.variants, sizes: msg.sizes, origLong: Math.max(src.w, src.h) });
    var out = { id: msg.id, ok: true, type: 'preview', quality: r.quality, reasons: r.reasons, w: src.w, h: src.h, edit: r.edit, info: r.info };
    var transfer = [];
    Object.keys(r.tiles).forEach(function (k) {
      var t = r.tiles[k];
      out[k] = { width: t.width, height: t.height, buffer: t.data.buffer };
      transfer.push(t.data.buffer);
    });
    return { msg: out, transfer: transfer };
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      await ready;
      while (queue.length) {
        // coalesce: only the newest queued preview is worth computing
        var msg = queue.shift();
        if (fatalError) { self.postMessage({ id: msg.id, ok: false, error: 'worker failed to start: ' + fatalError }); continue; }
        if (cancelled.has(msg.id) || (msg.type === 'preview' && queue.some(function (m) { return m.type === 'preview'; }))) {
          cancelled.delete(msg.id);
          self.postMessage({ id: msg.id, ok: false, cancelled: true });
          continue;
        }
        try {
          if (msg.type === 'process') self.postMessage(await doProcess(msg));
          else if (msg.type === 'preview') { var p = await doPreview(msg); self.postMessage(p.msg, p.transfer); }
          else self.postMessage({ id: msg.id, ok: false, error: 'unknown type ' + msg.type });
        } catch (e) {
          self.postMessage({ id: msg.id, ok: false, error: String(e && e.message || e) });
        }
        await new Promise(function (r) { setTimeout(r, 0); }); // let newer messages (cancel/preview) enqueue
      }
    } finally { running = false; }
  }

  self.onmessage = function (e) {
    var msg = e.data || {};
    if (msg.type === 'cancel') {
      var queued = queue.some(function (m) { return m.id === msg.id; });
      if (queued) cancelled.add(msg.id);
      return;
    }
    queue.push(msg);
    pump();
  };
})();
