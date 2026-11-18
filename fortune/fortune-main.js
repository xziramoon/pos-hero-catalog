'use strict';
// โมดูลเซียมซีต่อท้ายใบเสร็จ — ทุกจุดครอบ try/catch: ถ้าพลาด ต้องตัดกระดาษให้ใบเสร็จเสมอ และห้ามกระทบ POS Hero
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { BrowserWindow, Notification, ipcMain, clipboard, shell } = require('electron');
const logic = require('./logic');
const slipRenderer = require('./slip-renderer');
let coupon = null; // คูปองพังต้องไม่ทำให้เซียมซี/การตัดกระดาษพัง — โหลดไม่ได้ = ไม่มีคูปอง
try { coupon = require('./coupon-core'); } catch (e) { console.warn('[fortune] coupon-core load failed:', e && e.message); }
let billReader = null; // ตัวอ่านบิลจากไฟล์ spool — โหลดไม่ได้ = ใช้ยอด/สินค้าที่แคชเชียร์กรอกเอง
try { billReader = require('./bill-reader'); } catch (e) { console.warn('[fortune] bill-reader load failed:', e && e.message); }
let createBillSource = null;
try { createBillSource = require('./bill-source').createBillSource; } catch (e) { console.warn('[fortune] bill-source load failed:', e && e.message); }
let promo = null; // กฎคูปองรายสินค้า — โหลดไม่ได้ = ไม่มีคูปองรายสินค้า
try { promo = require('./promo-core'); } catch (e) { console.warn('[fortune] promo-core load failed:', e && e.message); }

const FORTUNES = require('./fortunes.json');
const HEARTBEAT_STALE_MS = 30 * 1000;
const WATCHER_RESTART_MS = 2000;
const LOG_MAX_BYTES = 512 * 1024;

let ctx = null;            // { app, getMainWindow, buildRaster }
let settings = logic.normalizeSettings(null);
let settingsFile = '';
let logFile = '';
let cacheKey = '';        // ตัวเลือกการเรนเดอร์ของแคชปัจจุบัน (ธีม/กลอน/ข้อความท้ายใบ)
let themeTimer = null;
let cache = null;          // Buffer[100] หรือ null ถ้ายังเรนเดอร์ไม่เสร็จ
let renderToken = 0;
let rendering = false;
let watcher = null;
let watcherPrinter = '';
let restartTimer = null;
let heartbeatTimer = null;
let lastHeartbeat = 0;
let staleNotified = false;
let stopping = false;
let queue = Promise.resolve();
const batcher = logic.makeBatcher({
  onFlush: (evts) => {
    // timeout รวมต่อชุด กันชุดเดียวค้างแล้วคิวทั้งแถวติด
    queue = queue.then(() => withTimeout(handleBatch(evts), 45000, 'handler jobs ' + evts.map((e) => e.id).join(',')))
      .catch((e) => log(`# handler error: ${e && e.message}`));
  }
});
const dedup = logic.makeDedup(200);
let stats = { date: logic.localDateStr(new Date()), count: 0 };
let settingsWin = null;
let amountWin = null;
let billSrc = null;       // เฝ้าโฟลเดอร์ที่ตัวช่วยสิทธิ์ผู้ดูแลคัดลอกไฟล์ spool มาให้
let billTimer = null;
let basket = null;        // สินค้าที่แคชเชียร์ยิงไว้ของบิลถัดไป (ใช้ครั้งเดียว)
let pending = null;       // ยอดบิลที่แคชเชียร์กรอกไว้รอบิลถัดไป (ใช้ครั้งเดียว)
let couponStore = null;   // ประวัติคูปองที่ออก
let onChange = () => {};

function log(line) {
  try {
    if (!logFile) return;
    try { if (fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, logFile + '.old'); } catch (e) { /* ยังไม่มีไฟล์ */ }
    // หมายเหตุของโปรแกรม (# ...) ใส่เวลากำกับ เพื่อให้รายงานบอกได้ว่าเกิดเมื่อไร
    const out = line.startsWith('# ') ? '# ' + new Date().toISOString() + ' ' + line.slice(2) : line;
    fs.appendFileSync(logFile, out + '\n');
  } catch (e) { /* ignore */ }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timeout ' + ms + 'ms')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function notify(title, body) {
  try { new Notification({ title, body }).show(); } catch (e) { /* ignore */ }
}

function loadSettings() {
  try { settings = logic.normalizeSettings(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); }
  catch (e) { settings = logic.normalizeSettings(null); }
}

function saveSettings() {
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (e) { console.warn('[fortune] save settings failed:', e && e.message); }
}

function bumpStats() {
  const today = logic.localDateStr(new Date());
  if (stats.date !== today) stats = { date: today, count: 0 };
  stats.count++;
  onChange();
}

function todayCount() {
  return stats.date === logic.localDateStr(new Date()) ? stats.count : 0;
}

// ---------- ส่ง bytes เข้าเครื่องพิมพ์ (ใช้ raw-print.ps1 ตัวเดิม — ชื่อเอกสาร "POS Hero Receipt" ซึ่ง watcher ข้ามอยู่แล้ว) ----------
function unpackedPath(...parts) {
  return ctx.app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', ...parts)
    : path.join(__dirname, '..', ...parts);
}

