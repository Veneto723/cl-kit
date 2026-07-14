#!/usr/bin/env node
// arc-switch-hook: a UserPromptSubmit hook that lets you switch/restart an arc
// session by TYPING a plain message — with NO Bash permission classifier in the
// path. It's the ONLY switch path (the old /switch and /restart slash commands were
// removed) precisely because it sidesteps a deadlock: a slash command's !-bash
// needs the safety classifier, which runs on the CURRENT account — so when that
// account is rate-limited, it can't run exactly when you need it most. Hooks run
// locally in the Claude Code harness, never call a model, and so work at 100%
// rate-limit.
//
// Triggers (the whole prompt, case-insensitive, leading /! optional):
//   arc:switch            → cycle to the next account
//   arc:switch <id>       → switch to a named account
//   arc:restart           → reload the wrapper + relaunch, same account
//   arc:help  (arc:arc)     → print the command cheat sheet (zero tokens)
//   arc:role <name>       → claim a role in this room (the "fridge" — see arc-room.js)
//   arc:note <to> <text>  → leave a sticky note for a roommate ("all" = broadcast)
//   arc:notes [all]       → read your unread notes (marks read); `all` = whole fridge
//   arc:anchors [reseal]  → which doc claims about the code have gone STALE (see arc-anchor.js)
//   arc:peek              → read-only usage readout of all accounts (no switch)
//   arc:remove-account <id> → remove an account (alias: arc:delete-account <id>)
//   … plus add-account / export / import / delete (delete = the current CHAT)
//
// On a trigger it drops the same trigger file arc-runner polls for and BLOCKS the
// prompt (decision:"block") so the text is NOT sent to the model — the reason
// string is shown to you instead. Non-trigger prompts pass through untouched.
//
// Input: hook JSON on stdin ({ prompt, session_id, ... }). ARC_SESSION identifies
// the arc session. Always exits 0 (a hook error must never wedge the prompt).
'use strict';

const core = require('./arc-switch-core');

// NOTE: delete-account / del-account MUST precede the bare `delete` alternative,
// else `arc:delete-account` matches `delete` (+ `\b` at the hyphen) and misfires as
// a CONVERSATION delete. They route to remove-account (account removal), not delete.
// `notes` MUST precede `note` (a plain alternation would try `note` first and only
// backtrack; being explicit costs nothing and documents the intent).
// `arc:` is the current prefix; `arc:` is kept as a deprecated alias through the
// migration so running sessions and muscle memory don't break.
const TRIGGER_RX = /^\s*[/!]?\s*arc:(switch|restart|delegate|mode|stance|add-account|add|remove-account|rm-account|remove|delete-account|del-account|rename|export|import|delete|peek|usage|trash|restore|notes|note|role|anchors|help|arc)\b\s*(.*)$/i;

function block(reason) {
  // UserPromptSubmit: block the prompt from reaching the model, show `reason`.
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

// ---- consistent arc: alert colours -------------------------------------------
// One palette across every arc: message: RED = destructive, GREEN = success,
// CYAN = neutral action, YELLOW = refusal/error (the default). The host renders
// ANSI in the block reason but re-emits each display row, dropping colour across a
// soft-wrap — so paint() re-applies the colour PER LINE.
const CLR = { red: '\x1b[1;91m', green: '\x1b[1;92m', cyan: '\x1b[1;96m', yellow: '\x1b[1;93m', rst: '\x1b[0m' };
function alertColor(msg) {
  if (/^✓/.test(msg)) return CLR.green;                                       // completed
  if (/REMOVE account|DELETE the CURRENT conversation|EMPTY TRASH|⚠/.test(msg)) return CLR.red;  // destructive
  if (/^(SWITCHING|RESTARTING|opening|adding|deleting)\b/i.test(msg)) return CLR.cyan; // in-progress
  return CLR.yellow;                                                          // refusal / error / hint
}
function paint(text, ansi) {
  return String(text).split('\n').map((l) => (l ? ansi + l + CLR.rst : '')).join('\n');
}
// Block with the "[arc] " prefix and a semantic colour applied to the message body.
function clBlock(message) {
  return block(`[arc] ${paint(message, alertColor(message))}`);
}

// An ordinary prompt — i.e. a TURN BOUNDARY, the only moment a roommate's note can
// be delivered (an agent cannot be interrupted mid-turn). Hand over anything waiting
// on the fridge as `additionalContext`, then let the prompt through untouched.
//
// No unread notes → exit 0 with EMPTY stdout, which injects nothing. That is exactly
// what this hook has always done for ordinary prompts, so the "stay silent when there
// is no delta" path is the already-proven one, not a new assumption.
// Opt-in diagnostic (ARC_FRIDGE_DEBUG=1): record exactly what Claude Code hands this
// hook. It earned its keep — a hand-supplied `cwd` in a test masked the fact that the
// session's real cwd had drifted to a different room. Off by default; never throws.
function fridgeTrace(o) {
  if (process.env.ARC_FRIDGE_DEBUG !== '1') return;
  try {
    const fs = require('fs'), os = require('os'), path = require('path');
    fs.appendFileSync(path.join(os.homedir(), '.claude', 'cache', 'arc-fridge-hook.log'),
      `${new Date().toISOString()} ${JSON.stringify(o)}\n`);
  } catch {}
}

function deliverFridge(hook) {
  const session = (process.env.ARC_SESSION || '').trim();
  const cwd = typeof hook.cwd === 'string' ? hook.cwd : null;
  let injected = false, err = null;
  const parts = [];
  // Standing behavioural context FIRST: the stance grant (balanced/active only — passive
  // injects nothing, so the default costs zero tokens). This is what makes the dial actually
  // steer the agent: it is re-asserted every turn, exactly where the fridge notes ride.
  try { const d = require('./arc-stance').directive(require('./arc-stance').getStance(session)); if (d) parts.push(d); } catch {}
  try {
    const inj = require('./arc-fridge').injection(session, cwd); // NB: advances the read cursor
    if (inj) parts.push(inj.text);
  } catch (e) { err = String(e && e.message).slice(0, 120); /* NEVER wedge a prompt */ }
  if (parts.length) {
    injected = true;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') },
    }));
  }
  fridgeTrace({ session: session || null, cwd, payloadKeys: Object.keys(hook), injected, err });
  process.exit(0);
}

