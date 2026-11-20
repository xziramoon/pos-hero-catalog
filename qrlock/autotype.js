'use strict';
// ระยะ 3: แปลงลำดับปุ่มในตั้งค่า → ขั้นตอนส่งปุ่ม แล้วส่งเข้า Sea & Hill ด้วย PowerShell (SendKeys)
// ["F5","02","ENTER","{AMOUNT}","ENTER"]  ·  "WAIT:300" = หน่วงมิลลิวินาที
const { execFile } = require('child_process');

const NAMED = { ENTER: '{ENTER}', TAB: '{TAB}', ESC: '{ESC}', ESCAPE: '{ESC}', BACKSPACE: '{BACKSPACE}', DELETE: '{DELETE}', UP: '{UP}', DOWN: '{DOWN}', LEFT: '{LEFT}', RIGHT: '{RIGHT}', HOME: '{HOME}', END: '{END}', SPACE: ' ' };
const escText = (t) => String(t).replace(/[+^%~(){}[\]]/g, (c) => '{' + c + '}'); // SendKeys ตัวอักษรพิเศษ

function buildSteps(keys, amount) {
  if (!Array.isArray(keys) || !keys.length) throw new Error('ยังไม่ได้ตั้งลำดับปุ่ม');
  return keys.map((raw) => {
    const k = String(raw).trim();
    const up = k.toUpperCase();
    let m;
    if ((m = /^WAIT:(\d+)$/.exec(up))) return { wait: Math.min(parseInt(m[1], 10), 2000) };
    if (up.startsWith('WAIT:')) throw new Error('รูปแบบหน่วงเวลาผิด: ' + k); // กันพิมพ์ข้อความ WAIT:xx ลง POS
    if (/^F([1-9]|1[0-2])$/.test(up)) return { keys: '{' + up + '}' };
    if (NAMED[up]) return { keys: NAMED[up] };
    if (k === '{AMOUNT}') return { keys: escText(amount) };
    if (/^\{[A-Z]+\}$/.test(k)) throw new Error('ปุ่มไม่รู้จัก: ' + k);
    return { keys: escText(k) };
  });
}

const PS = `
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64)) | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class W {
  public delegate bool EP(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BlockInput(bool b);
  public static IntPtr Find(string part) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { if (!IsWindowVisible(h)) return true; var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      if (sb.ToString().IndexOf(part, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
}
"@
$h = [W]::Find($p.title)
if ($h -eq [IntPtr]::Zero) { Write-Output 'ERR:window-not-found'; exit 2 }
if ([W]::IsIconic($h)) { [void][W]::ShowWindow($h, 9) }
[void][W]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 250
if ([W]::GetForegroundWindow() -ne $h) { Write-Output 'ERR:cannot-foreground'; exit 3 }
$locked = $false
try {
  try { $locked = [W]::BlockInput($true) } catch {}
  foreach ($s in $p.steps) {
    if ($s.wait) { Start-Sleep -Milliseconds $s.wait } else { [System.Windows.Forms.SendKeys]::SendWait($s.keys); Start-Sleep -Milliseconds 80 }
  }
  Write-Output ('OK:' + $locked)
} finally { if ($locked) { [void][W]::BlockInput($false) } }
`;

// คืน { ok, reason } — ไม่โยน error; ถูกฆ่าที่ 3 วิ (ระบบปลดล็อกคีย์บอร์ดให้เองเมื่อโปรเซสจบ)
function runAutoType({ windowTitleContains, keys, amount, timeoutMs = 3000 }) {
  return new Promise((resolve) => {
    let steps;
    try { steps = buildSteps(keys, amount); } catch (e) { return resolve({ ok: false, reason: e.message }); }
    if (!windowTitleContains) return resolve({ ok: false, reason: 'ยังไม่ได้ตั้งชื่อหน้าต่าง Sea & Hill' });
    const b64 = Buffer.from(JSON.stringify({ title: windowTitleContains, steps }), 'utf8').toString('base64');
    const script = Buffer.from("$b64 = '" + b64 + "'\n" + PS, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], { timeout: timeoutMs, windowsHide: true }, (err, out) => {
      const o = String(out || '').trim();
      if (/^OK:/m.test(o)) return resolve({ ok: true });
      if (/window-not-found/.test(o)) return resolve({ ok: false, reason: 'ไม่พบหน้าต่าง Sea & Hill' });
      if (/cannot-foreground/.test(o)) return resolve({ ok: false, reason: 'ดึงหน้าต่าง Sea & Hill ขึ้นมาไม่ได้' });
      resolve({ ok: false, reason: err ? (err.killed ? 'หมดเวลา 3 วินาที' : err.message) : 'ไม่ทราบสาเหตุ' });
    });
  });
}
module.exports = { buildSteps, runAutoType };