let printerCache = '';
async function resolvePrinter() {
  if (settings.printerName) return settings.printerName;
  if (watcherPrinter) return watcherPrinter; // ใช้เครื่องเดียวกับที่ตัวเฝ้าคิวเฝ้าอยู่ ไม่ต้องถามระบบทุกครั้ง
  const mw = ctx.getMainWindow();
  if (!mw) return '';
  const printers = await withTimeout(mw.webContents.getPrintersAsync(), 5000, 'getPrinters');
  const target = printers.find((p) => p.isDefault) || printers[0];
  if (target) printerCache = target.name;
  return target ? target.name : '';
}

async function sendBytes(buf) {
  let printer = '';
  try { printer = await resolvePrinter(); } catch (e) { printer = printerCache; if (!printer) throw e; }
  if (!printer) throw new Error('ไม่พบเครื่องพิมพ์ในระบบ');
  const tmp = path.join(os.tmpdir(), `pos-hero-fortune-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
  fs.writeFileSync(tmp, buf);
  try {
    await new Promise((resolve, reject) => {
      execFile('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', unpackedPath('build', 'raw-print.ps1'),
        '-PrinterName', printer, '-FilePath', tmp
      ], { windowsHide: true, timeout: 15000, killSignal: 'SIGKILL' }, (error, _o, stderr) => (error ? reject(new Error((stderr || error.message).trim())) : resolve()));
    });
  } finally {
    fs.unlink(tmp, () => {});
  }
}

// ---------- จัดการงานที่พิมพ์จบ ----------
// จัดการงานที่จบเป็นชุด: ใบเสร็จ 1 ใบ = เซียมซี 1 ใบ (ต่อกันบนแถบเดียว) แล้วตัดครั้งเดียวท้ายชุด
async function handleBatch(evts) {
  const actions = evts.map((e) => logic.decideAction(e.doc, settings));
  const slipCount = Math.min(actions.filter((a) => a === 'slip').length, 5);
  const ids = evts.map((e) => e.id).join(',');
  log(`# batch jobs [${ids}] ${evts.map((e) => '"' + e.doc + '"').join(' + ')} → ${slipCount ? slipCount + ' slip + cut' : 'cut'}`);
  if (!actions.some((a) => a !== 'skip')) return;

  if (slipCount > 0) {
    try {
      const parts = [];
      const picked = [];
      for (let i = 0; i < slipCount; i++) { const idx = logic.pickIndex(FORTUNES, settings); picked.push(idx + 1); parts.push(await getSlipBytes(idx)); }
      // คูปองต่อท้ายเซียมซีก่อนคำสั่งตัด (หนึ่งชุด = หนึ่งคูปอง) พลาดตรงไหน = พิมพ์เซียมซีเดิม ใบเสร็จต้องถูกตัดเสมอ
      let minted = [];
      try { minted = await buildCoupons(Math.max(1, slipCount)); for (const m of minted) parts.push(m.buf); } catch (e) { minted = []; log(`# coupon skipped: ${e && e.message}`); }
      parts.push(logic.FEED_AND_CUT);
      await sendBytes(Buffer.concat(parts));
      for (let i = 0; i < slipCount; i++) bumpStats();
      log(`# slip #${picked.join(',#')} sent for jobs [${ids}]`);
      for (const m of minted) {
        const saved = couponStore.commit(m.record);
        log(`# coupon ${m.label} issued ${coupon.displayCode(m.record.code)}${saved ? '' : ' (SAVE FAILED)'}`);
        if (!saved) notify('บันทึกคูปองไม่สำเร็จ', 'คูปองถูกพิมพ์แล้วแต่ตรวจรหัสในเครื่องนี้ไม่ได้ — จดรหัส ' + coupon.displayCode(m.record.code));
      }
      return;
    } catch (e) {
      log(`# slip failed for jobs [${ids}] (${e && e.message}) → cut only`);
      notify('POS Hero: ส่งเซียมซีไม่สำเร็จ', 'ตัดกระดาษให้อย่างเดียว — ' + (e && e.message ? e.message : ''));
      // ตกลงมาตัดกระดาษอย่างเดียว — ใบเสร็จต้องถูกตัดเสมอ
    }
  }
  try { await sendBytes(logic.FEED_AND_CUT); log(`# cut sent for jobs [${ids}]`); }
  catch (e) { log(`# cut failed for jobs [${ids}]: ${e && e.message}`); notify('POS Hero: ตัดกระดาษไม่สำเร็จ', 'ตรวจสอบเครื่องพิมพ์ หรือตั้งไดรเวอร์ Paper Cut กลับเป็น Cut'); }
}

// ---------- คูปองส่วนลด (ตามยอด + รายสินค้า) ----------
// ออกคูปองของบิลนี้ — ใบไหนพลาดก็ข้ามเฉพาะใบนั้น; เรียกผ่าน try เสมอ
// แหล่งข้อมูลของบิล: (1) บิลที่ตัวอ่านบิลอ่านได้จากไฟล์ spool (ยอดรวม + รายการ) — มาก่อน (2) ยอด/สินค้าที่แคชเชียร์กรอกเอง (ใช้เมื่อไม่มีบิลที่อ่านได้)
const MAX_COUPONS = 4;
const MAX_PRODUCT_COUPONS = 3;
function renderRecord(c) { return withTimeout(slipRenderer.renderCoupon(c, ctx.buildRaster), 10000, 'render coupon'); }
const catalogItems = () => { try { return ctx.getCatalogItems ? ctx.getCatalogItems() : []; } catch (e) { return []; } };

async function issueFor(src, out) {
  const base = src.billNo ? { billNo: src.billNo } : undefined;
  const tier = src.amount != null ? coupon.pickTier(settings.couponTiers, src.amount) : null;
  if (tier && out.length < MAX_COUPONS) {
    try {
      const record = couponStore.mint({ amount: src.amount, percent: tier.percent, prefix: settings.couponPrefix, validDays: settings.couponValidDays, extra: base });
      const buf = await renderRecord({ percent: record.percent, code: coupon.displayCode(record.code), raw: coupon.normalizeCode(record.code), expires: coupon.thaiDate(record.expiresAt) });
      out.push({ record, buf, label: record.percent + '%' });
    } catch (e) { log(`# amount coupon skipped: ${e && e.message}`); }
  } else log(src.amount == null ? '# coupon: no amount' : '# coupon: amount below first tier');
  if (promo && src.items && src.items.length) {
    const earned = promo.evaluate(settings.promoRules, src.items).earned.slice(0, MAX_PRODUCT_COUPONS);
    for (const rule of earned) {
      if (out.length >= MAX_COUPONS) break;
      try {
        const record = couponStore.mint({
          amount: null, percent: rule.kind === 'percent' ? rule.value : null, prefix: settings.couponPrefix, validDays: settings.couponValidDays,
          extra: { ...(base || {}), type: 'product', itemId: rule.itemId, name: rule.name, kind: rule.kind, value: rule.value, minQty: rule.minQty }
        });
        const buf = await renderRecord({
          title: 'คูปองส่วนลดสินค้า', big: promo.rewardText(rule), product: rule.name, note: 'ใช้ได้ครั้งเดียว เมื่อซื้อสินค้านี้ในครั้งหน้า',
          code: coupon.displayCode(record.code), raw: coupon.normalizeCode(record.code), expires: coupon.thaiDate(record.expiresAt)
        });
        out.push({ record, buf, label: rule.name + ' ' + promo.rewardText(rule) });
      } catch (e) { log(`# product coupon skipped (${rule.name}): ${e && e.message}`); }
    }
  }
}

async function buildCoupons(billCount = 1) {
  if (!coupon || !couponStore || !settings.couponEnabled) return [];
  const manualAmount = pending ? pending.take() : null;
  const manualItems = basket ? basket.take() : [];
  const sources = [];
  if (billSrc && settings.billReadEnabled) {
    billSrc.poll();
    if (billSrc.unsettled()) { for (let i = 0; i < 20 && billSrc.unsettled(); i++) { await new Promise((r) => setTimeout(r, 150)); billSrc.poll(); } }
    const used = couponStore.recent(5000);
    for (const b of billSrc.take(Math.max(1, billCount))) {
      if (b.billNo && used.some((c) => c.billNo === b.billNo)) { log(`# coupon: bill ${b.billNo} already issued → skip`); continue; }
      const bk = billReader ? billReader.billToBasket(b, catalogItems()) : { matched: [], unmatched: [] };
      log(`# bill read: ${b.billNo || '-'} total ${b.total} · ${b.items.length} items (${bk.matched.length} matched${bk.unmatched.length ? ', unmatched: ' + bk.unmatched.join(' | ') : ''})`);
      sources.push({ amount: b.total, items: bk.matched, billNo: b.billNo });
    }
  }
  if (!sources.length && (manualAmount != null || manualItems.length)) sources.push({ amount: manualAmount, items: manualItems, billNo: null });
  else if (sources.length && (manualAmount != null || manualItems.length)) log('# coupon: manual entry ignored (bill was read automatically)');
  const out = [];
  for (const src of sources) await issueFor(src, out);
  return out;
}

function basketInfo() {
  if (!basket || !promo) return { items: [], remainingMs: 0 };
  const items = basket.items();
  const prog = new Map(promo.evaluate(settings.promoRules, items).progress.map((p) => [p.rule.itemId, p]));
  return {
    remainingMs: basket.remainingMs(),
    items: items.map((it) => {
      const p = prog.get(it.itemId);
      return { itemId: it.itemId, name: it.name, qty: it.qty, minQty: p ? p.rule.minQty : null, reward: p ? promo.rewardText(p.rule) : null, done: !!(p && p.done) };
    })
  };
}

// ยิง/พิมพ์สินค้า → เข้าตะกร้าถ้ามีกฎส่วนลดของสินค้านั้น
function basketScan(text) {
  if (!basket || !promo || !settings.couponEnabled) return { ok: false, reason: 'ระบบคูปองปิดอยู่' };
  const items = ctx.getCatalogItems ? ctx.getCatalogItems() : [];
  const r = promo.findItem(items, text);
  if (r.status === 'notfound') return { ok: true, status: 'notfound' };
  if (r.status === 'suggest') return { ok: true, status: 'suggest', choices: r.choices.map((i) => ({ id: i.id, name: i.name })) };
  return basketAddItem(r.item.id, r.item.name);
}
function basketAddItem(itemId, nameHint) {
  const rule = settings.promoRules.find((x) => x.itemId === String(itemId));
  if (!rule) return { ok: true, status: 'nopromo', name: nameHint || String(itemId) };
  basket.add(rule.itemId, rule.name);
  return { ok: true, status: 'added', name: rule.name };
}

function amountInfo() {
  const amount = pending ? pending.peek() : null;
  const tier = amount != null && coupon ? coupon.pickTier(settings.couponTiers, amount) : null;
  return {
    couponEnabled: !!settings.couponEnabled && !!coupon && !!couponStore,
    amount, remainingMs: pending ? pending.remainingMs() : 0,
    percent: tier ? tier.percent : null,
    tiers: coupon ? coupon.normalizeTiers(settings.couponTiers) : [],
    basket: basketInfo(),
    hasRules: settings.promoRules.length > 0
  };
}

// หน้าต่างเล็กลอยค้างสำหรับกรอกยอดบิล (พิมพ์ยอด → Enter → ใช้กับใบเสร็จถัดไปครั้งเดียว)
function openAmount() {
  if (amountWin && !amountWin.isDestroyed()) { amountWin.show(); amountWin.focus(); return; }
  amountWin = new BrowserWindow({
    width: 380, height: 540, title: 'บิลถัดไป (คูปอง)', autoHideMenuBar: true, minimizable: false, maximizable: false, resizable: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'amount-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  amountWin.setMenu(null);
  amountWin.setAlwaysOnTop(true, 'floating');
  try {
    const { screen } = require('electron');
    const wa = screen.getPrimaryDisplay().workArea;
    amountWin.setPosition(wa.x + wa.width - 400, wa.y + wa.height - 560);
  } catch (e) { /* ใช้ตำแหน่งตั้งต้น */ }
  amountWin.loadFile(path.join(__dirname, 'amount.html'));
  amountWin.on('closed', () => { amountWin = null; });
}

function registerCouponIpc() {
  ipcMain.handle('fortune:amount-get', () => { try { return amountInfo(); } catch (e) { return { couponEnabled: false, amount: null, remainingMs: 0, percent: null, tiers: [] }; } });
  ipcMain.handle('fortune:amount-set', (_e, raw) => {
    try {
      if (!pending || !pending.set(raw)) return { ok: false, reason: 'ใส่ยอดเป็นตัวเลข เช่น 850 หรือ 1,250' };
      return { ok: true, info: amountInfo() };
    } catch (e) { return { ok: false, reason: e && e.message ? e.message : String(e) }; }
  });
  ipcMain.handle('fortune:amount-clear', () => { try { if (pending) pending.clear(); if (basket) basket.clear(); } catch (e) { /* ignore */ } return { ok: true }; });
  ipcMain.handle('fortune:basket-scan', (_e, text) => { try { return basketScan(text); } catch (e) { return { ok: false, reason: e && e.message ? e.message : String(e) }; } });
  ipcMain.handle('fortune:basket-add', (_e, itemId) => { try { return basket && promo ? basketAddItem(itemId) : { ok: false }; } catch (e) { return { ok: false }; } });
  ipcMain.handle('fortune:basket-dec', (_e, itemId) => { try { if (basket) basket.dec(itemId); } catch (e) { /* ignore */ } return { ok: true }; });
  ipcMain.handle('fortune:bill-status', () => { try { return billStatus(); } catch (e) { return { running: false, outdated: false, enabled: false, last: null }; } });
  ipcMain.handle('fortune:helper-setup', () => { try { helperSetup(); } catch (e) { /* ignore */ } return { ok: true }; });
  ipcMain.handle('fortune:helper-remove', () => { try { helperRemove(); } catch (e) { /* ignore */ } return { ok: true }; });
  ipcMain.handle('fortune:promo-search', (_e, q) => { try { return promo && ctx.getCatalogItems ? promo.searchItems(ctx.getCatalogItems(), q).map((i) => ({ id: i.id, name: i.name, code: i.code })) : []; } catch (e) { return []; } });
  ipcMain.handle('fortune:coupon-check', (_e, code) => {
    try { return couponStore ? { ok: true, ...couponStore.check(code) } : { ok: false, reason: 'ระบบคูปองไม่พร้อมใช้งาน' }; } catch (e) { return { ok: false, reason: e && e.message ? e.message : String(e) }; }
  });
  ipcMain.handle('fortune:coupon-use', (_e, code) => {
    try { return couponStore ? { ok: true, ...couponStore.markUsed(code) } : { ok: false, reason: 'ระบบคูปองไม่พร้อมใช้งาน' }; } catch (e) { return { ok: false, reason: e && e.message ? e.message : String(e) }; }
  });
}

function onWatcherEvent(evt) {
  if (evt.e === 'hb' || evt.e === 'start') { lastHeartbeat = Date.now(); staleNotified = false; }
  if (evt.e !== 'hb') log(JSON.stringify(evt));
  if (settings.mode !== 'on') return; // โหมดบันทึกอย่างเดียว: ไม่ทำอะไรกับงาน

  if (evt.doc === logic.OWN_DOC_NAME) return; // งานของ POS Hero เอง (มีคำสั่งตัดในตัว) — ไม่นับ ไม่ลงบันทึก
  if (evt.e === 'added') { batcher.added(evt.id); return; }

  let finished = false;
  if (evt.e === 'done') finished = true;
  else if (evt.e === 'gone') finished = !evt.done && !/Error|Delet|Offline|Paperout|UserIntervention/i.test(evt.lastStatus || '');
  if (evt.e === 'gone' && !finished) batcher.dropped(evt.id); // จบแบบพลาด/ถูกยกเลิก หรือจบไปแล้ว: เลิกรอ
  if (!finished) return;
  if (dedup.seen(evt.id)) { log(`# skip job ${evt.id} "${evt.doc}" (already handled within 10 min)`); batcher.dropped(evt.id); return; }
  dedup.add(evt.id);
  batcher.finished(evt); // รอคิวเงียบ แล้วค่อยตัด/พิมพ์เซียมซีเป็นชุด (handleBatch)
}

// ---------- watcher (PowerShell ตัวเดียวรันค้าง) ----------
async function startWatcher() {
  stopWatcher(false);
  batcher.reset(); // ตัวเฝ้าใหม่เริ่มจำงานค้างในคิวใหม่
  stopping = false;
  if (settings.mode === 'off') return;
  let printer = '';
  try { printer = await resolvePrinter(); } catch (e) { /* ลองใหม่ด้านล่าง */ }
  if (!printer) { restartTimer = setTimeout(startWatcher, 5000); return; }
  watcherPrinter = printer;
  try {
    watcher = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', unpackedPath('fortune', 'job-watcher.ps1'),
      '-PrinterName', printer, '-IntervalMs', '120'
    ], { windowsHide: true });
  } catch (e) { log(`# spawn failed: ${e && e.message}`); restartTimer = setTimeout(startWatcher, WATCHER_RESTART_MS); return; }

  const child = watcher;
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { onWatcherEvent(JSON.parse(line)); } catch (e) { log(`# bad line: ${line.slice(0, 200)}`); }
    }
  });
  child.stderr.on('data', (d) => log(`# stderr: ${String(d).trim().slice(0, 300)}`));
  child.on('exit', (code) => {
    // ตัวที่เราสั่งปิดเองเพื่อแทนที่ (stopWatcher/startWatcher) ห้ามกลับมาสั่งรีสตาร์ท ไม่งั้นวนฆ่า-เปิดใหม่ทุก 2 วินาที
    if (child.replacedByUs) return;
    if (watcher === child) watcher = null;
    if (stopping || settings.mode === 'off') return;
    if (restartTimer) return;
    log(`# watcher exited (${code}) → restart`);
    restartTimer = setTimeout(() => { restartTimer = null; startWatcher().catch(() => {}); }, WATCHER_RESTART_MS);
  });
  lastHeartbeat = Date.now();
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      if (!watcher || settings.mode === 'off') return;
      if (Date.now() - lastHeartbeat > HEARTBEAT_STALE_MS && !staleNotified) {
        staleNotified = true;
        notify('POS Hero: ตัวเฝ้าเครื่องพิมพ์หยุดทำงาน', 'ใบเสร็จอาจไม่ถูกตัดกระดาษ — ลองเปิดโปรแกรมใหม่ หรือตั้งไดรเวอร์ Paper Cut = Cut');
      }
    }, 5000);
  }
}

