#!/usr/bin/env node
// cl-wire-settings: merge cl's hooks + statusline into
// ~/.claude/settings.json WITHOUT clobbering the user's existing entries. Called
// by the installers (install.sh today; install.ps1 keeps its own copy) so every
// platform wires the exact same set. Idempotent — safe to re-run.
//
//   node cl-wire-settings.js [scriptsDir]
//
// scriptsDir defaults to ~/.claude/scripts. Writes UTF-8 without a BOM (Node's
// JSON.parse rejects a BOM), with a trailing newline.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const scripts = (process.argv[2] || path.join(CLAUDE_DIR, 'scripts'));
const S = scripts.replace(/\\/g, '/'); // forward slashes work in a hook command on every OS
const settingsPath = path.join(CLAUDE_DIR, 'settings.json');

let settings = {};
let raw = null;
try { raw = fs.readFileSync(settingsPath, 'utf8'); } catch { /* no settings.json yet — start fresh */ }
if (raw != null) {
  // Parse BEFORE touching anything. If the user's settings.json is malformed (a
  // trailing comma, a stray edit), REFUSE — never silently overwrite their config
  // with just cl's entries. (install.ps1 aborts here too.)
  try {
    settings = JSON.parse(raw.replace(/^﻿/, '')) || {}; // tolerate a leading BOM
  } catch (e) {
    process.stderr.write(`cl-wire-settings: ${settingsPath} is not valid JSON (${e.message}).\n` +
      `  Refusing to overwrite it — fix the JSON and re-run. Nothing was changed.\n`);
    process.exit(1);
  }
  // Back up the good original only now that we know we'll modify it.
  try { fs.writeFileSync(settingsPath + '.bak-cl-kit', raw); } catch {}
}

// The hooks cl owns, per event. cl-switch-hook FIRST on UserPromptSubmit so the
// classifier-immune switch fallback runs before anything else.
// TaskCreated/TaskCompleted drive the fridge's git-derived "done" (cl-done.js). They
// fire in an ORDINARY session — no agent team, no experimental flag — because the hook
// call inside TaskUpdate sits outside any teams check. TaskCreated records the HEAD sha
// as a baseline; TaskCompleted diffs against it and posts the sticky note. Default mode
// is 'note' (never blocks); features.doneGate = 'strict' turns it into a real gate.
const HOOKS = [
  { event: 'UserPromptSubmit', script: 'cl-switch-hook.js', arg: '' },
  { event: 'UserPromptSubmit', script: 'cl-notify.js', arg: 'start' },
  { event: 'Stop', script: 'cl-notify.js', arg: 'done' },
  { event: 'StopFailure', script: 'cl-notify.js', arg: 'fail' },
  { event: 'Notification', script: 'cl-notify.js', arg: 'wait' },
  { event: 'TaskCreated', script: 'cl-done.js', arg: '' },
  { event: 'TaskCompleted', script: 'cl-done.js', arg: '' },
];

settings.hooks = settings.hooks || {};
for (const h of HOOKS) {
  const command = `node "${S}/${h.script}"${h.arg ? ' ' + h.arg : ''}`;
  const groups = Array.isArray(settings.hooks[h.event]) ? settings.hooks[h.event] : (settings.hooks[h.event] = []);
  // idempotent: skip if any existing command in this event already runs this script.
  const present = groups.some((g) => Array.isArray(g.hooks) && g.hooks.some((x) => typeof x.command === 'string' && x.command.includes(h.script)));
  if (present) continue;
  if (groups.length && Array.isArray(groups[0].hooks)) groups[0].hooks.push({ type: 'command', command });
  else groups.push({ hooks: [{ type: 'command', command }] });
}

// statusline — only if the user hasn't set one.
if (!settings.statusLine) {
  settings.statusLine = { type: 'command', command: `node "${S}/usage-monitor.js" --compact` };
}

// (No Bash allow-rule needed: switching/restarting is done via the zero-token
// `cl:switch` / `cl:restart` sentinels caught by the UserPromptSubmit hook — no
// !-bash, no classifier. The old /switch /restart slash commands were removed.)

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
process.stdout.write(`settings.json wired (hooks + statusline)${fs.existsSync(settingsPath + '.bak-cl-kit') ? ' — backup at settings.json.bak-cl-kit' : ''}\n`);
