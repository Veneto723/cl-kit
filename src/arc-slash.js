'use strict';
// arc-slash: the ONE source of truth for arc's prompt-command surface. ONE form:
//
//   /arc-<verb>  — matched by arc-switch-hook (UserPromptSubmit) BEFORE the model runs,
//                  so it costs zero tokens; the / menu autocompletes it (skill stubs
//                  installed by install.ps1). Windows cannot hold `:` in a directory
//                  name, so the form is hyphenated. Machines send it too: the revive
//                  prompt (arc-invite.js) is `/arc-role <role>` — programmatic prompts
//                  reach the hook raw (measured: `claude -p "/arc-peek"` blocked).
//
// Claude Code hands the hook the RAW typed /command, not the expanded skill body —
// verified live 2026-07-18 ("Original prompt: /arc-peek" on the block label;
// docs/review/zero-token-slash-command-2026-07-18.md). The skill stub bodies exist only
// for the / menu and as a graceful fallback if the hook is ever not wired.
//
// This module is on the hook's hot path (required on every prompt): keep it tiny and
// dependency-free.

// Verb alternation shared by BOTH regexes. ORDER MATTERS, twice over:
//   - delete-account / del-account MUST precede the bare `delete` alternative, else
//     `delete-account` matches `delete` (+ `\b` at the hyphen) and misfires as a
//     CONVERSATION delete. They route to remove-account.
//   - `notes` MUST precede `note` (a plain alternation would try `note` first and only
//     backtrack; being explicit costs nothing and documents the intent).
const VERBS = 'switch|restart|delegate|mode|stance|add-account|add|remove-account|rm-account|remove|delete-account|del-account|rename|export|import|delete|peek|usage|trash|restore|notes|note|role|join|help|arc';

// STRIP-ONLY (retired 2026-07-18): the dead `arc:<verb>` prompt shape, with its old
// tolerances (leading /!, whitespace). Its one consumer is stripConvArgs, which DELETES
// leftovers from older preserved argv so they cannot replay as prose on every respawn.
// The hook must never match it.
const LEGACY_RX = new RegExp('^\\s*[/!]?\\s*arc:(' + VERBS + ')\\b\\s*(.*)$', 'i');

// The slash form — DELIBERATELY STRICT, because a blocked prompt is
// ERASED and a false positive here destroys the human's message outright (adversarial
// review 2026-07-18 reproduced the erasure class the first draft allowed):
//   COLUMN-0 anchor, no leading whitespace: Claude Code's own rule is that a slash
//     command starts at column 0 — a LEADING SPACE is the documented idiom for sending
//     slash-like text as prose, and this regex must honor it (` /arc-peek explain...`
//     passes through; the first draft's ^\s* ate it).
//   (?=\s|$) instead of \b: a hyphen is a \b boundary, so \b matched `/arc-note-taker`
//     and `/arc-switch-hook.js is broken` as commands. The lookahead requires the verb
//     to END (whitespace or end-of-prompt); multi-verb names (delete-account) are whole
//     alternatives, so they still match first by order.
//   Arg confined to the COMMAND LINE ([^\n]*): the first draft's \s*(.*)$ crossed one
//     newline, so `/arc-switch\nveneto` EXECUTED a switch with the second line as the
//     account. Now any non-empty second line fails the match and the prompt survives
//     (fail-open); a lone trailing newline from a paste is still tolerated (\s*$).
// Full alternation, not just the menu verbs — but NOT for typed aliases: a TYPED
// stub-less /command never arrives (measured live 2026-07-18: typing /arc-usage gets
// "Unknown command" client-side; the prompt never reaches UserPromptSubmit — aliases
// have no typed spelling at all). The alias arm still
// earns its place for the paths that BYPASS the input-box gate: a /command passed
// programmatically (argv, `claude -p`, a prompt file) reaches the hook raw, and
// stripConvArgs asks this same regex when deciding what to strip from respawn argv.
const SLASH_RX = new RegExp('^/arc-(' + VERBS + ')(?=\\s|$)[^\\S\\n]*([^\\n]*)\\s*$', 'i');

