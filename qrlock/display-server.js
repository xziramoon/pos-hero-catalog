'use strict';
// เว็บเซิร์ฟเวอร์เล็ก + WebSocket (ส่งออกอย่างเดียว) สำหรับจอฝั่งลูกค้า — ไม่พึ่งไลบรารีนอก
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(text) {
  const p = Buffer.from(text, 'utf8');
  const h = p.length < 126 ? Buffer.from([0x81, p.length])
    : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([h, p]);
}

function createDisplayServer({ port = 8080, heartbeatMs = 10000, getLastMessage = () => ({ type: 'idle' }), assetsDir = __dirname } = {}) {
  const clients = new Set();
  let hb = null;
  const files = { '/display': ['display.html', 'text/html; charset=utf-8'], '/qrcode.js': ['vendor/qrcode.js', 'application/javascript'], '/assets/risu-sheet.jpg': ['assets/risu-sheet.jpg', 'image/jpeg'] };
  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    const f = files[url] || (url === '/' ? files['/display'] : null);
    if (!f) { res.writeHead(404); return res.end('not found'); }
    fs.readFile(path.join(assetsDir, f[0]), (err, buf) => {
      if (err) { res.writeHead(500); return res.end('error'); }
      res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-store' }); res.end(buf);
    });
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.url || '').split('?')[0] !== '/ws') return socket.destroy();
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    clients.add(socket);
    const drop = () => { clients.delete(socket); };
    socket.on('close', drop); socket.on('error', drop);
    socket.on('data', (d) => { // รับแค่ close / ping — จอไม่มีตรรกะการเงิน
      const op = d[0] & 0x0f;
      if (op === 8) { try { socket.end(); } catch (e) { /* ignore */ } drop(); }
      else if (op === 9) { try { socket.write(Buffer.from([0x8a, 0])); } catch (e) { /* ignore */ } }
    });
    try { socket.write(frame(JSON.stringify(getLastMessage()))); } catch (e) { drop(); }
  });
  return {
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        // heartbeat: จอฝั่งมือถือใช้เช็กว่าสายยังอยู่ (มือถือหลับ/สัญญาณหลุดแบบเงียบ onclose จะไม่ทำงาน)
        hb = setInterval(() => { const f = frame('{"type":"ping"}'); for (const c of [...clients]) { try { c.write(f); } catch (e) { clients.delete(c); } } }, heartbeatMs);
        if (hb.unref) hb.unref();
        resolve(server.address().port);
      });
    }),
    stop: () => new Promise((resolve) => {
      clearInterval(hb); hb = null; for (const c of clients) { try { c.destroy(); } catch (e) { /* ignore */ } } clients.clear(); server.close(() => resolve()); }),
    broadcast(msg) { const f = frame(JSON.stringify(msg)); for (const c of [...clients]) { try { c.write(f); } catch (e) { clients.delete(c); } } },
    clientCount: () => clients.size
  };
}
module.exports = { createDisplayServer, frame };
