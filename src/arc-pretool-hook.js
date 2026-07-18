#!/usr/bin/env node
// arc-pretool-hook: the stance (/arc-mode) as an ENFORCED GATE, not just a steer.
//
// Everything else the stance governs is advice injected into the model's context — the right
// shape for it, because "act only on the user's order" is a judgment only the model can make.
// Spawning a peer is different in kind: it creates a REAL SESSION — a window, a process, its own
// quota — and an injected sentence cannot stop an agent from running a command.
//
// `arc delegate <role>` carries BOTH costs under one verb, deliberately (the agent should not
// have to know whether a peer is live — that is arc's data, not its judgment). So this gate does
// the one thing the verb hides: it checks whether the role is LIVE, and only speaks when a
// session would actually be created.
//
//   role LIVE           → defer. It is just a note: free, reversible, the commonest thing an
//                         agent does. Prompting here would be pure noise.
//   role EMPTY, passive → DENY   no session gets spawned in passive, whoever asked. A PreToolUse
//                         hook sees a tool call and CANNOT tell the user's order from the agent's
//                         own initiative — and there is deliberately no prompt-command escape
//                         hatch (a prompt would be provably the human's, but a human's natural
//                         act is prose, not a command). So passive costs you the spawn.
//   role EMPTY, balanced→ ASK    (the default) the permission prompt IS the confirmation.
//   role EMPTY, active  → ALLOW  auto-approved: you asked for an agent that staffs its own peers.
//
// BALANCED'S "ASK" IS ONLY AS REAL AS THE PROMPT — and since Claude Code 2.1.210 it is real
// everywhere. Under older builds, auto-accept mode (⏵⏵) answered permission prompts itself, so
// `ask` was approved without a human ever seeing it and balanced silently behaved like active
// (observed the first time a peer was staffed that way; for a while that was documented here as
// KNOWN AND ACCEPTED, with passive as the only real restraint). 2.1.210 changed the contract: a
// hook's `ask` now FLOORS the decision at a prompt, auto mode or not. Live-fired on 2.1.211
// (2026-07-16, the cross-board gate below): the prompt reached the human in auto mode. So every
// `ask` in this file — balanced's confirmation, the runaway guard, the cross-board gate — now
// actually reaches a person, and balanced is meaningfully distinct from active again. Still do
// NOT escalate balanced to DENY: it was a bad idea when ask was broken (it would have re-created
// a confirmation the user opted out of) and it is pointless now that ask works.
//
// RUNAWAY GUARD: even under ACTIVE it drops to ASK once several peers are live. Each is a session
// burning its own quota, and "spawn a helper" is exactly the move that looks locally reasonable
// every single time. It fails OPEN to a prompt, never to a refusal.
//
// SAFETY: this sits in front of EVERY Bash/PowerShell call, so it must be inert and must never
// wedge a session. No output (= defer to the normal flow) for anything that is not a delegate to
// an empty chair, for non-arc sessions, and on ANY error.
'use strict';

