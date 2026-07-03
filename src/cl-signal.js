#!/usr/bin/env node
// Broadcaster invoked by the /switch and /restart slash commands (via their
// `!`-bash line). Validates the request (via cl-switch-core) and drops a
// per-session trigger the cl-runner wrapper polls for. Its stdout is what the
// user sees in chat, so it states the outcome explicitly.
//
// IMPORTANT: this `!`-bash path goes through Claude Code's Bash permission
// classifier, which runs on the CURRENT account's model — so when that account
// is rate-limited it can fail to run at all. The classifier-immune fallback is
// the `cl:switch` / `cl:restart` UserPromptSubmit hook (cl-switch-hook.js):
// type `cl:switch` (or `cl:switch <id>`) as a plain message and it always works.
//
// Usage: node cl-signal.js <action> [target]
'use strict';

const core = require('./cl-switch-core');

const action  = (process.argv[2] || 'switch').trim();
const target  = (process.argv[3] || '').trim() || null;
const session = (process.env.CL_SESSION || '').trim();

if (action === 'restart') {
  process.stdout.write('RESULT: ' + core.requestRestart(session).message + '\n');
} else if (action === 'switch') {
  process.stdout.write('RESULT: ' + core.requestSwitch(session, target).message + '\n');
} else {
  process.stdout.write(`RESULT: unknown action "${action}" — nothing happened.\n`);
}
