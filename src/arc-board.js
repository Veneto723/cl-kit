// arc-board: the BOARD — an append-only sticky-note ledger shared by the arc sessions
// working in the same place. Sessions that share a board are PEERS; each occupies a ROLE
// by writing a CLAIM. Those four words are the whole vocabulary.
//
// A BOARD = the git repo root of the session's cwd (canonicalised), else the literal
// folder. Two sessions started anywhere inside E:\whalephone are peers. Want a
// second pair on one repo? Give it a git worktree — a different folder is a
// different board, so the FILESYSTEM does the isolation, not a config field.
//
// The board follows the session's CURRENT cwd, which Claude Code reports per prompt
// and which can DRIFT. Moving around inside a repo is harmless (we walk up to the
// git root), but `cd`-ing into a DIFFERENT repo genuinely changes boards — the role
// claimed in the old board stops applying, and `arc:role` will say you have none.
// That is intended ("you moved flats"), but it is surprising, so: documented.
//
// Design notes (each one earned; see docs/research/agent-handoff/SUMMARY.md):
//  * APPEND-ONLY, never consumed. Linda tuple spaces distinguish rd() (read, tuple
//    stays) from in() (take, tuple removed). This is rd()-only: a note is never
//    removed, only a per-role CURSOR advances. "Done" facts stay auditable forever.
//  * NO seq FIELD. A note's seq IS its 1-based line number. Two peers appending
//    concurrently would both compute "last+1" and collide; a line's position cannot
//    collide. Cursor = how many lines that role has read.
//  * NO LOCKING, NO GIT CAS. Peers share one working directory, so they share
//    one file on one filesystem: single-line O_APPEND writes are atomic between
//    processes. (git compare-and-swap only mattered for writers in different
//    clones/worktrees — which are, by definition, different boards.)
//  * SELF-IGNORING. .peer/.gitignore is "*", so the board never enters the
//    project's history and the project's own .gitignore never learns it exists.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// THE BOARD FOLDER: .arc/peer/
//
// Everything arc puts in a repo now lives under ONE `.arc/`, and the split inside it is the
// design, not an accident:
//   .arc/roles/<role>.md   COMMITTED   what a role owns. A project fact — same on every machine,
//                                      true whether or not anyone is in that chair.
//   .arc/peer/             IGNORED     the board: notes, cursors, claims. Machine state — a
//                                      claim is a PID, and a PID means nothing on your other PC.
// `.arc/peer/.gitignore` is `*`, so the board self-ignores while `.arc/roles/` commits normally.
// One folder, two lifetimes, each declaring its own.
//
// It was `.plan` until 2026-07-15 — a name left from before the room->board rename, confusing
// enough that it had to be explained out loud ("there is no .board; .plan IS the board").
//
// Renaming it moves LIVE STATE, which is the dangerous kind, so:
//   * READ falls back through LEGACY_DIRS, so the ledger is never invisible for even one call
//     between a deploy and the first write. A board that reports "no notes" when it has 38 is a
//     lie, and the silent kind.
//   * ensureBoard MIGRATES on the next write with ONE atomic rename — the whole ledger, every
//     cursor and claim, arrives intact; nothing is copied and it cannot half-finish.
// After that the fallback is a couple of failed stats, forever. No permanent shim, no data loss,
// no window where two sessions write to different folders and silently stop seeing each other.
const PLAN_DIR = path.join('.arc', 'peer');
// Newest first. A machine that skipped a hop (home still on `.plan`) migrates straight here.
const LEGACY_DIRS = ['.peer', '.plan'];
const NOTES = 'notes.jsonl';
const GITIGNORE_BODY =
  '# The board: cross-session sticky notes. Coordination scratch, not a project\n' +
  '# artifact — this ignores the whole .arc/peer/ area (including this file), so\n' +
  "# the project's own .gitignore never needs to know it exists. Its sibling\n" +
  '# .arc/roles/ is NOT ignored: a role\'s duty is a project fact and commits.\n' +
  '*\n';

// ---- board resolution ---------------------------------------------------------
// Canonicalise so E:\WhalePhone, e:\whalephone and a junction all name one board.
function canonical(p) {
  let out = p;
  try { out = fs.realpathSync.native(p); } catch { out = path.resolve(p); }
  out = path.resolve(out);
  return out.toLowerCase();   // Windows FS is case-insensitive: one board per path, any case
}

