# เก็บตัวอย่างไฟล์ spool ของใบเสร็จ เพื่อดูว่าอ่านรายการ/ยอดเงินจากใบเสร็จอัตโนมัติได้ไหม
# เรียกโดยแอป (เมนูถาด "เก็บตัวอย่างบิล") ผ่านหน้าต่างขอสิทธิ์ผู้ดูแล (UAC) — โฟลเดอร์ spool อ่านด้วยสิทธิ์ผู้ใช้ปกติไม่ได้
# รันมือก็ได้ (Run as Administrator): powershell -ExecutionPolicy Bypass -File spool-capture.ps1 -Dest C:\temp\samples
#
# หยุดเองเมื่อ: เก็บครบ MaxJobs งาน หรือครบ MaxMinutes นาที หรือมีไฟล์ชื่อ STOP ในโฟลเดอร์ปลายทาง
#   (แล้วรอจนไฟล์ที่ยังพิมพ์ค้างหายไปจาก spool อีกไม่เกิน 20 วินาที เพื่อได้ไฟล์ครบ)
# ข้ามงานพิมพ์ของ POS Hero เอง (เซียมซี/คูปอง/ใบเสร็จของแอป) เพื่อให้ตัวอย่างเป็นบิลของ POS ล้วน ๆ
# ผลลัพธ์: ไฟล์ .SPL/.SHD ต่องาน + samples.zip (ส่งไฟล์ zip นี้) ; ไฟล์อาจมีข้อมูลบิล ส่งเฉพาะคนที่ไว้ใจ
#
# สำคัญ: spooler จองไฟล์ขนาดเต็ม (เช่น 64KB เป็นศูนย์) แล้วค่อยเขียนข้อมูลทีหลัง และลบทิ้งทันทีที่พิมพ์เสร็จ
#        จึงต้องอ่านซ้ำทุก ~40 ms แล้วเขียนทับสำเนาทุกครั้งที่เนื้อหาเปลี่ยน จนกว่าไฟล์จะหายไป
# ถ้าไฟล์ยังได้ไม่ครบ: Printer Properties > Advanced > ติ๊ก "Keep printed documents" แล้วลองใหม่ (spool จะไม่ถูกลบหลังพิมพ์)

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

$MaxBytes = 20MB
$deadline = (Get-Date).AddMinutes($MaxMinutes)
$own = @{}       # base name ที่เป็นงานของแอป (ข้าม)
$tracked = @{}   # base name -> @{ Target; Last(byte[]); Name; Gone(bool) }
$ownMarker = [Text.Encoding]::Unicode.GetBytes('POS Hero')

function Read-Shared([string]$path) {
    # เปิดแบบอนุญาตให้ spooler เขียน/ลบพร้อมกัน; ไม่ได้ = $null
    try {
        $fs = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try {
            $len = [Math]::Min($fs.Length, $MaxBytes)
            $buf = New-Object byte[] $len
            $off = 0
            while ($off -lt $len) { $n = $fs.Read($buf, $off, $len - $off); if ($n -le 0) { break }; $off += $n }
            if ($off -lt $len) { $trim = New-Object byte[] $off; [Array]::Copy($buf, $trim, $off); return ,$trim }
            return ,$buf
        } finally { $fs.Dispose() }
    } catch { return $null }
}
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
function Same-Bytes([byte[]]$a, [byte[]]$b) {
    if ($null -eq $a -or $null -eq $b -or $a.Length -ne $b.Length) { return $false }
    for ($i = 0; $i -lt $a.Length; $i++) { if ($a[$i] -ne $b[$i]) { return $false } }
    return $true
}

$endingSince = $null
while ($true) {
    $ending = ((Get-Date) -ge $deadline) -or ($tracked.Count -ge $MaxJobs) -or (Test-Path -LiteralPath $stop)
    if ($ending -and -not $endingSince) { $endingSince = Get-Date }
    $present = @{}
    try {
        foreach ($spl in (Get-ChildItem -LiteralPath $SpoolDir -Filter '*.SPL' -File -ErrorAction Stop)) {
            $base = $spl.BaseName
            if ($own.ContainsKey($base)) { continue }
            $present[$base] = $true
            if (-not $tracked.ContainsKey($base)) {
                if ($ending) { continue }   # ใกล้จบแล้ว ไม่รับงานใหม่
                # .SHD บอกชื่อเอกสาร/เครื่องพิมพ์: ถ้าเป็นของ POS Hero เองให้ข้าม
                $shd = Join-Path $SpoolDir ($base + '.SHD')
                $shdBytes = if (Test-Path -LiteralPath $shd) { Read-Shared $shd } else { $null }
                if (Has-Marker $shdBytes) { $own[$base] = $true; Log "skip own job $base"; continue }
                $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
                $tracked[$base] = @{ Target = (Join-Path $Dest ("$stamp-" + $spl.Name)); Last = $null; Name = $spl.Name; Shd = (Join-Path $Dest ("$stamp-" + $base + '.SHD')); ShdLast = $null }
                Log "new job $($spl.Name)"
            }
            $t = $tracked[$base]
            $bytes = Read-Shared $spl.FullName
            if ($null -ne $bytes -and -not (Same-Bytes $bytes $t.Last)) {
                try { [IO.File]::WriteAllBytes($t.Target, $bytes); $t.Last = $bytes } catch { }
            }
            $shdPath = Join-Path $SpoolDir ($base + '.SHD')
            if (Test-Path -LiteralPath $shdPath) {
                $sb = Read-Shared $shdPath
                if ($null -ne $sb -and -not (Same-Bytes $sb $t.ShdLast)) { try { [IO.File]::WriteAllBytes($t.Shd, $sb); $t.ShdLast = $sb } catch { } }
            }
        }
    } catch { Log ('cannot read spool dir: ' + $_.Exception.Message); Start-Sleep -Seconds 2 }

    if ($ending) {
        $stillThere = ($tracked.Keys | Where-Object { $present.ContainsKey($_) }).Count
        if ($stillThere -eq 0 -or ((Get-Date) - $endingSince).TotalSeconds -gt 20) { break }
    }
    Start-Sleep -Milliseconds 40
}

foreach ($k in $tracked.Keys) { $t = $tracked[$k]; $n = if ($t.Last) { $t.Last.Length } else { 0 }; Log ("final {0}: {1} bytes" -f $t.Name, $n) }
Log "end jobs=$($tracked.Count)"
try {
    $zip = Join-Path $Dest 'samples.zip'
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    $files = Get-ChildItem -LiteralPath $Dest -File | Where-Object { $_.Name -ne 'samples.zip' -and $_.Name -ne 'STOP' -and $_.Name -ne 'DONE' }
    if ($files) { Compress-Archive -LiteralPath $files.FullName -DestinationPath $zip -Force }
} catch { Log ('zip failed: ' + $_.Exception.Message) }
Set-Content -LiteralPath (Join-Path $Dest 'DONE') -Value $tracked.Count -Encoding ASCII
