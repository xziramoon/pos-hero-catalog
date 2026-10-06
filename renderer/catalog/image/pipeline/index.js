/**
 * Catalog image pipeline (spec §8, §12.1). Pure functions of (cv, image, cfg, edit):
 * no DOM, no Worker globals, no Node-only APIs -> loads in a Web Worker via
 * importScripts('pipeline/defaults-image.js','pipeline/util.js','pipeline/steps.js','pipeline/index.js')
 * (then use self.CatalogPipeline) and in Node via require('.../pipeline').
 *
 * ---------------------------------------------------------------------------
 * API
 *
 *   const P = require('.../pipeline');
 *   P.steps                 // [{ id, enabled(cfg, edit) -> bool, run(ctx) -> ctx }, ...] in run order:
 *                           // orient, analyzeResize, findBackground, roughBox, grabcut, assess,
 *                           // straighten, removeShadow, upscale, whiteBalance, exposure,
 *                           // composite, sharpen, fitTile
 *   P.runPipeline(cv, rgbaImage, cfg, edit, opts) -> result
 *   P.normalizeEdit(edit, cfg) -> full edit object (defaults filled in)
 *   P.imageDefaults         // spec §11 `image` (copy; see defaults-image.js)
 *   P.PIPELINE_VERSION      // 1  (== edit.pipelineVersion)
 *
 *   rgbaImage : { data: Uint8Array|Uint8ClampedArray (RGBA, w*h*4), width, height }
 *               EXIF orientation must already be applied (createImageBitmap
 *               imageOrientation:'from-image'). For `final` this is the orig (<= origMax).
 *   cfg       : spec §11 `image` object (missing keys fall back to defaults).
 *   edit      : spec §8.4 `image.edit` (missing keys fall back to defaults).
 *   opts      : { mode: 'final'|'preview' (default 'final'),
 *                 variants: ['thumb','full'] (subset; default both),
 *                 sizes: { thumb, full } output sizes in px (default cfg.thumbSize/fullSize;
 *                        preview default: thumb cfg.thumbSize, full cfg.analyzeMax),
 *                 origLong: long side of the ORIGINAL (<= origMax) image in px. Only needed
 *                        in preview when rgbaImage was pre-downscaled; used for the
 *                        retake test and the maxUpscale cap. Default: long side of rgbaImage,
 *                 debug: true -> result.debug = { analyzeMask } (Uint8Array 0/255, analyzeW*analyzeH),
 *                 shouldCancel: () => bool, checked between steps (throws Error('cancelled')) }
 *
 *   result    : { quality: 'ok'|'check'|'retake', reasons: string[],
 *                 tiles: { thumb?: {width,height,data:Uint8Array RGBA}, full?: ... },
 *                 info: { mode, busy, fallback, bgRemoved, productPx, maskRatio, solidity,
 *                         edgeSides, p97Before, tiltDeg, straightenedBy, shadowRemoved,
 *                         wbGain, expGain, zoomClamped?, analyzeW, analyzeH },
 *                 edit: normalised edit actually used,
 *                 debug? }
 *
 *   Reason codes (§8.3): too_small -> retake; check: mask_area_low | mask_area_high |
 *   touches_edges | mask_broken (also triggers the no-bg-removal fallback) | dark |
 *   tilt_too_large. quality is 'retake' if too_small, else 'check' if any reason, else 'ok'.
 *
 * Modes
 *   preview : everything runs on the analyze-size image (<= cfg.analyzeMax, long side).
 *   final   : analysis steps (background, GrabCut, assess, straighten angle, shadow) run at
 *             analyze size; then `upscale` swaps in the full-res image, scales the mask up
 *             (bilinear, re-thresholded) and re-applies the straighten rotation; the remaining
 *             steps (white balance, exposure, composite, sharpen, fitTile) run at full-res.
 *   Both are deterministic for identical (image, cfg, edit) (GrabCut RNG is re-seeded).
 *
 * Coordinate spaces
 *   edit.maskEdits  : [{ mode:'add'|'erase', r, pts:[[x,y],...] }] in ANALYZE-SIZE pixels of the
 *                     image AFTER manual rotation (edit.rotate) and BEFORE auto-straighten
 *                     (the image GrabCut sees; its size is info.analyzeW x info.analyzeH).
 *                     Painted onto the GrabCut label mask as GC_FGD (add) / GC_BGD (erase) and
 *                     GrabCut is re-run with GC_INIT_WITH_MASK. A brush "add" stroke also
 *                     forces a cut-out on a "busy" (non-flat) background.
 *   edit.rotate     : degrees CLOCKWISE (any value; = nearest 90 multiple + fine part, fine
 *                     part rotated with replicate borders). Applied before analysis.
 *
 * thumbCrop / fullCrop  { x, y, z }   (one per output variant; default {0,0,1})
 *   The "content" is the cropped product image (tight product box on tile colour, or the
 *   rough box / whole photo when no background was removed). With z = 1, x = y = 0 the
 *   content is scaled so its long side is cfg.fill (0.86) of the tile and centred.
 *     z : zoom factor relative to that default fit (z = 2.7 -> 2.7x larger), applied about
 *         the content centre.
 *     x, y : pan of the content centre away from the tile centre, in tile pixels at the
 *         512-px reference scale (a 1024 tile multiplies them by 2), +x right, +y down.
 *   Output parts outside the tile are cut; uncovered tile area is cfg.tileBg.
 *   Total scale (default fit * z) is capped so the content is never enlarged more than
 *   cfg.maxUpscale relative to the ORIGINAL photo pixels; if the cap bites,
 *   info.zoomClamped[variant] = true.
 *
 * Memory: every cv.Mat is registered with the run's owner and freed in `finally`.
 * ---------------------------------------------------------------------------
 */
