'use strict';
const assert = require('assert');
const { buildSteps, runAutoType } = require('../qrlock/autotype');
assert.deepStrictEqual(buildSteps(['F5', '02', 'enter', '{AMOUNT}', 'ENTER', 'WAIT:300'], '360.00'),
  [{ keys: '{F5}' }, { keys: '02' }, { keys: '{ENTER}' }, { keys: '360.00' }, { keys: '{ENTER}' }, { wait: 300 }]);
assert.deepStrictEqual(buildSteps(['a+b'], '1'), [{ keys: 'a{+}b' }]); // ตัวอักษรพิเศษของ SendKeys ถูก escape
assert.deepStrictEqual(buildSteps(['WAIT:99999'], '1'), [{ wait: 2000 }]);
assert.throws(() => buildSteps([], '1')); assert.throws(() => buildSteps(['{FOO}'], '1'));
(async () => {
  assert.strictEqual((await runAutoType({ windowTitleContains: '', keys: ['F5'], amount: '1' })).ok, false);
  assert.strictEqual((await runAutoType({ windowTitleContains: 'x', keys: [], amount: '1' })).ok, false);
  if (process.platform === 'win32') { // ไม่มีหน้าต่างชื่อนี้ → ต้องไม่ส่งปุ่มใดๆ และรายงานว่าไม่พบ
    const r = await runAutoType({ windowTitleContains: 'zz-no-such-window-qrlock-9731', keys: ['F5'], amount: '1', timeoutMs: 10000 });
    assert.strictEqual(r.ok, false); assert.ok(/ไม่พบหน้าต่าง/.test(r.reason), r.reason);
  }
  console.log('qrlock-autotype: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
