/**
 * Synthetic photo fixtures for the catalog image pipeline (spec section 13 table).
 *
 *   node test/fixtures/make-synthetic.js [outdir]   -> writes <name>.jpg files
 *   require('./make-synthetic').makeAll()           -> { name: {width,height,data(RGBA),expect} }
 *
 * Everything is procedural + seeded, so output is identical on every run.
 * `expect.quality` lists the acceptable quality levels (spec section 13).
 */
'use strict';
const fs = require('fs');
const path = require('path');

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w, h, fn) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fn(x, y), o = (y * w + x) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** signed distance to a rounded box centred at origin (half sizes hw, hh, corner radius r) */
function sdBox(px, py, hw, hh, r) {
  const qx = Math.abs(px) - hw + r, qy = Math.abs(py) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * Draw a bottle-like product (body + cap + label with text blocks), rotated by
 * `deg` (clockwise on screen), with an optional soft cast shadow.
 */
function drawProduct(img, o) {
  const { cx, cy, w, h, deg = 0, body = [200, 60, 90], label = [245, 240, 225], cap = [40, 40, 50], shadow = 0.25, seed = 7 } = o;
  const rnd = rng(seed), blocks = [];
  for (let i = 0; i < 9; i++) blocks.push([(rnd() - 0.5) * 0.7, (i - 4) * 0.075 + 0.02, 0.1 + rnd() * 0.3, 0.025, [rnd() * 120, rnd() * 120, rnd() * 160]]);
  const th = deg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th), hw = w / 2, hh = h / 2;
  const x0 = Math.max(0, Math.floor(cx - w - h)), x1 = Math.min(img.width, Math.ceil(cx + w + h));
  const y0 = Math.max(0, Math.floor(cy - w - h)), y1 = Math.min(img.height, Math.ceil(cy + w + h));
  const d = img.data;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o4 = (y * img.width + x) * 4;
      if (shadow > 0) {
        const sx = x - cx - 0.04 * h, sy = y - cy - 0.03 * h;
        const sl = sx * c + sy * s, sm = -sx * s + sy * c;
        const sd = sdBox(sl, sm, hw, hh, w * 0.12);
        const a = shadow * Math.max(0, Math.min(1, 1 - sd / (0.035 * h)));
        if (a > 0) for (let k = 0; k < 3; k++) d[o4 + k] = clamp(d[o4 + k] * (1 - a));
      }
      const dx = x - cx, dy = y - cy, lx = dx * c + dy * s, ly = -dx * s + dy * c;
      const sd = sdBox(lx, ly, hw, hh, w * 0.12);
      const cov = Math.max(0, Math.min(1, 0.5 - sd));
      if (cov <= 0) continue;
      const u = lx / hw, v = ly / hh; // -1..1
      let col = body;
      const shade = 1 - 0.28 * u * u; // cylinder-ish shading
      if (v < -0.8) col = cap;
      else if (v > -0.55 && v < 0.5) {
        col = label;
        const tx = u * 0.5, ty = v + 0.05;
        for (const b of blocks) if (Math.abs(tx - b[0]) < b[2] && Math.abs(ty - b[1]) < b[3]) col = b[4];
      }
      for (let k = 0; k < 3; k++) {
        const val = clamp(col[k] * shade);
        d[o4 + k] = d[o4 + k] * (1 - cov) + val * cov;
      }
    }
  }
}

function addNoise(img, amp, seed) {
  const r = rng(seed), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() + r() + r() - 1.5) * amp;
    d[i] = clamp(d[i] + n); d[i + 1] = clamp(d[i + 1] + n); d[i + 2] = clamp(d[i + 2] + n);
  }
}

function flatBg(w, h, color, vign) {
  return canvas(w, h, (x, y) => {
    const g = 1 - vign * (((x / w - 0.5) ** 2 + (y / h - 0.5) ** 2) * 2);
    return [color[0] * g, color[1] * g, color[2] * g];
  });
}

function woodBg(w, h, seed) {
  const r = rng(seed), phase = [], base = [150, 105, 62];
  for (let i = 0; i < 40; i++) phase.push(r() * 6.28);
  return canvas(w, h, (x, y) => {
    const band = Math.floor(y / 46), t = (y % 46) / 46;
    const grain = Math.sin(x * 0.012 + phase[band % 40] + Math.sin(y * 0.08) * 0.8) * 0.5 + 0.5;
    const k = 0.82 + 0.28 * grain - 0.18 * (t < 0.04 ? 1 : 0) + 0.04 * Math.sin(band * 1.7);
    return [base[0] * k, base[1] * k, base[2] * k];
  });
}

