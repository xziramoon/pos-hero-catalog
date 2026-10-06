/**
 * Pipeline helpers: statistics on uint8 data, mat bookkeeping, small cv wrappers.
 * Loads via require() in Node and importScripts() in a Worker (namespace
 * `self.CatalogPipeline.util`).
 */
(function (root) {
  'use strict';
  var NS = (root.CatalogPipeline = root.CatalogPipeline || {});

  /** numpy.percentile (linear interpolation) of an ascending-sorted numeric array. */
  function percentileSorted(sorted, p) {
    var n = sorted.length;
    if (!n) return 0;
    var r = (p / 100) * (n - 1), lo = Math.floor(r), hi = Math.min(n - 1, lo + 1);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (r - lo);
  }

  /** Histogram (256 bins) → numpy.percentile equivalent. Exact for uint8 data. */
  function percentileHist(hist, n, p) {
    if (!n) return 0;
    var r = (p / 100) * (n - 1), lo = Math.floor(r), hi = Math.min(n - 1, lo + 1);
    function kth(k) { var c = 0; for (var v = 0; v < 256; v++) { c += hist[v]; if (c > k) return v; } return 255; }
    var a = kth(lo), b = hi === lo ? a : kth(hi);
    return a + (b - a) * (r - lo);
  }

  function median(sorted) { return percentileSorted(sorted, 50); }

  /** Collect histogram of channel `ch` (of `cn` interleaved) where sel(i) is true. */
  function histOf(data, cn, ch, maskData, maskWant) {
    var h = new Uint32Array(256), n = 0, N = data.length / cn;
    for (var i = 0; i < N; i++) {
      if (maskData) { var on = maskData[i] > 0; if (on !== maskWant) continue; }
      h[data[i * cn + ch]]++; n++;
    }
    return { hist: h, n: n };
  }

  function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  /**
   * Per-run Mat registry: everything allocated through ctx.own() is deleted in
   * ctx.dispose() (called from a finally block), so a step that throws cannot leak.
   */
  function createOwner() {
    var set = new Set();
    return {
      own: function (m) { set.add(m); return m; },
      drop: function (m) { if (m && set.has(m)) { set.delete(m); m.delete(); } },
      disposeAll: function () { set.forEach(function (m) { try { m.delete(); } catch (e) { /* already freed */ } }); set.clear(); },
      count: function () { return set.size; }
    };
  }

  function parseHexColor(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!m) return [247, 243, 234];
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  }

  /** Largest connected component of a binary (non-zero) 8UC1 mat. Returns {mat (0/255), area, x,y,w,h} or null. Caller owns result.mat via ctx.own. */
  function largestComponent(cv, ctx, bin, connectivity) {
    var labels = new cv.Mat(), stats = new cv.Mat(), cent = new cv.Mat();
    try {
      var n = cv.connectedComponentsWithStats(bin, labels, stats, cent, connectivity || 8);
      if (n <= 1) return null;
      var best = 1, bestA = -1, s = stats.data32S;
      for (var i = 1; i < n; i++) { var a = s[i * 5 + 4]; if (a > bestA) { bestA = a; best = i; } }
      var out = ctx.own(new cv.Mat(bin.rows, bin.cols, cv.CV_8UC1));
      var lab = labels.data32S, od = out.data;
      for (var j = 0; j < lab.length; j++) od[j] = lab[j] === best ? 255 : 0;
      return { mat: out, area: bestA, x: s[best * 5], y: s[best * 5 + 1], w: s[best * 5 + 2], h: s[best * 5 + 3] };
    } finally { labels.delete(); stats.delete(); cent.delete(); }
  }

  function morph(cv, ctx, src, op, k) {
    var kernel = cv.Mat.ones(k, k, cv.CV_8U), dst = ctx.own(new cv.Mat());
    try { cv.morphologyEx(src, dst, op, kernel); } finally { kernel.delete(); }
    return dst;
  }

  function countNonZero(data) { var c = 0; for (var i = 0; i < data.length; i++) if (data[i]) c++; return c; }

  /** Bounding box of non-zero pixels of a w*h 8UC1 buffer, or null. */
  function bboxOfMask(data, w, h) {
    var x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (var y = 0; y < h; y++) {
      var row = y * w;
      for (var x = 0; x < w; x++) if (data[row + x]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  var api = {
    percentileSorted: percentileSorted, percentileHist: percentileHist, median: median, histOf: histOf,
    clamp8: clamp8, createOwner: createOwner, parseHexColor: parseHexColor, largestComponent: largestComponent,
    morph: morph, countNonZero: countNonZero, bboxOfMask: bboxOfMask
  };
  if (typeof module === 'object' && module.exports) module.exports = api; else NS.util = api;
})(typeof self !== 'undefined' ? self : this);
