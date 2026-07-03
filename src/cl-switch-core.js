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
// switching=true only when a trigger was actually written. `menu:true` marks a
// picker listing (no switch happened — the user should choose). Never throws.
//
// `target` may be an account id/name OR a 1-based number from the menu. With no
// target: 1 account → refuse; 2 accounts → cycle to the other; 3+ → show the menu
// (can't sensibly auto-pick — this is the "hard to recall names" case).

// Numbered picker of all accounts, current marked. Numbers match resolveTarget.
function renderMenu(cfg, current, lead) {
  const rows = cfg.accounts.map((a, i) => {
    const mark = a.id === current ? '  ← current' : '';
    return `  ${i + 1}. ${a.id}${a.label && a.label !== a.id.toUpperCase() ? ` (${a.label})` : ''} [${a.type}]${mark}`;
  });
  return `${lead}\n${rows.join('\n')}\n` +
    `Pick by number or name: \`/switch <n|name>\`  (or \`cl:switch <n|name>\` — works even when rate-limited).`;
}

// Resolve a target token to an account: a 1-based menu number, or an id/name.
function resolveTarget(C, cfg, target) {
  if (/^\d+$/.test(target)) {
    const idx = parseInt(target, 10) - 1;
    return (idx >= 0 && idx < cfg.accounts.length) ? cfg.accounts[idx] : null;
  }
  return C.findAccount(cfg, target);
}

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

  // No explicit target: refuse (1) / cycle (2) / show the picker menu (3+).
  if (!target) {
    if (cfg.accounts.length < 2) {
      return { ok: false, switching: false,
        message: `NOT SWITCHING — only ONE account is configured (${ids}), so there is nothing to switch to. The session stays on "${current}". Add another with \`cl add-account <id>\`.` };
    }
    if (cfg.accounts.length >= 3) {
      return { ok: true, switching: false, menu: true,
        message: renderMenu(cfg, current, `SWITCH ACCOUNT — you're on "${current}". ${cfg.accounts.length} accounts configured:`) };
    }
    // exactly 2 → cycle to the other
    const next = C.nextAccount(cfg, current, null);
    if (!next) return { ok: false, switching: false, message: `NOT SWITCHING — no other account to cycle to (current: "${current}").` };
    return writeSwitch(session, current, next);
  }

  // Explicit target (number or name).
  const acc = resolveTarget(C, cfg, target);
  if (!acc) {
    return { ok: false, switching: false, menu: true,
      message: renderMenu(cfg, current, `NOT SWITCHING — "${target}" is not a valid account number or name. Choose one:`) };
  }
  if (acc.id === current) {
    return { ok: false, switching: false,
      message: `NOT SWITCHING — this session is ALREADY on "${current}". Nothing happened.` };
  }
  return writeSwitch(session, current, acc);
}

// Write the switch trigger carrying the RESOLVED account id (so a menu number is
// already turned into an id before cl-runner sees it).
function writeSwitch(session, current, next) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `cl-switch-${session}.trigger`), JSON.stringify({ at: Date.now(), target: next.id }));
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
