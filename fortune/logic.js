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
  docFilter: 'document',  // ชื่อเอกสารที่มีข้อความนี้ = ใบเสร็จ (ระบบ POS ร้านส่งงานชื่อ "document") (คั่นหลายคำด้วย ,)
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
  // ตรงทั้งชื่อเท่านั้น (ไม่งั้น "Local Downlevel Document" จะถูกนับเป็นใบเสร็จเพราะมีคำว่า document) —
  // ใส่ * หน้า/หลังเพื่อให้หมายถึง "ขึ้นต้นด้วย / ลงท้ายด้วย / มีคำนี้" เช่น Sea*  *receipt  *Hill*
  return terms.some((t) => {
    const star0 = t.startsWith('*'), star1 = t.endsWith('*') && t.length > 1;
    const core = t.slice(star0 ? 1 : 0, star1 ? t.length - 1 : t.length);
    if (!core) return false;
    if (star0 && star1) return name.includes(core);
    if (star0) return name.endsWith(core);
    if (star1) return name.startsWith(core);
    return name === core;
  });
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
// เลขงานของ Windows วนกลับ (เห็น 255 → 1) จึงจำ id แค่ ttlMs (ค่าเริ่มต้น 10 นาที) ไม่งั้นงานใหม่ที่ id ซ้ำจะถูกข้าม
function makeDedup(limit = 200, ttlMs = 10 * 60 * 1000, nowFn = Date.now) {
  const seenAt = new Map();
  return {
    seen(id) {
      const t = seenAt.get(id);
      if (t === undefined) return false;
      if (nowFn() - t > ttlMs) { seenAt.delete(id); return false; }
      return true;
    },
    add(id) {
      seenAt.delete(id); seenAt.set(id, nowFn());
      while (seenAt.size > limit) seenAt.delete(seenAt.keys().next().value);
    }
  };
}

// รวมงานพิมพ์ที่จบใกล้กัน/ซ้อนกันเป็นชุดเดียว แล้วค่อยตัดกระดาษครั้งเดียวตอนคิวเงียบ
// (ไม่งั้นงานแทรกก่อนใบเสร็จ เช่น Local Downlevel Document จะทำให้คำสั่งตัดเข้าคิวหลังใบเสร็จ แล้วเซียมซีหลุดไปอยู่อีกแถบ)
function makeBatcher(opts) {
  const { quietMs = 600, maxWaitMs = 8000, staleMs = 30000, now = Date.now, setT = setTimeout, clearT = clearTimeout, onFlush } = opts;
  const active = new Map(); // id → เวลาที่เห็นเข้าคิว (งานที่ยังพิมพ์ไม่จบ)
  let batch = [];
  let firstAt = 0;
  let timer = null;
  function schedule(ms) { if (timer) clearT(timer); timer = setT(check, ms); }
  function check() {
    timer = null;
    if (!batch.length) return;
    for (const [id, t] of active) if (now() - t > staleMs) active.delete(id);
    if (active.size > 0 && now() - firstAt < maxWaitMs) { schedule(300); return; }
    const out = batch; batch = []; firstAt = 0;
    onFlush(out);
  }
  return {
    added(id) { active.set(id, now()); if (batch.length) schedule(quietMs); },
    dropped(id) { active.delete(id); },
    finished(evt) { active.delete(evt.id); if (!batch.length) firstAt = now(); batch.push(evt); schedule(quietMs); },
    reset() { active.clear(); },
    pending() { return batch.length; }
  };
}

const FEED_AND_CUT = Buffer.from([0x1b, 0x64, 0x02, 0x1d, 0x56, 0x41, 0x00]); // ESC d 2 + GS V 65 0

const LEVEL_LABEL = { 上签: '上签 · ดี', 中签: '中签 · กลาง', 下签: '下签 · รอจังหวะ' };

// สรุปไฟล์บันทึกงานพิมพ์เป็นข้อความสั้นๆ สำหรับส่งให้คนช่วยดู (ไม่มีข้อมูลลูกค้า มีแค่ชื่อเอกสาร/สถานะ/เวลา)
function buildReportText(lines, meta = {}) {
  const events = [];
  for (const l of lines) { try { const o = JSON.parse(l); if (o && o.e) events.push(o); } catch (e) { /* บรรทัดหมายเหตุ (#...) */ } }
  // เลขงานของ Windows วนกลับได้ (255 → 1) จึงแยกงานด้วย "เลข + ครั้งที่ขึ้น added" ไม่ใช่เลขอย่างเดียว
  const jobs = new Map();
  const current = new Map(); // id → key ของงานล่าสุดที่ใช้เลขนี้
  let seq = 0;
  for (const o of events) {
    if (o.id === undefined) continue;
    if (o.e === 'added' && current.has(o.id)) {
      const prev = jobs.get(current.get(o.id));
      // added ซ้ำของงานเดิมที่ยังไม่จบ (watcher เริ่มใหม่) ไม่นับเป็นงานใหม่
      if (!prev.endAt) { if (o.status) prev.statuses.add(o.status); continue; }
      current.delete(o.id);
    }
    let key = current.get(o.id);
    if (!key) { key = o.id + '#' + (++seq); current.set(o.id, key); jobs.set(key, { id: o.id, doc: o.doc || '', statuses: new Set() }); }
    const j = jobs.get(key);
    if (o.doc) j.doc = o.doc;
    if (o.status) j.statuses.add(o.status);
    if (o.lastStatus) j.statuses.add(o.lastStatus);
    if (o.e === 'added') j.addedAt = Date.parse(o.t);
    if ((o.e === 'done' || o.e === 'gone') && !j.endAt) { j.endAt = Date.parse(o.t); j.endEvent = o.e; }
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
  const notes = lines.filter((l) => l.startsWith('#')).slice(-15);
  if (notes.length) { out.push(''); out.push('สิ่งที่โปรแกรมทำล่าสุด:'); notes.forEach((l) => out.push('  ' + l)); }
  out.push('');
  out.push('เหตุการณ์ล่าสุด 30 รายการ:');
  events.filter((o) => o.e !== 'hb' && o.e !== 'start').slice(-30).forEach((o) => out.push('  ' + [o.t, o.e, o.id, o.doc, o.status || o.lastStatus || ''].filter((x) => x !== undefined).join(' | ')));
  return out.join('\n');
}

module.exports = {
  buildReportText, makeBatcher,
  OWN_DOC_NAME, DEFAULT_SETTINGS, normalizeSettings, localDateStr, inDateRange, matchesReceipt,
  decideAction, allowedIndexes, pickIndex, makeDedup, FEED_AND_CUT, LEVEL_LABEL
};
