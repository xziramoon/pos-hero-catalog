# Catalog Hero × POS Hero — สเปกสำหรับ Claude Code

> เอกสารนี้สรุปทุกอย่างที่ตกลงกันไว้ เรื่องการทำ "กระเป๋าสินค้า" (แคตตาล็อกพร้อมรูป) ให้อยู่ในชุดเดียวกับ POS Hero (repo `xziramoon/pos-lan`)
> เขียนให้ Claude Code อ่านแล้วลงมือได้ทันที แบ่งงานเป็นเฟส แต่ละเฟสมีเกณฑ์ว่าเสร็จเมื่อไหร่
> ส่วนที่ **ปรับเพิ่มได้ภายหลัง** รวมไว้ที่หัวข้อ 11 และ 12

**ผู้ใช้:** Boss (เจ้าของร้าน อึ้งลักเส็ง มี 2 สาขา) ใช้งานที่หน้าเคาน์เตอร์ ระบบขายหลักคือ Sea & Hill
**ภาษา UI:** ไทยทั้งหมด ส่วนชื่อตัวแปร คอมเมนต์ และ commit message ใช้อังกฤษหรือไทยตามสไตล์ไฟล์เดิม
**เป้าหมายหลัก:** หาสินค้าจากรูปได้เร็ว → คลิก → คัดลอกรหัส → ไปวางใน Sea & Hill

---

## สารบัญ
1. สถานะปัจจุบันของโค้ด
2. การตัดสินใจที่ตกลงแล้ว และเรื่องที่ยังเปิดอยู่
3. สถาปัตยกรรมรวม
4. Data model
5. Cloudflare Worker (ฝั่งเซิร์ฟเวอร์)
6. ฝั่งแอป: sync, cache, offline
7. หน้าต่างกระเป๋าสินค้า (UI/UX)
8. ระบบตัดแต่งรูป (Image pipeline + หน้า "ปรับรูป")
9. ย้ายข้อมูลจาก Catalog Hero เดิม
10. เฟสงานและเกณฑ์ว่าเสร็จ
11. ค่าที่ปรับแต่งได้ (config)
12. จุดต่อขยายและไอเดียทำเพิ่ม
13. การทดสอบ
14. ข้อห้ามและข้อควรระวัง
- ภาคผนวก A: โค้ดต้นแบบ image pipeline (Python/OpenCV)
- ภาคผนวก B: ค่าสีของธีม

---

## 1. สถานะปัจจุบันของโค้ด

### 1.1 `xziramoon/pos-lan` (POS Hero v1.8.2): **ต่อยอดจาก repo นี้**
- Electron 32 ใช้ `electron-builder` ปล่อยอัปเดตผ่าน GitHub releases
- `main.js` สร้างหน้าต่างไร้ขอบ `WIN_WIDTH=400`, `WIN_HEIGHT=700`, `alwaysOnTop`, `skipTaskbar` และมีโหมด mini widget `MINI_WIDTH=210`, `MINI_HEIGHT=86`
  - ค่าเหล่านี้ต้องตรงกับ `--mini-w` / `--mini-h` ใน `renderer/theme-hero.css` ซึ่งต้องแก้ให้ตรงกันเองด้วยมือ
- `preload.js` เปิด `window.heroWindow` (เปิด/ปิดหน้าต่าง, ปักหมุด, mini mode, inbox, พิมพ์ ฯลฯ)
- `renderer/`: `index.html`, `app.js` (~165KB), `base.css`, `theme-hero.css`, `hero-chrome.js`, `hero-sprite.js` และฟอนต์ `assets/fonts/PressStart2P.woff2` กับ `VT323.woff2`
- ธีมเปลี่ยนด้วย `:root[data-theme="..."]` มีทอง-อำพัน (ค่าเริ่มต้น), `emerald`, `navy`, `ember` และรุ้ง RGB โดยใช้ตัวแปร `--hero-*` (ภาคผนวก B)
- สไตล์หลัก:
  - กรอบนูน 3D คือ `border-color: lt dk dk lt`
  - แถบหัว `.hero-titlebar` สูง 36px ใช้ gradient `#241a44 → #150e28`
  - แถบปุ่มล่าง `.floating-controls`
  - แท็บ `.filter-tab` / `.filter-tab.active`
- ข้อมูลเงินเก็บใน `localStorage` (`posUltimateRecords` ฯลฯ) **ไม่มีข้อมูลสินค้าเลย**
- `cloudflare-inbox/` คือ Worker ชื่อ `pos-hero-inbox` ใช้ Durable Object `Inbox` แบบ SQLite (`new_sqlite_classes`)
  - เลียนแบบ Firebase REST/SSE ที่ path `/pos_hero_inbox/{key}/events.json` และ `heartbeat.json`
  - key ยาว 32–128 ตัว
  - มีชุดทดสอบ `test/smoke.js` และคู่มือ `docs/cloudflare-setup.md`
- มีช่องทางสำรอง UDP broadcast ในวง LAN (`LanInbox`) และ HTTP server ในวง LAN สำหรับรับแจ้งเตือนจากมือถือ