function stopWatcher(final = true) {
  if (final) stopping = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (watcher) { watcher.replacedByUs = true; try { watcher.kill(); } catch (e) { /* ignore */ } watcher = null; }
  if (final && heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ---------- เรนเดอร์แคช ----------
async function rebuildCache() {
  const token = ++renderToken;
  const cacheOpts = logic.renderOptions(settings);
  cacheKey = JSON.stringify(cacheOpts);
  cache = null;
  rendering = true;
  onChange();
  try {
    const result = await slipRenderer.renderAll(
      FORTUNES,
      cacheOpts,
      ctx.buildRaster,
      () => token !== renderToken
    );
    if (token === renderToken && result) {
      cache = result;
      rebuildFailures = 0;
      log(`# slip cache ready (theme ${cacheOpts.theme}, zh ${cacheOpts.showZh}, th ${cacheOpts.showTh})`);
    }
  } catch (e) {
    console.warn('[fortune] render failed:', e && e.message);
    log(`# render failed: ${e && e.message}`);
    if (token === renderToken) scheduleRebuildRetry();
  } finally {
    if (token === renderToken) { rendering = false; onChange(); }
  }
}

// เรนเดอร์แคชพลาด: ลองใหม่เอง (15, 30, 45 … สูงสุด 120 วินาที) ไม่ทิ้งให้แคชว่างไปจนกว่าจะปิดเปิดโปรแกรม
let retryTimer = null;
let rebuildFailures = 0;
function scheduleRebuildRetry() {
  rebuildFailures++;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (settings.mode === 'on' && !cache && !rendering) rebuildCache().catch(() => {});
  }, Math.min(15000 * rebuildFailures, 120000));
}

