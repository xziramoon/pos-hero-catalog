'use strict';
// อ่านบิลจากไฟล์ spool ของ POS (รูปแบบ EMF ที่ไดรเวอร์เครื่องพิมพ์ใบเสร็จสร้าง) — ไม่พึ่ง Electron, ทดสอบด้วย node ได้
// POS วาดตัวหนังสือด้วย EMR_SMALLTEXTOUT / EMR_EXTTEXTOUTW ซึ่งเก็บเป็น "glyph index" ของฟอนต์ (Tahoma) ไม่ใช่ Unicode
// จึงแปลงกลับด้วย cmap ของฟอนต์ที่เครื่องนี้ (อ่านจาก C:\Windows\Fonts) แล้วจัดเป็นบรรทัดตามพิกัด y/x
// ผลลัพธ์: { items:[{name, unit, qty, total}], total, payment, billNo, date } หรือ null ถ้าไม่ใช่บิล
const fs = require('fs');
const path = require('path');

// ---------- cmap: glyph index → Unicode ----------
function parseCmap(b) {
  const map = new Map();
  const nt = b.readUInt16BE(4); let cmapOff = 0;
  for (let i = 0; i < nt; i++) { const o = 12 + i * 16; if (b.toString('latin1', o, o + 4) === 'cmap') cmapOff = b.readUInt32BE(o + 8); }
  if (!cmapOff) return map;
  const n = b.readUInt16BE(cmapOff + 2);
  for (let i = 0; i < n; i++) {
    const pid = b.readUInt16BE(cmapOff + 4 + i * 8), eid = b.readUInt16BE(cmapOff + 6 + i * 8), off = cmapOff + b.readUInt32BE(cmapOff + 8 + i * 8);
    if (!((pid === 3 && (eid === 1 || eid === 10)) || pid === 0)) continue;
    const fmt = b.readUInt16BE(off);
    if (fmt === 4) {
      const segX2 = b.readUInt16BE(off + 6), seg = segX2 / 2, endO = off + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
      for (let s = 0; s < seg; s++) {
        const end = b.readUInt16BE(endO + s * 2), start = b.readUInt16BE(startO + s * 2), delta = b.readInt16BE(deltaO + s * 2), ro = b.readUInt16BE(rangeO + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g;
          if (ro === 0) g = (c + delta) & 0xffff;
          else { const gi = b.readUInt16BE(rangeO + s * 2 + ro + (c - start) * 2); g = gi === 0 ? 0 : (gi + delta) & 0xffff; }
          if (g && !map.has(g)) map.set(g, c);
        }
      }
    } else if (fmt === 12) {
      const ng = b.readUInt32BE(off + 12);
      for (let k = 0; k < ng; k++) { const o = off + 16 + k * 12, sc = b.readUInt32BE(o), ec = b.readUInt32BE(o + 4), sg = b.readUInt32BE(o + 8); for (let c = sc; c <= ec; c++) if (!map.has(sg + c - sc)) map.set(sg + c - sc, c); }
    }
  }
  return map;
}

const FONT_FILES = ['tahoma.ttf', 'tahomabd.ttf', 'LeelawUI.ttf', 'leelawdb.ttf'];
let fontCache = null;
function loadFonts(fontDir) {
  const dir = fontDir || path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  if (fontCache && fontCache.dir === dir) return fontCache.maps;
  const maps = {};
  for (const f of FONT_FILES) { try { maps[f] = parseCmap(fs.readFileSync(path.join(dir, f))); } catch (e) { /* ไม่มีฟอนต์นี้ */ } }
  fontCache = { dir, maps };
  return maps;
}

const readableScore = (t) => { let k = 0; for (const ch of t) { const c = ch.codePointAt(0); if ((c >= 0xe00 && c <= 0xe7f) || (c >= 0x20 && c < 0x7f)) k++; } return k / Math.max(1, t.length); };