(function (root) {
  'use strict';
  var NS = (root.CatalogPipeline = root.CatalogPipeline || {});
  var isNode = typeof require === 'function' && typeof module === 'object';
  var D = isNode ? require('./defaults-image') : NS.defaults;
  var U = isNode ? require('./util') : NS.util;
  var S = isNode ? require('./steps') : NS.steps;

  var PIPELINE_VERSION = 1;

  function normalizeEdit(edit, cfg) {
    cfg = D.mergeImageCfg(cfg);
    var e = edit || {};
    function crop(c) { return { x: +(c && c.x) || 0, y: +(c && c.y) || 0, z: (c && +c.z > 0) ? +c.z : 1 }; }
    return {
      pipelineVersion: PIPELINE_VERSION,
      bgRemove: e.bgRemove === undefined ? !!cfg.bgRemove : !!e.bgRemove,
      autoStraighten: e.autoStraighten === undefined ? !!cfg.autoStraighten : !!e.autoStraighten,
      rotate: +e.rotate || 0,
      brightness: Math.max(-50, Math.min(50, +e.brightness || 0)),
      sharpen: e.sharpen === undefined ? Math.round(cfg.sharpenAmount * 100) : Math.max(0, Math.min(100, +e.sharpen || 0)),
      maskEdits: Array.isArray(e.maskEdits) ? e.maskEdits : [],
      thumbCrop: crop(e.thumbCrop),
      fullCrop: crop(e.fullCrop)
    };
  }

  function levelOf(reasons) {
    if (reasons.indexOf('too_small') >= 0) return 'retake';
    return reasons.length ? 'check' : 'ok';
  }

  function runPipeline(cv, rgbaImage, cfg, edit, opts) {
    cfg = D.mergeImageCfg(cfg);
    opts = opts || {};
    var mode = opts.mode === 'preview' ? 'preview' : 'final';
    var variants = (opts.variants || ['thumb', 'full']).filter(function (v) { return v === 'thumb' || v === 'full'; });
    var sizes = Object.assign(
      mode === 'preview' ? { thumb: cfg.thumbSize, full: cfg.analyzeMax } : { thumb: cfg.thumbSize, full: cfg.fullSize },
      opts.sizes || {});
    var owner = U.createOwner();
    var ed = normalizeEdit(edit, cfg);
    var ctx = {
      cv: cv, cfg: cfg, edit: ed, th: D.thresholds, mode: mode,
      opts: { variants: variants, origLong: opts.origLong, debug: !!opts.debug },
      sizes: sizes, input: rgbaImage, bgColor: U.parseHexColor(cfg.tileBg),
      own: owner.own, drop: owner.drop,
      src: null, img: null, mask: null, reasons: [], info: { mode: mode }, tiles: {}, debug: {},
      skipBg: false, busy: false, fallback: false, roughBox: null, cropRect: null, straighten: null
    };
    try {
      for (var i = 0; i < S.steps.length; i++) {
        if (opts.shouldCancel && opts.shouldCancel()) throw new Error('cancelled');
        var step = S.steps[i];
        if (step.enabled(cfg, ed)) ctx = step.run(ctx);
      }
      ctx.info.analyzeW = ctx.analyzeW; ctx.info.analyzeH = ctx.analyzeH;
      var result = {
        quality: levelOf(ctx.reasons), reasons: ctx.reasons.slice(), tiles: ctx.tiles, info: ctx.info, edit: ed
      };
      if (opts.debug) result.debug = ctx.debug;
      return result;
    } finally {
      owner.disposeAll();
    }
  }

  var api = {
    steps: S.steps, runPipeline: runPipeline, normalizeEdit: normalizeEdit,
    imageDefaults: D.imageDefaults, thresholds: D.thresholds, mergeImageCfg: D.mergeImageCfg,
    PIPELINE_VERSION: PIPELINE_VERSION, _levelOf: levelOf
  };
  if (isNode) module.exports = api; else NS.index = api;
})(typeof self !== 'undefined' ? self : this);
