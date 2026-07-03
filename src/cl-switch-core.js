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

  // No explicit target: refuse (1) / cycle (below menuMin) / show the picker menu.
  // menuMin = min account count that triggers the numbered menu instead of a
  // blind cycle (cl-config features.switchMenuMin, default 3, floor 2).
  const menuMin = Math.max(2, (cfg.features && cfg.features.switchMenuMin) || 3);
  if (!target) {
    if (cfg.accounts.length < 2) {
      return { ok: false, switching: false,
        message: `NOT SWITCHING — only ONE account is configured (${ids}), so there is nothing to switch to. The session stays on "${current}". Add another with \`cl add-account <id>\`.` };
    }
    if (cfg.accounts.length >= menuMin) {
      return { ok: true, switching: false, menu: true,
        message: renderMenu(cfg, current, `SWITCH ACCOUNT — you're on "${current}". ${cfg.accounts.length} accounts configured:`) };
    }
    // below the menu threshold → cycle to the other
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

// Drop a picker trigger → cl-runner opens the interactive arrow-key account
// picker (zero tokens). Refuses if <2 accounts. Returns { ok, picker, message }.
function requestPicker(session) {
  if (!session) {
    return { ok: false, picker: false, message: 'NOT SWITCHING — not running under the cl wrapper (launch with `cl`).' };
  }
  let C, cfg;
  try { C = require('./cl-config'); cfg = C.loadConfig(); }
  catch (e) { return { ok: false, picker: false, message: `NOT SWITCHING — cl config unreadable (${e.message}).` }; }
  if (cfg.accounts.length < 2) {
    return { ok: false, picker: false,
      message: `NOT SWITCHING — only ONE account is configured. Add another with \`cl add-account <id>\`.` };
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `cl-pick-${session}.trigger`), JSON.stringify({ at: Date.now() }));
    return { ok: true, picker: true, message: 'opening account picker — use ↑/↓ and Enter in the terminal…' };
  } catch (e) {
    return { ok: false, picker: false, message: `picker signal FAILED — ${e.message}` };
  }
}

// Drop an add-account trigger → cl-runner kills claude and runs the guided
// browser login on the freed TTY. Requires an id (bare cl:add-account → usage,
// no trigger). `argStr` is everything after `cl:add-account` (id + flags).
function requestAddAccount(session, argStr) {
  if (!session) {
    return { ok: false, message: 'NOT running under the cl wrapper (launch with `cl`).' };
  }
  const tokens = (argStr || '').trim().split(/\s+/).filter(Boolean);
  const id = tokens.find((t) => !t.startsWith('-'));
  if (!id) {
    return { ok: false, message: 'usage: cl:add-account <id> [--label L] [--email E] [--console] [--default] — an account id is required.' };
  }
  if (!/^[a-z][a-z0-9_-]*$/i.test(id)) {
    return { ok: false, message: `invalid id "${id}" — use letters/digits/dash/underscore, starting with a letter.` };
  }
  // Reject an existing id up front (before killing claude) so an obvious mistake
  // doesn't cost a disruptive kill+relaunch.
  try {
    const C = require('./cl-config');
    if (C.findAccount(C.loadConfig(), id)) {
      return { ok: false, message: `account "${id}" already exists — pick a different id (see /cl or cl doctor).` };
    }
  } catch {}
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `cl-addacct-${session}.trigger`), JSON.stringify({ at: Date.now(), args: argStr.trim() }));
    return { ok: true, message: `adding account "${id}" — a Claude sign-in opens in your browser; log in as the NEW account. (this takes over the terminal briefly, then returns)` };
  } catch (e) {
    return { ok: false, message: `add-account signal FAILED — ${e.message}` };
  }
}

// ---- remove account (double-confirmed, pure config edit — no wrapper needed) ---
const CONFIRM_WORDS = new Set(['confirm', '--confirm', 'yes', '--yes', 'y']);
function pendingRmPath(session) { return path.join(CACHE_DIR, `cl-rmpending-${session}.json`); }

