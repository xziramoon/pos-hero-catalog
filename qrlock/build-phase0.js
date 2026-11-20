'use strict';
// รวม qrcode.js + qr-builder.js ลงหน้า HTML ไฟล์เดียว (ใช้ออฟไลน์ได้): node qrlock/build-phase0.js
const fs = require('fs'), path = require('path');
const r = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/<\/script/gi, '<\/script');
const out = r('phase0.src.html').replace('/*QRLIB*/', () => r('vendor/qrcode.js')).replace('/*BUILDER*/', () => r('qr-builder.js'));
fs.writeFileSync(path.join(__dirname, 'phase0.html'), out);
console.log('wrote qrlock/phase0.html', out.length, 'bytes');
