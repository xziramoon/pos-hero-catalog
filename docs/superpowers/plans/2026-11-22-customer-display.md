# จอลูกค้า (Customer Display) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เพิ่มหน้ารายการสินค้า / ยอดรวม / จ่ายเงิน / ขอบคุณ ลงจอลูกค้าเดิมของ QR-LOCK โดยอ่านข้อมูลจาก Sea & Hill POS ด้วย UI Automation แบบอ่านอย่างเดียว

**Architecture:** `posreader.exe` (C#, คอมไพล์ด้วย csc ตอนรัน) พิมพ์ JSON lines → `reader-host.js` ส่งอีเวนต์เข้า `cart-state.js` (state machine ล้วน) → `composeView` รวมกับข้อความ QR → `display-server` เดิม broadcast ไปที่ `display.html` เดิม

**Tech Stack:** Node (Electron main, เทสต์ด้วย `node` ธรรมดา + `assert`), C# .NET Framework 4.x (`UIAutomationClient.dll`), HTML/JS ไฟล์เดียว

**Spec:** `docs/superpowers/specs/2026-11-22-customer-display-design.md` (อ่านหัวข้อ 5 และ 9 ก่อนเริ่ม)

## Global Constraints

- posreader **อ่านอย่างเดียว**: ห้ามส่งคีย์ ห้ามคลิก ห้ามแก้ไฟล์/registry ของ Sea & Hill; ห้ามหาช่องด้วย AutomationId (ใช้ ClassName `WindowsForms10.STATIC` / `WindowsForms10.EDIT` + รูปแบบข้อความ)
- ห้ามแตะ logic รับเงิน (inbox, LAN relay, UDP, Pushbullet, พิมพ์สลิป); `test/smoke.js` และเทสต์เดิมต้องผ่าน
- repo เป็น public: ห้าม commit `.exe`, URL Sheet/Apps Script, key, token
- Total ใช้ค่าจาก POS เสมอ ห้ามคำนวณเอง; poll ทุก **300 ms**; reader ส่งเฉพาะตอนค่าเปลี่ยน; POS ไม่เปิดให้ลองใหม่ทุก **2 วินาที** ห้าม crash
- พอร์ตเริ่มต้น **8790** (ไม่ใช่ 8080/8788); thanks ค้าง **8 วินาที**; mismatch tolerance **0.01**
- ข้อความ UI ภาษาไทยทั้งหมด; ทำบน branch `feat/customer-display` เปิด PR ห้าม push ลง main
- โค้ดใหม่ใน `customerdisplay/`; โมดูลต้องพังแล้วไม่กระทบ POS (ห่อ try/catch ที่จุดต่อใน qrlock-main); `test/qrlock-load.test.js` ยืนยันว่า `qrlock-main` export เฉพาะ `init, shutdown, trayItems` — ห้ามเปลี่ยน

## Review Focus

1. POS ปิด/ค้างกลางบิล: ต้องกลับหน้าต้อนรับ ไม่ crash ไม่ค้างรายการเก่า (Task 2, 3)
2. ชื่อสินค้ามี `/`, comma หลักพัน, ช่องว่างรอบ `:`, `ลบ :` ของ barcode ที่ไม่มีในตะกร้า (Task 1, 2)
3. รายการรวมไม่ตรง Total (Recall Bill/ส่วนลด) ต้อง fallback เป็นรายการล่าสุด+Total ไม่ใช่แสดงยอดผิด (Task 2)
4. reader พิมพ์บรรทัด JSON เสีย / exit กะทันหัน / Total เจอ 2 ช่อง (Task 3, 4)
5. จอที่ต่อใหม่กลางบิล และ QR ซ้อนกับ pay/cart ต้องได้สถานะรวมที่ถูกต้อง (Task 2, 5)

---

### Task 1: parse-line

**Files:**
- Create: `customerdisplay/parse-line.js`
- Test: `test/cd-parse-line.test.js`

**Interfaces:**
- Produces: `parseLine(text: string): { action: 'upsert'|'remove', barcode: string, name: string, unit: string, qty: number, price: number, amount: number } | null` (คืน `null` ถ้า parse ไม่ได้; remove คืนเฉพาะ `barcode` ได้ แต่ฟิลด์อื่นเป็น `''`/`0` ถ้าอ่านไม่ได้)

- [ ] **Step 1: Write failing test** ใช้ตัวอย่างจริงจากสเปก §9:
  - `'8850822011676/เค.เอ. ไฮยาอินเทนส์เซรั่ม 7กรัม/แพ็ค/@ 1.00 x 225.00 = 225.00'` → upsert, barcode `8850822011676`, name `เค.เอ. ไฮยาอินเทนส์เซรั่ม 7กรัม`, unit `แพ็ค`, qty 1, price 225, amount 225
  - `'เพิ่ม : 8850822011676/…/แพ็ค/@ 2.00 x 225.00 = 450.00'` → upsert qty 2 amount 450
  - `'ลบ : 8850822011676/…'` และ `'ลบ: …'` (ไม่มีช่องว่างก่อน `:`) → action `remove` barcode ถูก
  - ชื่อมี `/` (`'123/น้ำ 1/2 ลิตร/ขวด/@ 1.00 x 10.00 = 10.00'`) → name `น้ำ 1/2 ลิตร` unit `ขวด`
  - `'…@ 3.00 x 1,250.50 = 3,751.50'` → price 1250.5 amount 3751.5
  - `''`, `'garbage'`, `null` → `null`
- [ ] **Step 2: Run** `node test/cd-parse-line.test.js` → FAIL (module not found)
- [ ] **Step 3: Implement `parseLine`** ตามสเปก §5.3: ตัด prefix → barcode ก่อน `/` แรก → แยกท้ายที่ `/@ ` ตัวสุดท้าย → unit = หลัง `/` สุดท้ายก่อน `/@` → ตัด comma ก่อน `Number()`
- [ ] **Step 4: Run** test → PASS; `node test/run-all.js` ยังผ่าน
- [ ] **Step 5: Commit** `feat(display): parse yellow-bar line`

### Task 2: cart-state + composeView

**Files:**
- Create: `customerdisplay/cart-state.js`
- Test: `test/cd-cart-state.test.js`

**Interfaces:**
- Consumes: `parseLine` (Task 1)
- Produces:
  - `createCartState({ now?: () => number, thanksMs?: number = 8000, log?: (s: string) => void }): { handle(evt): { billSaved: boolean }, view(): View }`
  - `evt` คือ JSON ของ reader (สเปก §5.2): `{t:'main', machine, receipt, total, line}` | `{t:'pay', due, cash, change, transfer}` | `{t:'pay_closed'}` | `{t:'pos_missing'}`
  - `View` = `{type:'idle'}` | `{type:'cart', machine, items:[{barcode,name,unit,qty,price,amount}], lastBarcode, total, hidden: boolean, last: item|null}` | `{type:'pay', machine, due, cash, change, transfer}` | `{type:'thanks', machine, change}`
  - `composeView(qrMsg: {type:string}|null, cartView: View): object` — ถ้า `qrMsg.type` ∈ `show_qr|paid|expired|cancelled` คืน qrMsg, ไม่งั้นคืน cartView (ลำดับ QR > pay > thanks > cart > welcome ผ่านการที่ cartView เองเลือก pay/thanks/cart/idle แล้ว)

- [ ] **Step 1: Write failing tests** (นาฬิกาปลอม) แต่ละข้อเป็น assert แยก:
  - ใบเสร็จแรก + แถบเหลือง baseline: ข้อความแถบเหลืองเดิมที่ค้างมา **ไม่ถูกนับ** จนกว่าจะเปลี่ยน
  - ยิงสินค้าใหม่ → items 1 รายการ, `last` ตรง; ยิงซ้ำ (`เพิ่ม :` qty 2) → upsert ไม่เพิ่มบรรทัด; `ลบ :` → ลบ; `ลบ :` barcode ที่ไม่มี → ไม่ error
  - ใบเสร็จเปลี่ยน → ล้างรายการ + baseline ใหม่
  - ผลรวม amount ต่าง `total` เกิน 0.01 → `hidden: true` และ `log` ถูกเรียก; ต่างไม่เกิน → `hidden: false`
  - `total=0` และไม่มีรายการ → `{type:'idle'}`
  - `pay` → view `pay`; `pay_closed` + receipt เปลี่ยน → `handle` คืน `billSaved: true` และ view `thanks` พร้อมเงินทอนล่าสุด; หลังเวลาผ่าน 8000 ms → idle
  - `pay_closed` + receipt เดิม (Cancel) → กลับ `cart`, `billSaved: false`
  - `pos_missing` → idle และล้างรายการ
  - `composeView`: `show_qr` ชนะ `pay`; `{type:'idle'}`/null → คืน cartView
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** ตามสเปก §5.4; เก็บ `lastReceipt`, `baselineLine`, `lastLine`, Map ตาม barcode (คงลำดับการใส่), `payOpen`, `lastChange`, `savedAt`; "บิลบันทึกแล้ว" = `pay_closed` เมื่อ receipt ที่เห็นล่าสุดต่างจาก receipt ตอน pay เปิด **หรือ** `main` ถัดมามี receipt ใหม่ขณะ `awaitingSave` (ใช้ธง `awaitingSave` ตั้งตอน pay_closed รอ evt `main` ถัดไป ถ้า receipt เปลี่ยนจึง billSaved)
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(display): cart state machine`

### Task 3: reader-host

**Files:**
- Create: `customerdisplay/reader-host.js`
- Test: `test/cd-reader-host.test.js`

**Interfaces:**
- Produces: `createReaderHost({ spawn: (cmd, args) => ChildProcess = child_process.spawn, resolveExe: () => Promise<string|null>, onEvent: (evt) => void, onLog?: (s: string) => void, restartMs?: number = 2000, recordPath?: string }): { start(): Promise<void>, stop(): void }`
- Produces: `replayFile(path: string, onEvent: (evt) => void, { intervalMs?: number }): Promise<void>` อ่าน `.jsonl` แล้วยิงอีเวนต์ตามลำดับ

- [ ] **Step 1: Write failing tests** ด้วย child ปลอม (EventEmitter + stdout stream): แยก JSON lines ที่มาเป็นก้อนครึ่งบรรทัด; บรรทัดเสียถูกข้าม (เรียก `onLog` ไม่ throw); child `exit` → spawn ใหม่หลัง `restartMs` (ใช้ timer ปลอม/ค่าน้อย); `stop()` แล้วไม่ restart; `resolveExe` คืน `null` → `onLog` แจ้งไทยและไม่ spawn; `replayFile` ยิงอีเวนต์ครบตามลำดับ
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** ตาม signature; รับ stdout เป็น utf8 แล้วแยกบรรทัด; ถ้ามี `recordPath` ให้ append บรรทัดดิบลงไฟล์
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** `feat(display): reader host with restart and replay`

### Task 4: posreader.cs + csc compile

**Files:**
- Create: `customerdisplay/posreader.cs`, `customerdisplay/build-reader.js`
- Test: `test/cd-build-reader.test.js`

**Interfaces:**
- Produces: `findCsc(): string|null` (ลอง `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` แล้ว `Framework\v4.0.30319`); `ensureReader({ srcPath: string, outDir: string }): Promise<string|null>` คืน path ของ exe ใน `outDir` คอมไพล์ใหม่เมื่อ sha1 ของ `.cs` เปลี่ยน (เก็บแฮชไว้ข้าง exe), คืน `null` ถ้าไม่มี csc/คอมไพล์ไม่ผ่าน (ไม่ throw)
- posreader CLI: `posreader.exe [--record file.jsonl]` — stdout เป็น JSON lines ตามสเปก §5.2 (`main`/`pay`/`pay_closed`/`pos_missing`); `machine` เติมใน `main`

- [ ] **Step 1: Write failing test** (ข้ามอัตโนมัติถ้า `process.platform !== 'win32'` หรือ `findCsc()` เป็น null): `ensureReader` บนโฟลเดอร์ชั่วคราว → ได้ path ที่มีไฟล์; เรียกซ้ำไม่คอมไพล์ใหม่ (mtime เท่าเดิม); รัน exe 1 วินาทีโดยไม่มี POS → stdout มี `{"t":"pos_missing"}` และ exe ไม่ crash
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement `posreader.cs`**: ลูป 300 ms; หา top-level window ที่ `Name` มี `Sea And Hill POS`; cache element ของ Total/ใบเสร็จ/รหัสเครื่อง/แถบเหลือง (รูปแบบข้อความตามสเปก §5.2) ค้นใหม่เฉพาะเมื่อ `ElementNotAvailableException`/หน้าต่างหาย; Total เจอมากกว่า 1 ช่อง → ไม่ส่ง total (ส่ง `null`) และเขียน stderr; หน้าต่าง `Name=="Pay"` ใน ProcessId เดียวกับ POS จับคู่ป้าย/EDIT ด้วย `BoundingRectangle` ตามสเปก §5.2 (cash อาจไม่มีทศนิยม); ส่งบรรทัดเฉพาะเมื่อค่าเปลี่ยน; POS หาย → `pos_missing` แล้วลองใหม่ทุก 2 วินาที; ห่อทุกการเรียก UIA ด้วย try/catch; `--record` เขียนซ้ำลงไฟล์
- [ ] **Step 4: Implement `build-reader.js`** ตาม signature; เรียก csc ด้วย `/target:exe /reference:UIAutomationClient.dll,UIAutomationTypes.dll` และ `/out:`
- [ ] **Step 5: Run** test → PASS (บนเครื่องที่มี csc) แล้ว commit `feat(display): posreader UIA reader and csc build`
- [ ] **Step 6: Manual (Boss, POS จริง)** รัน exe กับ `--record` ตามเช็กลิสต์สเปก §6 เก็บไฟล์ `.jsonl` ไว้นอก repo (บิลจริงมีข้อมูลร้าน)

### Task 5: display.html views + server state

**Files:**
- Modify: `qrlock/display.html` (ฟังก์ชัน `render`), `qrlock/display-server.js` (ไม่ต้องแก้ถ้า `getLastMessage` ใช้ได้อยู่แล้ว — ยืนยันด้วยเทสต์)
- Test: `test/cd-display-html.test.js`

**Interfaces:**
- Consumes: `View` จาก Task 2 (ข้อความ `cart`/`pay`/`thanks`) ผ่าน WebSocket เดิม
- Produces: `render(m)` รองรับ `m.type` ใหม่ + แสดงรหัสเครื่อง (`m.machine`) เล็กๆ ที่มุมจอ

- [ ] **Step 1: Write failing test** อ่าน `display.html` เป็นข้อความ: มี branch `'cart'`, `'pay'`, `'thanks'` ใน `render`; มีข้อความไทยของหน้า pay ("ยอดชำระ", "รับเงิน", "เงินทอน") และ "ขอบคุณ"; ยังมีสตริงเดิม `ไม่ได้เชื่อมต่อ`; และ `display-server` ส่งข้อความล่าสุดที่เป็นชนิดใหม่ให้ client ที่เพิ่งต่อ (ใช้ createDisplayServer + `getLastMessage` คืน `{type:'cart',...}` ตามแบบเทสต์ใน `test/qrlock-session.test.js`)
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement views** ในธีมแดง-ทอง เดิม: `cart` = รายการซ้าย (ชื่อ, `qty × price`, ยอด) รายการล่าสุดไฮไลต์และเลื่อนลงอัตโนมัติ ยอดรวมตัวใหญ่ขวาล่าง; ถ้า `hidden` แสดงเฉพาะ `last` + total; `pay` ตัวใหญ่ 3 บรรทัด (ใช้ `due`; ไม่แสดง cash/change จนกว่ามีค่า); `thanks` + เงินทอน; รหัสเครื่องมุมจอ; หน้า portrait/landscape เดิมต้องไม่พัง (media query เดิม)
- [ ] **Step 4: Run** → PASS; เปิดด้วยเบราว์เซอร์จริงดูภาพ (ใช้ `node` ยิง `broadcast` ตัวอย่าง) แนบภาพถ่ายหน้าจอใน PR
- [ ] **Step 5: Commit** `feat(display): cart, pay and thanks views`

### Task 6: ต่อเข้า qrlock-main + พอร์ต + ตัวเลือกมือถือ + package

**Files:**
- Modify: `qrlock/qrlock-main.js` (DEFAULTS, `loadConfig`, `start`/`stop`, `send`, `savePhone`), `qrlock/phone.html` (ช่องติ๊กใหม่), `package.json` (`build.files`, `asarUnpack`, `version`)
- Test: `test/cd-integration.test.js`, ปรับ `test/qrlock-load.test.js` ถ้าจำเป็น

**Interfaces:**
- Consumes: `createReaderHost`, `ensureReader`, `createCartState`, `composeView`
- Produces: `DEFAULTS.displayPort = 8790`; `DEFAULTS.portMigrated = false`; `DEFAULTS.phone.autoDisplayAfterBill = false`; `migrateConfig(raw: object): object` (export จาก `customerdisplay/migrate.js`: ถ้า `portMigrated !== true` และ `displayPort` เป็น 8080 หรือไม่มี → ตั้ง 8790; ตั้ง `portMigrated: true` เสมอ)

- [ ] **Step 1: Write failing tests**: `migrateConfig` — 8080→8790 + ธง; 9000 คงเดิม + ธง; มีธงแล้วและเป็น 8080 → คงเดิม; config ว่าง → 8790; `composeView` + `getLastMessage` ที่ qrlock-main ใช้ (แยกเป็นฟังก์ชัน `currentView()` ใน `customerdisplay/` ที่รับ `qrMsg` และ `cart` แล้วเทสต์ได้โดยไม่พึ่ง electron): ต่อ client ใหม่กลางบิลได้ `pay` ไม่ใช่ `idle`; `billSaved` + ตัวเลือกปิด → ไม่เรียกฟังก์ชันกลับจอลูกค้า, ตัวเลือกเปิด → เรียก 1 ครั้ง
- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement**: `loadConfig` ผ่าน `migrateConfig` แล้ว `saveConfig`; ใน `start()` สร้าง cart-state + reader-host (ห่อ try/catch ทั้งหมด — พังแล้ว log อย่างเดียว ห้ามกระทบ QR-LOCK เดิม) แล้วส่ง `server.broadcast(currentView())` เมื่อ view เปลี่ยน (เทียบ JSON) และทุก 1 วินาทีเพื่อให้ thanks หมดเวลา; `getLastMessage` คืน `currentView()`; `stop()` เรียก `reader.stop()`; เมื่อ `billSaved` และ `phoneCfg().enabled && phoneCfg().autoDisplayAfterBill` → `phoneOpenDisplay().catch(() => {})`; `savePhone` เก็บ `autoDisplayAfterBill` เป็น boolean; `phone.html` เพิ่มช่องติ๊ก "กลับหน้าจอลูกค้าเองเมื่อบันทึกบิลแล้ว" ข้าง `autoDisplayOnQr`; `ensureReader` ใช้ `srcPath` = ไฟล์ใน `app.getAppPath()` (unpacked) และ `outDir` = userData; อัปเดต URL/firewall ที่ใช้ `cfg.displayPort` อยู่แล้ว (ตรวจว่าไม่มี 8080 ฝังตายเหลือ: `grep -rn 8080 qrlock/ docs/`)
- [ ] **Step 4: Edit package.json**: เพิ่ม `"customerdisplay/**/*"` ใน `build.files`, `"customerdisplay/posreader.cs"` ใน `asarUnpack`, ยกเวอร์ชันเป็น `1.9.0-catalog.27`
- [ ] **Step 5: Run** `npm test` → ผ่านทั้งหมดรวม `test/smoke.js`
- [ ] **Step 6: Commit** `feat(display): wire customer display into QR-LOCK; port 8790; auto-return option`

### Task 7: ทดสอบเปิดใช้จริงและอัปขึ้น

- [ ] **Step 1:** `npm test` ทั้งชุด → ผ่านทั้งหมด; `git status` ไม่มี `.exe`, ไม่มีไฟล์ record
- [ ] **Step 2: เปิดแอปจริง** `npm start` บนเครื่องนี้ ยืนยัน: แอปไม่ crash, `posreader` คอมไพล์ได้, ถ้า POS ไม่เปิดจอขึ้นหน้าต้อนรับ, เปิด `http://localhost:8790/display` ได้ (ถ้า POS เปิดอยู่ให้ดูอีเวนต์จริงด้วย); รายงานผลตามจริง รวมสิ่งที่ยังทดสอบกับ POS จริงไม่ได้
- [ ] **Step 3: อัปขึ้น** push branch `feat/customer-display` และเปิด PR (ห้ามรวมเข้า main เอง); PR เขียนภาษาไทย ระบุ: ต้องเปิด URL ใหม่พอร์ต 8790 บนมือถือครั้งเดียว, ตัวเลือกกลับจอลูกค้าอัตโนมัติปิดเป็นค่าเริ่มต้น, เช็กลิสต์ทดสอบกับ POS จริง (สเปก §6)