### 1.2 `xziramoon/catalog-hero` (Catalog Hero v1.1.0): **ต้นทางข้อมูลเดิม**
- Electron แยกตัว `renderer/app.js` (~58KB) เป็นธีมน้ำตาลส้ม การ์ดมนๆ ใช้ฟอนต์ Prompt กับ Remix Icon
- ข้อมูลอยู่ในไฟล์ `catalog-data.json` (ที่ `%APPDATA%\Catalog Hero\` หรือในโฟลเดอร์แชร์) โครงสร้างคือ
  `{ items:[{id,name,code,cat,img}], categories:[...], favoriteIds:[...], shopName, auth }`
  - `img` คือ dataURL JPEG ที่ย่อให้กว้างไม่เกิน 500px **ฝังอยู่ใน JSON** ทำให้ไฟล์ใหญ่
  - `id` สร้างจาก `Date.now()`
- `sync.js` ซิงก์ผ่านโฟลเดอร์แชร์ใน LAN โดยเช็กไฟล์ทุก 2 วินาที (ดูจาก mtime และขนาดไฟล์)
  - **ปัญหา:** บันทึกทับกันทั้งไฟล์ และตอนออฟไลน์แล้วต่อกลับจะเขียนทับข้อมูลของเครื่องอื่น
- `auth.js` เป็นระบบล็อกการแก้ไขด้วย ID+รหัสผ่าน ใช้ scrypt (N=16384, r=8, p=1) แฮชเก็บใน `auth`
- พฤติกรรมเดิม:
  - คลิกการ์ด = `copyCode(item.code)`
  - โหมดเลือกหลายชิ้น
  - ย้ายหมวด, ลบ, ของโปรด

### 1.3 Design prototype
- แคนวาส "Catalog Hero — Inventory" ในบัญชี claude.ai ของ Boss มี 4 บอร์ด
  - `Main`: กระเป๋าสินค้าชุดเดียวกับ POS Hero
  - `Crop`: หน้าปรับรูป
  - `PhotoTest`: ทดสอบรูปจริง 8 แบบ
  - `Main-v1`: แบบแรก
- **ใช้หัวข้อ 7 และ 8 ในเอกสารนี้เป็นสเปกหลัก** แคนวาสเป็นแค่ภาพอ้างอิง

---

## 2. การตัดสินใจที่ตกลงแล้ว และเรื่องที่ยังเปิดอยู่

### ตกลงแล้ว
| เรื่อง | ข้อสรุป |
|---|---|
| หน้าตา | ธีม pixel RPG ชุดเดียวกับ POS Hero ใช้ตัวแปร `--hero-*` เดิม ฟอนต์ Sarabun / Press Start 2P / VT323 กรอบนูน และรองรับทุกธีมของ POS Hero |
| รูปแบบหน้าจอ | ช่องเก็บของแบบเกม (ตาราง slot) + การ์ดรายละเอียดสินค้าด้านขวา + แท็บหมวดแบบ `.filter-tab` |
| คลิกช่อง | **คัดลอกรหัสทันที** + เลือกสินค้านั้นในการ์ด มีแอนิเมชัน COPIED และแถบแจ้งเตือน |
| แก้ไขสินค้า | คลิกขวาที่ช่อง หรือกดปุ่ม "แก้ไข" ในการ์ด คลิกซ้ายต้องไม่เปิดหน้าแก้ไข |
| รูปสินค้า | ใช้รูปจริง ผ่านระบบตัดแต่งอัตโนมัติ (หัวข้อ 8) ทุกรูปสี่เหลี่ยมจัตุรัสบนพื้นครีม **ห้ามแสดงรูปแบบ object-fit: cover กับรูปดิบ** |
| รูป 2 แบบ | รูปในช่องตาราง (ซูมเน้นฉลากได้) แยกจากรูปใหญ่ในการ์ด (เห็นทั้งชิ้น) |
| ซิงก์ | ผ่าน Cloudflare (Worker + Durable Object SQLite + R2) ใช้ข้ามเครื่องและข้ามสาขาได้ แทนโฟลเดอร์แชร์ใน LAN |
| Worker | **เพิ่มเข้าไปใน Worker `pos-hero-inbox` ตัวเดิม** ใช้ URL เดียวกัน deploy คำสั่งเดียว แต่ใช้ Durable Object class ใหม่แยกจาก `Inbox` |
| ออฟไลน์ | ทุกเครื่องเก็บสำเนาไว้ในตัว ค้นและคัดลอกรหัสได้ตอนเน็ตล่ม ส่วนที่แก้ระหว่างนั้นเข้าคิวรอ (outbox) |
| รวมข้อมูล | รวมทีละสินค้าตามเวลาที่แก้ล่าสุด (per-item last-write-wins) ลบแบบทิ้งเครื่องหมายไว้ (tombstone) **ห้ามเขียนทับทั้งก้อน** |

### ยังเปิดอยู่ (ถ้า Boss ยังไม่ตอบ ใช้ค่าเริ่มต้นนี้ไปก่อน)
| เรื่อง | ค่าเริ่มต้น | ทางเลือก |
|---|---|---|
| รวมเป็นโปรแกรมเดียวหรือแยก | **รวมเข้า POS Hero (pos-lan)** เปิดเป็นหน้าต่างที่ 2 | แยกโปรแกรม Catalog Hero ไว้เหมือนเดิมแต่ใช้ Worker ตัวเดียวกัน ทำให้สลับได้ง่ายโดยแยกโค้ดไว้ใน `catalog/` (หัวข้อ 3.2) |
| ที่เก็บรูป | R2 | ถ้า Boss ไม่อยากผูกบัตรกับ Cloudflare (ตอนเปิด R2 มักขอให้ผูก) เก็บแค่รูปในช่องตารางเป็น BLOB ใน Durable Object ได้ ต้องเช็กขีดจำกัดขนาดต่อแถวก่อน |
| ราคาในแคตตาล็อก | ยังไม่มี | ดูหัวข้อ 12 (ใช้กับหน้า 60:40) |
| ปุ่มลัด | `F2` | ตั้งค่าได้ (หัวข้อ 11) |

---

## 3. สถาปัตยกรรมรวม

```
┌──────────────── POS Hero (Electron, pos-lan) ───────────────┐
│ main process                                                 │
│  ├─ main.js (เดิม: หน้าต่างเงิน, inbox, LAN, พิมพ์)            │
│  └─ catalog/  ← ใหม่ทั้งหมด                                    │
│       ├─ catalog-window.js   สร้าง/ซ่อนหน้าต่างกระเป๋า, F2       │
│       ├─ catalog-store.js    cache ในเครื่อง + outbox + merge    │
│       ├─ catalog-sync.js     คุยกับ Worker (pull/push/รูป)       │
│       ├─ catalog-images.js   เก็บไฟล์รูปในเครื่อง                 │
│       └─ catalog-migrate.js  ย้ายจาก catalog-data.json           │
│ renderer (หน้าต่างที่ 2, preload แยก)                           │
│  └─ renderer/catalog/                                          │
│       ├─ index.html, catalog.css (ใช้ theme-hero.css ร่วม)       │
│       ├─ catalog-app.js      UI กระเป๋า + การ์ด + แท็บ            │
│       ├─ photo-editor.js     หน้า "ปรับรูป"                       │
│       └─ image-worker.js     Web Worker รัน OpenCV.js             │
└──────────────────────────────────────────────────────────────┘
              │  HTTPS (fetch)  ▲ poll ทุก N วินาที
              ▼                 │
┌──── Cloudflare Worker: pos-hero-inbox (เดิม + เพิ่ม) ────┐
│  /pos_hero_inbox/...      → DO Inbox (เดิม ห้ามแตะ)          │
│  /catalog/{key}/...       → DO Catalog (ใหม่, SQLite)        │
│  /catalog/{key}/img/...   → R2 bucket CATALOG_IMAGES         │
└──────────────────────────────────────────────────────────┘
```

### 3.1 หลักแยกความเสี่ยง
- **ระบบรับเงินโอนสำคัญที่สุด** โค้ดแคตตาล็อกต้องอยู่ใน `catalog/` และ `renderer/catalog/` เท่านั้น การแก้ `main.js` เดิมให้มีแค่จุดเชื่อมเล็กๆ: `require('./catalog/catalog-window')`, ลงทะเบียน IPC และปุ่มลัด
- หน้าต่างกระเป๋าเป็น `BrowserWindow` แยก มี `preload-catalog.js` ของตัวเอง เปิด `window.catalogAPI` ถ้า renderer ของกระเป๋าค้างหรือ crash หน้าต่างเงินต้องทำงานต่อได้
- งานหนักของ image pipeline รันใน Web Worker ห้ามรันใน main process
- ทุก `try/catch` ฝั่งแคตตาล็อกต้องไม่โยน error ขึ้นไปถึง process หลัก ให้ log ด้วย prefix `[catalog]`

### 3.2 ถ้า Boss เลือกแยกโปรแกรม
ทั้งโฟลเดอร์ `catalog/` และ `renderer/catalog/` ต้องยกไปใส่ Electron shell แยกได้โดยแก้น้อยที่สุด เพราะฉะนั้นห้ามอ้างตัวแปร global ของ `main.js` ตรงๆ ให้รับผ่านพารามิเตอร์ของฟังก์ชัน `init({ app, getMainWindow, userDataDir, config })`

---

## 4. Data model

### 4.1 สินค้า (Item): ใช้ร่วมกันทั้ง Worker และแอป
```jsonc
{
  "id": "01J9Z...",            // ULID (string) — สร้างที่เครื่อง ห้ามใช้ Date.now() ตัวเลขอีก
  "code": "00101",             // รหัสที่คัดลอกไปวางใน Sea & Hill (string เสมอ เก็บเลข 0 นำหน้า)
  "name": "เคลียร์ เมน ดีพโอเชี่ยน",
  "shortName": "เคลียร์ ดีพโอเชี่ยน 450",  // ชื่อสั้นใต้ช่อง (ว่าง = ใช้ name)
  "cat": "ของใช้ส่วนตัว",
  "fav": true,                 // แทน favoriteIds เดิม (ย้ายเข้ามาในตัวสินค้า เพื่อ merge ทีละชิ้นได้)
  "barcodes": ["885..."],      // ทางเลือก — สำหรับยิงบาร์โค้ดค้นหา
  "tags": [],                  // ทางเลือก
  "image": {                   // null = ยังไม่มีรูป
    "hash": "sha256-hex",      // hash ของไฟล์ต้นฉบับ → ใช้เป็น key ใน R2
    "ver": 3,                  // เพิ่มทุกครั้งที่ประมวลผลรูปใหม่ (ใช้ทำ cache-busting)
    "edit": { ... },           // ค่าการตัดแต่ง (หัวข้อ 8.4) — เก็บไว้เพื่อแก้ซ้ำได้
    "quality": "ok" | "check" | "retake",   // ผลให้คะแนนอัตโนมัติ (หัวข้อ 8.3)
    "w": 1024, "h": 1024
  },
  "updatedAt": 1791240299123,  // ms — เวลาที่แก้ (ของเครื่องที่แก้)
  "updatedBy": "device-id",    // ไว้ตัดสินเมื่อ updatedAt เท่ากัน + debug
  "rev": 1532,                 // ลำดับที่ server ให้ (เพิ่มขึ้นเรื่อยๆ ทั้ง catalog)
  "deleted": false             // tombstone
}
```

### 4.2 ข้อมูลระดับร้าน (Meta)
```jsonc
{ "categories": ["ทั่วไป", "ของใช้ส่วนตัว", ...],   // ลำดับที่แสดงในแท็บ
  "shopName": "ร้าน อึ้งลักเส็ง ซุปเปอร์มาร์เก็ต",
  "schemaVersion": 1,
  "updatedAt": ..., "rev": ... }
```
- categories รวมแบบ last-write-wins ทั้งรายการ (เปลี่ยนไม่บ่อย) แต่ต้องมี `ทั่วไป` เสมอ
- **ไฟล์รูปไม่ฝังใน JSON อีกต่อไป**

### 4.3 กฎ merge (ทั้ง server และ client ใช้ฟังก์ชันเดียวกัน `mergeItem(local, remote)`)
1. ฉบับที่ `updatedAt` มากกว่าชนะ
2. ถ้า `updatedAt` เท่ากัน ให้ `updatedBy` ที่เรียงตามตัวอักษรแล้วมากกว่าชนะ (กำหนดแน่นอน)
3. tombstone ก็เป็นการแก้แบบหนึ่ง ใช้กฎเดียวกัน ลบแล้วจะไม่ฟื้นกลับ เว้นแต่มีการแก้ที่ใหม่กว่า
4. server ปฏิเสธ `updatedAt` ที่ล้ำอนาคตเกิน 10 นาที (นาฬิกาเครื่องเพี้ยน) โดยตอบ 409 พร้อมเวลาของ server ให้ client ปรับ offset แล้วส่งใหม่
5. เขียนฟังก์ชันนี้เป็น module เดียว (`catalog/shared/merge.js`) แล้ว copy หรือ bundle ไปใช้ใน Worker ด้วย พร้อม unit test

---

## 5. Cloudflare Worker (ฝั่งเซิร์ฟเวอร์)

### 5.1 แก้ `cloudflare-inbox/`
- `wrangler.toml` เพิ่ม
  ```toml
  [[durable_objects.bindings]]
  name = "CATALOG"
  class_name = "Catalog"

  [[r2_buckets]]
  binding = "CATALOG_IMAGES"
  bucket_name = "pos-hero-catalog"

  [[migrations]]
  tag = "v2"
  new_sqlite_classes = ["Catalog"]
  ```
- `src/index.js`: route `/catalog/...` ไปที่ `Catalog` **ก่อน**เช็ก `KEY_PATH_RE` ของ inbox เดิม ส่วนโค้ดของ inbox ห้ามเปลี่ยนพฤติกรรม
- แยกโค้ดไว้ที่ `src/catalog.js` แล้ว export class `Catalog` ออกจาก `index.js`

### 5.2 Auth
- `{key}` ใน path คือ **Catalog Key** ยาว 32–128 ตัว `[A-Za-z0-9_-]` เหมือนกฎ inbox เดิม แต่ละ key ได้ Durable Object ของตัวเอง (`idFromName(key)`)
- การเขียนทุกครั้งต้องแนบ header `X-Catalog-Write: <writeToken>`
  - writeToken ตั้งครั้งแรกด้วย `POST /catalog/{key}/init` แล้ว Worker เก็บเป็นแฮชไว้ใน DO
  - เครื่องที่มีแค่ key อ่านได้อย่างเดียว ใช้ทำเครื่องโชว์หรือเครื่องพนักงาน
- ระบบล็อกการแก้ไขด้วย ID+รหัสผ่านแบบเดิมของ Catalog Hero ยังเก็บไว้ในเครื่องได้ เป็นชั้นป้องกันใน UI

### 5.3 Endpoints
| Method | Path | ใช้ทำอะไร |
|---|---|---|
| GET | `/catalog/{key}/health` | `{ok, rev, itemCount, serverTime}` |
| POST | `/catalog/{key}/init` | ตั้ง writeToken ครั้งแรก (ถ้าตั้งแล้วตอบ 409) |
| GET | `/catalog/{key}/changes?since=<rev>&limit=500` | `{items:[...], meta?, rev, more:boolean, serverTime}` ส่งเฉพาะที่ `rev > since` |
| POST | `/catalog/{key}/items` | body `{items:[Item...]}` สูงสุด 200 ชิ้นต่อครั้ง server ใช้ `mergeItem` ชิ้นที่ชนะได้ `rev` ใหม่ ตอบ `{accepted:[{id,rev}], rejected:[{id,reason, current}]}` |
| PUT | `/catalog/{key}/meta` | categories / shopName |
| PUT | `/catalog/{key}/img/{hash}/{variant}` | อัปโหลดรูป โดย `variant` เป็น `orig` / `full` / `thumb` (`image/jpeg` หรือ `image/webp`, ≤ 5MB) |
| GET | `/catalog/{key}/img/{hash}/{variant}` | ดึงรูป ใส่ `Cache-Control: public, max-age=31536000, immutable` เพราะ hash และ variant ไม่เปลี่ยน |
| GET | `/catalog/{key}/export` | ดาวน์โหลดสำรองทั้ง catalog เป็น JSON (ไม่รวมรูป) |

- R2 object key: `{keyHash}/{hash}/{variant}.jpg` ใช้ `keyHash` (sha256 ของ key) แทน key ดิบ
- ไฟล์ thumb และ full ที่ประมวลผลใหม่ให้ใช้ชื่อ `{hash}/{variant}-v{ver}` หรือแนบ `?v=` ตอนดึง อย่าเขียนทับไฟล์ที่ cache แบบ immutable ไว้แล้ว
- CORS เปิดแบบเดียวกับ inbox เดิม เผื่อทำหน้าเว็บหรือมือถือในอนาคต

### 5.4 SQLite schema ใน DO `Catalog`
```sql
CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, rev INTEGER, updated_at INTEGER, updated_by TEXT, deleted INTEGER, data TEXT);
CREATE INDEX IF NOT EXISTS items_rev ON items(rev);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);   -- meta, rev counter, write token hash, schemaVersion
```
- tombstone เก็บไว้อย่างน้อย 90 วันแล้วค่อยล้าง (`kv.tombstoneHorizonRev`) ถ้าเครื่องไหนส่ง `since` เก่ากว่า horizon ให้ตอบ `{resetRequired:true}` เพื่อให้ client ดึงใหม่ทั้งหมด

### 5.5 โควตาฟรี
- ใช้ `changes?since=` เท่านั้น ห้ามดึงทั้ง catalog ทุกรอบ
- poll ทุก 5 วินาทีตอนหน้าต่างเปิดอยู่ และทุก 60 วินาทีตอนซ่อน: 2 สาขา × 2 เครื่อง ใช้ไม่ถึงหมื่น request ต่อวัน ส่วน inbox เดิมใช้ประมาณ 290 ครั้งต่อวัน
- ทางเลือก: ทำ SSE แบบเดียวกับ inbox เดิม (`Accept: text/event-stream`) เพื่อลดการ poll ทำได้ในเฟสหลัง

### 5.6 ชุดทดสอบ
เพิ่ม `test/catalog-smoke.js` ใช้รูปแบบเดียวกับ `smoke.js` (ใช้ key สุ่ม ไม่ปนข้อมูลร้าน) ให้ครอบคลุม:
- init
- push 3 ชิ้น
- changes since 0
- แก้ชนกันจาก 2 deviceId
- tombstone
- อัปโหลดและดึงรูป
- ไม่มี writeToken ต้องได้ 401

ให้ `npm test` รันทั้งชุดเดิมและชุดใหม่

---

## 6. ฝั่งแอป: sync, cache, offline

### 6.1 ที่เก็บในเครื่อง (`app.getPath('userData')/catalog/`)
```
catalog/
  db.json            ← { items:{id:Item}, meta, lastRev, deviceId, clockOffset }  (เขียนแบบ tmp+rename เหมือน sync.js เดิม)
  outbox.json        ← คิวการแก้ที่ยังไม่ได้ส่ง [{op:'item'|'meta'|'img', payload, tries, nextAt}]
  images/{hash}/{variant}-v{ver}.jpg
  backups/db-YYYYMMDD.json  ← สำรองวันละครั้ง เก็บ 14 ไฟล์ล่าสุด
