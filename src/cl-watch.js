#!/usr/bin/env node
// cl-watch: emit one line per NEW unread note for a role, so a session can WAKE on a
// delegation instead of waiting for a human to prompt it.
//
// The fridge delivers notes at TURN boundaries (a human prompt), so an idle session
// never sees a delegation until someone nudges it. A DELEGATE (e.g. a `research`
// session) fixes that by running this as a BACKGROUND task / Monitor:
//
//     Monitor / background:  cl watch research
//
// Each delegation a roommate posts (`cl note research "investigate X"`) then prints a
// line here → that line is an event that re-invokes the (otherwise idle) session, which
// runs `cl notes` to read it and acts. This only OBSERVES — it never advances the read
// cursor; `cl notes` does the actual read. Each unread note is emitted once per process.
//
// It runs until stopped. The session must stay ALIVE (terminal open) — a background
// waker can pull back an idle session, but nothing can wake a closed one.
'use strict';

const R = require('./cl-room');
const F = require('./cl-fridge');

const POLL_MS = 2500;

// Resolve the role to watch: an explicit arg, else this session's own claimed role.
function resolveRole(roleArg, session, room) {
  const r = String(roleArg || '').trim().toLowerCase();
  if (r) return r;
  return session ? F.getRole(session, room) : null;
}

// One poll: emit any unread note for `role` we haven't emitted yet (never touches the
// cursor). Returns the updated `emitted` set. Pure-ish (takes/returns state) so it's
// testable without a running loop.
function poll(room, role, emitted, write) {
  let u;
  try { u = R.unreadFor(room, role); } catch { return emitted; }
  for (const n of u.notes) {
    if (emitted.has(n.seq)) continue;
    emitted.add(n.seq);
    const body = String(n.body).replace(/\s+/g, ' ').slice(0, 140);
    write(`delegation for ${role} from ${n.from}${n.priority === 'high' ? ' [!]' : ''}: ${body}`);
  }
  return emitted;
}

function run(roleArg, cwd) {
  const session = (process.env.CL_SESSION || '').trim();
  const room = R.resolveRoom(cwd || process.cwd());
  const role = resolveRole(roleArg, session, room);
  if (!role) {
    process.stderr.write('[cl watch] no role to watch — pass one (`cl watch research`) or claim one first (`cl role research`).\n');
    process.exit(1);
  }
  process.stderr.write(`[cl watch] watching room "${room.name}" for delegations to "${role}" (Ctrl+C / stop to end)\n`);
  const emitted = new Set();
  const write = (line) => process.stdout.write(line + '\n');
  poll(room, role, emitted, write);              // fire any PENDING delegation immediately
  setInterval(() => poll(room, role, emitted, write), POLL_MS);
}

module.exports = { run, poll, resolveRole };

if (require.main === module) run(process.argv[2], process.cwd());
