'use strict';
// สร้าง fortune/fortunes.json จากไฟล์ markdown ฉบับตรวจทาน (เซียมซี-100-ใบ.md)
// ใช้: node fortune/tools/build-fortunes.js <path-to-md>
const fs = require('fs');
const path = require('path');
const src = process.argv[2];
if (!src) { console.error('usage: node build-fortunes.js <md>'); process.exit(1); }
const text = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
const parts = text.split(/^## ใบที่ /m).slice(1);
const out = [];
for (const part of parts) {
  const head = part.split('\n')[0];
  const m = head.match(/^(\d+) · (上签|中签|下签)/);
  if (!m) throw new Error('bad header: ' + head);
  const rows = [...part.matchAll(/^\| (.+?) \| (.+?) \|$/gm)]
    .map((r) => [r[1].trim(), r[2].trim()])
    .filter((r) => r[0] !== 'กลอนจีน' && !/^-+$/.test(r[0]));
  const meaning = (part.match(/^\*\*ความหมาย:\*\* (.+?)\s*$/m) || [])[1];
  const money = (part.match(/^\*\*การเงิน:\*\* (.+?)\s*$/m) || [])[1];
  if (rows.length !== 4 || !meaning || !money) throw new Error('incomplete slip ' + m[1]);
  out.push({ n: Number(m[1]), level: m[2], zh: rows.map((r) => r[0]), th: rows.map((r) => r[1]), meaning, money });
}
if (out.length !== 100 || out.some((s, i) => s.n !== i + 1)) throw new Error('expected 100 sequential slips, got ' + out.length);
const c = { 上签: 0, 中签: 0, 下签: 0 };
out.forEach((s) => c[s.level]++);
fs.writeFileSync(path.join(__dirname, '..', 'fortunes.json'), JSON.stringify(out, null, 1) + '\n');
console.log('OK', c);
