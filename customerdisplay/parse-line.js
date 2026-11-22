'use strict';
// อ่านข้อความแถบเหลืองของ Sea & Hill: [เพิ่ม : | ลบ : ]<barcode>/<ชื่อ>/<หน่วย>/@ <จำนวน> x <ราคา> = <ยอด>
const num = (s) => Number(String(s).replace(/,/g, ''));

function parseLine(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  if (!s) return null;
  let action = 'upsert';
  const m = /^(เพิ่ม|ลบ)\s*:\s*/.exec(s);
  if (m) { if (m[1] === 'ลบ') action = 'remove'; s = s.slice(m[0].length); }
  const slash = s.indexOf('/');
  const barcode = (slash < 0 ? s : s.slice(0, slash)).trim();
  if (!barcode) return null;
  const at = s.lastIndexOf('/@ ');
  const tail = at < 0 ? null : /^([\d,]+(?:\.\d+)?)\s*x\s*([\d,]+(?:\.\d+)?)\s*=\s*(-?[\d,]+(?:\.\d+)?)\s*$/.exec(s.slice(at + 3));
  if (!tail || slash < 0) {
    return action === 'remove' ? { action, barcode, name: '', unit: '', qty: 0, price: 0, amount: 0 } : null;
  }
  const mid = s.slice(slash + 1, at); // <ชื่อ>/<หน่วย>
  const u = mid.lastIndexOf('/');
  const name = (u < 0 ? mid : mid.slice(0, u)).trim();
  const unit = u < 0 ? '' : mid.slice(u + 1).trim();
  return { action, barcode, name, unit, qty: num(tail[1]), price: num(tail[2]), amount: num(tail[3]) };
}
module.exports = { parseLine };
