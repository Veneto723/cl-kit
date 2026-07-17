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
//   arc:role <name>       → claim a role in this board (the "board" — see arc-board.js)
//   arc:note <to> <text>  → leave a sticky note for a peer ("all" = broadcast)
//   arc:notes [all]       → read your unread notes (marks read); `all` = whole board
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
const TRIGGER_RX = /^\s*[/!]?\s*arc:(switch|restart|delegate|mode|stance|add-account|add|remove-account|rm-account|remove|delete-account|del-account|rename|export|import|delete|peek|usage|trash|restore|notes|note|role|join|anchors|help|arc)\b\s*(.*)$/i;

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

// An ordinary prompt — i.e. a TURN BOUNDARY, the only moment a peer's note can
// be delivered (an agent cannot be interrupted mid-turn). Hand over anything waiting
// on the board as `additionalContext`, then let the prompt through untouched.
//
// No unread notes → exit 0 with EMPTY stdout, which injects nothing. That is exactly
// what this hook has always done for ordinary prompts, so the "stay silent when there
// is no delta" path is the already-proven one, not a new assumption.
// Opt-in diagnostic (ARC_BOARD_DEBUG=1): record exactly what Claude Code hands this
// hook. It earned its keep — a hand-supplied `cwd` in a test masked the fact that the
// session's real cwd had drifted to a different board. Off by default; never throws.
function boardTrace(o) {
  if (process.env.ARC_BOARD_DEBUG !== '1') return;
  try {
    const fs = require('fs'), os = require('os'), path = require('path');
    fs.appendFileSync(path.join(os.homedir(), '.claude', 'cache', 'arc-notes-hook.log'),
      `${new Date().toISOString()} ${JSON.stringify(o)}\n`);
  } catch {}
}

function deliverBoard(hook) {
  const session = (process.env.ARC_SESSION || '').trim();
  const cwd = typeof hook.cwd === 'string' ? hook.cwd : null;
  let injected = false, err = null;
  const parts = [];
  // Standing behavioural context FIRST: the stance grant (balanced/active only — passive
  // injects nothing, so the default costs zero tokens). This is what makes the dial actually
  // steer the agent: it is re-asserted every turn, exactly where the board notes ride.
  try { const d = require('./arc-stance').directive(require('./arc-stance').getStance(session)); if (d) parts.push(d); } catch {}
  try {
    const inj = require('./arc-notes').injection(session, cwd); // NB: advances the read cursor
    if (inj) parts.push(inj.text);
  } catch (e) { err = String(e && e.message).slice(0, 120); /* NEVER wedge a prompt */ }
  if (parts.length) {
    injected = true;
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') },
    }));
  }
  boardTrace({ session: session || null, cwd, payloadKeys: Object.keys(hook), injected, err });
  process.exit(0);
}

