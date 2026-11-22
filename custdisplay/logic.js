'use strict';
// จอลูกค้าแสดงรายการสินค้า: parse แถบเหลืองของ Sea & Hill POS + state machine
// pure function ล้วน ไม่พึ่ง Electron / fs / timer (เวลาส่งเข้ามาทาง `now`) เพื่อให้เขียน unit test ได้
// อ้างอิง docs/customer-display-plan.md ข้อ 4–6

const THANKS_MS = 8000;       // ขึ้น "ขอบคุณครับ" ค้างไว้ก่อนกลับหน้าต้อนรับ
const SAVE_WINDOW_MS = 5000;  // Pay ปิดแล้วเลขที่ใบเสร็จเปลี่ยนภายในเวลานี้ = บันทึกบิลแล้ว (ไม่ใช่ Cancel)
const SUM_EPS = 0.01;

function num(s) {
  const n = Number(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
}

// "[prefix : ]<barcode>/<ชื่อ>/<หน่วย>/@ <จำนวน> x <ราคา> = <ยอด>"
// คืน {action:'upsert'|'remove', barcode, name, unit, qty, price, amount} หรือ null ถ้าไม่ใช่รูปแบบแถบเหลือง
function parseBar(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  let action = 'upsert';
  const pm = /^(เพิ่ม|ลบ)\s*:\s*/.exec(s);
  if (pm) { action = pm[1] === 'ลบ' ? 'remove' : 'upsert'; s = s.slice(pm[0].length); }

  // ส่วนท้ายตัดจากขวา: ชื่อสินค้าอาจมี "/" อยู่ข้างใน
  const at = s.lastIndexOf('/@ ');
  if (at < 0) return null;
  const tail = /^([\d,]*\.?\d+)\s*x\s*(-?[\d,]*\.?\d+)\s*=\s*(-?[\d,]*\.?\d+)\s*$/.exec(s.slice(at + 3));
  if (!tail) return null;
  const head = s.slice(0, at);
  const first = head.indexOf('/');
  const lastSlash = head.lastIndexOf('/');
  if (first < 0 || lastSlash <= first) return null; // ต้องมี barcode / ชื่อ / หน่วย
  const barcode = head.slice(0, first).trim();
  if (!barcode) return null;
  const qty = num(tail[1]), price = num(tail[2]), amount = num(tail[3]);
  if ([qty, price, amount].some(Number.isNaN)) return null;
  return {
    action,
    barcode,
    name: head.slice(first + 1, lastSlash).trim(),
    unit: head.slice(lastSlash + 1).trim(),
    qty, price, amount,
  };
}

function createState() {
  return {
    receipt: null,
    total: 0,
    items: [],          // [{barcode,name,unit,qty,price,amount}] เรียงตามลำดับที่ยิงครั้งแรก
    last: null,         // barcode รายการล่าสุด (ไฮไลต์)
    lastLine: null,     // ข้อความแถบเหลืองที่เห็นล่าสุด
    baseline: null,     // ข้อความแถบเหลืองที่ค้างจากบิลก่อน ห้ามนับ
    baselineTotal: 0,
    fallbackItem: null, // รายการล่าสุดที่ parse ได้ ใช้ตอน fallback
    pay: null,          // {due,cash,change} ขณะหน้า Pay เปิด
    lastPay: null,      // ค่า Pay ล่าสุดก่อนปิด (ไว้ขึ้นเงินทอนตอนขอบคุณ)
    payClosedAt: null,
    thanksUntil: 0,
    thanksChange: null,
  };
}

function applyBar(st, p) {
  if (p.action === 'remove') {
    st.items = st.items.filter((i) => i.barcode !== p.barcode);
    if (st.last === p.barcode) st.last = st.items.length ? st.items[st.items.length - 1].barcode : null;
    return;
  }
  const rec = { barcode: p.barcode, name: p.name, unit: p.unit, qty: p.qty, price: p.price, amount: p.amount };
  const i = st.items.findIndex((x) => x.barcode === p.barcode);
  if (i >= 0) st.items[i] = rec; else st.items.push(rec);
  st.last = p.barcode;
  st.fallbackItem = rec;
}

// event จาก pos-reader: {t:'main'|'pay'|'pay_closed'|'pos_missing', ...}
// แก้ไข st ตรงๆ แล้วคืน st เดิม
function reduce(st, ev, now) {
  if (!ev || typeof ev !== 'object') return st;

  if (ev.t === 'pos_missing') {
    Object.assign(st, createState());
    return st;
  }

  if (ev.t === 'pay') {
    st.pay = { due: ev.due ?? null, cash: ev.cash ?? null, change: ev.change ?? null, transfer: ev.transfer ?? null };
    st.lastPay = st.pay;
    st.payClosedAt = null;
    st.thanksUntil = 0;
    return st;
  }

  if (ev.t === 'pay_closed') {
    if (st.pay) { st.payClosedAt = now; }
    st.pay = null;
    return st;
  }

  if (ev.t !== 'main') return st;

  const receipt = ev.receipt || null;
  const total = typeof ev.total === 'number' ? ev.total : 0;
  const line = typeof ev.line === 'string' && ev.line ? ev.line : null;

  if (receipt !== st.receipt) {
    // ใบเสร็จเปลี่ยน: ถ้า Pay เพิ่งปิด = บันทึกบิลแล้ว → ขอบคุณ
    const saved = st.receipt !== null && st.payClosedAt !== null && now - st.payClosedAt <= SAVE_WINDOW_MS && st.lastPay;
    const change = saved ? st.lastPay.change : null;
    Object.assign(st, createState());
    st.receipt = receipt;
    st.total = total;
    st.baseline = line;           // แถบเหลืองยังค้างรายการจากบิลก่อน
    st.baselineTotal = total;
    st.lastLine = line;
    if (saved) { st.thanksUntil = now + THANKS_MS; st.thanksChange = change; }
    return st;
  }

  // ใบเสร็จเดิม: มีความเคลื่อนไหวหลัง Cancel แปลว่าไม่ใช่การบันทึกบิล
  st.payClosedAt = null;
  if (total === 0 && st.items.length) { st.items = []; st.last = null; st.fallbackItem = null; } // POS เคลียร์บิล (Total 0/ว่าง)
  const totalChanged = total !== st.total;
  st.total = total;

  if (line !== null && line !== st.lastLine) {
    st.lastLine = line;
    if (st.baseline !== null && line === st.baseline) {
      // ข้อความเท่า baseline = ค้างจากบิลก่อน ไม่นับ
    } else {
      st.baseline = null;
      const p = parseBar(line);
      if (p) applyBar(st, p);
    }
  } else if (line !== null && line === st.baseline && totalChanged && total !== st.baselineTotal) {
    // ยิงสินค้าตัวเดียวกับที่ค้างในแถบเหลืองเป๊ะๆ ข้อความจึงไม่เปลี่ยน แต่ยอดรวมขยับ → นับเป็นรายการจริง
    st.baseline = null;
    const p = parseBar(line);
    if (p) applyBar(st, p);
  }
  return st;
}

function sumItems(items) {
  return items.reduce((a, i) => a + i.amount, 0);
}

// ข้อความที่จะส่งไปจอลูกค้า (รูปแบบตรงกับ type ใน qrlock/display.html)
function view(st, now) {
  if (st.pay) {
    return { type: 'pay', due: st.pay.due, cash: st.pay.cash, change: st.pay.change };
  }
  if (st.thanksUntil && now < st.thanksUntil) {
    return { type: 'thanks', change: st.thanksChange };
  }
  if (!st.items.length && !st.total) return { type: 'idle' };

  const consistent = Math.abs(sumItems(st.items) - st.total) <= SUM_EPS;
  if (consistent && st.items.length) {
    return { type: 'cart', items: st.items.map((i) => ({ ...i })), last: st.last, total: st.total, fallback: false };
  }
  // ยอดไม่ตรง (Recall Bill / ส่วนลด / แก้ราคา / เริ่มกลางบิล): แสดงแค่รายการล่าสุด + Total จาก POS
  const only = st.fallbackItem ? [{ ...st.fallbackItem }] : [];
  return { type: 'cart', items: only, last: st.fallbackItem ? st.fallbackItem.barcode : null, total: st.total, fallback: true };
}

// เวลาที่ควรเรียก view() อีกครั้ง (ใช้กับ timer ของหน้าขอบคุณ) หรือ null ถ้าไม่มี
function nextWakeup(st, now) {
  return st.thanksUntil && now < st.thanksUntil ? st.thanksUntil : null;
}

module.exports = { parseBar, createState, reduce, view, nextWakeup, THANKS_MS, SAVE_WINDOW_MS };
