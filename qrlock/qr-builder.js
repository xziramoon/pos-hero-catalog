'use strict';
// QR-LOCK ระยะ 0/1: ตัวสร้าง QR EMVCo (TLV) ล็อกยอด — ไม่พึ่งอะไร ใช้ได้ทั้ง node และเบราว์เซอร์
// ห้ามแตะรหัส 29/30/31/62 ของต้นแบบ (บอกว่าเงินเข้าบัญชีไหน)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QrLockBuilder = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF
  function crc16(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
      crc ^= (str.charCodeAt(i) & 0xFF) << 8;
      for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  // แยก TLV ชั้นนอกสุด: [{tag, value}] — โยน Error ถ้าโครงสร้างผิด
  function parseTlv(s) {
    const out = [];
    let i = 0;
    while (i < s.length) {
      if (i + 4 > s.length) throw new Error('TLV ขาดช่วง ที่ตำแหน่ง ' + i);
      const tag = s.slice(i, i + 2);
      const lenStr = s.slice(i + 2, i + 4);
      if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lenStr)) throw new Error('TLV ไม่ใช่ตัวเลข ที่ตำแหน่ง ' + i);
      const len = parseInt(lenStr, 10);
      if (i + 4 + len > s.length) throw new Error('ความยาวรหัส ' + tag + ' เกินข้อความ');
      out.push({ tag, value: s.slice(i + 4, i + 4 + len) });
      i += 4 + len;
    }
    return out;
  }

  function tlv(tag, value) {
    if (value.length > 99) throw new Error('ค่ารหัส ' + tag + ' ยาวเกิน 99');
    return tag + String(value.length).padStart(2, '0') + value;
  }

  // ตรวจต้นแบบ: ต้องมี 00, 63 และ CRC ถูก — คืน {ok, error}
  function validateTemplate(template) {
    try {
      const t = String(template || '').trim();
      if (!t) return { ok: false, error: 'ว่างเปล่า' };
      const items = parseTlv(t);
      if (items[0].tag !== '00') return { ok: false, error: 'ไม่ขึ้นต้นด้วยรหัส 00' };
      const last = items[items.length - 1];
      if (last.tag !== '63' || last.value.length !== 4) return { ok: false, error: 'ไม่มีรหัส 63 (CRC) ท้ายข้อความ' };
      const want = crc16(t.slice(0, t.length - 4));
      if (want !== last.value.toUpperCase()) return { ok: false, error: 'CRC ไม่ตรง (ควรเป็น ' + want + ')' };
      if (!items.some((x) => x.tag === '29' || x.tag === '30' || x.tag === '31')) {
        return { ok: false, error: 'ไม่พบข้อมูลบัญชีผู้รับ (รหัส 29/30/31)' };
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // รับยอดเป็นข้อความ/ตัวเลข → '360.00' (ทศนิยมไม่เกิน 2 ตำแหน่ง, > 0) ไม่งั้นโยน Error
  function formatAmount(amount) {
    const s = String(amount).trim().replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('ยอดเงินไม่ถูกต้อง');
    const [i, d = ''] = s.split('.');
    const out = String(parseInt(i, 10)) + '.' + d.padEnd(2, '0');
    if (!(parseFloat(out) > 0)) throw new Error('ยอดเงินต้องมากกว่า 0');
    if (out.length > 13) throw new Error('ยอดเงินสูงเกินไป');
    return out;
  }

  // ต้นแบบ + ยอด → ข้อความ QR ล็อกยอด (ใช้ครั้งเดียว)
  function buildQr(template, amount) {
    const v = validateTemplate(template);
    if (!v.ok) throw new Error('ต้นแบบ QR ใช้ไม่ได้: ' + v.error);
    const amt = formatAmount(amount);
    const items = parseTlv(String(template).trim())
      .filter((x) => x.tag !== '63' && x.tag !== '54' && x.tag !== '01');
    items.push({ tag: '01', value: '12' }, { tag: '54', value: amt });
    items.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    const body = items.map((x) => tlv(x.tag, x.value)).join('') + '6304';
    return body + crc16(body);
  }

  return { crc16, parseTlv, validateTemplate, formatAmount, buildQr };
}));