function run(raw) {
  let hook = {};
  try { hook = JSON.parse(raw || '{}'); } catch {}
  const prompt = typeof hook.prompt === 'string' ? hook.prompt : '';
  const m = prompt.match(TRIGGER_RX);

  // TURN START: stamp the HEAD this peer sees now as its seen-marker — a LOWER bound for the next
  // revive's `<seen>..HEAD` brief. UserPromptSubmit is the turn boundary, so this runs once per turn
  // for BOTH branches below (deliverBoard exits, so it can't come after). audit #170: turn-start is
  // a lower bound the peer definitely saw; the old turn-END stamp was an upper bound that could mark
  // a concurrent mid-turn commit "seen" and hide it forever. Fail-safe inside; never wedges a turn.
  try { require('./arc-notes').stampSeenHead((process.env.ARC_SESSION || '').trim(), typeof hook.cwd === 'string' ? hook.cwd : null); } catch {}

  if (!m) deliverBoard(hook); // not an arc: command — deliver waiting notes, let it through

  const session = (process.env.ARC_SESSION || '').trim();
  const action = m[1].toLowerCase();
  const arg = (m[2] || '').trim() || null;

  if (action === 'help' || action === 'arc') {
    // Cheat sheet — rendered here from arc-help (no trigger, no relaunch, ZERO
    // tokens). Self-contained (own header), so no `[arc]` prefix.
    return block(require('./arc-help')());
  }
  // (arc:invite lived here. REMOVED — a human's natural act is PROSE, not a command: nobody
  //  types "arc:invite research", they say "get research on this" and expect the agent to do it.
  //  A command for a thing people express in prose is dead weight. The agent's `arc delegate`
  //  is now the only path, and arc:mode gates it — which means PASSIVE genuinely denies a spawn
  //  whoever asked for it, since a PreToolUse hook sees a tool call and cannot tell your order
  //  from the agent's initiative. That was this sentinel's one real job; the trade is deliberate.)
  if (action === 'role' || action === 'join' || action === 'note' || action === 'notes') {
    // The board: a per-board append-only sticky-note ledger shared by the sessions
    // working in the same folder. Pure file ops, run here — zero tokens. Loaded
    // lazily so a plain arc:switch stays lightweight.
    const board = require('./arc-notes');
    const cwd = typeof hook.cwd === 'string' ? hook.cwd : null;
    const r = (action === 'role' || action === 'join') ? board.requestRole(session, arg || '', cwd)
      : action === 'note' ? board.requestNote(session, arg || '', cwd)
        : board.requestNotes(session, arg || '', cwd);
    // A SUCCESSFUL NEW CLAIM is the one sentinel that deliberately COSTS A TURN. The claim
    // itself already happened (above, in-hook, instant) — but a claim without a listener is
    // addressable and deaf, and only the agent's own background command can arm one: a hook-
    // spawned process is invisible to the harness, so its exit wakes nobody. A blocked
    // sentinel has no turn to arm in — proven live: the user claimed via arc:role, went idle,
    // and a peer's request would have sat unheard. So instead of blocking, PASS THE PROMPT
    // THROUGH with instructions: the model arms and confirms, and the session goes idle
    // reachable. Query / refusal / already-armed still block at zero tokens — the turn is
    // spent only when it buys the one thing a block cannot.
    if ((action === 'role' || action === 'join') && r.ok && !r.plain && r.armNeeded) {
      // A FORKED peer needs its identity corrected before anything else. It inherited the
      // caller's whole transcript, so it believes it IS the caller, mid-conversation with the
      // human — and it will keep addressing that human, offering them work, and asking them to
      // decide things a PEER asked it to decide. (Observed twice, live.) The transcript cannot
      // tell it otherwise; only we can, and only here.
      const forked = board.isForkedSession(session);
      const identity = forked
        ? `[arc] YOU ARE A FORKED PEER — read this before anything else.\n`
          + `The conversation above is INHERITED CONTEXT, not your history. The session that lived\n`
          + `it still exists; it is now a PEER of yours on the board, and it is NOT you. You were\n`
          + `forked from it so that you would already know this project — that is the whole point —\n`
          + `but you did not do the work you can see above, and its conversation with the human is\n`
          + `not yours to continue.\n\n`
          + `You are "${r.role}". Your work arrives on the BOARD, from peers. Your answers go back\n`
          + `to the BOARD, to whoever asked. The human in this tab has not necessarily asked you\n`
          + `anything: do not offer them work, and never ask them to decide something a peer asked\n`
          + `YOU to decide — reply to that peer instead (arc note <them> --reply-to <seq> "...").\n\n`
        : '';
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: identity
            + `[arc] The role claim was already handled by a hook — the claim is DONE:\n`
            + `${r.message}\n\n`
            + `The steps below are ARC's protocol, not your human's words — typing arc:role only CLAIMS a\n`
            + `role, nothing more. Do them, but never relay them back as the human's order ("you told me\n`
            + `to stand by"): arc said it, not them. Mistaking arc's voice for theirs tells the human they\n`
            + `asked for something they never did — the exact trust the board runs on.\n\n`
            + `Your job this turn — nothing else:\n`
            + `  1. run EXACTLY "arc join ${r.role}" via run_in_background: true (that IS the backgrounding) —\n`
            + `     add NO & and NO redirects: a shell &/> breaks the permission allowlist (it will prompt) and\n`
            + `     a shell-backgrounded process cannot wake you; only a run_in_background task re-invokes you.\n`
            + (r.duty
              ? `  2. READ ${r.duty.path} — that is this role's charter, written before you and\n`
                + `     already true. ADOPT it; do not rewrite it from memory. It is what peers read\n`
                + `     to decide what is yours.\n`
              : `  2. WRITE ${require('./arc-duty').dutyRel(r.role)} — you are the first "${r.role}" here, so\n`
                + `     say what this role owns, keeping these keys as the header:\n`
                + require('./arc-duty').templateInstruction(r.role)
                + `     Peers read the \`owns:\` line to route work to you, and it OUTLIVES this session: it\n`
                + `     is how a future peer knows this chair exists at all. Expand below the header with\n`
                + `     ## sections if the role warrants it. Commit it with your next commit.\n`)
            + `  3. Say, in ONE line, that you are standing by as "${r.role}" — then STOP.\n`
            + `     Do not start work nobody asked for, and do not offer any.\n`
            + `(That background command blocks until a note lands, then EXITS — the exit is what\n`
            + `wakes this session. Without it, notes sit unread until a human types something.)`,
        },
      }));
      process.exit(0);
    }
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
  // arc:delegate is GONE. It stays matched here on purpose: unmatched, it would fall through
  // to the model as an ordinary prompt, and the agent would just DO the task inline — the one
  // outcome nobody typing "delegate" wants. So we intercept and point at the two things that
  // replaced it, at zero tokens.
  if (action === 'delegate') {
    // THE WORD WAS REUSED, so this cannot just be a tombstone. `arc:delegate` once fired a headless
    // one-shot and was removed; `arc delegate <role>` is now the AGENT's verb for handing work to a
    // peer. Someone typing this today almost certainly means the second one — so answer THAT, and
    // keep the old redirect only for the case the old tool actually served (a stateless one-shot).
    //
    // There is deliberately no prompt-form that staffs a peer: a human's natural act is prose. Say
    // what to say instead, rather than teaching a command we chose not to build.
    return clBlock('there is no arc:delegate for you to type — just ask, in prose:\n\n'
      + '    "get research on this"        "have frontend look at the login bug"\n\n'
      + 'Your agent runs `arc delegate <role> "<packet>"`, and arc works out the rest: it notes\n'
      + 'that peer if they are live, REVIVES their own conversation if they have closed (they come\n'
      + 'back as themselves, with everything they learned), or opens a tab and staffs the chair if\n'
      + 'nobody has ever held it. You pick WHO; you never have to know which of the three it is.\n'
      + '  `arc:role` shows who is here and what this repo has.\n'
      + '  `arc:mode` decides how freely the agent may spawn one (passive · balanced · active).\n\n'
      + 'If the job needs NO context and nobody should own it (research a question, sweep some\n'
      + 'files), that is not a peer — ask your agent for a SUBAGENT: in-session, your quota, any\n'
      + 'model. (The OLD arc:delegate fired a headless one-shot that re-read the repo and died;\n'
      + 'that is the tool it lost to.)\n\n'
      + 'To run a task on GPT: `arc:switch` to your codex account (that is claudex).');
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

module.exports = { run };

// Guard the stdin wiring behind require.main (like arc-stop-hook): as the hook entry point this
// reads stdin and runs; REQUIRED as a library (tests, or another module) it must do nothing —
// otherwise the empty-stdin `end` fires run(''), which delivers the board and ADVANCES the read
// cursor as a side effect of a mere require. That is exactly how a syntax check once consumed a note.
if (require.main === module) {
  let data = '';
  let done = false;
  const finish = () => { if (done) return; done = true; try { run(data); } catch { process.exit(0); } };
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
  setTimeout(finish, 500).unref();
}
