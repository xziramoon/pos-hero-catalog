'use strict';
// ตรรกะคูปองส่วนลดรายสินค้า (ไม่พึ่ง Electron — ทดสอบด้วย node ได้)
// กฎ = { itemId, name, minQty, kind: 'baht'|'percent', value } ; ตะกร้า = สินค้าที่แคชเชียร์ยิงไว้ของบิลถัดไป

const MAX_RULES = 200;

function normalizeRules(raw) {
  if (!Array.isArray(raw)) return [];
  const byItem = new Map();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const itemId = String(r.itemId == null ? '' : r.itemId).trim();
    if (!itemId) continue;
    const kind = r.kind === 'percent' ? 'percent' : 'baht';
    const value = Number(r.value);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (kind === 'percent' && value > 100) continue;
    if (kind === 'baht' && value > 100000) continue;
    const minQty = Math.min(99, Math.max(1, Math.floor(Number(r.minQty)) || 1));
    const name = String(r.name == null ? '' : r.name).trim().slice(0, 80) || itemId;
    byItem.set(itemId, { itemId, name, minQty, kind, value: Math.round(value * 100) / 100 });
  }
  return [...byItem.values()].slice(0, MAX_RULES);
}

function rewardText(rule) {
  return rule.kind === 'percent' ? `ลด ${rule.value}%` : `ลด ${rule.value} บาท`;
}

const low = (s) => String(s == null ? '' : s).trim().toLowerCase();

// items = [{id,name,code,barcodes[]}] จากแคตตาล็อก
// → { status:'found', item } | { status:'suggest', choices:[item…≤6] } | { status:'notfound' }
function findItem(items, text) {
  const t = low(text);
  if (!t || !Array.isArray(items)) return { status: 'notfound' };
  const exact = items.find((it) => it && (low(it.id) === t || low(it.code) === t || (Array.isArray(it.barcodes) && it.barcodes.some((b) => low(b) === t))));
  if (exact) return { status: 'found', item: exact };
  const part = items.filter((it) => it && low(it.name).includes(t));
  if (part.length === 1) return { status: 'found', item: part[0] };
  if (part.length > 1) return { status: 'suggest', choices: part.slice(0, 6) };
  return { status: 'notfound' };
}

function searchItems(items, q, n = 8) {
  const t = low(q);
  if (!t || !Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (!it) continue;
    if (low(it.name).includes(t) || low(it.code) === t || low(it.id) === t || (Array.isArray(it.barcodes) && it.barcodes.some((b) => low(b) === t))) {
      out.push(it);
      if (out.length >= n) break;
    }
  }
  return out;
}

// สินค้าที่ยิงไว้ของบิลถัดไป: หมดอายุเอง (นับใหม่ทุกครั้งที่ยิง) ใช้ครั้งเดียว
function createBasket({ now = Date.now, ttlMs = 10 * 60 * 1000 } = {}) {
  const m = new Map(); // itemId → { itemId, name, qty }
  let at = 0;
  const fresh = () => m.size > 0 && now() - at <= ttlMs;
  const expire = () => { if (m.size && !fresh()) m.clear(); };
  return {
    add(itemId, name, n = 1) {
      expire();
      const id = String(itemId);
      const cur = m.get(id) || { itemId: id, name: String(name || id), qty: 0 };
      cur.qty = Math.min(99, cur.qty + n);
      m.set(id, cur); at = now();
      return cur.qty;
    },
    dec(itemId) {
      expire();
      const cur = m.get(String(itemId));
      if (!cur) return;
      cur.qty -= 1;
      if (cur.qty <= 0) m.delete(String(itemId));
      at = now();
    },
    remove(itemId) { m.delete(String(itemId)); },
    items() { expire(); return [...m.values()].map((x) => ({ ...x })); },
    take() { const v = fresh() ? [...m.values()].map((x) => ({ ...x })) : []; m.clear(); at = 0; return v; },
    clear() { m.clear(); at = 0; },
    remainingMs() { return fresh() ? Math.max(0, ttlMs - (now() - at)) : 0; }
  };
}

// → { earned:[rule], progress:[{ rule, qty, done }] } ; หนึ่งกฎ = หนึ่งคูปอง (ซื้อเกินขั้นต่ำก็ได้ใบเดียว)
function evaluate(rules, basketItems) {
  const qtyOf = new Map();
  for (const b of basketItems || []) qtyOf.set(String(b.itemId), (qtyOf.get(String(b.itemId)) || 0) + (Number(b.qty) || 0));
  const earned = [], progress = [];
  for (const rule of normalizeRules(rules)) {
    const qty = qtyOf.get(rule.itemId) || 0;
    if (qty <= 0) continue;
    const done = qty >= rule.minQty;
    progress.push({ rule, qty, done });
    if (done) earned.push(rule);
  }
  return { earned, progress };
}

module.exports = { normalizeRules, rewardText, findItem, searchItems, createBasket, evaluate };