// Walk up for a .git (dir OR file — worktrees use a .git *file*). Fall back to cwd.
function repoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(startDir); // no repo — the folder IS the board
    dir = up;
  }
}

// The board a session started in `cwd` belongs to.
function resolveBoard(cwd) {
  const root = canonical(repoRoot(cwd || process.cwd()));
  // basename of a drive root ("e:\") is "" — fall back to the path so a board is
  // never nameless. (Yes, people really do keep a git repo at a drive root.)
  // READ FALLBACK: a board not written to since the rename still lives under an old name, and
  // pointing at an empty `.arc/peer` would report "no notes" for a board that has 38 — a lie,
  // and the worst kind (silent). Prefer the current name; use an old one only while it is the
  // one that actually exists. ensureBoard migrates on the next write, then this never fires.
  let planDir = path.join(root, PLAN_DIR);
  if (!fs.existsSync(planDir)) {
    for (const legacy of LEGACY_DIRS) {
      const p = path.join(root, legacy);
      if (fs.existsSync(p)) { planDir = p; break; }
    }
  }
  return { root, planDir, name: path.basename(root) || root };
}

// Create the board dir + its self-ignore. Idempotent; cheap to call every time.
// Also THE MIGRATION POINT: this runs on every write path (a claim, a note), so the legacy
// `.plan` folder is renamed the first time anyone writes. One atomic rename carries the entire
// ledger, every cursor and every claim — nothing is copied, nothing is lost, and it cannot
// half-finish. It MUTATES board.planDir because callers hold the object by reference and would
// otherwise keep writing to the folder we just moved out from under them.
function ensureBoard(board) {
  const target = path.join(board.root, PLAN_DIR);
  if (board.planDir !== target && !fs.existsSync(target)) {
    // The target is NESTED now (.arc/peer), and rename() will not create the parent — without
    // this the migration silently fails and the board just stays where it was.
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch {}
    try { fs.renameSync(board.planDir, target); board.planDir = target; }
    catch { /* someone raced us, or it is locked — keep using the legacy dir, still correct */ }
  }
  fs.mkdirSync(board.planDir, { recursive: true });
  const gi = path.join(board.planDir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE_BODY);
  return board;
}

const notesPath = (board) => path.join(board.planDir, NOTES);
const cursorPath = (board, role) => path.join(board.planDir, `cursor-${role}.json`);
const claimPath = (board, role) => path.join(board.planDir, `claim-${role}.json`);
// LEGACY: a claim used to be called a "lease" (before the board/peer/claim rename). A session
// that is LIVE RIGHT NOW may still be holding one — and an invisible claim is not a cosmetic
// problem: a second session would see the role as vacant, take it, and the two would share a
// cursor and eat each other's notes, which is the exact failure claims exist to prevent. So
// every READ accepts both names, and a fresh claim migrates the old file away.
const legacyClaimPath = (board, role) => path.join(board.planDir, `lease-${role}.json`);
const CLAIM_FILE_RX = /^(?:claim|lease)-(.+)\.json$/;
function readClaimFile(board, role) {
  for (const p of [claimPath(board, role), legacyClaimPath(board, role)]) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* try the next name */ }
  }
  return null;
}

// ---- notes -------------------------------------------------------------------
// One line = one note. `seq` is the 1-based line number, assigned at READ time.
// ---- the note schema ---------------------------------------------------------
// Notes were free prose, and two real sessions promptly invented a taxonomy BY HAND —
// "DELEGATION: …", "Re your #8", "CORRECTION to #13 — I was WRONG", "VERDICT: …". So the
// structure is real; it was just encoded where only a human could follow it. These fields make
// it MACHINE-READABLE. All are OPTIONAL: `arc note all "build is broken"` still works, and every
// note written before this stays valid (an absent kind reads as `info`).
//
// The one that matters most is `supersedes`. The ledger is append-only ON PURPOSE (you never
// rewrite history, you append a correction) — but nothing linked the correction to what it
// corrected, so a reader could act on a claim its own author had publicly retracted. Now they
// are linked, and the retracted note is marked wherever it is read.
const KINDS = ['info', 'request', 'result', 'correction', 'blocker', 'decision'];
const DEFAULT_KIND = 'info';
// How loudly a kind wants to be read. Used to RANK the injection digest: a blocker or a
// retraction must never sit below routine news.
const KIND_RANK = { blocker: 0, correction: 1, decision: 2, request: 3, result: 4, info: 5 };

