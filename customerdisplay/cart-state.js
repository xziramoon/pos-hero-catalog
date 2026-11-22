'use strict';
// State machine จอลูกค้า (ล้วน ไม่พึ่ง electron/IO): รับอีเวนต์จาก posreader คืนสิ่งที่จอควรแสดง
const { parseLine } = require('./parse-line');
const QR_TYPES = new Set(['show_qr', 'paid', 'expired', 'cancelled']);
const TOLERANCE = 0.01;

function createCartState({ now = () => Date.now(), thanksMs = 8000, log = () => {} } = {}) {
  let machine = null, receipt = null, baseline = null, prevLine = null, total = 0;
  let items = new Map(), lastBarcode = null;
  let payOpen = false, pay = null, lastChange = null, savedWhilePay = false, awaitingSave = false;
  let thanksAt = null, thanksChange = null, mismatchLogged = false;

  const reset = () => { items = new Map(); lastBarcode = null; };
  const apply = (p) => {
    if (!p) return;
    thanksAt = null;
    if (p.action === 'remove') { items.delete(p.barcode); if (lastBarcode === p.barcode) lastBarcode = null; return; }
    items.set(p.barcode, { barcode: p.barcode, name: p.name, unit: p.unit, qty: p.qty, price: p.price, amount: p.amount });
    lastBarcode = p.barcode;
  };
  const startBill = (e) => { reset(); receipt = e.receipt; baseline = prevLine = e.line; total = e.total; };
  const saved = () => { thanksAt = now(); thanksChange = lastChange; awaitingSave = false; };

  function handle(e) {
    const out = { billSaved: false };
    if (!e || typeof e !== 'object') return out;
    if (e.t === 'pos_missing') { reset(); receipt = baseline = prevLine = null; total = 0; payOpen = false; pay = null; awaitingSave = savedWhilePay = false; thanksAt = null; return out; }
    if (e.t === 'pay') {
      payOpen = true; savedWhilePay = false; awaitingSave = false;
      pay = { due: e.due, cash: e.cash, change: e.change, transfer: e.transfer };
      if (e.change != null) lastChange = e.change;
      return out;
    }
    if (e.t === 'pay_closed') {
      if (!payOpen) return out;
      payOpen = false;
      if (savedWhilePay) { savedWhilePay = false; reset(); baseline = prevLine; saved(); out.billSaved = true; } else awaitingSave = true;
      return out;
    }
    if (e.t !== 'main') return out;
    if (e.machine) machine = e.machine;
    if (receipt === null) { startBill(e); return out; }
    if (e.receipt && e.receipt !== receipt) {
      if (payOpen) { savedWhilePay = true; receipt = e.receipt; baseline = prevLine = e.line; total = e.total; return out; }
      startBill(e);
      if (awaitingSave) { saved(); out.billSaved = true; }
      return out;
    }
    awaitingSave = false;
    if (e.total != null) total = e.total;
    if (e.line !== prevLine) { prevLine = e.line; if (e.line !== baseline) apply(parseLine(e.line)); }
    return out;
  }

  function view() {
    if (payOpen && pay) return { type: 'pay', machine, ...pay };
    if (thanksAt !== null) {
      if (now() - thanksAt < thanksMs) return { type: 'thanks', machine, change: thanksChange };
      thanksAt = null;
    }
    const list = [...items.values()];
    if (!list.length && !total) return { type: 'idle' };
    const last = lastBarcode ? items.get(lastBarcode) || null : (list[list.length - 1] || null);
    const sum = list.reduce((s, i) => s + i.amount, 0);
    const hidden = list.length > 0 && Math.abs(sum - total) > TOLERANCE;
    if (hidden && !mismatchLogged) log('cart/total mismatch: sum=' + sum.toFixed(2) + ' total=' + total);
    mismatchLogged = hidden;
    return { type: 'cart', machine, items: list, lastBarcode, total, hidden, last };
  }
  return { handle, view };
}

function composeView(qrMsg, cartView) { return qrMsg && QR_TYPES.has(qrMsg.type) ? qrMsg : cartView; }
module.exports = { createCartState, composeView };
