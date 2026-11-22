'use strict';
// รัน posreader เป็นโปรเซสลูก: อ่าน JSON lines จาก stdout, เกิดปัญหา/ปิดเองให้เปิดใหม่ — พังแล้วต้องไม่กระทบ POS Hero
const fs = require('fs');
const { spawn: nodeSpawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

function createReaderHost({ spawn = nodeSpawn, resolveExe, onEvent, onLog = () => {}, restartMs = 2000, recordPath } = {}) {
  let child = null, stopped = true, timer = null;

  function handleLine(line) {
    line = line.trim();
    if (!line) return;
    if (recordPath) { try { fs.appendFileSync(recordPath, line + '\n'); } catch (e) { /* ignore */ } }
    let evt;
    try { evt = JSON.parse(line); } catch (e) { onLog('posreader: บรรทัดอ่านไม่ได้: ' + line.slice(0, 80)); return; }
    try { onEvent(evt); } catch (e) { onLog('posreader: onEvent error: ' + (e && e.message)); }
  }
  function schedule() { if (stopped) return; clearTimeout(timer); timer = setTimeout(() => { run().catch(() => {}); }, restartMs); if (timer.unref) timer.unref(); }
  async function run() {
    if (stopped) return;
    let exe = null;
    try { exe = await resolveExe(); } catch (e) { exe = null; }
    if (!exe) { onLog('ไม่พบหรือคอมไพล์ posreader ไม่สำเร็จ (ต้องมี Windows .NET csc.exe) — จอลูกค้าจะแสดงเฉพาะ QR'); return; }
    if (stopped) return;
    let c;
    try { c = spawn(exe, []); } catch (e) { onLog('เปิด posreader ไม่ได้: ' + (e && e.message)); return schedule(); }
    child = c;
    const dec = new StringDecoder('utf8'); let rest = '';
    if (c.stdout) c.stdout.on('data', (d) => { rest += typeof d === 'string' ? d : dec.write(d); const parts = rest.split('\n'); rest = parts.pop(); parts.forEach(handleLine); });
    const ended = () => { if (child === c) child = null; schedule(); };
    c.on('exit', ended); c.on('error', (e) => { onLog('posreader error: ' + (e && e.message)); ended(); });
  }
  return {
    start() { stopped = false; return run(); },
    stop() { stopped = true; clearTimeout(timer); timer = null; if (child) { try { child.kill(); } catch (e) { /* ignore */ } } }
  };
}

async function replayFile(file, onEvent, { intervalMs = 300 } = {}) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch (x) { continue; }
    onEvent(e);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
module.exports = { createReaderHost, replayFile };
