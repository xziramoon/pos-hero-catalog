/**
 * Pipeline steps (spec §8.2 / §8.3 / §12.1). Each step is
 *   { id, enabled(cfg, edit) -> bool, run(ctx) -> ctx }
 * ctx fields are documented in index.js. Mats are allocated through ctx.own()
 * so runPipeline's finally block frees whatever a step leaves behind; steps
 * free big intermediates early with ctx.drop().
 *
 * Working colour space is RGB (not BGR as in the Appendix A prototype); the
 * HSV/gray conversions use the RGB_ variants so the numbers are identical.
 */
(function (root) {
  'use strict';
  var NS = (root.CatalogPipeline = root.CatalogPipeline || {});
  var U = (typeof require === 'function' && typeof module === 'object') ? require('./util') : NS.util;

  var GC_BGD = 0, GC_FGD = 1, GC_PR_BGD = 2, GC_PR_FGD = 3;

  // ---------------------------------------------------------------- helpers

  function setImg(ctx, m) { if (ctx.img && ctx.img !== m) ctx.drop(ctx.img); ctx.img = m; return m; }
  function setMask(ctx, m) { if (ctx.mask && ctx.mask !== m) ctx.drop(ctx.mask); ctx.mask = m; return m; }
  function longSide(m) { return Math.max(m.cols, m.rows); }

  function thresholdMask(m) { // in place: >127 -> 255 else 0
    var d = m.data;
    for (var i = 0; i < d.length; i++) d[i] = d[i] > 127 ? 255 : 0;
    return m;
  }

  function rotateMat(cv, ctx, m, cx, cy, deg, interp, border) {
    var M = cv.getRotationMatrix2D(new cv.Point(cx, cy), deg, 1);
    var dst = ctx.own(new cv.Mat());
    try { cv.warpAffine(m, dst, M, new cv.Size(m.cols, m.rows), interp, border, new cv.Scalar(0, 0, 0, 0)); }
    finally { M.delete(); }
    return dst;
  }

  /** Largest external contour: {rect (minAreaRect), contourArea, hullArea}. null when mask is empty. */
  function shapeOf(cv, mask) {
    var contours = new cv.MatVector(), hier = new cv.Mat(), tmp = mask.clone();
    try {
      cv.findContours(tmp, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      var best = -1, bestA = -1;
      for (var i = 0; i < contours.size(); i++) {
        var c = contours.get(i), a = cv.contourArea(c);
        c.delete();
        if (a > bestA) { bestA = a; best = i; }
      }
      if (best < 0) return null;
      var cnt = contours.get(best), hull = new cv.Mat();
      try {
        var rect = cv.minAreaRect(cnt);
        cv.convexHull(cnt, hull, false, true);
        return { rect: rect, contourArea: bestA, hullArea: cv.contourArea(hull) };
      } finally { cnt.delete(); hull.delete(); }
    } finally { contours.delete(); hier.delete(); tmp.delete(); }
  }

  /** Tilt (deg) of a min-area rect normalised to [-45, 45]. */
  function normTilt(angle) { var a = ((angle % 90) + 90) % 90; return a > 45 ? a - 90 : a; }

  function drawStrokes(cv, target, edits, valueByMode) {
    for (var i = 0; i < edits.length; i++) {
      var e = edits[i], v = valueByMode[e.mode];
      if (v === undefined || !e.pts || !e.pts.length) continue;
      var r = Math.max(1, Math.round(e.r || 8)), col = new cv.Scalar(v, v, v, v), prev = null;
      for (var j = 0; j < e.pts.length; j++) {
        var p = new cv.Point(Math.round(e.pts[j][0]), Math.round(e.pts[j][1]));
        cv.circle(target, p, r, col, -1);
        if (prev) cv.line(target, prev, p, col, 2 * r);
        prev = p;
      }
    }
  }

  function strokeBBox(edits, mode, w, h) {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    edits.forEach(function (e) {
      if (e.mode !== mode || !e.pts) return;
      var r = e.r || 8;
      e.pts.forEach(function (p) {
        x0 = Math.min(x0, p[0] - r); x1 = Math.max(x1, p[0] + r);
        y0 = Math.min(y0, p[1] - r); y1 = Math.max(y1, p[1] + r);
      });
    });
    if (x1 < x0) return null;
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(w - 1, Math.ceil(x1)); y1 = Math.min(h - 1, Math.ceil(y1));
    return { x: x0, y: y0, w: Math.max(1, x1 - x0 + 1), h: Math.max(1, y1 - y0 + 1) };
  }

  function hasAddStroke(edit) {
    return (edit.maskEdits || []).some(function (e) { return e.mode === 'add' && e.pts && e.pts.length; });
  }

  function clampRect(x, y, w, h, W, H) {
    var x0 = Math.max(1, x), y0 = Math.max(1, y), x1 = Math.min(W - 1, x + w), y1 = Math.min(H - 1, y + h);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }
  function clipRect(r, W, H) {
    var x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(W, r.x + r.w), y1 = Math.min(H, r.y + r.h);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  // ------------------------------------------------------------------ steps

  /** 0. Build the source mat from RGBA input and apply manual rotation (edit.rotate, degrees clockwise). */
  var orient = {
    id: 'orient',
    enabled: function () { return true; },
    run: function (ctx) {
      var cv = ctx.cv, inp = ctx.input;
      var rgba = ctx.own(cv.matFromArray(inp.height, inp.width, cv.CV_8UC4, inp.data));
      var rgb = ctx.own(new cv.Mat());
      cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      ctx.drop(rgba);
      var a = (((ctx.edit.rotate || 0) % 360) + 360) % 360;
      if (a > 180) a -= 360;
      var q = Math.round(a / 90), fine = a - q * 90;
      q = ((q % 4) + 4) % 4;
      var cur = rgb;
      if (q) {
        var rot = ctx.own(new cv.Mat());
        cv.rotate(cur, rot, q === 1 ? cv.ROTATE_90_CLOCKWISE : q === 2 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE);
        ctx.drop(cur); cur = rot;
      }
      if (Math.abs(fine) > 0.01) {
        var f = rotateMat(cv, ctx, cur, cur.cols / 2, cur.rows / 2, -fine, cv.INTER_LINEAR, cv.BORDER_REPLICATE);
        ctx.drop(cur); cur = f;
      }
      ctx.src = cur;
      ctx.origLong = ctx.opts.origLong || longSide(cur);
      return ctx;
    }
  };

  /** 1. Downscale to analyzeMax (long side), never upscale. */
  var analyzeResize = {
    id: 'analyzeResize',
    enabled: function () { return true; },
    run: function (ctx) {
      var cv = ctx.cv, src = ctx.src, s = Math.min(1, ctx.cfg.analyzeMax / longSide(src));
      var img = ctx.own(new cv.Mat());
      if (s < 1) cv.resize(src, img, new cv.Size(Math.max(1, Math.floor(src.cols * s)), Math.max(1, Math.floor(src.rows * s))), 0, 0, cv.INTER_AREA);
      else src.copyTo(img);
      ctx.img = img;
      ctx.analyzeLong = longSide(img);
      ctx.analyzeW = img.cols; ctx.analyzeH = img.rows;
      ctx.scaleToAnalyze = 1;                    // working px per analyze px (1 until `upscale`)
      ctx.ppo = longSide(img) / ctx.origLong;    // working px per original px
      return ctx;
    }
  };

  /** 2+3. Background colour from the border + flat-background check. */
  var findBackground = {
    id: 'findBackground',
    enabled: function () { return true; },
    run: function (ctx) {
      var cv = ctx.cv, th = ctx.th, cfg = ctx.cfg, edit = ctx.edit;
      var brush = hasAddStroke(edit);
      if (!edit.bgRemove) { ctx.skipBg = true; ctx.busy = false; return ctx; }
      var img = ctx.img, w = img.cols, h = img.rows;
      var blur = ctx.own(new cv.Mat());
      cv.GaussianBlur(img, blur, new cv.Size(0, 0), th.edgeBlurSigma, th.edgeBlurSigma, cv.BORDER_DEFAULT);
      var e = Math.max(3, Math.floor(Math.min(h, w) * th.edgeBandFrac)), d = blur.data;
      var idx = [];
      function addRect(x0, y0, x1, y1) { for (var y = y0; y < y1; y++) for (var x = x0; x < x1; x++) idx.push((y * w + x) * 3); }
      // same four strips (corners counted twice) as the numpy prototype
      addRect(0, 0, w, e); addRect(0, h - e, w, h); addRect(0, 0, e, h); addRect(w - e, 0, w, h);
      var ref = [0, 1, 2].map(function (c) {
        var v = new Float64Array(idx.length);
        for (var i = 0; i < idx.length; i++) v[i] = d[idx[i] + c];
        v.sort();
        return U.median(v);
      });
      var ed = new Float64Array(idx.length);
      for (var i = 0; i < idx.length; i++) {
        var a = d[idx[i]] - ref[0], b = d[idx[i] + 1] - ref[1], c2 = d[idx[i] + 2] - ref[2];
        ed[i] = Math.sqrt(a * a + b * b + c2 * c2);
      }
      ed.sort();
      ctx.bgRef = ref; ctx.blur = blur;
      ctx.edgeP97 = U.percentileSorted(ed, th.edgeThrPercentile);
      ctx.edgeP90 = U.percentileSorted(ed, th.edgeBusyPercentile);
      ctx.busy = ctx.edgeP90 > cfg.edgeBusyThreshold;
      ctx.info.edgeP90 = ctx.edgeP90;
      // A flat background is not required when the user painted "add" strokes: they asked for a cut-out.
      ctx.skipBg = ctx.busy && !brush;
      if (ctx.skipBg) { ctx.drop(blur); ctx.blur = null; }
      return ctx;
    }
  };

  /** 4. Rough product box: colour distance from the background, open 3x3, biggest blob, +6%. */
  var roughBox = {
    id: 'roughBox',
    enabled: function (cfg, edit) { return !!edit.bgRemove; },
    run: function (ctx) {
      if (ctx.skipBg) return ctx;
      var cv = ctx.cv, cfg = ctx.cfg, th = ctx.th, img = ctx.img, w = img.cols, h = img.rows;
      if (ctx.busy) { // brush-forced cut-out on a busy background: box from the "add" strokes
        var sb = strokeBBox(ctx.edit.maskEdits, 'add', w, h);
        var pad0 = Math.floor(th.roughBoxPad * Math.max(sb.w, sb.h));
        ctx.roughBox = clampRect(sb.x - pad0, sb.y - pad0, sb.w + 2 * pad0, sb.h + 2 * pad0, w, h);
        return ctx;
      }
      var thr = Math.max(cfg.fgThresholdMin, ctx.edgeP97 * cfg.fgThresholdEdgeMul);
      var bd = ctx.blur.data, ref = ctx.bgRef, m = ctx.own(new cv.Mat(h, w, cv.CV_8UC1)), md = m.data;
      var thr2 = thr * thr;
      for (var i = 0, n = w * h; i < n; i++) {
        var a = bd[i * 3] - ref[0], b = bd[i * 3 + 1] - ref[1], c = bd[i * 3 + 2] - ref[2];
        md[i] = (a * a + b * b + c * c) > thr2 ? 1 : 0;
      }
      ctx.drop(ctx.blur); ctx.blur = null;
      var opened = U.morph(cv, ctx, m, cv.MORPH_OPEN, 3);
      ctx.drop(m);
      var big = U.largestComponent(cv, ctx, opened);
      ctx.drop(opened);
      if (!big) { ctx.skipBg = true; return ctx; }
      ctx.drop(big.mat);
      var pad = Math.floor(th.roughBoxPad * Math.max(big.w, big.h));
      // Same rect arithmetic as the Appendix A prototype (grabCut clips to the image itself).
      ctx.roughBox = { x: Math.max(1, big.x - pad), y: Math.max(1, big.y - pad), w: Math.min(w - 2, big.w + 2 * pad), h: Math.min(h - 2, big.h + 2 * pad) };
      return ctx;
    }
  };

  /**
   * 5. GrabCut (cfg.grabcutIters, rect init) -> biggest blob -> close 9x9.
   * Brush strokes (edit.maskEdits, analyze-size coordinates, i.e. the image
   * after manual rotate and before auto-straighten): after the rect pass the
   * labels get GC_FGD ("add") / GC_BGD ("erase") strokes painted on and GrabCut
   * is re-run with GC_INIT_WITH_MASK. Strokes are re-imposed on the final mask so
   * the user always wins over blob selection / closing.
   */
  var grabcut = {
    id: 'grabcut',
    enabled: function (cfg, edit) { return !!edit.bgRemove; },
    run: function (ctx) {
      if (ctx.skipBg || !ctx.roughBox) return ctx;
      var cv = ctx.cv, cfg = ctx.cfg, img = ctx.img, w = img.cols, h = img.rows, rb = ctx.roughBox;
      var edits = ctx.edit.maskEdits || [];
      var gm = ctx.own(new cv.Mat(h, w, cv.CV_8UC1, new cv.Scalar(GC_BGD)));
      var bgd = new cv.Mat(), fgd = new cv.Mat();
      try {
        var rect = new cv.Rect(rb.x, rb.y, rb.w, rb.h);
        if (ctx.busy) { // no distance-based prior: PR_BGD everywhere, PR_FGD inside the box
          gm.setTo(new cv.Scalar(GC_PR_BGD));
          var cr = clipRect(rb, w, h), roi = gm.roi(new cv.Rect(cr.x, cr.y, cr.w, cr.h));
          roi.setTo(new cv.Scalar(GC_PR_FGD));
          roi.delete();
        } else {
          cv.setRNGSeed(1234);
          cv.grabCut(img, gm, rect, bgd, fgd, cfg.grabcutIters, cv.GC_INIT_WITH_RECT);
        }
        if (edits.length) {
          drawStrokes(cv, gm, edits, { add: GC_FGD, erase: GC_BGD });
          cv.setRNGSeed(1234);
          cv.grabCut(img, gm, rect, bgd, fgd, cfg.grabcutIters, cv.GC_INIT_WITH_MASK);
        }
      } finally { bgd.delete(); fgd.delete(); }
      var bin = ctx.own(new cv.Mat(h, w, cv.CV_8UC1)), gd = gm.data, bdta = bin.data;
      for (var i = 0; i < gd.length; i++) bdta[i] = (gd[i] === GC_FGD || gd[i] === GC_PR_FGD) ? 255 : 0;
      ctx.drop(gm);
      var big = U.largestComponent(cv, ctx, bin);
      var cur = bin;
      if (big) { cur = big.mat; ctx.drop(bin); }
      var closed = U.morph(cv, ctx, cur, cv.MORPH_CLOSE, 9);
      ctx.drop(cur);
      if (edits.length) drawStrokes(cv, closed, edits, { add: 255, erase: 0 }); // user strokes have the last word
      if (U.countNonZero(closed.data) === 0) { ctx.drop(closed); ctx.skipBg = true; return ctx; }
      ctx.mask = closed;
      if (ctx.opts.debug) { ctx.debug.analyzeMask = new Uint8Array(closed.data); }
      return ctx;
    }
  };

  /**
   * §8.3 quality scoring + fallback decision. Runs right after GrabCut so a broken
   * mask can still be replaced by the rough-box crop (no bg removal) before the
   * image gets rotated. Pushes reason codes; the level is derived in index.js.
   * Codes: too_small (retake) | mask_area_low | mask_area_high | touches_edges |
   *        mask_broken | dark | tilt_too_large (pushed by `straighten`)
   */
  var assess = {
    id: 'assess',
    enabled: function () { return true; },
    run: function (ctx) {
      var cv = ctx.cv, th = ctx.th, cfg = ctx.cfg, img = ctx.img, w = img.cols, h = img.rows, info = ctx.info;
      var gray = ctx.own(new cv.Mat());
      cv.cvtColor(img, gray, cv.COLOR_RGB2GRAY);
      var productLongAnalyze, hist;
      if (ctx.mask) {
        var m = ctx.mask, md = m.data;
        var bb = U.bboxOfMask(md, w, h), area = U.countNonZero(md);
        productLongAnalyze = Math.max(bb.w, bb.h);
        info.maskArea = area;
        if (ctx.roughBox) {
          var ratio = area / (ctx.roughBox.w * ctx.roughBox.h);
          info.maskRatio = ratio;
          if (ratio < th.maskAreaMin) ctx.reasons.push('mask_area_low');
          if (ratio > th.maskAreaMax) ctx.reasons.push('mask_area_high');
        }
        var sides = (bb.x <= 1 ? 1 : 0) + (bb.y <= 1 ? 1 : 0) + (bb.x + bb.w >= w - 1 ? 1 : 0) + (bb.y + bb.h >= h - 1 ? 1 : 0);
        info.edgeSides = sides;
        if (sides > th.maxEdgeSides) ctx.reasons.push('touches_edges');
        var sh = shapeOf(cv, m);
        if (sh) {
          var solidity = sh.hullArea > 0 ? Math.min(1, area / sh.hullArea) : 1;
          info.solidity = solidity;
          if (solidity < th.solidityMin) { ctx.reasons.push('mask_broken'); ctx.fallback = true; }
        }
        hist = U.histOf(gray.data, 1, 0, md, true);
        if (ctx.fallback) { // broken mask: crop to the rough box, no bg removal
          setMask(ctx, null);
          ctx.cropRect = ctx.roughBox ? clipRect(ctx.roughBox, w, h) : null;
        }
      } else {
        productLongAnalyze = ctx.roughBox ? Math.max(ctx.roughBox.w, ctx.roughBox.h) : Math.max(w, h);
        hist = U.histOf(gray.data, 1, 0, null, true);
      }
      ctx.drop(gray);
      var p97 = U.percentileHist(hist.hist, hist.n, 97);
      info.p97Before = p97;
      if (p97 < th.darkP97) ctx.reasons.push('dark');
      var productPx = productLongAnalyze / ctx.ppo; // working px -> original px (ppo = working px per original px)
      info.productPx = Math.round(productPx);
      if (productPx < cfg.retakeMinProductPx) ctx.reasons.push('too_small');
      info.busy = !!ctx.busy; info.fallback = !!ctx.fallback; info.bgRemoved = !!ctx.mask;
      return ctx;
    }
  };

  /** 6. Straighten with minAreaRect when 2..25 degrees off (>25 is left to the human and flags `tilt_too_large`). */
  var straighten = {
    id: 'straighten',
    enabled: function (cfg, edit) { return !!edit.bgRemove && !!edit.autoStraighten; },
    run: function (ctx) {
      if (!ctx.mask) return ctx;
      var cv = ctx.cv, cfg = ctx.cfg;
      var sh = shapeOf(cv, ctx.mask);
      if (!sh) return ctx;
      var ang = normTilt(sh.rect.angle), cx = sh.rect.center.x, cy = sh.rect.center.y;
      ctx.info.tiltDeg = ang;
      var abs = Math.abs(ang);
      if (abs > cfg.maxAutoTiltDeg) { ctx.reasons.push('tilt_too_large'); return ctx; }
      if (!(abs > cfg.minAutoTiltDeg)) return ctx;
      // minAreaRect angle conventions differ between OpenCV versions, so pick the
      // rotation sign that actually reduces the residual tilt of the mask.
      var best = null;
      [ang, -ang].forEach(function (a) {
        var rm = rotateMat(cv, ctx, ctx.mask, cx, cy, a, cv.INTER_LINEAR, cv.BORDER_CONSTANT);
        thresholdMask(rm);
        var s2 = shapeOf(cv, rm), resid = s2 ? Math.abs(normTilt(s2.rect.angle)) : 99;
        if (!best || resid < best.resid - 1e-6) { if (best) ctx.drop(best.mask); best = { a: a, mask: rm, resid: resid }; }
        else ctx.drop(rm);
      });
      var rimg = rotateMat(cv, ctx, ctx.img, cx, cy, best.a, cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      var oldMask = ctx.mask;
      ctx.mask = best.mask; // oldMask is dropped below
      ctx.drop(oldMask);
      setImg(ctx, rimg);
      ctx.straighten = { angle: best.a, cx: cx, cy: cy };
      ctx.info.straightenedBy = best.a;
      return ctx;
    }
  };

  /** 7. Shadow removal (§8.2 step 7); result used only when > shadowKeepRatio of the old mask survives. */
  var removeShadow = {
    id: 'removeShadow',
    enabled: function (cfg, edit) { return !!edit.bgRemove; },
    run: function (ctx) {
      if (!ctx.mask) return ctx;
      var cv = ctx.cv, th = ctx.th, cfg = ctx.cfg, img = ctx.img, w = img.cols, h = img.rows;
      var hsv = ctx.own(new cv.Mat());
      cv.cvtColor(img, hsv, cv.COLOR_RGB2HSV);
      var md = ctx.mask.data, hd = hsv.data;
      var hs = U.histOf(hd, 3, 1, md, false), hv = U.histOf(hd, 3, 2, md, false);
      if (!hs.n) { ctx.drop(hsv); return ctx; }
      var bS = U.percentileHist(hs.hist, hs.n, 50), bV = U.percentileHist(hv.hist, hv.n, 50);
      var m2 = ctx.own(new cv.Mat(h, w, cv.CV_8UC1)), d2 = m2.data, area = 0, i;
      for (i = 0; i < md.length; i++) {
        if (!md[i]) { d2[i] = 0; continue; }
        area++;
        var S = hd[i * 3 + 1], V = hd[i * 3 + 2];
        var shadow = S < bS + th.shadowSatMargin && V < bV - th.shadowValHigh && V > bV * th.shadowValLow;
        d2[i] = shadow ? 0 : 255;
      }
      ctx.drop(hsv);
      var opened = U.morph(cv, ctx, m2, cv.MORPH_OPEN, 5);
      ctx.drop(m2);
      var big = U.largestComponent(cv, ctx, opened);
      ctx.drop(opened);
      if (!big) return ctx;
      var closed = U.morph(cv, ctx, big.mat, cv.MORPH_CLOSE, 15);
      ctx.drop(big.mat);
      var newArea = U.countNonZero(closed.data);
      if (newArea > cfg.shadowKeepRatio * area) { setMask(ctx, closed); ctx.info.shadowRemoved = true; }
      else ctx.drop(closed);
      return ctx;
    }
  };

  /**
   * `final` mode only: swap the analyze-size working image for the full-res source
   * and scale the analyze-size mask / straighten / crop up to it, so the heavy
   * steps below run at full resolution while GrabCut ran at analyze size.
   */
  var upscale = {
    id: 'upscale',
    enabled: function () { return true; },
    run: function (ctx) {
      var cv = ctx.cv;
      if (ctx.mode !== 'final' || (ctx.src.cols === ctx.img.cols && ctx.src.rows === ctx.img.rows)) return ctx;
      var sx = ctx.src.cols / ctx.img.cols, sy = ctx.src.rows / ctx.img.rows;
      var full = ctx.own(new cv.Mat());
      ctx.src.copyTo(full);
      if (ctx.straighten) {
        var r = rotateMat(cv, ctx, full, ctx.straighten.cx * sx, ctx.straighten.cy * sy, ctx.straighten.angle, cv.INTER_LINEAR, cv.BORDER_REPLICATE);
        ctx.drop(full); full = r;
      }
      if (ctx.mask) {
        var um = ctx.own(new cv.Mat());
        cv.resize(ctx.mask, um, new cv.Size(full.cols, full.rows), 0, 0, cv.INTER_LINEAR);
        thresholdMask(um);
        setMask(ctx, um);
      }
      if (ctx.cropRect) {
        var c = ctx.cropRect;
        ctx.cropRect = clipRect({ x: Math.floor(c.x * sx), y: Math.floor(c.y * sy), w: Math.ceil(c.w * sx), h: Math.ceil(c.h * sy) }, full.cols, full.rows);
      }
      setImg(ctx, full);
      ctx.scaleToAnalyze = longSide(full) / ctx.analyzeLong;
      ctx.ppo = longSide(full) / ctx.origLong;
      return ctx;
    }
  };

  /** 8. Gentle white balance from the background (per-channel gain clamped to cfg.wbGainClamp). */
  var whiteBalance = {
    id: 'whiteBalance',
    enabled: function (cfg, edit) { return !!edit.bgRemove; },
    run: function (ctx) {
      if (!ctx.mask) return ctx;
      var cfg = ctx.cfg, th = ctx.th, d = ctx.img.data, md = ctx.mask.data;
      var hs = [0, 1, 2].map(function (c) { return U.histOf(d, 3, c, md, false); });
      if (hs[0].n <= th.minWbBgPixels) return ctx;
      var g = hs.map(function (h) { return U.percentileHist(h.hist, h.n, 50); });
      var mean = (g[0] + g[1] + g[2]) / 3, lo = cfg.wbGainClamp[0], hi = cfg.wbGainClamp[1];
      var gain = g.map(function (v) { return Math.min(hi, Math.max(lo, mean / Math.max(v, 1))); });
      ctx.info.wbGain = gain;
      for (var i = 0; i < d.length; i += 3) {
        d[i] = Math.floor(U.clamp8(d[i] * gain[0]));
        d[i + 1] = Math.floor(U.clamp8(d[i + 1] * gain[1]));
        d[i + 2] = Math.floor(U.clamp8(d[i + 2] * gain[2]));
      }
      return ctx;
    }
  };

  /** 9. Exposure: if P97 of the product < 200, gain min(maxGain, target/P97) (no CLAHE!). Plus manual edit.brightness (gain 1 + b/100). */
  var exposure = {
    id: 'exposure',
    enabled: function () { return true; },
    run: function (ctx) {
      var cv = ctx.cv, cfg = ctx.cfg, th = ctx.th, img = ctx.img;
      var gray = ctx.own(new cv.Mat());
      cv.cvtColor(img, gray, cv.COLOR_RGB2GRAY);
      var hist;
      if (ctx.mask) hist = U.histOf(gray.data, 1, 0, ctx.mask.data, true);
      else if (ctx.cropRect) {
        var r = ctx.cropRect, roi = gray.roi(new cv.Rect(r.x, r.y, r.w, r.h)), rc = ctx.own(roi.clone());
        roi.delete();
        hist = U.histOf(rc.data, 1, 0, null, true);
        ctx.drop(rc);
      } else hist = U.histOf(gray.data, 1, 0, null, true);
      ctx.drop(gray);
      var p = U.percentileHist(hist.hist, hist.n, 97), gain = 1;
      if (p < th.exposureTriggerP97) gain = Math.min(cfg.exposureMaxGain, cfg.exposureTargetP97 / Math.max(p, 1));
      ctx.info.expGain = gain;
      var total = gain * (1 + (ctx.edit.brightness || 0) / 100);
      if (Math.abs(total - 1) > 1e-6) {
        var d = img.data;
        for (var i = 0; i < d.length; i++) d[i] = Math.floor(U.clamp8(d[i] * total));
      }
      return ctx;
    }
  };

  /** 10. Blend onto the tile colour with a feathered mask (sigma 1.6 @ analyze scale) and crop tight. No mask: crop to cropRect (fallback) or keep the whole image. */
  var composite = {
    id: 'composite',
    enabled: function () { return true; },
    run: function (ctx) {
      var cv = ctx.cv, cfg = ctx.cfg, img = ctx.img, w = img.cols, h = img.rows, out;
      if (ctx.mask) {
        var bb = U.bboxOfMask(ctx.mask.data, w, h);
        var sig = cfg.edgeFeatherSigma * ctx.scaleToAnalyze;
        var soft = ctx.own(new cv.Mat());
        cv.GaussianBlur(ctx.mask, soft, new cv.Size(0, 0), sig, sig, cv.BORDER_DEFAULT);
        var bg = ctx.bgColor, sd = soft.data, id = img.data;
        out = ctx.own(new cv.Mat(bb.h, bb.w, cv.CV_8UC3));
        var od = out.data;
        for (var y = 0; y < bb.h; y++) {
          for (var x = 0; x < bb.w; x++) {
            var pi = (y + bb.y) * w + (x + bb.x), s = sd[pi] / 255, o = (y * bb.w + x) * 3;
            od[o] = Math.floor(id[pi * 3] * s + bg[0] * (1 - s));
            od[o + 1] = Math.floor(id[pi * 3 + 1] * s + bg[1] * (1 - s));
            od[o + 2] = Math.floor(id[pi * 3 + 2] * s + bg[2] * (1 - s));
          }
        }
        ctx.drop(soft);
      } else if (ctx.cropRect) {
        var r = ctx.cropRect, roi = img.roi(new cv.Rect(r.x, r.y, r.w, r.h));
        out = ctx.own(roi.clone());
        roi.delete();
      } else {
        out = ctx.own(img.clone());
      }
      setImg(ctx, out);
      setMask(ctx, null);
      return ctx;
    }
  };

  /** 11. Unsharp: (1+a)*img - a*blur(sigma). a = edit.sharpen/100 (35 -> 1.35 / -0.35). Sigma scales with working resolution. */
  var sharpen = {
    id: 'sharpen',
    enabled: function (cfg, edit) { return (edit.sharpen || 0) > 0; },
    run: function (ctx) {
      var cv = ctx.cv, a = ctx.edit.sharpen / 100, sig = ctx.cfg.sharpenSigma * ctx.scaleToAnalyze;
      var blur = ctx.own(new cv.Mat()), out = ctx.own(new cv.Mat());
      cv.GaussianBlur(ctx.img, blur, new cv.Size(0, 0), sig, sig, cv.BORDER_DEFAULT);
      cv.addWeighted(ctx.img, 1 + a, blur, -a, 0, out);
      ctx.drop(blur);
      setImg(ctx, out);
      return ctx;
    }
  };

  /** 12. Lay out into square tiles. See the header of index.js for the crop {x,y,z} definition. */
  var fitTile = {
    id: 'fitTile',
    enabled: function () { return true; },
    run: function (ctx) {
      var cv = ctx.cv, cfg = ctx.cfg, img = ctx.img, bg = ctx.bgColor;
      var cap = cfg.maxUpscale / ctx.ppo; // max output px per working px (== maxUpscale vs the original)
      ctx.opts.variants.forEach(function (name) {
        var S = ctx.sizes[name], crop = (name === 'thumb' ? ctx.edit.thumbCrop : ctx.edit.fullCrop) || {};
        var z = crop.z > 0 ? crop.z : 1, cx = crop.x || 0, cy = crop.y || 0;
        var base = Math.min(cap, S * cfg.fill / Math.max(img.cols, img.rows));
        var k = base * z;
        if (k > cap) { k = cap; ctx.info.zoomClamped = ctx.info.zoomClamped || {}; ctx.info.zoomClamped[name] = true; }
        var nw = Math.max(1, Math.floor(img.cols * k)), nh = Math.max(1, Math.floor(img.rows * k));
        var scaled = ctx.own(new cv.Mat());
        cv.resize(img, scaled, new cv.Size(nw, nh), 0, 0, k < 1 ? cv.INTER_AREA : cv.INTER_CUBIC);
        var tile = new Uint8Array(S * S * 4), i;
        for (i = 0; i < tile.length; i += 4) { tile[i] = bg[0]; tile[i + 1] = bg[1]; tile[i + 2] = bg[2]; tile[i + 3] = 255; }
        var ox = Math.floor((S - nw) / 2) + Math.round(cx * S / 512), oy = Math.floor((S - nh) / 2) + Math.round(cy * S / 512);
        var sd = scaled.data;
        var x0 = Math.max(0, -ox), x1 = Math.min(nw, S - ox);
        for (var y = 0; y < nh; y++) {
          var ty = y + oy;
          if (ty < 0 || ty >= S) continue;
          for (var x = x0; x < x1; x++) {
            var s = (y * nw + x) * 3, t = (ty * S + x + ox) * 4;
            tile[t] = sd[s]; tile[t + 1] = sd[s + 1]; tile[t + 2] = sd[s + 2];
          }
        }
        ctx.drop(scaled);
        ctx.tiles[name] = { width: S, height: S, data: tile };
      });
      return ctx;
    }
  };

  var steps = [orient, analyzeResize, findBackground, roughBox, grabcut, assess, straighten, removeShadow, upscale, whiteBalance, exposure, composite, sharpen, fitTile];
  var api = { steps: steps };
  if (typeof module === 'object' && module.exports) module.exports = api; else NS.steps = api;
})(typeof self !== 'undefined' ? self : this);
