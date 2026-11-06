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

module.exports = {
  OWN_DOC_NAME, DEFAULT_SETTINGS, normalizeSettings, localDateStr, inDateRange, matchesReceipt,
  decideAction, allowedIndexes, pickIndex, makeDedup, FEED_AND_CUT, LEVEL_LABEL
};