// Matches anywhere it could plausibly be a command, including inside a quoted string: it FAILS
// CLOSED on purpose, because a false positive costs at worst a prompt while a false negative lets
// a session spawn ungated.
//
// And be honest about what this is: a GUARDRAIL against an agent's own self-initiation, not a
// sandbox against a hostile one. Any command-string matcher can be walked around (build the string
// at runtime, pipe it to a shell, and no regex sees it). It exists to make the dial mean something
// for an agent that is trying to cooperate — which is every agent here — not to contain one that
// is trying not to.
// `arc delegate <role> …` — capture the ROLE, because whether this costs anything DEPENDS on it:
// delegating to a LIVE peer is just a note (free, reversible, never gated), while delegating to a
// closed or unknown one spawns a session. One verb, two costs, and the gate must tell them apart
// or it would prompt on every note (noise) or on none (a session spawned unasked).
const RX_DELEGATE = /(?:^|[\s;&|(`])arc(?:\.cmd|\.exe)?\s+delegate\s+([a-z][a-z0-9_-]*)/i;
// A note carrying --board leaves THIS repo and lands on another one's ledger. That is the only
// way anything crosses the filesystem isolation a board is built on, so it is the only arc command
// that asks in EVERY stance — including active. The dial governs how much an agent may do on ITS
// OWN board; it was never a mandate to speak on someone else's.
const RX_CROSS_BOARD = /(?:^|[\s;&|(`])arc(?:\.cmd|\.exe)?\s+note\s+[^\n]*--board[=\s]+(\S+)/i;
// A REPLY IS NOT INITIATIVE. The stance dial governs what an agent STARTS; answering a note that
// already reached you is the second half of an exchange the board exists to carry — and without
// this, the permission prompt sits INSIDE the auto-feed loop (a peer's reply arrives at turn end,
// and the answer going back would cost a human keystroke). The human's idea, verbatim (roadmap,
// 2026-07-17): "replying a note doesn't require user permission." So a VERIFIED reply is
// auto-allowed in EVERY stance, passive included — passive gates initiative, and a reply is the
// opposite of initiative. The claim is verified against the ledger, and ANY doubt defers to the
// normal permission flow: an allow must be PROVEN, a defer costs at most a prompt.
//   - the referenced note exists on THIS board (numeric seq only; an id-shaped ref defers),
//   - it was addressed to this session's role (directly, in a comma-list, or broadcast),
//   - it was written by the role being replied to (a reply goes back to its asker),
//   - and it is not our own note.
// A cross-board reply still asks: RX_CROSS_BOARD is checked FIRST and returns before this.
const RX_NOTE_REPLY = /(?:^|[\s;&|(`])arc(?:\.cmd|\.exe)?\s+note\s+([a-z][a-z0-9_-]*)\s+[^\n]*--reply-to[=\s]+#?(\d+)/i;

// AN AUTO-ALLOW MUST SCOPE TO EXACTLY THE EXEMPTED COMMAND — the one predicate both auto-allows
// (the note-reply exemption and the ACTIVE-stance delegate) run through. A hook `allow` approves the
// WHOLE Bash command, so a chained tail rides it: `arc <verb> …; rm -rf X` would auto-run the `rm`
// AND remove the very prompt that would have shown a human the tail (audit #290 caught this on the
// reply; #293 scheduled it for delegate). "Sole" means the command is ONLY that arc verb —
//   • anchored at its START (no leading `cd /other;` — which would run other work AND, for a note,
//     land on a DIFFERENT board than the ledger checks read), and
//   • free of EVERY shell control/substitution char (`; & | ` $ ( ) < >` and newlines) anywhere,
//     quoted or not — `$()` and backticks execute inside double quotes, and parsing quoting across
//     two shells is exactly the analysis a fail-closed gate must not attempt.
// A decorated command fails the test and falls back to the normal permission prompt: fail-closed
// costs a prompt, never a bypass.
function soleCommand(cmd, verb) {
  const anchored = new RegExp('^arc(?:\\.cmd|\\.exe)?\\s+' + verb + '\\b', 'i');
  return anchored.test(String(cmd || '').trim()) && !/[;&|`$()<>\r\n]/.test(String(cmd || ''));
}

const MAX_PEERS_AUTO = 3;   // beyond this, even ACTIVE asks first

function out(decision, reason, systemMessage) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  if (systemMessage) payload.systemMessage = systemMessage;
  process.stdout.write(JSON.stringify(payload));
}

function run(raw) {
  let hook = {};
  try { hook = JSON.parse(raw || '{}'); } catch { return null; }

  const tool = String(hook.tool_name || '');
  if (!/^(Bash|PowerShell)$/i.test(tool)) return null;            // not a shell call — defer
  const cmd = String((hook.tool_input && hook.tool_input.command) || '');

  // CROSS-BOARD FIRST, and unconditionally. Checked before the stance dial is even read: posting
  // onto another repo's board is not a thing a stance can pre-authorise, because the person who
  // owns that board is not necessarily the person who set this one's dial. Cheap, no board reads.
  const xb = cmd.match(RX_CROSS_BOARD);
  if (xb) {
    out('ask',
      `[arc] cross-board note → ${xb[1]}`,
      'arc: this note LEAVES this repo and lands on another board\'s ledger — the one thing that\n'
      + `  crosses the filesystem isolation peers are built on. Target: ${xb[1]}\n`
      + '  It arrives as an ANNOUNCEMENT from "<this board>/<your role>", one-way: they cannot\n'
      + '  reply to you there. Approve only if that board\'s people want to hear this.');
    return 'ask-cross-board';
  }

  // THE REPLY EXEMPTION (see RX_NOTE_REPLY above). Checked after cross-board (leaving the repo
  // outranks it) and before anything else: on success it ALLOWS — skipping the normal permission
  // prompt entirely — so every branch that is not a proven reply must fall through to defer.
  //
  // COMMAND-SCOPED, OR NOTHING (audit #290 — a real bypass, caught before it entered the record):
  // the regex match is a SUBSTRING, but an allow approves the WHOLE shell command — so a genuine
  // reply with `; rm -rf X` chained on would have ridden the exemption, and it would remove
  // exactly the prompt that shows a human the chained tail. So the allow additionally demands the
  // command be SOLELY the reply: anchored at its start (no leading `cd …;` either — a cd moves
  // the note onto a DIFFERENT board than the one the ledger checks ran against), and containing
  // NONE of the shell control/substitution characters anywhere, quoted or not — `$()` and
  // backticks execute INSIDE double quotes, and parsing quoting across two shells is exactly the
  // analysis a fail-closed gate must not attempt. A reply whose body needs those characters
  // simply defers to the normal permission prompt: fail-closed costs a prompt, never a bypass.
  const soleReply = soleCommand(cmd, 'note');
  const nr = cmd.match(RX_NOTE_REPLY);
  if (nr && !soleReply) return null;                              // chained/decorated — normal flow decides
  if (nr) {
    try {
      const session = (process.env.ARC_SESSION || '').trim();
      if (!session) return null;
      const R = require('./arc-board');
      const N = require('./arc-notes');
      const board = R.resolveBoard(N.resolveCwd(session, typeof hook.cwd === 'string' ? hook.cwd : null));
      const me = N.getRole(session, board);
      const to = nr[1].toLowerCase();
      const seq = parseInt(nr[2], 10);
      const target = R.allNotes(board)[seq - 1];
      const addressedToMe = !!me && !!target && (target.to == null || target.to === me
        || (Array.isArray(target.to) && target.to.includes(me)));
      if (me && target && addressedToMe && target.from === to && target.from !== me) {
        out('allow', `[arc] reply to #${seq} — answering a note that reached you is never gated.`);
        return 'allow-reply';
      }
    } catch { /* unproven — defer */ }
    return null;                                                  // not a PROVEN reply — normal flow decides
  }

  const m = cmd.match(RX_DELEGATE);
  if (!m) return null;                                            // not a delegate — defer, silently

  const session = (process.env.ARC_SESSION || '').trim();
  if (!session) return null;                                      // not an arc session — stay out of the way

  // WOULD THIS SPAWN? Delegating to a live peer is a NOTE — free, reversible, and gating it would
  // be pure noise on the commonest thing an agent does. Only an empty chair costs a session, and
  // that is the exact moment the dial should mean something. Fails OPEN (treat as a note) if the
  // board cannot be read: a coordination gate must never block work by being unsure.
  let spawns = false;
  try {
    const R = require('./arc-board');
    const N = require('./arc-notes');
    const board = R.resolveBoard(N.resolveCwd(session, typeof hook.cwd === 'string' ? hook.cwd : null));
    spawns = !R.liveRoles(board).some((l) => l.role === m[1].toLowerCase());
  } catch { return null; }
  if (!spawns) return null;                                       // a live peer: this is just a note

  const stance = require('./arc-stance').getStance(session);      // passive | balanced | active

  if (stance === 'passive') {
    out('deny',
      '[/arc-mode passive] The agent may not spawn peer sessions in passive mode.',
      'arc: refused — nobody holds that role, so delegating to it would SPAWN a session, and you\n'
      + '  are in PASSIVE mode.\n'
      + '  want it anyway?   /arc-mode balanced   — then ask again; you will get a prompt.\n'
      + '  (a gate sees a TOOL CALL, so it cannot tell your order from the agent\'s own idea.\n'
      + '   passive therefore refuses the spawn whoever wanted it — that is the trade.)');
    return 'deny';
  }

  if (stance === 'active') {
    // Count the peers already here. Cheap, and it fails OPEN to a prompt, never to a refusal.
    let peers = 0;
    try {
      const R = require('./arc-board');
      const N = require('./arc-notes');
      const board = R.resolveBoard(N.resolveCwd(session, typeof hook.cwd === 'string' ? hook.cwd : null));
      const me = N.getRole(session, board);
      peers = R.liveRoles(board).filter((l) => l.role !== me).length;
    } catch { /* cannot count — treat as 0 and let ACTIVE do its job */ }

    if (peers >= MAX_PEERS_AUTO) {
      out('ask',
        `[/arc-mode active] ${peers} peers are already live — asking before spawning another.`,
        `arc: ACTIVE would auto-approve this, but ${peers} peers are already on the board.\n`
        + '  each one is a session burning its own quota, so this one needs your nod.');
      return 'ask-cap';
    }
    // COMMAND-SCOPED, OR ASK (audit #293 — the last unscoped auto-allow in this gate). ACTIVE
    // auto-approves a delegate, but the `allow` blesses the WHOLE command, so a chained tail
    // (`arc delegate x "…"; rm -rf Y`) would ride it. So only auto-allow a SOLE delegate; a
    // decorated one falls to a prompt (the human then sees the tail), never denied — ACTIVE still
    // wants the delegate, it just cannot bless what is stapled to it.
    if (!soleCommand(cmd, 'delegate')) {
      out('ask',
        '[/arc-mode active] the delegate is chained to another command — approving the prompt confirms the WHOLE line.',
        'arc: ACTIVE would auto-approve a bare delegate, but this command carries more than the\n'
        + '  delegate (a shell operator: ; && | ` $() etc.). An auto-allow would bless the whole line,\n'
        + '  so this one needs your prompt — check the full command before approving.');
      return 'ask-chained';
    }
    out('allow', '[/arc-mode active] auto-approved — you asked for an agent that starts its own peers.');
    return 'allow';
  }

  // balanced (the default): the agent may propose it; approving the prompt IS the confirmation.
  out('ask',
    '[/arc-mode balanced] Nobody holds that role, so this would spawn a session — the prompt is your confirmation.',
    'arc: nobody holds that role, so the agent wants to put a session in the chair (new tab, its own\n'
    + '  quota) — reviving that peer\'s own conversation if it has one, else forking this context.\n'
    + '  approve to allow it  ·  /arc-mode active auto-approves  ·  /arc-mode passive refuses outright');
  return 'ask';
}

module.exports = { run, RX_DELEGATE, RX_NOTE_REPLY, MAX_PEERS_AUTO, soleCommand };

if (require.main === module) {
  let raw = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    // ANY failure here must be invisible: this hook runs before every shell command, and a
    // coordination nicety must never block a session's work. No output = defer to normal flow.
    try { run(raw); } catch { /* defer */ }
    process.exit(0);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
  setTimeout(finish, 500).unref();
}
