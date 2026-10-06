'use strict';
// "ปรับรูป" photo editor (spec 8.5) + the shared image Web Worker client.
//
//   CatalogPhotoEditor.processFile(blob, cfg)        -> auto pipeline result (worker `process`)
//   CatalogPhotoEditor.open({ title, source:{blob,isOrig}, edit, shortName, cfg, onDone })
//        onDone(result, { shortName }) may be async; it throws to keep the editor open (error shown).
//   CatalogPhotoEditor.toPayload(result, { includeOrig }) -> argument for catalogAPI.saveImage
//   CatalogPhotoEditor.isOpen(), reasonText(code), qualityLabel(q)
//
// Live preview: worker `preview` at analyze size, debounced + coalesced (one request in flight, the newest edit
// is sent when it returns). Crops are previewed on a 500px canvas whose inner 80% is the real tile (the frame), so
// the ring around the frame shows the product beyond the tile: edit crop (x,y,z) is sent as (x*K, y*K, z*K), K = 0.8.
(function () {
  const I = window.CatalogIcons;
  const STAGE = 500;              // editing stage / preview render size (px)
  const K = 0.8;                  // frame = inner K of the stage
  const FRAME = STAGE * K;        // 400
  const UNIT = FRAME / 512;       // stage px per crop unit (crop x/y are tile px at 512 reference)
  const ZMIN = 0.5, ZMAX = 4;
  const MINI = 104;
  const MAX_STROKES = 300, MAX_PTS = 4000; // same limits main's sanitizeEdit applies, so a saved edit always reproduces the image

  const REASONS = {
    too_small: 'รูปเล็กเกินไป ถ่ายใหม่ใกล้ขึ้น',
    mask_area_low: 'ตัดพื้นหลังแล้วเหลือสินค้าน้อยเกินไป ลองใช้แปรงเติมส่วนที่ขาด',
    mask_area_high: 'ตัดพื้นหลังได้กว้างเกินไป ลองใช้แปรงลบส่วนที่เกิน',
    touches_edges: 'สินค้าชิดขอบรูปหลายด้าน อาจถูกตัดแหว่ง ถ่ายให้เห็นทั้งชิ้น',
    mask_broken: 'ขอบสินค้าแหว่ง ระบบจึงไม่ลบพื้นหลังให้ ลองใช้แปรงเติมส่วนที่ขาด',
    dark: 'รูปมืดมาก ถ่ายใหม่ในที่สว่างขึ้น',
    tilt_too_large: 'สินค้าเอียงมากเกินกว่าจะตั้งตรงอัตโนมัติ ลองหมุนรูปเอง'
  };
  const QUALITY = { ok: 'รูปผ่าน', check: 'ควรตรวจรูป', retake: 'ควรถ่ายใหม่' };
  const reasonText = (c) => REASONS[c] || c;
  const qualityLabel = (q) => QUALITY[q] || q;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ------------------------------------------------------------------ worker client
  const W = (function () {
    let worker = null; let fatal = null; let seq = 0;
    const pending = new Map();
    function failAll(err) { pending.forEach((p) => p.rej(err)); pending.clear(); }
    function ensure() {
      if (worker) return;
      worker = new Worker('image/image-worker.js');
      worker.onmessage = (e) => {
        const m = e.data || {};
        if (m.type === 'ready') return;
        if (m.type === 'fatal') { fatal = m.error || 'worker failed'; failAll(new Error(fatal)); return; }
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.ok) p.res(m);
        else p.rej(Object.assign(new Error(m.error || 'cancelled'), { cancelled: !!m.cancelled }));
      };
      worker.onerror = (e) => { fatal = (e && e.message) || 'worker error'; failAll(new Error(fatal)); };
    }
    function call(msg, transfer) {
      ensure();
      if (fatal) return Promise.reject(new Error(fatal));
      const id = ++seq;
      return new Promise((res, rej) => { pending.set(id, { res, rej }); worker.postMessage(Object.assign({ id }, msg), transfer || []); });
    }
    return { call };
  })();

  let sourceSeq = 0;
  const newSourceId = () => 'src' + (++sourceSeq) + '-' + Date.now().toString(36);

  // Automatic pipeline (no UI). `source` is a Blob/File; isOrig when it is an already stored orig.
  async function processFile(blob, cfg, opts) {
    opts = opts || {};
    const sourceId = newSourceId();
    const res = await W.call({ type: 'process', sourceId, file: blob, isOrig: !!opts.isOrig, cfg: cfg || {}, edit: opts.edit || {} });
    res.sourceId = sourceId;
    return res;
  }

  async function blobBytes(b) { return b.arrayBuffer(); }
  // Argument for catalogAPI.saveImage(itemId, payload). Orig bytes are only sent when the hash is new to the item.
  async function toPayload(res, o) {
    o = o || {};
    const p = {
      thumb: await blobBytes(res.thumb), full: await blobBytes(res.full),
      hash: res.hash, edit: res.edit, quality: res.quality, w: res.w, h: res.h
    };
    if (o.includeOrig !== false) p.orig = await blobBytes(res.orig);
    return p;
  }

  // ------------------------------------------------------------------ editor
  let cur = null; // the open editor instance
  const isOpen = () => !!cur;

  function defaultEdit(cfg) {
    const c = cfg || {};
    return {
      pipelineVersion: 1,
      bgRemove: c.bgRemove !== false, autoStraighten: c.autoStraighten !== false,
      rotate: 0, brightness: 0, sharpen: Math.round((c.sharpenAmount != null ? c.sharpenAmount : 0.35) * 100),
      maskEdits: [], thumbCrop: { x: 0, y: 0, z: 1 }, fullCrop: { x: 0, y: 0, z: 1 }
    };
  }
  function mergeEdit(base, e) {
    const out = base;
    if (!e || typeof e !== 'object') return out;
    ['bgRemove', 'autoStraighten'].forEach((k) => { if (typeof e[k] === 'boolean') out[k] = e[k]; });
    ['rotate', 'brightness', 'sharpen'].forEach((k) => { if (Number.isFinite(+e[k])) out[k] = +e[k]; });
    if (Array.isArray(e.maskEdits)) out.maskEdits = clone(e.maskEdits);
    ['thumbCrop', 'fullCrop'].forEach((k) => {
      if (e[k] && typeof e[k] === 'object') out[k] = { x: +e[k].x || 0, y: +e[k].y || 0, z: +e[k].z > 0 ? +e[k].z : 1 };
    });
    return out;
  }
  function splitRotate(a) {
    a = (((a || 0) % 360) + 360) % 360; if (a > 180) a -= 360;
    const q = Math.round(a / 90);
    return { q, fine: a - q * 90 };
  }
  function joinRotate(q, fine) {
    let a = ((q * 90 + fine) % 360 + 360) % 360; if (a > 180) a -= 360;
    return Math.round(a * 10) / 10;
  }

  function open(opts) {
    if (cur) return cur.promise;
    const ed = createEditor(opts);
    cur = ed;
    ed.promise.finally(() => { if (cur === ed) cur = null; });
    return ed.promise;
  }

  function createEditor(o) {
    const cfg = o.cfg || {};
    const st = {
      sourceId: newSourceId(), blob: o.source.blob, isOrig: !!o.source.isOrig, sentData: false,
      edit: mergeEdit(defaultEdit(cfg), o.edit), mode: 'thumb', view: 'tile', brushMode: 'add', brushSize: 28,
      shortName: o.shortName || '', showOrig: false, busy: false, saving: false,
      res: null, analyzeMask: null, bmp: null, inflight: false, dirtyPreview: false, timer: 0, destroyed: false,
      rendered: { thumb: { x: 0, y: 0, z: 1 }, full: { x: 0, y: 0, z: 1 } }, stroke: null
    };
    const rot = splitRotate(st.edit.rotate);
    st.q = rot.q; st.fine = Math.max(-20, Math.min(20, rot.fine));
    st.edit.rotate = joinRotate(st.q, st.fine);
    const initial = JSON.stringify([st.edit, st.shortName]);
    const prevFocus = document.activeElement;
    const origUrl = URL.createObjectURL(st.blob);

    const root = document.createElement('div');
    root.className = 'pe-root';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'peTitle');
    const btn = (id, icon, label, extra) => '<button type="button" class="cat-btn cat-btn-sm" id="' + id + '" aria-label="' + esc(extra && extra.aria || label) + '"' + (extra && extra.title ? ' title="' + esc(extra.title) + '"' : '') + '>' + (icon ? '<span data-icon="' + icon + '" data-size="12"></span>' : '') + (label ? esc(label) : '') + '</button>';
    const tog = (id, label, on) => '<button type="button" class="pe-switch" id="' + id + '" role="switch" aria-checked="' + !!on + '"><span class="pe-sw-box" aria-hidden="true"></span>' + esc(label) + '</button>';
    const range = (id, label, min, max, step, val, unit) => '<label class="pe-range"><span class="pe-range-top"><span>' + esc(label) + '</span><output id="' + id + 'Out">' + val + (unit || '') + '</output></span><input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '"></label>';
    root.innerHTML =
      '<div class="pe-head"><h2 id="peTitle">ปรับรูป' + (o.title ? ' · ' + esc(o.title) : '') + '</h2>' +
      '<span class="pe-quality" id="peQuality" role="status"></span></div>' +
      '<div class="pe-body">' +
      '<div class="pe-left">' +
      '<div class="pe-modetabs" role="tablist" aria-label="เลือกกรอบรูป">' +
      '<button type="button" role="tab" class="filter-tab active" id="peTabThumb" data-mode="thumb" aria-selected="true">รูปในช่องตาราง</button>' +
      '<button type="button" role="tab" class="filter-tab" id="peTabFull" data-mode="full" aria-selected="false">รูปใหญ่ในการ์ด</button></div>' +
      '<div class="pe-stage" id="peStage" tabindex="0" aria-label="พื้นที่แก้รูป ลากเพื่อเลื่อน หมุนลูกกลิ้งเมาส์เพื่อซูม ลูกศรเลื่อนทีละนิด">' +
      '<canvas class="pe-canvas" id="peCanvas" width="' + STAGE + '" height="' + STAGE + '"></canvas>' +
      '<canvas class="pe-brushcv" id="peBrushCv" hidden></canvas>' +
      '<img class="pe-orig" id="peOrig" alt="รูปต้นฉบับ" hidden draggable="false">' +
      '<div class="pe-frame" id="peFrame" aria-hidden="true"></div>' +
      '<div class="pe-busy" id="peBusy" hidden>กำลังประมวลผล...</div>' +
      '<div class="pe-cursor" id="peCursor" hidden></div>' +
      '</div>' +
      '<div class="pe-hint" id="peHint">ลากเพื่อเลื่อนรูป · หมุนลูกกลิ้งเมาส์เพื่อซูม · กด Space ค้างเพื่อดูรูปก่อนแก้</div>' +
      '</div>' +
      '<div class="pe-right">' +
      '<div class="pe-minis">' +
      '<button type="button" class="pe-mini" data-mode="thumb" aria-label="ดูตัวอย่างรูปในช่องตาราง"><canvas width="' + MINI * 2 + '" height="' + MINI * 2 + '" id="peMiniThumb"></canvas><span>ในช่องตาราง</span></button>' +
      '<button type="button" class="pe-mini" data-mode="full" aria-label="ดูตัวอย่างรูปใหญ่ในการ์ด"><canvas width="' + MINI * 2 + '" height="' + MINI * 2 + '" id="peMiniFull"></canvas><span>ในการ์ด</span></button></div>' +
      '<div class="pe-reasons" id="peReasons" aria-live="polite"></div>' +
      '<label class="cat-field">ชื่อสั้นใต้ช่อง (แยกรุ่น/กลิ่น/ขนาดที่คล้ายกัน)<input id="peShort" value="' + esc(st.shortName) + '" autocomplete="off" maxlength="300"></label>' +
      '<div class="pe-group"><div class="pe-gtitle">ซูมและตำแหน่ง</div>' +
      range('peZoom', 'ซูม', ZMIN * 100, ZMAX * 100, 1, 100, '%') +
      '<div class="pe-row">' + btn('peFit', 'fit', 'พอดีทั้งชิ้น') + btn('peFocus', 'focus', 'เน้นฉลาก', { title: 'ซูม 2.4 เท่าที่กลางสินค้า แล้วลากปรับต่อ' }) + btn('peReset', 'reset', 'รีเซ็ต', { aria: 'รีเซ็ตการแก้ไขทั้งหมด' }) + '</div></div>' +
      '<div class="pe-group"><div class="pe-gtitle">หมุนรูป</div>' +
      '<div class="pe-row">' + btn('peRotL', 'rotl', '90°', { aria: 'หมุนทวนเข็มนาฬิกา 90 องศา' }) + btn('peRotR', 'rotr', '90°', { aria: 'หมุนตามเข็มนาฬิกา 90 องศา' }) + '</div>' +
      range('peFine', 'หมุนละเอียด', -20, 20, 0.5, st.fine, '°') + '</div>' +
      '<div class="pe-group"><div class="pe-gtitle">พื้นหลัง</div>' +
      tog('peBg', 'ลบพื้นหลัง', st.edit.bgRemove) + tog('peStraight', 'ตั้งตรงอัตโนมัติ', st.edit.autoStraighten) +
      '<div class="pe-row">' + btn('peBrushOn', 'brush', 'แปรงแก้ขอบ', { aria: 'เปิดโหมดแปรงแก้ขอบ' }) + '</div>' +
      '<div class="pe-brushtools" id="peBrushTools" hidden>' +
      '<div class="pe-row"><button type="button" class="cat-btn cat-btn-sm" id="peAdd" aria-pressed="true"><span data-icon="brush" data-size="12"></span>เติม</button>' +
      '<button type="button" class="cat-btn cat-btn-sm" id="peErase" aria-pressed="false"><span data-icon="eraser" data-size="12"></span>ลบ</button>' +
      btn('peUndo', 'undo', 'ย้อน', { aria: 'ย้อนเส้นแปรงล่าสุด' }) + btn('peClear', 'trash', 'ล้าง', { aria: 'ล้างเส้นแปรงทั้งหมด' }) + '</div>' +
      range('peBrushSize', 'ขนาดหัวแปรง', 6, 90, 1, st.brushSize, '') +
      '<div class="pe-note">ระบายสีเขียวคือ "ส่วนนี้เป็นสินค้า" สีแดงคือ "ส่วนนี้เป็นพื้นหลัง" ระบบจะตัดขอบใหม่ให้</div></div></div>' +
      '<div class="pe-group"><div class="pe-gtitle">แสงและความคม</div>' +
      range('peBright', 'ความสว่าง', -50, 50, 1, st.edit.brightness, '') + range('peSharp', 'ความคม', 0, 100, 1, st.edit.sharpen, '') + '</div>' +
      '<div class="pe-group"><button type="button" class="cat-btn cat-btn-wide" id="peCompare" aria-label="กดค้างเพื่อดูรูปก่อนแก้ (หรือกด Space ค้าง)"><span data-icon="eye" data-size="12"></span>กดค้างเพื่อดูรูปก่อนแก้</button></div>' +
      '</div></div>' +
      '<div class="pe-foot"><span class="pe-status" id="peStatus" role="status" aria-live="polite"></span>' +
      '<button type="button" class="cat-btn" id="peCancel">ยกเลิก</button>' +
      '<button type="button" class="cat-btn cat-btn-primary" id="peSave">บันทึกรูป</button></div>';
    const host = document.getElementById('app') || document.body;
    const tb = document.querySelector('.hero-titlebar'); // keep the draggable title bar (hide/close) usable
    if (tb) root.style.top = tb.offsetHeight + 'px';
    host.appendChild(root);
    I.mount(root);
    const $ = (id) => root.querySelector('#' + id);
    const stage = $('peStage'), canvas = $('peCanvas'), cx = canvas.getContext('2d');
    const brushCv = $('peBrushCv'), bx = brushCv.getContext('2d');
    const bufs = { thumb: document.createElement('canvas'), full: document.createElement('canvas') };
    bufs.thumb.width = bufs.thumb.height = bufs.full.width = bufs.full.height = STAGE;
    $('peOrig').src = origUrl;

    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });

    // ---- helpers
    const crop = () => st.edit[st.mode === 'thumb' ? 'thumbCrop' : 'fullCrop'];
    const uiScale = () => (stage.getBoundingClientRect().width || STAGE) / STAGE;
    const setStatus = (t, bad) => { const s = $('peStatus'); s.textContent = t || ''; s.classList.toggle('bad', !!bad); };
    const dirty = () => JSON.stringify([st.edit, st.shortName]) !== initial;

    function viewEdit() {
      const e = clone(st.edit);
      ['thumbCrop', 'fullCrop'].forEach((k) => { const c = e[k]; e[k] = { x: c.x * K, y: c.y * K, z: c.z * K }; });
      return e;
    }

    // ---- preview loop
    function schedule(delay) {
      if (st.destroyed) return;
      clearTimeout(st.timer);
      st.timer = setTimeout(pump, delay == null ? 60 : delay);
    }
    async function pump() {
      if (st.destroyed) return;
      if (st.inflight) { st.dirtyPreview = true; return; }
      st.inflight = true; st.dirtyPreview = false;
      $('peBusy').hidden = false;
      const sent = { thumb: clone(st.edit.thumbCrop), full: clone(st.edit.fullCrop) };
      const wantMask = st.view === 'brush';
      try {
        const msg = { type: 'preview', sourceId: st.sourceId, isOrig: st.isOrig, cfg, edit: viewEdit(), sizes: { thumb: STAGE, full: STAGE }, debug: wantMask };
        if (!st.sentData) msg.file = st.blob;
        let r;
        try { r = await W.call(msg); } catch (e) {
          if (!st.sentData || /unknown sourceId/.test(e.message)) { msg.file = st.blob; r = await W.call(msg); } else throw e;
        }
        st.sentData = true;
        if (st.destroyed) return;
        applyResult(r, sent, wantMask);
        setStatus('');
      } catch (e) {
        if (!e.cancelled && !st.destroyed) {
          console.warn('[catalog] preview failed', e);
          setStatus('แสดงตัวอย่างไม่สำเร็จ ลองปรับค่าอีกครั้ง หรือเลือกรูปใหม่', true);
        }
      } finally {
        st.inflight = false;
        if (!st.destroyed) {
          if (st.dirtyPreview) schedule(0); else $('peBusy').hidden = true;
        }
      }
    }
    function toCanvas(t, target) {
      target.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(t.buffer), t.width, t.height), 0, 0);
    }
    function applyResult(r, sent, wantMask) {
      st.res = r;
      toCanvas(r.thumb, bufs.thumb); toCanvas(r.full, bufs.full);
      st.rendered = sent;
      st.analyzeMask = wantMask && r.analyzeMask ? { w: r.analyzeMask.width, h: r.analyzeMask.height, data: new Uint8Array(r.analyzeMask.buffer) } : (wantMask ? null : st.analyzeMask);
      drawStage(); drawMinis(); renderQuality(); $('peBrushOn').disabled = false;
      if (st.view === 'brush') drawBrush();
    }

    // ---- drawing
    function drawStage() {
      cx.clearRect(0, 0, STAGE, STAGE);
      cx.drawImage(bufs[st.mode], 0, 0);
      applyTransform();
    }
    // Instant feedback while a newer preview is still computing: transform the last render to the current crop.
    function applyTransform() {
      const c = crop(), r = st.rendered[st.mode];
      const s = c.z / r.z, tx = (c.x - r.x) * UNIT, ty = (c.y - r.y) * UNIT;
      canvas.style.transformOrigin = (STAGE / 2 + r.x * UNIT) + 'px ' + (STAGE / 2 + r.y * UNIT) + 'px';
      canvas.style.transform = (Math.abs(s - 1) < 1e-6 && !tx && !ty) ? '' : 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
    }
    function drawMinis() {
      ['thumb', 'full'].forEach((m) => {
        const c = $(m === 'thumb' ? 'peMiniThumb' : 'peMiniFull'), g = c.getContext('2d');
        g.clearRect(0, 0, c.width, c.height);
        g.drawImage(bufs[m], STAGE * (1 - K) / 2, STAGE * (1 - K) / 2, FRAME, FRAME, 0, 0, c.width, c.height);
      });
    }
    function renderQuality() {
      const r = st.res; if (!r) return;
      const q = $('peQuality');
      q.textContent = qualityLabel(r.quality); q.dataset.q = r.quality;
      $('peReasons').innerHTML = r.reasons && r.reasons.length ? r.reasons.map((c) => '<div class="pe-reason ' + (c === 'too_small' ? 'retake' : '') + '">' + esc(reasonText(c)) + '</div>').join('') : '';
    }

    // ---- brush view (analyze space)
    function analyzeDims() { const i = st.res && st.res.info; return i && i.analyzeW ? { w: i.analyzeW, h: i.analyzeH } : null; }
    function brushScale() { const d = analyzeDims(); return d ? STAGE / Math.max(d.w, d.h) : 1; }
    function drawBrush() {
      const d = analyzeDims(); if (!d || !st.bmp) return;
      const s = brushScale(), W2 = Math.round(d.w * s), H2 = Math.round(d.h * s);
      if (brushCv.width !== W2 || brushCv.height !== H2) { brushCv.width = W2; brushCv.height = H2; }
      bx.setTransform(1, 0, 0, 1, 0, 0);
      bx.fillStyle = '#2a2a2a'; bx.fillRect(0, 0, W2, H2);
      // analyze image = source rotated by edit.rotate (90 multiples + fine), fitted to analyze size
      const bw = st.bmp.width, bh = st.bmp.height, odd = st.q % 2 !== 0;
      const sc = (odd ? W2 / bh : W2 / bw);
      bx.save();
      bx.translate(W2 / 2, H2 / 2); bx.rotate((st.q * 90 + st.fine) * Math.PI / 180);
      bx.imageSmoothingQuality = 'high';
      bx.drawImage(st.bmp, -bw * sc / 2, -bh * sc / 2, bw * sc, bh * sc);
      bx.restore();
      const m = st.analyzeMask;
      if (m && m.w === d.w && m.h === d.h) {
        const tmp = document.createElement('canvas'); tmp.width = m.w; tmp.height = m.h;
        const id = new ImageData(m.w, m.h);
        for (let i = 0, n = m.w * m.h; i < n; i++) if (m.data[i]) { id.data[i * 4] = 74; id.data[i * 4 + 1] = 222; id.data[i * 4 + 2] = 128; id.data[i * 4 + 3] = 85; }
        tmp.getContext('2d').putImageData(id, 0, 0);
        bx.imageSmoothingEnabled = false;
        bx.drawImage(tmp, 0, 0, W2, H2);
      }
      const strokes = st.edit.maskEdits.concat(st.stroke ? [st.stroke] : []);
      bx.lineCap = 'round'; bx.lineJoin = 'round';
      strokes.forEach((sk) => {
        bx.strokeStyle = sk.mode === 'add' ? 'rgba(34,197,94,0.55)' : 'rgba(239,68,68,0.55)';
        bx.fillStyle = bx.strokeStyle; bx.lineWidth = sk.r * 2 * s;
        bx.beginPath();
        sk.pts.forEach((p, i) => { if (i) bx.lineTo(p[0] * s, p[1] * s); else bx.moveTo(p[0] * s, p[1] * s); });
        if (sk.pts.length === 1) { bx.beginPath(); bx.arc(sk.pts[0][0] * s, sk.pts[0][1] * s, sk.r * s, 0, Math.PI * 2); bx.fill(); } else bx.stroke();
      });
    }
    function setView(v) {
      if (v === 'brush' && !(st.res && analyzeDims() && st.bmp)) return;
      st.view = v;
      const brush = v === 'brush';
      canvas.hidden = brush; brushCv.hidden = !brush; $('peFrame').hidden = brush; $('peBrushTools').hidden = !brush;
      $('peBrushOn').setAttribute('aria-pressed', String(brush));
      $('peBrushOn').lastChild.textContent = brush ? 'กลับไปดูรูปที่ตัดแล้ว' : 'แปรงแก้ขอบ';
      $('peHint').textContent = brush ? 'ระบายบนรูปเพื่อบอกว่าตรงไหนเป็นสินค้า (เติม) หรือพื้นหลัง (ลบ) แล้วรูปในช่องตัวอย่างจะอัปเดต' : 'ลากเพื่อเลื่อนรูป · หมุนลูกกลิ้งเมาส์เพื่อซูม · กด Space ค้างเพื่อดูรูปก่อนแก้';
      stage.classList.toggle('pe-brushing', brush);
      if (brush) { drawBrush(); schedule(0); } else { drawStage(); }
    }

    // ---- edit mutations
    function touch(delay, o2) {
      if (!(o2 && o2.noPreview)) schedule(delay);
      syncControls();
    }
    function syncControls() {
      const c = crop();
      $('peZoom').value = Math.round(c.z * 100); $('peZoomOut').textContent = Math.round(c.z * 100) + '%';
      $('peFine').value = st.fine; $('peFineOut').textContent = st.fine + '°';
      $('peBright').value = st.edit.brightness; $('peBrightOut').textContent = st.edit.brightness;
      $('peSharp').value = st.edit.sharpen; $('peSharpOut').textContent = st.edit.sharpen;
      $('peBg').setAttribute('aria-checked', String(st.edit.bgRemove));
      $('peStraight').setAttribute('aria-checked', String(st.edit.autoStraighten));
      $('peBrushSizeOut').textContent = st.brushSize;
      $('peAdd').setAttribute('aria-pressed', String(st.brushMode === 'add')); $('peErase').setAttribute('aria-pressed', String(st.brushMode === 'erase'));
      $('peUndo').disabled = $('peClear').disabled = !st.edit.maskEdits.length;
      root.querySelectorAll('[data-mode]').forEach((b) => {
        const on = b.dataset.mode === st.mode;
        b.classList.toggle('active', on);
        if (b.getAttribute('role') === 'tab') b.setAttribute('aria-selected', String(on)); else b.setAttribute('aria-pressed', String(on));
      });
    }
    function setMode(m) {
      st.mode = m;
      if (st.view === 'tile') drawStage();
      syncControls();
    }
    function setZoom(z) { const c = crop(); c.z = Math.round(clamp(z, ZMIN, ZMAX) * 1000) / 1000; applyTransform(); touch(); }
    function clearStrokes(why) {
      if (!st.edit.maskEdits.length) return;
      st.edit.maskEdits = [];
      setStatus(why || 'ล้างเส้นแปรงแล้ว', false);
    }
    function applyRotate() {
      st.edit.rotate = joinRotate(st.q, st.fine);
      clearStrokes('ล้างเส้นแปรงเพราะหมุนรูป (เส้นแปรงใช้กับมุมรูปเดิมเท่านั้น)');
      touch(st.view === 'brush' ? 0 : 120);
      if (st.view === 'brush') drawBrush();
    }

    // ---- events: stage pan / zoom / brush
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || st.showOrig) return;
      stage.focus({ preventScroll: true });
      stage.setPointerCapture(e.pointerId);
      if (st.view === 'brush') {
        if (st.edit.maskEdits.length >= MAX_STROKES) { setStatus('แปรงแก้ขอบครบ ' + MAX_STROKES + ' เส้นแล้ว กด "ย้อน" หรือ "ล้าง" ก่อนวาดเพิ่ม', true); return; }
        const p = brushPoint(e);
        st.stroke = { mode: st.brushMode, r: Math.round(st.brushSize / 2 / brushScale() * 10) / 10, pts: [p] };
        drawBrush();
      } else drag = { x: e.clientX, y: e.clientY };
      e.preventDefault();
    });
    stage.addEventListener('pointermove', (e) => {
      if (st.view === 'brush') {
        moveCursor(e);
        if (st.stroke) {
          const p = brushPoint(e), last = st.stroke.pts[st.stroke.pts.length - 1];
          if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= Math.max(1, st.stroke.r / 3) && st.stroke.pts.length < MAX_PTS) { st.stroke.pts.push(p); drawBrush(); }
          else if (st.stroke.pts.length >= MAX_PTS) setStatus('เส้นนี้ยาวเกินไป ปล่อยเมาส์แล้วเริ่มเส้นใหม่', true);
        }
        return;
      }
      if (!drag) return;
      const k = 1 / (uiScale() * UNIT), c = crop();
      c.x = Math.round(clamp(c.x + (e.clientX - drag.x) * k, -2000, 2000) * 10) / 10;
      c.y = Math.round(clamp(c.y + (e.clientY - drag.y) * k, -2000, 2000) * 10) / 10;
      drag.x = e.clientX; drag.y = e.clientY;
      applyTransform(); touch(40, { noPreview: false });
    });
    const endPointer = () => {
      drag = null;
      if (st.stroke) { st.edit.maskEdits.push(st.stroke); st.stroke = null; drawBrush(); touch(0); }
    };
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);
    stage.addEventListener('pointerleave', () => { $('peCursor').hidden = true; });
    stage.addEventListener('wheel', (e) => {
      if (st.view === 'brush') return;
      e.preventDefault();
      setZoom(crop().z * Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    function brushPoint(e) {
      const rc = brushCv.getBoundingClientRect(), s = brushScale();
      return [Math.round((e.clientX - rc.left) / rc.width * brushCv.width / s * 10) / 10, Math.round((e.clientY - rc.top) / rc.height * brushCv.height / s * 10) / 10];
    }
    function moveCursor(e) {
      const c = $('peCursor'), rc = stage.getBoundingClientRect(), d = st.brushSize * uiScale();
      c.hidden = false; c.style.width = c.style.height = d + 'px';
      c.style.left = (e.clientX - rc.left - d / 2) + 'px'; c.style.top = (e.clientY - rc.top - d / 2) + 'px';
      c.dataset.mode = st.brushMode;
    }
    stage.addEventListener('keydown', (e) => {
      if (st.view !== 'tile') return;
      const step = e.shiftKey ? 16 : 4, c = crop(); let hit = true;
      if (e.key === 'ArrowLeft') c.x -= step; else if (e.key === 'ArrowRight') c.x += step;
      else if (e.key === 'ArrowUp') c.y -= step; else if (e.key === 'ArrowDown') c.y += step;
      else if (e.key === '+' || e.key === '=') { setZoom(c.z * 1.1); e.preventDefault(); return; }
      else if (e.key === '-') { setZoom(c.z / 1.1); e.preventDefault(); return; }
      else hit = false;
      if (hit) { e.preventDefault(); applyTransform(); touch(40); }
    });

    // ---- events: controls
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    $('peZoom').addEventListener('input', (e) => setZoom(+e.target.value / 100));
    $('peFit').addEventListener('click', () => { const c = crop(); c.x = 0; c.y = 0; c.z = 1; applyTransform(); touch(0); });
    $('peFocus').addEventListener('click', () => { const c = crop(); c.x = 0; c.y = 0; c.z = 2.4; applyTransform(); touch(0); });
    $('peReset').addEventListener('click', () => {
      st.edit = defaultEdit(cfg); st.q = 0; st.fine = 0; st.shortName = o.shortName || ''; $('peShort').value = st.shortName;
      $('peBg').setAttribute('aria-checked', String(st.edit.bgRemove));
      applyTransform(); touch(0); if (st.view === 'brush') drawBrush();
      setStatus('รีเซ็ตการแก้ไขทั้งหมดแล้ว');
    });
    $('peRotL').addEventListener('click', () => { st.q = (st.q + 3) % 4; applyRotate(); });
    $('peRotR').addEventListener('click', () => { st.q = (st.q + 1) % 4; applyRotate(); });
    $('peFine').addEventListener('input', (e) => { st.fine = +e.target.value; applyRotate(); });
    $('peBg').addEventListener('click', () => { st.edit.bgRemove = !st.edit.bgRemove; touch(0); });
    $('peStraight').addEventListener('click', () => { st.edit.autoStraighten = !st.edit.autoStraighten; touch(0); });
    $('peBright').addEventListener('input', (e) => { st.edit.brightness = +e.target.value; touch(120); });
    $('peSharp').addEventListener('input', (e) => { st.edit.sharpen = +e.target.value; touch(120); });
    $('peShort').addEventListener('input', (e) => { st.shortName = e.target.value; });
    $('peBrushOn').addEventListener('click', () => {
      if (!st.edit.bgRemove) { st.edit.bgRemove = true; touch(0); }
      setView(st.view === 'brush' ? 'tile' : 'brush');
    });
    $('peBrushOn').disabled = true;
    $('peAdd').addEventListener('click', () => { st.brushMode = 'add'; syncControls(); });
    $('peErase').addEventListener('click', () => { st.brushMode = 'erase'; syncControls(); });
    $('peBrushSize').addEventListener('input', (e) => { st.brushSize = +e.target.value; syncControls(); });
    $('peUndo').addEventListener('click', () => { st.edit.maskEdits.pop(); drawBrush(); touch(0); });
    $('peClear').addEventListener('click', () => { st.edit.maskEdits = []; drawBrush(); touch(0); });

    // hold-to-compare
    function showOrig(on) {
      if (st.showOrig === on) return;
      st.showOrig = on;
      $('peOrig').hidden = !on;
      $('peCompare').setAttribute('aria-pressed', String(on));
    }
    const cmp = $('peCompare');
    cmp.addEventListener('pointerdown', (e) => { cmp.setPointerCapture(e.pointerId); showOrig(true); });
    cmp.addEventListener('pointerup', () => showOrig(false));
    cmp.addEventListener('pointercancel', () => showOrig(false));
    cmp.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); showOrig(true); } });
    cmp.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') showOrig(false); });

    // keyboard (document level so Space works anywhere inside the editor)
    function isTextTarget(t) { return t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type !== 'range')); }
    function onKeyDown(e) {
      if (st.destroyed) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return; }
      if (e.key === 'Tab') trap(e);
      if (e.key === ' ' && !isTextTarget(e.target) && e.target !== cmp && e.target.tagName !== 'BUTTON') { e.preventDefault(); showOrig(true); }
    }
    function onKeyUp(e) { if (e.key === ' ' && e.target !== cmp) showOrig(false); }
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    const onBlur = () => showOrig(false);
    window.addEventListener('blur', onBlur);
    function trap(e) {
      const f = Array.from(root.querySelectorAll('input,button:not(:disabled)')).filter((x) => !x.hidden && x.offsetParent !== null);
      f.push(stage); // stage is focusable too
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }

    // ---- close / save
    function destroy() {
      st.destroyed = true; clearTimeout(st.timer);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      URL.revokeObjectURL(origUrl);
      if (st.bmp && st.bmp.close) st.bmp.close();
      root.remove();
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus();
    }
    function cancel() {
      if (st.saving) return;
      if (dirty() && !window.confirm('ทิ้งการแก้ไขรูปที่ยังไม่ได้บันทึก ใช่ไหม?')) return;
      destroy(); resolve(null);
    }
    async function save() {
      if (st.saving) return;
      st.saving = true; $('peSave').disabled = true; $('peCancel').disabled = true;
      $('peBusy').hidden = false; $('peBusy').textContent = 'กำลังสร้างรูปขนาดจริง...'; setStatus('');
      try {
        clearTimeout(st.timer);
        const msg = { type: 'process', sourceId: st.sourceId, isOrig: st.isOrig, cfg, edit: clone(st.edit) };
        if (!st.sentData) msg.file = st.blob;
        let res;
        try { res = await W.call(msg); } catch (e) {
          if (/unknown sourceId/.test(e.message)) { msg.file = st.blob; res = await W.call(msg); } else throw e;
        }
        await o.onDone(res, { shortName: st.shortName.trim() });
        destroy(); resolve(res);
      } catch (e) {
        console.warn('[catalog] editor save failed', e);
        setStatus(e && e.userMessage ? e.userMessage : 'บันทึกรูปไม่สำเร็จ ลองอีกครั้ง' + (e && e.message && !/Error invoking/.test(e.message) ? ' (' + e.message + ')' : ''), true);
        st.saving = false; $('peSave').disabled = false; $('peCancel').disabled = false;
        $('peBusy').hidden = true; $('peBusy').textContent = 'กำลังประมวลผล...';
      }
    }
    $('peCancel').addEventListener('click', cancel);
    $('peSave').addEventListener('click', save);

    // ---- start
    syncControls(); applyTransform();
    createImageBitmap(st.blob, { imageOrientation: 'from-image' }).then((b) => { if (st.destroyed) { b.close(); return; } st.bmp = b; }).catch(() => { /* brush view unavailable */ });
    setStatus('กำลังเตรียมรูป...');
    schedule(0);
    stage.focus({ preventScroll: true });

    return { promise, root, state: st };
  }

  window.CatalogPhotoEditor = { processFile, open, isOpen, toPayload, reasonText, qualityLabel, _W: W };
})();
