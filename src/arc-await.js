#!/usr/bin/env node
// arc-await: block until a note lands for a role, then EXIT. That exit IS the wake.
//
// WHY THIS SHAPE. arc runs claude with stdio:'inherit' on a real TTY, so it holds no handle
// to type into a live session, and Claude Code exposes no timer hook and no external prompt
// injection. Exactly one thing can pull an IDLE session back: a background command the
// session itself started, whose EXIT re-invokes the agent. A command that merely PRINTS does
// not. So "wait for a note" must be a process that stops the moment there is one.
//
// It never times out. It used to (20m), sized to outlive an `arc delegate` — a tool that no
// longer exists. A PEER answers when they answer; there is no cap to outlive, and a timeout
// would be actively harmful: the timeout exit would re-invoke the agent, which would find
// nothing, idle, get re-armed, and wake again forever — a session that never sleeps, burning
// a turn on every cycle. Blocking indefinitely costs one file poll every 2.5s instead.
//
// It does NOT mark anything read; it only observes. The waking turn is where the note is
// actually delivered (`arc notes`) — note that a wake is NOT a human prompt, so the
// turn-START injection does not fire for it. That is why the output below tells the agent to
// run `arc notes`.
//
// The Stop hook arms this automatically for any session holding a role (see arc-stop-hook),
// so being on a board IS being reachable — an agent never has to remember to listen.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const R = require('./arc-board');
const F = require('./arc-notes');

const POLL_MS = 2500;
const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');

// ---- the armed marker ---------------------------------------------------------------
// The Stop hook must not arm a SECOND waiter every time the session idles — that would pile
// up a process per turn, all waking at once on the next note. So a live waiter leaves a pid
// behind and the hook skips arming when it is still alive. Liveness (not mere existence) is
// the test: a session that crashed with a waiter running must not be deaf forever.
const awaitFile = (session) => path.join(CACHE_DIR, `arc-await-${session}.json`);

function markWaiting(session, role, pid) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(awaitFile(String(session)), JSON.stringify({ pid, role, at: Date.now() }));
  } catch { /* a marker is an optimisation, never a requirement */ }
}

function clearWaiting(session) {
  try { fs.unlinkSync(awaitFile(String(session))); } catch { /* already gone */ }
}

// ---- the offer marker ---------------------------------------------------------------
// Only the AGENT can arm a listener (a background command must belong to the session it
// wakes), so the Stop hook can ask but not do. Which means an agent that doesn't comply —
// Bash denied, or it simply ignores us — would be asked again at the end of EVERY turn,
// forever. That is the nag we already refused to build for unanswered requests, so: ask once
// per listening cycle. If it complies, isWaiting() goes true and this resets, so the next
// cycle (after a note wakes it and the waiter exits) gets a fresh offer. If it doesn't, we
// said our piece once and shut up.
const offerFile = (session) => path.join(CACHE_DIR, `arc-listen-offered-${session}.json`);

function markOffered(session) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(offerFile(String(session)), JSON.stringify({ at: Date.now() }));
  } catch { /* best effort */ }
}
function wasOffered(session) {
  try { return fs.existsSync(offerFile(String(session))); } catch { return false; }
}
// WHEN the offer was made, or null. The statusline uses the AGE to tell a genuine squat (offered
// long ago, never armed) from the ordinary arming window (offered a moment ago, arming now) — so it
// warns DEAF on the former without flashing it every turn on the latter.
function offeredAt(session) {
  try { return JSON.parse(fs.readFileSync(offerFile(String(session)), 'utf8')).at || null; } catch { return null; }
}
function clearOffered(session) {
  try { fs.unlinkSync(offerFile(String(session))); } catch { /* already gone */ }
}

// The live waiter's marker ({pid, role, at}), or null. LIVENESS is the test, not existence —
// a marker whose pid died is swept so the session re-arms instead of staying deaf forever.
// The role matters to callers: a listener armed for your OLD role hears nothing on your new
// one, so "waiting" without "waiting-as-whom" would report a deaf session as reachable.
function waitingFor(session) {
  try {
    const m = JSON.parse(fs.readFileSync(awaitFile(String(session)), 'utf8'));
    if (m && m.pid && R.isAlive(m.pid)) return m;
    clearWaiting(session);          // stale: the waiter died. Re-arm.
    return null;
  } catch { return null; }
}

// Is a waiter ALREADY listening for this session? Used by the Stop hook to stay quiet.
function isWaiting(session) { return waitingFor(session) !== null; }

// Resolve the role to wait on: an explicit arg, else this session's own claimed role.
function resolveRole(roleArg, session, board) {
  const r = String(roleArg || '').trim().toLowerCase();
  if (r) return r;
  return session ? F.getRole(session, board) : null;
}