// ---------- EMF → บรรทัดข้อความ ----------
// → [{ y, parts:[{x,text}], text }]  (เรียงบนลงล่าง; ส่วนในบรรทัดเรียงซ้ายไปขวา)
function extractLines(buf, opts = {}) {
  const sig = buf.indexOf(Buffer.from(' EMF'));
  if (sig < 40) return null;
  const maps = opts.cmaps || loadFonts(opts.fontDir);
  const fonts = Object.keys(maps);
  const items = [];
  let p = sig - 40;
  while (p + 8 <= buf.length) {
    const t = buf.readUInt32LE(p), s = buf.readUInt32LE(p + 4);
    if (s < 8 || p + s > buf.length) break;
    if (t === 108 && s >= 36) { // EMR_SMALLTEXTOUT
      const x = buf.readInt32LE(p + 8), y = buf.readInt32LE(p + 12), n = buf.readUInt32LE(p + 16), opt = buf.readUInt32LE(p + 20);
      const off = p + 36 + ((opt & 0x100) ? 0 : 16), small = !!(opt & 0x200), w = small ? 1 : 2;
      if (off + n * w <= p + s) {
        const ids = []; for (let i = 0; i < n; i++) ids.push(small ? buf.readUInt8(off + i) : buf.readUInt16LE(off + i * 2));
        items.push({ x, y, ids, glyph: !!(opt & 0x10) });
      }
    } else if (t === 84 && s >= 76) { // EMR_EXTTEXTOUTW
      const x = buf.readInt32LE(p + 36), y = buf.readInt32LE(p + 40), n = buf.readUInt32LE(p + 44), offs = buf.readUInt32LE(p + 48), opt = buf.readUInt32LE(p + 52);
      if (p + offs + n * 2 <= p + s) {
        const ids = []; for (let i = 0; i < n; i++) ids.push(buf.readUInt16LE(p + offs + i * 2));
        items.push({ x, y, ids, glyph: !!(opt & 0x10) });
      }
    }
    p += s;
    if (t === 14) break; // EMR_EOF
  }
  if (!items.length) return null;
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of items) { const r = rows[rows.length - 1]; if (r && Math.abs(r.y - it.y) <= 6) r.items.push(it); else rows.push({ y: it.y, items: [it] }); }
  return rows.map((r) => {
    r.items.sort((a, b) => a.x - b.x);
    // เลือกฟอนต์ที่ให้ข้อความอ่านออกที่สุดต่อบรรทัด (ปกติ/ตัวหนา glyph index ต่างกัน)
    let best = null, bestScore = -1;
    const cands = fonts.length ? fonts : [null];
    for (const f of cands) {
      const parts = r.items.map((q) => ({ x: q.x, text: q.glyph ? (f ? q.ids.map((g) => String.fromCodePoint(maps[f].get(g) || 0xfffd)).join('') : '') : String.fromCharCode(...q.ids) }));
      const sc = readableScore(parts.map((q) => q.text).join(''));
      if (sc > bestScore) { bestScore = sc; best = parts; }
    }
    return { y: r.y, parts: best, text: best.map((q) => q.text).join('') };
  });
}

