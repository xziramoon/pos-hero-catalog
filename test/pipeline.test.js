/**
 * Catalog image pipeline tests (Node, vendored OpenCV.js, plain node:assert).
 *   - 8 synthetic fixtures (spec section 13) with expected quality
 *   - real photos from test/fixtures/photos/ are picked up automatically if present
 *   - determinism, preview vs final, brush strokes, crops, upscale cap, rotate,
 *     bgRemove off, step list shape, memory growth
 */
'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { loadCv } = require('../renderer/catalog/image/tools/load-cv');
const { decode, downscale } = require('../renderer/catalog/image/tools/run-on-file');
const P = require('../renderer/catalog/image/pipeline');
const { makeAll } = require('./fixtures/make-synthetic');

const BG = [0xf7, 0xf3, 0xea];
const results = [];

/** bbox of tile pixels that differ from the tile colour */
function contentBox(tile, tol = 14) {
  const { width: w, height: h, data: d } = tile;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (Math.abs(d[o] - BG[0]) + Math.abs(d[o + 1] - BG[1]) + Math.abs(d[o + 2] - BG[2]) > tol) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}
function meanAbsDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.data.length; i += 4) s += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
  return s / (a.data.length / 4) / 3;
}
function same(a, b) { return Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0; }
function heapBytes(cv) { const m = new cv.Mat(1, 1, cv.CV_8UC1); const n = m.data.buffer.byteLength; m.delete(); return n; }

const NOPE = { thumbCrop: { x: 0, y: 0, z: 1 } };