function normalizeKind(k) {
  const s = String(k || '').trim().toLowerCase();
  return KINDS.includes(s) ? s : DEFAULT_KIND;   // unknown kind degrades to info, never throws
}
const asSeq = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : undefined; };

function appendNote(board, note) {
  ensureBoard(board);
  const rec = {
    ts: new Date().toISOString(),
    from: String(note.from || 'unknown'),
    to: note.to ? String(note.to) : null,      // null = broadcast to the whole flat
    kind: normalizeKind(note.kind),
    priority: note.priority === 'high' ? 'high' : 'normal',
    body: String(note.body || ''),
    replyTo: asSeq(note.replyTo),              // this note ANSWERS that note (a thread)
    supersedes: asSeq(note.supersedes),        // this note RETRACTS/replaces that note
    refs: note.refs && typeof note.refs === 'object' ? note.refs : undefined, // {sha, files, tests}
  };
  // A correction/result almost always names its target; if the caller gave one but no kind,
  // infer the obvious one rather than filing a retraction as routine news.
  if (!note.kind) {
    if (rec.supersedes) rec.kind = 'correction';
    else if (rec.replyTo) rec.kind = 'result';
  }
  // A blocker or a retraction is high-priority by nature — don't make callers remember.
  if (rec.kind === 'blocker' || rec.kind === 'correction') rec.priority = 'high';
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
  // Single-line O_APPEND: atomic between processes on one filesystem.
  fs.appendFileSync(notesPath(board), JSON.stringify(rec) + '\n');
  return rec;
}

// seq -> the note that RETRACTED it (or undefined). Derived from the ledger, so it cannot lie
// and needs no back-writing: history stays append-only.
function supersededMap(board, all) {
  const notes = all || allNotes(board);
  const m = new Map();
  for (const n of notes) if (n.supersedes) m.set(n.supersedes, n);   // last writer wins
  return m;
}

// A `request` with no `result`/`correction` replying to it: asked, and never answered. This is
// the thing that used to scroll silently away.
function openRequests(board, role) {
  const all = allNotes(board);
  const answered = new Set(all.filter((n) => n.replyTo).map((n) => n.replyTo));
  return all.filter((n) => n.kind === 'request' && !answered.has(n.seq)
    && (!role || n.from === role || n.to === role || n.to == null));
}

// Every note answering `seq`, oldest first — the thread under a request.
function repliesTo(board, seq, all) {
  return (all || allNotes(board)).filter((n) => n.replyTo === seq);
}

function allNotes(board) {
  let raw; try { raw = fs.readFileSync(notesPath(board), 'utf8'); } catch { return []; }
  const out = [];
  raw.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push({ seq: i + 1, ...JSON.parse(line) }); } catch { /* skip a torn line */ }
  });
  return out;
}

function noteCount(board) { return allNotes(board).length; }

// Highest physical record position, including a torn line. Cursors are positions
// in the append-only file, not counts of successfully parsed notes.
function latestSeq(board) {
  let raw; try { raw = fs.readFileSync(notesPath(board), 'utf8'); } catch { return 0; }
  let latest = 0;
  raw.split('\n').forEach((line, i) => { if (line.trim()) latest = i + 1; });
  return latest;
}

// ---- cursors (rd()-only: nothing is consumed, the cursor just advances) --------
// Keyed by ROLE, not session id — a restarted terminal gets a new session id but is
// still "coding in this board", and must resume where it left off, not re-read all.
function readCursor(board, role) {
  try { return JSON.parse(fs.readFileSync(cursorPath(board, role), 'utf8')).seq || 0; }
  catch { return 0; }
}
function writeCursor(board, role, seq) {
  ensureBoard(board);
  atomicWriteJson(cursorPath(board, role), { seq, at: Date.now() });
  return seq;
}

