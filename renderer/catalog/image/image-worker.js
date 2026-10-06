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
 *              'preview'  fast live preview at analyze size (<= cfg.analyzeMax), raw RGBA back;
 *                         the analyze image is produced exactly as in 'process' (same resize/dims)
 *              'cancel'   { id: <id of a request still queued> } -> that request is answered
 *                         { id, ok:false, cancelled:true }. A running job cannot be interrupted
 *                         (single-threaded wasm); queued 'preview's older than the newest queued
 *                         preview OF THE SAME sourceId are auto-cancelled the same way (so dragging
 *                         a slider is cheap).
 *   source     exactly one of: file (Blob/File), bitmap (ImageBitmap, transferred), arrayBuffer.
 *              Decoded with createImageBitmap(blob, { imageOrientation:'from-image' }) so EXIF
 *              rotation is applied. Then downscaled to cfg.origMax (long side) = the "orig";
 *              transparent areas are filled with cfg.tileBg first.
 *              Send `sourceId` with the first request; the worker keeps the last decoded source,
 *              so later requests with the same sourceId may omit file/bitmap/arrayBuffer.
 *              A request that DOES carry data is re-decoded unless sourceId, a content fingerprint
 *              (size + sampled bytes; ImageBitmaps always re-decode) and cfg.origMax all match the
 *              cache, so new bytes under an old sourceId are never ignored. Requests dropped by
 *              cancel/coalescing still have their image data absorbed into the cache.
 *   isOrig     true when the bytes are an already-stored orig variant: if it is <= origMax the
 *              orig blob/hash are the unchanged input bytes (hash stays stable on re-process).
 *   cfg        spec section 11 `image` config (missing keys -> pipeline defaults)
 *   edit       spec section 8.4 `image.edit` (missing keys -> defaults)
 *   debug      preview only: also return `analyzeMask {width,height,buffer}` (0/255, analyze size; absent without a cut-out)
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
 *     info.analyzeW/analyzeH is the coordinate space of edit.maskEdits (identical to 'process').
 * RESPONSE (error)  { id, ok:false, error:'message' }   |   { id, ok:false, cancelled:true }
 *     OpenCV C++ exceptions (thrown as numbers) are mapped with cv.exceptionFromPtr when available.
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
  // Last decoded source: { sourceId, fp, origMax, isOrig, source:{blob|bitmap}, canvas, w, h, rgba, origBlob, hash }
  var cache = null;

  var ready = (async function () {
    var c = self.cv;
    if (c && typeof c.then === 'function') c = await c; // Promise-returning build
    if (!c.Mat) await new Promise(function (res) { c.onRuntimeInitialized = res; });
    cv = c;
    self.postMessage({ type: 'ready' });
  })().catch(function (e) {
    fatalError = describeError(e);
    self.postMessage({ type: 'fatal', error: fatalError });
  });

  /** OpenCV.js throws raw numeric pointers for C++ exceptions; map them to messages when possible. */
  function describeError(e) {
    try {
      var c = cv || self.cv;
      if (typeof e === 'number' && c && typeof c.exceptionFromPtr === 'function') {
        var x = c.exceptionFromPtr(e);
        return 'OpenCV: ' + ((x && (x.msg || x.err || x.what)) || e);
      }
    } catch (_) { /* fall through */ }
    return typeof e === 'number' ? 'OpenCV exception ' + e : String((e && e.message) || e);
  }

  function hex(buf) {
    var a = new Uint8Array(buf), s = '';
    for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
    return s;
  }

  function hasData(msg) { return !!(msg.file || msg.bitmap || msg.arrayBuffer); }

  /** Cheap content fingerprint: size + sha256 of 3 sampled 4 KB slices. null for ImageBitmaps (always re-decoded). */
  async function fingerprint(msg) {
    if (msg.bitmap) return null;
    var blob = msg.file || new Blob([msg.arrayBuffer]), n = blob.size, K = 4096, parts = [];
    [0, Math.max(0, Math.floor(n / 2) - K / 2), Math.max(0, n - K)].forEach(function (o) { parts.push(blob.slice(o, o + K)); });
    var bytes = await new Blob(parts).arrayBuffer();
    return n + ':' + hex(await crypto.subtle.digest('SHA-256', bytes));
  }

  /** Decode source -> orig canvas (<= origMax) and store it as the cache entry. */
  async function render(msg, source, fp, cfg) {
    var bmp = source.bitmap || await createImageBitmap(source.blob, { imageOrientation: 'from-image' });
    var bw = bmp.width, bh = bmp.height, s = Math.min(1, cfg.origMax / Math.max(bw, bh));
    var w = Math.max(1, Math.round(bw * s)), h = Math.max(1, Math.round(bh * s));
    var canvas = new OffscreenCanvas(w, h), g = canvas.getContext('2d');
    g.fillStyle = cfg.tileBg; g.fillRect(0, 0, w, h); // transparent PNGs must not turn black in JPEG
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, w, h);
    if (!source.bitmap && bmp.close) bmp.close(); // blob sources can be re-decoded; bitmaps are kept
    var isOrig = !!msg.isOrig;
    var old = cache;
    cache = {
      sourceId: msg.sourceId, fp: fp, origMax: cfg.origMax, isOrig: isOrig, source: source, canvas: canvas, w: w, h: h,
      rgba: null, origBlob: (isOrig && s === 1 && source.blob) ? source.blob : null, hash: null,
      // true once `canvas` holds the pixels of the stored orig bytes (an input that already IS the orig needs no re-decode)
      settled: !!(isOrig && s === 1 && source.blob)
    };
    if (old && old.source !== source && old.source.bitmap && old.source.bitmap.close) old.source.bitmap.close();
    return cache;
  }

  /**
   * Get the decoded source for a request. A request that supplies image data is decoded
   * unless it matches the cache (same sourceId + content fingerprint + origMax); a
   * data-less request needs a cached sourceId (and re-renders if origMax changed).
   */
  async function getSource(msg, cfg) {
    var same = cache && msg.sourceId !== undefined && cache.sourceId === msg.sourceId;
    if (hasData(msg)) {
      var fp = await fingerprint(msg);
      if (same && fp !== null && cache.fp === fp && cache.origMax === cfg.origMax && !msg.force) return cache;
      var source = msg.bitmap ? { bitmap: msg.bitmap } : { blob: msg.file || new Blob([msg.arrayBuffer]) };
      return render(msg, source, fp, cfg);
    }
    if (!same) throw new Error('unknown sourceId and no image data supplied');
    if (cache.origMax !== cfg.origMax) return render({ sourceId: cache.sourceId, isOrig: cache.isOrig }, cache.source, cache.fp, cfg);
    return cache;
  }

  async function ensureOrig(src, cfg) {
    if (!src.origBlob) src.origBlob = await src.canvas.convertToBlob({ type: 'image/jpeg', quality: Math.max(ORIG_JPEG_Q, cfg.jpegQuality || 0) });
    if (!src.hash) src.hash = hex(await crypto.subtle.digest('SHA-256', await src.origBlob.arrayBuffer()));
    // First pass == reprocess: analyse the exact (JPEG re-encoded) orig bytes that get stored, not the raw decoded
    // file, so process(file) and process(storedOrig, isOrig) give the same quality verdict.
    if (!src.settled) {
      var bmp = await createImageBitmap(src.origBlob);
      var c = new OffscreenCanvas(src.w, src.h), g = c.getContext('2d');
      g.drawImage(bmp, 0, 0, src.w, src.h);
      if (bmp.close) bmp.close();
      src.canvas = c; src.rgba = null; src.settled = true;
    }
    return src;
  }

  function rgbaOf(src) {
    if (!src.rgba) {
      var d = src.canvas.getContext('2d').getImageData(0, 0, src.w, src.h);
      src.rgba = { data: d.data, width: src.w, height: src.h };
    }
    return src.rgba;
  }

  async function tileToBlob(tile, quality) {
    var c = new OffscreenCanvas(tile.width, tile.height);
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(tile.data), tile.width, tile.height), 0, 0);
    return c.convertToBlob({ type: 'image/jpeg', quality: quality });
  }

  async function doProcess(msg) {
    var cfg = P.mergeImageCfg(msg.cfg);
    var src = await ensureOrig(await getSource(msg, cfg), cfg);
    var r = P.runPipeline(cv, rgbaOf(src), cfg, msg.edit, { mode: 'final', variants: msg.variants, sizes: msg.sizes });
    var thumb = await tileToBlob(r.tiles.thumb, cfg.jpegQuality), full = await tileToBlob(r.tiles.full, cfg.jpegQuality);
    return {
      id: msg.id, ok: true, type: 'process', thumb: thumb, full: full, orig: src.origBlob, hash: src.hash,
      quality: r.quality, reasons: r.reasons, w: src.w, h: src.h, edit: r.edit, info: r.info
    };
  }

  async function doPreview(msg) {
    var cfg = P.mergeImageCfg(msg.cfg);
    var src = await ensureOrig(await getSource(msg, cfg), cfg);
    // Same input as `process` (the orig-size RGBA): the pipeline's own analyzeResize then yields exactly
    // the same analyze image / size as final, so brush coordinates and info.analyzeW/H match.
    var r = P.runPipeline(cv, rgbaOf(src), cfg, msg.edit, { mode: 'preview', variants: msg.variants, sizes: msg.sizes, debug: !!msg.debug });
    var out = { id: msg.id, ok: true, type: 'preview', quality: r.quality, reasons: r.reasons, w: src.w, h: src.h, edit: r.edit, info: r.info };
    var transfer = [];
    if (msg.debug && r.debug && r.debug.analyzeMask) { // brush overlay: 0/255 mask at analyze size
      out.analyzeMask = { width: r.info.analyzeW, height: r.info.analyzeH, buffer: r.debug.analyzeMask.buffer };
      transfer.push(r.debug.analyzeMask.buffer);
    }
    Object.keys(r.tiles).forEach(function (k) {
      var t = r.tiles[k];
      out[k] = { width: t.width, height: t.height, buffer: t.data.buffer };
      transfer.push(t.data.buffer);
    });
    return { msg: out, transfer: transfer };
  }

  /** A dropped request that carries image data must still land in the cache, or later data-less requests would fail. */
  async function absorbDropped(msg) {
    if (!hasData(msg) || fatalError) return;
    try { await getSource(msg, P.mergeImageCfg(msg.cfg)); } catch (e) { /* the request is dropped anyway */ }
  }

  async function pump() {
    if (running) return;
    running = true;
    try {
      await ready;
      while (queue.length) {
        var msg = queue.shift();
        if (fatalError) { self.postMessage({ id: msg.id, ok: false, error: 'worker failed to start: ' + fatalError }); continue; }
        // coalesce: a preview is superseded only by a newer queued preview of the SAME source
        var superseded = msg.type === 'preview' && queue.some(function (m) { return m.type === 'preview' && m.sourceId === msg.sourceId; });
        if (cancelled.has(msg.id) || superseded) {
          cancelled.delete(msg.id);
          await absorbDropped(msg);
          self.postMessage({ id: msg.id, ok: false, cancelled: true });
          continue;
        }
        try {
          if (msg.type === 'process') self.postMessage(await doProcess(msg));
          else if (msg.type === 'preview') { var p = await doPreview(msg); self.postMessage(p.msg, p.transfer); }
          else self.postMessage({ id: msg.id, ok: false, error: 'unknown type ' + msg.type });
        } catch (e) {
          self.postMessage({ id: msg.id, ok: false, error: describeError(e) });
        }
        await new Promise(function (r) { setTimeout(r, 0); }); // let newer messages (cancel/preview) enqueue
      }
    } finally { running = false; }
  }

  self.onmessage = function (e) {
    var msg = e.data || {};
    if (msg.type === 'cancel') {
      if (queue.some(function (m) { return m.id === msg.id; })) cancelled.add(msg.id);
      return;
    }
    queue.push(msg);
    pump();
  };
})();
