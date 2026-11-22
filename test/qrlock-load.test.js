'use strict';
// ทุกไฟล์ JS ของ qrlock ต้อง parse ได้ และ qrlock-main ต้องโหลดได้ (กัน syntax error ที่ทำให้ฟีเจอร์เงียบหาย)
const fs = require('fs'), path = require('path'), assert = require('assert');
const { spawnSync } = require('child_process');
const dir = path.join(__dirname, '..', 'qrlock');
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
  const r = spawnSync(process.execPath, ['--check', path.join(dir, f)], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, f + ': ' + r.stderr);
}
const M = require('module'), orig = M._load;
M._load = function (r, ...a) { if (r === 'electron') return new Proxy({}, { get: () => class {} }); return orig.call(this, r, ...a); };
const m = require('../qrlock/qrlock-main');
assert.deepStrictEqual(Object.keys(m).sort(), ['enableCartDisplay', 'init', 'showCart', 'shutdown', 'trayItems']);
console.log('qrlock-load: ok');
