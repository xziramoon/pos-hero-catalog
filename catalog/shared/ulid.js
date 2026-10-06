'use strict';
// ULID generator (Crockford base32, 26 chars). Works in Node and browsers.
// Monotonic within the same millisecond: the random part is incremented.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomBytes(n) {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  if (g.crypto && typeof g.crypto.getRandomValues === 'function') {
    return g.crypto.getRandomValues(new Uint8Array(n));
  }
  // eslint-disable-next-line global-require
  return new Uint8Array(require('crypto').randomBytes(n));
}

let lastTime = -1;
let lastRand = null; // array of 16 values 0..31

function freshRandom() {
  const bytes = randomBytes(16);
  const out = new Array(16);
  for (let i = 0; i < 16; i++) out[i] = bytes[i] & 31;
  return out;
}

function encodeTime(t) {
  let s = '';
  for (let i = 0; i < 10; i++) {
    s = ALPHABET[t % 32] + s;
    t = Math.floor(t / 32);
  }
  return s;
}

function ulid(now = Date.now()) {
  let t = Math.floor(now);
  if (!(t >= 0)) t = 0;
  if (t <= lastTime && lastRand) {
    // Same (or earlier) ms: keep the time monotonic and bump the random part.
    t = lastTime;
    let i = 15;
    while (i >= 0) {
      if (lastRand[i] === 31) { lastRand[i] = 0; i--; } else { lastRand[i]++; break; }
    }
    if (i < 0) lastRand = freshRandom(); // overflow: practically unreachable
  } else {
    lastRand = freshRandom();
    lastTime = t;
  }
  let r = '';
  for (let i = 0; i < 16; i++) r += ALPHABET[lastRand[i]];
  return encodeTime(t) + r;
}

module.exports = { ulid, ALPHABET };