// ---- atomic state writes + a claim lock ---------------------------------------
// A claim or cursor written with a bare writeFileSync can be TORN by a crash mid-write,
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
// wedge the board, so a lock older than LOCK_STALE_MS is broken rather than waited on.
const LOCK_STALE_MS = 10_000;
function withLock(board, name, fn) {
  const lock = path.join(board.planDir, `.lock-${name}`);
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
function unreadFor(board, role) {
  const all = allNotes(board);
  const latest = latestSeq(board);
  let cursor = readCursor(board, role);
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
function markRead(board, role) { return writeCursor(board, role, latestSeq(board)); }

// ---- role claim --------------------------------------------------------------
// Cursors are keyed by role, so TWO live "coding" sessions in one board would share
// a cursor and steal each other's notes. At most one live holder per (board, role).
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function roleClaim(board, role) {
  const l = readClaimFile(board, role);          // claim-*.json, or a legacy lease-*.json
  return l && isAlive(l.pid) ? l : null;        // a dead holder's claim is vacant
}

// Returns {ok:true} if claimed, or {ok:false, holder} if a LIVE *other* session holds it.
// IDENTITY IS THE SESSION, NOT THE PID: `arc:restart` re-execs arc-runner with a NEW pid
// but the SAME ARC_SESSION, and must be able to reclaim its own role. The pid is only
// a liveness probe. (Fall back to pid comparison for claims written without a session.)
// The check and the write happen UNDER A LOCK: without it, two sessions claiming the same
// role at once both read "vacant" and both write — both believe they hold it, then share a
// cursor and eat each other's notes. `convId` records WHICH CONVERSATION took the role, so a
// later session resuming that same conversation can pick it back up (see vacantClaimForConv).
function claimRole(board, role, pid, sessionId, convId) {
  ensureBoard(board);
  try {
    return withLock(board, `role-${role}`, () => {
      const held = roleClaim(board, role);
      if (held) {
        const same = (sessionId && held.sessionId) ? held.sessionId === sessionId : held.pid === pid;
        if (!same) return { ok: false, holder: held };
      }
      // don't lose a previously-recorded conversation when this claim doesn't name one
      const conv = convId || (held && held.convId) || null;
      atomicWriteJson(claimPath(board, role), { role, pid, sessionId: sessionId || null, convId: conv, at: Date.now() });
      try { fs.unlinkSync(legacyClaimPath(board, role)); } catch {}   // migrate off the old name
      return { ok: true };
    });
  } catch (e) {
    return { ok: false, holder: null, busy: true, error: String(e && e.message) };
  }
}

// The claim this CONVERSATION was working under, now vacant (its session died). That is the
// role a resumed conversation should pick back up: a relaunch mints a NEW ARC_SESSION, so the
// role would otherwise be silently lost and the session would stop receiving notes entirely.
function vacantClaimForConv(board, convId) {
  if (!convId) return null;
  let files = [];
  try { files = fs.readdirSync(board.planDir); } catch { return null; }
  for (const f of files) {
    if (!CLAIM_FILE_RX.test(f)) continue;   // a legacy lease-*.json is still OUR claim
    try {
      const l = JSON.parse(fs.readFileSync(path.join(board.planDir, f), 'utf8'));
      if (l.convId && l.convId === convId && !isAlive(l.pid)) return l;   // ours, and vacant
    } catch { /* torn claim = no claim */ }
  }
  return null;
}

// Who else is live in this flat right now (dead claims are ignored, not deleted —
// a crashed session's claim just goes vacant).
function liveRoles(board) {
  let files = []; try { files = fs.readdirSync(board.planDir); } catch { return []; }
  return files
    .map((f) => (f.match(CLAIM_FILE_RX) || [])[1])
    .filter((r, i, a) => r && a.indexOf(r) === i)   // one role may have BOTH names mid-migration
    .map((r) => roleClaim(board, r))
    .filter(Boolean);
}

function releaseRole(board, role, pid) {
  for (const p of [claimPath(board, role), legacyClaimPath(board, role)]) {
    try { if (JSON.parse(fs.readFileSync(p, 'utf8')).pid === pid) fs.unlinkSync(p); } catch {}
  }
}

module.exports = {
  PLAN_DIR, GITIGNORE_BODY,
  canonical, repoRoot, resolveBoard, ensureBoard,
  notesPath, appendNote, allNotes, noteCount, latestSeq,
  KINDS, KIND_RANK, DEFAULT_KIND, normalizeKind, supersededMap, openRequests, repliesTo,
  readCursor, writeCursor, unreadFor, markRead,
  isAlive, roleClaim, claimRole, releaseRole, liveRoles,
  atomicWriteJson, withLock, vacantClaimForConv,
};
