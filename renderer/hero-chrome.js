(function () {
    function applyPinVisual(pinned) {
        var btn = document.getElementById('btnPin');
        if (!btn) return;
        btn.classList.toggle('is-pinned', !!pinned);
        btn.title = pinned ? 'กำลังลอยบนสุด (แตะเพื่อปลด)' : 'ไม่ได้ลอยบนสุด (แตะเพื่อปักหมุด)';
    }

    // ---------------------------------------------------------------
    // Feedback animations for "saved" (manual entry) vs. "money in"
    // (auto-detected via the phone-notification relay) — pure visual polish,
    // called from app.js's saveRecord / injectPaymentEvent / apply6040ToPOS.
    //
    // Declared before the mini-mode block below since that block also
    // relies on restartAnim (function declarations are hoisted, but
    // keeping the shared helper up top is easier to follow).
    // ---------------------------------------------------------------
    function restartAnim(el, cls) {
        if (!el) return;
        el.classList.remove(cls);
        void el.offsetWidth; // force reflow so the animation restarts
        el.classList.add(cls);
    }

    if (window.heroWindow) {
        window.heroWindow.getPinState().then(applyPinVisual).catch(function () {});
        window.heroWindow.onPinStateChanged(applyPinVisual);

        // -----------------------------------------------------------
        // Mini-mode transition — see renderer/theme-hero.css's
        // #modeShutter / .mode-anim rules and main.js's
        // enterMiniMode/exitMiniMode/commitEnterMini for the rest of
        // this sequence. Summary: entering mini animates the full UI
        // out + closes a full-viewport shutter *before* the native
        // window resize happens (Windows has no smooth-resize API, so
        // the resize itself is masked behind the closed shutter);
        // exiting mini resizes immediately (the target size is already
        // known) and then animates the full UI assembling back in.
        // -----------------------------------------------------------
        var reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        var modeCleanupTimer = null;

        function clearModeAnimClasses() {
            document.body.classList.remove('mode-anim', 'to-mini', 'to-full');
            var hud = document.getElementById('miniWidget');
            if (hud) hud.classList.remove('land', 'press');
        }

        if (window.heroWindow.onModeTransition) {
            window.heroWindow.onModeTransition(function (payload) {
                // Only "entering mini" has a pre-resize animation phase to wait
                // on — exiting resizes immediately (see onModeChanged below) and
                // never sends this event.
                if (!payload || payload.to !== 'mini') return;

                if (modeCleanupTimer) { clearTimeout(modeCleanupTimer); modeCleanupTimer = null; }
                clearModeAnimClasses();
                document.body.classList.add('mode-anim', 'to-mini');

                var acked = false;
                var ack = function () {
                    if (acked) return;
                    acked = true;
                    if (window.heroWindow.collapseReady) window.heroWindow.collapseReady();
                };
                var shutter = document.getElementById('modeShutter');
                if (reducedMotion || !shutter) {
                    // theme-hero.css's reduced-motion block kills every animation
                    // globally, so the shutter's animationend would never fire —
                    // ack on the next frame instead and let main.js's window
                    // actually just jump (no motion = an instant cut is correct).
                    requestAnimationFrame(ack);
                } else {
                    shutter.addEventListener('animationend', ack, { once: true });
                    // belt-and-braces: commit even if the animationend event is
                    // ever missed, rather than depending solely on main.js's own
                    // watchdog for every case.
                    setTimeout(ack, 280);
                }
            });
        }

        if (window.heroWindow.onModeChanged) {
            window.heroWindow.onModeChanged(function (mode) {
                var hud = document.getElementById('miniWidget');
                if (modeCleanupTimer) { clearTimeout(modeCleanupTimer); modeCleanupTimer = null; }

                if (mode === 'mini') {
                    document.body.classList.add('mini-mode');
                    // Timed off this event (the real resize commit) rather than a
                    // hardcoded CSS delay, so it lands correctly even if the
                    // watchdog/ack path took a little longer than the nominal 230ms.
                    if (hud) restartAnim(hud, 'land');
                    restartAnim(document.querySelector('.mini-coin'), 'bump');
                    modeCleanupTimer = setTimeout(clearModeAnimClasses, 190);
                } else {
                    document.body.classList.remove('mini-mode');
                    document.body.classList.add('mode-anim', 'to-full');
                    modeCleanupTimer = setTimeout(clearModeAnimClasses, 340);
                }
            });
        }

    }

    // Called on a genuine click (see the drag/click block below) instead of
    // calling heroWindow.exitMini() directly, so there's an instant tactile
    // response (press bump) even though the real IPC call — and the
    // resize it triggers — is deliberately deferred a beat behind it.
    // Declared unconditionally (unlike the block above) so it never throws
    // even if window.heroWindow somehow isn't there.
    var exitMiniPending = false;
    window.heroExitMini = function () {
        if (exitMiniPending) return;
        exitMiniPending = true;
        var hud = document.getElementById('miniWidget');
        restartAnim(hud, 'press');
        restartAnim(document.querySelector('.mini-coin'), 'bump');
        setTimeout(function () {
            exitMiniPending = false;
            if (window.heroWindow && window.heroWindow.exitMini) window.heroWindow.exitMini();
        }, 100);
    };

    // ---------------------------------------------------------------
    // Mini HUD: click-to-expand vs. drag-to-move, disambiguated with an
    // explicit pixel threshold instead of -webkit-app-region:drag — that
    // approach (v1.5.7's first attempt) swallowed real mouse clicks in
    // practice: a synthetic test click has zero pixel jitter and worked
    // fine under automated testing, but an actual human click always moves
    // the cursor a pixel or two, which Windows' own drag-region hit-testing
    // treated as "drag started" and ate the click entirely.
    //
    // Pointer capture (not plain mouse events) is used so drag tracking
    // survives the cursor outrunning this tiny, constantly-repositioning
    // window — plain mousemove/mouseup stop arriving the instant the
    // pointer leaves the window's current bounds. The actual window move
    // is computed in main.js from the OS cursor position directly (see
    // window:mini-drag-move), not from renderer event coordinates, for the
    // same reason.
    // ---------------------------------------------------------------
    (function () {
        var hud = document.getElementById('miniWidget');
        if (!hud) return;
        var DRAG_THRESHOLD = 4; // px — a real click always has some jitter; only treat it as a drag once movement clearly exceeds that
        var dragging = false;
        var dragMoved = false;
        var startX = 0, startY = 0;
        var rafPending = false;

        hud.addEventListener('pointerdown', function (e) {
            if (e.button !== 0) return;
            dragging = true;
            dragMoved = false;
            startX = e.screenX;
            startY = e.screenY;
            hud.setPointerCapture(e.pointerId);
        });

        hud.addEventListener('pointermove', function (e) {
            if (!dragging) return;
            if (!dragMoved) {
                if (Math.abs(e.screenX - startX) < DRAG_THRESHOLD && Math.abs(e.screenY - startY) < DRAG_THRESHOLD) return;
                dragMoved = true;
                hud.classList.add('dragging');
                if (window.heroWindow && window.heroWindow.dragMiniStart) window.heroWindow.dragMiniStart();
            }
            if (!rafPending) {
                rafPending = true;
                requestAnimationFrame(function () {
                    rafPending = false;
                    if (dragging && window.heroWindow && window.heroWindow.dragMiniMove) window.heroWindow.dragMiniMove();
                });
            }
        });

        function endDrag(e) {
            if (!dragging) return;
            dragging = false;
            hud.classList.remove('dragging');
            try { hud.releasePointerCapture(e.pointerId); } catch (err) {}
            if (dragMoved) {
                if (window.heroWindow && window.heroWindow.dragMiniEnd) window.heroWindow.dragMiniEnd();
            } else {
                heroExitMini();
            }
        }
        // Catalog button: keep its pointer events away from the HUD's
        // drag/click-to-expand handlers entirely.
        var bagBtn = document.getElementById('miniBagBtn');
        if (bagBtn) {
            ['pointerdown', 'pointerup', 'mousedown', 'mouseup'].forEach(function (t) {
                bagBtn.addEventListener(t, function (e) { e.stopPropagation(); });
            });
            bagBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                if (window.heroWindow && window.heroWindow.toggleCatalog) window.heroWindow.toggleCatalog();
            });
        }
        hud.addEventListener('pointerup', endDrag);
        hud.addEventListener('pointercancel', endDrag);
    })();

    function showCoinPop(amount, opts) {
        opts = opts || {};
        var amt = (parseFloat(amount) || 0).toLocaleString('en-US');
        var pop = document.createElement('div');
        pop.className = 'coin-pop' + (opts.moneyIn ? ' money-in' : '');
        pop.textContent = (opts.moneyIn ? '💰 +' : '✅ +') + amt + ' ฿' + (opts.moneyIn ? ' เงินเข้า!' : ' บันทึกแล้ว');
        document.body.appendChild(pop);
        var cleanup = function () { if (pop.parentNode) pop.parentNode.removeChild(pop); };
        pop.addEventListener('animationend', cleanup);
        setTimeout(cleanup, 2500);
    }

    function flashLatestRow() {
        var tbody = document.getElementById('tableBody');
        if (!tbody) return;
        var rows = tbody.querySelectorAll('tr');
        if (rows.length) restartAnim(rows[rows.length - 1], 'row-flash');
    }

    window.celebrateTransaction = function (amount, opts) {
        showCoinPop(amount, opts);
        restartAnim(document.getElementById('sumNet'), 'sum-pulse');
        restartAnim(document.querySelector('.mini-coin'), 'bump');
        restartAnim(document.getElementById('miniSumNet'), 'flash');
        flashLatestRow();
    };

    // ---------------------------------------------------------------
    // Theme picker — 5 palettes, persisted in localStorage, applied via
    // a data-theme attribute on <html> (see the head script in
    // index.html that applies it before first paint, and the
    // :root[data-theme="..."] blocks in theme-hero.css).
    // ---------------------------------------------------------------
    var DEFAULT_THEME = 'amber';

    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
    }

    function markActiveSwatch() {
        var active = currentTheme();
        document.querySelectorAll('.theme-swatch').forEach(function (el) {
            el.classList.toggle('active', el.getAttribute('data-theme') === active);
        });
    }

    window.openThemeModal = function () {
        markActiveSwatch();
        document.getElementById('themeModal').style.display = 'flex';
    };
    window.closeThemeModal = function () {
        document.getElementById('themeModal').style.display = 'none';
    };
    // ---------------------------------------------------------------
    // Receipt printing — bypasses the OS print pipeline entirely instead
    // of going through window.print()/webContents.print(). That pipeline
    // was a dead end for this printer: `pageSize`'s height either doesn't
    // match one of the EPSON TM-T82III driver's two registered roll
    // lengths (297mm/3276mm) — in which case the driver itself pads with
    // blank BEFORE the content to reach the nearest one — or it does match
    // one exactly, in which case Chromium faithfully rasterizes and sends
    // the *entire* requested page (mostly blank) since that's genuinely
    // how tall it was told the page is. Confirmed both failure modes by
    // capturing the literal bytes sent to the driver (redirected its port
    // to a file). Neither is fixable by tuning the requested page size —
    // the driver has no third, correctly-sized option.
    //
    // Instead: screenshot the actual rendered receipt element directly
    // (webContents.capturePage, sized to its real content — no page
    // concept involved at all), convert that bitmap to a 1-bit image in
    // main.js, and send it as a raw ESC/POS `GS v 0` raster command
    // straight to the printer via the Win32 WritePrinter API (through the
    // bundled build/raw-print.ps1 helper) — completely sidestepping
    // Windows' GDI page-size negotiation for this printer.
    //
    // The relevant #print*Area element is display:none on screen and its
    // @media print font sizes don't apply outside an actual print pass —
    // so it's temporarily made visible on-screen (not display:none'd
    // elsewhere; capturePage's rect just crops to it) with print-scale's
    // typography applied, screenshotted, then hidden again.
    // ---------------------------------------------------------------
    function currentPrintElement() {
        var body = document.body;
        return body.classList.contains('printing-drawer') ? document.getElementById('printDrawerArea')
            : body.classList.contains('printing-exchange') ? document.getElementById('printExchangeArea')
            : body.classList.contains('printing-recon') ? document.getElementById('printReconArea')
            : body.classList.contains('print-summary-only') ? document.getElementById('printSummaryArea')
            : document.querySelector('.paper');
    }

    // Must match main.js's RECEIPT_DOT_WIDTH (72mm printable width at 203dpi,
    // byte-aligned). CSS `zoom` (not `transform: scale`) renders the element
    // at this pixel density directly — Chromium re-lays-out and re-rasterizes
    // text/borders at the zoomed size, same as real browser zoom, instead of
    // just stretching an already-rasterized bitmap. That distinction matters
    // here: capturing at the unzoomed ~272px-wide native size and upscaling
    // the *bitmap* afterward (nativeImage.resize) blurred thin text strokes
    // into near-invisibility while thicker borders survived — confirmed by
    // decoding a real capture back into a PNG and comparing.
    var RECEIPT_DOT_WIDTH = 576;
    var CAPTURE_ZOOM = RECEIPT_DOT_WIDTH / (72 * 96 / 25.4);

    window.heroPrint = function () {
        if (!(window.heroWindow && window.heroWindow.rawPrint)) { window.print(); return; }

        var el = currentPrintElement();
        if (!el) { if (typeof clearPrintClasses === 'function') clearPrintClasses(); return; }

        document.body.classList.add('print-scale');
        var prevCssText = el.style.cssText;
        function placeAt(topPx) {
            el.style.cssText = prevCssText + '; display: block !important; position: fixed !important; ' +
                'left: 0 !important; top: ' + topPx + 'px !important; z-index: 2147483647 !important; background: #fff !important; ' +
                'width: 72mm !important; max-width: 72mm !important; height: auto !important; max-height: none !important;';
        }
        placeAt(0);

        function cleanup() {
            el.style.cssText = prevCssText;
            document.body.classList.remove('print-scale');
            if (typeof clearPrintClasses === 'function') clearPrintClasses();
        }
        function fail(reason) {
            cleanup();
            alert('⚠️ พิมพ์ไม่สำเร็จ: ' + (reason || 'ไม่ทราบสาเหตุ') + '\nตรวจสอบว่าเครื่องพิมพ์เปิดอยู่และเชื่อมต่อดีหรือไม่');
        }

        // Two rAFs plus a short fixed delay: rAFs alone guarantee a layout
        // pass has run with the styles above applied, but not that Chromium's
        // compositor has actually committed/presented that frame yet — a real
        // capture in testing intermittently still caught the pre-hide frame
        // (titlebar/buttons/filter tabs still visible) with just double-rAF.
        // Printing isn't latency-sensitive, so trade a few ms for reliability
        // rather than chase a tighter but flakier signal.
        function afterPaint(fn) {
            requestAnimationFrame(function () { requestAnimationFrame(function () { setTimeout(fn, 150); }); });
        }

        // capturePage จับได้แค่ส่วนที่อยู่ในหน้าต่าง — ใบเสร็จยาว (พิมพ์เต็มที่มีหลายสิบรายการ) จึงเลื่อนใบขึ้น
        // ทีละความสูงหน้าต่าง จับทีละช่วง แล้วให้ main.js ต่อภาพเป็นแผ่นเดียวก่อนส่งเครื่องพิมพ์
        afterPaint(function () {
            var rect = el.getBoundingClientRect();
            var total = Math.ceil(rect.height);
            var x = Math.round(rect.left), width = Math.round(rect.width);
            var step = Math.max(1, Math.floor(window.innerHeight));
            if (!window.heroWindow.printCaptureSlice || total <= step) {
                // ใบสั้นพอดีหน้าต่าง: จับครั้งเดียวแบบเดิม
                window.heroWindow.rawPrint({ x: x, y: Math.round(rect.top), width: width, height: total }).then(function (res) {
                    if (!res || !res.success) fail(res && res.reason); else cleanup();
                }).catch(function (err) { fail(err && err.message); });
                return;
            }
            var jobId = 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2);
            var offset = 0;
            (function next() {
                var h = Math.min(step, total - offset);
                window.heroWindow.printCaptureSlice(jobId, { x: x, y: 0, width: width, height: h }).then(function (res) {
                    if (!res || !res.success) { fail(res && res.reason); return; }
                    offset += h;
                    if (offset < total) {
                        placeAt(-offset);
                        afterPaint(next);
                        return;
                    }
                    window.heroWindow.rawPrint({ jobId: jobId }).then(function (res2) {
                        if (!res2 || !res2.success) fail(res2 && res2.reason); else cleanup();
                    }).catch(function (err) { fail(err && err.message); });
                }).catch(function (err) { fail(err && err.message); });
            })();
        });
    };

    // ---------------------------------------------------------------
    // Print font-size zoom — adjustable multiplier on top of the
    // baseline sizes in base.css's body.print-scale block (every rule
    // there is calc()'d against --print-zoom). Persisted so it's a
    // once-per-printer setting, not something re-tuned every receipt.
    // ---------------------------------------------------------------
    var PRINT_ZOOM_MIN = 0.7, PRINT_ZOOM_MAX = 1.6, PRINT_ZOOM_STEP = 0.1;

    function getPrintZoom() {
        var v = parseFloat(localStorage.getItem('printZoom'));
        return (v && v >= PRINT_ZOOM_MIN && v <= PRINT_ZOOM_MAX) ? v : 1;
    }

    function applyPrintZoom(zoom) {
        document.documentElement.style.setProperty('--print-zoom', zoom);
        var label = document.getElementById('printZoomValue');
        if (label) label.textContent = Math.round(zoom * 100) + '%';
    }

    window.adjustPrintZoom = function (delta) {
        // round() here kills float drift from repeated +/-0.1 steps (e.g. 1.2999999999999998)
        var next = Math.round((getPrintZoom() + delta) * 10) / 10;
        next = Math.min(PRINT_ZOOM_MAX, Math.max(PRINT_ZOOM_MIN, next));
        localStorage.setItem('printZoom', next);
        applyPrintZoom(next);
    };

    applyPrintZoom(getPrintZoom());

    // The native window's backgroundColor (set at BrowserWindow construction
    // in main.js) briefly shows through the newly-exposed region whenever the
    // window grows — most visibly right after exiting mini mode. Keep it
    // synced to whichever theme is actually active instead of leaving it
    // hardcoded to one palette's color.
    function pushBackgroundColor() {
        if (!window.heroWindow || !window.heroWindow.setBackgroundColor) return;
        var hex = getComputedStyle(document.documentElement).getPropertyValue('--hero-bg-1').trim();
        if (/^#[0-9a-fA-F]{6}$/.test(hex)) window.heroWindow.setBackgroundColor(hex);
    }
    pushBackgroundColor();

    window.selectTheme = function (name) {
        if (name === DEFAULT_THEME) {
            document.documentElement.removeAttribute('data-theme');
        } else {
            document.documentElement.setAttribute('data-theme', name);
        }
        try { localStorage.setItem('heroTheme', name); } catch (e) {}
        try { window.heroWindow && window.heroWindow.notifyTheme && window.heroWindow.notifyTheme(name); } catch (e) {}
        markActiveSwatch();
        pushBackgroundColor();
    };
})();
