'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPhone, parseDevices, parsePackages, launchArgs, displayArgs } = require('../qrlock/phone');

assert.deepStrictEqual(parseDevices('List of devices attached\n192.168.1.50:41234\tdevice\nabc\tunauthorized\n\n'),
  [{ id: '192.168.1.50:41234', state: 'device' }, { id: 'abc', state: 'unauthorized' }]);
assert.deepStrictEqual(parseDevices('List of devices attached\n'), []);
assert.deepStrictEqual(parsePackages('package:com.b.app\r\npackage:com.a.app\nnoise\n'), ['com.a.app', 'com.b.app']);
assert.deepStrictEqual(launchArgs('com.x.y'), ['shell', 'monkey', '-p', 'com.x.y', '-c', 'android.intent.category.LAUNCHER', '1']);
assert.ok(displayArgs('http://1.2.3.4:8080/display').includes('http://1.2.3.4:8080/display'));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qrphone-'));
  let cfg = { address: '192.168.1.50:41234', payPackage: 'com.x.pay' };
  // ยังไม่มี adb → ต้องไม่ crash และบอกเหตุผล
  const calls = [];
  let connected = false;
  const exec = (bin, args, _o, cb) => {
    calls.push(args.join(' '));
    if (args[0] === 'devices') return cb(null, 'List of devices attached\n' + (connected ? '192.168.1.50:41234\tdevice\n' : ''), '');
    if (args[0] === 'connect') { connected = true; return cb(null, 'connected to ' + args[1], ''); }
    if (args[0] === 'pair') return cb(null, args[2] === '123456' ? 'Successfully paired to ' + args[1] : 'Failed: wrong code', '');
    cb(null, '', '');
  };
  const p = createPhone({ dir, getCfg: () => cfg, exec });
  assert.strictEqual((await p.openPay()).ok, false);
  assert.strictEqual((await p.status()).adb, false);

  fs.mkdirSync(path.join(dir, 'platform-tools'));
  fs.writeFileSync(path.join(dir, 'platform-tools', 'adb.exe'), '');
  // ต่อใหม่อัตโนมัติก่อนส่งคำสั่ง แล้วเปิดแอป
  const r = await p.openPay();
  assert.strictEqual(r.ok, true);
  assert.ok(calls.some((c) => c === 'connect 192.168.1.50:41234'));
  assert.ok(calls.some((c) => c === '-s 192.168.1.50:41234 shell monkey -p com.x.pay -c android.intent.category.LAUNCHER 1'));
  // เชื่อมอยู่แล้ว → ไม่ connect ซ้ำ
  calls.length = 0;
  await p.openPay();
  assert.ok(!calls.some((c) => c.startsWith('connect')));
  // ตรวจอินพุต
  cfg = { ...cfg, payPackage: 'rm -rf' };
  assert.strictEqual((await p.openPay()).ok, false);
  assert.strictEqual((await p.openDisplay('http://x/y; reboot')).ok, false);
  assert.strictEqual((await p.pair('bad', '123456')).ok, false);
  assert.strictEqual((await p.pair('192.168.1.50:37123', '12')).ok, false);
  assert.strictEqual((await p.pair('192.168.1.50:37123', '000000')).ok, false);
  assert.strictEqual((await p.pair('192.168.1.50:37123', '123456')).ok, true);
  assert.strictEqual((await p.connect('nope')).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('qrlock-phone ok');
})().catch((e) => { console.error(e); process.exit(1); });
