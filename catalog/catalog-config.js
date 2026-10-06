'use strict';
// Loads/saves userData/catalog/config.json (tmp + rename). Defaults come from defaults.js.
const fs = require('fs');
const path = require('path');
const { getDefaults, deepMerge } = require('./defaults');

function createConfigStore(dir) {
  const file = path.join(dir, 'config.json');
  let cfg = getDefaults();

  function load() {
    let user = {};
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[catalog] config.json unreadable, using defaults:', e.message);
    }
    cfg = deepMerge(getDefaults(), user);
    return cfg;
  }

  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      console.warn('[catalog] config save failed:', e.message);
      return false;
    }
  }

  function get() { return cfg; }

  function update(patch) {
    cfg = deepMerge(cfg, patch || {});
    save();
    return cfg;
  }

  // Renderer-safe copy: the write token never leaves the main process.
  function publicConfig() {
    const c = JSON.parse(JSON.stringify(cfg));
    c.hasWriteToken = !!(c.worker && c.worker.writeToken);
    if (c.worker) delete c.worker.writeToken;
    return c;
  }

  return { load, save, get, update, publicConfig, file };
}

module.exports = { createConfigStore };
