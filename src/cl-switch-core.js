// cl-switch-core: the shared validate + drop-trigger logic for switching/
// restarting a cl session. Used by BOTH entry points:
//   - cl-signal.js       (the /switch and /restart slash commands' !-bash)
//   - cl-switch-hook.js  (a UserPromptSubmit hook — classifier-immune fallback
//                          that works even when the account is rate-limited)
//
// Keeping it in one module means the two paths can never disagree about what a
// valid switch is or where the trigger file goes.
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');

// Resolve this session's CURRENT account from its state file (fallback: default).
function currentAccount(C, cfg, session) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `cl-state-${session}.json`), 'utf8'));
    const acc = C.findAccount(cfg, st.account);
    if (acc) return acc.id;
  } catch {}
  return cfg.defaultAccount;
}

// Decide + (if valid) perform a switch signal. Returns { ok, switching, message }.
// switching=true only when a trigger was actually written. Never throws.
function requestSwitch(session, target) {
  if (!session) {
    return { ok: false, switching: false,
      message: 'NOT SWITCHING — this session is not running under the cl wrapper (launch with `cl` to use switching).' };
  }
  let C, cfg;
  try { C = require('./cl-config'); cfg = C.loadConfig(); }
  catch (e) {
    return { ok: false, switching: false,
      message: `NOT SWITCHING — cl config unreadable (${e.message}). Fix ~/.claude/cl-config.json or run \`cl setup\`.` };
  }

  const current = currentAccount(C, cfg, session);
  const ids = cfg.accounts.map((a) => a.id).join(', ');
  target = target ? String(target).trim() : null;

  if (cfg.accounts.length < 2 && !target) {
    return { ok: false, switching: false,
      message: `NOT SWITCHING — only ONE account is configured (${ids}), so there is nothing to switch to. The session stays on "${current}" and was NOT restarted. Add another account first (ask "add a cl account ..." via the cl MCP, or run \`cl setup\`).` };
  }
  if (target && !C.findAccount(cfg, target)) {
    return { ok: false, switching: false,
      message: `NOT SWITCHING — no account named "${target}". Configured accounts: ${ids}. The session stays on "${current}" and was NOT restarted.` };
  }
  if (target && C.findAccount(cfg, target).id === current) {
    return { ok: false, switching: false,
      message: `NOT SWITCHING — this session is ALREADY on "${current}". Nothing happened.` };
  }
  const next = C.nextAccount(cfg, current, target);
  if (!next) {
    return { ok: false, switching: false,
      message: `NOT SWITCHING — no other account to cycle to (configured: ${ids}; current: "${current}"). The session was NOT restarted.` };
  }

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `cl-switch-${session}.trigger`), JSON.stringify({ at: Date.now(), target }));
    return { ok: true, switching: true,
      message: `SWITCHING "${current}" → "${next.id}" (${next.label}) — the wrapper will relaunch this conversation on it momentarily.` };
  } catch (e) {
    return { ok: false, switching: false, message: `switch signal FAILED — ${e.message}` };
  }
}

// Drop a restart trigger. Returns { ok, message }. Never throws.
function requestRestart(session) {
  if (!session) {
    return { ok: false, message: 'NOT RESTARTING — this session is not running under the cl wrapper (launch with `cl`).' };
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `cl-restart-${session}.trigger`), JSON.stringify({ at: Date.now() }));
    return { ok: true, message: 'RESTARTING — the wrapper will reload and relaunch this conversation momentarily.' };
  } catch (e) {
    return { ok: false, message: `restart signal FAILED — ${e.message}` };
  }
}

module.exports = { requestSwitch, requestRestart, currentAccount, CACHE_DIR };