async function main() {
  const cv = await loadCv();
  const fx = makeAll();
  const run = (img, edit, opts, cfg) => P.runPipeline(cv, img, cfg || {}, edit || {}, opts || {});
  const tests = [];
  const test = (name, fn) => tests.push({ name, fn });

  test('steps array has the spec shape and ids', () => {
    const ids = P.steps.map((s) => s.id);
    assert.deepStrictEqual(ids, ['orient', 'analyzeResize', 'findBackground', 'roughBox', 'grabcut', 'assess', 'straighten', 'removeShadow', 'upscale', 'whiteBalance', 'exposure', 'composite', 'sharpen', 'fitTile']);
    for (const s of P.steps) { assert.strictEqual(typeof s.enabled, 'function'); assert.strictEqual(typeof s.run, 'function'); }
    assert.strictEqual(P.steps.find((s) => s.id === 'grabcut').enabled({}, { bgRemove: false }), false);
  });

  test('defaults match spec section 11 image config', () => {
    const d = P.imageDefaults;
    assert.strictEqual(d.tileBg, '#f7f3ea'); assert.strictEqual(d.fill, 0.86); assert.strictEqual(d.thumbSize, 512);
    assert.strictEqual(d.fullSize, 1024); assert.strictEqual(d.origMax, 2048); assert.strictEqual(d.analyzeMax, 640);
    assert.strictEqual(d.retakeMinProductPx, 220); assert.strictEqual(d.maxUpscale, 2.0); assert.strictEqual(d.grabcutIters, 5);
    assert.deepStrictEqual(d.wbGainClamp, [0.9, 1.1]);
  });

  // ---- 8 synthetic fixtures ------------------------------------------------
  const table = [];
  for (const [name, img] of Object.entries(fx)) {
    test(`synthetic ${name}`, () => {
      const r = run(img);
      table.push([name, r.quality, r.reasons.join(',') || '-', r.info.productPx, r.info.busy ? 'busy' : r.info.fallback ? 'fallback' : r.info.bgRemoved ? 'cutout' : 'whole']);
      assert.ok(img.expect.quality.includes(r.quality), `quality ${r.quality} (${r.reasons}) not in ${img.expect.quality}`);
      for (const code of img.expect.reasonsInclude || []) assert.ok(r.reasons.includes(code), `reason ${code} missing in ${r.reasons}`);
      if (img.expect.busy) { assert.ok(r.info.busy); assert.strictEqual(r.info.bgRemoved, false); }
      assert.strictEqual(r.tiles.thumb.width, 512); assert.strictEqual(r.tiles.thumb.height, 512);
      assert.strictEqual(r.tiles.full.width, 1024); assert.strictEqual(r.tiles.full.height, 1024);
      const t = r.tiles.thumb;
      assert.deepStrictEqual([t.data[0], t.data[1], t.data[2], t.data[3]], [...BG, 255]); // corner is tile colour
      const bb = contentBox(t);
      assert.ok(bb, 'tile has content');
      assert.ok(Math.max(bb.w, bb.h) <= 512 * 0.86 + 6, `content too big ${bb.w}x${bb.h}`);
      if (r.info.bgRemoved && r.quality !== 'retake') assert.ok(Math.max(bb.w, bb.h) >= 512 * 0.86 - 12, `content too small ${bb.w}x${bb.h}`);
    });
  }

  test('phone-tilted is straightened by ~12 deg', () => {
    const r = run(fx['phone-tilted']);
    assert.ok(Math.abs(Math.abs(r.info.straightenedBy) - 12) < 2, `straightenedBy ${r.info.straightenedBy}`);
    const off = run(fx['phone-tilted'], { autoStraighten: false });
    assert.ok(contentBox(off.tiles.thumb).w > contentBox(r.tiles.thumb).w + 10, 'unstraightened content should be wider');
  });

  test('far-small is never upscaled beyond maxUpscale (2x)', () => {
    const img = fx['far-small'], r = run(img);
    assert.strictEqual(r.quality, 'retake');
    const bb = contentBox(r.tiles.thumb);
    assert.ok(bb.h <= r.info.productPx * 2 + 8, `content ${bb.h}px for product ${r.info.productPx}px`);
    const z = run(img, { thumbCrop: { x: 0, y: 0, z: 10 } });
    assert.ok(z.info.zoomClamped && z.info.zoomClamped.thumb, 'zoom should be clamped');
  });

  test('deterministic (final and preview), incl. brush strokes', () => {
    const edit = { maskEdits: [{ mode: 'erase', r: 10, pts: [[320, 205]] }], brightness: 10 };
    for (const mode of ['final', 'preview']) {
      const img = mode === 'preview' ? downscale(fx['web-white'], 640) : fx['web-white'];
      const a = run(img, edit, { mode, origLong: 800 }), b = run(img, edit, { mode, origLong: 800 });
      assert.ok(same(a.tiles.thumb, b.tiles.thumb) && same(a.tiles.full, b.tiles.full), mode + ' not deterministic');
    }
  });

  test('preview mode is close to final and runs at analyze size', () => {
    const img = fx['phone-tilted'], small = downscale(img, 640);
    const f = run(img), p = run(small, {}, { mode: 'preview', origLong: img.width });
    assert.strictEqual(p.quality, f.quality);
    assert.strictEqual(p.tiles.full.width, 640);
    assert.ok(meanAbsDiff(f.tiles.thumb, p.tiles.thumb) < 10, 'preview thumb deviates: ' + meanAbsDiff(f.tiles.thumb, p.tiles.thumb));
    const t0 = Date.now(); run(small, {}, { mode: 'preview', variants: ['thumb'], origLong: img.width });
    assert.ok(!run(small, {}, { mode: 'preview', variants: ['thumb'] }).tiles.full);
    assert.ok(Date.now() - t0 < 5000);
  });

  test('preview given the full image has identical analyze image/mask as final', () => {
    const img = fx['phone-tilted'], e = { maskEdits: [{ mode: 'erase', r: 6, pts: [[300, 120]] }] };
    const f = run(img, e, { debug: true }), p = run(img, e, { mode: 'preview', debug: true });
    assert.deepStrictEqual([p.info.analyzeW, p.info.analyzeH], [f.info.analyzeW, f.info.analyzeH]);
    assert.ok(Buffer.compare(Buffer.from(p.debug.analyzeMask), Buffer.from(f.debug.analyzeMask)) === 0);
  });

  test('brush: erase stroke removes the cap (GC_BGD), add stroke forces a cut-out on a busy bg', () => {
    const img = fx['web-white'];
    const base = run(img, {}, { debug: true }), am = base.debug.analyzeMask, W = base.info.analyzeW;
    assert.strictEqual(am[205 * W + 320], 255, 'cap area is product without strokes');
    const e = run(img, { maskEdits: [{ mode: 'erase', r: 12, pts: [[300, 205], [340, 205]] }] }, { debug: true });
    assert.strictEqual(e.debug.analyzeMask[205 * W + 320], 0, 'erased');
    assert.strictEqual(e.debug.analyzeMask[330 * W + 320], 255, 'body kept');
    const busy = fx['closeup-label'];
    const a = run(busy, { maskEdits: [{ mode: 'add', r: 25, pts: [[250, 250], [400, 300], [300, 400]] }, { mode: 'erase', r: 20, pts: [[60, 60], [600, 60]] }] }, { debug: true });
    // a cut-out was attempted despite the busy background (the artwork-like mask may then be rejected by quality/fallback)
    assert.ok(a.info.busy && a.debug.analyzeMask, 'grabcut ran');
    assert.strictEqual(a.debug.analyzeMask[250 * a.info.analyzeW + 250], 255);
    assert.strictEqual(a.debug.analyzeMask[60 * a.info.analyzeW + 60], 0);
  });

  test('bgRemove=false keeps the whole photo (no cut-out), still ok', () => {
    const r = run(fx['phone-tilted'], { bgRemove: false });
    assert.strictEqual(r.info.bgRemoved, false);
    assert.strictEqual(r.quality, 'ok');
    assert.ok(contentBox(r.tiles.thumb).w >= 400);
  });

  test('manual rotate 90 turns a tall product wide; brightness/sharpen change output', () => {
    const base = run(fx['web-white'], { thumbCrop: { x: 0, y: 0, z: 1 } });
    const rot = run(fx['web-white'], { rotate: 90 });
    assert.ok(contentBox(base.tiles.thumb).h > contentBox(base.tiles.thumb).w);
    assert.ok(contentBox(rot.tiles.thumb).w > contentBox(rot.tiles.thumb).h);
    const bright = run(fx['dark'], { brightness: 40 }), plain = run(fx['dark']);
    assert.ok(meanAbsDiff(bright.tiles.thumb, plain.tiles.thumb) > 3);
    assert.ok(!same(run(fx['web-white'], { sharpen: 0 }).tiles.thumb, base.tiles.thumb));
  });

  test('thumbCrop {x,y,z}: pan in 512-scale px, zoom about the content centre', () => {
    const img = fx['web-white'];
    const base = contentBox(run(img).tiles.thumb);
    const pan = contentBox(run(img, { thumbCrop: { x: 60, y: -20, z: 1 } }).tiles.thumb);
    assert.ok(Math.abs(pan.cx - base.cx - 60) <= 3, `pan x ${pan.cx - base.cx}`);
    assert.ok(Math.abs(pan.cy - base.cy + 20) <= 3, `pan y ${pan.cy - base.cy}`);
    const out = contentBox(run(img, { thumbCrop: { x: 0, y: 0, z: 0.5 } }).tiles.thumb);
    assert.ok(Math.abs(out.h - base.h / 2) <= 4, `zoom out ${out.h} vs ${base.h / 2}`);
    const r2 = run(img, { fullCrop: { x: 60, y: 0, z: 1 } });
    const fb = contentBox(r2.tiles.full), f0 = contentBox(run(img).tiles.full);
    assert.ok(Math.abs(fb.cx - f0.cx - 120) <= 4, 'full tile pan scales with size (1024/512)');
    assert.ok(same(run(img, { fullCrop: { x: 60, y: 0, z: 1 } }).tiles.thumb, run(img).tiles.thumb), 'fullCrop must not affect thumb');
  });

  test('wasm heap does not grow across repeated runs, even with failures (no Mat leaks)', () => {
    const img = fx['phone-tilted'];
    run(img); run(img); // warm up
    const before = heapBytes(cv);
    for (let i = 0; i < 6; i++) run(img, { maskEdits: [{ mode: 'add', r: 8, pts: [[300, 300]] }] });
    for (let i = 0; i < 4; i++) {
      let n = 0;
      assert.throws(() => run(img, {}, { shouldCancel: () => ++n > 9 }), /cancelled/);
    }
    const grew = heapBytes(cv) - before;
    assert.ok(grew <= 8 * 1024 * 1024, `heap grew by ${grew} bytes`);
  });

  // ---- real photos (optional) ----------------------------------------------
  const expectByName = {
    'web-white': ['ok'], 'phone-tilted': ['ok'], 'counter-landscape': ['ok'], 'dark': ['check', 'ok'],
    'sideways': ['check'], 'closeup-label': ['ok'], 'tall-tight': ['ok'], 'far-small': ['retake', 'check']
  };
  const photoDir = path.join(__dirname, 'fixtures', 'photos');
  const photos = fs.existsSync(photoDir) ? fs.readdirSync(photoDir).filter((f) => /\.(jpe?g|png)$/i.test(f)) : [];
  for (const f of photos) {
    test(`photo ${f}`, () => {
      const base = f.replace(/\.[^.]+$/, '');
      const img = downscale(decode(path.join(photoDir, f)), P.imageDefaults.origMax);
      const r = run(img);
      table.push(['photos/' + f, r.quality, r.reasons.join(',') || '-', r.info.productPx, '']);
      assert.strictEqual(r.tiles.thumb.width, 512);
      if (expectByName[base]) assert.ok(expectByName[base].includes(r.quality), `${f}: ${r.quality} (${r.reasons}) not in ${expectByName[base]}`);
    });
  }

  let failed = 0;
  for (const t of tests) {
    const t0 = Date.now();
    try { await t.fn(); console.log(`  ok   ${t.name} (${Date.now() - t0}ms)`); }
    catch (e) { failed++; console.log(`  FAIL ${t.name}\n       ${e && e.stack || e}`); }
  }
  console.log('\nper-fixture quality:');
  for (const row of table) console.log('  ' + row.map((c, i) => String(c).padEnd([22, 8, 28, 6, 8][i])).join(' '));
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
