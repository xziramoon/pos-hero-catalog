// posreader — อ่านข้อความจากหน้าต่าง Sea & Hill POS ด้วย UI Automation "อ่านอย่างเดียว"
// ห้ามส่งคีย์ ห้ามคลิก ห้ามแตะไฟล์/registry ของ POS. ผลลัพธ์: JSON 1 บรรทัดต่ออีเวนต์ เฉพาะตอนค่าเปลี่ยน
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

static class PosReader
{
    static readonly Regex MoneyRe = new Regex(@"^-?[\d,]+\.\d{2}$");
    static readonly Regex ReceiptRe = new Regex(@"^POS\d+-\d+$");
    static readonly Regex MachineRe = new Regex(@"^POS\d+$");
    static readonly Regex BarRe = new Regex(@"/@\s*[\d,]+(\.\d+)?\s*x\s*[\d,]+(\.\d+)?\s*=\s*-?[\d,]+(\.\d+)?\s*$");
    static TextWriter Out;
    static string lastMain = null, lastPay = null;
    static bool payWasOpen = false;

    // main window cache
    static AutomationElement win;
    static int winPid;
    static AutomationElement total, receipt, machine, bar;
    static int totalCount;
    static DateTime lastScan = DateTime.MinValue;
    static string lastTotalText = null;
    // pay cache
    static AutomationElement payWin;
    static Dictionary<string, AutomationElement> payEdits = new Dictionary<string, AutomationElement>();

