'use strict';
const assert = require('node:assert');
const { fitTabs } = require('../renderer/catalog/filters');

const mk = (...w) => w.map((x, i) => ({ id: 'c' + i, w: x }));
const items = mk(50, 50, 50, 50, 50); // total 5*50 + 4*4 = 266

// everything fits -> no button
let r = fitTabs(items, 266, 80, 4, 'c0');
assert.deepStrictEqual(r.hidden, []); assert.strictEqual(r.visible.length, 5);
// does not fit: room = 200 - 80 = 120 -> two tabs (104)
r = fitTabs(items, 200, 80, 4, 'c0');
assert.deepStrictEqual(r.visible, ['c0', 'c1']); assert.deepStrictEqual(r.hidden, ['c2', 'c3', 'c4']);
// active hidden tab takes the last slot
r = fitTabs(items, 200, 80, 4, 'c4');
assert.deepStrictEqual(r.visible, ['c0', 'c4']); assert.deepStrictEqual(r.hidden, ['c1', 'c2', 'c3']);
// a wide active tab pushes out more than one
r = fitTabs(mk(50, 50, 50, 100), 200, 80, 4, 'c3');
assert.deepStrictEqual(r.visible, ['c3']);
// nothing fits at all: only the active tab is shown
r = fitTabs(items, 100, 80, 4, 'c2');
assert.deepStrictEqual(r.visible, []); assert.strictEqual(r.activeHidden, true);
r = fitTabs(items, 100, 80, 4, 'all');
assert.deepStrictEqual(r.visible, []); assert.strictEqual(r.hidden.length, 5);
// empty
assert.deepStrictEqual(fitTabs([], 0, 80, 4, 'x'), { visible: [], hidden: [] });
console.log('tabs-fit OK');
// active tab wider than the room: nothing visible, flagged so the button can show the active name
r = fitTabs(mk(50, 50, 200), 150, 80, 4, 'c2');
assert.deepStrictEqual(r.visible, []); assert.strictEqual(r.activeHidden, true); assert.strictEqual(r.hidden.length, 3);
assert.ok(!fitTabs(items, 200, 80, 4, 'c4').activeHidden);
console.log('tabs-fit active-hidden OK');