// ใบเซียมซีที่จะพิมพ์: ใช้แคช ถ้ายังไม่พร้อมให้เรนเดอร์ใบนั้นใบเดียวทันที (ราว 0.3 วินาที) แทนที่จะไม่ออกเซียมซี
async function getSlipBytes(idx) {
  if (cache && cache[idx]) return cache[idx];
  log(`# cache not ready → render slip #${idx + 1} on demand`);
  if (!rendering && settings.mode === 'on') rebuildCache().catch(() => {});
  return withTimeout(slipRenderer.renderSingle(FORTUNES[idx], logic.renderOptions(settings), ctx.buildRaster), 10000, 'render slip');
}

function applySettings(next) {
  const prev = settings;
  settings = logic.normalizeSettings(Object.assign({}, prev, next));
  saveSettings();
  const needsSlips = settings.mode === 'on';
  const lookChanged = JSON.stringify(logic.renderOptions(settings)) !== cacheKey;
  if (needsSlips && (lookChanged || prev.mode !== 'on' || (!cache && !rendering))) rebuildCache().catch(() => {});
  if (!needsSlips) { renderToken++; cache = null; rendering = false; }
  if (prev.mode !== settings.mode || prev.printerName !== settings.printerName) {
    if (settings.mode === 'off') stopWatcher(); else startWatcher().catch(() => {});
  }
  onChange();
  return getState();
}

