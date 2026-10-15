
## Catalog Hero (กระเป๋าสินค้า) — งานที่กำลังทำ

- สเปกหลัก: `docs/CATALOG_HERO_SPEC.md` ต้องอ่านทั้งไฟล์ก่อนแตะโค้ดส่วนแคตตาล็อก
- คำสั่งแต่ละเฟส: `docs/CLAUDE_CODE_PROMPTS.md` ทำทีละเฟส แต่ละเฟสใช้ branch แยกและเปิด PR ห้าม push ลง main
- ดีไซน์อ้างอิง: `docs/catalog-design/` / ต้นแบบระบบรูป: `docs/catalog-prototype/` / รูปทดสอบ: `test/fixtures/photos/`
- โค้ดแคตตาล็อกอยู่ใน `catalog/`, `renderer/catalog/` และ `cloudflare-inbox/src/catalog.js` เท่านั้น
- **ห้ามแตะ logic ส่วนรับเงิน** (inbox, LAN relay, UDP, Pushbullet fallback, พิมพ์สลิป) และ `test/smoke.js` เดิมต้องผ่านเสมอ
- **ห้ามเปลี่ยน `MINI_WIDTH` / `MINI_HEIGHT`** ใน main.js โดยไม่แก้ `--mini-w` / `--mini-h` ใน theme-hero.css ให้ตรงกัน
- repo นี้เป็น public: ห้าม commit URL ของ Google Sheet, Apps Script, ImgBB key, Catalog Key หรือ write token
- ผู้ใช้ (Boss) สื่อสารเป็นภาษาไทย ให้สรุปงานและข้อความใน UI เป็นภาษาไทยทั้งหมด