```
- ถ้ามีสินค้าหลักหมื่นชิ้น `db.json` จะใหญ่ ให้เตรียมย้ายไปใช้ SQLite ในเครื่อง (`better-sqlite3`) ในเฟสหลังได้ โดยหุ้ม store ไว้หลัง interface เดียว: `get/put/list/changesSince`

### 6.2 Flow
- **แก้หรือเพิ่มสินค้า:** เขียนลง `db.json` ทันที (UI อัปเดตทันที) แล้วต่อคิว outbox แล้วสั่ง flush
- **flush:** ส่ง outbox ตามลำดับ
  - รูปต้องขึ้นก่อน item ที่อ้างถึง hash ของรูปนั้น
  - ถ้าไม่สำเร็จ ให้รอนานขึ้นแบบ exponential backoff (2s → 4s → … สูงสุด 5 นาที)
- **pull:** `changes?since=lastRev` → `mergeItem` กับของในเครื่อง → บันทึก → ส่ง `catalog:changed` ไปที่ renderer → ดึงรูปที่ hash/ver เปลี่ยนแบบ lazy (เฉพาะช่องที่มองเห็นก่อน)
- **ไฟสถานะในแถบหัว:**
  - เขียว = ซิงก์แล้ว
  - เหลือง = มีงานในคิว N รายการ
  - แดง = ต่อ Worker ไม่ได้ (โชว์เวลาที่ซิงก์สำเร็จครั้งล่าสุด)
- ถ้า pull ล้มเหลวติดกันหลายนาที ให้ขึ้นแถบเตือนแบบเดียวกับ `#inboxGapBar` ว่า "ของที่ใส่ตอนนี้ยังไม่ส่งไปเครื่องอื่น"
- ต้องทำงานได้ตอนเครื่องย้ายไปใช้ฮอตสปอตมือถือ (Worker เป็น HTTPS ธรรมดา) ให้ฟัง `network-changed` แบบเดียวกับที่ main.js เดิมทำ แล้วสั่ง pull ทันที