function awaitOnce(roleArg, cwd, opts) {
  const o = opts || {};
  const tag = o.label || 'arc await';   // `arc join` listens through this too — its output should say so
  const pollMs = o.pollMs || POLL_MS;
  const write = o.write || ((l) => process.stdout.write(l + '\n'));
  const session = (process.env.ARC_SESSION || '').trim();
  const board = R.resolveBoard(cwd || process.cwd());
  const role = resolveRole(roleArg, session, board);
  if (!role) {
    process.stderr.write(`[${tag}] no role — \`arc join research\` claims one and listens.\n`);
    return Promise.resolve(1);
  }
  // SUPERSEDE the listener this session already has, if any. markWaiting overwrites the
  // marker with OUR pid — that overwrite IS the stand-down order: the old listener checks
  // marker ownership every poll (below) and exits 0 with "superseded" within one poll
  // interval. It used to be process.kill(prev.pid), which worked but reported the
  // DESIGNED displacement as a task "failed with exit code 1" — a recurring false alarm
  // the human eventually spent attention asking about (2026-07-18). A graceful stand-down
  // says what actually happened. One session, one listener, ~2.5s of benign overlap
  // (`arc await` only OBSERVES — it never advances the read cursor, so two pollers
  // cannot consume each other's wake).
  if (session) {
    markWaiting(session, role, process.pid);
    // ARMING IS THE COMPLIANCE — so the offer is fulfilled HERE, the moment the listener exists.
    //
    // It used to be cleared only when a Stop hook happened to observe a live listener, and that
    // observation is not guaranteed: the hook that asked already blocked the turn, so its next
    // firing returns immediately on stop_hook_active — and if a note lands before any LATER turn
    // ends, the listener exits without the marker ever being cleared. From then on the session is
    // deaf and the hook says "already asked this cycle" forever. It happened to the session that
    // wrote this: the DEAF statusline warning (added minutes earlier for the rate-limit squat)
    // caught it. Clearing on arm makes the cycle close where it actually closes.
    clearOffered(session);
  }

  // A listener exists to WAKE ITS SESSION — so when that session dies, it has nothing left to
  // wake and must stop. It does not stop on its own: it is a detached background process, and
  // the poll loop is happy to run forever. Every restart, close, or crash was therefore leaking
  // one node process that polls the board every 2.5s for the rest of the machine's uptime.
  // (Found by the first live peer loop: five listeners alive, most of them orphans.)
  // The session's arc-runner pid is the liveness proxy the whole board already uses for claims.
  const ownerPid = session ? F.sessionPid(session) : 0;
  const orphaned = () => ownerPid && !R.isAlive(ownerPid);

  // MY BOARD MOVED. A listener captures its folder at spawn and then polls that exact path
  // forever — so if the board dir is renamed underneath it (the .plan -> .peer migration), it
  // polls a corpse. And it is WORSE than merely missing notes: the armed marker still names a
  // LIVE pid, so the Stop hook sees "already listening" and stays quiet. The session would be
  // deaf forever while arc reported it reachable — the exact failure this whole design exists to
  // prevent. So: if the folder we were watching stops existing, EXIT. That exit wakes the
  // session, the marker clears, and the next idle re-arms on the new path. Self-healing.
  const watching = board.planDir;
  const moved = () => !fs.existsSync(watching);

  const check = () => {
    let u;
    try { u = R.unreadFor(board, role); } catch { return false; }
    if (!u.count) return false;
    write(`[${tag}] ${u.count} note(s) landed for "${role}" on the "${board.name}" board — this exit is your wake-up:`);
    for (const n of u.notes) {
      write(`  #${n.seq} from ${n.from}${n.priority === 'high' ? ' [!]' : ''}: ${String(n.body).replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    write('Read them properly (and mark them read) with:  arc notes');
    return true;
  };

  // SUPERSEDED: the marker exists but names a DIFFERENT pid — a newer listener took this
  // session's chair (see the arm block above). Stand down without touching the marker.
  const superseded = () => {
    if (!session) return false;
    const w = waitingFor(session);
    return !!(w && w.pid !== process.pid);
  };

  return new Promise((resolve) => {
    // OWNERSHIP-CHECKED clear: only remove the marker if it is still OURS. A displaced
    // listener that cleared unconditionally would delete its SUCCESSOR's marker — the
    // session would keep a live poller the Stop hook could no longer see.
    const done = (code) => {
      if (session) { const w = waitingFor(session); if (!w || w.pid === process.pid) clearWaiting(session); }
      resolve(code);
    };
    if (check()) return done(0);
    const t = setInterval(() => {
      // opts.maxPolls: a test hatch only. Nothing in production stops this early — see the
      // header on why a TIMEOUT would make a session wake forever.
      if (check()) { clearInterval(t); return done(0); }
      if (superseded()) {                                     // a newer listener holds this chair
        write(`[${tag}] superseded by a newer listener for this session — standing down.`);
        clearInterval(t); return resolve(0);                  // NOT done(): the marker is the successor's
      }
      if (orphaned()) { clearInterval(t); return done(0); }   // my session is gone: nothing to wake
      if (moved()) {                                          // my board moved: re-arm on the new one
        write(`[${tag}] the board folder moved (${watching} is gone) — exiting so this session re-arms on the new one.`);
        clearInterval(t); return done(0);
      }
      if (o.maxPolls && (o._n = (o._n || 0) + 1) >= o.maxPolls) { clearInterval(t); return done(0); }
    }, pollMs);
  });
}

module.exports = { awaitOnce, resolveRole, isWaiting, waitingFor, markWaiting, clearWaiting, awaitFile,
  markOffered, wasOffered, offeredAt, clearOffered, offerFile };

if (require.main === module) {
  awaitOnce(process.argv[2], process.cwd()).then((c) => process.exit(c));
}
