'use strict';
// ระยะ 2: จับคู่แจ้งเตือนเงินเข้ากับ QR ที่รออยู่ — ต้องผ่านทุกข้อ (ไม่พึ่ง electron)
const BANK_PATTERNS = {
  maemanee: /แม่มณี|maemanee|mae\s*manee/i,
  bbl: /กรุงเทพ|bangkok\s*bank|bbl|bualuang|บัวหลวง/i
};
const satang = (v) => Math.round(parseFloat(v) * 100);

// evt = { amount, text, ts } — ts = เวลาที่แจ้งเตือนเข้า (ms)
// คืน { ok:true } หรือ { ok:false, reason }
function matchPayment(evt, session, bank) {
  if (!session || session.status !== 'WAITING') return { ok: false, reason: 'no-waiting-session' };
  const re = BANK_PATTERNS[bank];
  if (re && !re.test(String(evt.text || ''))) return { ok: false, reason: 'bank-mismatch' };
  if (!Number.isFinite(satang(evt.amount)) || satang(evt.amount) !== satang(session.amount)) return { ok: false, reason: 'amount-mismatch' };
  if (!(evt.ts >= session.startedAt)) return { ok: false, reason: 'before-qr' };
  return { ok: true };
}

// แจ้งเตือนหนึ่งรายการใช้จับคู่ได้ครั้งเดียว
function createMatcher({ getBank }) {
  const used = new Set();
  return function tryMatch(evt, session) {
    const key = evt.id || (evt.ts + '|' + evt.amount + '|' + evt.text);
    if (used.has(key)) return { ok: false, reason: 'already-used' };
    const r = matchPayment(evt, session, getBank());
    if (r.ok) { used.add(key); if (used.size > 500) used.delete(used.values().next().value); }
    return r;
  };
}
module.exports = { matchPayment, createMatcher, BANK_PATTERNS };