// The / menu: one stub per PRIMARY verb (aliases resolve in the regex, not the menu).
// `hint` renders in autocomplete; `desc` is the menu line (verified against the actual
// handlers, not just help text); `fallback` decides the stub body's behavior for the one
// case the hook is not wired (fresh machine, broken install):
//   'run'      — the verb has a terminal twin (`arc <verb>`, arc-runner) that is safe for
//                the model to execute and relay: degraded (1 turn) but CORRECT.
//   'sentinel' — stateful/destructive or hook-only; the body must NOT improvise. It points
//                the human at a clean one-line /arc-<verb> and `arc doctor`.
//   'arm'      — role only: the pass-through case. On a FRESH claim the hook deliberately
//                lets the turn run (only the model can arm the listener), so the body is
//                what the model reads — it defers to the injected [arc] context, with the
//                terminal form as the no-hook fallback.
// The partition of VERBS, made machine-checkable (a verb added to the alternation
// without a MENU/ALIASES/EXCLUDED decision is a silent half-command — dispatched by
// the regex, invisible in the menu, no stub contract; the test asserts totality).
const ALIASES = ['stance', 'add', 'rm-account', 'remove', 'delete-account', 'del-account', 'usage', 'restore', 'join', 'arc'];
const EXCLUDED = ['delegate']; // matched only so it can never leak to the model

// Arg policy. The slash form ships with autocomplete: the menu inserts
// "/arc-restart" and the human keeps typing — "/arc-restart after the build finishes"
// must NOT restart mid-build and erase the qualifier. For verbs whose handlers take no
// arg (and delete, which takes only a confirm word), an unexpected arg means "this is
// prose, not a command": FAIL OPEN, let the model see it.
const NO_ARG = new Set(['restart', 'peek', 'usage', 'help', 'arc']);
const CONFIRM_ARG_RX = /^(confirm|--confirm|yes|--yes|y)$/i;
// Verbs whose argument is a SINGLE token (a role name, an account, a stance): prose
// after them means the human kept typing past the autocomplete — "/arc-role Besides
// this function has an error..." ATE that message as an invalid role name and showed
// the roster instead (field report 2026-07-18). Shape-gate them: an arg that cannot
// possibly be the argument is prose, and prose fails OPEN to the model.
// (ROLE_SHAPE mirrors arc-notes VALID_ROLE, case-tolerant here — an exact-case
// refusal downstream is a legitimate answer to a legitimate command attempt.)
const ROLE_SHAPE = /^[a-z][a-z0-9_-]{0,23}$/i;
function slashArgOk(verb, arg) {
  const v = String(verb || '').toLowerCase();
  const a = String(arg || '').trim();
  if (!a) return true;
  if (NO_ARG.has(v)) return false;
  if (v === 'delete') return CONFIRM_ARG_RX.test(a);
  const tokens = a.split(/\s+/);
  // A lone token that fails downstream validation still DISPATCHES ("/arc-mode nope"
  // earns the helpful "unknown stance — pick one of..." refusal; a typo is a command
  // attempt, not prose). Only an arg that cannot possibly be the argument — a
  // sentence after a one-token verb — is prose.
  if (v === 'role' || v === 'join') return tokens.length === 1 && ROLE_SHAPE.test(a);
  if (v === 'mode' || v === 'stance' || v === 'switch') return tokens.length === 1;
  if (v === 'rename') return tokens.length <= 2;
  return true;
}

const MENU = [
  { verb: 'role',           hint: '[role]',                          fallback: 'arm',      desc: 'Claim a board role, or see who am I and who else is here (bare)' },
  { verb: 'notes',          hint: '[all]',                           fallback: 'run',      desc: 'Read your unread board notes now; "all" shows the whole board' },
  { verb: 'note',           hint: '<role|all> <text>',               fallback: 'run',      desc: 'Leave a sticky note for a peer; "all" broadcasts to the board' },
  { verb: 'peek',           hint: '',                                fallback: 'run',      desc: 'Show usage of every account and where a launch would land' },
  { verb: 'switch',         hint: '[account]',                       fallback: 'sentinel', desc: 'Switch account, keeping this conversation (bare opens the picker)' },
  { verb: 'restart',        hint: '',                                fallback: 'sentinel', desc: 'Reload the arc wrapper and relaunch this conversation, same account' },
  { verb: 'mode',           hint: '[passive|balanced|active]',       fallback: 'sentinel', desc: 'Set agent initiative — passive, balanced, or active (bare opens dial)' },
  { verb: 'export',         hint: '[all|global|project|id]',         fallback: 'sentinel', desc: 'Archive this conversation (or all / global / a project) to a .tgz' },
  { verb: 'import',         hint: '<archive> [dest]',                fallback: 'sentinel', desc: 'Merge exported sessions in, newer-wins; optional re-root under dest' },
  { verb: 'add-account',    hint: '[id] [--api --url <gateway>]',    fallback: 'sentinel', desc: 'Add an account — bare = wizard, id = browser login, --api = gateway' },
  { verb: 'remove-account', hint: '[account]',                       fallback: 'sentinel', desc: 'Remove an account (two-step confirm; profile moves to recoverable trash)' },
  { verb: 'rename',         hint: '[old] <new>',                     fallback: 'sentinel', desc: 'Rename an account, keeping its login and chats (one arg = this account)' },
  { verb: 'delete',         hint: '',                                fallback: 'sentinel', desc: 'Trash THIS conversation and start fresh (asks, then "confirm")' },
  { verb: 'trash',          hint: '[restore <id>|empty]',            fallback: 'sentinel', desc: 'List trashed conversations; restore one, or permanently empty the trash' },
  { verb: 'help',           hint: '',                                fallback: 'sentinel', desc: 'Show the arc command cheat sheet (zero tokens)' },
];
// Deliberately NOT in the menu (the regex still matches them, so typing them still works
// at zero tokens):
//   delegate — a tombstone that only redirects; a menu entry would advertise a command
//              the design refuses to give a human form (see arc-switch-hook).
//   join     — same code path as role, but the vocabulary split is deliberate: /arc-role
//              DECLARES (prompt), terminal `arc join` LISTENS. A menu entry blurs it.
//   restore  — pure shorthand for `trash restore <id>`; folded into /arc-trash's hint.
//   usage · add · remove · rm-account · del-account · delete-account · stance · arc —
//              aliases of peek / add-account / remove-account / mode / help.

