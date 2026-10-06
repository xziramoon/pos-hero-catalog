# ย้ายช่องทาง ☁️ จาก Firebase ไป Cloudflare

โค้ดฝั่ง Cloudflare อยู่ในโฟลเดอร์ [`cloudflare-inbox/`](../cloudflare-inbox) เป็น Worker เล็กๆ ที่รับคำสั่งแบบเดียวกับ Firebase ที่ POS Hero ใช้
จึง**ไม่ต้องอัปเดตแอป** แค่เปลี่ยน URL ในแอปและใน MacroDroid

- ฟรีในปริมาณของร้านเดียว (แผนฟรี 100,000 request ต่อวัน ส่วน heartbeat ใช้วันละประมาณ 290 ครั้ง)
- แต่ละ Inbox Key มีที่เก็บข้อมูลแยกกัน key ต้องยาวอย่างน้อย 32 ตัวเหมือนเดิม
- ลบแจ้งเตือนที่เก่ากว่า 3 วันเอง และรับได้สูงสุด 5,000 รายการต่อ key
- ไม่ต้องยุ่งกับกฎของ STOCK MASTER ใน Firebase อีก

---

## ขั้นที่ 1 — สมัครและ deploy (ทำครั้งเดียว บนคอมที่มีโค้ด)

1. สมัคร Cloudflare ฟรีที่ https://dash.cloudflare.com/sign-up
2. เปิด Terminal ที่โฟลเดอร์ `D:\Claude\pos-hero\cloudflare-inbox` แล้วรัน:
   ```
   npm install
   npx wrangler login
   npx wrangler deploy
   ```
   - `wrangler login` จะเปิดเบราว์เซอร์ให้กดอนุญาต
   - ครั้งแรกอาจถามให้ตั้งชื่อ subdomain ของ `workers.dev` ตั้งเป็นชื่อร้านได้
3. ท้ายผลลัพธ์จะมี URL แบบ `https://pos-hero-inbox.<ชื่อของคุณ>.workers.dev` จดเก็บไว้
4. ตรวจว่าทำงาน:
   ```
   set BASE=https://pos-hero-inbox.<ชื่อของคุณ>.workers.dev
   npm test
   ```
   ต้องขึ้น `all passed` (ชุดทดสอบใช้ key สุ่มของตัวเอง ไม่ปนกับข้อมูลร้าน)

### เพิ่มเติมสำหรับ Catalog Hero (กระเป๋าสินค้า) — เปิด R2 ก่อน deploy

Worker ตัวเดียวกันนี้รับซิงก์กระเป๋าสินค้าด้วย (path `/catalog/{key}/...`) โดยเก็บรูปไว้ใน Cloudflare R2 จึงต้องเปิด R2 และสร้าง bucket **ก่อน** รัน `npx wrangler deploy` ครั้งแรกหลังอัปเดต ไม่เช่นนั้น deploy จะล้มเหลวเพราะหา bucket ไม่เจอ

1. เปิด R2: Cloudflare dashboard → **R2 Object Storage** → กด Purchase / Enable R2
   (แผนฟรีมี 10GB และไม่คิดค่า egress แต่ Cloudflare **อาจขอให้ผูกบัตร** ตอนเปิดครั้งแรก)
2. สร้าง bucket ชื่อ `pos-hero-catalog` (ตัวพิมพ์เล็กตามนี้เป๊ะ) ด้วยคำสั่ง:
   ```
   npx wrangler r2 bucket create pos-hero-catalog
   ```
   หรือสร้างในหน้า dashboard ก็ได้ ไม่ต้องเปิด public access
3. deploy ตามปกติ `npx wrangler deploy` (การ deploy ครั้งนี้จะเพิ่ม Durable Object `Catalog` ผ่าน migration v2 ส่วนข้อมูล inbox เดิมไม่หาย)
4. ทดสอบทั้งชุดเดิมและชุดใหม่ `npm test` ต้องขึ้น `all passed` สองครั้ง (smoke.js และ catalog-smoke.js)

> ถ้าไม่อยากเปิด R2: **ยังไม่มีโหมดสำรอง** (เก็บรูปเป็น BLOB ใน Durable Object แทน R2) ตอนนี้โค้ดต้องใช้ R2 เท่านั้น ถ้า bucket ไม่มี การอัปโหลดรูปจะล้มเหลว (ข้อมูลสินค้าที่ไม่ใช่รูปยังซิงก์ได้) โหมดสำรองจะทำในภายหลังถ้าจำเป็น

