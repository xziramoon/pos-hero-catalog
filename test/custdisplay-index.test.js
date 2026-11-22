'use strict';
// custdisplay/index.js: spawn reader, ส่งข้อความผ่าน qrlock.showCart, respawn แบบ backoff, kill ตอนปิด, ค่าเริ่ม = ปิด
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custd-'));
  const app = { getPath: () => dir, isPackaged: false };
  const shown = []; const calls = [];
  const qrlock = { enableCartDisplay: async (on) => { calls.push(on); return on ? 8080 : null; }, showCart: (m) => shown.push(m) };
  const children = [];
  const spawn = (cmd, args) => {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.killed = false; c.kill = () => { c.killed = true; };
    c.cmd = cmd; c.args = args; children.push(c); return c;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const M = require('../custdisplay');

  // ค่าเริ่มต้น = ปิด: ไม่ spawn ไม่เปิดเซิร์ฟเวอร์
  M.init({ app, qrlock, spawn });
  await wait(30);
  assert.strictEqual(children.length, 0); assert.deepStrictEqual(calls, []); assert.strictEqual(M._state().enabled, false);
  const item = M.trayItems()[0];
  assert.strictEqual(item.type, 'checkbox'); assert.strictEqual(item.checked, false);

  // เปิดจากเมนู tray → เก็บ config, เปิดเซิร์ฟเวอร์, spawn reader พร้อม -ParentPid
  await item.click();
  assert.deepStrictEqual(calls, [true]);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'custdisplay-config.json'), 'utf8')).enabled, true);
  assert.strictEqual(children.length, 1);
  assert.strictEqual(children[0].cmd, 'powershell.exe');
  assert.ok(children[0].args.includes('-File') && children[0].args.some((a) => a.endsWith('pos-reader.ps1')));
  assert.strictEqual(children[0].args[children[0].args.indexOf('-ParentPid') + 1], String(process.pid));

  // บรรทัดจาก reader (มี BOM / บรรทัดเสีย ต้องไม่พัง) → ขึ้นจอ
  const out = children[0].stdout;
  out.write('﻿{"t":"main","receipt":"R1","total":0,"line":"x"}\nnot json\n');
  await wait(30);
  out.write(JSON.stringify({ t: 'main', receipt: 'R1', total: 225, line: '885/เซรั่ม/แพ็ค/@ 1.00 x 225.00 = 225.00' }) + '\n');
  await wait(30);
  const cart = shown[shown.length - 1];
  assert.strictEqual(cart.type, 'cart'); assert.strictEqual(cart.total, 225); assert.strictEqual(cart.items[0].name, 'เซรั่ม');
  const n = shown.length;
  out.write(JSON.stringify({ t: 'main', receipt: 'R1', total: 225, line: '885/เซรั่ม/แพ็ค/@ 1.00 x 225.00 = 225.00' }) + '\n');
  await wait(30);
  assert.strictEqual(shown.length, n, 'ข้อความเหมือนเดิมไม่ส่งซ้ำ');
  out.write('{"t":"pay","due":225,"cash":500,"change":275,"transfer":null}\n');
  await wait(30);
  assert.deepStrictEqual(shown[shown.length - 1], { type: 'pay', due: 225, cash: 500, change: 275 });

  // reader ตาย → เคลียร์จอ (idle) แล้ว respawn หลัง backoff
  children[0].emit('exit', 1);
  await wait(30);
  assert.deepStrictEqual(shown[shown.length - 1], { type: 'idle' });
  await wait(1200);
  assert.strictEqual(children.length, 2, 'respawn หลัง backoff');

  // ปิดจากเมนู → kill + ปล่อยเซิร์ฟเวอร์ + ไม่ respawn อีก
  await M.trayItems()[0].click();
  assert.ok(children[1].killed); assert.strictEqual(calls[calls.length - 1], false);
  children[1].emit('exit', 0);
  await wait(2500);
  assert.strictEqual(children.length, 2, 'ปิดแล้วต้องไม่ respawn');
  M.shutdown();
  console.log('custdisplay-index: ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
