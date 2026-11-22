'use strict';
// รวมสถานะจอลูกค้า: ข้อความ QR (ลำดับสูงสุด) + สถานะตะกร้า/จ่ายเงินจาก posreader แล้วส่งเมื่อเปลี่ยนเท่านั้น
// ทุกอย่างห่อ try/catch — ปัญหาฝั่งจอลูกค้าห้ามหลุดไปกระทบ QR-LOCK หรือ POS
const { composeView } = require('./cart-state');

const autoReturnEnabled = (p) => !!(p && p.enabled && p.autoDisplayAfterBill);

function createDisplayFeed({ cart, send, shopName = () => undefined, onBillSaved = () => {} }) {
  let qr = null, lastJson = null;
  const current = () => {
    const v = composeView(qr, cart.view());
    const s = shopName();
    return s ? { shopName: s, ...v } : v;
  };
  function publish(force) {
    try {
      const v = current(); const j = JSON.stringify(v);
      if (!force && j === lastJson) return;
      lastJson = j; send(v);
    } catch (e) { /* ignore */ }
  }
  return {
    current,
    onReaderEvent(evt) {
      let r = { billSaved: false };
      try { r = cart.handle(evt) || r; } catch (e) { return; }
      publish(false);
      if (r.billSaved) { try { onBillSaved(); } catch (e) { /* ignore */ } }
    },
    setQr(msg) { qr = msg || null; publish(true); },
    tick() { publish(false); }
  };
}
module.exports = { createDisplayFeed, autoReturnEnabled };
