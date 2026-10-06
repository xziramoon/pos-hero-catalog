'use strict';
// Dev helper: write N fake items into a catalog store for performance testing.
//   node catalog/tools/seed-demo.js [count=500] [--dir <path>] [--images <n>] [--reset]
// Default dir is <repo>/.catalog-dev (gitignored). Run the app against it with:
//   CATALOG_DATA_DIR=<that dir> npx electron .
// Do not point --dir at the real userData/catalog folder: it would mix fake items into live data.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { createStore } = require('../catalog-store');

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const count = parseInt(args.find((a) => /^\d+$/.test(a)) || '500', 10);
const dir = path.resolve(flag('--dir') || path.join(__dirname, '..', '..', '.catalog-dev'));
const imageCount = flag('--images') != null ? parseInt(flag('--images'), 10) : Math.min(count, 60);

const CATS = ['เครื่องดื่ม', 'ขนมขบเคี้ยว', 'ของใช้ส่วนตัว', 'เครื่องปรุง', 'นมและผลิตภัณฑ์', 'ของใช้ในบ้าน', 'บะหมี่กึ่งสำเร็จรูป'];
const BRANDS = ['เคลียร์', 'ตราเจดีย์', 'มาม่า', 'เลย์', 'โออิชิ', 'ไวไว', 'ดัชมิลล์', 'สก๊อตต์', 'ซันไลต์', 'โค้ก', 'เป๊ปซี่', 'ทิพรส'];
const KINDS = ['รสต้มยำ', 'รสออริจินัล', 'ขวดใหญ่', 'แพ็คคู่', 'กลิ่นลาเวนเดอร์', 'สูตรเข้มข้น', 'ไซส์เล็ก', 'รสสไปซี่'];
const COLORS = [[236, 72, 153], [59, 130, 246], [34, 197, 94], [245, 158, 11], [239, 68, 68], [139, 92, 246], [20, 184, 166], [120, 113, 108]];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// Cream tile with a coloured "product" rectangle. PNG bytes saved under a .jpg name:
// fine for dev, browsers sniff the real format.
function fakePng(rgb, size = 128) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const inside = x > size * 0.3 && x < size * 0.7 && y > size * 0.1 && y < size * 0.9;
      const c = inside ? rgb : [247, 243, 234];
      raw[row + 1 + x * 3] = c[0]; raw[row + 2 + x * 3] = c[1]; raw[row + 3 + x * 3] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync(dir, { recursive: true });
if (args.includes('--reset')) { try { fs.unlinkSync(path.join(dir, 'db.json')); } catch (_) { /* none */ } }
const store = createStore(dir).load();

const imgs = COLORS.map((c, i) => {
  const hash = crypto.createHash('sha256').update('demo-color-' + i).digest('hex');
  const d = path.join(dir, 'images', hash);
  fs.mkdirSync(d, { recursive: true });
  const png = fakePng(c);
  for (const f of ['orig.jpg', 'thumb-v1.jpg', 'full-v1.jpg']) fs.writeFileSync(path.join(d, f), png);
  return hash;
});

const items = [];
for (let i = 0; i < count; i++) {
  const brand = BRANDS[i % BRANDS.length];
  const kind = KINDS[(i * 7) % KINDS.length];
  const hasImg = i < imageCount;
  items.push({
    code: String(100 + i).padStart(5, '0'),
    name: `${brand} ${kind} ${i + 1}`,
    shortName: i % 3 === 0 ? `${brand} ${i + 1}` : '',
    cat: CATS[i % CATS.length],
    fav: i % 17 === 0,
    barcodes: ['885' + String(1000000000 + i * 37).slice(-10)],
    image: hasImg ? { hash: imgs[i % imgs.length], ver: 1, edit: null, quality: i % 11 === 0 ? 'check' : 'ok', w: 128, h: 128 } : null
  });
}
store.putMany(items);
store.flush();
console.log(`[seed] wrote ${items.length} items (${imageCount} with images) to ${dir}`);
