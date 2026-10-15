# ต้นแบบระบบตัดแต่งรูป (Python)

ไฟล์ในโฟลเดอร์นี้ใช้เป็น**ตัวอ้างอิง**ตอนเขียนเวอร์ชัน OpenCV.js เท่านั้น ไม่ได้เป็นส่วนของแอป

| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `clean_pipeline.py` | pipeline เต็ม: หาพื้น → GrabCut → ตั้งตรง → ตัดเงา → สมดุลสีขาว/ปรับแสง → วางบนพื้นครีม → เพิ่มความคม → จัดลงช่อง 512 ค่าตรงกับสเปกหัวข้อ 8.2 |
| `auto_crop_simple.py` | แบบเบา: หาตัวสินค้าแล้วครอปพร้อมปรับแสง ไม่ลบพื้นหลัง ใช้เป็นทางสำรองเมื่อ mask แหว่ง (สเปก 8.3) |

ลองรันได้แบบนี้:
```bash
pip install opencv-python-headless pillow numpy
python -c "from PIL import Image, ImageOps; from clean_pipeline import clean; clean(ImageOps.exif_transpose(Image.open('../test/fixtures/photos/phone-tilted.jpg')).convert('RGB')).save('out.jpg')"
```

ผลจากต้นแบบอยู่ใน `../test/fixtures/expected-prototype/` และภาพเปรียบเทียบอยู่ใน `../design/previews/pipeline-compare-3rows.jpg` (แถวบน = รูปดิบ, แถวกลาง = ตัดขอบอย่างเดียว, แถวล่าง = pipeline เต็ม)

**ข้อจำกัดที่พบตอนทดสอบ:**
- `dark.jpg`: GrabCut ตัดขอบสินค้าแหว่ง ต้องให้ระบบให้คะแนนจับได้ แล้วถอยไปใช้ `auto_crop_simple`
- `far-small.jpg`: ความละเอียดไม่พอ ขยายแล้วแตก ควรได้ `retake`
- `sideways.jpg`: หมุน 90° ให้เองไม่ได้ ต้องให้คนกดหมุน