function run(raw) {
  let hook = {};
  try { hook = JSON.parse(raw || '{}'); } catch {}
  const prompt = typeof hook.prompt === 'string' ? hook.prompt : '';
  const m = prompt.match(TRIGGER_RX);
  if (!m) deliverFridge(hook); // not an arc: command — deliver waiting notes, let it through

  const session = (process.env.ARC_SESSION || '').trim();
  const action = m[1].toLowerCase();
  const arg = (m[2] || '').trim() || null;

  if (action === 'help' || action === 'arc') {
    // Cheat sheet — rendered here from arc-help (no trigger, no relaunch, ZERO
    // tokens). Self-contained (own header), so no `[arc]` prefix.
    return block(require('./arc-help')());
  }
  if (action === 'role' || action === 'note' || action === 'notes') {
    // The fridge: a per-room append-only sticky-note ledger shared by the sessions
    // working in the same folder. Pure file ops, run here — zero tokens. Loaded
    // lazily so a plain arc:switch stays lightweight.
    const fridge = require('./arc-fridge');
    const cwd = typeof hook.cwd === 'string' ? hook.cwd : null;
    const r = action === 'role' ? fridge.requestRole(session, arg || '', cwd)
      : action === 'note' ? fridge.requestNote(session, arg || '', cwd)
        : fridge.requestNotes(session, arg || '', cwd);
    return r.plain ? block(r.message) : clBlock(r.message);
  }
  if (action === 'anchors') {
    // Doc-vs-code staleness readout. Pure file ops + a git grep — zero tokens.
    const cwd = typeof hook.cwd === 'string' ? hook.cwd : null;
    const r = require('./arc-anchor').requestAnchors(session, arg || '', cwd);
    return r.plain ? block(r.message) : clBlock(r.message);
  }
  if (action === 'peek' || action === 'usage') {
    // Read-only usage readout — rendered entirely here (no trigger, no relaunch).
    // Its message is self-contained (own header), so no `[arc]` prefix.
    const r = core.buildPeek(session);
    return block(r.message);
  }
  if (action === 'restart') {
    const r = core.requestRestart(session);
    return clBlock(r.message);
  }
  if (action === 'delegate') {
    // Fire a HEADLESS run on the chosen runtime; the result comes back as a fridge note.
    // The delegate runs ALONGSIDE you — you keep the session and keep working.
    //   arc:delegate <claude|codex> [--advisor] [--model <id>] <task>
    const D = require('./arc-delegate');
    const spec = D.parseDelegateSpec(arg || '');
    if (!spec) {
      return clBlock('usage: arc:delegate <claude|codex> [--advisor] [--model <id>] <task>\n'
        + '  do it:     arc:delegate codex "find why the import test is flaky"\n'
        + '  review it:  arc:delegate claude --advisor --model claude-fable-5 "review my migration plan: …"\n'
        + '  --advisor = READ-ONLY review with an APPROVE/REVISE verdict. It runs in the BACKGROUND;\n'
        + '  the result lands on the fridge — you keep working.');
    }
    const room = require('./arc-room').resolveRoom(typeof hook.cwd === 'string' ? hook.cwd : process.cwd());
    const myRole = require('./arc-fridge').getRole(session, room);
    // QUOTA FOLLOWS THE CALLER: a claude delegate inherits THIS session's account unless
    // --account says otherwise. Delegating to your own agent must not jump quotas silently.
    const account = spec.account || process.env.ARC_RUNTIME_ACCOUNT || null;
    D.spawnDelegate(spec.runtime, room.root, spec.task, { toRole: myRole, session, advisor: spec.advisor, model: spec.model, account });
    const on = (spec.runtime === 'claude' && account) ? ` on "${account}"` : '';
    const what = spec.advisor ? `asked ${spec.runtime}${spec.model ? ` (${spec.model})` : ''}${on} to REVIEW` : `delegated to ${spec.runtime}${spec.model ? ` (${spec.model})` : ''}${on}`;
    return clBlock(`✓ ${what} — "${spec.task.slice(0, 56)}${spec.task.length > 56 ? '…' : ''}"\n`
      + `  running in the BACKGROUND; you keep working. ${spec.advisor ? 'The verdict' : 'The result'} lands on the fridge`
      + (myRole ? ` for "${myRole}"` : ' as a broadcast (claim a role with arc:role to have it addressed to you)') + '.\n'
      + `  arc hands it to this session automatically at the end of a turn — you do not have to ask for it.`);
  }
  if (action === 'mode' || action === 'stance') {
    // The initiative dial: passive · balanced · active. `arc:mode <value>` sets it directly
    // (zero tokens, no relaunch); a bare `arc:mode` opens the ←/→ bar picker.
    const St = require('./arc-stance');
    const set = (arg || '').trim().toLowerCase();
    if (!set) return clBlock(core.requestModePicker(session).message);
    if (!St.STANCES.includes(set)) {
      return clBlock(`unknown stance "${set}" — pick one of: ${St.STANCES.join(' · ')}\n  ${St.renderBar(St.getStance(session))}`);
    }
    St.setStance(session, set);
    return clBlock(`✓ stance: ${set}\n  ${St.renderBar(set)}\n  ${St.summary(set)}`);
  }
  if (action === 'add-account' || action === 'add') {
    const r = core.requestAddAccount(session, arg || '');
    return clBlock(r.message);
  }
  if (action === 'remove-account' || action === 'rm-account' || action === 'remove'
      || action === 'delete-account' || action === 'del-account') {
    const r = core.requestRemoveAccount(session, arg || '');
    return clBlock(r.message);
  }
  if (action === 'rename') {
    const r = core.requestRename(session, arg || '');
    return clBlock(r.message);
  }
  if (action === 'delete') {
    const r = core.requestDelete(session, arg || '');
    return clBlock(r.message);
  }
  if (action === 'trash' || action === 'restore') {
    // Trash management — pure file ops handled synchronously here (zero tokens).
    // arc:restore <id> is shorthand for arc:trash restore <id>. List results are
    // self-contained readouts (plain), everything else gets the alert colours.
    const r = core.requestTrash(session, action === 'restore' ? `restore ${arg || ''}`.trim() : (arg || ''));
    return r.plain ? block(r.message) : clBlock(r.message);
  }
  if (action === 'export' || action === 'import') {
    // Pure file ops — run synchronously in the hook (zero tokens, no session
    // disruption). Loaded lazily so a plain arc:switch stays lightweight.
    const sync = require('./arc-sync');
    const r = action === 'export' ? sync.doExport(session, arg || '') : sync.doImport(session, arg || '');
    return clBlock(r.message);
  }
  // Bare `arc:switch` → open the interactive arrow-key picker (arc-runner renders
  // it on the freed TTY). An explicit `arc:switch <n|name>` → switch directly.
  if (!arg) {
    const r = core.requestPicker(session);
    return clBlock(r.message);
  }
  const r = core.requestSwitch(session, arg);
  const note = (!r.switching && !r.menu) ? '\n(typed arc:switch — no model/classifier involved, works even when rate-limited)' : '';
  return clBlock(`${r.message}${note}`);
}

let data = '';
let done = false;
const finish = () => { if (done) return; done = true; try { run(data); } catch { process.exit(0); } };
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', finish);
process.stdin.on('error', finish);
setTimeout(finish, 500).unref();
