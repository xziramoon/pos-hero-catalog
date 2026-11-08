# เฝ้าคิวเครื่องพิมพ์ ส่งเหตุการณ์เป็น JSON บรรทัดละ 1 รายการออก stdout
#   added = งานเข้าคิว | done = พิมพ์จบ | gone = งานหายจากคิว (lastStatus ใช้แยกว่าจบปกติหรือพลาด)
#   hb = สัญญาณยังทำงานอยู่ (ทุก ~5 วินาที) | error = อ่านคิวไม่ได้
# ใช้: job-watcher.ps1 -PrinterName "<ชื่อเครื่องพิมพ์>" [-IntervalMs 120]
param(
    [Parameter(Mandatory=$true)][string]$PrinterName,
    [int]$IntervalMs = 120
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($o) {
    $o['t'] = (Get-Date).ToString('o')
    [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

$seen = @{}
$first = $true   # รอบแรก: งานที่ค้างอยู่ในคิวแล้ว (เช่น Retained จากเมื่อก่อน) ถือว่าจบไปแล้ว ห้ามทำซ้ำ
$lastHb = Get-Date
Emit @{ e = 'start'; printer = $PrinterName }

while ($true) {
    try {
        $jobs = @(Get-PrintJob -PrinterName $PrinterName -ErrorAction Stop)
    } catch {
        Emit @{ e = 'error'; msg = $_.Exception.Message }
        Start-Sleep -Seconds 2
        continue
    }

    $now = @{}
    foreach ($j in $jobs) {
        $id = [string]$j.Id
        $st = [string]$j.JobStatus
        $now[$id] = $true
        if (-not $seen.ContainsKey($id)) {
            $already = $first -and ($st -match 'Printed|Complete|Retained')
            $seen[$id] = @{ doc = [string]$j.DocumentName; status = $st; done = $already }
            if ($already) { Emit @{ e = 'existing'; id = $j.Id; doc = [string]$j.DocumentName; status = $st } }
            else { Emit @{ e = 'added'; id = $j.Id; doc = [string]$j.DocumentName; status = $st } }
        } else {
            $seen[$id].status = $st
        }
        if (-not $seen[$id].done -and $st -match 'Printed|Complete|Retained') {
            $seen[$id].done = $true
            Emit @{ e = 'done'; id = $j.Id; doc = $seen[$id].doc; status = $st }
        }
    }

    foreach ($id in @($seen.Keys)) {
        if (-not $now.ContainsKey($id)) {
            $s = $seen[$id]
            $seen.Remove($id)
            Emit @{ e = 'gone'; id = [int]$id; doc = $s.doc; lastStatus = $s.status; done = $s.done }
        }
    }

    $first = $false
    if (((Get-Date) - $lastHb).TotalSeconds -ge 5) {
        $lastHb = Get-Date
        Emit @{ e = 'hb' }
    }
    Start-Sleep -Milliseconds $IntervalMs
}
