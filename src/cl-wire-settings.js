#!/usr/bin/env node
// cl-wire-settings: merge cl's hooks + statusline + switch allow-rule into
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
try {
  const raw = fs.readFileSync(settingsPath, 'utf8');
  fs.writeFileSync(settingsPath + '.bak-cl-kit', raw);
  settings = JSON.parse(raw.replace(/^﻿/, '')) || {};
} catch { /* no existing settings — start fresh */ }

// The hooks cl owns, per event. cl-switch-hook FIRST on UserPromptSubmit so the
// classifier-immune switch fallback runs before anything else.
const HOOKS = [
  { event: 'UserPromptSubmit', script: 'cl-switch-hook.js', arg: '' },
  { event: 'UserPromptSubmit', script: 'cl-notify.js', arg: 'start' },
  { event: 'Stop', script: 'cl-notify.js', arg: 'done' },
  { event: 'StopFailure', script: 'cl-notify.js', arg: 'fail' },
  { event: 'Notification', script: 'cl-notify.js', arg: 'wait' },
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

// pre-approve /switch's !-bash signal so it works in auto mode without a prompt.
settings.permissions = settings.permissions || {};
if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
const allowRule = 'Bash(node "$HOME/.claude/scripts/cl-signal.js":*)';
if (!settings.permissions.allow.includes(allowRule)) settings.permissions.allow.push(allowRule);

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
process.stdout.write(`settings.json wired (hooks + statusline + switch allow-rule)${fs.existsSync(settingsPath + '.bak-cl-kit') ? ' — backup at settings.json.bak-cl-kit' : ''}\n`);
