'use strict';
// คอมไพล์ posreader.cs ด้วย csc.exe ที่มีอยู่ใน Windows (ไม่ต้องลง Visual Studio) — ไม่ commit ไฟล์ .exe เพราะ repo เป็น public
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const FW = [process.env.windir || 'C:\Windows', 'Microsoft.NET'];
const FRAMEWORKS = [path.join(...FW, 'Framework64', 'v4.0.30319'), path.join(...FW, 'Framework', 'v4.0.30319')];
function findCsc() { for (const d of FRAMEWORKS) { const p = path.join(d, 'csc.exe'); if (fs.existsSync(p)) return p; } return null; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// คอมไพล์อาจล้มเหลวชั่วคราว (ไฟล์ .exe ถูกล็อกโดยโปรแกรมสแกนไวรัส) จึงลองซ้ำได้ — ไม่ throw คืน null ถ้าไม่สำเร็จ
async function ensureReader({ srcPath, outDir, exec = execFile, retryMs = 500, attempts = 3 }) {
  try {
    srcPath = path.resolve(srcPath); outDir = path.resolve(outDir); // csc อ่านพาธที่มี / ปนกับ  ผิด
    const csc = findCsc();
    if (!csc || !fs.existsSync(srcPath)) return null;
    const hash = crypto.createHash('sha1').update(fs.readFileSync(srcPath)).digest('hex');
    const exe = path.join(outDir, 'posreader.exe'), stamp = path.join(outDir, 'posreader.sha1');
    if (fs.existsSync(exe) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === hash) return exe;
    fs.mkdirSync(outDir, { recursive: true });
    const fwDir = path.dirname(csc);
    const refs = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map((n) => {
      const wpf = path.join(fwDir, 'WPF', n); return '/reference:' + (fs.existsSync(wpf) ? wpf : n);
    });
    const args = ['/nologo', '/target:exe', '/optimize+', '/out:' + exe, ...refs, srcPath];
    for (let i = 0; i < attempts; i++) {
      const ok = await new Promise((resolve) => exec(csc, args, { windowsHide: true, timeout: 60000 }, (err) => resolve(!err && fs.existsSync(exe))));
      if (ok) { try { fs.writeFileSync(stamp, hash); } catch (e) { /* ignore */ } return exe; }
      if (i < attempts - 1) await sleep(retryMs);
    }
    return null;
  } catch (e) { return null; }
}
module.exports = { findCsc, ensureReader };
