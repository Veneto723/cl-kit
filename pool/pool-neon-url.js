// Shared resolver for the pool metrics DB connection URL.
// Priority: cl-config.json poolDb.neonUrl > legacy scripts/pool-config.json.
// Returns null when no pool DB is configured (pool tooling then no-ops).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = function poolNeonUrl() {
  const home = os.homedir();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'cl-config.json'), 'utf8'));
    if (cfg.poolDb && cfg.poolDb.neonUrl) return cfg.poolDb.neonUrl;
  } catch {}
  try {
    const legacy = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'scripts', 'pool-config.json'), 'utf8'));
    if (legacy.neonUrl) return legacy.neonUrl;
  } catch {}
  return null;
};
