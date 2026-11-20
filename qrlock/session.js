'use strict';
// สถานะ QR ต่อเครื่อง: WAITING → PAID | PAID_MANUAL | CANCELLED | EXPIRED (ไม่พึ่ง electron)
// แต่ละเครื่องมี WAITING ได้ใบเดียว สร้างใบใหม่ = ยกเลิกใบเก่า
function createSessions({ now = () => Date.now(), expirySec = 180, onChange = () => {} } = {}) {
  let current = null;
  let seq = 0;
  const finish = (status, extra) => {
    if (!current || current.status !== 'WAITING') return null;
    current.status = status; current.endedAt = now(); Object.assign(current, extra || {});
    const done = current; onChange(done); return done;
  };
  return {
    create({ amount, payload, machine, staff }) {
      finish('CANCELLED', { note: 'replaced' });
      current = { id: ++seq, amount, payload, machine, staff: staff || null, status: 'WAITING', startedAt: now(), expiresAt: now() + expirySec * 1000, endedAt: null };
      onChange(current); return current;
    },
    current: () => current,
    waiting: () => (current && current.status === 'WAITING' ? current : null),
    confirmManual: () => finish('PAID_MANUAL'),
    cancel: () => finish('CANCELLED'),
    markPaid: (matchedText) => finish('PAID', { matchedText: matchedText || null }),
    // เรียกเป็นระยะ: คืนรายการที่เพิ่งหมดเวลา (ถ้ามี)
    tick() { return current && current.status === 'WAITING' && now() >= current.expiresAt ? finish('EXPIRED') : null; }
  };
}
module.exports = { createSessions };