### 6.3 ตั้งค่า
อยู่ในหน้าต่างกระเป๋า เมนู "ตั้งค่า Cloudflare"
- Worker URL: ใช้ค่าเดียวกับช่อง Database URL ของ inbox เป็นค่าเริ่มต้น ถ้าว่างให้ดึงจาก `inboxConfig`
- Catalog Key: สุ่มให้ 40 ตัว และมีปุ่มคัดลอกไปตั้งเครื่องอื่น
- Write token
- ปุ่ม "ทดสอบการเชื่อมต่อ"
- เก็บค่าไว้ใน `userData/catalog/config.json` ห้ามเก็บใน localStorage เพราะ main process ต้องใช้

---

## 7. หน้าต่างกระเป๋าสินค้า (UI/UX)

### 7.1 หน้าต่าง
- `BrowserWindow` ไร้ขอบ ขนาดเริ่มต้น 920×752 (ต่ำสุด 640×520) ปรับขนาดได้ จำตำแหน่งและขนาดไว้
- วางอัตโนมัติชิดซ้ายของหน้าต่าง POS Hero หรือ widget จิ๋ว ถ้าจอแคบให้วางซ้อนตรงกลาง
- เปิด/ปิดด้วย:
  - **F2** (`globalShortcut`) ถ้ามีโปรแกรมอื่นจองปุ่มนี้แล้วให้แจ้งเตือนและให้เลือกปุ่มใหม่
  - ปุ่มกระเป๋าใหม่ใน `.hero-titlebar-btns`
  - ปุ่มกระเป๋าที่ติดด้านซ้ายของ mini widget (ขนาด 54×86 ใช้กรอบนูนแบบเดียวกัน)
    - **ระวัง:** การเพิ่มปุ่มนี้กระทบ `MINI_WIDTH` กับ `--mini-w` และแอนิเมชันย่อ/ขยาย ทางที่ปลอดภัยกว่าคือทำเป็น `BrowserWindow` จิ๋วแยก หรือวางปุ่มไว้ใน widget เดิมโดยไม่เปลี่ยนขนาด ให้ประเมินก่อนลงมือ
  - `Esc` เพื่อซ่อน
- เปิดหน้าต่างแล้ว focus ไปที่ช่องค้นหาทันที ปิดแล้วซ่อน (`hide()`) ไม่ต้องทำลายหน้าต่าง จะได้เปิดครั้งต่อไปได้ทันที
- ปักหมุดลอยบนสุดได้ แบบเดียวกับ `btnPin`

### 7.2 Layout (ตามบอร์ด Main)
```
┌ titlebar 36px: [กระเป๋า] CATALOG HERO · INVENTORY · กระเป๋าสินค้า ●ซิงก์   [ปักหมุด][ซ่อน][ปิด] ┐
│ ┌ paper (กรอบนูน 3px) ─────────────────────────────────────────────┐ │
│ │ แถบเควส: "กระเป๋าสินค้า" + คำแนะนำสั้น (คลิก=คัดลอก · คลิกขวา=แก้ไข · Enter) │ │
│ │ [ค้นหา / ยิงบาร์โค้ด ..........................SCAN] [+ เพิ่มสินค้า] │ │
│ │ แท็บ: ทั้งหมด · <หมวด...> · ★ของโปรด · ยังไม่มีรูป · ต้องตรวจรูป   n/m ช่อง │ │
│ │ ┌ ตาราง slot (panel-3) ─────────────┐ ┌ การ์ดสินค้า 268px ──────┐ │ │
│ │ │ ▢ ▢ ▢ ▢ ▢                         │ │ แถบระดับ (LEGENDARY/COMMON)│ │ │
│ │ │ ▢ ▢ ▢ ▢ ▢   (virtualized)          │ │ รูปใหญ่ 224px             │ │ │
│ │ │ ▢ ▢ ▢ ▢ ▢                         │ │ ชื่อ · หมวด · แหล่งรูป      │ │ │
│ │ └──────────────────────────────────┘ │ รหัส (VT323 30px) [คัดลอก] │ │ │
│ │                                        │ [ปรับรูป][แก้ไข][★]        │ │ │
│ └────────────────────────────────────────┴──────────────────────────┘ │
│ skill bar: [เลือกหลายชิ้น][ย้ายหมวด][ตั้งค่า Cloudflare][สำรองข้อมูล] …… ปิด/เปิด [F2] │
└──────────────────────────────────────────────────────────────────────┘
```

### 7.3 ช่อง (slot)
- ขนาด 100×126 (รูปกรอบ 88×88 + ชื่อ 1 บรรทัด 12px ตัดด้วย ellipsis) ระยะห่าง 8px จำนวนคอลัมน์คำนวณจากความกว้างหน้าต่าง
- กรอบช่องปกติเป็นกรอบนูน `lt/dk` พื้น `--hero-panel-2` และพื้นในกรอบรูปเป็น `#f7f3ea` (ครีม เท่ากับพื้นหลังที่ pipeline ใช้ ทำให้รูปกลืนกับช่อง)
- สถานะของช่อง:
  - **เลือกอยู่:** ขอบ `--hero-gold-bright` + glow
  - **ของโปรด:** ขอบ `--hero-gold` + glow อ่อน + ดาวมุมขวาบน
  - **ต้องตรวจรูป** (`image.quality !== 'ok'`): ป้าย `!` สีส้มที่มุมซ้ายบน
  - **ไม่มีรูป:** กรอบรูปเส้นประ + ไอคอนกล่อง + จุดแดงที่มุม
  - **ช่องว่าง** (เติมให้เต็มแถวสุดท้าย): พื้น `--hero-panel-3` และเงาด้านใน
- รูป: `object-fit: contain` เสมอ และใช้ `loading="lazy"`
- **ต้อง virtualize** ด้วย IntersectionObserver หรือวาดเฉพาะแถวที่มองเห็น เพราะสินค้าอาจถึงหลักหมื่น

### 7.4 การทำงาน
| Input | ผล |
|---|---|
| คลิกซ้ายที่ช่อง | `clipboard.writeText(code)` + เลือกในการ์ด + แอนิเมชัน COPIED (กรอบเรืองเขียว 0.7 วินาที + ป้าย COPIED ลอยขึ้น 1.1 วินาที) + แถบแจ้ง "คัดลอกแล้ว 00101 · ไปวางใน Sea & Hill ได้เลย" 1.8 วินาที |
| คลิกขวา / ปุ่ม แก้ไข | เปิดหน้าแก้ไขสินค้า (ชื่อ, ชื่อสั้น, รหัส, หมวด, บาร์โค้ด, รูป) |
| พิมพ์ในช่องค้นหา | กรองทันที ค้นจากชื่อ ชื่อสั้น รหัส และบาร์โค้ด ไม่สนตัวพิมพ์เล็กใหญ่ ไม่สนช่องว่าง และไม่สนวรรณยุกต์ไทย (normalize NFC) |
| Enter ในช่องค้นหา | ถ้าเหลือผลเดียวให้คัดลอกเลย ถ้ามีหลายผลให้คัดลอกตัวที่เลือกอยู่ ถ้าพิมพ์รหัสหรือบาร์โค้ดตรงตัวให้คัดลอกตัวนั้น |
| ยิงบาร์โค้ด | ปืนสแกนพิมพ์ตัวเลขตามด้วย Enter จึงทำงานเหมือนกด Enter อยู่แล้ว |
| ลูกศร ←↑→↓ | เลื่อนตัวที่เลือกในตาราง แล้ว Enter = คัดลอก |
| โหมดเลือกหลายชิ้น | คลิก = เลือก/ยกเลิก (ไม่คัดลอก) ใช้ย้ายหมวด, ลบ, ปักดาวหลายชิ้นพร้อมกัน |
| Esc | ล้างช่องค้นหา ถ้าช่องว่างอยู่แล้วให้ซ่อนหน้าต่าง |

