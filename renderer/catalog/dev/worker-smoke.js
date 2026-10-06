/* Dev-only harness page script (excluded from the build). Spins up the real image worker under the catalog CSP. */
(function () {
  'use strict';
  function report(o) { console.log('SMOKE_RESULT:' + JSON.stringify(o)); }
  window.addEventListener('securitypolicyviolation', function (e) { console.log('SMOKE_CSP:' + e.violatedDirective + ' ' + e.blockedURI); });
  var c = document.getElementById('c'), g = c.getContext('2d');
  g.fillStyle = '#d0ccc0'; g.fillRect(0, 0, 800, 600);
  g.fillStyle = '#40a0e0'; g.fillRect(300, 120, 200, 380);
  c.toBlob(function (blob) {
    var w;
    try { w = new Worker('../image/image-worker.js'); } catch (e) { return report({ ok: false, stage: 'new Worker', error: String(e) }); }
    w.onerror = function (e) { report({ ok: false, stage: 'worker.onerror', error: e.message || String(e) }); };
    w.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'fatal') return report({ ok: false, stage: 'fatal', error: m.error });
      if (m.type === 'ready') return w.postMessage({ id: 1, type: 'process', sourceId: 'smoke', file: blob, cfg: {}, edit: {} });
      if (m.id === 1) {
        if (!m.ok) return report({ ok: false, stage: 'process', error: m.error });
        return report({ ok: true, quality: m.quality, reasons: m.reasons, w: m.w, h: m.h, hash: m.hash, thumbType: m.thumb.type, thumbSize: m.thumb.size, fullSize: m.full.size });
      }
    };
  }, 'image/png');
})();
