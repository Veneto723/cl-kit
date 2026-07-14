// arc-room: the "fridge" — a per-room, append-only sticky-note ledger shared by the
// arc sessions working in the same place.
//
// ROOM = the git repo root of the session's cwd (canonicalised), else the literal
// folder. Two sessions started anywhere inside E:\whalephone are roommates. Want a
// second pair on one repo? Give it a git worktree — a different folder is a
// different room, so the FILESYSTEM does the isolation, not a config field.
//
// The room follows the session's CURRENT cwd, which Claude Code reports per prompt
// and which can DRIFT. Moving around inside a repo is harmless (we walk up to the
// git root), but `cd`-ing into a DIFFERENT repo genuinely changes rooms — the role
// claimed in the old room stops applying, and `arc:role` will say you have none.
// That is intended ("you moved flats"), but it is surprising, so: documented.
//
// Design notes (each one earned; see docs/research/agent-handoff/SUMMARY.md):
//  * APPEND-ONLY, never consumed. Linda tuple spaces distinguish rd() (read, tuple
//    stays) from in() (take, tuple removed). This is rd()-only: a note is never
//    removed, only a per-role CURSOR advances. "Done" facts stay auditable forever.
//  * NO seq FIELD. A note's seq IS its 1-based line number. Two roommates appending
//    concurrently would both compute "last+1" and collide; a line's position cannot
//    collide. Cursor = how many lines that role has read.
//  * NO LOCKING, NO GIT CAS. Roommates share one working directory, so they share
//    one file on one filesystem: single-line O_APPEND writes are atomic between
//    processes. (git compare-and-swap only mattered for writers in different
//    clones/worktrees — which are, by definition, different rooms.)
//  * SELF-IGNORING. .plan/.gitignore is "*", so the fridge never enters the
//    project's history and the project's own .gitignore never learns it exists.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLAN_DIR = '.plan';
const NOTES = 'notes.jsonl';
const GITIGNORE_BODY =
  '# The fridge: cross-session sticky notes. Coordination scratch, not a project\n' +
  '# artifact — this ignores the whole .plan/ area (including this file), so the\n' +
  "# project's own .gitignore never needs to know it exists.\n" +
  '*\n';

// ---- room resolution ---------------------------------------------------------
// Canonicalise so E:\WhalePhone, e:\whalephone and a junction all name one room.
function canonical(p) {
  let out = p;
  try { out = fs.realpathSync.native(p); } catch { out = path.resolve(p); }
  out = path.resolve(out);
  return out.toLowerCase();   // Windows FS is case-insensitive: one room per path, any case
}

// Walk up for a .git (dir OR file — worktrees use a .git *file*). Fall back to cwd.
function repoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(startDir); // no repo — the folder IS the room
    dir = up;
  }
}

// The room a session started in `cwd` belongs to.
function resolveRoom(cwd) {
  const root = canonical(repoRoot(cwd || process.cwd()));
  // basename of a drive root ("e:\") is "" — fall back to the path so a room is
  // never nameless. (Yes, people really do keep a git repo at a drive root.)
  return { root, planDir: path.join(root, PLAN_DIR), name: path.basename(root) || root };
}

// Create .plan/ + its self-ignore. Idempotent; cheap to call every time.
function ensureRoom(room) {
  fs.mkdirSync(room.planDir, { recursive: true });
  const gi = path.join(room.planDir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE_BODY);
  return room;
}

const notesPath = (room) => path.join(room.planDir, NOTES);
const cursorPath = (room, role) => path.join(room.planDir, `cursor-${role}.json`);
const leasePath = (room, role) => path.join(room.planDir, `lease-${role}.json`);

// ---- notes -------------------------------------------------------------------
// One line = one note. `seq` is the 1-based line number, assigned at READ time.
function appendNote(room, note) {
  ensureRoom(room);
  const rec = {
    ts: new Date().toISOString(),
    from: String(note.from || 'unknown'),
    to: note.to ? String(note.to) : null,      // null = broadcast to the whole flat
    priority: note.priority === 'high' ? 'high' : 'normal',
    body: String(note.body || ''),
    refs: note.refs && typeof note.refs === 'object' ? note.refs : undefined, // {sha, files, tests, anchors}
  };
  // Single-line O_APPEND: atomic between processes on one filesystem.
  fs.appendFileSync(notesPath(room), JSON.stringify(rec) + '\n');
  return rec;
}

function allNotes(room) {
  let raw; try { raw = fs.readFileSync(notesPath(room), 'utf8'); } catch { return []; }
  const out = [];
  raw.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push({ seq: i + 1, ...JSON.parse(line) }); } catch { /* skip a torn line */ }
  });
  return out;
}

function noteCount(room) { return allNotes(room).length; }

// Highest physical record position, including a torn line. Cursors are positions
// in the append-only file, not counts of successfully parsed notes.
function latestSeq(room) {
  let raw; try { raw = fs.readFileSync(notesPath(room), 'utf8'); } catch { return 0; }
  let latest = 0;
  raw.split('\n').forEach((line, i) => { if (line.trim()) latest = i + 1; });
  return latest;
}

// ---- cursors (rd()-only: nothing is consumed, the cursor just advances) --------
// Keyed by ROLE, not session id — a restarted terminal gets a new session id but is
// still "coding in this room", and must resume where it left off, not re-read all.
function readCursor(room, role) {
  try { return JSON.parse(fs.readFileSync(cursorPath(room, role), 'utf8')).seq || 0; }
  catch { return 0; }
}
function writeCursor(room, role, seq) {
  ensureRoom(room);
  atomicWriteJson(cursorPath(room, role), { seq, at: Date.now() });
  return seq;
}

