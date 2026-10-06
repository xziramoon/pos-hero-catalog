/**
 * Node-only helper: load the vendored OpenCV.js and resolve once the WASM
 * runtime is ready. Cached. Used by tests and tools/run-on-file.js.
 */
'use strict';
const path = require('path');
let cached = null;

function loadCv() {
  if (cached) return cached;
  cached = (async () => {
    let cv = require(path.join(__dirname, '..', '..', 'vendor', 'opencv.js'));
    if (cv && typeof cv.then === 'function') cv = await cv; // Promise-returning build
    if (!cv.Mat) await new Promise((res) => { cv.onRuntimeInitialized = res; });
    return cv;
  })();
  return cached;
}

module.exports = { loadCv };
