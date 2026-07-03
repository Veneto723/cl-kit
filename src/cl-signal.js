#!/usr/bin/env node
// Broadcaster invoked by the /switch and /restart slash commands (via their
// `!`-bash line). Its ONLY job is to validate the request against cl-config and
// drop a per-session trigger file that the cl-runner wrapper polls for.
//
// Validation happens HERE (not just in the runner) because this stdout is what
// the user actually sees in the chat: an impossible switch (single account,
// unknown target, target == current) must be refused EXPLICITLY and must NOT
// drop a trigger — otherwise the wrapper would kill + relaunch the session for
// nothing and the user would only see a vanishing wrapper line.
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
  process.stdout.write('RESULT: NOT SWITCHING — this session is not running under the cl wrapper (launch with `cl` to use /switch).\n');
  process.exit(0);
}
if (action !== 'switch' && action !== 'restart') {
  process.stdout.write(`RESULT: unknown action "${action}" — nothing happened.\n`);
  process.exit(0);
}

// /switch: validate against the live config BEFORE signaling.
if (action === 'switch') {
  let C = null, cfg = null;
  try { C = require('./cl-config'); cfg = C.loadConfig(); } catch (e) {
    process.stdout.write(`RESULT: NOT SWITCHING — cl config unreadable (${e.message}). Fix ~/.claude/cl-config.json or run \`cl setup\`.\n`);
    process.exit(0);
  }

  // Current account: this session's state file (fall back to the default).
  let current = cfg.defaultAccount;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(cacheDir, `cl-state-${session}.json`), 'utf8'));
    const acc = C.findAccount(cfg, st.account);
    if (acc) current = acc.id;
  } catch {}

  const ids = cfg.accounts.map((a) => a.id).join(', ');

  if (cfg.accounts.length < 2 && !target) {
    process.stdout.write(
      `RESULT: NOT SWITCHING — only ONE account is configured (${ids}), so there is nothing to switch to. ` +
      `The session stays on "${current}" and was NOT restarted. ` +
      `Add another account first (ask: "add a cl account ..." via the cl MCP, or run \`cl setup\`).\n`);
    process.exit(0);
  }
  if (target && !C.findAccount(cfg, target)) {
    process.stdout.write(
      `RESULT: NOT SWITCHING — no account named "${target}". Configured accounts: ${ids}. ` +
      `The session stays on "${current}" and was NOT restarted.\n`);
    process.exit(0);
  }
  if (target && C.findAccount(cfg, target).id === current) {
    process.stdout.write(
      `RESULT: NOT SWITCHING — this session is ALREADY on "${current}". Nothing happened.\n`);
    process.exit(0);
  }
  const next = C.nextAccount(cfg, current, target);
  if (!next) {
    process.stdout.write(
      `RESULT: NOT SWITCHING — no other account to cycle to (configured: ${ids}; current: "${current}"). ` +
      `The session was NOT restarted.\n`);
    process.exit(0);
  }

  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, `cl-switch-${session}.trigger`), JSON.stringify({ at: Date.now(), target }));
    process.stdout.write(`RESULT: SWITCHING "${current}" → "${next.id}" (${next.label}) — the wrapper will relaunch this conversation on it momentarily.\n`);
  } catch (e) {
    process.stdout.write(`RESULT: switch signal FAILED — ${e.message}\n`);
  }
  process.exit(0);
}

// /restart: no preconditions.
try {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, `cl-restart-${session}.trigger`), JSON.stringify({ at: Date.now() }));
  process.stdout.write('RESULT: RESTARTING — the wrapper will reload and relaunch this conversation momentarily.\n');
} catch (e) {
  process.stdout.write(`RESULT: restart signal FAILED — ${e.message}\n`);
}
