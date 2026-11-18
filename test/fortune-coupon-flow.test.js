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
let failFirstSend = false, sendCalls = 0, failCoupon = false;
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
  renderCoupon: async () => { if (failCoupon) throw new Error('boom'); return Buffer.from('CPN'); },
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
  fm.init({ app: { getPath: () => dir, isPackaged: false, getVersion: () => 't' }, getMainWindow: () => null, buildRaster: () => Buffer.alloc(0) });
  return dir;
}
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
