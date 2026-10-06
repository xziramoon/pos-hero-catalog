'use strict';
// Runs every test/*.test.js in its own node process; exits non-zero if any fails.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
let failed = 0;
for (const f of files) {
  console.log('> ' + f);
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log('FAILED ' + f); }
}
console.log(failed ? `\n${failed} test file(s) failed` : `\n${files.length} test file(s) passed`);
process.exit(failed ? 1 : 0);