// Remove `id` from cl-config.json: backup → remove → fix references → validate
// (rollback on failure). NEVER deletes the captured credential file (recoverable).
// Returns { backup, fixes[], credFile }.
function removeAccountFromConfig(C, id) {
  const bak = C.CONFIG_PATH + '.bak-' + Date.now();
  const raw = JSON.parse(fs.readFileSync(C.CONFIG_PATH, 'utf8'));
  fs.copyFileSync(C.CONFIG_PATH, bak);
  const idx = (raw.accounts || []).findIndex((a) => a.id === id);
  if (idx === -1) throw new Error(`account "${id}" not found`);
  const removed = raw.accounts[idx];
  raw.accounts.splice(idx, 1);
  const fixes = [];
  if (Array.isArray(raw.switchOrder)) raw.switchOrder = raw.switchOrder.filter((x) => x !== id);
  if (raw.defaultAccount === id) { raw.defaultAccount = raw.accounts[0].id; fixes.push(`default → ${raw.defaultAccount}`); }
  if (raw.features && raw.features.rephraseAccount === id) { raw.features.rephraseAccount = null; fixes.push('rephrase cleared'); }
  fs.writeFileSync(C.CONFIG_PATH, JSON.stringify(raw, null, 2));
  try { C.loadConfig(); }
  catch (e) { fs.copyFileSync(bak, C.CONFIG_PATH); throw new Error(`config rejected (${e.message}) — restored`); }
  const credFile = (removed.type === 'oauth' && removed.credentials && fs.existsSync(removed.credentials)) ? removed.credentials : null;
  return { backup: bak, fixes, credFile };
}

// Two-step removal. `argStr` = "<id>" (step 1: arm + show impact) or
// "<id> confirm" (step 2: verify the fresh pending marker, then remove).
// Returns { ok, pending?, removed?, message }.
function requestRemoveAccount(session, argStr) {
  if (!session) return { ok: false, message: 'NOT running under the cl wrapper (launch with `cl`).' };
  let C, cfg;
  try { C = require('./cl-config'); cfg = C.loadConfig(); }
  catch (e) { return { ok: false, message: `cl config unreadable (${e.message}).` }; }

  const tokens = (argStr || '').trim().split(/\s+/).filter(Boolean);
  const isConfirm = tokens.some((t) => CONFIRM_WORDS.has(t.toLowerCase()));
  const id = tokens.find((t) => !t.startsWith('-') && !CONFIRM_WORDS.has(t.toLowerCase()));
  if (!id) return { ok: false, message: 'usage: cl:remove-account <id>   (then confirm) — an account id is required.' };

  const acc = C.findAccount(cfg, id);
  if (!acc) return { ok: false, message: `no account "${id}". Configured: ${cfg.accounts.map((a) => a.id).join(', ')}.` };
  if (cfg.accounts.length < 2) return { ok: false, message: `refusing to remove the LAST account ("${acc.id}") — cl needs at least one.` };

  const current = currentAccount(C, cfg, session);
  const onIt = acc.id === current
    ? '\n  ⚠ this session is CURRENTLY on it — it keeps working until you switch or exit.' : '';

  if (!isConfirm) {
    // STEP 1 — arm a short-lived pending marker and show exactly what happens.
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(pendingRmPath(session), JSON.stringify({ id: acc.id, at: Date.now() })); } catch {}
    return {
      ok: true, pending: true,
      message:
        `REMOVE account "${acc.id}"${acc.label && acc.label !== acc.id.toUpperCase() ? ` (${acc.label})` : ''}` +
        ` · ${acc.type}${acc.email ? ` · ${acc.email}` : ''}?` + onIt + '\n' +
        `  • cl-config.json is backed up first; references (switch order / default / rephrase) are auto-fixed\n` +
        `  • its captured login file is KEPT (never deleted) so removal is recoverable\n` +
        `  CONFIRM within 2 min:  cl:remove-account ${acc.id} confirm     ·     or ignore this to cancel`,
    };
  }

  // STEP 2 — require a fresh pending marker for THIS id (enforces the two-step).
  let pend = null;
  try { pend = JSON.parse(fs.readFileSync(pendingRmPath(session), 'utf8')); } catch {}
  if (!pend || pend.id !== acc.id || Date.now() - pend.at > 120_000) {
    return { ok: false, message: `no pending confirmation for "${acc.id}" (or it expired) — run \`cl:remove-account ${acc.id}\` first to review what will be removed.` };
  }
  let res;
  try { res = removeAccountFromConfig(C, acc.id); }
  catch (e) { return { ok: false, message: `remove FAILED — ${e.message}` }; }
  try { fs.unlinkSync(pendingRmPath(session)); } catch {}
  return {
    ok: true, removed: true,
    message:
      `✓ removed account "${acc.id}".${res.fixes.length ? ` (${res.fixes.join('; ')})` : ''}\n` +
      (res.credFile ? `  its login file was KEPT at ${res.credFile} — delete it yourself if you want it gone.\n` : '') +
      `  reverse it by restoring the backup: ${res.backup}`,
  };
}

