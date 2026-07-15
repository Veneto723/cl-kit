#!/usr/bin/env node
// arc-wire-settings: the ~/.claude/settings.json merge substrate. Merges hook +
// statusline entries WITHOUT clobbering the user's existing config. Idempotent,
// refuses to touch malformed JSON, writes UTF-8 without a BOM.
//
// Used two ways:
//   • library  — mergeHooks() / readSettings() / writeSettings() are the reusable
//                merge contract the bundle installer (arc-bundle.js) rides on.
//   • CLI      — `node arc-wire-settings.js [scriptsDir]` wires arc's own core hooks
//                + statusline (scriptsDir defaults to ~/.claude/scripts).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const settingsPathDefault = path.join(CLAUDE_DIR, 'settings.json');

// Read settings.json. Returns { settings, raw }. THROWS on malformed JSON so callers
// never silently overwrite a user's config with just their own entries.
function readSettings(settingsPath = settingsPathDefault) {
  let raw = null;
  try { raw = fs.readFileSync(settingsPath, 'utf8'); } catch { return { settings: {}, raw: null }; }
  let settings;
  try { settings = JSON.parse(raw.replace(/^﻿/, '')) || {}; } // tolerate a leading BOM
  catch (e) { throw new Error(`${settingsPath} is not valid JSON (${e.message}) — refusing to overwrite it.`); }
  return { settings, raw };
}

