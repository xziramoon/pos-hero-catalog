'use strict';
// เฝ้าโฟลเดอร์ที่ "ตัวช่วยสิทธิ์ผู้ดูแล" (spool-relay.ps1) คัดลอกไฟล์ spool ของบิลมาไว้ แล้วอ่านเป็นบิล — ไม่พึ่ง Electron
// ตัวช่วยเขียนทับสำเนาซ้ำจนกว่า Windows จะลบไฟล์ต้นฉบับ → รอให้ไฟล์ "นิ่ง" (ไม่เปลี่ยน settleMs) ค่อยอ่านเป็นบิลสมบูรณ์
const fs = require('fs');
const path = require('path');

function createBillSource({ dir, readBill, now = Date.now, settleMs = 1200, ttlMs = 15 * 60 * 1000, keepFilesMs = 30 * 60 * 1000 }) {
  const state = new Map(); // ชื่อไฟล์ → { sig, changedAt, bill, queued }
  let queue = [];          // [{ bill, at }]  ยังไม่ถูกใช้
  const seenBillNos = [];  // กันบิลเดียวกันถูกใช้ซ้ำ (พิมพ์ซ้ำ)
  let last = null;         // บิลล่าสุดที่อ่านได้ (ให้หน้าตั้งค่าแสดง)

  function poll() {
    let names;
    try { names = fs.readdirSync(dir).filter((n) => /\.SPL$/i.test(n)); } catch (e) { return; }
    const t = now();
    for (const n of names) {
      const full = path.join(dir, n);
      let st; try { st = fs.statSync(full); } catch (e) { continue; }
      const sig = st.size + ':' + st.mtimeMs;
      let s = state.get(n);
      if (!s) { s = { sig: '', changedAt: t, bill: null, queued: false }; state.set(n, s); }
      if (s.sig !== sig) {
        s.sig = sig; s.changedAt = t; s.queued = false;
        if (st.size > 200) { try { s.bill = readBill(fs.readFileSync(full)); } catch (e) { s.bill = null; } } else s.bill = null;
      }
      if (!s.queued && s.bill && t - s.changedAt >= settleMs) {
        s.queued = true;
        if (!(s.bill.billNo && seenBillNos.includes(s.bill.billNo))) {
          queue.push({ bill: s.bill, at: t });
          last = { ...s.bill, at: t };
        }
      }
      if (st.mtimeMs && t - st.mtimeMs > keepFilesMs) { try { fs.unlinkSync(full); state.delete(n); } catch (e) { /* ignore */ } }
    }
    for (const n of [...state.keys()]) if (!names.includes(n)) state.delete(n);
    queue = queue.filter((q) => t - q.at <= ttlMs);
  }

  return {
    poll,
    // ไฟล์ที่ยังเปลี่ยนอยู่/ยังไม่นิ่ง (กำลังพิมพ์) — ให้ผู้เรียกรอสั้น ๆ ก่อนออกคูปอง
    unsettled() { const t = now(); let c = 0; for (const s of state.values()) if (s.bill && !s.queued && t - s.changedAt < settleMs + 500) c++; return c; },
    // เอาบิลที่ยังไม่ถูกใช้ออกมาไม่เกิน max ใบ (เก่าสุดก่อน) และจำเลขที่บิลไว้กันซ้ำ
    take(max = 5) {
      const out = queue.splice(0, max).map((q) => q.bill);
      for (const b of out) if (b.billNo) { seenBillNos.push(b.billNo); if (seenBillNos.length > 200) seenBillNos.shift(); }
      return out;
    },
    pending() { return queue.length; },
    last() { return last; },
    heartbeatAgeMs() { try { return Math.max(0, now() - fs.statSync(path.join(dir, 'heartbeat.txt')).mtimeMs); } catch (e) { return Infinity; } }
  };
}

module.exports = { createBillSource };
