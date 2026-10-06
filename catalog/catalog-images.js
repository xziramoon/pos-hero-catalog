'use strict';
// Main-process image file store: <catalog dir>/images/{hash}/orig.jpg and {variant}-v{ver}.jpg.
// Writes are tmp + rename. No Electron APIs, so it also runs in plain Node tests.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const HASH_RE = /^[0-9a-f]{64}$/; // lowercase sha256 hex of the orig bytes
const VARIANTS = ['orig', 'thumb', 'full'];

function createImages(imagesDir) {
  const emitter = new EventEmitter();

  function fileName(variant, ver) {
    if (!VARIANTS.includes(variant)) throw new Error('bad image variant: ' + variant);
    if (variant === 'orig') return 'orig.jpg';
    if (ver == null) return variant + '.jpg';
    if (!Number.isInteger(ver) || ver < 1) throw new Error('bad image ver: ' + ver);
    return variant + '-v' + ver + '.jpg';
  }

  function p(hash, variant, ver) {
    if (!HASH_RE.test(String(hash))) throw new Error('bad image hash');
    return path.join(imagesDir, hash, fileName(variant, ver));
  }

  function has(hash, variant, ver) {
    try { return fs.statSync(p(hash, variant, ver)).size > 0; } catch (_) { return false; }
  }

  function read(hash, variant, ver) {
    try { return fs.readFileSync(p(hash, variant, ver)); } catch (_) { return null; }
  }

  // Raw write (used by lazy downloads too, which must NOT trigger uploads).
  function write(hash, variant, ver, buf) {
    const file = p(hash, variant, ver);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
    fs.writeFileSync(tmp, Buffer.from(buf));
    fs.renameSync(tmp, file);
    return file;
  }

  // Locally produced variants. Emits 'saved' {hash, ver, orig:boolean} so sync can queue uploads.
  // Callers should do this BEFORE putting the item that references hash/ver.
  function saveVariants(hash, ver, v) {
    if (!v || !v.thumb || !v.full) throw new Error('thumb and full are required');
    const out = {};
    if (v.orig && !has(hash, 'orig')) out.orig = write(hash, 'orig', null, v.orig);
    out.thumb = write(hash, 'thumb', ver, v.thumb);
    out.full = write(hash, 'full', ver, v.full);
    try { emitter.emit('saved', { hash, ver, orig: !!out.orig }); } catch (e) { console.warn('[catalog] images listener error', e.message); }
    return out;
  }

  return {
    saveVariants, write, path: p, has, read, fileName, dir: imagesDir,
    on: (ev, fn) => { emitter.on(ev, fn); },
    off: (ev, fn) => { emitter.off(ev, fn); }
  };
}

module.exports = { createImages, HASH_RE };