// ---- atomic state writes + a claim lock ---------------------------------------
// A lease or cursor written with a bare writeFileSync can be TORN by a crash mid-write,
// and a check-then-write claim lets TWO sessions both "win" the same role — after which
// they share a cursor and silently eat each other's notes (the exact failure this whole
// design exists to prevent). So: every state write is tmp -> fsync -> rename, and the
// claim's check+write runs under an atomic lock.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);            // atomic within one filesystem
}

// mkdir is atomic on Windows AND POSIX — the portable lock. A crashed holder must never
// wedge the room, so a lock older than LOCK_STALE_MS is broken rather than waited on.
const LOCK_STALE_MS = 10_000;
function withLock(room, name, fn) {
  const lock = path.join(room.planDir, `.lock-${name}`);
  const deadline = Date.now() + 3000;
  for (;;) {
    try { fs.mkdirSync(lock); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(lock); continue; } } catch {}
      if (Date.now() > deadline) throw new Error(`role state is locked by another session (${name})`);
      sleepSync(25);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}

// What `role` hasn't seen: addressed to it, or broadcast; never its own notes.
function unreadFor(room, role) {
  const all = allNotes(room);
  const latest = latestSeq(room);
  let cursor = readCursor(room, role);
  // FAIL-OPEN: a cursor past the end means the ledger was truncated or rewritten
  // (it is supposed to be append-only). Re-read from the start rather than silently
  // skipping notes — a duplicate note is noise; a missed one is the bug this whole
  // design exists to prevent.
  if (cursor > latest) cursor = 0;
  const notes = all.filter(
    (n) => n.seq > cursor && n.from !== role && (n.to == null || n.to === role));
  const senders = [...new Set(notes.map((n) => n.from))];
  return { cursor, count: notes.length, notes, senders, latest, total: all.length };
}

// Advance past everything currently in the ledger (called after injection).
function markRead(room, role) { return writeCursor(room, role, latestSeq(room)); }

// ---- role lease --------------------------------------------------------------
// Cursors are keyed by role, so TWO live "coding" sessions in one room would share
// a cursor and steal each other's notes. At most one live holder per (room, role).
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function roleHolder(room, role) {
  try {
    const l = JSON.parse(fs.readFileSync(leasePath(room, role), 'utf8'));
    return isAlive(l.pid) ? l : null;   // a dead holder's lease is vacant
  } catch { return null; }
}

// Returns {ok:true} if claimed, or {ok:false, holder} if a LIVE *other* session holds it.
// IDENTITY IS THE SESSION, NOT THE PID: `arc:restart` re-execs arc-runner with a NEW pid
// but the SAME ARC_SESSION, and must be able to reclaim its own role. The pid is only
// a liveness probe. (Fall back to pid comparison for leases written without a session.)
// The check and the write happen UNDER A LOCK: without it, two sessions claiming the same
// role at once both read "vacant" and both write — both believe they hold it, then share a
// cursor and eat each other's notes. `convId` records WHICH CONVERSATION took the role, so a
// later session resuming that same conversation can pick it back up (see vacantLeaseForConv).
function claimRole(room, role, pid, sessionId, convId) {
  ensureRoom(room);
  try {
    return withLock(room, `role-${role}`, () => {
      const held = roleHolder(room, role);
      if (held) {
        const same = (sessionId && held.sessionId) ? held.sessionId === sessionId : held.pid === pid;
        if (!same) return { ok: false, holder: held };
      }
      // don't lose a previously-recorded conversation when this claim doesn't name one
      const conv = convId || (held && held.convId) || null;
      atomicWriteJson(leasePath(room, role), { role, pid, sessionId: sessionId || null, convId: conv, at: Date.now() });
      return { ok: true };
    });
  } catch (e) {
    return { ok: false, holder: null, busy: true, error: String(e && e.message) };
  }
}

// The lease this CONVERSATION was working under, now vacant (its session died). That is the
// role a resumed conversation should pick back up: a relaunch mints a NEW ARC_SESSION, so the
// role would otherwise be silently lost and the session would stop receiving notes entirely.
function vacantLeaseForConv(room, convId) {
  if (!convId) return null;
  let files = [];
  try { files = fs.readdirSync(room.planDir); } catch { return null; }
  for (const f of files) {
    if (!/^lease-.+\.json$/.test(f)) continue;
    try {
      const l = JSON.parse(fs.readFileSync(path.join(room.planDir, f), 'utf8'));
      if (l.convId && l.convId === convId && !isAlive(l.pid)) return l;   // ours, and vacant
    } catch { /* torn lease = no lease */ }
  }
  return null;
}

// Who else is live in this flat right now (dead leases are ignored, not deleted —
// a crashed session's lease just goes vacant).
function liveRoles(room) {
  let files = []; try { files = fs.readdirSync(room.planDir); } catch { return []; }
  return files
    .filter((f) => /^lease-.+\.json$/.test(f))
    .map((f) => roleHolder(room, f.slice(6, -5)))
    .filter(Boolean);
}

function releaseRole(room, role, pid) {
  try {
    const l = JSON.parse(fs.readFileSync(leasePath(room, role), 'utf8'));
    if (l.pid === pid) fs.unlinkSync(leasePath(room, role));
  } catch {}
}

module.exports = {
  PLAN_DIR, GITIGNORE_BODY,
  canonical, repoRoot, resolveRoom, ensureRoom,
  notesPath, appendNote, allNotes, noteCount, latestSeq,
  readCursor, writeCursor, unreadFor, markRead,
  isAlive, roleHolder, claimRole, releaseRole, liveRoles,
  atomicWriteJson, withLock, vacantLeaseForConv,
};
