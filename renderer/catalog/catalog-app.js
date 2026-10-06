'use strict';
// Catalog Hero inventory UI (spec §7). Local data only in Phase 2.
(function () {
  const api = window.catalogAPI;
  const F = window.CatalogFilters;
  const I = window.CatalogIcons;
  const PE = window.CatalogPhotoEditor;
  const $ = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ------------------------------------------------------------------ theme
  const DEFAULT_THEME = 'amber';
  function applyTheme(name) {
    if (!name || name === DEFAULT_THEME) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', name);
  }
  try { applyTheme(localStorage.getItem('heroTheme')); } catch (e) { /* ignore */ }
  window.addEventListener('storage', (e) => { if (e.key === 'heroTheme') applyTheme(e.newValue); });
  if (api) api.onTheme(applyTheme);

  I.mount(document);
  if (!api) {
    document.body.insertAdjacentHTML('afterbegin', '<p style="padding:20px">ไม่พบ catalogAPI</p>');
    return;
  }

  // ------------------------------------------------------------------ state
  const S = {
    cfg: null,
    meta: { categories: ['ทั่วไป'] },
    items: new Map(),     // id -> item (insertion order == creation order)
    arr: [],              // cached Array.from(items.values())
    arrDirty: true,
    idx: new Map(),       // id -> search index entry
    counts: null,         // { tabId: n }
    tabs: [],
    tab: 'all',
    query: '',
    qn: '',
    filtered: [],
    selectedId: null,
    multi: false,
    picked: new Set(),
    cols: 1,
    rowH: 134,
    totalRows: 0,
    rowEls: new Map(),
    dialog: null,
    sync: null,
    lastCanEdit: true,
    promptedTarget: null,
    job: null
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const g = () => S.cfg.grid;
  const validVer = (v) => v == null || (Number.isInteger(v) && v > 0);
  const hasImg = (it) => !!(it.image && typeof it.image.hash === 'string' && /^[0-9a-f]{64}$/.test(it.image.hash) && validVer(it.image.ver));
  const imgUrl = (it, variant) => 'catimg://' + encodeURIComponent(it.image.hash) + '/' + variant + '-v' + (it.image.ver || 1) + '.jpg';
  const labelOf = (it) => it.shortName || it.name || it.code || '(ไม่มีชื่อ)';

  // ------------------------------------------------------------------ data
  function upsert(it) {
    S.items.set(it.id, it);
    S.idx.set(it.id, F.buildIndexEntry(it));
    S.arrDirty = true; S.counts = null;
  }
  function drop(id) {
    S.items.delete(id); S.idx.delete(id); S.picked.delete(id);
    S.arrDirty = true; S.counts = null;
  }
  function itemsArr() {
    if (S.arrDirty) { S.arr = Array.from(S.items.values()); S.arrDirty = false; }
    return S.arr;
  }

  async function loadAll() {
    const r = await api.list();
    S.meta = r.meta || S.meta;
    S.items = new Map(); S.idx = new Map();
    const list = r.items.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const it of list) { S.items.set(it.id, it); S.idx.set(it.id, F.buildIndexEntry(it)); }
    S.arrDirty = true; S.counts = null;
  }

  let changedTimer = null;
  let changedIds = new Set();
  let changedAll = false;
  function onChanged(p) {
    if (!p || !Array.isArray(p.ids)) changedAll = true; else p.ids.forEach((i) => changedIds.add(i));
    if (changedTimer) return;
    changedTimer = setTimeout(async () => {
      changedTimer = null;
      const ids = Array.from(changedIds); const all = changedAll || ids.length > 300;
      changedIds = new Set(); changedAll = false;
      try {
        if (all) await loadAll();
        else {
          const got = await Promise.all(ids.map((id) => api.get(id)));
          ids.forEach((id, i) => { if (got[i]) upsert(got[i]); else drop(id); });
          S.meta = (await api.getMeta()) || S.meta;
        }
        S.counts = null;
        refresh({ keepScroll: true });
      } catch (e) { console.warn('[catalog] reload failed', e); }
    }, 25);
  }

  // ------------------------------------------------------------------ tabs / filter
  function computeCounts() {
    const c = { all: 0 }; const cats = {};
    const fx = F.FILTERS.slice(1);
    for (const f of fx) c[f.id] = 0;
    for (const it of itemsArr()) {
      c.all++;
      cats[it.cat] = (cats[it.cat] || 0) + 1;
      for (const f of fx) if (f.match(it)) c[f.id]++;
    }
    for (const k of Object.keys(cats)) c['cat:' + k] = cats[k];
    S.counts = c;
  }

  function renderTabs() {
    if (!S.counts) computeCounts();
    S.tabs = F.buildTabs(S.meta, S.cfg.tabs);
    if (!S.tabs.some((t) => t.id === S.tab)) S.tab = 'all';
    $('tabs').innerHTML = S.tabs.map((t) => {
      const active = t.id === S.tab;
      return '<button type="button" role="tab" class="filter-tab' + (active ? ' active' : '') + (t.alert ? ' alert' : '') +
        '" aria-selected="' + active + '" data-tab="' + esc(t.id) + '">' + (t.icon ? I.svg(t.icon, 11) : '') + esc(t.label) +
        '<span class="tab-count">' + (S.counts[t.id] || 0) + '</span></button>';
    }).join('');
  }

  function computeFiltered() {
    const tab = S.tabs.find((t) => t.id === S.tab) || S.tabs[0];
    const q = S.qn;
    const out = []; const exact = [];
    for (const it of itemsArr()) {
      if (!tab.match(it)) continue;
      if (q) {
        const e = S.idx.get(it.id);
        if (!F.matchesQuery(e, q)) continue;
        if (F.isExactCodeOrBarcode(e, q)) { exact.push(it); continue; }
      }
      out.push(it);
    }
    S.filtered = exact.length ? exact.concat(out) : out;
  }

  // ------------------------------------------------------------------ grid (virtualized)
  const scroller = $('gridScroll');
  const sizer = $('gridSizer');
  const rowsHost = $('gridRows');

  function applyGridVars() {
    const r = document.documentElement.style;
    r.setProperty('--slot-w', g().slotW + 'px'); r.setProperty('--slot-h', g().slotH + 'px');
    r.setProperty('--tile', g().tile + 'px'); r.setProperty('--gap', g().gap + 'px');
    r.setProperty('--tile-bg', S.cfg.image.tileBg);
    S.rowH = g().slotH + g().gap;
  }

  function slotHtml(it, rovingId) {
    const sel = it.id === S.selectedId;
    const picked = S.multi && S.picked.has(it.id);
    const img = hasImg(it);
    const cls = 'slot' + (it.fav ? ' fav' : '') + (sel ? ' selected' : '') + (img ? '' : ' noimg') + (picked ? ' picked' : '');
    const tile = img
      ? '<img src="' + esc(imgUrl(it, 'thumb')) + '" alt="" loading="lazy" decoding="async" draggable="false">'
      : I.svg('box', 32) + '<span class="slot-reddot"></span>';
    return '<button type="button" class="' + cls + '" data-id="' + esc(it.id) + '" tabindex="' + (it.id === rovingId ? 0 : -1) +
      '" aria-label="คัดลอกรหัส ' + esc(labelOf(it)) + '" title="' + esc((it.name || '') + (it.code ? ' · ' + it.code : '')) + '">' +
      '<span class="slot-tile">' + tile + '</span>' +
      (F.hasQualityIssue(it) ? '<span class="slot-badge-check" title="ต้องตรวจรูป">' + I.svg('warn', 10) + '</span>' : '') +
      (S.multi ? '<span class="slot-pick">' + (picked ? I.svg('check', 10) : '') + '</span>' : '') +
      (it.fav ? '<span class="slot-star">' + I.svg('star', 12) + '</span>' : '') +
      (g().showNames ? '<span class="slot-name">' + esc(labelOf(it)) + '</span>' : '') +
      '</button>';
  }

  function rowHtml(r, rovingId) {
    let h = '';
    for (let c = 0; c < S.cols; c++) {
      const i = r * S.cols + c;
      h += i < S.filtered.length ? slotHtml(S.filtered[i], rovingId) : '<div class="slot-filler" aria-hidden="true"></div>';
    }
    return h;
  }

  function measure() {
    const w = scroller.clientWidth - 16;
    const cols = Math.max(1, Math.floor((w + g().gap) / (g().slotW + g().gap)));
    const n = S.filtered.length;
    const dataRows = Math.ceil(n / cols);
    // pad with empty slots down to the bottom of the viewport (inventory look); none when empty
    const fillRows = n ? Math.max(dataRows, Math.floor((scroller.clientHeight - 16 + g().gap) / S.rowH)) : 0;
    const changed = cols !== S.cols || fillRows !== S.totalRows;
    S.cols = cols; S.totalRows = fillRows;
    sizer.style.height = Math.max(0, fillRows * S.rowH - (fillRows ? g().gap : 0)) + 'px';
    return changed;
  }

  function clearRows() { S.rowEls.forEach((el) => el.remove()); S.rowEls.clear(); }

  function renderRows() {
    const buf = g().bufferRows != null ? g().bufferRows : 3;
    const st = scroller.scrollTop; const vh = scroller.clientHeight;
    const first = Math.max(0, Math.floor((st - 8) / S.rowH) - buf);
    const last = Math.min(S.totalRows - 1, Math.ceil((st + vh) / S.rowH) + buf);
    const roving = rovingId();
    S.rowEls.forEach((el, r) => { if (r < first || r > last) { el.remove(); S.rowEls.delete(r); } });
    for (let r = first; r <= last; r++) {
      if (S.rowEls.has(r)) continue;
      const el = document.createElement('div');
      el.className = 'cat-row';
      el.style.top = r * S.rowH + 'px';
      el.style.height = g().slotH + 'px';
      el.style.gridTemplateColumns = 'repeat(' + S.cols + ', ' + g().slotW + 'px)';
      el.style.gap = g().gap + 'px';
      el.innerHTML = rowHtml(r, roving);
      rowsHost.appendChild(el);
      S.rowEls.set(r, el);
    }
  }

  let scrollRaf = 0;
  scroller.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; renderRows(); });
  }, { passive: true });

  new ResizeObserver(() => { if (S.cfg) { measure(); clearRows(); renderRows(); } }).observe(scroller);

  function rovingId() {
    if (S.selectedId && S.filtered.some((i) => i.id === S.selectedId)) return S.selectedId;
    return S.filtered.length ? S.filtered[0].id : null;
  }

  function slotEl(id) { return rowsHost.querySelector('[data-id="' + id + '"]'); }

  // Rewrite one slot in place (state change only; layout untouched).
  function refreshSlot(id) {
    const el = slotEl(id); const it = S.items.get(id);
    if (!el || !it) return;
    const hadFocus = el === document.activeElement;
    const tmp = document.createElement('div');
    tmp.innerHTML = slotHtml(it, rovingId());
    const fresh = tmp.firstChild;
    el.replaceWith(fresh);
    if (hadFocus) fresh.focus();
  }

  function scrollToIndex(i) {
    const r = Math.floor(i / S.cols);
    const top = 8 + r * S.rowH; const bottom = top + g().slotH;
    const st = scroller.scrollTop; const vh = scroller.clientHeight;
    if (top - 8 < st) scroller.scrollTop = Math.max(0, top - 8);
    else if (bottom + 8 > st + vh) scroller.scrollTop = bottom + 8 - vh;
  }

  // ------------------------------------------------------------------ refresh pipeline
  function refresh(opts) {
    opts = opts || {};
    renderTabs();
    computeFiltered();
    if (!S.filtered.some((i) => i.id === S.selectedId)) S.selectedId = S.filtered.length ? S.filtered[0].id : null;
    if (!opts.keepScroll) scroller.scrollTop = 0;
    measure();
    clearRows();
    renderRows();
    renderEmpty();
    $('count').textContent = S.filtered.length + '/' + itemsArr().length + ' ช่อง';
    renderCard();
    renderMultiBar();
  }

  function renderEmpty() {
    const el = $('emptyMsg');
    if (S.filtered.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = itemsArr().length
      ? '<span class="big">ไม่พบสินค้า</span><span>ลองพิมพ์คำอื่น หรือเปลี่ยนหมวดด้านบน</span>'
      : '<span class="big">กระเป๋ายังว่างอยู่</span><span>กด "เพิ่มสินค้า" เพื่อเริ่มใส่สินค้าชิ้นแรก</span>';
  }

  // ------------------------------------------------------------------ detail card
  function renderCard() {
    const card = $('card');
    const it = S.selectedId ? S.items.get(S.selectedId) : null;
    if (!it) { card.innerHTML = '<div class="card-empty">เลือกสินค้าจากตารางเพื่อดูรายละเอียด</div>'; return; }
    const img = hasImg(it);
    const q = it.image && it.image.quality;
    const src = !img ? 'ยังไม่มีรูป' : q === 'check' ? 'รูปควรตรวจ' : q === 'retake' ? 'รูปเล็กเกินไป ควรถ่ายใหม่' : 'รูปจากระบบตัดแต่ง';
    card.innerHTML =
      '<div class="card-rank' + (it.fav ? ' legendary' : '') + '">' + (it.fav ? 'LEGENDARY' : 'COMMON') + '</div>' +
      '<div class="card-img' + (img ? '' : ' noimg') + '">' +
      (img ? '<img src="' + esc(imgUrl(it, 'full')) + '" alt="' + esc(it.name) + '" draggable="false">' : I.svg('box', 64)) + '</div>' +
      '<div class="card-name">' + esc(it.name || '(ไม่มีชื่อ)') + '</div>' +
      '<div class="card-meta"><span>หมวด: ' + esc(it.cat) + '</span><span class="' + (img && q && q !== 'ok' || !img ? 'warn' : '') + '">รูป: ' + esc(src) + '</span>' +
      (it.barcodes && it.barcodes.length ? '<span>บาร์โค้ด: ' + esc(it.barcodes.join(', ')) + '</span>' : '') + '</div>' +
      '<div class="card-code-row"><div class="card-code" title="รหัสสินค้า">' + esc(it.code || '-') + '</div>' +
      '<button type="button" class="cat-btn" id="cardCopy" aria-label="คัดลอกรหัส"><span data-icon="copy" data-size="12"></span>คัดลอก</button></div>' +
      '<div class="card-actions">' +
      '<button type="button" class="cat-btn" id="cardImg"' + (readOnly() ? ' disabled title="ดูอย่างเดียว"' : '') + ' aria-label="' + (img ? 'ปรับรูปสินค้า' : 'เพิ่มรูปสินค้า') + '"><span data-icon="image" data-size="12"></span>' + (img ? 'ปรับรูป' : 'เพิ่มรูป') + '</button>' +
      (img ? '<button type="button" class="cat-btn" id="cardImgDel"' + (readOnly() ? ' disabled title="ดูอย่างเดียว"' : '') + ' aria-label="ลบรูปสินค้า"><span data-icon="trash" data-size="12"></span>ลบรูป</button>' : '') +
      '<button type="button" class="cat-btn" id="cardEdit"' + (readOnly() ? ' disabled title="ดูอย่างเดียว"' : '') + '><span data-icon="edit" data-size="12"></span>แก้ไข</button>' +
      '<button type="button" class="cat-btn" id="cardFav"' + (readOnly() ? ' disabled' : '') + ' aria-pressed="' + !!it.fav + '" aria-label="' + (it.fav ? 'เอาออกจากของโปรด' : 'ตั้งเป็นของโปรด') + '"><span data-icon="star" data-size="12"></span></button>' +
      '</div>';
    I.mount(card);
    const cimg = card.querySelector('.card-img img');
    if (cimg) cimg.addEventListener('error', () => { const box = cimg.parentElement; box.classList.add('noimg'); box.innerHTML = I.svg('box', 64); });
    $('cardCopy').onclick = () => copyValue(it, 'code');
    $('cardEdit').onclick = () => openEditDialog(it);
    $('cardImg').onclick = () => openEditorForItem(it);
    if ($('cardImgDel')) $('cardImgDel').onclick = () => confirmRemoveImage(it);
    $('cardFav').onclick = () => api.setFav([it.id], !it.fav);
  }

  // ------------------------------------------------------------------ selection / copy
  function select(id, opts) {
    opts = opts || {};
    const prev = S.selectedId;
    S.selectedId = id;
    if (prev && prev !== id) refreshSlot(prev);
    if (id) refreshSlot(id);
    // roving tabindex target may have changed
    renderCard();
    if (opts.scroll) { const i = S.filtered.findIndex((x) => x.id === id); if (i >= 0) scrollToIndex(i); }
    if (opts.scroll && id) { const el = slotEl(id); if (!el) { renderRows(); } }
  }

  function moveSel(dRow, dCol) {
    if (!S.filtered.length) return;
    let i = S.filtered.findIndex((x) => x.id === S.selectedId);
    if (i < 0) i = 0; else i = Math.max(0, Math.min(S.filtered.length - 1, i + dCol + dRow * S.cols));
    const onSlot = !!(document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('slot'));
    scrollToIndex(i);
    renderRows();
    select(S.filtered[i].id, { scroll: true });
    if (onSlot) { const el = slotEl(S.selectedId); if (el) el.focus(); }
  }

  let toastTimer = null;
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg; t.classList.toggle('error', !!isError); t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, S.cfg.copy.toastMs);
  }

  function flash(id) {
    if (!S.cfg.copy.flash || reducedMotion.matches) return;
    const el = slotEl(id); if (!el) return;
    el.classList.remove('copied'); void el.offsetWidth; el.classList.add('copied');
    el.querySelectorAll('.copied-badge').forEach((b) => b.remove());
    const b = document.createElement('span');
    b.className = 'copied-badge'; b.textContent = 'COPIED';
    el.appendChild(b);
    setTimeout(() => { b.remove(); }, 1100);
    setTimeout(() => { el.classList.remove('copied'); }, 700);
  }

  async function copyValue(it, kind) {
    const text = kind === 'barcode' ? (it.barcodes && it.barcodes[0]) : it.code;
    if (!text) {
      toast(kind === 'barcode' ? 'สินค้านี้ยังไม่มีบาร์โค้ด กดแก้ไขเพื่อเพิ่ม' : 'สินค้านี้ยังไม่มีรหัส กดแก้ไขเพื่อเพิ่ม', true);
      return;
    }
    try { await api.copyText(text); } catch (e) { toast('คัดลอกไม่สำเร็จ ลองอีกครั้ง', true); return; }
    flash(it.id);
    toast('คัดลอกแล้ว ' + text + ' · ไปวางใน Sea & Hill ได้เลย');
  }

  // Slot activation per config (spec §12.1 onSlotActivate).
  function activate(it) {
    if (S.multi) { togglePick(it.id); select(it.id); return; }
    select(it.id);
    const mode = S.cfg.copy.onSlotActivate;
    if (mode === 'select') return;
    copyValue(it, mode === 'copyBarcode' ? 'barcode' : 'code');
  }

  rowsHost.addEventListener('click', (e) => {
    const el = e.target.closest('.slot'); if (!el) return;
    const it = S.items.get(el.dataset.id); if (it) activate(it);
  });
  rowsHost.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('.slot'); if (!el) return;
    e.preventDefault();
    const it = S.items.get(el.dataset.id); if (!it) return;
    select(it.id);
    openEditDialog(it);
  });
  rowsHost.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    const slot = img.closest('.slot'); if (!slot) return;
    slot.classList.add('noimg');
    img.parentElement.innerHTML = I.svg('box', 32) + '<span class="slot-reddot"></span>';
  }, true);

  // ------------------------------------------------------------------ multi-select
  function togglePick(id) {
    if (S.picked.has(id)) S.picked.delete(id); else S.picked.add(id);
    refreshSlot(id); renderMultiBar();
  }
  function setMulti(on) {
    S.multi = on; S.picked.clear();
    $('btnMulti').setAttribute('aria-pressed', String(on));
    clearRows(); renderRows(); renderMultiBar();
  }
  function renderMultiBar() {
    $('multiActions').hidden = !S.multi;
    const n = S.picked.size;
    $('multiN').textContent = 'เลือก ' + n + ' ชิ้น';
    ['btnMoveCat', 'btnFavMulti', 'btnDelMulti'].forEach((id) => { $(id).disabled = n === 0 || readOnly(); });
  }

  // ------------------------------------------------------------------ dialogs
  function closeDialog() {
    if (!S.dialog || S.dialog.locked) return; // a running batch job keeps its dialog until it ends or is stopped
    const prev = S.dialog.prevFocus;
    if (S.dialog.cleanup) { try { S.dialog.cleanup(); } catch (e) { /* ignore */ } }
    S.dialog = null;
    const root = $('dlgRoot'); root.hidden = true; root.innerHTML = '';
    if (prev && document.contains(prev)) prev.focus(); else $('search').focus();
  }
  function showDialog(html, onMount, cls) {
    const root = $('dlgRoot');
    S.dialog = { prevFocus: document.activeElement };
    root.innerHTML = '<div class="cat-dlg' + (cls ? ' ' + cls : '') + '" role="dialog" aria-modal="true" aria-labelledby="dlgTitle">' + html + '</div>';
    root.hidden = false;
    I.mount(root);
    root.onmousedown = (e) => { if (e.target === root) closeDialog(); };
    root.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeDialog));
    if (onMount) onMount(root);
    const first = root.querySelector('[autofocus]') || root.querySelector('input,select,textarea,button');
    if (first) first.focus();
  }
  function trapTab(e) {
    const f = Array.from($('dlgRoot').querySelectorAll('input,select,textarea,button:not(:disabled)')).filter((x) => !x.hidden && x.offsetParent !== null);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  }

  function catOptions() { return S.meta.categories.map((c) => '<option value="' + esc(c) + '">').join(''); }

  function itemDialog(it) {
    if (!guardEdit()) return;
    const isNew = !it;
    const v = it || { name: '', shortName: '', code: '', cat: S.tab.startsWith('cat:') ? S.tab.slice(4) : 'ทั่วไป', barcodes: [] };
    showDialog(
      '<h2 id="dlgTitle">' + (isNew ? 'เพิ่มสินค้า' : 'แก้ไขสินค้า') + '</h2>' +
      '<form id="itemForm" novalidate style="display:contents">' +
      '<label class="cat-field">ชื่อสินค้า *<input name="name" value="' + esc(v.name) + '" autocomplete="off" autofocus><span class="err" id="errName"></span></label>' +
      '<label class="cat-field">ชื่อสั้นใต้ช่อง (ว่าง = ใช้ชื่อเต็ม)<input name="shortName" value="' + esc(v.shortName) + '" autocomplete="off"></label>' +
      '<label class="cat-field">รหัสสินค้า * (ตัวที่คัดลอกไปวาง)<input name="code" value="' + esc(v.code) + '" autocomplete="off" inputmode="text"><span class="err" id="errCode"></span><span class="hint" id="hintCode"></span></label>' +
      '<label class="cat-field">หมวด<input name="cat" list="catList" value="' + esc(v.cat) + '" autocomplete="off"><datalist id="catList">' + catOptions() + '</datalist></label>' +
      '<label class="cat-field">บาร์โค้ด (บรรทัดละ 1 อัน)<textarea name="barcodes">' + esc((v.barcodes || []).join('\n')) + '</textarea></label>' +
      imageFieldHtml() + tipsHtml(isNew || !hasImg(it)) +
      '<div class="cat-dlg-actions">' +
      (isNew ? '' : '<button type="button" class="cat-btn cat-btn-danger left" id="itemDelete"><span data-icon="trash" data-size="12"></span>ลบ</button>') +
      '<button type="button" class="cat-btn" data-close>ยกเลิก</button>' +
      '<button type="submit" class="cat-btn cat-btn-primary">บันทึก</button></div></form>',
      (root) => {
        const form = root.querySelector('#itemForm');
        const codeIn = form.elements.code;
        const imgCtl = mountImageField(root, form, it);
        const checkDup = () => {
          const q = F.normalize(codeIn.value); let dup = null;
          if (q) for (const [id, e] of S.idx) if (e.code === q && (!it || id !== it.id)) { dup = S.items.get(id); break; }
          root.querySelector('#hintCode').textContent = dup ? 'รหัสนี้ใช้กับ "' + labelOf(dup) + '" อยู่แล้ว (บันทึกซ้ำได้ถ้าตั้งใจ)' : '';
        };
        codeIn.addEventListener('input', checkDup); checkDup();
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const f = form.elements;
          const name = f.name.value.trim(); const code = f.code.value.trim();
          root.querySelector('#errName').textContent = name ? '' : 'กรอกชื่อสินค้า';
          root.querySelector('#errCode').textContent = code ? '' : 'กรอกรหัสสินค้า';
          if (!name || !code) { (name ? f.code : f.name).focus(); return; }
          const payload = {
            name, code, shortName: f.shortName.value.trim(), cat: f.cat.value.trim() || 'ทั่วไป',
            barcodes: f.barcodes.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
          };
          if (it) payload.id = it.id;
          try {
            const saved = await api.save(payload);
            if (!saved) throw new Error('save failed');
            upsert(saved);
            let imgFailed = false;
            if (imgCtl.pending()) {
              try {
                const p = imgCtl.pending();
                const withImg = unwrapSaved(await api.saveImage(saved.id, await PE.toPayload(p.res, { includeOrig: await needOrig(saved, p.res.hash) })));
                upsert(withImg);
              } catch (err) { console.warn('[catalog] saveImage failed', err); imgFailed = (err && err.userMessage) || true; }
            } else if (imgCtl.removing()) {
              try { upsert(unwrapSaved(await api.removeImage(saved.id), 'ลบรูปไม่สำเร็จ ลองอีกครั้ง')); } catch (err) { console.warn('[catalog] removeImage failed', err); imgFailed = (err && err.userMessage) || true; }
            }
            S.meta = (await api.getMeta()) || S.meta;
            closeDialog();
            if (isNew) { S.tab = 'all'; S.query = ''; S.qn = ''; $('search').value = ''; }
            S.selectedId = saved.id;
            refresh({ keepScroll: !isNew });
            if (isNew) { const i = S.filtered.findIndex((x) => x.id === saved.id); if (i >= 0) { scrollToIndex(i); renderRows(); } }
            if (imgFailed) toast('บันทึกสินค้าแล้ว แต่ยังไม่ได้ทำเรื่องรูป: ' + (typeof imgFailed === 'string' ? imgFailed : 'กด "ปรับรูป" เพื่อลองอีกครั้ง'), true); else toast('บันทึกแล้ว');
          } catch (err) {
            toast('บันทึกไม่สำเร็จ ลองอีกครั้ง', true);
          }
        });
        const del = root.querySelector('#itemDelete');
        if (del) del.addEventListener('click', () => confirmDelete([it.id]));
      },
      'wide'
    );
  }
  const openEditDialog = (it) => itemDialog(it);

  // saveImage / removeImage return the item or { error: <Thai message from main> }; turn that into a throw with a user-facing message.
  function userError(msg) { const e = new Error(msg); e.userMessage = msg; return e; }
  function unwrapSaved(r, fallback) {
    if (!r) throw userError(fallback || 'บันทึกรูปไม่สำเร็จ ลองอีกครั้ง');
    if (r.error) throw userError(r.error);
    return r;
  }
  // Always send the orig unless main confirms it already has this hash on disk (it may be missing, e.g. a synced item).
  async function needOrig(it, hash) {
    if (!(it && it.image && it.image.hash === hash)) return true;
    try { return !(await api.hasOrig(hash)); } catch (e) { return true; }
  }

  // ------------------------------------------------------------------ images (photo editor wiring)
  function tipsHtml(open) {
    return '<details class="cat-tips"' + (open ? ' open' : '') + '><summary>วิธีถ่ายรูปให้ได้ผลดี</summary><ul>' +
      '<li>วางบนพื้นเรียบสีเดียว เช่น กระดาษแข็งสีขาวหรือเทาอ่อน</li>' +
      '<li>แสงสว่าง ไม่ใช้แฟลช</li>' +
      '<li>ถ่ายตรงจากด้านหน้าหรือด้านบน</li>' +
      '<li>ให้สินค้าเต็มประมาณ 70% ของภาพ</li>' +
      '<li>อย่าให้สินค้าวางเอียงมาก</li></ul></details>';
  }
  function imageFieldHtml() {
    return '<div class="imgf" id="imgf"><div class="imgf-tile noimg" id="imgfTile"></div><div class="imgf-side">' +
      '<div class="imgf-state" id="imgfState" aria-live="polite"></div><div class="imgf-reasons" id="imgfReasons"></div>' +
      '<div class="imgf-btns"><button type="button" class="cat-btn cat-btn-sm" id="imgfPick"><span data-icon="camera" data-size="12"></span><span id="imgfPickText">เลือกรูป</span></button>' +
      '<button type="button" class="cat-btn cat-btn-sm" id="imgfEdit" aria-label="ปรับรูป"><span data-icon="image" data-size="12"></span>ปรับรูป</button>' +
      '<button type="button" class="cat-btn cat-btn-sm cat-btn-danger" id="imgfRemove" aria-label="ลบรูป"><span data-icon="trash" data-size="12"></span><span id="imgfRemoveText">ลบรูป</span></button></div>' +
      '<div class="imgf-hint">เลือกไฟล์ ลากรูปมาวางตรงนี้ หรือกด Ctrl+V เพื่อวางรูปจากคลิปบอร์ด ระบบจะตัดพื้นหลังและจัดลงช่องให้เอง</div></div></div>';
  }
  function pickImageFile() {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.addEventListener('change', () => resolve(inp.files && inp.files[0] || null));
      inp.addEventListener('cancel', () => resolve(null));
      inp.click();
    });
  }
  const isImageFile = (f) => !!f && (/^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name || ''));

  async function loadOrigSource(it) {
    let buf = null;
    try { buf = await api.readOrig(it.image.hash); } catch (e) { buf = null; }
    if (!buf) { toast('ไม่พบรูปต้นฉบับในเครื่องนี้ ต่ออินเทอร์เน็ตเพื่อโหลดจากคลาวด์ หรือเลือกรูปใหม่', true); return null; }
    return { blob: new Blob([buf], { type: 'image/jpeg' }), isOrig: true };
  }

  function confirmRemoveImage(it) {
    if (!guardEdit()) return;
    showDialog(
      '<h2 id="dlgTitle">ลบรูปสินค้า</h2><p>ลบรูปของ "' + esc(labelOf(it)) + '" ใช่ไหม สินค้ายังอยู่ แค่ไม่มีรูป (เพิ่มรูปใหม่ได้ทีหลัง)</p>' +
      '<div class="cat-conn-msg bad" id="rmErr" role="alert" hidden></div>' +
      '<div class="cat-dlg-actions"><button type="button" class="cat-btn" data-close>ยกเลิก</button>' +
      '<button type="button" class="cat-btn cat-btn-danger" id="rmGo">ลบรูป</button></div>',
      (root) => {
        root.querySelector('#rmGo').addEventListener('click', async () => {
          try {
            upsert(unwrapSaved(await api.removeImage(it.id), 'ลบรูปไม่สำเร็จ ลองอีกครั้ง'));
            closeDialog(); refresh({ keepScroll: true }); toast('ลบรูปแล้ว');
          } catch (e) { const m = root.querySelector('#rmErr'); m.textContent = e.userMessage || 'ลบรูปไม่สำเร็จ ลองอีกครั้ง'; m.hidden = false; }
        });
      }
    );
  }

  // "ปรับรูป" on the detail card: saves straight to the item.
  async function openEditorForItem(it) {
    if (!guardEdit()) return;
    let source; let edit = null;
    if (hasImg(it)) {
      source = await loadOrigSource(it);
      if (!source) return;
      edit = it.image.edit;
    } else {
      const file = await pickImageFile();
      if (!file) return;
      if (!isImageFile(file)) { toast('ไฟล์นี้ไม่ใช่รูป เลือกไฟล์ JPG หรือ PNG', true); return; }
      source = { blob: file, isOrig: false };
    }
    await PE.open({
      title: labelOf(it), source, edit, shortName: it.shortName || '', cfg: S.cfg.image,
      onDone: async (res, meta) => {
        const cur = S.items.get(it.id) || it; // refreshed: a retry must not use the stale item for includeOrig / shortName
        const payload = await PE.toPayload(res, { includeOrig: await needOrig(cur, res.hash) });
        let fin = unwrapSaved(await api.saveImage(it.id, payload));
        upsert(fin);
        if (meta.shortName !== (cur.shortName || '')) {
          try { fin = unwrapSaved(await api.save({ id: it.id, shortName: meta.shortName }), 'บันทึกชื่อสั้นไม่สำเร็จ'); upsert(fin); } catch (e) {
            // the image is already saved: close the editor instead of leaving the user to re-save the same image
            console.warn('[catalog] shortName save failed', e);
            refresh({ keepScroll: true });
            toast('บันทึกรูปแล้ว แต่ชื่อสั้นยังไม่ได้บันทึก กด "แก้ไข" เพื่อลองใหม่', true);
            return;
          }
        }
        refresh({ keepScroll: true });
        toast('บันทึกรูปแล้ว');
      }
    });
  }

  // Image field inside the add/edit dialog. The new image is only written when the dialog is saved.
  function mountImageField(root, form, it) {
    const q = (id) => root.querySelector(id);
    let pend = null; // { res, source, thumbUrl }
    let busy = false;
    let removed = false; // user chose "ลบรูป": applied when the dialog is saved
    function clearPend() { if (pend) { URL.revokeObjectURL(pend.thumbUrl); pend = null; } }
    function render() {
      const tile = q('#imgfTile'); const state = q('#imgfState'); const reasons = q('#imgfReasons');
      const existing = !!(it && hasImg(it)) && !removed;
      let quality = null; let text = 'ยังไม่มีรูป'; let codes = [];
      if (pend) {
        tile.classList.remove('noimg'); tile.innerHTML = '<img src="' + esc(pend.thumbUrl) + '" alt="รูปสินค้าใหม่">';
        quality = pend.res.quality; codes = pend.res.reasons || [];
        text = 'รูปใหม่ (บันทึกเมื่อกด "บันทึก") · ' + PE.qualityLabel(quality);
      } else if (existing) {
        tile.classList.remove('noimg'); tile.innerHTML = '<img src="' + esc(imgUrl(it, 'thumb')) + '" alt="รูปสินค้า">';
        quality = it.image.quality || null; text = 'รูปปัจจุบัน' + (quality ? ' · ' + PE.qualityLabel(quality) : '');
      } else { tile.classList.add('noimg'); tile.innerHTML = I.svg('box', 32); if (removed) text = 'จะลบรูปเมื่อกด "บันทึก"'; }
      if (busy) text = 'กำลังตัดแต่งรูป...';
      state.textContent = text; state.dataset.q = busy ? '' : (quality || '');
      reasons.innerHTML = codes.map((c) => '<div>' + esc(PE.reasonText(c)) + '</div>').join('');
      q('#imgfPickText').textContent = pend || existing ? 'เปลี่ยนรูป' : 'เลือกรูป';
      q('#imgfPick').disabled = busy; q('#imgfEdit').disabled = busy || !(pend || existing);
      const canRemove = !!(pend || existing || (removed && it && hasImg(it)));
      q('#imgfRemove').hidden = !canRemove; q('#imgfRemove').disabled = busy;
      q('#imgfRemoveText').textContent = removed && !pend ? 'ไม่ลบแล้ว' : pend ? 'ไม่ใช้รูปนี้' : 'ลบรูป';
    }
    async function loadFile(file) {
      if (busy) return;
      if (!isImageFile(file)) { toast('ไฟล์นี้ไม่ใช่รูป เลือกไฟล์ JPG หรือ PNG', true); return; }
      busy = true; render();
      try {
        const res = await PE.processFile(file, S.cfg.image);
        clearPend(); removed = false;
        pend = { res, source: { blob: res.orig, isOrig: true }, thumbUrl: URL.createObjectURL(res.thumb) };
        if (res.quality !== 'ok') toast(res.quality === 'retake' ? 'รูปเล็กเกินไป ถ่ายใหม่ใกล้ขึ้น หรือกด "ปรับรูป" เพื่อตรวจ' : 'ตัดแต่งแล้ว แต่ควรตรวจรูป กด "ปรับรูป" เพื่อแก้', true);
        else toast('ตัดแต่งรูปอัตโนมัติแล้ว กด "ปรับรูป" ถ้าอยากแก้ต่อ');
      } catch (e) {
        console.warn('[catalog] process failed', e);
        toast('เปิดรูปนี้ไม่ได้ ลองไฟล์ JPG หรือ PNG ไฟล์อื่น', true);
      } finally { busy = false; render(); }
    }
    async function editImage() {
      if (busy) return;
      let source; let edit;
      if (pend) { source = pend.source; edit = pend.res.edit; }
      else {
        source = await loadOrigSource(it);
        if (!source) return;
        edit = it.image.edit;
      }
      await PE.open({
        title: form.elements.name.value.trim() || (it && labelOf(it)) || '', source, edit, shortName: form.elements.shortName.value.trim(), cfg: S.cfg.image,
        onDone: async (res, meta) => {
          clearPend(); removed = false;
          pend = { res, source: { blob: res.orig, isOrig: true }, thumbUrl: URL.createObjectURL(res.thumb) };
          form.elements.shortName.value = meta.shortName;
          render();
        }
      });
    }
    q('#imgfPick').addEventListener('click', async () => { const f = await pickImageFile(); if (f) loadFile(f); });
    q('#imgfEdit').addEventListener('click', editImage);
    q('#imgfRemove').addEventListener('click', () => {
      if (busy) return;
      if (pend) clearPend(); // drop the new picture (the existing one, if any, stays)
      else removed = !removed;
      render();
    });
    const box = q('#imgf');
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
    box.addEventListener('dragleave', () => box.classList.remove('drag'));
    box.addEventListener('drop', (e) => {
      e.preventDefault(); box.classList.remove('drag');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
    const onPaste = (e) => {
      if (PE.isOpen() || !S.dialog) return;
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter(isImageFile);
      if (!files.length) return; // plain text pastes behave normally
      e.preventDefault(); loadFile(files[0]);
    };
    document.addEventListener('paste', onPaste);
    S.dialog.cleanup = () => { document.removeEventListener('paste', onPaste); clearPend(); };
    render();
    return { pending: () => pend, removing: () => removed && !pend };
  }

  function confirmDelete(ids) {
    if (!guardEdit()) return;
    const names = ids.slice(0, 3).map((id) => labelOf(S.items.get(id) || {})).join(', ');
    showDialog(
      '<h2 id="dlgTitle">ลบสินค้า</h2><p>ลบ ' + ids.length + ' รายการ' + (names ? ' (' + esc(names) + (ids.length > 3 ? ' ...' : '') + ')' : '') +
      ' ใช่ไหม? ลบแล้วจะไม่แสดงในกระเป๋าอีก</p>' +
      '<div class="cat-dlg-actions"><button type="button" class="cat-btn" data-close autofocus>ยกเลิก</button>' +
      '<button type="button" class="cat-btn cat-btn-danger" id="doDelete">ลบ</button></div>',
      (root) => {
        root.querySelector('#doDelete').addEventListener('click', async () => {
          try {
            await api.remove(ids);
            ids.forEach(drop);
            closeDialog(); S.picked.clear();
            refresh({ keepScroll: true });
            toast('ลบแล้ว ' + ids.length + ' รายการ');
          } catch (e) { toast('ลบไม่สำเร็จ ลองอีกครั้ง', true); }
        });
      }
    );
  }

  function moveCategoryDialog() {
    if (!guardEdit()) return;
    const ids = Array.from(S.picked);
    if (!ids.length) return;
    showDialog(
      '<h2 id="dlgTitle">ย้ายหมวด</h2><p>ย้าย ' + ids.length + ' รายการไปหมวด</p>' +
      '<label class="cat-field">ชื่อหมวด (เลือกที่มีอยู่ หรือพิมพ์ชื่อใหม่)<input id="moveCat" list="catList2" autocomplete="off" autofocus><datalist id="catList2">' + catOptions() + '</datalist></label>' +
      '<div class="cat-dlg-actions"><button type="button" class="cat-btn" data-close>ยกเลิก</button><button type="button" class="cat-btn cat-btn-primary" id="doMove">ย้าย</button></div>',
      (root) => {
        const go = async () => {
          const cat = root.querySelector('#moveCat').value.trim();
          if (!cat) { root.querySelector('#moveCat').focus(); return; }
          try {
            await api.moveCategory(ids, cat);
            closeDialog();
            toast('ย้าย ' + ids.length + ' รายการไปหมวด ' + cat + ' แล้ว');
            S.picked.clear();
          } catch (e) { toast('ย้ายหมวดไม่สำเร็จ ลองอีกครั้ง', true); }
        };
        root.querySelector('#doMove').addEventListener('click', go);
        root.querySelector('#moveCat').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      }
    );
  }

  // ---- settings (hotkey + click action)
  function accelFromEvent(e) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
    const named = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', ' ': 'Space' };
    let key;
    if (/^F\d{1,2}$/.test(e.key)) key = e.key;
    else if (named[e.key]) key = named[e.key];
    else if (e.key.length === 1) key = e.key.toUpperCase();
    else return null;
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl'); if (e.altKey) mods.push('Alt'); if (e.shiftKey) mods.push('Shift');
    // Ctrl/Alt is mandatory: a bare key (even F2) is grabbed system-wide and stolen from the POS program.
    if (!e.ctrlKey && !e.altKey) return { error: 'ต้องกด Ctrl หรือ Alt ร่วมด้วย ปุ่มเดี่ยวๆ อย่าง F2 จะไปแย่งปุ่มของโปรแกรมขาย' };
    return { accel: mods.concat(key).join('+') };
  }

  async function settingsDialog() {
    const hk = await api.getHotkey();
    let pending = null;
    const mode = S.cfg.copy.onSlotActivate;
    showDialog(
      '<h2 id="dlgTitle">ตั้งค่า</h2>' +
      '<label class="cat-field">ปุ่มลัดเปิด/ปิดกระเป๋า (คลิกช่องแล้วกดปุ่มที่ต้องการ ต้องมี Ctrl หรือ Alt เช่น Ctrl+Alt+B)<input id="hkInput" class="cat-hotkey-input" readonly value="' + esc(hk.disabled ? '' : hk.accelerator) + '" placeholder="ไม่ใช้ปุ่มลัด" aria-label="ปุ่มลัด"></label>' +
      '<span class="hint" id="hkMsg">' + (hk.disabled ? 'ตอนนี้ไม่ได้ใช้ปุ่มลัด เปิดกระเป๋าจากปุ่มกระเป๋าบนหน้าต่าง POS Hero' : hk.active ? '' : 'ปุ่ม ' + esc(hk.accelerator) + ' ใช้ไม่ได้ในตอนนี้ (อาจมีโปรแกรมอื่นใช้อยู่) เลือกปุ่มใหม่ได้เลย') + '</span>' +
      '<div class="cat-dlg-actions"><button type="button" class="cat-btn" id="hkOff"' + (hk.disabled ? ' disabled' : '') + '>ไม่ใช้ปุ่มลัด</button><button type="button" class="cat-btn" id="hkApply" disabled>ใช้ปุ่มนี้</button></div>' +
      '<label class="cat-field">เมื่อคลิกที่ช่องสินค้า<select id="actSel">' +
      [['copyCode', 'คัดลอกรหัสทันที'], ['select', 'เลือกอย่างเดียว (ไม่คัดลอก)'], ['copyBarcode', 'คัดลอกบาร์โค้ด']].map((o) => '<option value="' + o[0] + '"' + (o[0] === mode ? ' selected' : '') + '>' + o[1] + '</option>').join('') +
      '</select></label>' +
      '<div class="cat-dlg-actions"><button type="button" class="cat-btn cat-btn-primary" data-close>เสร็จ</button></div>',
      (root) => {
        const input = root.querySelector('#hkInput'); const msg = root.querySelector('#hkMsg'); const apply = root.querySelector('#hkApply');
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' || e.key === 'Tab') return;
          e.preventDefault(); e.stopPropagation();
          const r = accelFromEvent(e);
          if (!r) return;
          if (r.error) { msg.textContent = r.error; pending = null; apply.disabled = true; return; }
          pending = r.accel; input.value = r.accel; msg.textContent = ''; apply.disabled = false;
        });
        apply.addEventListener('click', async () => {
          if (!pending) return;
          const r = await api.setHotkey(pending);
          if (r.ok) { setHotkeyLabel(pending); updateHotkeyWarn({ active: true, accelerator: pending }); msg.textContent = 'ตั้งปุ่มลัดเป็น ' + pending + ' แล้ว'; apply.disabled = true; }
          else msg.textContent = r.error === 'in_use' ? 'ปุ่มนี้ถูกโปรแกรมอื่นใช้อยู่ ลองปุ่มอื่น' : r.error === 'needs_modifier' ? 'ต้องมี Ctrl หรือ Alt ร่วมด้วย ลองปุ่มอื่น' : 'ปุ่มนี้ใช้ไม่ได้ ลองปุ่มอื่น';
          if (r.ok) root.querySelector('#hkOff').disabled = false;
        });
        root.querySelector('#hkOff').addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          const r = await api.setHotkey('');
          if (r && r.ok) {
            pending = null; input.value = ''; apply.disabled = true; btn.disabled = true;
            setHotkeyLabel(''); updateHotkeyWarn({ active: false, disabled: true });
            msg.textContent = 'ปิดปุ่มลัดแล้ว เปิดกระเป๋าจากปุ่มกระเป๋าบนหน้าต่าง POS Hero';
          }
        });
        root.querySelector('#actSel').addEventListener('change', async (e) => {
          S.cfg = (await api.setConfig({ copy: { onSlotActivate: e.target.value } })) || S.cfg;
        });
      }
    );
  }


  // ------------------------------------------------------------------ sync status / read-only / Cloudflare settings
  const readOnly = () => !!(S.sync && S.sync.canEdit === false);
  const READONLY_MSG = 'เครื่องนี้ดูข้อมูลได้อย่างเดียว ใส่ write token ใน "ตั้งค่า Cloudflare" ถ้าต้องการแก้ไข';
  function guardEdit() {
    if (!readOnly()) return true;
    toast(READONLY_MSG, true);
    return false;
  }
  function fmtTime(ms) {
    if (!ms) return 'ยังไม่เคยซิงก์สำเร็จ';
    return new Date(ms).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function renderSync() {
    const s = S.sync; if (!s) return;
    const led = $('syncLed');
    led.dataset.state = s.state;
    let text, title;
    if (s.state === 'unconfigured') { text = 'ในเครื่อง'; title = 'ข้อมูลเก็บในเครื่องนี้ (ยังไม่ได้ตั้งค่า Cloudflare) คลิกเพื่อตั้งค่า'; }
    else if (s.state === 'confirm-target') { text = 'รอยืนยัน'; title = 'แคตตาล็อกบน Worker มีสินค้าอยู่แล้ว ' + (s.target ? s.target.itemCount : '') + ' ชิ้น คลิกเพื่อยืนยันการรวมข้อมูล'; }
    else if (s.state === 'ok') { text = 'ซิงก์แล้ว'; title = 'ซิงก์ล่าสุด ' + fmtTime(s.lastOkAt); }
    else if (s.state === 'pending') {
      text = s.writeBlocked ? 'token ไม่ถูกต้อง' : 'รอส่ง ' + s.pending;
      title = s.writeBlocked ? 'write token ไม่ถูกต้อง ค้างส่ง ' + s.pending + ' รายการ' : 'มีงานในคิว ' + s.pending + ' รายการ ซิงก์ล่าสุด ' + fmtTime(s.lastOkAt);
    } else if (s.state === 'offline') { text = 'ต่อไม่ได้' + (s.pending ? ' (' + s.pending + ')' : ''); title = 'ต่อ Worker ไม่ได้ ซิงก์สำเร็จล่าสุด ' + fmtTime(s.lastOkAt) + (s.pending ? ' · ค้างส่ง ' + s.pending + ' รายการ' : ''); }
    else { text = 'ดูอย่างเดียว'; title = 'เครื่องนี้ไม่มี write token แก้ไขไม่ได้ ซิงก์ล่าสุด ' + fmtTime(s.lastOkAt); }
    if (s.lastError && s.state !== 'ok') title += '\n' + s.lastError;
    $('syncText').textContent = text;
    led.title = title; led.setAttribute('aria-label', 'สถานะซิงก์: ' + text);
    $('syncWarn').hidden = !s.warn;
    const pc = s.problemCount || 0;
    $('syncProblems').hidden = !pc;
    if (pc) $('syncProblemsText').textContent = 'มี ' + pc + ' รายการที่ส่งขึ้น Worker ไม่สำเร็จ (สินค้ายังอยู่ในเครื่องนี้ครบ) กด "ดูรายละเอียด" เพื่อดูวิธีแก้';
    if (s.state === 'confirm-target' && !S.dialog && S.promptedTarget !== (s.target && s.target.itemCount) + ':' + s.lastOkAt) { S.promptedTarget = (s.target && s.target.itemCount) + ':' + s.lastOkAt; confirmTargetDialog(); }
    // edit controls follow read-only mode
    const ro = readOnly();
    $('btnAdd').disabled = ro; $('btnAdd').title = ro ? READONLY_MSG : '';
    renderMultiBar();
    if (S.lastCanEdit !== !ro) { S.lastCanEdit = !ro; if (S.cfg) renderCard(); }
  }
  function setSyncStatus(s) { S.sync = s; renderSync(); if (S.job) S.job.sync(); }

  function confirmTargetDialog() {
    const n = S.sync && S.sync.target ? S.sync.target.itemCount : 0;
    showDialog(
      '<h2 id="dlgTitle">รวมสินค้าเข้ากับแคตตาล็อกบน Cloudflare</h2>' +
      '<p>แคตตาล็อกนี้มีสินค้าอยู่แล้ว ' + n + ' ชิ้น จะรวมสินค้าในเครื่องเข้าไปไหม</p>' +
      '<p>ถ้ารวม สินค้าที่มีในเครื่องนี้จะถูกส่งขึ้นไปรวมกับของเดิม (ไม่ลบของใครทิ้ง ถ้าแก้ชิ้นเดียวกัน ฉบับที่แก้ล่าสุดจะชนะ) ถ้าไม่ใช่คีย์ที่ตั้งใจ ให้กด "ยังไม่รวม" แล้วตรวจ Worker URL กับ Catalog Key ใน "ตั้งค่า Cloudflare"</p>' +
      '<div class="cat-dlg-actions"><button type="button" class="cat-btn" id="tgNo" data-close>ยังไม่รวม</button>' +
      '<button type="button" class="cat-btn cat-btn-primary" id="tgYes">รวมสินค้าเข้าด้วยกัน</button></div>',
      (root) => {
        root.querySelector('#tgYes').addEventListener('click', async () => {
          const r = await api.confirmTarget();
          closeDialog();
          toast(r && r.ok ? 'กำลังรวมและซิงก์สินค้า' : 'ไม่มีรายการรอยืนยันแล้ว');
        });
      }
    );
  }

  function problemsDialog() {
    const list = (S.sync && S.sync.problems) || [];
    const items = list.map((p) => {
      const it = p.kind === 'item' ? S.items.get(p.id) : null;
      const label = p.kind === 'item' ? (it ? labelOf(it) + (it.code ? ' (' + it.code + ')' : '') : 'สินค้า ' + p.id) : 'รูปสินค้า ' + String(p.id).slice(0, 8);
      return '<li><b>' + esc(label) + '</b><br>' + esc(p.reason) + '</li>';
    }).join('');
    showDialog(
      '<h2 id="dlgTitle">รายการที่ส่งขึ้น Worker ไม่สำเร็จ</h2>' +
      '<p>ข้อมูลเหล่านี้ยังอยู่ในเครื่องนี้ครบ แต่เครื่องอื่นยังไม่เห็น</p><ul class="cat-problem-list">' + items + '</ul>' +
      ((S.sync && S.sync.problemCount > list.length) ? '<p>และอีก ' + (S.sync.problemCount - list.length) + ' รายการ</p>' : '') +
      '<div class="cat-dlg-actions"><button type="button" class="cat-btn" id="pbRetry">ลองส่งใหม่</button><button type="button" class="cat-btn cat-btn-primary" data-close>ปิด</button></div>',
      (root) => { root.querySelector('#pbRetry').addEventListener('click', () => { api.syncNow(); closeDialog(); toast('กำลังลองส่งใหม่'); }); }
    );
  }

  function randomKey(n) {
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    while (out.length < n) {
      const buf = new Uint8Array(n * 2); crypto.getRandomValues(buf);
      for (const b of buf) { if (b < 248 && out.length < n) out += abc[b % 62]; }
    }
    return out;
  }
  function suggestedWorkerUrl() {
    try {
      const c = JSON.parse(localStorage.getItem('inboxConfig') || '{}');
      const u = String((c && c.dbUrl) || '').trim().replace(/\/+$/, '');
      return /^https?:\/\/[^\s]+$/i.test(u) ? u : '';
    } catch (e) { return ''; }
  }

  async function cloudDialog() {
    S.cfg = (await api.getConfig()) || S.cfg;
    const w = S.cfg.worker || {};
    const suggested = !w.url ? suggestedWorkerUrl() : '';
    let hasToken = !!S.cfg.hasWriteToken;
    let lastTest = null;
    showDialog(
      '<h2 id="dlgTitle">ตั้งค่า Cloudflare</h2>' +
      '<p>ใช้ซิงก์กระเป๋าสินค้าระหว่างเครื่อง ทุกเครื่องของร้านใส่ Worker URL และ Catalog Key เดียวกัน เครื่องที่ใส่ write token ด้วยจึงจะแก้ไขได้ ที่เหลือดูได้อย่างเดียว</p>' +
      '<label class="cat-field">Worker URL (ใช้ค่าเดียวกับช่อง Database URL ของระบบรับเงินโอน)<input id="cfUrl" value="' + esc(w.url || suggested) + '" placeholder="https://pos-hero-inbox.xxxx.workers.dev" autocomplete="off" spellcheck="false" autofocus>' +
      '<span class="hint" id="cfUrlHint">' + (suggested ? 'ดึงค่ามาจากช่อง Database URL ของระบบรับเงินโอน (ยังไม่ได้บันทึก กด "บันทึก" เพื่อใช้)' : '') + '</span></label>' +
      '<label class="cat-field">Catalog Key (32-128 ตัว A-Z a-z 0-9 _ -)<span class="cat-field-row"><input id="cfKey" value="' + esc(w.key || '') + '" autocomplete="off" spellcheck="false" placeholder="กดสุ่มคีย์ใหม่ หรือวางคีย์จากเครื่องหลัก">' +
      '<button type="button" class="cat-btn" id="cfGen">สุ่มคีย์ใหม่</button><button type="button" class="cat-btn" id="cfCopy">คัดลอก</button></span>' +
      '<span class="hint">คัดลอกคีย์ไปวางในเครื่องอื่นเพื่อใช้กระเป๋าเดียวกัน</span></label>' +
      '<label class="cat-field">Write token (ตั้งเอง 16 ตัวขึ้นไป ใช้เหมือนกันทุกเครื่องที่แก้ไขได้)<input id="cfToken" type="password" autocomplete="new-password" spellcheck="false" placeholder="' + (hasToken ? 'ตั้งไว้แล้ว (ไม่แสดง) พิมพ์ใหม่เพื่อเปลี่ยน' : 'ว่าง = เครื่องนี้ดูอย่างเดียว') + '">' +
      '<span class="hint">เก็บไว้ในโปรแกรมเท่านั้น ไม่แสดงซ้ำ ถ้าพิมพ์ใหม่ ระบบจะบันทึกให้ตอนกดทดสอบหรือบันทึก</span></label>' +
      '<div class="cat-conn-msg" id="cfMsg" role="status" aria-live="polite"></div>' +
      '<div class="cat-dlg-actions">' +
      '<button type="button" class="cat-btn" id="cfTest">ทดสอบการเชื่อมต่อ</button>' +
      '<button type="button" class="cat-btn" id="cfInit" hidden>เริ่มใช้งานคีย์ใหม่</button>' +
      '<button type="button" class="cat-btn" data-close>ปิด</button>' +
      '<button type="button" class="cat-btn cat-btn-primary" id="cfSave">บันทึก</button></div>',
      (root) => {
        const q = (id) => root.querySelector(id);
        const msg = (t, kind) => { const m = q('#cfMsg'); m.textContent = t; m.className = 'cat-conn-msg' + (kind ? ' ' + kind : ''); };
        const vals = () => ({ url: q('#cfUrl').value.trim().replace(/\/+$/, ''), key: q('#cfKey').value.trim() });
        function validate(v) {
          if (!(/^https:\/\/[^\s/]+/i.test(v.url) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(v.url))) return 'Worker URL ไม่ถูกต้อง ต้องขึ้นต้นด้วย https:// (ใช้ http:// ได้เฉพาะ localhost) คัดลอกจากช่อง Database URL ของระบบรับเงินโอน';
          if (!/^[A-Za-z0-9_-]{32,128}$/.test(v.key)) return 'Catalog Key ต้องยาว 32-128 ตัว ใช้ A-Z a-z 0-9 _ - เท่านั้น กด "สุ่มคีย์ใหม่" หรือวางคีย์จากเครื่องหลัก';
          return null;
        }
        async function saveToken() {
          const t = q('#cfToken').value;
          if (!t) return true;
          const r = await api.setWriteToken(t);
          if (!r || !r.ok) { msg((r && r.message) || 'บันทึก write token ไม่สำเร็จ ลองใหม่', 'bad'); return false; }
          hasToken = !!r.hasWriteToken; q('#cfToken').value = '';
          q('#cfToken').placeholder = hasToken ? 'ตั้งไว้แล้ว (ไม่แสดง) พิมพ์ใหม่เพื่อเปลี่ยน' : 'ว่าง = เครื่องนี้ดูอย่างเดียว';
          return true;
        }
        async function saveAll() {
          const v = vals(); const bad = validate(v);
          if (bad) { msg(bad, 'bad'); return false; }
          S.cfg = (await api.setConfig({ worker: v })) || S.cfg;
          return saveToken();
        }
        q('#cfGen').addEventListener('click', () => {
          if (q('#cfKey').value.trim() && !window.confirm('เปลี่ยนคีย์จะแยกกระเป๋านี้ออกจากเครื่องอื่นที่ใช้คีย์เดิม แน่ใจหรือไม่')) return;
          q('#cfKey').value = randomKey(40); msg('สุ่มคีย์ใหม่แล้ว กด "คัดลอก" เพื่อนำไปใส่เครื่องอื่น แล้วกด "บันทึก"');
        });
        q('#cfCopy').addEventListener('click', async () => {
          const k = q('#cfKey').value.trim();
          if (!k) { msg('ยังไม่มีคีย์ให้คัดลอก กดสุ่มคีย์ใหม่ก่อน', 'bad'); return; }
          await api.copyText(k); msg('คัดลอก Catalog Key แล้ว', 'good');
        });
        q('#cfTest').addEventListener('click', async () => {
          const v = vals(); const bad = validate(v);
          if (bad) { msg(bad, 'bad'); return; }
          const btn = q('#cfTest'); btn.disabled = true; msg('กำลังทดสอบ...');
          try {
            if (!(await saveToken())) return;
            lastTest = await api.testConnection(v);
            msg(lastTest.message || (lastTest.ok ? 'เชื่อมต่อสำเร็จ' : 'เชื่อมต่อไม่สำเร็จ'), lastTest.ok && lastTest.tokenOk !== false ? 'good' : 'bad');
            q('#cfInit').hidden = !(lastTest.ok && lastTest.initialized === false);
          } catch (e) { msg('ทดสอบไม่สำเร็จ ลองอีกครั้ง', 'bad'); } finally { btn.disabled = false; }
        });
        q('#cfInit').addEventListener('click', async () => {
          const btn = q('#cfInit'); btn.disabled = true;
          try {
            if (!hasToken && !q('#cfToken').value) { msg('ใส่ write token ก่อน (ตั้งเองได้ 16 ตัวขึ้นไป) แล้วกด "เริ่มใช้งานคีย์ใหม่" อีกครั้ง', 'bad'); return; }
            if (!(await saveAll())) return;
            const r = await api.initWorker();
            msg(r.message || (r.ok ? 'เริ่มใช้งานคีย์แล้ว' : 'เริ่มใช้งานคีย์ไม่สำเร็จ'), r.ok ? 'good' : 'bad');
            if (r.ok) q('#cfInit').hidden = true;
          } catch (e) { msg('เริ่มใช้งานคีย์ไม่สำเร็จ ลองอีกครั้ง', 'bad'); } finally { btn.disabled = false; }
        });
        q('#cfSave').addEventListener('click', async () => {
          if (!(await saveAll())) return;
          S.cfg = (await api.getConfig()) || S.cfg;
          closeDialog();
          toast('บันทึกการตั้งค่า Cloudflare แล้ว กำลังซิงก์');
        });
      }
    );
  }

  function setHotkeyLabel(a) { $('hotkeyLabel').textContent = a || 'ไม่มี'; }
  function updateHotkeyWarn(hk) {
    $('hotkeyWarn').hidden = !!(hk.active || hk.disabled);
    if (!hk.active) $('hotkeyWarnText').textContent = 'ปุ่มลัด ' + hk.accelerator + ' ใช้ไม่ได้ (โปรแกรมอื่นใช้อยู่) เปิดกระเป๋าได้จากปุ่มบนหน้าต่างหลัก หรือเลือกปุ่มใหม่';
  }

  // ------------------------------------------------------------------ batch tools (Phase 5): legacy import, re-process all, backup
  const fmtN = (n) => Number(n || 0).toLocaleString('th-TH');
  const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const fmtDate = (ms) => new Date(ms).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
  const stat = (cls, label, n) => '<span class="' + cls + '" style="display:contents"><span>' + esc(label) + '</span><b>' + fmtN(n) + '</b></span>';
  const bindClose = (el) => el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeDialog));

  function syncLine() {
    const s = S.sync;
    if (!s || s.state === 'unconfigured') return 'ยังไม่ได้ตั้งค่า Cloudflare ข้อมูลเก็บในเครื่องนี้ก่อน';
    if (s.state === 'ok') return 'ซิงก์ขึ้น Cloudflare แล้ว';
    if (s.state === 'readonly') return 'เครื่องนี้ดูอย่างเดียว';
    return 'กำลังส่งขึ้น Cloudflare · รอส่ง ' + fmtN(s.pending) + ' รายการ';
  }

  // Progress widgets of a long job. While locked, Esc / click outside do not close the dialog.
  function jobHandle(root) {
    const q = (id) => root.querySelector(id);
    return {
      bar(done, total) { const b = q('#jobBar'); if (b) b.style.width = (total ? Math.min(100, (done / total) * 100) : 0) + '%'; },
      text(t) { const e = q('#jobText'); if (e) e.textContent = t; },
      sub(t) { const e = q('#jobSub'); if (e) e.textContent = t; },
      sync() { const e = q('#jobSync'); if (e) e.textContent = syncLine(); },
      lock(v) { if (S.dialog) S.dialog.locked = v; }
    };
  }
  const JOB_HTML = '<div class="cat-job-text" id="jobText" aria-live="polite"></div><div class="cat-bar" role="progressbar"><i id="jobBar"></i></div>' +
    '<div class="cat-job-sub" id="jobSub"></div><div class="cat-job-sub" id="jobSync"></div>';

  // processFile (OpenCV worker) -> saveImage for one source blob. existingHash = orig hash already stored for the item (orig bytes then not re-sent).
  async function processAndSave(itemId, blob, opts, existingHash) {
    const res = await PE.processFile(blob, S.cfg.image, opts);
    const payload = await PE.toPayload(res, { includeOrig: res.hash !== existingHash });
    const saved = unwrapSaved(await api.saveImage(itemId, payload));
    upsert(saved);
    return res.quality;
  }

  function goToCheckTab() { closeDialog(); S.tab = 'check'; S.query = ''; S.qn = ''; $('search').value = ''; refresh(); }

  // ---- import from the legacy Catalog Hero (spec 9)
  function importDialog() {
    if (!guardEdit()) return;
    let cands = [];
    let file = null;
    showDialog(
      '<h2 id="dlgTitle">นำเข้าจาก Catalog Hero (โปรแกรมเดิม)</h2><div id="impBody"><p>กำลังค้นหาไฟล์ข้อมูลเดิม...</p></div>',
      (root) => {
        const q = (id) => root.querySelector(id);
        const body = () => q('#impBody');
        let offProgress = null;
        S.dialog.cleanup = () => { if (offProgress) offProgress(); S.job = null; };

        function renderPick() {
          const list = cands.length
            ? '<div class="cat-filelist" role="radiogroup" aria-label="ไฟล์ข้อมูลเดิม">' + cands.map((c, i) =>
              '<label><input type="radio" name="legacyFile" value="' + i + '"' + (file === c.path ? ' checked' : '') + '><span>' + esc(c.path) + '<br>' +
              (c.source === 'shared' ? 'โฟลเดอร์แชร์' : c.source === 'appdata' ? 'ในเครื่องนี้' : 'ไฟล์ที่เลือก') + (c.size ? ' · ' + fmtSize(c.size) + ' · แก้ไขล่าสุด ' + esc(fmtDate(c.mtime)) : '') + '</span></label>').join('') + '</div>'
            : '<p>ไม่พบไฟล์ catalog-data.json ในโฟลเดอร์ปกติของ Catalog Hero กด "เลือกไฟล์..." เพื่อเลือกเอง</p>';
          body().innerHTML = '<p>นำเข้าสินค้า หมวด ของโปรด และรูป จากไฟล์ catalog-data.json ของโปรแกรม Catalog Hero เดิม ไฟล์เดิมจะไม่ถูกแก้ไขหรือลบ และนำเข้าซ้ำได้โดยไม่ซ้ำซ้อน</p>' +
            list + '<div id="impPrev"></div>' +
            '<div class="cat-dlg-actions"><button type="button" class="cat-btn left" id="impPick">เลือกไฟล์...</button>' +
            '<button type="button" class="cat-btn" data-close>ยกเลิก</button><button type="button" class="cat-btn cat-btn-primary" id="impGo" disabled>นำเข้า</button></div>';
          bindClose(body());
          body().querySelectorAll('input[name=legacyFile]').forEach((r) => r.addEventListener('change', () => choose(cands[+r.value].path)));
          q('#impPick').addEventListener('click', async () => {
            const f = await api.pickLegacyFile();
            if (!f) return;
            if (!cands.some((c) => c.path === f)) cands.unshift({ path: f, size: 0, mtime: 0, source: 'extra' });
            file = f; renderPick(); choose(f);
          });
          if (file) choose(file); else if (cands.length) { file = cands[0].path; renderPick(); }
        }

        async function choose(f) {
          file = f;
          if (!q('#impPrev')) return;
          q('#impGo').disabled = true;
          q('#impPrev').innerHTML = '<div class="cat-job-sub">กำลังตรวจไฟล์...</div>';
          const r = await api.previewLegacy(f);
          if (file !== f || !q('#impPrev')) return;
          if (!r.ok) { q('#impPrev').innerHTML = '<div class="cat-conn-msg bad">' + esc(r.error || 'อ่านไฟล์ไม่ได้') + '</div>'; return; }
          const w = r.warnings || {};
          q('#impPrev').innerHTML = '<div class="cat-stats" id="impCounts">' + stat('', 'สินค้า', r.counts.items) + stat('', 'มีรูป', r.counts.withImage) +
            stat('', 'หมวด', r.counts.categories) + stat('', 'ของโปรด', r.counts.favorites) +
            (w.invalid ? stat('bad', 'ข้าม (ไม่มีทั้งชื่อและรหัส)', w.invalid) : '') +
            (w.badImage ? stat('bad', 'รูปที่อ่านไม่ได้ (นำเข้าโดยไม่มีรูป)', w.badImage) : '') +
            (w.dupIds ? stat('', 'รหัสภายในซ้ำ (ใช้อันหลังสุด)', w.dupIds) : '') + '</div>' +
            (r.shopName ? '<div class="cat-job-sub">ชื่อร้าน: ' + esc(r.shopName) + '</div>' : '') +
            (r.hasAuth ? '<div class="cat-job-sub">พบรหัสล็อกการแก้ไขเดิม: เก็บไว้ในเครื่องนี้เท่านั้น ไม่ส่งขึ้น Cloudflare (ระบบล็อกยังไม่เปิดใช้ในเวอร์ชันนี้)</div>' : '');
          const go = q('#impGo');
          go.textContent = 'นำเข้า ' + fmtN(r.counts.items) + ' รายการ';
          go.disabled = !r.counts.items;
          go.onclick = () => startImport();
        }

        async function startImport() {
          let stop = false;
          body().innerHTML = JOB_HTML + '<div class="cat-dlg-actions"><button type="button" class="cat-btn cat-btn-danger" id="impStop">หยุด</button></div>';
          const job = jobHandle(root); job.lock(true);
          q('#impStop').addEventListener('click', () => { stop = true; q('#impStop').disabled = true; job.sub('กำลังหยุดหลังรูปปัจจุบัน...'); });
          job.text('กำลังนำเข้าข้อมูลสินค้า...'); job.sync();
          S.job = job;
          offProgress = api.onImportProgress((p) => { if (p.phase === 'text' || p.phase === 'text-done') { job.bar(p.done, p.total); job.sub(fmtN(p.done) + ' / ' + fmtN(p.total) + ' รายการ'); } });
          const imgs = { ok: 0, check: 0, retake: 0, failed: 0, left: 0 };
          let r = null;
          try {
            r = await api.importLegacy(file);
            if (!r || !r.ok) throw new Error((r && r.error) || 'นำเข้าไม่สำเร็จ');
            S.meta = (await api.getMeta()) || S.meta;
            const jobs = r.jobs || [];
            for (let i = 0; i < jobs.length; i++) {
              if (stop) { imgs.left = jobs.length - i; break; }
              const j = jobs[i];
              job.text('กำลังตัดแต่งรูป ' + fmtN(i + 1) + ' / ' + fmtN(jobs.length) + ' · ' + j.name);
              job.bar(i, jobs.length);
              job.sub(imgs.ok + ' ผ่าน · ' + imgs.check + ' ควรตรวจ · ' + imgs.retake + ' ควรถ่ายใหม่' + (imgs.failed ? ' · ' + imgs.failed + ' ล้มเหลว' : ''));
              try {
                const bytes = await api.readImportImage(j.file);
                if (!bytes) throw new Error('missing staged image');
                const quality = await processAndSave(j.itemId, new Blob([bytes], { type: j.mime || 'image/jpeg' }), {}, null);
                imgs[quality] = (imgs[quality] || 0) + 1;
              } catch (e) { console.warn('[catalog] import image failed', j.legacyId, e); imgs.failed++; }
            }
            job.bar(1, 1);
          } catch (e) {
            console.warn('[catalog] import failed', e);
            job.lock(false);
            body().innerHTML = '<div class="cat-conn-msg bad">' + esc(e.message || 'นำเข้าไม่สำเร็จ') + '</div><div class="cat-dlg-actions"><button type="button" class="cat-btn cat-btn-primary" data-close>ปิด</button></div>';
            bindClose(body());
            try { await api.finishImport(); } catch (_) { /* ignore */ }
            return;
          }
          try { await api.finishImport(); } catch (_) { /* ignore */ }
          job.lock(false);
          const s = r.summary; const w = r.warnings || {};
          body().innerHTML = '<div class="cat-job-text">นำเข้าเสร็จแล้ว</div><div class="cat-stats" id="impSummary">' +
            stat('ok', 'เพิ่มใหม่', s.added) + stat('', 'อัปเดต', s.updated) + stat('', 'ข้าม (ไม่เปลี่ยน/ว่าง/ลบไปแล้ว)', s.unchanged + s.skipped + s.skippedDeleted) +
            '<span class="sec">รูป</span>' + stat('ok', 'ผ่าน', imgs.ok) + stat('check', 'ควรตรวจ', imgs.check) + stat('retake', 'ควรถ่ายใหม่', imgs.retake) +
            (imgs.failed ? stat('bad', 'ล้มเหลว', imgs.failed) : '') + (imgs.left ? stat('bad', 'ยังไม่ได้ทำ (นำเข้าอีกครั้งเพื่อทำต่อ)', imgs.left) : '') +
            (w.badImage ? stat('bad', 'รูปเดิมที่อ่านไม่ได้', w.badImage) : '') + '</div>' +
            '<div class="cat-job-sub" id="jobSync">' + esc(syncLine()) + '</div>' +
            '<div class="cat-dlg-actions">' + (imgs.check + imgs.retake ? '<button type="button" class="cat-btn" id="impCheck">ไปที่แท็บ "ต้องตรวจรูป"</button>' : '') +
            '<button type="button" class="cat-btn cat-btn-primary" data-close>ปิด</button></div>';
          bindClose(body());
          const c = q('#impCheck'); if (c) c.addEventListener('click', goToCheckTab);
          S.tab = 'all'; refresh({ keepScroll: true });
        }

        (async () => {
          try { cands = (await api.findLegacy()) || []; } catch (e) { cands = []; }
          renderPick();
        })();
      },
      'wide'
    );
  }

  // ---- "จัดรูปทั้งหมด" (spec 8.6)
  function reprocessDialog() {
    if (!guardEdit()) return;
    const withImage = () => itemsArr().filter(hasImg);
    const unfinished = (it) => !it.image.edit || it.image.quality !== 'ok';
    if (!withImage().length) { toast('ยังไม่มีสินค้าที่มีรูปให้จัดใหม่', true); return; }
    showDialog(
      '<h2 id="dlgTitle">จัดรูปทั้งหมด</h2><div id="rpBody">' +
      '<p>ตัดแต่งรูปสินค้าใหม่ทั้งหมดจากรูปต้นฉบับ ด้วยขั้นตอนล่าสุดของระบบ (ค่าที่เคยปรับด้วยมือ เช่น แปรง หมุน ครอป ความสว่าง จะยังอยู่) ทำทีละรูป หยุดได้ทุกเมื่อ ระบบจะสำรองข้อมูลก่อนเริ่มเสมอ ย้อนกลับได้จากโฟลเดอร์ backups</p>' +
      '<label class="cat-check"><input type="checkbox" id="rpOnly"> เฉพาะรูปที่ยังไม่ผ่าน (ควรตรวจ/ควรถ่ายใหม่ หรือยังไม่มีค่าตัดแต่ง)</label>' +
      '<div class="cat-job-text" id="rpCount"></div>' +
      '<div class="cat-dlg-actions"><button type="button" class="cat-btn" data-close>ยกเลิก</button><button type="button" class="cat-btn cat-btn-primary" id="rpGo">เริ่มจัดรูป</button></div></div>',
      (root) => {
        const q = (id) => root.querySelector(id);
        S.dialog.cleanup = () => { S.job = null; };
        const pick = () => (q('#rpOnly').checked ? withImage().filter(unfinished) : withImage());
        const upd = () => { const n = pick().length; q('#rpCount').textContent = 'จะจัดใหม่ ' + fmtN(n) + ' รูป'; q('#rpGo').disabled = !n; };
        q('#rpOnly').addEventListener('change', upd); upd();
        q('#rpGo').addEventListener('click', async () => {
          const ids = pick().map((i) => i.id);
          if (!ids.length) return;
          const body = q('#rpBody');
          body.innerHTML = JOB_HTML;
          const job = jobHandle(root); job.lock(true);
          S.job = job;
          job.text('กำลังสำรองข้อมูล...');
          const bk = await api.backupNow('reprocess');
          if (!bk || !bk.ok) {
            job.lock(false);
            body.innerHTML = '<div class="cat-conn-msg bad">สำรองข้อมูลก่อนเริ่มไม่สำเร็จ จึงยังไม่จัดรูปให้ ' + esc((bk && bk.error) || '') + '</div><div class="cat-dlg-actions"><button type="button" class="cat-btn cat-btn-primary" data-close>ปิด</button></div>';
            bindClose(body);
            return;
          }
          let stop = false;
          body.insertAdjacentHTML('beforeend', '<div class="cat-dlg-actions"><button type="button" class="cat-btn cat-btn-danger" id="rpStop">หยุด</button></div>');
          q('#rpStop').addEventListener('click', () => { stop = true; q('#rpStop').disabled = true; job.sub('กำลังหยุดหลังรูปปัจจุบัน...'); });
          const cnt = { ok: 0, check: 0, retake: 0, failed: 0, noOrig: 0, left: 0 };
          for (let i = 0; i < ids.length; i++) {
            if (stop) { cnt.left = ids.length - i; break; }
            const it = S.items.get(ids[i]);
            if (!it || !hasImg(it)) continue;
            job.text('กำลังจัดรูป ' + fmtN(i + 1) + ' / ' + fmtN(ids.length) + ' · ' + labelOf(it));
            job.bar(i, ids.length);
            job.sub(cnt.ok + ' ผ่าน · ' + cnt.check + ' ควรตรวจ · ' + cnt.retake + ' ควรถ่ายใหม่' + (cnt.failed + cnt.noOrig ? ' · ' + (cnt.failed + cnt.noOrig) + ' ข้าม/ล้มเหลว' : ''));
            job.sync();
            try {
              const buf = await api.readOrig(it.image.hash);
              if (!buf) { cnt.noOrig++; continue; }
              const quality = await processAndSave(it.id, new Blob([buf], { type: 'image/jpeg' }), { isOrig: true, edit: it.image.edit || {} }, it.image.hash);
              cnt[quality] = (cnt[quality] || 0) + 1;
            } catch (e) { console.warn('[catalog] reprocess failed', it.id, e); cnt.failed++; }
          }
          job.bar(1, 1);
          job.lock(false);
          body.innerHTML = '<div class="cat-job-text">' + (cnt.left ? 'หยุดแล้ว' : 'จัดรูปเสร็จแล้ว') + '</div><div class="cat-stats" id="rpSummary">' +
            stat('ok', 'ผ่าน', cnt.ok) + stat('check', 'ควรตรวจ', cnt.check) + stat('retake', 'ควรถ่ายใหม่', cnt.retake) +
            (cnt.noOrig ? stat('bad', 'ไม่พบรูปต้นฉบับ (ข้าม)', cnt.noOrig) : '') + (cnt.failed ? stat('bad', 'ล้มเหลว', cnt.failed) : '') +
            (cnt.left ? stat('', 'ยังไม่ได้ทำ', cnt.left) : '') + '</div>' +
            '<div class="cat-job-sub">สำรองข้อมูลไว้ที่ backups/' + esc(bk.name || '') + '</div><div class="cat-job-sub" id="jobSync">' + esc(syncLine()) + '</div>' +
            '<div class="cat-dlg-actions">' + (cnt.check + cnt.retake ? '<button type="button" class="cat-btn" id="rpCheck">ไปที่แท็บ "ต้องตรวจรูป"</button>' : '') +
            '<button type="button" class="cat-btn cat-btn-primary" data-close>ปิด</button></div>';
          bindClose(body);
          const c = q('#rpCheck'); if (c) c.addEventListener('click', goToCheckTab);
          refresh({ keepScroll: true });
        });
      },
      'wide'
    );
  }

  // ---- backup (spec 7.2): a copy in backups/, optional export of the JSON to a chosen path
  function backupDialog() {
    showDialog(
      '<h2 id="dlgTitle">สำรองข้อมูล</h2>' +
      '<p>โปรแกรมสำรองข้อมูลสินค้าให้อัตโนมัติวันละครั้ง (เก็บ 14 วันล่าสุด) ในโฟลเดอร์ backups ของกระเป๋าสินค้า ถ้าอยากสำรองเดี๋ยวนี้ หรือเก็บสำเนาไว้ที่อื่น เลือกได้ด้านล่าง</p>' +
      '<div class="cat-conn-msg" id="bkMsg" role="status" aria-live="polite"></div>' +
      '<div class="cat-dlg-actions"><button type="button" class="cat-btn" id="bkNow">สำรองตอนนี้</button>' +
      '<button type="button" class="cat-btn" id="bkLocal">ส่งออก JSON (จากเครื่องนี้)...</button>' +
      '<button type="button" class="cat-btn" id="bkCloud">ส่งออก JSON (จาก Cloudflare)...</button>' +
      '<button type="button" class="cat-btn" id="bkRestore"' + (readOnly() ? ' disabled title="ดูอย่างเดียว"' : '') + '>กู้คืนจากไฟล์สำรอง...</button>' +
      '<button type="button" class="cat-btn cat-btn-primary" data-close>ปิด</button></div>',
      (root) => {
        const q = (id) => root.querySelector(id);
        const msg = (t, kind) => { const m = q('#bkMsg'); m.textContent = t; m.className = 'cat-conn-msg' + (kind ? ' ' + kind : ''); };
        q('#bkCloud').hidden = !(S.sync && S.sync.configured);
        q('#bkNow').addEventListener('click', async () => {
          const r = await api.backupNow('manual');
          if (r && r.ok) msg('สำรองแล้ว: backups/' + r.name, 'good'); else msg('สำรองไม่สำเร็จ ' + ((r && r.error) || ''), 'bad');
        });
        const exp = (source) => async () => {
          msg('กำลังส่งออก...');
          const r = await api.exportJson(source);
          if (r && r.ok) msg('ส่งออกแล้ว: ' + r.file, 'good');
          else if (r && r.canceled) msg('');
          else msg('ส่งออกไม่สำเร็จ ' + ((r && r.error) || ''), 'bad');
        };
        q('#bkRestore').addEventListener('click', async () => {
          msg('เลือกไฟล์สำรอง (db-....json จากโฟลเดอร์ backups)...');
          const r = await api.restoreBackup();
          if (r && r.ok) {
            msg('กู้คืนแล้ว ' + r.restored + ' รายการ (เพิ่มกลับ ' + (r.added + r.undeleted) + ' · แก้กลับ ' + r.updated + ')' + (r.backup ? ' · สำรองของเดิมไว้ที่ backups/' + r.backup : ''), 'good');
            loadAll().then(() => refresh({ keepScroll: true }));
          } else if (r && r.canceled) msg('');
          else msg('กู้คืนไม่สำเร็จ ' + ((r && r.error) || ''), 'bad');
        });
        q('#bkLocal').addEventListener('click', exp('local'));
        q('#bkCloud').addEventListener('click', exp('cloud'));
      }
    );
  }

  // ------------------------------------------------------------------ search + keyboard
  const search = $('search');
  search.addEventListener('input', () => {
    S.query = search.value; S.qn = F.normalize(S.query);
    refresh();
  });

  function enterFromSearch() {
    if (!S.filtered.length) { if (S.qn) toast('ไม่พบสินค้า', true); return; }
    const exact = S.qn && S.filtered.find((it) => F.isExactCodeOrBarcode(S.idx.get(it.id), S.qn));
    let target = null;
    if (exact) target = exact;
    else if (S.filtered.length === 1) { if (S.cfg.copy.enterCopiesSingleResult) target = S.filtered[0]; }
    else target = S.items.get(S.selectedId) || S.filtered[0];
    if (!target) return;
    select(target.id, { scroll: true });
    copyValue(target, 'code');
  }

  function isTextTarget(t) { return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'); }

  document.addEventListener('keydown', (e) => {
    if (PE.isOpen()) return; // the photo editor handles its own keys
    if (menuOpen()) { if (menuKey(e)) return; }
    if (S.dialog) {
      if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
      else if (e.key === 'Tab') trapTab(e);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (search.value) { search.value = ''; S.query = ''; S.qn = ''; refresh(); search.focus(); }
      else api.hide();
      return;
    }
    const inSearch = e.target === search;
    if (inSearch && e.key === 'Enter') { e.preventDefault(); enterFromSearch(); return; }
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[e.key] && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (isTextTarget(e.target) && !(inSearch && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || !search.value))) return;
      e.preventDefault();
      moveSel(arrows[e.key][0], arrows[e.key][1]);
      return;
    }
    // Typing (or a barcode scanner) while focus is elsewhere goes to the search box.
    if (!isTextTarget(e.target) && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.key !== ' ') {
      search.focus();
    }
  });

  // ------------------------------------------------------------------ chrome wiring
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.filter-tab'); if (!b) return;
    S.tab = b.dataset.tab; refresh();
  });
  $('btnAdd').addEventListener('click', () => itemDialog(null));
  $('btnMulti').addEventListener('click', () => setMulti(!S.multi));
  $('btnMoveCat').addEventListener('click', moveCategoryDialog);
  $('btnFavMulti').addEventListener('click', () => {
    const ids = Array.from(S.picked); if (!ids.length) return;
    const allFav = ids.every((id) => (S.items.get(id) || {}).fav);
    api.setFav(ids, !allFav);
  });
  $('btnDelMulti').addEventListener('click', () => { const ids = Array.from(S.picked); if (ids.length) confirmDelete(ids); });
  // "เมนู" dropdown for the rarely used skill-bar actions (keeps the bar on one line down to 640px).
  const menuPop = $('menuPop'), btnMenu = $('btnMenu');
  const menuItems = () => Array.from(menuPop.querySelectorAll('[role="menuitem"]'));
  function menuOpen() { return !menuPop.hidden; }
  function setMenu(open, focusFirst) {
    menuPop.hidden = !open; btnMenu.setAttribute('aria-expanded', String(open));
    if (open && focusFirst !== false) { const f = menuItems()[0]; if (f) f.focus(); }
  }
  // returns true when the key was consumed
  function menuKey(e) {
    const items = menuItems(), i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); setMenu(false); btnMenu.focus(); return true; }
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i <= 0 ? items.length : i) - 1].focus(); return true; }
    if (e.key === 'Home') { e.preventDefault(); items[0].focus(); return true; }
    if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); return true; }
    if (e.key === 'Tab') { setMenu(false, false); return false; }
    return false;
  }
  btnMenu.addEventListener('click', () => setMenu(!menuOpen()));
  btnMenu.addEventListener('keydown', (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setMenu(true); } });
  document.addEventListener('mousedown', (e) => { if (menuOpen() && !e.target.closest('.cat-menu-wrap')) setMenu(false, false); });
  const menuRun = (fn) => () => { setMenu(false, false); btnMenu.focus(); fn(); };
  $('btnSettings').addEventListener('click', menuRun(settingsDialog));
  $('btnCloud').addEventListener('click', menuRun(cloudDialog));
  $('btnImport').addEventListener('click', menuRun(importDialog));
  $('btnReprocess').addEventListener('click', menuRun(reprocessDialog));
  $('btnBackup').addEventListener('click', backupDialog);
  $('syncProblemsBtn').addEventListener('click', problemsDialog);
  $('syncLed').addEventListener('click', () => { if (S.sync && S.sync.state === 'confirm-target') confirmTargetDialog(); else cloudDialog(); });
  $('syncWarnBtn').addEventListener('click', cloudDialog);
  $('hotkeyWarnBtn').addEventListener('click', settingsDialog);
  $('btnHide').addEventListener('click', () => api.hide());
  $('btnClose').addEventListener('click', () => api.hide());
  $('btnPin').addEventListener('click', async () => setPinned(await api.togglePin()));
  function setPinned(v) { $('btnPin').classList.toggle('is-pinned', !!v); $('btnPin').setAttribute('aria-pressed', String(!!v)); }

  // A file dropped outside the image field must not navigate the window to the file.
  ['dragover', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { if (!e.target.closest || !e.target.closest('.imgf')) e.preventDefault(); }));

  api.onFocusSearch(() => {
    if (S.dialog || PE.isOpen()) return;
    search.focus(); search.select();
  });
  api.onChanged(onChanged);
  api.onSyncStatus(setSyncStatus);

  // ------------------------------------------------------------------ boot
  (async function boot() {
    try {
      S.cfg = await api.getConfig();
      applyGridVars();
      await loadAll();
      try { setSyncStatus(await api.getSyncStatus()); } catch (e) { /* sync status is optional */ }
      setPinned(await api.getPinState());
      const hk = await api.getHotkey();
      setHotkeyLabel(hk.accelerator); updateHotkeyWarn(hk);
      refresh();
      search.focus();
    } catch (e) {
      console.warn('[catalog] boot failed', e);
      toast('โหลดกระเป๋าสินค้าไม่สำเร็จ ลองปิดแล้วเปิดใหม่', true);
    }
  })();
})();
