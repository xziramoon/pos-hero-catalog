'use strict';
// เรนเดอร์ใบเซียมซีเป็น ESC/POS ในหน้าต่างซ่อน
// ทุกงานเรนเดอร์ใช้หน้าต่างของตัวเอง (สร้าง → ใช้ → ทำลาย) ห้ามแชร์หน้าต่างกัน:
// ตอนแรกแชร์หน้าต่างเดียว แล้วปุ่มทดลองพิมพ์ปิดหน้าต่างทิ้งกลางทางขณะที่แคช 100 ใบกำลังเรนเดอร์ ("Object has been destroyed")
const path = require('path');
const { BrowserWindow } = require('electron');
const { LEVEL_LABEL } = require('./logic');

const SLIP_DOT_WIDTH = 576; // 80 มม. เท่าใบเสร็จ
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const openWindows = new Set();

function destroyWindow(w) {
  try { if (w && !w.isDestroyed()) w.destroy(); } catch (e) { /* ignore */ }
  openWindows.delete(w);
}

async function createWindow() {
  const w = new BrowserWindow({
    show: false, width: SLIP_DOT_WIDTH, height: 400, useContentSize: true, frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  openWindows.add(w);
  try {
    await w.loadFile(path.join(__dirname, 'slip.html'));
  } catch (e) {
    destroyWindow(w);
    throw e;
  }
  return w;
}

// ปิดทุกหน้าต่างเรนเดอร์ที่ค้างอยู่ (ตอนปิดโปรแกรมเท่านั้น)
function closeAll() {
  for (const w of [...openWindows]) destroyWindow(w);
}

// เรนเดอร์ 1 ใบ → Buffer ESC/POS (ไม่มี ESC @ และไม่มีคำสั่งตัด — ต่อท้ายใบเสร็จที่พิมพ์ไปแล้ว)
async function renderOne(w, fortune, opts, buildRaster) {
  const slip = Object.assign({}, fortune, { label: LEVEL_LABEL[fortune.level] || fortune.level });
  const height = await w.webContents.executeJavaScript(
    `window.renderSlip(${JSON.stringify(slip)}, ${JSON.stringify({ theme: opts.theme, showZh: opts.showZh, showTh: opts.showTh, footer: opts.footer })})`
  );
  w.setContentSize(SLIP_DOT_WIDTH, Math.max(100, height));
  await delay(60);
  const captured = await w.webContents.capturePage({ x: 0, y: 0, width: SLIP_DOT_WIDTH, height: Math.max(100, height) });
  const resized = captured.resize({ width: SLIP_DOT_WIDTH, quality: 'best' });
  const size = resized.getSize();
  return buildRaster(resized.toBitmap(), size.width, size.height, { init: false, finish: false });
}

// เรนเดอร์บล็อกมาสคอต 1 ท่า → Buffer ESC/POS (ต่อท้ายตัวใบเซียมซีได้ทันที ไม่มี ESC @ ไม่มีคำสั่งตัด)
async function renderMascotOne(w, pose, opts, buildRaster) {
  const height = await w.webContents.executeJavaScript(`window.renderMascot(${JSON.stringify({ img: pose.img, caption: pose.caption })}, ${JSON.stringify({ footer: opts.mascotFooter })})`);
  w.setContentSize(SLIP_DOT_WIDTH, Math.max(60, height));
  await delay(60);
  const captured = await w.webContents.capturePage({ x: 0, y: 0, width: SLIP_DOT_WIDTH, height: Math.max(60, height) });
  const resized = captured.resize({ width: SLIP_DOT_WIDTH, quality: 'best' });
  const size = resized.getSize();
  return buildRaster(resized.toBitmap(), size.width, size.height, { init: false, finish: false });
}

// เรนเดอร์มาสคอตทุกท่า (หน้าต่างของตัวเอง) → Buffer[]
async function renderMascotAll(poses, opts, buildRaster, isStale = () => false) {
  const w = await createWindow();
  try {
    const out = [];
    for (const p of poses) { if (isStale()) return null; out.push(await renderMascotOne(w, p, opts, buildRaster)); }
    return out;
  } finally { destroyWindow(w); }
}

async function renderMascotSingle(pose, opts, buildRaster) {
  const w = await createWindow();
  try { return await renderMascotOne(w, pose, opts, buildRaster); } finally { destroyWindow(w); }
}

// เรนเดอร์ใบเดียวด้วยหน้าต่างใหม่ (ใช้ตอนแคชยังไม่พร้อม และปุ่มทดลองพิมพ์)
async function renderSingle(fortune, opts, buildRaster) {
  const w = await createWindow();
  try { return await renderOne(w, fortune, opts, buildRaster); } finally { destroyWindow(w); }
}

// opts: { theme, showZh, showTh, footer } (จาก logic.renderOptions) — ต้องเรียกใหม่ทุกครั้งที่ตัวเลือกเปลี่ยน
// isStale() คืน true ถ้ามีงานเรนเดอร์ที่ใหม่กว่าเริ่มแล้ว (ยกเลิกรอบเก่า → คืน null)
async function renderAll(fortunes, opts, buildRaster, isStale = () => false) {
  const w = await createWindow();
  try {
    const cache = new Array(fortunes.length).fill(null);
    for (let i = 0; i < fortunes.length; i++) {
      if (isStale()) return null;
      cache[i] = await renderOne(w, fortunes[i], opts, buildRaster);
    }
    return cache;
  } finally {
    destroyWindow(w);
  }
}

module.exports = { renderAll, renderSingle, renderMascotAll, renderMascotSingle, closeAll };
