'use strict';
const assert = require('assert');
const http = require('http');
const net = require('net');
const { createSessions } = require('../qrlock/session');
const { createDisplayServer } = require('../qrlock/display-server');

(async () => {
  let t = 1000; const events = [];
  const S = createSessions({ now: () => t, expirySec: 180, onChange: (s) => events.push(s.status + ':' + s.id) });
  const a = S.create({ amount: '10.00', payload: 'x', machine: 'm1' });
  assert.strictEqual(S.waiting().id, a.id);
  const b = S.create({ amount: '20.00', payload: 'y', machine: 'm1' }); // ใบใหม่ยกเลิกใบเก่า
  assert.strictEqual(a.status, 'CANCELLED'); assert.strictEqual(S.waiting().id, b.id);
  t += 179000; assert.strictEqual(S.tick(), null);
  t += 1000; assert.strictEqual(S.tick().status, 'EXPIRED'); assert.strictEqual(S.waiting(), null);
  assert.strictEqual(S.confirmManual(), null); // จบแล้วกดซ้ำไม่ได้
  const c = S.create({ amount: '5.00', payload: 'z', machine: 'm1' });
  assert.strictEqual(S.confirmManual().status, 'PAID_MANUAL'); assert.strictEqual(c.status, 'PAID_MANUAL');
  S.create({ amount: '1.00', payload: 'q', machine: 'm1' }); assert.strictEqual(S.cancel().status, 'CANCELLED');

  // display server: หน้า /display + WebSocket รับข้อความ
  const srv = createDisplayServer({ port: 0, getLastMessage: () => ({ type: 'idle' }) });
  const port = await srv.start();
  const html = await new Promise((r) => http.get({ port, path: '/display' }, (res) => { let d = ''; res.on('data', (x) => d += x); res.on('end', () => r([res.statusCode, d])); }));
  assert.strictEqual(html[0], 200); assert.ok(html[1].includes('ไม่ได้เชื่อมต่อ'));
  const got = [];
  await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    let buf = Buffer.alloc(0), upgraded = false;
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) { const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; assert.ok(buf.toString().includes('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')); buf = buf.slice(i + 4); upgraded = true; }
      while (buf.length >= 2) { const len = buf[1]; if (buf.length < 2 + len) break; got.push(JSON.parse(buf.slice(2, 2 + len).toString())); buf = buf.slice(2 + len); }
      if (got.length === 1) { assert.strictEqual(srv.clientCount(), 1); srv.broadcast({ type: 'paid', amount: '360.00' }); }
      if (got.length === 2) { s.destroy(); resolve(); }
    });
  });
  assert.deepStrictEqual(got.map((m) => m.type), ['idle', 'paid']);
  await srv.stop();
  console.log('qrlock-session/display: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