### 7.5 แท็บ
- `ทั้งหมด` + หมวดตามลำดับใน meta + `★ ของโปรด` + `ยังไม่มีรูป` + `ต้องตรวจรูป` แท็บสองตัวท้ายใช้ตัวหนังสือสีแดงอ่อน
- แต่ละแท็บแสดงจำนวนสินค้า

### 7.6 ธีม
- โหลด `theme-hero.css` ตัวเดิมแล้วใช้ตัวแปร `--hero-*` **ห้าม hardcode สี** ยกเว้นพื้นครีมในกรอบรูปกับสีของ toast
- ฟังการเปลี่ยนธีมจากหน้าต่างหลัก (ส่ง IPC `theme:changed`) แล้วตั้ง `data-theme` ให้ตรงกัน
- ใช้ไอคอน pixel SVG แทน emoji ภายในหน้าต่างกระเป๋า

### 7.7 Accessibility
- ทุกปุ่มเป็น `<button>` จริง ปุ่มที่มีแต่ไอคอนต้องมี `aria-label` ช่องใน slot ใช้ `aria-label="คัดลอกรหัส <ชื่อ>"`
- กดไปทีละปุ่มด้วยปุ่ม Tab ได้ครบ
- เคารพ `prefers-reduced-motion` แบบเดียวกับ hero-chrome.js (ปิดแอนิเมชัน COPIED และแสดงแค่ toast)

---

## 8. ระบบตัดแต่งรูป

> ต้นแบบใน Python/OpenCV อยู่ในภาคผนวก A ทดสอบกับรูปจริง 2 รูป (แชมพูเคลียร์จากเว็บ และสบู่ตราเจดีย์ที่ถ่ายมือถือ) และรูปจำลองอีก 6 แบบ ได้ผลดี 6 จาก 8 แบบ
> ส่วนที่ยังพลาด: **รูปที่ถ่ายในที่มืด** (ตัดขอบสินค้าแหว่ง) และ **รูปที่ถ่ายไกลมาก** (ความละเอียดไม่พอ)

### 8.1 เครื่องมือ
- ใช้ **OpenCV.js** (WASM) ใน Web Worker (`image-worker.js`) มี GrabCut, minAreaRect, morphology และ connectedComponents ครบ ทำงานออฟไลน์ได้
- อ่านรูปด้วย `createImageBitmap(file, { imageOrientation: 'from-image' })` ซึ่งหมุนตามข้อมูล EXIF ให้แล้ว
- เขียนไฟล์ผลลัพธ์ด้วย `OffscreenCanvas.convertToBlob({type:'image/jpeg', quality:0.86})`
- เขียน pipeline เป็นอาร์เรย์ของขั้นตอน (หัวข้อ 12.2) แต่ละขั้นเปิด/ปิดและตั้งค่าได้

### 8.2 ขั้นตอนอัตโนมัติ (ค่าเริ่มต้นตามต้นแบบ)
| # | ขั้น | รายละเอียด / ค่าตั้งต้น |
|---|---|---|
| 0 | เก็บต้นฉบับ | ย่อด้านยาวสุดให้เหลือ ≤ 2048px แล้วบันทึกเป็น variant `orig` ไว้เสมอ ใช้ประมวลผลใหม่ภายหลัง |
| 1 | ย่อเพื่อวิเคราะห์ | ด้านยาวสุด 640px |
| 2 | หาสีพื้น | median สีของขอบรูปหนา 4% (เบลอ σ=3 ก่อน) |
| 3 | เช็กว่าพื้นเรียบไหม | ถ้า P90 ของระยะสีที่ขอบ > 80 แปลว่าไม่มีพื้นเรียบ (เช่นถ่ายใกล้จนเห็นแต่ฉลาก หรือครอปมาชิดแล้ว) ให้ **ข้ามขั้น 4–7** ไปปรับแสงแล้วจัดลงช่องเลย |
| 4 | กรอบคร่าวๆ | พิกเซลที่ระยะสีจากพื้น > max(28, P97(ขอบ)×1.6) → morphology open 3×3 → เลือกก้อนที่ใหญ่ที่สุด → ขยายออก 6% |
| 5 | GrabCut | ใช้กรอบจากขั้น 4 รัน 5 รอบ → เลือกก้อนที่ใหญ่ที่สุด → close 9×9 |
| 6 | ตั้งตรง | ใช้ `minAreaRect` ของ mask ถ้าเอียง 2°–25° ให้หมุนกลับ (เติมขอบด้วย replicate) ถ้าเอียงเกินนี้ให้ปล่อยไว้ให้คนหมุนเอง |
| 7 | ตัดเงา | พิกเซลใน mask ที่ S < S_พื้น+18 และ V_พื้น×0.35 < V < V_พื้น−8 คือเงา ให้ตัดออก แล้ว open 5×5 + เลือกก้อนใหญ่สุด + close 15×15 **ใช้ผลนี้เฉพาะเมื่อเหลือพื้นที่ > 55% ของ mask เดิม** |
| 8 | สมดุลสีขาว | ใช้สีพื้น ปรับ gain แต่ละช่องสีแค่ 0.9–1.1 **ห้ามปรับแรงกว่านี้** (รอบแรกที่ลองแรงไป สบู่สีชมพูกลายเป็นแดงเข้ม) |
| 9 | ปรับแสง | ถ้า P97 ของความสว่างตัวสินค้า < 200 ให้คูณด้วย min(2.0, 225/P97) **ห้ามใช้ CLAHE** เพราะทำให้สีเพี้ยน |
| 10 | ลบพื้นหลัง | ผสมกับพื้นครีม `#f7f3ea` โดยเบลอขอบ mask σ=1.6 แล้วครอปชิดตัวสินค้า |
| 11 | เพิ่มความคม | unsharp: `1.35·img − 0.35·blur(σ=1.0)` |
| 12 | จัดลงช่อง | วางสินค้าให้กินพื้นที่ 86% กลางพื้นครีม ได้ `thumb` 512×512 และ `full` 1024×1024 |

### 8.3 ให้คะแนนผลอัตโนมัติ (`image.quality`)
- `retake`: ด้านยาวของตัวสินค้าในรูปต้นฉบับ < 220px (ถ่ายไกลหรือรูปเล็กเกิน) ให้แสดงข้อความ "รูปเล็กเกินไป ถ่ายใหม่ใกล้ขึ้น" และ**ห้ามขยายเกิน 2 เท่า**
- `check` เมื่อเข้าข้อใดข้อหนึ่ง:
  - mask กินพื้นที่ < 8% หรือ > 92% ของกรอบที่หาได้
  - mask ติดขอบรูปมากกว่า 2 ด้าน (อาจตัดสินค้าแหว่ง)
  - ความทึบของ mask (พื้นที่ mask ÷ พื้นที่ convex hull) < 0.75 แปลว่าแหว่ง แบบเคสรูปในที่มืด
  - รูปมืดมาก (P97 < 120 ก่อนปรับแสง)
  - ขั้นตั้งตรงเจอมุมเอียงเกิน 25°
- **ถ้าเป็น `check` เพราะ mask แหว่ง** ให้ถอยไปใช้แบบไม่ลบพื้นหลัง: ครอปตามกรอบจากขั้น 4 + ปรับแสง + จัดลงช่อง ซึ่งให้ผลดีกว่าการแสดงสินค้าที่แหว่ง
- นอกจากนั้นเป็น `ok`

### 8.4 ค่าการตัดแต่งที่บันทึกไว้ (`image.edit`)
```jsonc
{
  "pipelineVersion": 1,
  "bgRemove": true,            // สวิตช์ลบพื้นหลัง
  "autoStraighten": true,
  "rotate": 0,                 // องศาที่หมุนเอง (90/180/270 + ปรับละเอียด ±20)
  "brightness": 0,             // -50..+50
  "sharpen": 35,               // 0..100 (35 = ค่า 1.35/−0.35)
  "maskEdits": [               // เส้นแปรงแก้ขอบ (เก็บแบบเวกเตอร์ เทียบกับขนาดรูปที่ใช้วิเคราะห์)
    { "mode": "add" | "erase", "r": 12, "pts": [[x,y], ...] }
  ],
  "thumbCrop": { "x": 0, "y": 77, "z": 2.7 },   // กรอบรูปในช่องตาราง (ซูมเน้นฉลากได้)
  "fullCrop":  { "x": 0, "y": -5, "z": 1.3 }    // กรอบรูปใหญ่ในการ์ด
}
```
- ทุกค่าใช้กับ `orig` แล้วได้ผลเหมือนเดิมทุกครั้ง (deterministic) เพราะฉะนั้นเปลี่ยนวิธีประมวลผลทีหลังแล้วสั่งทำใหม่ได้

