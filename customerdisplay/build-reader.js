'use strict';
// คอมไพล์ posreader.cs ด้วย csc.exe ที่มีอยู่ใน Windows (ไม่ต้องลง Visual Studio) — ไม่ commit ไฟล์ .exe เพราะ repo เป็น public
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const FW = [process.env.windir || 'C:\\Windows', 'Microsoft.NET'];
const FRAMEWORKS = [path.join(...FW, 'Framework64', 'v4.0.30319'), path.join(...FW, 'Framework', 'v4.0.30319')];
function findCsc() { for (const d of FRAMEWORKS) { const p = path.join(d, 'csc.exe'); if (fs.existsSync(p)) return p; } return null; }

function ensureReader({ srcPath, outDir }) {
  return new Promise((resolve) => {
    try {
      const csc = findCsc();
      if (!csc || !fs.existsSync(srcPath)) return resolve(null);
      const hash = crypto.createHash('sha1').update(fs.readFileSync(srcPath)).digest('hex');
      const exe = path.join(outDir, 'posreader.exe'), stamp = path.join(outDir, 'posreader.sha1');
      if (fs.existsSync(exe) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === hash) return resolve(exe);
      fs.mkdirSync(outDir, { recursive: true });
      const fwDir = path.dirname(csc);
      const refs = ['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map((n) => {
        const wpf = path.join(fwDir, 'WPF', n); return '/reference:' + (fs.existsSync(wpf) ? wpf : n);
      });
      execFile(csc, ['/nologo', '/target:exe', '/optimize+', '/out:' + exe, ...refs, srcPath], { windowsHide: true, timeout: 60000 }, (err) => {
        if (err || !fs.existsSync(exe)) return resolve(null);
        try { fs.writeFileSync(stamp, hash); } catch (e) { /* ignore */ }
        resolve(exe);
      });
    } catch (e) { resolve(null); }
  });
}
module.exports = { findCsc, ensureReader };
