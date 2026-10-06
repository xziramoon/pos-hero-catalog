/**
 * Legacy "Catalog Hero" fixture generator (for the Phase 5 harness run and manual testing).
 *
 *   node test/fixtures/make-legacy.js <outfile> [count=30]
 *
 * Writes a catalog-data.json in the legacy shape: numeric Date.now() ids, numeric + zero-padded codes, favoriteIds, categories,
 * shopName, an scrypt-like auth record, and img dataURLs (JPEG <= 500px wide, from the synthetic photo set); every 4th item has no image
 * and one item has a corrupt dataURL.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const { makeAll } = require('./make-synthetic');

function downscale(img, maxW) {
  if (img.width <= maxW) return img;
  const s = maxW / img.width, w = maxW, h = Math.max(1, Math.round(img.height * s));
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / s)), sy = Math.min(img.height - 1, Math.floor(y / s));
      const so = (sy * img.width + sx) * 4, o = (y * w + x) * 4;
      data[o] = img.data[so]; data[o + 1] = img.data[so + 1]; data[o + 2] = img.data[so + 2]; data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

function make(count) {
  const photos = Object.values(makeAll()).map((im) => 'data:image/jpeg;base64,' + jpeg.encode(downscale(im, 500), 82).data.toString('base64'));
  const cats = ['เครื่องดื่ม', 'ขนม', 'ของใช้ส่วนตัว', 'ของสด'];
  const base = 1700000000000;
  const items = [];
  const favoriteIds = [];
  for (let i = 0; i < count; i++) {
    const id = base + i * 37;
    const it = { id, name: 'สินค้าทดสอบ ' + (i + 1), code: i % 3 === 0 ? String(100 + i).padStart(5, '0') : String(8850000 + i), cat: cats[i % cats.length] };
    if (i % 4 !== 3) it.img = photos[i % photos.length];
    if (i === 6) it.img = 'data:image/jpeg;base64,/9j/broken';
    if (i === 9) delete it.cat;
    if (i % 5 === 0) favoriteIds.push(i % 2 ? String(id) : id);
    items.push(it);
  }
  return { items, categories: cats.concat(['หมวดว่าง']), favoriteIds, shopName: 'ร้านทดสอบ Catalog Hero', auth: { id: 'boss', salt: 'c2FsdA==', hash: 'aGFzaA==', N: 16384, r: 8, p: 1 } };
}

module.exports = { make };

if (require.main === module) {
  const out = path.resolve(process.argv[2] || 'catalog-data.json');
  const data = make(parseInt(process.argv[3], 10) || 30);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data));
  console.log('wrote', out, data.items.length, 'items,', fs.statSync(out).size, 'bytes');
}