### 8.5 หน้า "ปรับรูป" (ตามบอร์ด Crop และเพิ่มเครื่องมือ)
- พื้นที่แก้รูป 500×500 มีกรอบสี่เหลี่ยมพร้อมเส้นแบ่ง 3×3 และทำให้ส่วนนอกกรอบมืดลง
  - ลากรูปเพื่อเลื่อน
  - หมุนลูกกลิ้งเมาส์หรือเลื่อนแถบเพื่อซูม 50–400%
- **สลับกรอบได้ 2 แบบ:** "รูปในช่องตาราง" กับ "รูปใหญ่ในการ์ด" แต่ละแบบมีตัวอย่างเล็กข้างๆ ที่อัปเดตทันที
- ปุ่ม: หมุน ↺90° / ↻90°, แถบหมุนละเอียด ±20°, "พอดีทั้งชิ้น", "เน้นฉลาก" (ซูม 2.4 เท่าที่กลางสินค้าแล้วให้ลากปรับต่อ), "รีเซ็ต"
- **เครื่องมือใหม่:**
  - สวิตช์ **ลบพื้นหลัง** และ **ตั้งตรงอัตโนมัติ**
  - **แปรงแก้ขอบ** โหมดเติม/ลบ ปรับขนาดหัวแปรงได้ ใช้แก้ mask แล้วรัน GrabCut ใหม่โดยใช้เส้นแปรงเป็นตัวบอกว่าตรงไหนเป็นสินค้าหรือพื้น (`GC_FGD`/`GC_BGD`)
  - แถบเลื่อน **ความสว่าง** และ **ความคม**
  - **กดค้างเพื่อดูรูปก่อนแก้** (ปุ่มหรือกด Space ค้าง)
  - ช่อง **ชื่อสั้นใต้ช่อง** สำหรับแยกตัวที่คล้ายกัน (รุ่น/กลิ่น/ขนาด)
- ปุ่มบันทึก → สร้าง thumb และ full ใหม่ → `ver+1` → เข้าคิว outbox
- **ทำทุกอย่างในหน้านี้ให้สด (live preview)** โดยรันบนรูปขนาดวิเคราะห์ (640px) แล้วค่อยสร้างไฟล์ขนาดจริงตอนกดบันทึก

### 8.6 จัดรูปเป็นชุด
- ปุ่ม "จัดรูปทั้งหมด" ใน skill bar หรือหน้าตั้งค่า รันทีละรูปใน Worker มีแถบความคืบหน้าและปุ่มหยุด
- **สำรอง `db.json` ก่อนเริ่มเสมอ** ย้อนกลับได้
- จบแล้วสรุปผล: ok N / check N / retake N และมีปุ่มไปที่แท็บ "ต้องตรวจรูป"

### 8.7 การ์ด "วิธีถ่ายรูปให้ได้ผลดี"
แสดงในหน้าเพิ่มหรือแก้สินค้า:
- พื้นเรียบสีเดียว เช่นกระดาษแข็งสีขาวหรือเทาอ่อน
- แสงสว่าง ไม่ใช้แฟลช
- ถ่ายตรงจากด้านหน้าหรือด้านบน
- ให้สินค้าเต็มประมาณ 70% ของภาพ
- อย่าให้สินค้าวางเอียงมาก

---

## 9. ย้ายข้อมูลจาก Catalog Hero เดิม

