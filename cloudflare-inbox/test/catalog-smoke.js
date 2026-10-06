// Catalog smoke test against a running worker (default: wrangler dev on http://127.0.0.1:8787).
//   BASE=https://pos-hero-inbox.<you>.workers.dev node test/catalog-smoke.js
// Uses a random Catalog Key so it never touches real shop data.
const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const rnd = (n) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
const KEY = 'CatSmoke' + rnd(32);
const TOKEN = 'tok-' + rnd(32);
const root = `${BASE}/catalog/${KEY}`;
let failed = 0;
const check = (name, ok, detail) => { if (!ok) failed++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || detail === undefined ? '' : '  -> ' + JSON.stringify(detail))); };

const W = { 'X-Catalog-Write': TOKEN };
const jget = async (path) => (await fetch(root + path)).json();
const post = (items, headers = W) => fetch(root + '/items', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify({ items }) });
const mk = (id, o) => Object.assign({ id, code: '00' + id.slice(-3), name: 'สินค้า ' + id, cat: 'ทั่วไป', updatedAt: Date.now(), updatedBy: 'dev-a' }, o);
const HASH = rnd(64).replace(/[^a-f0-9]/g, 'a').padEnd(64, 'b');

(async () => {
  // health + init
  const h0 = await jget('/health');
  check('health ok on fresh key', h0.ok === true && h0.rev === 0 && h0.itemCount === 0 && typeof h0.serverTime === 'number', h0);
  check('short key rejected', (await fetch(`${BASE}/catalog/short/health`)).status === 400);
  check('write before init is 401', (await post([mk('X001')])).status === 401);
  check('init with short token rejected', (await fetch(root + '/init', { method: 'POST', headers: { 'X-Catalog-Write': 'short' } })).status === 400);
  const init = await fetch(root + '/init', { method: 'POST', headers: W });
  check('init sets token', init.status === 200, await init.text());
  const init2 = await fetch(root + '/init', { method: 'POST', headers: { 'X-Catalog-Write': 'another-token-1234567890' } });
  const init2b = await init2.json();
  check('second init is 409', init2.status === 409 && init2b.error === 'already_initialized', init2b);

  // auth
  const noTok = await post([mk('A001')], {});
  const noTokBody = await noTok.json();
  check('no write token -> 401 with error json', noTok.status === 401 && noTokBody.error === 'unauthorized' && noTokBody.message, noTokBody);
  check('wrong write token -> 401', (await post([mk('A001')], { 'X-Catalog-Write': 'wrong-token-1234567890' })).status === 401);
  check('meta without token -> 401', (await fetch(root + '/meta', { method: 'PUT', body: '{}' })).status === 401);
  check('image PUT without token -> 401', (await fetch(`${root}/img/${HASH}/orig`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array([1]) })).status === 401);

  // push 3 items
  const t0 = Date.now();
  const items = [mk('A001', { updatedAt: t0, name: 'ก' }), mk('A002', { updatedAt: t0, name: 'ข', fav: true }), mk('A003', { updatedAt: t0, name: 'ค', code: '00103' })];
  const pr = await (await post(items)).json();
  check('push 3 accepted with revs', pr.accepted && pr.accepted.length === 3 && pr.accepted.every(a => a.rev > 0) && pr.rejected.length === 0, pr);
  const h1 = await jget('/health');
  check('health reflects 3 items', h1.itemCount === 3 && h1.rev === 3, h1);

  // changes since 0 / since rev
  const ch = await jget('/changes?since=0');
  check('changes since 0 returns all 3', ch.items.length === 3 && ch.more === false && ch.rev === 3, ch);
  check('code kept as string with leading zeros', ch.items.find(i => i.id === 'A003').code === '00103', ch.items);
  const ch2 = await jget('/changes?since=2');
  check('changes since 2 returns only rev>2', ch2.items.length === 1 && ch2.items[0].rev === 3, ch2);
  const ch3 = await jget('/changes?since=0&limit=2');
  check('limit paginates with more=true', ch3.items.length === 2 && ch3.more === true && ch3.rev === 2, ch3);

  // concurrent edits from two devices
  const newer = mk('A001', { updatedAt: t0 + 1000, updatedBy: 'dev-b', name: 'ก-B' });
  const older = mk('A001', { updatedAt: t0 + 500, updatedBy: 'dev-a', name: 'ก-A-late' });
  const r1 = await (await post([newer])).json();
  check('newer edit accepted', r1.accepted.length === 1 && r1.accepted[0].rev === 4, r1);
  const r2 = await (await post([older])).json();
  check('older edit rejected as stale with current', r2.rejected.length === 1 && r2.rejected[0].reason === 'stale' && r2.rejected[0].current.name === 'ก-B', r2);
  const tie = await (await post([mk('A001', { updatedAt: t0 + 1000, updatedBy: 'dev-a', name: 'tie-a' })])).json();
  check('tie on updatedAt: smaller updatedBy loses', tie.rejected.length === 1 && tie.rejected[0].reason === 'stale', tie);
  const tieWin = await (await post([mk('A001', { updatedAt: t0 + 1000, updatedBy: 'dev-c', name: 'tie-c' })])).json();
  check('tie on updatedAt: larger updatedBy wins', tieWin.accepted.length === 1, tieWin);
  const resend = await (await post([mk('A001', { updatedAt: t0 + 1000, updatedBy: 'dev-c', name: 'tie-c' })])).json();
  check('exact resend is idempotent', resend.accepted.length === 1 && resend.accepted[0].rev === tieWin.accepted[0].rev, resend);

  // tombstone
  const del = await (await post([mk('A002', { updatedAt: t0 + 2000, deleted: true })])).json();
  check('tombstone accepted', del.accepted.length === 1, del);
  const afterDel = await jget('/changes?since=' + (tieWin.accepted[0].rev));
  check('tombstone appears in changes', afterDel.items.some(i => i.id === 'A002' && i.deleted === true), afterDel);
  const stale = await (await post([mk('A002', { updatedAt: t0 + 1500, deleted: false })])).json();
  check('older edit cannot resurrect tombstone', stale.rejected.length === 1 && stale.rejected[0].current.deleted === true, stale);
  const revive = await (await post([mk('A002', { updatedAt: t0 + 3000, deleted: false })])).json();
  check('newer edit revives tombstone', revive.accepted.length === 1, revive);
  await post([mk('A002', { updatedAt: t0 + 4000, deleted: true })]);
  check('itemCount excludes tombstones', (await jget('/health')).itemCount === 2);

  // validation / limits
  const bad = await (await post([{ id: '', code: 1 }])).json();
  check('invalid item rejected with reason', bad.rejected.length === 1 && bad.rejected[0].reason, bad);
  const many = await post(Array.from({ length: 201 }, (_, i) => mk('M' + String(i).padStart(4, '0'))));
  check('more than 200 items -> 400', many.status === 400 && (await many.json()).error === 'too_many_items');
  const skew = await post([mk('S001', { updatedAt: Date.now() + 11 * 60 * 1000 })]);
  const skewBody = await skew.json();
  check('future updatedAt > 10 min -> 409 clock_skew + serverTime', skew.status === 409 && skewBody.error === 'clock_skew' && Math.abs(skewBody.serverTime - Date.now()) < 60000, skewBody);
  const nearFuture = await (await post([mk('S002', { updatedAt: Date.now() + 5 * 60 * 1000 })])).json();
  check('5 min in the future is accepted', nearFuture.accepted.length === 1, nearFuture);
  check('bad JSON -> 400', (await fetch(root + '/items', { method: 'POST', headers: W, body: '{"broken' })).status === 400);

  // meta
  const mr = await fetch(root + '/meta', { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, W), body: JSON.stringify({ categories: ['ของใช้ส่วนตัว'], shopName: 'ร้านทดสอบ' }) });
  const mb = await mr.json();
  check('meta PUT adds default category', mr.status === 200 && mb.meta.categories.includes('ทั่วไป') && mb.meta.categories.includes('ของใช้ส่วนตัว') && mb.meta.shopName === 'ร้านทดสอบ', mb);
  const chm = await jget('/changes?since=0');
  check('changes include meta', chm.meta && chm.meta.shopName === 'ร้านทดสอบ', chm.meta);
  const chm2 = await jget('/changes?since=' + chm.rev);
  check('no meta when since is current', chm2.meta === undefined && chm2.items.length === 0, chm2);

  // images
  const jpeg = new Uint8Array(2048).map((_, i) => (i * 7) & 255);
  jpeg[0] = 0xff; jpeg[1] = 0xd8;
  const ip = (variant, body, type = 'image/jpeg') => fetch(`${root}/img/${HASH}/${variant}`, { method: 'PUT', headers: Object.assign({ 'Content-Type': type }, W), body });
  check('PUT orig jpeg', (await ip('orig', jpeg)).status === 200);
  check('PUT thumb-v3 webp', (await ip('thumb-v3', jpeg, 'image/webp')).status === 200);
  check('PUT full-v3', (await ip('full-v3', jpeg)).status === 200);
  const g = await fetch(`${root}/img/${HASH}/thumb-v3`);
  const gb = new Uint8Array(await g.arrayBuffer());
  check('GET returns same bytes', g.status === 200 && gb.length === jpeg.length && gb.every((b, i) => b === jpeg[i]));
  check('GET has immutable cache header', /immutable/.test(g.headers.get('Cache-Control') || '') && /max-age=31536000/.test(g.headers.get('Cache-Control') || ''), g.headers.get('Cache-Control'));
  check('GET keeps stored content-type', g.headers.get('Content-Type') === 'image/webp', g.headers.get('Content-Type'));
  check('GET orig cached immutable', /immutable/.test((await fetch(`${root}/img/${HASH}/orig`)).headers.get('Cache-Control') || ''));
  check('GET missing image -> 404', (await fetch(`${root}/img/${HASH}/full-v9`)).status === 404);
  check('GET image needs no write token', (await fetch(`${root}/img/${HASH}/full-v3`)).status === 200);
  check('bad variant -> 400', (await ip('huge', jpeg)).status === 400);
  check('png content-type -> 415', (await ip('full-v4', jpeg, 'image/png')).status === 415);
  const big = await ip('full-v5', new Uint8Array(5 * 1024 * 1024 + 1));
  check('image over 5MB -> 413', big.status === 413, big.status);
  check('exactly 5MB is accepted', (await ip('full-v6', new Uint8Array(5 * 1024 * 1024))).status === 200);

  // export
  const ex = await jget('/export');
  check('export has all items incl. tombstones and meta', ex.items.length >= 4 && ex.items.some(i => i.deleted) && ex.meta && ex.meta.shopName === 'ร้านทดสอบ', Object.keys(ex));

  // isolation, CORS, errors
  const otherKey = KEY.replace(/.$/, KEY.endsWith('Q') ? 'R' : 'Q');
  const oh = await (await fetch(`${BASE}/catalog/${otherKey}/health`)).json();
  check('different key sees nothing', oh.itemCount === 0 && oh.rev === 0, oh);
  check('other key cannot read this key image', (await fetch(`${BASE}/catalog/${otherKey}/img/${HASH}/orig`)).status === 404);
  const pf = await fetch(root + '/items', { method: 'OPTIONS' });
  check('CORS preflight allows X-Catalog-Write', pf.status === 200 && /X-Catalog-Write/.test(pf.headers.get('Access-Control-Allow-Headers') || '') && pf.headers.get('Access-Control-Allow-Origin') === '*');
  check('CORS header on responses', (await fetch(root + '/health')).headers.get('Access-Control-Allow-Origin') === '*');
  const nf = await fetch(root + '/nope');
  check('unknown endpoint -> 404 json', nf.status === 404 && (await nf.json()).error === 'not_found');

  // inbox must be untouched
  check('inbox health still works', (await (await fetch(BASE + '/health')).json()).ok === true);
  check('inbox short key still 401', (await fetch(`${BASE}/pos_hero_inbox/short/events.json`)).status === 401);

  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.log('FAIL unexpected error', e); process.exit(1); });
