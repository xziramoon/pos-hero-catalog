# Vendored third-party code (catalog)

## opencv.js

- Source: npm `@techstark/opencv-js@5.0.0-release.1`, file `dist/opencv.js`
  (unmodified; OpenCV 5.0.0 compiled to WebAssembly with the wasm embedded in the
  single JS file, so it works offline and needs no `.wasm` fetch).
- License: **Apache-2.0** (OpenCV >= 4.5; wrapper package also Apache-2.0).
  <https://github.com/opencv/opencv/blob/master/LICENSE>, <https://github.com/TechStark/opencv-js>
- Size: ~13 MB. Loaded only inside `image/image-worker.js` via `importScripts('../vendor/opencv.js')`.
  CSP needs `'wasm-unsafe-eval'` (already in docs/catalog-contracts.md).
- Verified present (checked by test/pipeline.test.js running the whole pipeline on it):
  grabCut, minAreaRect, findContours, convexHull, connectedComponentsWithStats,
  morphologyEx, warpAffine, GaussianBlur, cvtColor, addWeighted, getRotationMatrix2D,
  resize, contourArea, setRNGSeed.
- Upgrade: `npm i --no-save @techstark/opencv-js@<ver>` in a scratch dir, copy
  `dist/opencv.js` here, run `npm test`.
