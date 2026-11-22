# อ่านหน้าจอ Sea & Hill POS ด้วย UI Automation (อ่านอย่างเดียว: ห้ามส่งคีย์ ห้ามคลิก ห้ามแก้ไฟล์/registry ของ POS)
# พิมพ์ JSON 1 บรรทัดต่อ stdout เฉพาะตอนค่าเปลี่ยน (UTF-8):
#   {"t":"main","receipt":"POS02261122-00070","total":225.00,"line":"..."}
#   {"t":"pay","due":225.00,"cash":500,"change":275.00,"transfer":null}
#   {"t":"pay_closed"}   {"t":"pos_missing"}
# due = "คงเหลือทั้งสิ้น" ถ้ามี ไม่มีใช้ "รวมทั้งสิ้น"
# รัน: powershell -NoProfile -ExecutionPolicy Bypass -File custdisplay\pos-reader.ps1
#      เพิ่ม -Interval 300 -Debug1 เพื่อดู log ดีบักที่ stderr

param(
    [int]$IntervalMs = 300,
    [switch]$Debug1,
    [int]$ParentPid = 0   # ถ้าแอปแม่ (POS Hero) ตาย ให้จบเอง ไม่ค้างเป็นโปรเซสกำพร้า
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$stdout.AutoFlush = $true

function Emit($obj) { $stdout.WriteLine(($obj | ConvertTo-Json -Compress)) }
function Dbg($m) { if ($Debug1) { [Console]::Error.WriteLine("[reader] $m") } }

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$Cond = [System.Windows.Automation.Condition]
$P = [System.Windows.Automation.AutomationElement]

function Find-PosWindow {
    $kids = $AE::RootElement.FindAll($TS::Children, $Cond::TrueCondition)
    foreach ($w in $kids) {
        try { if ($w.Current.Name -like '*Sea And Hill POS*') { return $w } } catch {}
    }
    return $null
}

# หน้าต่าง Pay เป็นลูกตรงของหน้าต่างหลัก POS ใน UIA tree (ไม่ใช่ top-level ใต้ Desktop) ยืนยันกับ POS จริงแล้ว
$script:payCond = New-Object System.Windows.Automation.PropertyCondition($P::NameProperty, 'Pay')
function Find-PayWindow($mainWin) {
    if (-not $mainWin) { return $null }
    return $mainWin.FindFirst($TS::Children, $script:payCond)
}

function Statics($root) {
    $c = New-Object System.Windows.Automation.PropertyCondition($P::ClassNameProperty, 'x')
    # ClassName ขึ้นต้นด้วย WindowsForms10.STATIC (ท้ายมีเลขสุ่ม) จึงต้องกรองเอง
    $all = $root.FindAll($TS::Descendants, $Cond::TrueCondition)
    $out = @()
    foreach ($e in $all) { try { if ($e.Current.ClassName -like 'WindowsForms10.STATIC*') { $out += $e } } catch {} }
    return , $out
}

function To-Num([string]$s) {
    $t = ($s -replace ',', '').Trim()
    $d = 0.0
    if ([double]::TryParse($t, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$d)) { return $d }
    return $null
}

# ---- หน้าหลัก: cache element ของ 3 ช่อง (total / line / receipt) ----
$script:posWin = $null
$script:elTotal = $null
$script:elLine = $null
$script:elReceipt = $null
$script:posPid = 0

function Locate-Main {
    $w = Find-PosWindow
    if (-not $w) { return $false }
    $script:posWin = $w
    $script:posPid = $w.Current.ProcessId
    $script:elTotal = $null; $script:elLine = $null; $script:elReceipt = $null
    foreach ($e in (Statics $w)) {
        $n = $e.Current.Name
        if ([string]::IsNullOrEmpty($n)) { continue }
        if (-not $script:elTotal -and $n -match '^-?[\d,]+\.\d{2}$') { $script:elTotal = $e }
        elseif (-not $script:elReceipt -and $n -match '^POS\d+-\d+$') { $script:elReceipt = $e }
        elseif (-not $script:elLine -and $n -match '/@ .+ x .+ = ') { $script:elLine = $e }
    }
    Dbg "located: total=$([bool]$script:elTotal) receipt=$([bool]$script:elReceipt) line=$([bool]$script:elLine)"
    return ($script:elTotal -and $script:elReceipt)
}

function Read-El($el) {
    if (-not $el) { return $null }
    return $el.Current.Name   # ElementNotAvailableException → ให้ผู้เรียกจับแล้วค้นใหม่
}

# แถบเหลืองไม่มีข้อความในบิลใหม่ (ยังไม่ยิง) → หาใหม่เป็นระยะถ้ายังไม่เคยเจอ
function Read-Main {
    $receipt = Read-El $script:elReceipt
    $total = To-Num (Read-El $script:elTotal)
    $line = $null
    if (-not $script:elLine) {
        foreach ($e in (Statics $script:posWin)) {
            if ($e.Current.Name -match '/@ .+ x .+ = ') { $script:elLine = $e; break }
        }
    }
    if ($script:elLine) { $line = Read-El $script:elLine }
    return @{ t = 'main'; receipt = $receipt; total = $total; line = $line }
}

# ---- หน้า Pay: จับคู่ป้าย STATIC กับช่อง EDIT ด้วย BoundingRectangle ----
function Read-Pay($payWin) {
    $statics = Statics $payWin
    $edits = @()
    foreach ($e in $payWin.FindAll($TS::Descendants, $Cond::TrueCondition)) {
        try { if ($e.Current.ClassName -like 'WindowsForms10.EDIT*') { $edits += $e } } catch {}
    }
    $labels = @{ 'รวมทั้งสิ้น' = 'gross'; 'คงเหลือทั้งสิ้น' = 'remain'; 'ชำระเงินสด' = 'cash'; 'เงินทอน' = 'change'; 'เงินโอน' = 'transfer' }
    $vals = @{}
    foreach ($s in $statics) {
        $key = ($s.Current.Name -replace '\s*:\s*$', '').Trim()
        if (-not $labels.ContainsKey($key)) { continue }
        $r = $s.Current.BoundingRectangle
        $best = $null; $bestDx = [double]::MaxValue
        foreach ($ed in $edits) {
            $er = $ed.Current.BoundingRectangle
            $cy = $er.Top + $er.Height / 2
            if ($cy -ge $r.Top -and $cy -le $r.Bottom -and $er.Left -ge ($r.Right - 6)) {  # เผื่อ 6px: ช่อง "เงินโอน" เริ่มก่อนขอบป้าย 2px
                $dx = $er.Left - $r.Right
                if ($dx -lt $bestDx) { $bestDx = $dx; $best = $ed }
            }
        }
        if ($best) { $vals[$labels[$key]] = To-Num $best.Current.Name }
    }
    $due = $vals['remain']; if ($null -eq $due) { $due = $vals['gross'] }
    return @{ t = 'pay'; due = $due; cash = $vals['cash']; change = $vals['change']; transfer = $vals['transfer'] }
}

# ---- ลูปหลัก ----
$lastMain = $null; $lastPay = $null; $payWasOpen = $false; $missingSent = $false

while ($true) {
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
    try {
        if (-not $script:posWin -or -not $script:elTotal) {
            if (-not (Locate-Main)) {
                if (-not $missingSent) { Emit @{ t = 'pos_missing' }; $missingSent = $true; $lastMain = $null; $lastPay = $null; $payWasOpen = $false }
                Start-Sleep -Seconds 2
                continue
            }
            $missingSent = $false
        }

        $m = Read-Main
        $key = "$($m.receipt)|$($m.total)|$($m.line)"
        if ($key -ne $lastMain) { $lastMain = $key; Emit $m }

        $pw = Find-PayWindow $script:posWin
        if ($pw) {
            $pay = Read-Pay $pw
            $pk = "$($pay.due)|$($pay.cash)|$($pay.change)|$($pay.transfer)"
            if (-not $payWasOpen -or $pk -ne $lastPay) { $lastPay = $pk; Emit $pay }
            $payWasOpen = $true
        } elseif ($payWasOpen) {
            $payWasOpen = $false; $lastPay = $null
            Emit @{ t = 'pay_closed' }
        }
    } catch {
        # POS ปิด/รีสตาร์ท หรือ element หมดอายุ → ค้นหาใหม่รอบหน้า (ห้าม crash)
        Dbg "reset: $($_.Exception.GetType().Name)"
        $script:posWin = $null; $script:elTotal = $null; $script:elLine = $null; $script:elReceipt = $null
        Start-Sleep -Milliseconds 500
        continue
    }
    Start-Sleep -Milliseconds $IntervalMs
}
