/**
 * Catalog image pipeline defaults.
 *
 * FALLBACK copy of spec §11 `image` config. The authoritative copy is the main-process
 * `catalog/defaults.js` (merged with config.json); the renderer passes the effective
 * `getConfig().image` as `cfg` on every worker message (Phase 3b), so these values only apply
 * when a caller omits keys (tests, the CLI tools, the CSP smoke page).
 * test/image-save.test.js fails if this copy drifts from catalog/defaults.js.
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