function labelBg(w, h) { // close-up: busy artwork fills the whole frame
  const r = rng(99);
  const img = canvas(w, h, (x, y) => mix([230, 60, 70], [250, 200, 60], (x / w + y / h) / 2));
  for (let i = 0; i < 45; i++) {
    const bw = 40 + r() * 220, bh = 18 + r() * 60, bx = r() * w - 20, by = r() * h - 20, col = [r() * 255, r() * 255, r() * 255];
    for (let y = Math.max(0, by | 0); y < Math.min(h, by + bh); y++) {
      for (let x = Math.max(0, bx | 0); x < Math.min(w, bx + bw); x++) {
        const o = (y * w + x) * 4; img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2];
      }
    }
  }
  return img;
}

function makeAll() {
  const out = {};
  // 1. web photo, white bg, small product
  let im = flatBg(800, 800, [252, 252, 252], 0.01);
  drawProduct(im, { cx: 400, cy: 410, w: 150, h: 330, body: [90, 160, 210], shadow: 0 });
  addNoise(im, 2, 1);
  out['web-white'] = { ...im, expect: { quality: ['ok'] } };

  // 2. phone photo on a table, product tilted ~12 deg, with shadow
  im = flatBg(1600, 1200, [205, 200, 192], 0.08);
  drawProduct(im, { cx: 800, cy: 620, w: 300, h: 640, deg: 12, body: [215, 110, 140], shadow: 0.3, seed: 3 });
  addNoise(im, 5, 2);
  out['phone-tilted'] = { ...im, expect: { quality: ['ok'], straighten: true } };

  // 3. wooden counter, landscape
  im = woodBg(1600, 1000, 5);
  drawProduct(im, { cx: 800, cy: 500, w: 330, h: 600, body: [235, 235, 240], label: [60, 120, 70], cap: [200, 200, 205], shadow: 0.3, seed: 11 });
  addNoise(im, 4, 3);
  out['counter-landscape'] = { ...im, expect: { quality: ['ok'] } };

  // 4. dark
  im = flatBg(1200, 900, [38, 36, 34], 0.15);
  drawProduct(im, { cx: 600, cy: 450, w: 260, h: 520, body: [70, 40, 45], label: [88, 84, 74], cap: [24, 24, 26], shadow: 0.2, seed: 5 });
  addNoise(im, 9, 4);
  out['dark'] = { ...im, expect: { quality: ['check', 'ok'], reasonsInclude: ['dark'] } };

  // 5. sideways: lying on its side (125 deg = 90 + 35 residual tilt), no EXIF
  im = flatBg(1400, 1000, [225, 222, 215], 0.06);
  drawProduct(im, { cx: 700, cy: 500, w: 260, h: 560, deg: 125, body: [60, 130, 90], shadow: 0.25, seed: 9 });
  addNoise(im, 4, 5);
  out['sideways'] = { ...im, expect: { quality: ['check'], reasonsInclude: ['tilt_too_large'] } };

  // 6. close-up of a label: busy artwork to the edges
  im = labelBg(1000, 1000);
  addNoise(im, 3, 6);
  out['closeup-label'] = { ...im, expect: { quality: ['ok'], busy: true } };

  // 7. tight, tall, thin crop
  im = flatBg(420, 1100, [244, 244, 244], 0);
  drawProduct(im, { cx: 210, cy: 550, w: 290, h: 1050, body: [220, 190, 60], shadow: 0, seed: 13 });
  addNoise(im, 2, 7);
  out['tall-tight'] = { ...im, expect: { quality: ['ok'] } };

  // 8. far away, small product
  im = flatBg(2000, 1500, [210, 206, 198], 0.08);
  drawProduct(im, { cx: 1000, cy: 800, w: 70, h: 150, body: [200, 80, 60], shadow: 0.25, seed: 17 });
  addNoise(im, 5, 8);
  out['far-small'] = { ...im, expect: { quality: ['retake', 'check'] } };
  return out;
}

function writeAll(dir) {
  const jpeg = require('jpeg-js');
  fs.mkdirSync(dir, { recursive: true });
  const all = makeAll();
  for (const [name, img] of Object.entries(all)) {
    const enc = jpeg.encode({ data: Buffer.from(img.data), width: img.width, height: img.height }, 92);
    fs.writeFileSync(path.join(dir, name + '.jpg'), enc.data);
  }
  return Object.keys(all);
}

module.exports = { makeAll, writeAll };

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || path.join(__dirname, 'synthetic'));
  console.log('wrote', writeAll(dir).join(', '), 'to', dir);
}
