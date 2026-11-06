'use strict';
// ตรรกะล้วน (ไม่พึ่ง Electron) ของโมดูลเซียมซี — ทดสอบด้วย node ได้โดยตรง
const crypto = require('crypto');

const OWN_DOC_NAME = 'POS Hero Receipt'; // ชื่อเอกสารที่ build/raw-print.ps1 ใช้ — ข้ามเสมอ (มีคำสั่งตัดในตัวเองแล้ว)

const DEFAULT_SETTINGS = Object.freeze({
  mode: 'off',             // 'off' = ปิดทั้งหมด | 'record' = บันทึกงานพิมพ์อย่างเดียว (ขั้น 0) | 'on' = ต่อท้ายเซียมซีจริง
  skipUnlucky: true,       // ปิดใบโชคร้าย (ไม่สุ่ม 下签)
  showZh: true,            // ใส่กลอนจีน
  showTh: true,            // ใส่กลอนแปลไทย
  printerName: '',         // ว่าง = เครื่องพิมพ์เริ่มต้นของ Windows
  docFilter: 'Sea & Hill', // ชื่อเอกสารที่มีข้อความนี้ = ใบเสร็จ Sea & Hill (คั่นหลายคำด้วย ,)
  startDate: '',           // YYYY-MM-DD ว่าง = ไม่จำกัด
  endDate: '',
  cutOthers: true,         // งานอื่นที่จบ → ส่งคำสั่งตัดกระดาษให้ (เพราะไดรเวอร์ตั้ง No Cut)
  footer: 'สวัสดีปีใหม่ 2570 · อึ้งลักเส็ง 黄六盛'
});

function normalizeSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS, raw && typeof raw === 'object' ? raw : {});
  if (!['off', 'record', 'on'].includes(s.mode)) s.mode = 'off';
  for (const k of ['skipUnlucky', 'showZh', 'showTh', 'cutOthers']) s[k] = !!s[k];
  for (const k of ['printerName', 'docFilter', 'footer']) s[k] = typeof s[k] === 'string' ? s[k].trim() : DEFAULT_SETTINGS[k];
  for (const k of ['startDate', 'endDate']) s[k] = /^\d{4}-\d{2}-\d{2}$/.test(s[k]) ? s[k] : '';
  return s;
}

function localDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function inDateRange(settings, now = new Date()) {
  const today = localDateStr(now);
  if (settings.startDate && today < settings.startDate) return false;
  if (settings.endDate && today > settings.endDate) return false;
  return true;
}

