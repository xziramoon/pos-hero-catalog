'use strict';
// First pass vs reprocess consistency (real OpenCV worker in Electron):
//   HARNESS_FIXTURES=1 HARNESS_STEPS=test/electron/catalog-harness/steps/consistency.js npm run harness:catalog
// (unset ELECTRON_RUN_AS_NODE). For every synthetic fixture: process(file) and process(thatOrig, isOrig) must give the same
// hash, quality, reasons and the same thumb/full bytes size class. Exits non-zero (throws) on any difference.
const fs = require('fs');
const path = require('path');

module.exports = async (h) => {
  const files = fs.readdirSync(h.fixturesDir).filter((f) => /\.jpe?g$/i.test(f)).sort();
  if (!files.length) throw new Error('no fixtures (set HARNESS_FIXTURES=1)');
  const bad = [];
  for (const f of files) {
    const b64 = fs.readFileSync(path.join(h.fixturesDir, f)).toString('base64');
    const r = await h.js(`(async () => {
      const PE = window.CatalogPhotoEditor, cfg = (await window.catalogAPI.getConfig()).image;
      const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const a = await PE.processFile(new Blob([bin], { type: 'image/jpeg' }), cfg);
      const b = await PE.processFile(a.orig, cfg, { isOrig: true, edit: a.edit });
      return { first: { q: a.quality, r: a.reasons, hash: a.hash, tw: a.thumb.size }, again: { q: b.quality, r: b.reasons, hash: b.hash, tw: b.thumb.size } };
    })()`);
    const same = r.first.q === r.again.q && JSON.stringify(r.first.r) === JSON.stringify(r.again.r) && r.first.hash === r.again.hash && r.first.tw === r.again.tw;
    h.log((same ? 'SAME ' : 'DIFF ') + f.padEnd(28) + r.first.q + '/' + r.again.q + ' ' + JSON.stringify(r.first.r) + (same ? '' : ' vs ' + JSON.stringify(r.again.r) + ' thumbBytes ' + r.first.tw + '/' + r.again.tw));
    if (!same) bad.push(f);
  }
  if (bad.length) throw new Error('first pass and reprocess differ for: ' + bad.join(', '));
  h.log('CONSISTENCY OK (' + files.length + ' fixtures)');
};
