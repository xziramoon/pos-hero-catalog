'use strict';
// Single source of truth for catalog config (spec §11). Deep-merged with
// userData/catalog/config.json — never hardcode these values elsewhere.

const defaults = {
  worker: {
    url: '', key: '', writeToken: '', pollMsVisible: 5000, pollMsHidden: 60000,
    requestTimeoutMs: 20000, imageTimeoutMs: 60000, batchSize: 200, warnAfterMs: 180000
  },
  window: {
    hotkey: 'F2', width: 920, height: 752, minWidth: 640, minHeight: 520,
    dockSide: 'left', dockGap: 8, alwaysOnTop: true, bounds: null
  },
  grid: { slotW: 100, slotH: 126, tile: 88, gap: 8, showNames: true, nameLines: 1, bufferRows: 3 },
  copy: {
    // copyCode (default) | select | copyBarcode
    onSlotActivate: 'copyCode',
    toastMs: 1800, flash: true, enterCopiesSingleResult: true, playSound: false
  },
  tabs: { showNoImage: true, showNeedsCheck: true, showFavorites: true },
  image: {
    tileBg: '#f7f3ea', fill: 0.86, thumbSize: 512, fullSize: 1024, origMax: 2048, jpegQuality: 0.86,
    analyzeMax: 640,
    bgRemove: true, autoStraighten: true, maxAutoTiltDeg: 25, minAutoTiltDeg: 2,
    edgeBusyThreshold: 80, fgThresholdMin: 28, fgThresholdEdgeMul: 1.6,
    grabcutIters: 5, shadowKeepRatio: 0.55,
    wbGainClamp: [0.9, 1.1], exposureTargetP97: 225, exposureMaxGain: 2.0,
    sharpenAmount: 0.35, sharpenSigma: 1.0, edgeFeatherSigma: 1.6,
    retakeMinProductPx: 220, maxUpscale: 2.0
  },
  backup: { daily: true, keep: 14 }
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Objects merge recursively; arrays and scalars from `user` replace defaults.
function deepMerge(base, user) {
  if (!isPlainObject(base)) return user === undefined ? base : user;
  const out = {};
  for (const k of Object.keys(base)) {
    out[k] = isPlainObject(base[k]) ? deepMerge(base[k], isPlainObject(user) ? user[k] : undefined)
      : (isPlainObject(user) && user[k] !== undefined ? user[k] : base[k]);
  }
  if (isPlainObject(user)) {
    for (const k of Object.keys(user)) if (!(k in out)) out[k] = user[k];
  }
  return out;
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

module.exports = { defaults, deepMerge, getDefaults: () => clone(defaults) };
