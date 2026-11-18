# ตัวช่วยสิทธิ์ผู้ดูแลของ POS Hero: คัดลอกไฟล์ spool ของบิลไปไว้ในโฟลเดอร์ที่แอป (สิทธิ์ผู้ใช้ปกติ) อ่านได้
# ทำงานเป็น Scheduled Task ตอนล็อกอิน (ตั้งโดยแอปครั้งเดียว) — อย่าแก้สคริปต์นี้ในโฟลเดอร์แอป: งานจะรันสำเนาที่ C:\ProgramData\PosHero (แก้ได้เฉพาะผู้ดูแล)
# หลักการ: spooler จองไฟล์เต็มขนาดเป็นศูนย์แล้วเติมข้อมูลทีหลัง และลบทิ้งทันทีที่พิมพ์เสร็จ → อ่านซ้ำทุก ~40 ms แล้วเขียนทับสำเนาเมื่อเนื้อหาเปลี่ยน
# ข้ามงานของ POS Hero เอง (.SHD มีคำว่า "POS Hero") ; ไม่รันคำสั่งใดจากไฟล์ที่คัดลอก ; ลบสำเนาเก่าเกิน 30 นาที
# เขียน heartbeat.txt ทุกวินาที ให้แอปรู้ว่าตัวช่วยยังทำงานอยู่

param(
    [Parameter(Mandatory = $true)][string]$Dest,
    [string]$SpoolDir = (Join-Path $env:SystemRoot 'System32\spool\PRINTERS'),
    [int]$RunSeconds = 0,          # 0 = ทำงานตลอด (ใช้ค่ามากกว่า 0 เฉพาะตอนทดสอบ)
    [switch]$NoAdminCheck          # ทดสอบกับโฟลเดอร์จำลองเท่านั้น
)

$ErrorActionPreference = 'Continue'
if (-not $NoAdminCheck) {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) { exit 1 }
}
$mutexName = if ($NoAdminCheck) { 'Local\PosHeroSpoolRelayTest' + [Guid]::NewGuid().ToString('N') } else { 'Global\PosHeroSpoolRelay' }
$mutex = New-Object Threading.Mutex($false, $mutexName)
if (-not $mutex.WaitOne(0)) { exit 0 }   # มีตัวอื่นทำงานอยู่แล้ว

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$MaxBytes = 20MB
$own = @{}
$tracked = @{}   # base -> @{ Target; Last; Shd; ShdLast; Gone }
$ownMarker = [Text.Encoding]::Unicode.GetBytes('POS Hero')
$started = Get-Date
$lastBeat = [DateTime]::MinValue
$lastClean = [DateTime]::MinValue

function Read-Shared([string]$path) {
    try {
        $fs = New-Object IO.FileStream($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try {
            $len = [int][Math]::Min($fs.Length, $MaxBytes)
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

try {
    while ($true) {
        $now = Get-Date
        if ($RunSeconds -gt 0 -and ($now - $started).TotalSeconds -ge $RunSeconds) { break }
        if (($now - $lastBeat).TotalMilliseconds -ge 1000) { try { Set-Content -LiteralPath (Join-Path $Dest 'heartbeat.txt') -Value $now.ToString('s') -Encoding ASCII } catch { }; $lastBeat = $now }
        if (($now - $lastClean).TotalMinutes -ge 5) {
            try { Get-ChildItem -LiteralPath $Dest -File -ErrorAction Stop | Where-Object { $_.Name -ne 'heartbeat.txt' -and $_.LastWriteTime -lt $now.AddMinutes(-30) } | Remove-Item -Force -ErrorAction SilentlyContinue } catch { }
            $lastClean = $now
        }
        $present = @{}
        try {
            foreach ($spl in (Get-ChildItem -LiteralPath $SpoolDir -Filter '*.SPL' -File -ErrorAction Stop)) {
                $base = $spl.BaseName
                if ($own.ContainsKey($base)) { continue }
                $present[$base] = $true
                if (-not $tracked.ContainsKey($base)) {
                    $shd = Join-Path $SpoolDir ($base + '.SHD')
                    $shdBytes = if (Test-Path -LiteralPath $shd) { Read-Shared $shd } else { $null }
                    if (Has-Marker $shdBytes) { $own[$base] = $true; continue }
                    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
                    $tracked[$base] = @{ Target = (Join-Path $Dest ("$stamp-" + $spl.Name)); Last = $null; Seen = $now }
                }
                $t = $tracked[$base]
                $bytes = Read-Shared $spl.FullName
                if ($null -ne $bytes -and -not (Same-Bytes $bytes $t.Last)) {
                    try { [IO.File]::WriteAllBytes($t.Target, $bytes); $t.Last = $bytes } catch { }
                }
            }
        } catch { Start-Sleep -Seconds 2 }
        # งานที่หายไปจาก spool แล้ว (พิมพ์เสร็จ) เลิกติดตาม; สำเนาคงไว้ให้แอปอ่าน
        foreach ($k in @($tracked.Keys)) { if (-not $present.ContainsKey($k)) { $tracked.Remove($k) } }
        foreach ($k in @($own.Keys)) { if (-not $present.ContainsKey($k)) { $own.Remove($k) } }
        Start-Sleep -Milliseconds 40
    }
} finally { try { $mutex.ReleaseMutex() } catch { } }