async function testPrint() {
  const idx = logic.pickIndex(FORTUNES, settings);
  const bytes = cache && cache[idx] ? cache[idx] : await withTimeout(slipRenderer.renderSingle(FORTUNES[idx], logic.renderOptions(settings), ctx.buildRaster), 10000, 'render slip');
  await sendBytes(Buffer.concat([bytes, logic.FEED_AND_CUT]));
  return { success: true, n: idx + 1 };
}

// รายงานสรุปงานพิมพ์: เขียนไฟล์ + คัดลอกลงคลิปบอร์ด (วางส่งได้ทันที) + เปิดโฟลเดอร์ + ถ้ามีโฟลเดอร์ Google Drive ในเครื่องก็คัดลอกไปให้
function driveFolders() {
  const home = os.homedir();
  return [path.join(home, 'Google Drive'), path.join(home, 'My Drive'), 'G:\\My Drive', 'H:\\My Drive']
    .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } });
}

function readLogLines() {
  let lines = [];
  for (const f of [logFile + '.old', logFile]) { try { lines = lines.concat(fs.readFileSync(f, 'utf8').split(/\r?\n/)); } catch (e) { /* ไม่มีไฟล์ */ } }
  return lines.filter(Boolean);
}

function exportReport() {
  const lines = readLogLines();
  if (!lines.length) return { success: false, reason: 'ยังไม่มีไฟล์บันทึก — เปิดโหมด "บันทึกอย่างเดียว" แล้วขายสักบิลก่อน' };
  const text = logic.buildReportText(lines, {
    'เวอร์ชัน': ctx.app.getVersion(), 'โหมด': settings.mode, 'เครื่องพิมพ์': watcherPrinter || settings.printerName || '(เริ่มต้น)',
    'ตัวกรอง': settings.docFilter, 'สร้างเมื่อ': new Date().toISOString()
  });
  const file = path.join(path.dirname(logFile), 'fortune-report.txt');
  fs.writeFileSync(file, text, 'utf8');
  try { clipboard.writeText(text); } catch (e) { /* ignore */ }
  let drive = '';
  for (const d of driveFolders()) {
    try {
      const dir = path.join(d, 'pos-hero-logs'); fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(file, path.join(dir, 'fortune-report.txt'));
      fs.copyFileSync(logFile, path.join(dir, 'fortune-jobs.log'));
      drive = dir; break;
    } catch (e) { /* ลองโฟลเดอร์ถัดไป */ }
  }
  try { shell.showItemInFolder(file); } catch (e) { /* ignore */ }
  return { success: true, file, drive, chars: text.length };
}