#### ตั้ง Catalog Key และ write token

- **Catalog Key**: ข้อความสุ่มยาว 32–128 ตัว (`A-Z a-z 0-9 _ -`) ใช้เป็น path `/catalog/{key}/...` ใครมี key อ่านแคตตาล็อกได้ (เหมาะกับเครื่องพนักงาน) แอปสุ่มให้ 40 ตัว หรือสร้างเองก็ได้
- **write token**: รหัสยาว 16–256 ตัวสำหรับ **เขียน** (เพิ่ม/แก้/ลบสินค้า อัปโหลดรูป) ส่งใน header `X-Catalog-Write` Worker เก็บเป็นแฮช sha256 เท่านั้น ตั้งได้ครั้งเดียวต่อ key (ตั้งซ้ำจะได้ 409)
- ตั้งครั้งแรก (ทำครั้งเดียวต่อ key แอปจะมีปุ่มทำให้ในภายหลัง):
  ```
  curl -X POST https://pos-hero-inbox.<ชื่อของคุณ>.workers.dev/catalog/<CatalogKey>/init -H "X-Catalog-Write: <writeToken>"
  ```
- เครื่องที่มีแค่ Catalog Key (ไม่มี write token) อ่านได้อย่างเดียว เครื่องที่แก้ได้ต้องใส่ทั้งสองค่า **เก็บ write token ไว้ให้ดี** ถ้าลืมจะตั้งใหม่บน key เดิมไม่ได้ ต้องใช้ Catalog Key ใหม่แล้วนำเข้าข้อมูลจากไฟล์สำรอง (`GET /catalog/<key>/export`)
- ตรวจ: เปิด `https://pos-hero-inbox.<ชื่อ>.workers.dev/catalog/<CatalogKey>/health` ต้องได้ `{"ok":true,...}`

## ขั้นที่ 2 — เปลี่ยนในแอป POS Hero

⚙️ ตั้งค่า (ปุ่มที่แผงด้านล่าง) → กล่อง 📥 → ช่อง **Database URL** ใส่ URL จากขั้นที่ 1 (ไม่มี `/` ท้าย)
Inbox Key ใช้ตัวเดิมได้ แอปจะต่อใหม่เอง ไฟ ☁️ ในกล่องต้องขึ้นว่าต่ออยู่

## ขั้นที่ 3 — เปลี่ยนใน MacroDroid (2 จุด)

แก้เฉพาะส่วนต้นของ URL จาก Firebase เป็น URL ของ Worker ส่วนท้ายเหมือนเดิมทุกตัวอักษร

| Macro | เดิม | ใหม่ |
|---|---|---|
| ส่งเงินเข้า POS (HTTP POST) | `https://xxxx.firebasedatabase.app/pos_hero_inbox/<key>/events.json` | `https://pos-hero-inbox.<ชื่อ>.workers.dev/pos_hero_inbox/<key>/events.json` |
| POS heartbeat (HTTP PUT) | `https://xxxx.firebasedatabase.app/pos_hero_inbox/<key>/heartbeat.json` | `https://pos-hero-inbox.<ชื่อ>.workers.dev/pos_hero_inbox/<key>/heartbeat.json` |

Body JSON และ UDP ไม่ต้องแก้

## ขั้นที่ 4 — ทดสอบแล้วค่อยเลิกใช้ Firebase

1. กด 🧪 โหมดทดสอบ แล้วส่งแจ้งเตือนที่ title ขึ้นต้น `TEST` หรือโอนเข้า 1 บาท ผลต้องขึ้นใต้ปุ่ม
2. ใช้ไปสัก 1–2 วัน ถ้าไฟเขียวและรายการเข้าครบ ค่อยลบก้อน `pos_hero_inbox` ออกจากกฎ Firebase (ไม่ลบก็ไม่เป็นไร)

## ดูข้อมูล / แก้ปัญหา

- ดู log สดของ Worker: `npx wrangler tail`
- หน้า Cloudflare dashboard → Workers & Pages → pos-hero-inbox → Metrics ดูจำนวน request และ error
- แก้โค้ดแล้ว deploy ซ้ำด้วย `npx wrangler deploy` ข้อมูลเดิมไม่หาย