- ปุ่ม "นำเข้าจาก Catalog Hero" ให้เลือกไฟล์ `catalog-data.json` หรือค้นหาเองใน `%APPDATA%\Catalog Hero\` และโฟลเดอร์แชร์ที่ตั้งไว้ใน `sync-config.json`
- ขั้นตอน:
  1. อ่านไฟล์แล้ว `normalize` แบบเดียวกับ `sync.js` เดิม
  2. แต่ละ item:
     - สร้าง `id` ใหม่เป็น ULID และเก็บ id เดิมไว้ที่ `legacyId`
     - `fav` ดูจาก `favoriteIds.includes(String(id))`
     - `img` (dataURL) → แปลงเป็นไฟล์ → `orig` → ผ่าน pipeline → thumb และ full
  3. categories → meta
  4. `auth` เดิม → ย้ายไปเป็นระบบล็อกการแก้ไขในเครื่อง (ไม่ส่งขึ้น Cloudflare)
  5. push ทีละ 200 ชิ้น พร้อมแถบความคืบหน้า
- **ไม่ลบหรือแก้ไฟล์เดิม**
- นำเข้าซ้ำได้โดยไม่ซ้ำซ้อน: ถ้าเจอ `legacyId` เดิมให้อัปเดตแทนการเพิ่มใหม่

---

## 10. เฟสงานและเกณฑ์ว่าเสร็จ

> ทำแต่ละเฟสใน branch แยก แล้วเปิด PR ให้ Boss ทดสอบก่อนรวม **ห้าม push ไป main ตรงๆ**
> ทุกเฟสต้องผ่าน `npm test` และระบบรับเงินโอนเดิมต้องทำงานเหมือนเดิม (เปิดโหมดทดสอบแล้วส่งแจ้งเตือน TEST ต้องเข้า)

| เฟส | งาน | เสร็จเมื่อ |
|---|---|---|
| **1. Worker** | `src/catalog.js`, `wrangler.toml` (DO + R2), `shared/merge.js` + unit test, `test/catalog-smoke.js`, อัปเดต `docs/cloudflare-setup.md` (เพิ่มขั้นเปิด R2 และขั้นตั้ง Catalog Key) | `npm test` ผ่านทั้งชุดเดิมและชุดใหม่บน Worker ที่ deploy แล้ว และ inbox เดิมยังทำงาน |
| **2. หน้าต่างกระเป๋า (ข้อมูลในเครื่อง)** | `catalog-window.js`, preload แยก, UI ตามหัวข้อ 7 (ใช้ข้อมูลใน `db.json` อย่างเดียว ยังไม่ซิงก์), F2, ปุ่มในแถบหัว | เปิด/ปิดด้วย F2 ได้ คลิกแล้วคัดลอกรหัสได้ ค้นหาได้ Enter คัดลอกได้ เปลี่ยนธีมตามหน้าต่างหลักได้ สินค้า 10,000 ชิ้นยังเลื่อนลื่น (virtualized) |
| **3. ระบบรูป** | `image-worker.js` (OpenCV.js), pipeline ตามหัวข้อ 8.2–8.3, หน้าปรับรูป 8.5, เก็บรูปในเครื่อง | รูป fixture 8 แบบ (หัวข้อ 13) ได้ quality ตามตารางคาดหวัง และแก้ด้วยแปรงแล้วรูปในที่มืดกลับมาครบ |
| **4. ซิงก์** | `catalog-sync.js`, outbox, pull/push, รูปขึ้น R2, ไฟสถานะ, แถบเตือน | 2 เครื่องเห็นการแก้ของกันภายใน ≤ 10 วินาที ถอดเน็ตแล้วแก้ แล้วเสียบเน็ตกลับ ไม่มีอะไรหาย และไม่มีอะไรทับกัน |
| **5. ย้ายข้อมูล + จัดรูปทั้งหมด** | `catalog-migrate.js`, ปุ่มจัดรูปทั้งหมด | นำเข้าไฟล์จริงของ Boss ได้ครบ จำนวนสินค้าตรงกับไฟล์เดิม และนำเข้าซ้ำแล้วไม่ซ้ำ |
| **6. เก็บงาน** | ปุ่มบน mini widget, การ์ดวิธีถ่ายรูป, สำรองอัตโนมัติ, คู่มือภาษาไทย `docs/catalog.md` | Boss ใช้งานจริงที่เคาน์เตอร์ 1–2 วันโดยไม่มีปัญหา |

---

## 11. ค่าที่ปรับแต่งได้ (config)

เก็บใน `userData/catalog/config.json` อ่านตอนเริ่มโปรแกรม และมีหน้า UI สำหรับค่าที่ใช้บ่อย
ค่าที่ไม่มีในไฟล์ให้ใช้ค่าเริ่มต้นจาก `catalog/defaults.js` **ห้าม hardcode ค่าเหล่านี้กระจายในโค้ด**

```jsonc
{
  "worker":   { "url": "", "key": "", "writeToken": "", "pollMsVisible": 5000, "pollMsHidden": 60000 },
  "window":   { "hotkey": "F2", "width": 920, "height": 752, "dockSide": "left", "alwaysOnTop": true },
  "grid":     { "slotW": 100, "slotH": 126, "tile": 88, "gap": 8, "showNames": true, "nameLines": 1 },
  "copy":     { "toastMs": 1800, "flash": true, "enterCopiesSingleResult": true, "playSound": false },
  "tabs":     { "showNoImage": true, "showNeedsCheck": true, "showFavorites": true },
  "image": {
    "tileBg": "#f7f3ea", "fill": 0.86, "thumbSize": 512, "fullSize": 1024, "origMax": 2048, "jpegQuality": 0.86,
    "analyzeMax": 640,
    "bgRemove": true, "autoStraighten": true, "maxAutoTiltDeg": 25, "minAutoTiltDeg": 2,
    "edgeBusyThreshold": 80, "fgThresholdMin": 28, "fgThresholdEdgeMul": 1.6,
    "grabcutIters": 5, "shadowKeepRatio": 0.55,
    "wbGainClamp": [0.9, 1.1], "exposureTargetP97": 225, "exposureMaxGain": 2.0,
    "sharpenAmount": 0.35, "sharpenSigma": 1.0, "edgeFeatherSigma": 1.6,
    "retakeMinProductPx": 220, "maxUpscale": 2.0
  },
  "backup":   { "daily": true, "keep": 14 }
}
```

---

## 12. จุดต่อขยายและไอเดียทำเพิ่ม

### 12.1 โครงที่ต้องเตรียมไว้ตั้งแต่ตอนนี้
- **ฟิลด์ใหม่ใน Item:** `schemaVersion` + `catalog/migrations/NNN-*.js` (รับ item เก่า คืน item ใหม่) Worker เก็บ `data` เป็น JSON ทั้งก้อน จึงเพิ่มฟิลด์ได้โดยไม่ต้องแก้ schema ของ SQL
- **image pipeline เป็นอาร์เรย์ของขั้นตอน:**
  ```js
  // catalog/pipeline/index.js
  export const steps = [orient, analyzeResize, findBackground, roughBox, grabcut, straighten, removeShadow, whiteBalance, exposure, composite, sharpen, fitTile];
  // แต่ละ step: { id, enabled(cfg, edit), run(ctx) → ctx }
  ```
  เพิ่ม ลบ หรือสลับลำดับได้ เช่นเปลี่ยน `grabcut` เป็นโมเดล AI ลบพื้นหลังในเครื่อง (ONNX) โดยไม่กระทบขั้นอื่น
- **แท็บและตัวกรองเป็นรายการ:** `catalog/filters.js` คืน `[{id,label,match(item),alert?}]` เพิ่มแท็บใหม่ได้ในจุดเดียว
- **การกระทำเมื่อคลิกช่อง:** `onSlotActivate` ตั้งค่าได้ คือ `copyCode` (ค่าเริ่มต้น) / `select` / `copyBarcode` / ฟังก์ชันที่เพิ่มเองในอนาคต
- **ธีม:** เพิ่มธีมใหม่ใน `theme-hero.css` แล้วกระเป๋าจะใช้ได้เองเพราะอ่านตัวแปร `--hero-*`

### 12.2 ไอเดียทำเพิ่ม (ยังไม่ต้องทำ เรียงจากคุ้มสุด)
1. **ราคาสินค้า → หน้า 60:40:** เพิ่ม `price` ใน Item แล้วในหน้า 60:40 ให้มีปุ่ม "เลือกจากกระเป๋า" ที่เติมราคาลง `c60Price` / `c60WantPrice` ให้
2. **ดึงข้อมูลจาก STOCK MASTER (Firebase) หรือไฟล์ CSV ที่ export จาก Sea & Hill:** เติมชื่อและบาร์โค้ดให้อัตโนมัติ เหลือแค่ถ่ายรูป
3. **ถ่ายรูปจากมือถือ:** หน้าเว็บเล็กๆ บน Worker (ใช้ key และ writeToken) ให้มือถือสแกนบาร์โค้ดแล้วถ่ายรูปส่งขึ้นได้เลย คอมจะเห็นภายในไม่กี่วินาที
4. **SSE แทน poll:** ลด request และเห็นการเปลี่ยนแปลงทันที
5. **โมเดล AI ลบพื้นหลังในเครื่อง:** ได้ขอบคมกว่า GrabCut แลกกับขนาดโปรแกรมที่ใหญ่ขึ้น
6. **เสียงตอนคัดลอก** (8-bit "ติ๊ง") เปิด/ปิดได้ใน `copy.playSound`
7. **นับว่าคัดลอกรหัสไหนบ่อย:** ใช้เรียงลำดับ หรือทำแท็บ "ใช้บ่อย"
8. **พิมพ์ป้ายราคา:** ส่งต่อไปที่ TAG-SYS

---

## 13. การทดสอบ

- **unit test** (`node test/...` แบบเดียวกับ catalog-hero เดิม)
  - `merge.test.js`: ชนกัน, เวลาเท่ากัน, tombstone, นาฬิกาเพี้ยน
  - `outbox.test.js`: ลำดับรูปกับ item, backoff
  - `migrate.test.js`: ใช้ไฟล์ตัวอย่างขนาดเล็กที่มี dataURL
- **Worker:** `test/catalog-smoke.js` (หัวข้อ 5.6)
- **ชุดรูป** `test/fixtures/photos/`: ขอรูปจริงจาก Boss แล้วตั้งชื่อตามเคส ผลที่คาดหวังเป็นดังนี้

  | ไฟล์ | เคส | quality ที่คาด |
  |---|---|---|
  | `web-white.jpg` | รูปจากเว็บ พื้นขาว สินค้าเล็ก | ok |
  | `phone-tilted.jpg` | ถ่ายมือถือ บนโต๊ะ วางเอียง | ok (ต้องตั้งตรง) |
  | `counter-landscape.jpg` | บนเคาน์เตอร์ลายไม้ แนวนอน | ok |
  | `dark.jpg` | ที่มืด | check (หรือ ok ถ้าทำ mask ได้ครบ) |
  | `sideways.jpg` | ตะแคง 90° และไม่มีข้อมูล EXIF | check |
  | `closeup-label.jpg` | ใกล้ เห็นแต่ฉลาก | ok (ต้องไม่ครอปเพิ่ม) |
  | `tall-tight.jpg` | ครอปชิดมาแล้ว ผอมสูง | ok |
  | `far-small.jpg` | ถ่ายไกล สินค้าเล็ก | retake หรือ check |

  ทดสอบแบบ snapshot: บันทึก thumb ที่ได้ไว้ใน `test/fixtures/expected/` แล้วเทียบด้วยความต่างของพิกเซลที่ยอมรับได้
- **ทดสอบด้วยมือ:** ตาม "เสร็จเมื่อ" ของแต่ละเฟส + เช็กว่าระบบรับเงินโอนกับการพิมพ์สลิปยังทำงานปกติ

---

## 14. ข้อห้ามและข้อควรระวัง

- **ห้ามแตะ logic ส่วนรับเงิน** (inbox, LAN relay, UDP, Pushbullet fallback, ระบบพิมพ์) นอกจากจุดเชื่อมที่ระบุไว้ ถ้าจำเป็นต้องแก้ ให้แยก PR และอธิบายเหตุผล
- **ห้ามเปลี่ยน `MINI_WIDTH` / `MINI_HEIGHT`** โดยไม่แก้ `--mini-w` / `--mini-h` ให้ตรงกัน และไม่ทดสอบแอนิเมชันย่อ/ขยาย
- ห้ามเก็บ writeToken ไว้ใน renderer หรือ localStorage ให้อยู่ที่ main process เท่านั้น
- ห้ามฝังรูปเป็น dataURL ใน JSON อีก
- ห้ามแสดงรูปดิบด้วย `object-fit: cover`
- ห้ามปรับสีหรือ contrast แรงๆ เพราะสีสินค้าใช้จำว่าเป็นตัวไหน (บทเรียนจาก CLAHE)
- ข้อความในแอปเป็นภาษาไทยทั้งหมด และ error ต้องบอกว่าผู้ใช้ควรทำอะไรต่อ
- Electron security: `contextIsolation: true`, `nodeIntegration: false` และ CSP ที่ยอมให้โหลดได้แค่ `self`, `data:`, `blob:` และ URL ของ Worker

---

## ภาคผนวก A: โค้ดต้นแบบ image pipeline (Python + OpenCV)

ใช้เป็นตัวอ้างอิงตอนเขียนเวอร์ชัน OpenCV.js ค่าตัวเลขทั้งหมดตรงกับหัวข้อ 8.2 และ 11

```python
import numpy as np, cv2
from PIL import Image

