#!/usr/bin/env node
// arc-pretool-hook: the stance (arc:mode) as an ENFORCED GATE, not just a steer.
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
//                         own initiative — the `arc:invite` sentinel used to be the escape hatch
//                         (a prompt is provably yours), and it was removed on purpose: a human's
//                         natural act is prose, not a command. So passive costs you the spawn.
//   role EMPTY, balanced→ ASK    (the default) the permission prompt IS the confirmation.
//   role EMPTY, active  → ALLOW  auto-approved: you asked for an agent that staffs its own peers.
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
      '[arc:mode passive] The agent may not spawn peer sessions in passive mode.',
      'arc: refused — nobody holds that role, so delegating to it would SPAWN a session, and you\n'
      + '  are in PASSIVE mode.\n'
      + '  want it anyway?   arc:mode balanced   — then ask again; you will get a prompt.\n'
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
        `[arc:mode active] ${peers} peers are already live — asking before spawning another.`,
        `arc: ACTIVE would auto-approve this, but ${peers} peers are already on the board.\n`
        + '  each one is a session burning its own quota, so this one needs your nod.');
      return 'ask-cap';
    }
    out('allow', '[arc:mode active] auto-approved — you asked for an agent that starts its own peers.');
    return 'allow';
  }

  // balanced (the default): the agent may propose it; approving the prompt IS the confirmation.
  out('ask',
    '[arc:mode balanced] Nobody holds that role, so this would spawn a session — the prompt is your confirmation.',
    'arc: nobody holds that role, so the agent wants to put a session in the chair (new tab, its own\n'
    + '  quota) — reviving that peer\'s own conversation if it has one, else forking this context.\n'
    + '  approve to allow it  ·  arc:mode active auto-approves  ·  arc:mode passive refuses outright');
  return 'ask';
}

module.exports = { run, RX_DELEGATE, MAX_PEERS_AUTO };

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
