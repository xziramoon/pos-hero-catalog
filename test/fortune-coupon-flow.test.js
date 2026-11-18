'use strict';
// ทดสอบเส้นทางพิมพ์จริง (handleBatch) ด้วยของปลอม: ไม่โหลด electron จริง ไม่แตะเครื่องพิมพ์ ไม่เปิด PowerShell
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const cp = require('child_process');
const { EventEmitter } = require('events');

const CUT = Buffer.from([0x1b, 0x64, 0x02, 0x1d, 0x56, 0x41, 0x00]);
const countCuts = (b) => { let n = 0, i = -1; while ((i = b.indexOf(CUT, i + 1)) !== -1) n++; return n; };
const endsWithCut = (b) => b.subarray(b.length - CUT.length).equals(CUT);

// ---- ของปลอม ----
const sent = [];
let failFirstSend = false, sendCalls = 0, failCoupon = false, lastCoupon = null;
cp.execFile = (file, args, opts, cb) => {
  sendCalls++;
  const i = args.indexOf('-FilePath');
  sent.push(fs.readFileSync(args[i + 1]));
  if (failFirstSend && sendCalls === 1) cb(new Error('usb'), '', 'usb'); else cb(null, '', '');
};
cp.spawn = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {}; c.stderr = new EventEmitter(); c.kill = () => {}; return c; };
const fakeRenderer = {
  renderAll: async () => new Array(100).fill(Buffer.from('SLP')),
  renderSingle: async () => Buffer.from('SLP'),
  renderCoupon: async (c) => { lastCoupon = c; if (failCoupon) throw new Error('boom'); return Buffer.from('CPN'); },
  closeAll() {}
};
const electronStub = {
  BrowserWindow: class {}, Notification: class { show() {} }, ipcMain: { handle() {}, on() {} },
  clipboard: {}, shell: {}, screen: {}
};
const origLoad = Module._load;
Module._load = function (req, parent) {
  if (req === 'electron') return electronStub;
  if (req === './slip-renderer' && parent && /fortune-main\.js$/.test(parent.filename)) return fakeRenderer;
  return origLoad.apply(this, arguments);
};
const fm = require('../fortune/fortune-main');

function setup(extra = {}, flags = {}) {
  sent.length = 0; sendCalls = 0;
  failFirstSend = !!flags.failFirstSend; failCoupon = !!flags.failCoupon;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-'));
  fs.writeFileSync(path.join(dir, 'fortune-settings.json'), JSON.stringify(Object.assign(
    { mode: 'on', docFilter: 'document', printerName: 'TestPrinter', couponEnabled: true }, extra)));
  fm.init({ app: { getPath: () => dir, isPackaged: false, getVersion: () => 't' }, getMainWindow: () => null, buildRaster: () => Buffer.alloc(0), getCatalogItems: () => CATALOG, billDir: path.join(dir, 'bills'), billSettleMs: 5 });
  return dir;
}
const CATALOG = [
  { id: 'p1', name: 'ปลาหมึกแห้ง', code: '1001', barcodes: ['8850000000011'] },
  { id: 'p2', name: 'กุ้งแห้ง', code: '1002', barcodes: ['8850000000022'] },
  { id: 'p3', name: 'ของไม่มีโปร', code: '1003', barcodes: ['8850000000033'] }
];
const RULES = [
  { itemId: 'p1', name: 'ปลาหมึกแห้ง', minQty: 3, kind: 'baht', value: 10 },
  { itemId: 'p2', name: 'กุ้งแห้ง', minQty: 1, kind: 'percent', value: 5 }
];
// ---- EMF จำลองของบิล POS (ข้อความ Unicode ตรง ๆ) ----
const emfRec = (type, body) => { const b = Buffer.alloc(8 + body.length); b.writeUInt32LE(type, 0); b.writeUInt32LE(b.length, 4); body.copy(b, 8); return b; };
const emfTxt = (x, y, str) => { const ids = [...str].map((c) => c.charCodeAt(0)); const body = Buffer.alloc(68 + ids.length * 2);
  body.writeInt32LE(x, 28); body.writeInt32LE(y, 32); body.writeUInt32LE(ids.length, 36); body.writeUInt32LE(76, 40); ids.forEach((v, i) => body.writeUInt16LE(v, 68 + i * 2)); return emfRec(84, body); };
