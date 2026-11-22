'use strict';
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createReaderHost, replayFile } = require('../customerdisplay/reader-host');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fakeSpawner() {
  const children = [];
  const spawn = (cmd, args) => { const c = new EventEmitter(); c.stdout = new PassThrough(); c.killed = false; c.kill = () => { c.killed = true; }; c.cmd = cmd; children.push(c); return c; };
  return { spawn, children };
}

(async () => {
  // แยกบรรทัดที่มาเป็นก้อนครึ่งๆ (รวมตัวอักษรไทยที่ถูกตัดกลางไบต์) + ข้ามบรรทัด JSON เสีย
  {
    const { spawn, children } = fakeSpawner(); const evts = [], logs = [];
    const h = createReaderHost({ spawn, resolveExe: async () => 'x.exe', onEvent: (e) => evts.push(e), onLog: (s) => logs.push(s), restartMs: 10 });
    await h.start();
    const buf = Buffer.from('{"t":"main","machine":"POS02","receipt":"R1","total":225,"line":"ไทย"}\nnot json\n{"t":"pay_closed"}\n', 'utf8');
    children[0].stdout.write(buf.subarray(0, 50)); children[0].stdout.write(buf.subarray(50, 53)); children[0].stdout.write(buf.subarray(53));
    await sleep(20);
    assert.deepStrictEqual(evts.map((e) => e.t), ['main', 'pay_closed']); assert.strictEqual(evts[0].line, 'ไทย');
    assert.ok(logs.length >= 1, 'bad line logged');
    // exit → restart; stop → no restart
    children[0].emit('exit', 1); await sleep(40);
    assert.strictEqual(children.length, 2, 'restarted');
    h.stop(); children[1].emit('exit', 0); await sleep(40);
    assert.strictEqual(children.length, 2, 'no restart after stop'); assert.ok(children[1].killed);
  }
  // ไม่มี exe → log ไทย ไม่ spawn ไม่ throw
  {
    const { spawn, children } = fakeSpawner(); const logs = [];
    const h = createReaderHost({ spawn, resolveExe: async () => null, onEvent: () => {}, onLog: (s) => logs.push(s) });
    await h.start(); assert.strictEqual(children.length, 0); assert.ok(logs.length === 1 && /[ก-๙]/.test(logs[0]));
  }
  // record + replay
  {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cd-')), 'rec.jsonl');
    const { spawn, children } = fakeSpawner();
    const h = createReaderHost({ spawn, resolveExe: async () => 'x.exe', onEvent: () => {}, recordPath: f });
    await h.start(); children[0].stdout.write('{"t":"pos_missing"}\n{"t":"pay_closed"}\n'); await sleep(20); h.stop();
    const got = []; await replayFile(f, (e) => got.push(e.t), { intervalMs: 1 });
    assert.deepStrictEqual(got, ['pos_missing', 'pay_closed']);
  }
  console.log('cd-reader-host: ok');
})().catch((e) => { console.error(e); process.exit(1); });
