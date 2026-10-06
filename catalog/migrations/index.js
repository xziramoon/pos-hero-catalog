'use strict';
// Item schema migrations (spec §12.1). Each NNN-*.js exports
// { version, migrate(item) -> item } and upgrades an item FROM version-1 TO version.
// Add new files to the list below in ascending order.
const steps = [
  // require('./002-example'),
];

const CURRENT_SCHEMA = 1 + steps.length;

function migrateItem(item) {
  let v = Number.isFinite(item.schemaVersion) ? item.schemaVersion : 1;
  for (const s of steps) {
    if (s.version > v) {
      item = s.migrate(item) || item;
      v = s.version;
    }
  }
  item.schemaVersion = Math.max(v, CURRENT_SCHEMA);
  return item;
}

module.exports = { migrateItem, CURRENT_SCHEMA };