    static void Emit(string json) { Out.WriteLine(json); }
    static string Esc(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\""); else if (c == '\\') sb.Append("\\\\");
            else if (c < 0x20) sb.Append("\\u" + ((int)c).ToString("x4")); else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
    static double? Num(string s)
    {
        if (s == null) return null;
        s = s.Replace(",", "").Trim();
        double d; return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out d) ? (double?)d : null;
    }
    static string J(double? d) { return d.HasValue ? d.Value.ToString("0.####", CultureInfo.InvariantCulture) : "null"; }
    static string Name(AutomationElement e) { return e.Current.Name ?? ""; }

    static AutomationElement FindMainWindow()
    {
        foreach (AutomationElement w in AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition))
        {
            try { if (Name(w).Contains("Sea And Hill POS")) return w; } catch (Exception) { }
        }
        return null;
    }
    static bool Alive(AutomationElement e)
    {
        try { var n = e.Current.Name; return true; } catch (Exception) { return false; }
    }

    static void ScanMain()
    {
        total = receipt = machine = bar = null; totalCount = 0;
        foreach (AutomationElement e in win.FindAll(TreeScope.Descendants, Condition.TrueCondition))
        {
            try
            {
                if (!e.Current.ClassName.StartsWith("WindowsForms10.STATIC")) continue;
                string t = Name(e).Trim();
                if (MoneyRe.IsMatch(t)) { totalCount++; total = e; }
                else if (ReceiptRe.IsMatch(t)) receipt = e;
                else if (MachineRe.IsMatch(t)) machine = e;
                else if (BarRe.IsMatch(t)) bar = e;
            }
            catch (Exception) { }
        }
        if (totalCount != 1) { Console.Error.WriteLine("total candidates: " + totalCount); }
        lastScan = DateTime.UtcNow;
    }
    static string Read(AutomationElement e) { return e == null ? null : Name(e).Trim(); }

    static bool TickMain()
    {
        if (win == null || !Alive(win))
        {
            win = null; total = receipt = machine = bar = null;
            win = FindMainWindow();
            if (win == null) { EmitMain(null); return false; }
            winPid = win.Current.ProcessId;
            ScanMain();
        }
        try
        {
            // ช่องหลักยังไม่ครบ (เช่นแถบเหลืองว่างตอนเริ่ม) → สแกนซ้ำแบบจำกัดความถี่ หรือเมื่อ Total เปลี่ยน
            string tt = totalCount == 1 ? Read(total) : null;
            bool incomplete = bar == null || receipt == null || machine == null || totalCount != 1;
            if (incomplete && (DateTime.UtcNow - lastScan).TotalSeconds >= 2 || (incomplete && tt != lastTotalText)) ScanMain();
            lastTotalText = tt;
            double? tot = totalCount == 1 ? Num(Read(total)) : null;
            string json = "{\"t\":\"main\",\"machine\":" + Esc(Read(machine)) + ",\"receipt\":" + Esc(Read(receipt)) + ",\"total\":" + J(tot) + ",\"line\":" + Esc(Read(bar)) + "}";
            EmitMain(json);
        }
        catch (ElementNotAvailableException) { win = null; return true; }
        catch (Exception ex) { Console.Error.WriteLine("main: " + ex.Message); win = null; }
        return true;
    }
    static void EmitMain(string json)
    {
        string v = json ?? "{\"t\":\"pos_missing\"}";
        if (v != lastMain) { lastMain = v; Emit(v); }
    }

    static readonly string[] Labels = { "รวมทั้งสิ้น:", "คงเหลือทั้งสิ้น:", "ชำระเงินสด:", "เงินทอน:", "เงินโอน:" };
    static string Norm(string s) { return (s ?? "").Replace(" ", "").Replace("\u00a0", ""); }

    static void ScanPay()
    {
        payEdits.Clear();
        var statics = new List<AutomationElement>(); var edits = new List<AutomationElement>();
        foreach (AutomationElement e in payWin.FindAll(TreeScope.Descendants, Condition.TrueCondition))
        {
            try
            {
                string c = e.Current.ClassName;
                if (c.StartsWith("WindowsForms10.STATIC")) statics.Add(e);
                else if (c.StartsWith("WindowsForms10.EDIT")) edits.Add(e);
            }
            catch (Exception) { }
        }
        foreach (var lab in statics)
        {
            string key = Norm(Name(lab));
            if (Array.IndexOf(Labels, key) < 0) continue;
            var lr = lab.Current.BoundingRectangle; AutomationElement best = null; double bestD = double.MaxValue;
            foreach (var ed in edits)
            {
                var er = ed.Current.BoundingRectangle; double cy = er.Top + er.Height / 2;
                if (cy < lr.Top || cy > lr.Bottom || er.Left < lr.Right - 2) continue;
                double d = er.Left - lr.Right; if (d < bestD) { bestD = d; best = ed; }
            }
            if (best != null) payEdits[key] = best;
        }
    }
    static string PayVal(string label)
    {
        AutomationElement e; if (!payEdits.TryGetValue(label, out e)) return null;
        string s = Name(e).Trim(); return s.Length == 0 ? null : s;
    }
    static void TickPay()
    {
        AutomationElement found = null;
        if (win != null)
        {
            try
            {
                foreach (AutomationElement w in AutomationElement.RootElement.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.NameProperty, "Pay")))
                    if (w.Current.ProcessId == winPid) { found = w; break; }
            }
            catch (Exception) { }
        }
        if (found == null)
        {
            payWin = null;
            if (payWasOpen) { payWasOpen = false; lastPay = null; Emit("{\"t\":\"pay_closed\"}"); }
            return;
        }
        try
        {
            if (payWin == null || !Alive(payWin) || !found.Equals(payWin)) { payWin = found; ScanPay(); }
            payWasOpen = true;
            double? due = Num(PayVal("คงเหลือทั้งสิ้น:")) ?? Num(PayVal("รวมทั้งสิ้น:"));
            string json = "{\"t\":\"pay\",\"due\":" + J(due) + ",\"cash\":" + J(Num(PayVal("ชำระเงินสด:"))) + ",\"change\":" + J(Num(PayVal("เงินทอน:"))) + ",\"transfer\":" + J(Num(PayVal("เงินโอน:"))) + "}";
            if (json != lastPay) { lastPay = json; Emit(json); }
        }
        catch (Exception ex) { Console.Error.WriteLine("pay: " + ex.Message); payWin = null; }
    }

    static void Main(string[] args)
    {
        var stdout = Console.OpenStandardOutput();
        Out = new StreamWriter(stdout, new UTF8Encoding(false)) { AutoFlush = true };
        while (true)
        {
            bool found = false;
            try { found = TickMain(); if (found) TickPay(); }
            catch (Exception ex) { Console.Error.WriteLine("tick: " + ex.Message); win = null; }
            Thread.Sleep(found ? 300 : 2000);
        }
    }
}