function getState() {
  return {
    settings, todayCount: todayCount(), ready: !!cache, rendering,
    watcherRunning: !!watcher, watcherPrinter, logFile
  };
}

// ---------- ตัวอ่านบิลอัตโนมัติ: ตัวช่วยสิทธิ์ผู้ดูแล (Scheduled Task) + โฟลเดอร์ที่แอปอ่านได้ ----------
// ตัวช่วย (spool-relay.ps1) คัดลอกไฟล์ spool ของบิลมาที่ C:\ProgramData\PosHero\spool-live แอปอ่านแล้วถอดเป็นรายการ/ยอดรวม
// ติดตั้งครั้งเดียวด้วย UAC: สำเนาสคริปต์ไปไว้ใน ProgramData (แก้ได้เฉพาะผู้ดูแล — งานที่รันด้วยสิทธิ์สูงต้องไม่รันสคริปต์ที่ผู้ใช้ทั่วไปแก้ได้)
const HELPER_TASK = 'POS Hero Spool Helper';
const progData = () => path.join(process.env.ProgramData || 'C:\\ProgramData', 'PosHero');
const helperScriptCopy = () => path.join(progData(), 'spool-relay.ps1');
const billDir = () => (ctx && ctx.billDir) || path.join(progData(), 'spool-live');
const sha = (file) => { try { return require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (e) { return ''; } };

function runElevated(innerScript, cb) {
  const enc = (s) => Buffer.from(s, 'utf16le').toString('base64');
  const outer = `$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${enc(innerScript)}'; exit $p.ExitCode`;
  execFile('powershell.exe', ['-NoProfile', '-EncodedCommand', enc(outer)], { windowsHide: true, timeout: 180000 }, (error) => cb(error));
}

function helperSetup() {
  const src = unpackedPath('fortune', 'spool-relay.ps1');
  const user = `${process.env.USERDOMAIN || process.env.COMPUTERNAME}\\${process.env.USERNAME}`;
  const dir = progData(), dest = billDir(), script = helperScriptCopy();
  const inner = `
$ErrorActionPreference = 'Stop'
try {
  New-Item -ItemType Directory -Force -Path '${psq(dir)}' | Out-Null
  New-Item -ItemType Directory -Force -Path '${psq(dest)}' | Out-Null
  Copy-Item -LiteralPath '${psq(src)}' -Destination '${psq(script)}' -Force
  icacls '${psq(dir)}' /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*spool-relay.ps1*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${psq(script)}" -Dest "${psq(dest)}"')
  $trg = New-ScheduledTaskTrigger -AtLogOn -User '${psq(user)}'
  $pri = New-ScheduledTaskPrincipal -UserId '${psq(user)}' -LogonType Interactive -RunLevel Highest
  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName '${HELPER_TASK}' -Action $act -Trigger $trg -Principal $pri -Settings $set -Force | Out-Null
  Start-ScheduledTask -TaskName '${HELPER_TASK}'
  exit 0
} catch { exit 2 }`;
  notify('กำลังติดตั้งตัวช่วยอ่านบิล', 'กดอนุญาต (สิทธิ์ผู้ดูแล) ในหน้าต่างที่เด้งขึ้นมา');
  runElevated(inner, (error) => {
    if (error) { log(`# helper setup failed: ${error.message}`); notify('ติดตั้งตัวช่วยอ่านบิลไม่สำเร็จ', 'ต้องกดอนุญาต (สิทธิ์ผู้ดูแล) — ลองใหม่อีกครั้ง'); onChange(); return; }
    setTimeout(() => {
      const ok = !!billSrc && billSrc.heartbeatAgeMs() < 5000;
      log(`# helper setup done, running=${ok}`);
      notify(ok ? 'ตัวช่วยอ่านบิลพร้อมใช้งาน' : 'ติดตั้งแล้ว แต่ตัวช่วยยังไม่ตอบสนอง', ok ? 'บิลถัดไปจะถูกอ่านอัตโนมัติ' : 'ลองรีสตาร์ทเครื่อง หรือกดติดตั้งใหม่');
      onChange();
    }, 4000);
  });
}

function helperRemove() {
  const inner = `
$ErrorActionPreference = 'SilentlyContinue'
Stop-ScheduledTask -TaskName '${HELPER_TASK}'
Unregister-ScheduledTask -TaskName '${HELPER_TASK}' -Confirm:$false
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*spool-relay.ps1*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
exit 0`;
  runElevated(inner, (error) => {
    log(`# helper remove ${error ? 'failed: ' + error.message : 'ok'}`);
    notify(error ? 'ถอนตัวช่วยอ่านบิลไม่สำเร็จ' : 'ถอนตัวช่วยอ่านบิลแล้ว', error ? 'ต้องกดอนุญาต (สิทธิ์ผู้ดูแล)' : 'กลับไปใช้การกรอกยอด/ยิงสินค้าเอง');
    onChange();
  });
}

function billStatus() {
  const age = billSrc ? billSrc.heartbeatAgeMs() : Infinity;
  const last = billSrc ? billSrc.last() : null;
  let detail = null;
  if (last && billReader && promo) {
    const bk = billReader.billToBasket(last, catalogItems());
    const rules = new Set(settings.promoRules.map((r) => r.itemId));
    detail = {
      billNo: last.billNo, date: last.date, total: last.total, payment: last.payment, at: last.at,
      items: last.items.map((it) => ({ name: it.name, qty: it.qty, total: it.total })),
      matched: bk.matched.map((m) => ({ name: m.name, qty: m.qty, hasRule: rules.has(m.itemId) })),
      unmatched: bk.unmatched
    };
  }
  const copy = helperScriptCopy();
  const outdated = age < 5000 && fs.existsSync(copy) && sha(copy) !== sha(unpackedPath('fortune', 'spool-relay.ps1'));
  return { running: age < 5000, outdated, enabled: !!settings.billReadEnabled, last: detail };
}

// ---------- เก็บตัวอย่างไฟล์ spool ของบิล POS (ไว้ดูว่าอ่านรายการจากบิลอัตโนมัติได้ไหม) ----------
// ต้องใช้สิทธิ์ผู้ดูแลเพื่ออ่านโฟลเดอร์ spool → ขอ UAC ครั้งเดียว สคริปต์หยุดเองเมื่อครบ 8 งาน/30 นาที (หรือกดหยุดจากเมนูถาด)
let captureTimer = null;
function samplesDir() { return path.join(ctx.app.getPath('userData'), 'spool-samples'); }
const psq = (s) => String(s).replace(/'/g, "''");

function startSpoolCapture() {
  if (captureTimer) return;
  const dir = samplesDir();
  try { fs.mkdirSync(dir, { recursive: true }); fs.unlinkSync(path.join(dir, 'DONE')); } catch (e) { /* ไม่มีไฟล์เก่า */ }
  const script = unpackedPath('fortune', 'spool-capture.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `"${script}"`, '-Dest', `"${dir}"`, '-MaxJobs', '8', '-MaxMinutes', '30'].map((a) => `'${psq(a)}'`).join(',');
  captureTimer = setInterval(() => {}, 1 << 30); // กันกดซ้ำระหว่างรอ UAC; แทนที่ด้วยตัวจับเวลาจริงด้านล่าง
  execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList ${args}`],
    { windowsHide: true, timeout: 120000 }, (error) => {
      if (error) {
        clearInterval(captureTimer); captureTimer = null; onChange();
        log(`# spool capture not started: ${error.message}`);
        notify('เก็บตัวอย่างบิลไม่สำเร็จ', 'ต้องกดอนุญาต (สิทธิ์ผู้ดูแล) ในหน้าต่างที่เด้งขึ้นมา');
        return;
      }
      clearInterval(captureTimer);
      const startedAt = Date.now();
      captureTimer = setInterval(() => {
        let finished = false, n = '';
        try { n = fs.readFileSync(path.join(dir, 'DONE'), 'utf8').trim(); finished = true; } catch (e) { /* ยังเก็บอยู่ */ }
        if (!finished && Date.now() - startedAt < 35 * 60 * 1000) return;
        clearInterval(captureTimer); captureTimer = null; onChange();
        log(`# spool capture finished (${finished ? n + ' jobs' : 'timeout'})`);
        notify('เก็บตัวอย่างบิลเสร็จแล้ว', finished ? `ได้ ${n} งาน — ส่งไฟล์ samples.zip ในโฟลเดอร์ที่เปิดให้` : 'หมดเวลา ลองเปิดโฟลเดอร์ดูไฟล์ที่ได้');
        try { const z = path.join(dir, 'samples.zip'); if (fs.existsSync(z)) shell.showItemInFolder(z); else shell.openPath(dir); } catch (e) { /* ignore */ }
      }, 3000);
      onChange();
      log('# spool capture started');
      notify('เริ่มเก็บตัวอย่างบิลแล้ว', 'พิมพ์บิลจริง 3-5 ใบ (หลายรายการ ต่างกัน) — ครบแล้วจะแจ้งและเปิดโฟลเดอร์ให้');
    });
  onChange();
}

