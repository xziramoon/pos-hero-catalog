'use strict';
// เรนเดอร์ใบเซียมซีทั้ง 100 ใบในหน้าต่างซ่อน → ESC/POS เก็บไว้ในหน่วยความจำ (พิมพ์จริงจะไม่มีความหน่วง)
const path = require('path');
const { BrowserWindow } = require('electron');
const { LEVEL_LABEL } = require('./logic');

const SLIP_DOT_WIDTH = 576; // 80 มม. เท่าใบเสร็จ
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let win = null;

async function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    show: false, width: SLIP_DOT_WIDTH, height: 400, useContentSize: true, frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  await win.loadFile(path.join(__dirname, 'slip.html'));
  return win;
}

function closeWindow() {
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) { /* ignore */ }
  win = null;
}

// เรนเดอร์ 1 ใบ → Buffer ESC/POS (ไม่มี ESC @ และไม่มีคำสั่งตัด — ต่อท้ายใบเสร็จที่พิมพ์ไปแล้ว)
async function renderOne(w, fortune, opts, buildRaster) {
  const slip = Object.assign({}, fortune, { label: LEVEL_LABEL[fortune.level] || fortune.level });
  const height = await w.webContents.executeJavaScript(
    `window.renderSlip(${JSON.stringify(slip)}, ${JSON.stringify({ showZh: opts.showZh, showTh: opts.showTh, footer: opts.footer })})`
  );
  w.setContentSize(SLIP_DOT_WIDTH, Math.max(100, height));
  await delay(60);
  const captured = await w.webContents.capturePage({ x: 0, y: 0, width: SLIP_DOT_WIDTH, height: Math.max(100, height) });
  const resized = captured.resize({ width: SLIP_DOT_WIDTH, quality: 'best' });
  const size = resized.getSize();
  return buildRaster(resized.toBitmap(), size.width, size.height, { init: false, finish: false });
}

// opts: { showZh, showTh, footer } — ต้องเรียกใหม่ทุกครั้งที่สวิตช์กลอนเปลี่ยน
// isStale() คืน true ถ้ามีงานเรนเดอร์ใหม่ที่ใหม่กว่าเริ่มแล้ว (ยกเลิกรอบเก่า)
async function renderAll(fortunes, opts, buildRaster, isStale = () => false) {
  const w = await ensureWindow();
  const cache = new Array(fortunes.length).fill(null);
  for (let i = 0; i < fortunes.length; i++) {
    if (isStale()) return null;
    cache[i] = await renderOne(w, fortunes[i], opts, buildRaster);
  }
  return cache;
}

module.exports = { renderAll, renderOne, ensureWindow, closeWindow };
