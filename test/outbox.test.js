'use strict';
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOutbox, backoffMs } = require('../catalog/catalog-outbox');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-outbox-'));
const H1 = 'a'.repeat(64);
const item = (id, o) => Object.assign({ id, code: '1', name: id, updatedAt: 1000, updatedBy: 'dev-a', deleted: false, image: null }, o);

try {
  // ---- backoff: 2s, 4s, 8s ... capped at 5 min
  assert.strictEqual(backoffMs(0), 0);
  assert.deepStrictEqual([1, 2, 3, 4].map(backoffMs), [2000, 4000, 8000, 16000]);
  assert.strictEqual(backoffMs(8), 256000);
  assert.strictEqual(backoffMs(9), 300000);
  assert.strictEqual(backoffMs(40), 300000);

  // ---- coalescing: same id keeps one entry holding the latest payload
  {
    const ob = createOutbox(tmp, { now: () => 5000 }).load();
    ob.enqueueItem(item('A', { name: 'v1', updatedAt: 1 }));
    ob.enqueueItem(item('B'));
    ob.enqueueItem(item('A', { name: 'v2', updatedAt: 2 }));
    ob.enqueueItem(item('A', { name: 'v3', updatedAt: 3 }));
    assert.strictEqual(ob.size(), 2);
    assert.strictEqual(ob.getItem('A').payload.name, 'v3');
    ob.enqueueMeta({ categories: ['x'], shopName: 'a', updatedAt: 1 });
    ob.enqueueMeta({ categories: ['x', 'y'], shopName: 'a', updatedAt: 2 });
    assert.strictEqual(ob.size(), 3);
    assert.deepStrictEqual(ob.getMeta().payload.categories, ['x', 'y']);
    // payload is a snapshot, not a live reference
    const live = item('C'); ob.enqueueItem(live); live.name = 'mutated';
    assert.strictEqual(ob.getItem('C').payload.name, 'C');
    ob.flush();
    fs.rmSync(ob.file);
  }

  // ---- ordering: item referencing a pending image waits for the img ops
  {
    let t = 10000;
    const ob = createOutbox(tmp, { now: () => t }).load();
    ob.enqueueItem(item('P', { image: { hash: H1, ver: 1 } }));
    ob.enqueueItem(item('Q'));
    ob.enqueueImage(H1, 'orig', null);
    ob.enqueueImage(H1, 'thumb', 1);
    ob.enqueueImage(H1, 'full', 1);
    let r = ob.ready();
    assert.strictEqual(r.img.length, 3);
    assert.deepStrictEqual(r.item.map((e) => e.payload.id), ['Q'], 'P is blocked while its images are pending');
    ob.remove('img:' + H1 + '/orig');
    ob.remove('img:' + H1 + '/thumb-v1');
    assert.deepStrictEqual(ob.ready().item.map((e) => e.payload.id), ['Q'], 'still blocked by full');
    // a failing image upload keeps the item blocked even after its backoff elapses for the item
    ob.fail('img:' + H1 + '/full-v1');
    assert.strictEqual(ob.ready().img.length, 0, 'image is in backoff');
    assert.deepStrictEqual(ob.ready().item.map((e) => e.payload.id), ['Q']);
    t += 2001;
    assert.strictEqual(ob.ready().img.length, 1);
    ob.remove('img:' + H1 + '/full-v1');
    assert.deepStrictEqual(ob.ready().item.map((e) => e.payload.id).sort(), ['P', 'Q']);
    ob.flush();
    fs.rmSync(ob.file);
  }

  // ---- failure / backoff / reset
  {
    let t = 0;
    const ob = createOutbox(tmp, { now: () => t }).load();
    ob.enqueueItem(item('A'));
    ob.fail('item:A', 100);
    assert.strictEqual(ob.getItem('A').nextAt, 2100);
    ob.fail('item:A', 2100);
    assert.strictEqual(ob.getItem('A').nextAt, 2100 + 4000);
    t = 2000;
    assert.strictEqual(ob.ready(2000).item.length, 0);
    assert.strictEqual(ob.ready(7000).item.length, 1);
    assert.strictEqual(ob.nextDueAt(2000), 6100);
    ob.resetBackoff();
    assert.strictEqual(ob.getItem('A').tries, 0);
    assert.strictEqual(ob.ready(0).item.length, 1);
    // a new edit during backoff retries immediately
    ob.fail('item:A', 0);
    ob.enqueueItem(item('A', { name: 'again', updatedAt: 9 }));
    assert.strictEqual(ob.getItem('A').nextAt, 0);
    // remove with expect only removes the same version
    const sent = ob.getItem('A').payload;
    ob.enqueueItem(item('A', { name: 'newer', updatedAt: 10 }));
    assert.strictEqual(ob.remove('item:A', sent), false, 'newer edit survives the ack of an older send');
    assert.strictEqual(ob.remove('item:A', ob.getItem('A').payload), true);
    fs.rmSync(ob.file, { force: true });
  }

  // ---- persistence
  {
    const a = createOutbox(tmp).load();
    a.enqueueItem(item('A', { image: { hash: H1, ver: 2 } }));
    a.enqueueImage(H1, 'thumb', 2);
    a.enqueueMeta({ categories: ['ทั่วไป'], shopName: 's', updatedAt: 5 });
    a.fail('img:' + H1 + '/thumb-v2', 1000);
    a.flush();
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'outbox.json'), 'utf8'));
    assert.strictEqual(raw.length, 3);
    assert.deepStrictEqual(Object.keys(raw[0]).sort(), ['nextAt', 'op', 'payload', 'tries']);
    const b = createOutbox(tmp).load();
    assert.strictEqual(b.size(), 3);
    assert.strictEqual(b.get('img:' + H1 + '/thumb-v2').tries, 1);
    assert.strictEqual(b.get('img:' + H1 + '/thumb-v2').nextAt, 3000);
    assert.strictEqual(b.getItem('A').payload.image.ver, 2);
    assert.deepStrictEqual(b.itemIds(), ['A']);
    // corrupt file: kept aside, starts empty
    fs.writeFileSync(path.join(tmp, 'outbox.json'), '{nope');
    const c = createOutbox(tmp).load();
    assert.strictEqual(c.size(), 0);
    assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('outbox.json.corrupt-')));
  }
  console.log('outbox.test.js ok');
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}
