#!/usr/bin/env node
// cl-switch-hook: a UserPromptSubmit hook that lets you switch/restart a cl
// session by TYPING a plain message — with NO Bash permission classifier in the
// path. This is the escape hatch for the deadlock where the current account is
// rate-limited: `/switch`'s !-bash needs the classifier (which runs on that same
// dead account) to be approved, so it can't run exactly when you need it most.
// Hooks run locally in the Claude Code harness, never call a model, and so work
// at 100% rate-limit.
//
// Triggers (the whole prompt, case-insensitive, leading /! optional):
//   cl:switch            → cycle to the next account
//   cl:switch <id>       → switch to a named account
//   cl:restart           → reload the wrapper + relaunch, same account
//   cl:peek              → read-only usage readout of all accounts (no switch)
//   … plus add-account / remove-account / export / import / delete
//
// On a trigger it drops the same trigger file cl-runner polls for and BLOCKS the
// prompt (decision:"block") so the text is NOT sent to the model — the reason
// string is shown to you instead. Non-trigger prompts pass through untouched.
//
// Input: hook JSON on stdin ({ prompt, session_id, ... }). CL_SESSION identifies
// the cl session. Always exits 0 (a hook error must never wedge the prompt).
'use strict';

const core = require('./cl-switch-core');

const TRIGGER_RX = /^\s*[/!]?\s*cl:(switch|restart|add-account|add|remove-account|rm-account|remove|export|import|delete|peek|usage)\b\s*(.*)$/i;

function block(reason) {
  // UserPromptSubmit: block the prompt from reaching the model, show `reason`.
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

function run(raw) {
  let hook = {};
  try { hook = JSON.parse(raw || '{}'); } catch {}
  const prompt = typeof hook.prompt === 'string' ? hook.prompt : '';
  const m = prompt.match(TRIGGER_RX);
  if (!m) process.exit(0); // not a cl: command — let the prompt through

  const session = (process.env.CL_SESSION || '').trim();
  const action = m[1].toLowerCase();
  const arg = (m[2] || '').trim() || null;

  if (action === 'peek' || action === 'usage') {
    // Read-only usage readout — rendered entirely here (no trigger, no relaunch).
    // Its message is self-contained (own header), so no `[cl]` prefix.
    const r = core.buildPeek(session);
    return block(r.message);
  }
  if (action === 'restart') {
    const r = core.requestRestart(session);
    return block(`[cl] ${r.message}`);
  }
  if (action === 'add-account' || action === 'add') {
    const r = core.requestAddAccount(session, arg || '');
    return block(`[cl] ${r.message}`);
  }
  if (action === 'remove-account' || action === 'rm-account' || action === 'remove') {
    const r = core.requestRemoveAccount(session, arg || '');
    return block(`[cl] ${r.message}`);
  }
  if (action === 'delete') {
    const r = core.requestDelete(session, arg || '');
    return block(`[cl] ${r.message}`);
  }
  if (action === 'export' || action === 'import') {
    // Pure file ops — run synchronously in the hook (zero tokens, no session
    // disruption). Loaded lazily so a plain cl:switch stays lightweight.
    const sync = require('./cl-sync');
    const r = action === 'export' ? sync.doExport(session, arg || '') : sync.doImport(session, arg || '');
    return block(`[cl] ${r.message}`);
  }
  // Bare `cl:switch` → open the interactive arrow-key picker (cl-runner renders
  // it on the freed TTY). An explicit `cl:switch <n|name>` → switch directly.
  if (!arg) {
    const r = core.requestPicker(session);
    return block(`[cl] ${r.message}`);
  }
  const r = core.requestSwitch(session, arg);
  const note = (!r.switching && !r.menu) ? '\n(typed cl:switch — no model/classifier involved, works even when rate-limited)' : '';
  return block(`[cl] ${r.message}${note}`);
}

let data = '';
let done = false;
const finish = () => { if (done) return; done = true; try { run(data); } catch { process.exit(0); } };
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', finish);
process.stdin.on('error', finish);
setTimeout(finish, 500).unref();