function stopSpoolCapture() {
  try { fs.writeFileSync(path.join(samplesDir(), 'STOP'), '1'); } catch (e) { /* ignore */ }
  notify('กำลังหยุดเก็บตัวอย่างบิล', 'รอสักครู่ จะแจ้งเมื่อเสร็จ');
}

function openSamplesFolder() {
  const dir = samplesDir();
  try { fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); } catch (e) { /* ignore */ }
}

function trayItems() {
  const modeText = { off: 'ปิด', record: 'บันทึกอย่างเดียว', on: 'เปิด' }[settings.mode];
  return [
    { label: `🔮 เซียมซี: ${modeText} · วันนี้ ${todayCount()} ใบ`, click: () => openSettings() },
    { label: '🧾 ยอดบิล (คูปอง)', click: () => { try { openAmount(); } catch (e) { /* ignore */ } } },
    captureTimer
      ? { label: '⏹ หยุดเก็บตัวอย่างบิล', click: () => stopSpoolCapture() }
      : { label: '📥 เก็บตัวอย่างบิล (ขอสิทธิ์ผู้ดูแล)', click: () => { try { startSpoolCapture(); } catch (e) { /* ignore */ } } },
    { label: '📂 เปิดโฟลเดอร์ตัวอย่างบิล', click: () => openSamplesFolder() },
    { type: 'separator' }
  ];
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 520, height: 940, title: 'ตั้งค่าเซียมซี', autoHideMenuBar: true, resizable: true,
    webPreferences: { preload: path.join(__dirname, 'preload-fortune.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

function init(context) {
  ctx = context;
  const dir = ctx.app.getPath('userData');
  settingsFile = path.join(dir, 'fortune-settings.json');
  logFile = path.join(dir, 'fortune-jobs.log');
  loadSettings();
  try {
    if (coupon) {
      pending = coupon.createPending();
      basket = promo ? promo.createBasket() : null;
      if (billReader && createBillSource) {
        billSrc = createBillSource({ dir: billDir(), readBill: (buf) => billReader.readBill(buf), settleMs: ctx.billSettleMs || 1200 });
        billTimer = setInterval(() => { try { billSrc.poll(); } catch (e) { /* ignore */ } }, 300);
      }
      couponStore = coupon.createCouponStore({ file: path.join(dir, 'fortune-coupons.json') });
      registerCouponIpc();
    }
  } catch (e) { pending = null; couponStore = null; log(`# coupon init failed: ${e && e.message}`); }
  onChange = () => {
    try { if (ctx.onChange) ctx.onChange(); } catch (e) { /* ignore */ }
    try { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('fortune:state', getState()); } catch (e) { /* ignore */ }
  };

  ipcMain.handle('fortune:get-state', () => getState());
  ipcMain.handle('fortune:set-settings', (_e, next) => { try { return applySettings(next || {}); } catch (e) { return getState(); } });
  ipcMain.handle('fortune:test-print', async () => {
    try { return await testPrint(); } catch (e) { return { success: false, reason: e && e.message ? e.message : String(e) }; }
  });
  ipcMain.handle('fortune:export-report', () => { try { return exportReport(); } catch (e) { return { success: false, reason: e && e.message ? e.message : String(e) }; } });
  ipcMain.handle('fortune:list-printers', async () => {
    try { const mw = ctx.getMainWindow(); return mw ? (await mw.webContents.getPrintersAsync()).map((p) => p.name) : []; } catch (e) { return []; }
  });

  if (settings.mode === 'on') rebuildCache().catch(() => {});
  // ข้ามวันแล้วธีมอาจเปลี่ยน (auto ตามช่วงวันที่) — ตรวจทุก 10 นาที ถ้าเปลี่ยนให้เรนเดอร์แคชใหม่
  themeTimer = setInterval(() => {
    if (settings.mode === 'on' && !rendering && (!cache || JSON.stringify(logic.renderOptions(settings)) !== cacheKey)) rebuildCache().catch(() => {});
  }, 10 * 60 * 1000);
  if (settings.mode !== 'off') startWatcher().catch(() => {});
}

function shutdown() { if (themeTimer) clearInterval(themeTimer); if (captureTimer) clearInterval(captureTimer); if (billTimer) clearInterval(billTimer); stopWatcher(true); slipRenderer.closeAll(); }

module.exports = { init, shutdown, trayItems, openSettings, openAmount, _handleBatch: handleBatch, _getPending: () => pending, _getBillSrc: () => billSrc, _getBasket: () => basket, _basketScan: (t) => basketScan(t), _basketScan: (t) => basketScan(t), _getStore: () => couponStore }; // _ = สำหรับ test เท่านั้น
