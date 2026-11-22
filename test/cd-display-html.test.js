'use strict';
// รัน <script> ของ qrlock/display.html ใน sandbox แล้วตรวจ HTML ที่ render จริงของหน้าใหม่
const assert = require('assert'), fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { createDisplayServer } = require('../qrlock/display-server');
const html = fs.readFileSync(path.join(__dirname, '..', 'qrlock', 'display.html'), 'utf8');
const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
const els = {}; let timerSeq = 0; const cleared = new Set();
const el = () => ({ style: {}, className: '', innerHTML: '', textContent: '', classList: { toggle() {} }, addEventListener() {}, play() {}, scrollIntoView() {} });
const doc = { getElementById: (id) => els[id] || (els[id] = el()), documentElement: el(), body: el(), addEventListener() {}, createElement: () => ({ getContext: () => ({ fillRect() {} }), captureStream() {} }), hidden: false };
const sb = { document: doc, window: { addEventListener() {} }, location: { protocol: 'http:', host: 'x' }, navigator: {}, WebSocket: class { close() {} }, setInterval: () => 0, setTimeout: () => { timerSeq++; return timerSeq; }, clearInterval() {}, clearTimeout: (id) => { cleared.add(id); }, qrcode() {}, Date, Math, JSON, String, Number, AudioContext: class {} };
vm.createContext(sb); vm.runInContext(script, sb);
const draw = (m) => { sb.render(m); return els.v.innerHTML; };

const item = (n, q, p) => ({ barcode: n, name: 'สินค้า' + n, unit: 'ชิ้น', qty: q, price: p, amount: q * p });
let h = draw({ type: 'cart', machine: 'POS02', items: [item('A', 2, 225), item('B', 1, 10.5)], lastBarcode: 'B', total: 460.5, hidden: false, last: item('B', 1, 10.5) });
assert.ok(h.includes('สินค้าA') && h.includes('สินค้าB'), 'rows');
assert.ok(h.includes('460.50'), 'total formatted'); assert.ok(h.includes('450.00'), 'line amount');
assert.ok(/id="hl"/.test(h), 'last row highlighted'); assert.ok(els.mc.textContent.includes('POS02'), 'machine code corner');
h = draw({ type: 'cart', machine: 'POS02', items: [item('A', 2, 225)], lastBarcode: 'A', total: 400, hidden: true, last: item('A', 2, 225) });
assert.ok(h.includes('สินค้าA') && h.includes('400.00')); assert.ok(!/class="list"/.test(h), 'hidden → no full list');
h = draw({ type: 'cart', machine: 'POS02', items: [item('<b>', 1, 5)], lastBarcode: '<b>', total: 5, hidden: false, last: item('<b>', 1, 5) });
assert.ok(!h.includes('สินค้า<b>'), 'name escaped');
h = draw({ type: 'pay', machine: 'POS02', due: 225, cash: 500, change: 275, transfer: null });
for (const s of ['ยอดชำระ', 'รับเงิน', 'เงินทอน', '225.00', '500.00', '275.00']) assert.ok(h.includes(s), s);
h = draw({ type: 'pay', machine: 'POS02', due: 225, cash: null, change: null, transfer: null });
assert.ok(h.includes('225.00') && !h.includes('เงินทอน'), 'no cash yet → no change row');
h = draw({ type: 'thanks', machine: 'POS02', change: 275 }); assert.ok(h.includes('ขอบคุณ') && h.includes('275.00'));
h = draw({ type: 'thanks', machine: 'POS02', change: null }); assert.ok(h.includes('ขอบคุณ') && !h.includes('เงินทอน'));
assert.ok(draw({ type: 'idle' }).includes('ยินดีต้อนรับ'), 'welcome kept');
assert.ok(html.includes('ไม่ได้เชื่อมต่อ'));

// ผลรีวิว: Total อ่านไม่ได้ → ไม่แสดงยอดรวม (ห้ามขึ้น 0.00) แต่ยังเห็นรายการล่าสุด
h = draw({ type: 'cart', machine: 'POS02', items: [item('A', 1, 20)], lastBarcode: 'A', total: null, hidden: true, last: item('A', 1, 20) });
assert.ok(h.includes('สินค้าA') && !h.includes('ยอดรวม') && !h.includes('฿ 0.00') && !h.includes('NaN'), 'no total shown when unknown');
// ผลรีวิว: ตัวจับเวลา idle ของหน้า QR (paid/expired) ต้องถูกยกเลิกเมื่อมีหน้าใหม่มาทับ ไม่งั้นจะดึงกลับหน้าต้อนรับผิดจังหวะ
{ const before = timerSeq; sb.render({ type: 'paid', amount: '10.00' }); assert.ok(timerSeq > before, 'paid arms a timer'); const id = timerSeq;
  sb.render({ type: 'cart', machine: 'POS02', items: [], total: 5, hidden: false, last: null }); assert.ok(cleared.has(id), 'paid timer cleared by next render'); }
{ sb.render({ type: 'expired' }); const id = timerSeq; sb.render({ type: 'thanks', machine: 'POS02', change: null }); assert.ok(cleared.has(id), 'expired timer cleared'); }

// server ส่งข้อความล่าสุดชนิดใหม่ให้ client ที่เพิ่งต่อ
(async () => {
  const srv = createDisplayServer({ port: 0, getLastMessage: () => ({ type: 'cart', total: 1 }) });
  const port = await srv.start();
  const net = require('net'); let got = '';
  await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    s.on('data', (d) => { got += d.toString('utf8'); if (got.includes('"cart"')) { s.destroy(); resolve(); } });
    setTimeout(resolve, 1500);
  });
  await srv.stop(); assert.ok(got.includes('"type":"cart"'), 'late client gets current view');
  console.log('cd-display-html: ok');
})();
