'use strict';
// Phase 6 visual walkthrough (screenshots + DOM assertions). Run:
//   HARNESS_SEED=60 HARNESS_FIXTURES=1 HARNESS_SHOT=<dir> HARNESS_STEPS=test/electron/catalog-harness/steps/walkthrough.js npm run harness:catalog
const fs = require('fs');
const path = require('path');

module.exports = async (h) => {
  const out = [];
  const note = (k, v) => { out.push(k + ': ' + JSON.stringify(v)); h.log(k, JSON.stringify(v)); };
  const set = (w, hgt) => { h.win.setMinimumSize(640, 520); h.win.setSize(w, hgt); };
  const pause = () => h.sleep(900);
  const click = (sel) => h.js(`document.querySelector(${JSON.stringify(sel)}).click()`);

  // real pipeline images on the first 6 items (quality badges); the rest keep seeded images
  const files = fs.readdirSync(h.fixturesDir).filter((f) => /\.jpe?g$/i.test(f)).sort().slice(0, 6);
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const b64 = fs.readFileSync(path.join(h.fixturesDir, files[i])).toString('base64');
    results.push(await h.js(`(async () => {
      const PE = window.CatalogPhotoEditor, api = window.catalogAPI, cfg = (await api.getConfig()).image;
      const list = (await api.list()).items.sort((a, b) => (a.id < b.id ? -1 : 1));
      const it = list[${i}];
      const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
      const res = await PE.processFile(new Blob([bin], { type: 'image/jpeg' }), cfg);
      const saved = await api.saveImage(it.id, await PE.toPayload(res, { includeOrig: true }));
      return { name: it.name, q: res.quality, err: saved && saved.error };
    })()`));
  }
  note('images', results);
  await h.sleep(1200);

  set(920, 752); await pause();
  await h.shot('01-main-920');
  note('skillbar@920', await h.js(`(() => { const b = document.querySelector('.cat-skillbar'); const r = b.getBoundingClientRect(); const kids = Array.from(b.children).filter((e) => !e.hidden && e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().top)); return { h: Math.round(r.height), tops: Array.from(new Set(kids)), w: innerWidth }; })()`));

  // menu
  await click('#btnMenu'); await pause();
  note('menu', await h.js(`({ expanded: document.getElementById('btnMenu').getAttribute('aria-expanded'), items: Array.from(document.querySelectorAll('#menuPop [role=menuitem]')).map((e) => e.textContent.trim()), focus: document.activeElement.id })`));
  await h.shot('02-menu-open');
  // keyboard: arrow down then Escape closes and returns focus to the button
  await h.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
  note('menu-arrow', await h.js(`document.activeElement.id`));
  await h.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  note('menu-esc', await h.js(`({ open: !document.getElementById('menuPop').hidden, focus: document.activeElement.id, winVisible: true })`));

  // settings dialog + hotkey
  await click('#btnMenu'); await click('#btnSettings'); await pause();
  note('hotkey-field', await h.js(`document.getElementById('hkInput').value`));
  await h.shot('03-settings');
  await h.js(`document.getElementById('hkInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }))`);
  await pause();
  note('bare-F2-msg', await h.js(`document.getElementById('hkMsg').textContent`));
  await h.shot('04-settings-bare-f2');
  await click('#hkOff'); await pause();
  note('after-off', await h.js(`({ msg: document.getElementById('hkMsg').textContent, label: document.getElementById('hotkeyLabel').textContent, input: document.getElementById('hkInput').value })`));
  await h.shot('05-settings-off');
  await click('[data-close]'); await pause();
  await h.shot('06-skillbar-label-none');

  // Cloudflare dialog
  await click('#btnMenu'); await click('#btnCloud'); await pause();
  await h.shot('07-cloudflare');
  await click('[data-close]'); await pause();

  // import dialog
  await click('#btnMenu'); await click('#btnImport'); await pause();
  await h.shot('08-import');
  await h.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await pause();

  // reprocess + backup dialogs
  await click('#btnMenu'); await click('#btnReprocess'); await pause();
  await h.shot('09-reprocess');
  await h.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await pause();
  await click('#btnBackup'); await pause();
  await h.shot('10-backup');
  await h.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await pause();

  // edit dialog with image (remove button) + card
  await h.js(`document.querySelector('.slot[data-id]') && document.querySelector('.slot[data-id]').click()`); await pause();
  await h.shot('11-card');
  await click('#cardEdit'); await pause();
  await h.shot('12-edit-dialog');
  await h.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await pause();

  // photo editor
  await click('#cardImg'); await h.sleep(2500);
  await h.shot('13-editor');
  note('editor-open', await h.js(`!!document.querySelector('.pe-root, .pe')`));
  await h.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await pause();

  // themes
  for (const t of ['amber', 'emerald', 'navy', 'ember', 'slate', 'pink', 'rainbow']) {
    h.win.webContents.send('catalog:theme', t); await h.sleep(700);
    note('theme-' + t, await h.js(`document.documentElement.getAttribute('data-theme')`));
    await h.shot('20-theme-' + t);
  }
  h.win.webContents.send('catalog:theme', 'amber');

  // min size 640x520
  set(640, 520); await h.sleep(800);
  note('min-size', h.win.getSize());
  await h.shot('30-min-640x520');
  note('skillbar@640', await h.js(`(() => { const b = document.querySelector('.cat-skillbar'); const kids = Array.from(b.children).filter((e) => !e.hidden && e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().top)); return { h: Math.round(b.getBoundingClientRect().height), tops: Array.from(new Set(kids)), w: innerWidth, overflowX: document.documentElement.scrollWidth > innerWidth }; })()`));
  await click('#btnMenu'); await pause();
  await h.shot('31-min-menu');
  await h.js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  fs.writeFileSync(path.join(h.dir, 'walkthrough.txt'), out.join('\n'));
};
