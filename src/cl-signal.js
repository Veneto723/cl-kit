#!/usr/bin/env node
// Broadcaster invoked by the /switch and /restart slash commands (via their
// `!`-bash line). Its ONLY job is to drop a per-session trigger file that the
// cl-runner wrapper polls for. It does no switching itself.
//
// Usage: node cl-signal.js <action> [target]
//   action = "switch" | "restart"
//   target = optional account id for /switch <id> (cycles to next if omitted)
//
// The session id comes from CL_SESSION, which cl-runner sets in claude's env
// when it launches; the `!`-bash in a slash command inherits it. This scopes
// the trigger to exactly the terminal the command was typed in.
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const action  = (process.argv[2] || 'switch').trim();
const target  = (process.argv[3] || '').trim() || null;
const session = (process.env.CL_SESSION || '').trim();
const cacheDir = path.join(os.homedir(), '.claude', 'cache');

if (!session) {
  // Not launched under cl-runner (plain `claude`). Nothing can consume the
  // trigger, so say so rather than silently doing nothing.
  process.stdout.write('[cl] not running under the cl wrapper — launch with `cl` to use /switch.\n');
  process.exit(0);
}
if (action !== 'switch' && action !== 'restart') {
  process.stdout.write(`[cl] unknown action "${action}".\n`);
  process.exit(0);
}

try {
  fs.mkdirSync(cacheDir, { recursive: true });
  const triggerPath = path.join(cacheDir, `cl-${action}-${session}.trigger`);
  fs.writeFileSync(triggerPath, JSON.stringify({ at: Date.now(), target }));
  process.stdout.write(`[cl] ${action}${target ? ` → ${target}` : ''} signal sent — the wrapper will act momentarily.\n`);
} catch (e) {
  process.stdout.write(`[cl] failed to send ${action} signal: ${e.message}\n`);
}
