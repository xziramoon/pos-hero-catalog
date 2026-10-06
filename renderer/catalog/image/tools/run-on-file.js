/**
 * Dev CLI: run the catalog image pipeline on a photo and write the tiles so a
 * human can eyeball them.
 *
 *   node renderer/catalog/image/tools/run-on-file.js in.jpg outdir/ [--edit '{"rotate":90}'] [--preview] [--cfg '{...}']
 *
 * Writes <outdir>/<name>-thumb.png, <name>-full.png, <name>-thumb.jpg, and prints
 * quality / reasons / info. EXIF orientation is NOT applied here (jpeg-js ignores it);
 * pass --edit '{"rotate":90}' to emulate. Input is downscaled to origMax like the worker does.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadCv } = require('./load-cv');
const P = require('../pipeline');

function decode(file) {
  const buf = fs.readFileSync(file);
  if (/\.png$/i.test(file)) {
    const { PNG } = require('pngjs');
    const p = PNG.sync.read(buf);
    return { width: p.width, height: p.height, data: new Uint8Array(p.data) };
  }
  const jpeg = require('jpeg-js');
  const j = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
  return { width: j.width, height: j.height, data: j.data };
}

/** Box-filter downscale so the long side is <= max (dev stand-in for the worker's canvas downscale). */
function downscale(img, max) {
  const s = max / Math.max(img.width, img.height);
  if (s >= 1) return img;
  const w = Math.round(img.width * s), h = Math.round(img.height * s), out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y / s), y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) / s)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / s), x1 = Math.max(x0 + 1, Math.min(img.width, Math.floor((x + 1) / s)));
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const o = (yy * img.width + xx) * 4;
        acc[0] += img.data[o]; acc[1] += img.data[o + 1]; acc[2] += img.data[o + 2]; acc[3] += img.data[o + 3]; n++;
      }
      const o2 = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) out[o2 + k] = acc[k] / n;
    }
  }
  return { width: w, height: h, data: out };
}

function writeTiles(result, outdir, name) {
  const { PNG } = require('pngjs');
  const jpeg = require('jpeg-js');
  fs.mkdirSync(outdir, { recursive: true });
  const files = [];
  for (const [variant, t] of Object.entries(result.tiles)) {
    const png = new PNG({ width: t.width, height: t.height });
    Buffer.from(t.data).copy(png.data);
    const pf = path.join(outdir, `${name}-${variant}.png`);
    fs.writeFileSync(pf, PNG.sync.write(png));
    files.push(pf);
    const jf = path.join(outdir, `${name}-${variant}.jpg`);
    fs.writeFileSync(jf, jpeg.encode({ data: Buffer.from(t.data), width: t.width, height: t.height }, 86).data);
    files.push(jf);
  }
  return files;
}

async function main(argv) {
  const args = argv.slice(2), pos = [];
  let edit = {}, cfg = {}, mode = 'final';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--edit') edit = JSON.parse(args[++i]);
    else if (args[i] === '--cfg') cfg = JSON.parse(args[++i]);
    else if (args[i] === '--preview') mode = 'preview';
    else pos.push(args[i]);
  }
  if (pos.length < 2) { console.error('usage: run-on-file.js in.jpg outdir/ [--edit json] [--cfg json] [--preview]'); process.exit(2); }
  const cv = await loadCv();
  const full = cfg.origMax || P.imageDefaults.origMax;
  const img = downscale(decode(pos[0]), full);
  let input = img, opts = { mode };
  if (mode === 'preview') {
    input = downscale(img, cfg.analyzeMax || P.imageDefaults.analyzeMax);
    opts.origLong = Math.max(img.width, img.height);
  }
  const t0 = Date.now();
  const r = P.runPipeline(cv, input, cfg, edit, opts);
  const name = path.basename(pos[0]).replace(/\.[^.]+$/, '');
  const files = writeTiles(r, pos[1], name);
  console.log(JSON.stringify({ file: pos[0], mode, ms: Date.now() - t0, quality: r.quality, reasons: r.reasons, info: r.info }, null, 1));
  console.log('wrote:\n  ' + files.join('\n  '));
}

if (require.main === module) main(process.argv).catch((e) => { console.error(e); process.exit(1); });
module.exports = { decode, downscale, writeTiles };
