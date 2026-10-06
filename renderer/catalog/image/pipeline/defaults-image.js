/**
 * Catalog image pipeline defaults.
 *
 * COPY of spec §11 `image` config. The authoritative copy lives in the main
 * process `catalog/defaults.js`; it is duplicated here so the Web Worker (which
 * cannot require main-process code) works standalone.
 * TODO(Phase 3b): dedupe — have the renderer pass `config.image` into the worker
 * on every message (the worker already accepts `cfg` per message) and drop this
 * file, or generate it from catalog/defaults.js at build time.
 *
 * `thresholds` holds the few constants spec §8.2/§8.3 give as literals rather
 * than as config keys (kept out of `image` so that object matches §11 exactly).
 */
(function (root) {
  'use strict';
  var NS = (root.CatalogPipeline = root.CatalogPipeline || {});

  var imageDefaults = {
    tileBg: '#f7f3ea', fill: 0.86, thumbSize: 512, fullSize: 1024, origMax: 2048, jpegQuality: 0.86,
    analyzeMax: 640,
    bgRemove: true, autoStraighten: true, maxAutoTiltDeg: 25, minAutoTiltDeg: 2,
    edgeBusyThreshold: 80, fgThresholdMin: 28, fgThresholdEdgeMul: 1.6,
    grabcutIters: 5, shadowKeepRatio: 0.55,
    wbGainClamp: [0.9, 1.1], exposureTargetP97: 225, exposureMaxGain: 2.0,
    sharpenAmount: 0.35, sharpenSigma: 1.0, edgeFeatherSigma: 1.6,
    retakeMinProductPx: 220, maxUpscale: 2.0
  };

  var thresholds = {
    edgeBandFrac: 0.04,        // §8.2 step 2: border band thickness
    edgeBlurSigma: 3,          // §8.2 step 2
    edgeBusyPercentile: 90,    // §8.2 step 3
    edgeThrPercentile: 97,     // §8.2 step 4
    roughBoxPad: 0.06,         // §8.2 step 4
    shadowSatMargin: 18,       // §8.2 step 7
    shadowValLow: 0.35,
    shadowValHigh: 8,
    exposureTriggerP97: 200,   // §8.2 step 9 / Appendix A
    maskAreaMin: 0.08,         // §8.3
    maskAreaMax: 0.92,
    maxEdgeSides: 2,
    solidityMin: 0.75,
    darkP97: 120,
    minWbBgPixels: 500
  };

  function mergeImageCfg(cfg) {
    var out = {}, k;
    for (k in imageDefaults) out[k] = imageDefaults[k];
    if (cfg) for (k in cfg) if (cfg[k] !== undefined) out[k] = cfg[k];
    return out;
  }

  var api = { imageDefaults: imageDefaults, thresholds: thresholds, mergeImageCfg: mergeImageCfg };
  if (typeof module === 'object' && module.exports) module.exports = api; else NS.defaults = api;
})(typeof self !== 'undefined' ? self : this);