// ---------- ชื่อสินค้า: ตัดสระบน/ล่าง วรรณยุกต์ ช่องว่าง เครื่องหมาย เพื่อเทียบแบบทนความเพี้ยนของ glyph ----------
function normThai(s) {
  return String(s == null ? '' : s).normalize('NFC').toLowerCase()
    .replace(/[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e\ufffd]/g, '')
    .replace(/[\s.,()\[\]{}\-_/\\*:;'"!?+=]/g, '');
}

const NUM = '([\\d,]+(?:\\.\\d+)?)';
const num = (s) => Number(String(s).replace(/,/g, ''));

// ---------- บรรทัด → บิล ----------
function parseBill(lines) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const items = [];
  let total = null, payment = null, billNo = null, date = null;
  const qtyRe = new RegExp('^\\s*' + NUM + '\\s*[Xx×]\\s*(\\d+(?:\\.\\d+)?)\\s*$');
  const lastNumber = (line) => { const m = line.parts.length > 1 ? line.parts[line.parts.length - 1].text.match(new RegExp('^\\s*' + NUM + '\\s*$')) : null; return m ? num(m[1]) : null; };
  const used = new Set();
  for (let i = 0; i < lines.length - 1; i++) {
    const q = lines[i + 1];
    let m = null, qi = -1;
    for (let k = 0; k < q.parts.length; k++) { const mm = q.parts[k].text.match(qtyRe); if (mm) { m = mm; qi = k; break; } }
    if (!m) continue;
    const name = lines[i].text.replace(/\s+/g, ' ').trim();
    if (!name || /^[\d.,\s]+$/.test(name)) continue;
    const unit = num(m[1]), qty = num(m[2]);
    const rest = q.parts.slice(qi + 1).map((x) => x.text).join('').match(new RegExp('^\\s*' + NUM + '\\s*$'));
    const lineTotal = rest ? num(rest[1]) : Math.round(unit * qty * 100) / 100;
    items.push({ name, unit, qty, total: lineTotal });
    used.add(i); used.add(i + 1);
  }
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    const t = lines[i].text;
    if (/รายการ/.test(t) && total == null) { const n = lastNumber(lines[i]); if (n != null) total = n; else { const mm = t.match(/(\d[\d,]*\.\d\d)\s*$/); if (mm) total = num(mm[1]); } }
    else if (/ช[าำ]?ระ/.test(normThai(t))) {
      const nt = normThai(t); payment = /เงนสด/.test(nt) ? 'cash' : /โอน/.test(nt) ? 'transfer' : 'other';
    }
    const bn = t.match(/\b([A-Z]{2,}\d*\d{6}-\d+)\b/); if (bn && !billNo) billNo = bn[1];
    const dt = t.match(/(\d{1,2}-\d{1,2}-\d{4})\s*@\s*(\d{1,2}:\d{2})/); if (dt && !date) date = dt[1] + ' ' + dt[2];
  }
  if (!items.length && total == null) return null;
  if (total == null && items.length) total = Math.round(items.reduce((a, b) => a + b.total, 0) * 100) / 100;
  return { items, total, payment, billNo, date };
}

function readBill(buf, opts) {
  try { return parseBill(extractLines(buf, opts)); } catch (e) { return null; }
}

// ---------- จับคู่ชื่อบนบิลกับแคตตาล็อก ----------
function createMatcher(catalog) {
  const byNorm = new Map(); const all = [];
  for (const it of catalog || []) { const k = normThai(it && it.name); if (!k) continue; if (!byNorm.has(k)) byNorm.set(k, it); all.push([k, it]); }
  return function match(billName) {
    const k = normThai(billName); if (!k) return null;
    if (byNorm.has(k)) return byNorm.get(k);
    if (k.length < 6) return null;
    const hits = all.filter(([n]) => n.length >= 6 && (n.includes(k) || k.includes(n)));
    return hits.length === 1 ? hits[0][1] : null;
  };
}

// → { matched:[{itemId,name,qty}], unmatched:[ชื่อบนบิล] }
function billToBasket(bill, catalog) {
  const match = createMatcher(catalog); const q = new Map(); const unmatched = [];
  for (const it of (bill && bill.items) || []) {
    const c = match(it.name);
    if (!c) { unmatched.push(it.name); continue; }
    const cur = q.get(String(c.id)) || { itemId: String(c.id), name: c.name, qty: 0 };
    cur.qty += it.qty; q.set(cur.itemId, cur);
  }
  return { matched: [...q.values()], unmatched };
}

module.exports = { parseCmap, loadFonts, extractLines, parseBill, readBill, normThai, createMatcher, billToBasket };
