'use strict';
// ย้ายพอร์ตจอลูกค้า 8080 → 8790 ครั้งเดียว (8080 ในเครื่อง POS มีโปรแกรมอื่นใช้) ถ้าตั้งกลับเป็น 8080 เองหลังย้ายแล้วจะไม่ถูกย้ายอีก
function migrateConfig(raw) {
  const c = raw && typeof raw === 'object' ? { ...raw } : {};
  if (c.portMigrated !== true) {
    const p = parseInt(c.displayPort, 10);
    if (!p || p === 8080) c.displayPort = 8790;
    c.portMigrated = true;
  }
  return c;
}
module.exports = { migrateConfig };