function billFile(billNo, total, lines) { // lines: [[ชื่อ, ราคา, จำนวน]]
  const recs = []; let y = 100;
  for (const [name, unit, qty] of lines) { recs.push(emfTxt(4, y, name)); y += 30; recs.push(emfTxt(4, y, unit.toFixed(2) + ' X ' + qty)); recs.push(emfTxt(481, y, (unit * qty).toFixed(2))); y += 30; }
  recs.push(emfTxt(4, y, lines.length + ' รายการ'), emfTxt(481, y, total.toFixed(2))); y += 30;
  recs.push(emfTxt(4, y, 'เลขที่:' + billNo));
  const hdr = Buffer.alloc(96); hdr.write(' EMF', 32, 'latin1');
  return Buffer.concat([Buffer.alloc(44), emfRec(1, hdr), ...recs, emfRec(14, Buffer.alloc(12)), Buffer.alloc(3000)]);
}
const putBill = (dir, name, buf) => { fs.mkdirSync(path.join(dir, 'bills'), { recursive: true }); fs.writeFileSync(path.join(dir, 'bills', name), buf); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let jobId = 1000;
const batch = (docs) => fm._handleBatch(docs.map((doc) => ({ id: ++jobId, doc })));

let n = 0;
const run = async (name, fn) => { await fn(); n++; console.log('PASS ' + name); };

(async () => {
  await run('no pending amount → plain slip + one cut, no coupon', async () => {
    setup(); await batch(['document']);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(countCuts(sent[0]), 1); assert.ok(endsWithCut(sent[0]));
    assert.ok(sent[0].indexOf('CPN') === -1);
  });
  await run('pending 1200 → slip, coupon, then ONE cut at the very end; coupon saved; pending consumed', async () => {
    setup(); fm._getPending().set('1200'); await batch(['document']);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(countCuts(sent[0]), 1); assert.ok(endsWithCut(sent[0]));
    const iS = sent[0].indexOf('SLP'), iC = sent[0].indexOf('CPN');
    assert.ok(iS >= 0 && iC > iS, 'slip first, then coupon');
    assert.strictEqual(fm._getPending().peek(), null);
    const rec = fm._getStore().recent(5);
    assert.strictEqual(rec.length, 1); assert.strictEqual(rec[0].percent, 10); assert.strictEqual(rec[0].amount, 1200);
    // บาร์โค้ดต้องเข้ารหัสรหัสดิบ (ไม่มีขีด) ตรงกับที่บันทึก เพื่อให้ปืนยิงแล้วตรวจเจอ
    assert.strictEqual(lastCoupon.raw, rec[0].code);
    assert.ok(/^SH[A-Z2-9]{6}$/.test(lastCoupon.raw), lastCoupon.raw);
    assert.strictEqual(lastCoupon.code, 'SH-' + lastCoupon.raw.slice(2));
  });
  await run('two receipts in one batch → two slips, ONE coupon, one cut', async () => {
    setup(); fm._getPending().set('600'); await batch(['document', 'document']);
    assert.strictEqual(sent.length, 1);
    const b = sent[0];
    assert.strictEqual(b.toString('latin1').split('SLP').length - 1, 2);
    assert.strictEqual(b.toString('latin1').split('CPN').length - 1, 1);
    assert.strictEqual(countCuts(b), 1); assert.ok(endsWithCut(b));
    assert.strictEqual(fm._getStore().recent(5)[0].percent, 5);
  });
  await run('amount below first tier → plain, nothing saved', async () => {
    setup(); fm._getPending().set('100'); await batch(['document']);
    assert.strictEqual(fm._getStore().recent(5).length, 0);
    assert.ok(sent[0].indexOf('CPN') === -1); assert.strictEqual(countCuts(sent[0]), 1);
  });
  await run('coupon render fails → plain slip still printed with cut, nothing saved', async () => {
    setup({}, { failCoupon: true }); fm._getPending().set('1200'); await batch(['document']);
    assert.strictEqual(sent.length, 1); assert.strictEqual(countCuts(sent[0]), 1); assert.ok(endsWithCut(sent[0]));
    assert.ok(sent[0].indexOf('CPN') === -1);
    assert.strictEqual(fm._getStore().recent(5).length, 0);
  });
  await run('printing slip+coupon fails → falls back to cut-only, no coupon saved', async () => {
    setup({}, { failFirstSend: true }); fm._getPending().set('1200'); await batch(['document']);
    assert.strictEqual(sent.length, 2);
    assert.ok(sent[1].equals(CUT), 'second send is the cut-only fallback');
    assert.strictEqual(fm._getStore().recent(5).length, 0);
  });
  await run('couponEnabled=false → plain slip and pending NOT consumed', async () => {
    setup({ couponEnabled: false }); fm._getPending().set('1200'); await batch(['document']);
    assert.ok(sent[0].indexOf('CPN') === -1); assert.strictEqual(countCuts(sent[0]), 1);
    assert.strictEqual(fm._getPending().peek(), 1200);
  });
  await run('non-receipt job → cut only, pending untouched', async () => {
    setup(); fm._getPending().set('1200'); await batch(['Z-Report']);
    assert.ok(sent[0].equals(CUT));
    assert.strictEqual(fm._getPending().peek(), 1200);
  });
  await run('product coupon: scan 3 items → slip + product coupon + ONE cut; saved with product fields', async () => {
    setup({ promoRules: RULES });
    assert.strictEqual(fm._basketScan('8850000000011').status, 'added');
    fm._basketScan('1001'); fm._basketScan('ปลาหมึก');
    await batch(['document']);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(countCuts(sent[0]), 1); assert.ok(endsWithCut(sent[0]));
    assert.strictEqual(sent[0].toString('latin1').split('CPN').length - 1, 1);
    assert.strictEqual(lastCoupon.big, 'ลด 10 บาท'); assert.strictEqual(lastCoupon.product, 'ปลาหมึกแห้ง');
    assert.ok(/^SH[A-Z2-9]{6}$/.test(lastCoupon.raw));
    const rec = fm._getStore().recent(5);
    assert.strictEqual(rec.length, 1); assert.strictEqual(rec[0].type, 'product'); assert.strictEqual(rec[0].itemId, 'p1');
    assert.strictEqual(fm._getBasket().items().length, 0, 'ตะกร้าถูกใช้แล้ว');
  });
  await run('product coupon: not enough qty / no rule / unknown item → no coupon', async () => {
    setup({ promoRules: RULES });
    fm._basketScan('8850000000011'); fm._basketScan('8850000000011'); // 2 < 3
    assert.strictEqual(fm._basketScan('8850000000033').status, 'nopromo');
    assert.strictEqual(fm._basketScan('9999').status, 'notfound');
    await batch(['document']);
    assert.ok(sent[0].indexOf('CPN') === -1); assert.strictEqual(countCuts(sent[0]), 1);
    assert.strictEqual(fm._getStore().recent(5).length, 0);
  });
  await run('product + amount coupons together: two coupons, one cut at the end', async () => {
    setup({ promoRules: RULES }); fm._getPending().set('1200'); fm._basketScan('8850000000022');
    await batch(['document']);
    assert.strictEqual(sent[0].toString('latin1').split('CPN').length - 1, 2);
    assert.strictEqual(countCuts(sent[0]), 1); assert.ok(endsWithCut(sent[0]));
    const types = fm._getStore().recent(5).map((c) => c.type || 'amount').sort();
    assert.deepStrictEqual(types, ['amount', 'product']);
  });
  await run('product coupon render fails → plain slip + cut, nothing saved', async () => {
    setup({ promoRules: RULES }, { failCoupon: true }); fm._basketScan('8850000000022');
    await batch(['document']);
    assert.strictEqual(countCuts(sent[0]), 1); assert.ok(endsWithCut(sent[0])); assert.ok(sent[0].indexOf('CPN') === -1);
    assert.strictEqual(fm._getStore().recent(5).length, 0);
  });
  await run('couponEnabled=false → scan refused, no coupon', async () => {
    setup({ promoRules: RULES, couponEnabled: false });
    assert.strictEqual(fm._basketScan('8850000000022').ok, false);
    await batch(['document']);
    assert.ok(sent[0].indexOf('CPN') === -1);
  });
  await run('auto-read bill: amount coupon + product coupon from the printed bill; reprint of same bill issues nothing', async () => {
    const dir = setup({ promoRules: RULES });
    putBill(dir, 'x-FP1.SPL', billFile('POS01261118-00157', 1200, [['ปลาหมึกแห้ง', 400, 3]]));
    fm._getBillSrc().poll(); await sleep(30); fm._getBillSrc().poll();
    await batch(['document']);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(countCuts(sent[0]), 1); assert.ok(endsWithCut(sent[0]));
    assert.strictEqual(sent[0].toString('latin1').split('CPN').length - 1, 2, 'amount + product');
    const rec = fm._getStore().recent(5);
    assert.deepStrictEqual(rec.map((c) => c.type || 'amount').sort(), ['amount', 'product']);
    assert.ok(rec.every((c) => c.billNo === 'POS01261118-00157'), 'เก็บเลขที่บิลไว้ในคูปอง');
    assert.strictEqual(rec.find((c) => !c.type).amount, 1200); assert.strictEqual(rec.find((c) => !c.type).percent, 10);
    // พิมพ์บิลเดิมซ้ำ → ไม่ออกคูปองซ้ำ
    putBill(dir, 'y-FP2.SPL', billFile('POS01261118-00157', 1200, [['ปลาหมึกแห้ง', 400, 3]]));
    fm._getBillSrc().poll(); await sleep(30); fm._getBillSrc().poll();
    sent.length = 0; await batch(['document']);
    assert.ok(sent[0].indexOf('CPN') === -1); assert.strictEqual(countCuts(sent[0]), 1);
    assert.strictEqual(fm._getStore().recent(5).length, 2, 'ไม่เพิ่ม');
  });
  await run('auto-read bill wins over manual entry (no double coupons); unmatched names are harmless', async () => {
    const dir = setup({ promoRules: RULES }); fm._getPending().set('5000'); fm._basketScan('8850000000022');
    putBill(dir, 'x-FP1.SPL', billFile('POS01261118-00200', 600, [['สินค้าที่ไม่มีในแคตตาล็อก', 300, 2]]));
    fm._getBillSrc().poll(); await sleep(30); fm._getBillSrc().poll();
    await batch(['document']);
    const rec = fm._getStore().recent(5);
    assert.strictEqual(rec.length, 1, 'มีแค่คูปองตามยอดของบิล 600 (ไม่ใช่ 5000 ที่กรอกมือ)');
    assert.strictEqual(rec[0].amount, 600); assert.strictEqual(rec[0].percent, 5);
    assert.strictEqual(countCuts(sent[0]), 1); assert.ok(endsWithCut(sent[0]));
  });
  await run('bill below tier and junk spool files → plain slip + one cut', async () => {
    const dir = setup({ promoRules: RULES });
    putBill(dir, 'x-FP1.SPL', billFile('POS01261118-00300', 100, [['ปลาหมึกแห้ง', 50, 2]]));
    putBill(dir, 'x-00240.SPL', Buffer.from([0x1b, 0x70, 0, 0x19, 0xfa]));
    fm._getBillSrc().poll(); await sleep(30); fm._getBillSrc().poll();
    await batch(['document']);
    assert.ok(sent[0].indexOf('CPN') === -1); assert.strictEqual(countCuts(sent[0]), 1);
    assert.strictEqual(fm._getStore().recent(5).length, 0);
  });
  await run('billReadEnabled=false → bill ignored, manual entry used', async () => {
    const dir = setup({ promoRules: RULES, billReadEnabled: false }); fm._getPending().set('1200');
    putBill(dir, 'x-FP1.SPL', billFile('POS01261118-00400', 100, [['ปลาหมึกแห้ง', 50, 2]]));
    fm._getBillSrc().poll(); await sleep(30); fm._getBillSrc().poll();
    await batch(['document']);
    assert.strictEqual(fm._getStore().recent(5)[0].amount, 1200);
  });
  await run('settings normalisation: bad tiers/days/prefix cannot break the module', async () => {
    const logic = require('../fortune/logic');
    const s = logic.normalizeSettings({ couponTiers: 'x', couponValidDays: -5, couponPrefix: 'ab-cdefg', couponEnabled: 1 });
    assert.deepStrictEqual(s.couponTiers, [{ min: 500, percent: 5 }, { min: 1000, percent: 10 }]);
    assert.strictEqual(s.couponValidDays, 1); assert.strictEqual(s.couponPrefix, 'ABCD'); assert.strictEqual(s.couponEnabled, true);
    assert.strictEqual(logic.normalizeSettings(null).couponEnabled, false, 'off by default');
  });
  console.log(`\n${n} flow tests passed`);
  process.exit(0); // timers ของโมดูล (watcher restart / theme) ยังรันอยู่
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