function matchesReceipt(docName, filter) {
  const name = String(docName || '').toLowerCase();
  const terms = String(filter || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  return terms.some((t) => name.includes(t));
}

// ตัดสินใจว่างานพิมพ์ที่จบแล้วต้องทำอะไร: 'skip' | 'cut' | 'slip'
// 'slip' = พิมพ์เซียมซีแล้วตัด; 'cut' = ตัดอย่างเดียว; ใบเสร็จต้องถูกตัดเสมอ
function decideAction(docName, settings, now = new Date()) {
  if (settings.mode !== 'on') return 'skip';
  if (String(docName || '') === OWN_DOC_NAME) return 'skip';
  if (matchesReceipt(docName, settings.docFilter)) return inDateRange(settings, now) ? 'slip' : 'cut';
  return settings.cutOthers ? 'cut' : 'skip';
}

function allowedIndexes(fortunes, settings) {
  const out = [];
  fortunes.forEach((f, i) => { if (!(settings.skipUnlucky && f.level === '下签')) out.push(i); });
  return out;
}

function pickIndex(fortunes, settings, randomInt = crypto.randomInt) {
  const pool = allowedIndexes(fortunes, settings);
  if (!pool.length) throw new Error('no fortune allowed');
  return pool[randomInt(0, pool.length)];
}

// จำ job id ที่จัดการแล้ว N รายการล่าสุด (กันพิมพ์ซ้ำ)
function makeDedup(limit = 200) {
  const order = [];
  const set = new Set();
  return {
    seen(id) { return set.has(id); },
    add(id) {
      if (set.has(id)) return;
      set.add(id); order.push(id);
      while (order.length > limit) set.delete(order.shift());
    }
  };
}

const FEED_AND_CUT = Buffer.from([0x1b, 0x64, 0x02, 0x1d, 0x56, 0x41, 0x00]); // ESC d 2 + GS V 65 0

const LEVEL_LABEL = { 上签: '上签 · ดี', 中签: '中签 · กลาง', 下签: '下签 · รอจังหวะ' };

// สรุปไฟล์บันทึกงานพิมพ์เป็นข้อความสั้นๆ สำหรับส่งให้คนช่วยดู (ไม่มีข้อมูลลูกค้า มีแค่ชื่อเอกสาร/สถานะ/เวลา)
function buildReportText(lines, meta = {}) {
  const events = [];
  for (const l of lines) { try { const o = JSON.parse(l); if (o && o.e) events.push(o); } catch (e) { /* บรรทัดหมายเหตุ (#...) */ } }
  const jobs = new Map(); // id → { doc, addedAt, endAt, endEvent, lastStatus }
  for (const o of events) {
    if (o.id === undefined) continue;
    const j = jobs.get(o.id) || { id: o.id, doc: o.doc || '', statuses: new Set() };
    if (o.doc) j.doc = o.doc;
    if (o.status) j.statuses.add(o.status);
    if (o.lastStatus) j.statuses.add(o.lastStatus);
    if (o.e === 'added') j.addedAt = Date.parse(o.t);
    if ((o.e === 'done' || o.e === 'gone') && !j.endAt) { j.endAt = Date.parse(o.t); j.endEvent = o.e; }
    jobs.set(o.id, j);
  }
  const byDoc = new Map();
  for (const j of jobs.values()) {
    const g = byDoc.get(j.doc) || { n: 0, secs: [], statuses: new Set() };
    g.n++;
    if (j.addedAt && j.endAt) g.secs.push((j.endAt - j.addedAt) / 1000);
    j.statuses.forEach((s) => g.statuses.add(s));
    byDoc.set(j.doc, g);
  }
  const out = [];
  out.push('POS Hero — รายงานงานพิมพ์ (เซียมซี)');
  for (const [k, v] of Object.entries(meta)) out.push(k + ': ' + v);
  out.push('จำนวนงานในไฟล์บันทึก: ' + jobs.size);
  out.push('');
  out.push('ชื่อเอกสาร → จำนวนครั้ง | เวลาเข้าคิวถึงจบ (วินาที) | สถานะที่เจอ');
  for (const [doc, g] of [...byDoc.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const t = g.secs.length ? g.secs.map((x) => x.toFixed(1)).slice(-5).join(', ') : '-';
    out.push('"' + doc + '" → ' + g.n + ' | ' + t + ' | ' + [...g.statuses].join('/'));
  }
  const errors = events.filter((o) => o.e === 'error').slice(-5);
  if (errors.length) { out.push(''); out.push('ข้อผิดพลาดล่าสุด:'); errors.forEach((o) => out.push('  ' + o.t + ' ' + o.msg)); }
  out.push('');
  out.push('เหตุการณ์ล่าสุด 30 รายการ:');
  events.filter((o) => o.e !== 'hb').slice(-30).forEach((o) => out.push('  ' + [o.t, o.e, o.id, o.doc, o.status || o.lastStatus || ''].filter((x) => x !== undefined).join(' | ')));
  return out.join('\n');
}

module.exports = {
  buildReportText,
  OWN_DOC_NAME, DEFAULT_SETTINGS, normalizeSettings, localDateStr, inDateRange, matchesReceipt,
  decideAction, allowedIndexes, pickIndex, makeDedup, FEED_AND_CUT, LEVEL_LABEL
};
