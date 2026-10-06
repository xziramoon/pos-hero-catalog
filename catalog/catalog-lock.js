'use strict';
// Single-owner lock for userData/catalog. POS Hero has no single-instance
// lock of its own, and two processes writing db.json / outbox.json as whole
// files would silently drop each other's edits. The second process simply
// runs without the catalog (the money side is not touched).
const fs = require('fs');
const path = require('path');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function createLock(dir, pid = process.pid) {
  const file = path.join(dir, '.lock');
  let held = false;

  function readOwner() {
    try { return parseInt(fs.readFileSync(file, 'utf8'), 10); } catch (_) { return null; }
  }

  // true when this process owns the catalog folder.
  function acquire() {
    try {
      fs.writeFileSync(file, String(pid), { flag: 'wx' });
      held = true;
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const owner = readOwner();
    if (owner !== pid && pidAlive(owner)) return false;
    // Stale lock left by a crash (or our own pid): take it over.
    fs.writeFileSync(file, String(pid));
    held = true;
    return true;
  }

  function release() {
    if (!held) return;
    held = false;
    try { if (readOwner() === pid) fs.unlinkSync(file); } catch (_) { /* ignore */ }
  }

  return { acquire, release, owner: readOwner, get held() { return held; } };
}

module.exports = { createLock, pidAlive };
