'use strict';
// Tabs/filters as a list (spec §12.1) + search normalization (spec §7.4).
// UMD: loaded as a classic script in the renderer (window.CatalogFilters) and
// require()-able from node tests without Electron.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CatalogFilters = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Thai mai taikhu, tone marks, thanthakhat, nikhahit, yamakkan: U+0E47..U+0E4E
  const THAI_MARKS = /[็-๎]/g;
  const ZERO_WIDTH = /[​-‍⁠﻿]/g;
  const LATIN_COMBINING = /[̀-ͯ]/g;

  // Case-insensitive, whitespace-insensitive, Thai-tone-insensitive, NFC.
  function normalize(s) {
    if (s == null) return '';
    return String(s)
      .normalize('NFD').replace(LATIN_COMBINING, '').normalize('NFC')
      .replace(/ํา/g, 'ำ') // nikhahit + sara aa == sara am; fix before stripping marks
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(ZERO_WIDTH, '')
      .replace(THAI_MARKS, '');
  }

  function buildIndexEntry(item) {
    const barcodes = (item.barcodes || []).map(normalize);
    const code = normalize(item.code);
    const name = normalize(item.name);
    const short = normalize(item.shortName);
    return {
      code,
      barcodes,
      // \u0001 separator: whitespace-free queries can't match across fields
      hay: [name, short, code].concat(barcodes).join('\u0001')
    };
  }

  function matchesQuery(entry, q) {
    return q === '' || entry.hay.indexOf(q) !== -1;
  }
  function isExactCodeOrBarcode(entry, q) {
    return q !== '' && (entry.code === q || entry.barcodes.indexOf(q) !== -1);
  }

  const hasQualityIssue = (i) => !!(i.image && i.image.quality && i.image.quality !== 'ok');

  // Fixed filters; category tabs are generated from meta.categories.
  const FILTERS = [
    { id: 'all', label: 'ทั้งหมด', match: () => true },
    { id: 'fav', label: 'ของโปรด', icon: 'star', cfgKey: 'showFavorites', match: (i) => !!i.fav },
    { id: 'noimage', label: 'ยังไม่มีรูป', alert: true, cfgKey: 'showNoImage', match: (i) => !i.image },
    { id: 'check', label: 'ต้องตรวจรูป', alert: true, cfgKey: 'showNeedsCheck', match: hasQualityIssue }
  ];

  // [{id,label,match,alert?,icon?}] in display order: all, categories..., fav, noimage, check
  function buildTabs(meta, tabsCfg) {
    tabsCfg = tabsCfg || {};
    const tabs = [FILTERS[0]];
    for (const c of (meta && meta.categories) || []) {
      tabs.push({ id: 'cat:' + c, label: c, match: (i) => i.cat === c });
    }
    for (const f of FILTERS.slice(1)) {
      if (f.cfgKey && tabsCfg[f.cfgKey] === false) continue;
      tabs.push(f);
    }
    return tabs;
  }

  // Which category tabs stay in the single row. items = [{id, w}] in display order (w = measured px width),
  // avail = px free for the category tabs, moreW = width of the "+N หมวด" button INCLUDING its gap, gap = px between tabs.
  // If everything fits there is no button. Otherwise greedy fit in the space left after the button; when the active
  // tab is hidden it takes the last visible slot (earlier ones are dropped until it fits). -> {visible:[ids], hidden:[ids]}
  function fitTabs(items, avail, moreW, gap, activeId) {
    const total = items.reduce((s, t, i) => s + t.w + (i ? gap : 0), 0);
    if (total <= avail) return { visible: items.map((t) => t.id), hidden: [] };
    const room = avail - moreW;
    let used = 0; const vis = [];
    for (const t of items) {
      const next = used + t.w + (vis.length ? gap : 0);
      if (next > room) break;
      vis.push(t); used = next;
    }
    const act = items.find((t) => t.id === activeId);
    if (act && !vis.includes(act)) {
      while (vis.length && vis.reduce((s, t, i) => s + t.w + (i ? gap : 0), 0) + act.w + (vis.length ? gap : 0) > room) vis.pop();
      if (!vis.length && act.w > room) return { visible: [], hidden: items.map((t) => t.id), activeHidden: true };
      vis.push(act);
    }
    const ids = new Set(vis.map((t) => t.id));
    return { visible: vis.map((t) => t.id), hidden: items.filter((t) => !ids.has(t.id)).map((t) => t.id) };
  }

  return { fitTabs, normalize, buildIndexEntry, matchesQuery, isExactCodeOrBarcode, hasQualityIssue, FILTERS, buildTabs };
});
