'use strict';
// ตัวกั้นให้ "QR มีสิทธิ์ก่อนเสมอ": ข้อความรายการสินค้า (cart/pay/thanks) จากจอลูกค้าแบบแสดงสินค้า
// จะไม่ถูกส่งทับ QR ที่กำลังรอจ่าย หรือหน้า paid/expired/cancelled ที่เพิ่งขึ้นภายใน holdMs
// ข้อความล่าสุดถูกจำไว้ แล้วส่งตอนที่ QR จบ (release) — pure ไม่พึ่ง Electron
function createCartGate({ send, isWaiting, now = Date.now, holdMs = 5000 }) {
  let pending = null, holdUntil = 0;
  const blocked = () => !!isWaiting() || now() < holdUntil;
  return {
    offer(msg) { pending = msg; if (!blocked()) send(msg); },
    qrEnded() { holdUntil = now() + holdMs; },
    // เรียกหลังหมดช่วง hold: ส่งข้อความล่าสุดที่ค้างไว้ คืน true ถ้าส่งแล้ว
    release() { if (pending && !blocked()) { send(pending); return true; } return false; },
    clear() { pending = null; holdUntil = 0; },
    hasPending: () => !!pending,
  };
}
module.exports = { createCartGate };
