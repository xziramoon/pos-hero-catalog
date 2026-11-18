# เก็บตัวอย่างไฟล์ spool ของใบเสร็จ เพื่อดูว่าอ่านรายการ/ยอดเงินจากใบเสร็จอัตโนมัติได้ไหม
# เรียกโดยแอป (เมนูถาด "เก็บตัวอย่างบิล") ผ่านหน้าต่างขอสิทธิ์ผู้ดูแล (UAC) — โฟลเดอร์ spool อ่านด้วยสิทธิ์ผู้ใช้ปกติไม่ได้
# รันมือก็ได้ (Run as Administrator): powershell -ExecutionPolicy Bypass -File spool-capture.ps1 -Dest C:\temp\samples
#
# หยุดเองเมื่อ: เก็บครบ MaxJobs งาน หรือครบ MaxMinutes นาที หรือมีไฟล์ชื่อ STOP ในโฟลเดอร์ปลายทาง
# ข้ามงานพิมพ์ของ POS Hero เอง (เซียมซี/คูปอง/ใบเสร็จของแอป) เพื่อให้ตัวอย่างเป็นบิลของ POS ล้วน ๆ
# ผลลัพธ์: ไฟล์ .SPL/.SHD ต่องาน + samples.zip (ส่งไฟล์ zip นี้) ; ไฟล์อาจมีข้อมูลบิล ส่งเฉพาะคนที่ไว้ใจ
# หมายเหตุ: Windows ลบไฟล์ spool ทันทีที่พิมพ์เสร็จ สคริปต์จึงสแกนทุก 40 ms แล้วคัดลอกทันที
# ถ้าได้ไฟล์ว่าง/น้อย: Printer Properties > Advanced > ติ๊ก "Keep printed documents" แล้วลองใหม่

param(
    [string]$Dest = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'spool-samples'),
    [string]$SpoolDir = (Join-Path $env:SystemRoot 'System32\spool\PRINTERS'),
    [int]$MaxJobs = 8,
    [int]$MaxMinutes = 30,
    [switch]$NoAdminCheck   # ใช้ทดสอบกับโฟลเดอร์จำลองเท่านั้น
)

$ErrorActionPreference = 'Continue'
if (-not $NoAdminCheck) {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) { Write-Host 'ต้องรันแบบ Run as Administrator' -ForegroundColor Red; exit 1 }
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$stop = Join-Path $Dest 'STOP'
Remove-Item -LiteralPath $stop -Force -ErrorAction SilentlyContinue
$log = Join-Path $Dest 'capture-log.txt'
function Log($m) { try { Add-Content -LiteralPath $log -Value ((Get-Date).ToString('s') + ' ' + $m) -Encoding UTF8 } catch { } }
Log "start spool=$SpoolDir max=$MaxJobs jobs / $MaxMinutes min"

$deadline = (Get-Date).AddMinutes($MaxMinutes)
$done = @{}      # base name -> $true (คัดลอกแล้ว หรือเป็นงานของแอป)
$jobs = 0
$ownMarker = [Text.Encoding]::Unicode.GetBytes('POS Hero')

function Has-Marker([byte[]]$bytes) {
    if (-not $bytes) { return $false }
    $m = $ownMarker
    for ($i = 0; $i -le $bytes.Length - $m.Length; $i++) {
        if ($bytes[$i] -ne $m[0]) { continue }
        $ok = $true
        for ($j = 1; $j -lt $m.Length; $j++) { if ($bytes[$i + $j] -ne $m[$j]) { $ok = $false; break } }
        if ($ok) { return $true }
    }
    return $false
}

while ((Get-Date) -lt $deadline -and $jobs -lt $MaxJobs -and -not (Test-Path -LiteralPath $stop)) {
    try {
        foreach ($spl in (Get-ChildItem -LiteralPath $SpoolDir -Filter '*.SPL' -File -ErrorAction Stop)) {
            $base = $spl.BaseName
            if ($done.ContainsKey($base)) { continue }
            $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
            $shd = Join-Path $SpoolDir ($base + '.SHD')
            # .SHD บอกชื่อเอกสาร/เครื่องพิมพ์: ถ้าเป็นของ POS Hero เองให้ข้าม
            $shdBytes = $null
            try { if (Test-Path -LiteralPath $shd) { $shdBytes = [IO.File]::ReadAllBytes($shd) } } catch { }
            if (Has-Marker $shdBytes) { $done[$base] = $true; Log "skip own job $base"; continue }
            $target = Join-Path $Dest ("$stamp-" + $spl.Name)
            try {
                Copy-Item -LiteralPath $spl.FullName -Destination $target -ErrorAction Stop
                if ($shdBytes) { [IO.File]::WriteAllBytes((Join-Path $Dest ("$stamp-" + $base + '.SHD')), $shdBytes) }
                $done[$base] = $true; $jobs++
                Log ("copied {0} ({1} bytes)" -f $spl.Name, (Get-Item -LiteralPath $target).Length)
                if ($jobs -ge $MaxJobs) { break }
            } catch { }  # ไฟล์ยังถูกล็อกอยู่ จะลองใหม่รอบหน้า
        }
    } catch { Log ('cannot read spool dir: ' + $_.Exception.Message); Start-Sleep -Seconds 2 }
    Start-Sleep -Milliseconds 40
}

Log "end jobs=$jobs"
try {
    $zip = Join-Path $Dest 'samples.zip'
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    $files = Get-ChildItem -LiteralPath $Dest -File | Where-Object { $_.Name -ne 'samples.zip' -and $_.Name -ne 'STOP' }
    if ($files) { Compress-Archive -LiteralPath $files.FullName -DestinationPath $zip -Force }
} catch { Log ('zip failed: ' + $_.Exception.Message) }
Set-Content -LiteralPath (Join-Path $Dest 'DONE') -Value $jobs -Encoding ASCII