// Write settings back (UTF-8, no BOM, trailing newline). Backs up the prior good copy.
function writeSettings(settingsPath, settings, raw) {
  if (raw != null) { try { fs.writeFileSync(settingsPath + '.bak-arc', raw); } catch {} }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

// Merge hook entries into settings.hooks, idempotently and without clobbering.
// entries: [{ event, command, match? }]. `match` (default: the whole command) is the
// substring used to detect an already-present entry — pass a stable script path so a
// re-install with a moved scripts dir still dedups. New entries append into the FIRST
// matcher group of the event (co-locating with the user's matchers). Returns #added.
function mergeHooks(settings, entries) {
  settings.hooks = settings.hooks || {};
  let added = 0;
  for (const e of entries) {
    const groups = Array.isArray(settings.hooks[e.event]) ? settings.hooks[e.event] : (settings.hooks[e.event] = []);
    const match = e.match || e.command;
    const present = groups.some((g) => Array.isArray(g.hooks) && g.hooks.some((x) => typeof x.command === 'string' && x.command.includes(match)));
    if (present) continue;
    // A MATCHER is not decoration on PreToolUse — it is what stops the hook from spawning node
    // on EVERY tool call (Read, Grep, Edit, …), which would tax every action in the session to
    // police one command. So a matched entry lives in its OWN group and never gets folded into
    // an unmatched one.
    if (e.matcher) {
      const g = groups.find((x) => x.matcher === e.matcher && Array.isArray(x.hooks));
      if (g) g.hooks.push({ type: 'command', command: e.command });
      else groups.push({ matcher: e.matcher, hooks: [{ type: 'command', command: e.command }] });
      added++;
      continue;
    }
    if (groups.length && Array.isArray(groups[0].hooks) && !groups[0].matcher) groups[0].hooks.push({ type: 'command', command: e.command });
    else groups.push({ hooks: [{ type: 'command', command: e.command }] });
    added++;
  }
  return added;
}

// Set the statusline command only if the user has none of their own.
function setStatusline(settings, command) {
  if (!settings.statusLine) { settings.statusLine = { type: 'command', command }; return true; }
  return false;
}

// arc's own core hooks, as merge entries relative to a scripts dir.
// arc-switch-hook FIRST on UserPromptSubmit so the classifier-immune switch runs first.
// TaskCreated/TaskCompleted drive the board's git-derived "done" (arc-done.js).
function coreHookEntries(scriptsDir) {
  const S = scriptsDir.replace(/\\/g, '/'); // forward slashes work in a hook command
  const H = [
    ['UserPromptSubmit', 'arc-switch-hook.js', ''],
    ['UserPromptSubmit', 'arc-notify.js', 'start'],
    // arc-stop-hook BEFORE arc-notify on Stop: the board's second delivery point. It can
    // block the stop to hand over a note that landed MID-TURN (e.g. a peer's reply),
    // so the session never goes idle on top of an unread answer it asked for.
    ['Stop', 'arc-stop-hook.js', ''],
    ['Stop', 'arc-notify.js', 'done'],
    ['StopFailure', 'arc-notify.js', 'fail'],
    ['Notification', 'arc-notify.js', 'wait'],
    ['TaskCreated', 'arc-done.js', ''],
    ['TaskCompleted', 'arc-done.js', ''],
  ];
  const entries = H.map(([event, script, arg]) => ({ event, script, command: `node "${S}/${script}"${arg ? ' ' + arg : ''}` }));
  // The stance gate for `arc delegate`. MATCHED to the shell tools only: unmatched, it would spawn
  // node on every Read/Grep/Edit in the session to police one command. A session may be handed
  // EITHER shell tool (the first invited peer had PowerShell and no Bash at all), so both.
  entries.push({
    event: 'PreToolUse', script: 'arc-pretool-hook.js', matcher: 'Bash|PowerShell',
    command: `node "${S}/arc-pretool-hook.js"`,
  });
  return entries;
}

// Wire arc's core hooks + statusline into settings.json.
// The BOARD commands an agent must be able to run UNATTENDED. Found by the first live
// staffing a peer: the new session's whole job is to arm its listener with nobody watching —
// it sat forever at a Bash permission prompt instead, claimed but deaf. The same prompt would
// wedge every Stop-hook re-arm in an unattended session. These are coordination commands
// (claim, listen, read, post) — nothing destructive is on this list, and `arc delegate` is
// deliberately NOT: it is the one verb that can spawn a session, so it stays gated by arc:mode.
// EVERY shell tool, not just Bash. A session does not always get the Bash tool: the first
// INVITED peer reported `No such tool available: Bash` and had only PowerShell — so a Bash-only
// allowlist matched nothing, `arc join` raised a permission prompt, and the tab sat there
// claimed-but-deaf. That is precisely the failure this allowlist exists to prevent, so it must
// cover whichever shell the harness hands the session. (Found by the scout peer, in its own
// runtime.)
const BOARD_COMMANDS = ['arc join', 'arc await', 'arc role', 'arc notes', 'arc note'];
const SHELL_TOOLS = ['Bash', 'PowerShell'];
const BOARD_PERMISSIONS = SHELL_TOOLS.flatMap((tool) =>
  BOARD_COMMANDS.flatMap((cmd) => [`${tool}(${cmd}:*)`, `${tool}(${cmd})`]));

function mergePermissions(settings, allow) {
  if (!settings.permissions || typeof settings.permissions !== 'object') settings.permissions = {};
  const cur = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : (settings.permissions.allow = []);
  for (const p of allow) if (!cur.includes(p)) cur.push(p);
  return settings;
}

function wireArcSettings(scriptsDir = path.join(CLAUDE_DIR, 'scripts'), settingsPath = settingsPathDefault) {
  const { settings, raw } = readSettings(settingsPath);
  mergeHooks(settings, coreHookEntries(scriptsDir));
  mergePermissions(settings, BOARD_PERMISSIONS);
  setStatusline(settings, `node "${scriptsDir.replace(/\\/g, '/')}/usage-monitor.js" --compact`);
  writeSettings(settingsPath, settings, raw);
  return { settingsPath, backedUp: raw != null };
}

module.exports = { readSettings, writeSettings, mergeHooks, mergePermissions, BOARD_PERMISSIONS, setStatusline, coreHookEntries, wireArcSettings };

if (require.main === module) {
  try {
    const r = wireArcSettings(process.argv[2] || path.join(CLAUDE_DIR, 'scripts'));
    process.stdout.write(`settings.json wired (hooks + statusline)${r.backedUp ? ' — backup at settings.json.bak-arc' : ''}\n`);
  } catch (e) {
    process.stderr.write(`arc-wire-settings: ${e.message}\n  Nothing was changed.\n`);
    process.exit(1);
  }
}