def clean(pil, size=512, fill=0.86, bg=(247,243,234)):
    img = cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)          # pil: หมุนตาม EXIF แล้ว
    h0, w0 = img.shape[:2]; s = 640/max(h0, w0)
    if s < 1: img = cv2.resize(img, (int(w0*s), int(h0*s)), interpolation=cv2.INTER_AREA)
    h, w = img.shape[:2]

    # 1) สีพื้นจากขอบรูป + เช็กว่าพื้นเรียบไหม
    blur = cv2.GaussianBlur(img, (0,0), 3).astype(float); e = max(3, int(min(h,w)*0.04))
    edge = np.concatenate([blur[:e].reshape(-1,3), blur[-e:].reshape(-1,3), blur[:,:e].reshape(-1,3), blur[:,-e:].reshape(-1,3)])
    ref = np.median(edge, 0); ed = np.sqrt(((edge-ref)**2).sum(1)); dist = np.sqrt(((blur-ref)**2).sum(2))
    busy = np.percentile(ed, 90) > 80
    if busy:
        out = img; mask = None
    else:
        # 2) กรอบคร่าวๆ
        thr = max(28, np.percentile(ed, 97)*1.6); m = (dist > thr).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3,3), np.uint8))
        n, lab, st, _ = cv2.connectedComponentsWithStats(m)
        if n <= 1:
            out = img; mask = None
        else:
            big = 1+np.argmax(st[1:, cv2.CC_STAT_AREA]); x, y, bw, bh = st[big, :4]; pad = int(0.06*max(bw, bh))
            rect = (max(1,x-pad), max(1,y-pad), min(w-2, bw+2*pad), min(h-2, bh+2*pad))
            # 3) GrabCut
            gm = np.zeros((h,w), np.uint8); bgd = np.zeros((1,65)); fgd = np.zeros((1,65))
            cv2.grabCut(img, gm, rect, bgd, fgd, 5, cv2.GC_INIT_WITH_RECT)
            mask = np.where((gm==1)|(gm==3), 255, 0).astype(np.uint8)
            n, lab, st, _ = cv2.connectedComponentsWithStats(mask)
            if n > 1: big = 1+np.argmax(st[1:, cv2.CC_STAT_AREA]); mask = np.where(lab==big, 255, 0).astype(np.uint8)
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9,9), np.uint8))
            # 4) ตั้งตรง (2°–25°)
            cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            (cx, cy), (rw, rh), ang = cv2.minAreaRect(max(cnts, key=cv2.contourArea))
            if rw < rh: ang = ang-90
            ang = ang+180 if ang < -45 else ang; ang = ang-90 if ang > 45 else ang
            if 2 < abs(ang) < 25:
                M = cv2.getRotationMatrix2D((cx,cy), ang, 1)
                img = cv2.warpAffine(img, M, (w,h), borderMode=cv2.BORDER_REPLICATE); mask = cv2.warpAffine(mask, M, (w,h))
            # 5) ตัดเงา
            hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(float); bgsel = mask==0
            bS = np.median(hsv[...,1][bgsel]); bV = np.median(hsv[...,2][bgsel])
            shadow = (mask>0)&(hsv[...,1]<bS+18)&(hsv[...,2]<bV-8)&(hsv[...,2]>bV*0.35)
            m2 = mask.copy(); m2[shadow] = 0; m2 = cv2.morphologyEx(m2, cv2.MORPH_OPEN, np.ones((5,5), np.uint8))
            n2, l2, st2, _ = cv2.connectedComponentsWithStats(m2)
            if n2 > 1:
                b2 = 1+np.argmax(st2[1:, cv2.CC_STAT_AREA]); m2 = np.where(l2==b2, 255, 0).astype(np.uint8)
                m2 = cv2.morphologyEx(m2, cv2.MORPH_CLOSE, np.ones((15,15), np.uint8))
                if m2.sum() > 0.55*mask.sum(): mask = m2
            # 6) สมดุลสีขาวแบบอ่อน + ปรับแสงเฉพาะตัวสินค้า
            bgpix = img[mask==0].reshape(-1,3).astype(float)
            if len(bgpix) > 500:
                g = np.median(bgpix, 0); gain = np.clip(g.mean()/np.maximum(g,1), 0.9, 1.1); img = np.clip(img*gain, 0, 255).astype(np.uint8)
            Lp = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)[mask>0]; p = np.percentile(Lp, 97)
            if p < 200: img = np.clip(img.astype(float)*min(2.0, 225/max(p,1)), 0, 255).astype(np.uint8)
            # 7) วางบนพื้นครีม + ครอปชิด
            soft = cv2.GaussianBlur(mask, (0,0), 1.6).astype(float)[...,None]/255
            canvas = np.full_like(img, bg[::-1]); out = (img*soft + canvas*(1-soft)).astype(np.uint8)
            ys, xs = np.where(mask>0); out = out[ys.min():ys.max()+1, xs.min():xs.max()+1]
    if mask is None:   # พื้นไม่เรียบ: ปรับแสงทั้งรูป
        g = cv2.cvtColor(out, cv2.COLOR_BGR2GRAY); p = np.percentile(g, 97)
        if p < 200: out = np.clip(out.astype(float)*min(2.0, 225/max(p,1)), 0, 255).astype(np.uint8)
    # 8) เพิ่มความคม
    out = cv2.addWeighted(out, 1.35, cv2.GaussianBlur(out, (0,0), 1.0), -0.35, 0)
    # 9) จัดลงช่องสี่เหลี่ยมจัตุรัส
    oh, ow = out.shape[:2]; k = size*fill/max(oh, ow)
    out = cv2.resize(out, (max(1,int(ow*k)), max(1,int(oh*k))), interpolation=cv2.INTER_AREA)
    tile = np.full((size,size,3), bg[::-1], np.uint8); y = (size-out.shape[0])//2; x = (size-out.shape[1])//2
    tile[y:y+out.shape[0], x:x+out.shape[1]] = out
    return Image.fromarray(cv2.cvtColor(tile, cv2.COLOR_BGR2RGB))
```

**สิ่งที่ต้นแบบยังไม่ได้ทำ แต่ต้องมีในของจริง:** ให้คะแนน quality (8.3), ถอยไปใช้แบบไม่ลบพื้นหลังเมื่อ mask แหว่ง, แปรงแก้ขอบ (`GC_INIT_WITH_MASK`), ใช้ `thumbCrop`/`fullCrop`, ไม่ขยายเกิน 2 เท่า

---

## ภาคผนวก B: ค่าสีของธีม (จาก `renderer/theme-hero.css`)

| ตัวแปร | ทอง-อำพัน (ค่าเริ่มต้น) | emerald | navy | ember |
|---|---|---|---|---|
| `--hero-bg-1` | #120d09 | #071410 | #060b18 | #170805 |
| `--hero-bg-2` | #1c140c | #0e211a | #0c1830 | #24100a |
| `--hero-panel` | #241a10 | #10241c | #101f3d | #2a130c |
| `--hero-panel-2` | #1a130b | #0b1a14 | #0a1628 | #1c0d08 |
| `--hero-panel-3` | #140e08 | #08140f | #081120 | #150a06 |
| `--hero-border-lt` | #ffe27a | #7ce3b8 | #8ec5ff | #ffb37a |
| `--hero-border-dk` | #6b4a12 | #1f5c46 | #1e3a6b | #7c2d12 |
| `--hero-gold` | #f6c453 | #34d399 | #60a5fa | #fb923c |
| `--hero-gold-bright` | #ffe27a | #6ee7b7 | #93c5fd | #fdba74 |
| `--hero-text` | #f1e9d2 | #eafff4 | #eaf2ff | #fff1e8 |
| `--hero-active-1/2` | #b45309 / #f59e0b | #0f766e / #14b8a6 | #1d4ed8 / #3b82f6 | #b91c1c / #ef4444 |

แถบหัวใช้ `linear-gradient(180deg, #241a44, #150e28)` เหมือนกันทุกธีม แถบปุ่มล่างใช้ `#150e28` และสี toast "คัดลอกแล้ว" ใช้พื้น `#14532d` ขอบ `#4ade80`