// ---- delete current session (double-confirmed, moves to recoverable trash) ---
function pendingDelPath(session) { return path.join(CACHE_DIR, `cl-delpending-${session}.json`); }

// The conversation id THIS cl session is on.
function sessionConvId(session) {
  for (const p of [path.join(CACHE_DIR, `cl-state-${session}.json`), path.join(CACHE_DIR, `cl-active-${session}.json`)]) {
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); if (j.convId) return j.convId; } catch {}
  }
  return null;
}

// Two-step deletion of the CURRENT conversation. Step 1 (bare `cl:delete`) shows
// the impact and arms a 2-min pending marker; step 2 (`cl:delete confirm`) drops
// a delete trigger — cl-runner kills claude, moves the transcript to recoverable
// trash, and starts a FRESH session. Returns { ok, pending?, deleting?, message }.
function requestDelete(session, argStr) {
  if (!session) return { ok: false, message: 'NOT running under the cl wrapper (launch with `cl`).' };
  const convId = sessionConvId(session);
  if (!convId) return { ok: false, message: 'no current conversation id yet (the statusline hasn\'t bridged it) — try again in a moment.' };

  let sizeStr = '';
  try {
    const fp = require('./cl-sync').findTranscriptFile(convId);
    if (fp) { const b = fs.statSync(fp).size; sizeStr = b < 1024 ? ` (${b} B)` : b < 1048576 ? ` (${Math.round(b / 1024)} KB)` : ` (${(b / 1048576).toFixed(1)} MB)`; }
  } catch {}

  const isConfirm = (argStr || '').trim().split(/\s+/).some((t) => CONFIRM_WORDS.has(t.toLowerCase()));
  if (!isConfirm) {
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(pendingDelPath(session), JSON.stringify({ convId, at: Date.now() })); } catch {}
    return {
      ok: true, pending: true,
      message:
        `DELETE the CURRENT conversation (${convId.slice(0, 8)}${sizeStr})?\n` +
        `  • it is MOVED to recoverable trash (~/.claude/backups/cl-deleted-<ts>/), never hard-deleted\n` +
        `  • this conversation ENDS and a fresh empty session starts in its place\n` +
        `  CONFIRM within 2 min:  cl:delete confirm     ·     or ignore this to cancel`,
    };
  }

  let pend = null;
  try { pend = JSON.parse(fs.readFileSync(pendingDelPath(session), 'utf8')); } catch {}
  if (!pend || pend.convId !== convId || Date.now() - pend.at > 120_000) {
    return { ok: false, message: `no pending confirmation for this conversation (or it expired) — run \`cl:delete\` first to review.` };
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `cl-delete-${session}.trigger`), JSON.stringify({ at: Date.now(), convId }));
    fs.unlinkSync(pendingDelPath(session));
  } catch (e) { return { ok: false, message: `delete signal FAILED — ${e.message}` }; }
  return { ok: true, deleting: true, message: `deleting this conversation and starting fresh — one moment…` };
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

module.exports = { requestSwitch, requestRestart, requestPicker, requestAddAccount, requestRemoveAccount, requestDelete, currentAccount, CACHE_DIR };