// Render one MENU entry as its skill-stub SKILL.md (the / menu entry). The body is a
// FALLBACK ONLY: when the hook is wired (normal), a blocked prompt is erased and the body
// is never read; the body exists for the one case the hook is not active, and it must
// degrade safely per the entry's fallback class. JSON.stringify gives valid YAML
// double-quoted scalars, so descriptions may carry quotes/dashes without hand-escaping.
function stubText(e) {
  const head = '---\n'
    + `name: arc-${e.verb}\n`
    + `description: ${JSON.stringify(e.desc)}\n`
    + (e.hint ? `argument-hint: ${JSON.stringify(e.hint)}\n` : '')
    + 'disable-model-invocation: true\n'
    + '---\n\n';
  // "not wired" is not the only way here — THREE causes reach this body, and the model
  // must not misdiagnose (live smoke test 2026-07-18: a fail-open arg landed here and
  // the body's two-cause text told the model to run the command with the prose glued
  // on as bogus arguments):
  //   1. trailing prose on a no-arg verb (slashArgOk fail-open — the COMMON case),
  //   2. a multiline command (the hook matches single-line commands only, by design),
  //   3. the hook genuinely not wired (rare: fresh machine, broken install).
  const notWired = `The arc UserPromptSubmit hook normally intercepts /arc-${e.verb} BEFORE the model runs`
    + ' (zero tokens). You are reading this because ONE of: (1) the command carried extra prose it'
    + ' does not take — in that case the prose IS the user\'s real message: answer IT, do not execute'
    + ' anything; (2) the command spanned multiple lines (the hook matches single-line commands only);'
    + ' (3) the hook is not wired in this session.';
  if (e.fallback === 'run') {
    return head + notWired + ` For (2) and (3): run \`arc ${e.verb}\` (the command WITHOUT any glued-on`
      + ' prose) in this session\'s shell and relay its output verbatim. If clean one-line commands keep'
      + ' reaching you, the hook is genuinely unwired — suggest `arc doctor`.\n';
  }
  if (e.fallback === 'arm') {
    return head
      + 'arc\'s hook handles /arc-role before the model runs. On a FRESH role claim it deliberately lets\n'
      + 'this turn through so the model can arm the board listener — in that case an [arc] context block\n'
      + 'is injected this turn: FOLLOW IT exactly (arm `arc join $1` via run_in_background: true, adopt\n'
      + 'the charter, stand by in one line).\n\n'
      + 'If there is NO [arc] context above, the hook did not run: run `arc role $1` in this session\'s\n'
      + 'shell, follow what it prints, and suggest `arc doctor`. (If `$1` above reads literally —\n'
      + 'unsubstituted — bare `arc role` prints the role this session already holds; join as that.)\n';
  }
  // 'sentinel' — never improvise a stateful/destructive op from a stub.
  return head + notWired + ' Do NOT improvise this operation, whichever cause applies. For (2),'
    + ` tell the user to retype \`/arc-${e.verb}\` as ONE clean line; for (3), suggest`
    + ' `arc doctor` to get the hook rewired.\n';
}

module.exports = { VERBS, LEGACY_RX, SLASH_RX, MENU, ALIASES, EXCLUDED, slashArgOk, stubText };

// The regenerator the drift guard points at: `node src/arc-slash.js` rewrites every
// stub from MENU. Without this, a red drift test names the stale verb but offers no
// fix, and the lowest-friction path becomes weakening the guard (same require.main
// pattern as arc-wire-settings).
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', 'skills');
  for (const e of MENU) {
    const dir = path.join(root, `arc-${e.verb}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), stubText(e));
  }
  process.stdout.write(`regenerated ${MENU.length} /arc-* skill stubs under skills/\n`);
}
