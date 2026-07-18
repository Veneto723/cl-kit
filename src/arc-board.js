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
// claimed in the old board stops applying, and `/arc-role` will say you have none.
// That is intended ("you moved flats"), but it is surprising, so: documented.
//
// Design notes (each one earned; see docs/research/agent-handoff/SUMMARY.md):
//  * APPEND-ONLY, never consumed. Linda tuple spaces distinguish rd() (read, tuple
//    stays) from in() (take, tuple removed). This is rd()-only: a note is never
//    removed, only a per-role CURSOR advances. "Done" facts stay auditable forever.
//  * NO seq FIELD. A note's seq IS its 1-based line number, assigned at READ time.
//    Two peers appending concurrently would both compute "last+1" and collide; a
//    line's position cannot collide. Cursor = how many lines that role has read.
//    ^ TRUE ON ONE FILESYSTEM, AND ONLY THERE. A position is not an identity: it is
//    an accident of arrival order. The moment a board is SHARED ACROSS MACHINES via
//    git, two clones append different lines to the same offsets and every positional
//    reference silently re-points. PROVEN with two real clones: a plain merge writes
//    "<<<<<<< HEAD" INTO the ledger (unparseable — the board wedges); a merge=union
//    driver merges clean and is WORSE — the same note `replyTo:4` resolved to
//    "HOME-1" on one machine and "OFFICE-1" on the other. Same file, same history,
//    two meanings, no error. So a shared board needs an identity that travels: see
//    `id` below. seq survives as a LOCAL DISPLAY INDEX only — never as a reference.
//    SHARING IS OPT-IN, AND THIS BOARD DOES NOT TAKE IT (2026-07-16). arc's own repo
//    is PUBLIC, and committing the ledger would publish every note anyone ever writes
//    here — so .peer/ stays self-ignored below and the ledger stays local. The
//    machinery is built and proven anyway, because it is what makes the ledger
//    CORRECT, not merely shareable: a reference that means one note is right even
//    when nothing is ever merged. To share a board (a PRIVATE repo), un-ignore
//    notes.jsonl by hand — ensureBoard only writes .gitignore when absent, so an
//    edited one is never fought.
//  * STABLE ID, position-independent: `id` = "<origin>:<token>". The origin is this
//    machine (.peer/origin.json, never committed); the token is RANDOM, never a
//    counter — "count what's there and add one" is the exact race the positional
//    design was built to avoid, and reintroducing it here would undo that. Notes
//    written before ids exist are a FROZEN prefix, so they map 1:1 onto synthetic
//    ids "~:<position>" and their old numeric replyTo keeps meaning what it meant.
//  * NO LOCKING, NO GIT CAS. Peers on one machine share one working directory, so
//    they share one file on one filesystem: single-line O_APPEND writes are atomic
//    between processes. Across machines git is the transport and `merge=union` the
//    merge; correctness there comes from ids + a per-origin cursor, not from locking.
//  * SELF-IGNORING. .peer/.gitignore is "*", so the board never enters the
//    project's history and the project's own .gitignore never learns it exists.
'use strict';

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
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
// The self-ignore sits at .arc/.gitignore and swallows the WHOLE .arc — peer/ AND roles/.
// The operator's ruling (2026-07-17): everything under .arc is machine state and travels by
// `arc export` / `arc import`, never by git. Charters included — that half of the old split
// ("a role's duty is a project fact and commits") was overruled. One file, one level up,
// same trick: it ignores itself too, so the project's own .gitignore never needs to know
// arc exists. (The former peer/.gitattributes `merge=union` went with it: nothing under
// .arc passes through git now, and the union job moved into `arc import`'s ledger merge —
// which git's union never did soundly anyway; see the id-less-prefix note in mergeLedgers.)
const GITIGNORE_BODY =
  '# arc machine state: the board (peer/), the role charters (roles/), claims, cursors.\n' +
  '# None of it is a project artifact — it travels between machines by `arc export` /\n' +
  '# `arc import`, never by git (operator ruling, 2026-07-17). This file ignores the\n' +
  '# whole .arc including itself, so the project\'s own .gitignore never needs to know\n' +
  '# arc exists.\n' +
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
  if (path.basename(path.dirname(board.planDir)) === '.arc') {
    // The self-ignore covers the WHOLE .arc from one level up (see GITIGNORE_BODY), and the
    // old per-dir pair inside peer/ is retired: the .gitignore is redundant under the parent
    // rule, and the .gitattributes union merge is moot — nothing under .arc meets git now.
    // Unlinking every call is a no-op after the first (ENOENT); this IS the migration.
    const gi = path.join(path.dirname(board.planDir), '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE_BODY);
    for (const f of ['.gitignore', '.gitattributes']) { try { fs.unlinkSync(path.join(board.planDir, f)); } catch {} }
  } else {
    // A legacy planDir (root-level .peer/.plan — the rename above raced or is locked): there is
    // no .arc parent to hold the rule, so the in-dir self-ignore stays until the migration lands.
    const gi = path.join(board.planDir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE_BODY);
  }
  return board;
}

const notesPath = (board) => path.join(board.planDir, NOTES);
const cursorPath = (board, role) => path.join(board.planDir, `cursor-${role}.json`);
const claimPath = (board, role) => path.join(board.planDir, `claim-${role}.json`);

// LAST-SEEN HEAD, per role, machine-local. The revive freshness brief must show a peer the commits
// it HAS NOT SEEN — and "haven't seen" is a git POSITION, not a wall-clock time. `--since=<time>`
// filters by committer date, which is wrong on a two-machine repo: a commit pulled from the other
// machine keeps its ORIGINAL date, so one made at 09:00 and pulled at 15:00 is excluded by
// `--since=14:00` though the peer never saw it (audit #149, reproduced). So we record the HEAD sha
// the peer actually saw — stamped every turn by the stop hook — and brief `<sha>..HEAD`, which is
// ancestry: immune to date skew and to pull/cherry-pick reordering. Machine-local, gitignored: it
// is "what THIS clone's peer last saw", and a home peer revived on home reads home's marker.
const seenPath = (board, role) => path.join(board.planDir, `seen-${role}.json`);
function stampSeen(board, role, sha) {
  if (!sha) return null;
  try { ensureBoard(board); atomicWriteJson(seenPath(board, role), { sha: String(sha).trim(), at: Date.now() }); return sha; }
  catch { return null; }   // a missed stamp just widens the next brief — never break a turn over it
}
function readSeen(board, role) {
  try { return JSON.parse(fs.readFileSync(seenPath(board, role), 'utf8')); } catch { return null; }
}
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

// ---- references: what `replyTo`/`supersedes` POINT AT --------------------------
// A reference used to be a position ("note 4"), which is only meaningful in one file on one
// machine. Proven to break the moment a board is shared: after a union merge the SAME `replyTo:4`
// meant "HOME-1" on one clone and "OFFICE-1" on the other — a thread that re-parents itself
// depending on who is reading. So a reference now stores the target's ID, which cannot drift.
//
// BOTH FORMS ARE READ, FOREVER. Every note already on every board stores a NUMBER, and the ledger
// is append-only — there is no rewrite pass and there must never be one. A number means "the note
// at that position in the frozen pre-id prefix", which is exactly what it meant when it was
// written, and that prefix cannot move.
const refKey = (ref) => {
  if (typeof ref === 'string') return ref;                     // an id: already stable
  const n = asSeq(ref);
  return n === undefined ? undefined : legacyId(n);            // legacy position -> its frozen id
};
// Callers hand us whatever the agent typed — usually the DISPLAY seq it just read ("--reply-to 127").
// Resolve that to the target's id at WRITE time, so what lands in the ledger is stable. Falls back
// to the raw value when the target cannot be found, so a reference to a not-yet-synced note is kept
// rather than dropped: better a dangling pointer we can still see than a silent deletion.
// The inverse, for DISPLAY: an id is what we store, a seq is what a human reads. Renders the
// LOCAL number of whatever a reference points at. Returns null when the target is not on this
// board yet (a reply that arrived before the note it answers — possible the instant a board is
// shared), so callers can say so instead of printing a raw id at a human.
function refSeq(all, ref) {
  const key = refKey(ref);
  if (!key) return null;
  const hit = all.find((n) => n.id === key);
  return hit ? hit.seq : null;
}
function resolveRef(board, ref, all) {
  if (ref === undefined || ref === null || ref === '') return undefined;
  if (typeof ref === 'string' && ref.includes(':')) return ref;  // already an id
  const seq = asSeq(ref);
  if (seq === undefined) return undefined;
  const hit = (all || allNotes(board)).find((n) => n.seq === seq);
  return hit ? hit.id : legacyId(seq);
}

// ---- origin: WHICH MACHINE wrote a note ---------------------------------------
// Machine-local and NEVER committed (.peer/.gitignore is "*"), so each clone keeps its own —
// which is the point: it is what makes two machines' notes distinguishable after a union merge.
// Generated once, then stable forever; if it is ever lost, notes written after simply belong to a
// new origin. That degrades cleanly (a cursor re-shows that origin's notes once) and never
// corrupts: an id already written into the ledger is immutable.
const originPath = (board) => path.join(board.planDir, 'origin.json');
function boardOrigin(board) {
  try { const o = JSON.parse(fs.readFileSync(originPath(board), 'utf8')).id; if (o) return o; } catch {}
  const id = crypto.randomBytes(4).toString('hex');
  try { ensureBoard(board); atomicWriteJson(originPath(board), { id, at: Date.now() }); } catch {}
  return id;
}
// LATENT EDGE — double-mint, NOT a bug (audit #166). Before origin.json exists, two concurrent
// FIRST-EVER appends can each mint a different origin id; last writer wins the file, but notes
// already appended keep whichever id their writer read. So the earliest notes could split across
// two origins. It does NOT break `ord` (each origin still counts its own subsequence cleanly) or
// the cursor (per-origin) — the board is just finer-grained than intended for its first few notes.
// First-append race only; every append after origin.json exists reads the one id.
// RANDOM, not a counter. See the design note at the top: reading the ledger to compute "last+1"
// is the collision the positional scheme existed to prevent, and it would come back the moment two
// local peers appended in the same tick. 48 random bits per note need no coordination at all.
function mintId(board) { return `${boardOrigin(board)}:${crypto.randomBytes(6).toString('hex')}`; }
// Notes written before ids existed: a FROZEN prefix (everything new carries an id), so their line
// position is stable and doubles as their identity. ZERO-PADDED because ids are compared as strings
// and "~:10" sorts before "~:2" — which would silently reorder the very prefix whose order the old
// numeric replyTo depends on. Width 6 outlives any realistic board.
const LEGACY_ORIGIN = '~';
const LEGACY_W = 6;
const legacyId = (pos) => `${LEGACY_ORIGIN}:${String(pos).padStart(LEGACY_W, '0')}`;
const noteOrigin = (n) => String(n.id || `${LEGACY_ORIGIN}:`).split(':')[0];

function appendNote(board, note) {
  ensureBoard(board);
  const rec = {
    id: mintId(board),                           // stable identity — survives any merge or reorder
    ts: new Date().toISOString(),
    from: String(note.from || 'unknown'),
    to: note.to == null ? null                                         // null = broadcast to the whole flat
      : (Array.isArray(note.to) ? note.to.map(String) : String(note.to)),   // one role, or a specific subset (array)
    kind: normalizeKind(note.kind),
    priority: note.priority === 'high' ? 'high' : 'normal',
    body: String(note.body || ''),
    replyTo: resolveRef(board, note.replyTo),        // this note ANSWERS that note (a thread)
    supersedes: resolveRef(board, note.supersedes),  // this note RETRACTS/replaces that note
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
// Keyed by the target's ID, never its position — a retraction must keep retracting the same note
// after a merge reorders the ledger. Callers look up by `note.id`.
function supersededMap(board, all) {
  const notes = all || allNotes(board);
  const m = new Map();
  for (const n of notes) if (n.supersedes) m.set(refKey(n.supersedes), n);   // last writer wins
  return m;
}

// A `request` with no `result`/`correction` replying to it: asked, and never answered. This is
// the thing that used to scroll silently away.
//
// A RETRACTED REQUEST IS NOT OWED. `--supersedes` is how a sender says "never mind", and the board
// already tells every reader not to act on the note it retracts — so billing the recipient for an
// answer to it creates a debt that CANNOT be paid: the only way to clear it would be to reply to a
// note nobody is allowed to act on. Found by using it: a request I retracted the moment I realised
// it was unanswerable (I had told the peer not to reply) kept showing as owed anyway.
// A note's recipient is a single role (string), a SPECIFIC SUBSET (array, addressed to each), or
// broadcast (null, everyone). This is the one place that knows "is this directed at <role>" — used
// by delivery, receipts, and the request tracker so all three agree on who a multi-recipient note is for.
const toHas = (to, role) => Array.isArray(to) ? to.includes(role) : to === role;

function openRequests(board, role) {
  const all = allNotes(board);
  const retracted = supersededMap(board, all);
  // WHO has replied to each request (request-id → set of replier roles). A single/broadcast request
  // closes on ANY reply (unchanged). A MULTI-recipient request is owed-by-each: it stays open until
  // every recipient SOMEONE HOLDS has replied. An empty chair is excluded (waiting on a role nobody
  // holds is infinite); a deaf-but-held one still counts — it can answer once woken, and the sender
  // sees via receipts that it has not, then drops it by choice. "Wait for all who can answer."
  const repliers = new Map();
  for (const n of all) if (n.replyTo) { const k = refKey(n.replyTo); if (!repliers.has(k)) repliers.set(k, new Set()); repliers.get(k).add(n.from); }
  let live = null;   // lazily built: only a multi-recipient request needs the live roster
  const answered = (n) => {
    const who = repliers.get(n.id) || new Set();
    if (!Array.isArray(n.to)) return who.size > 0;
    if (!live) live = new Set(liveRoles(board).map((l) => l.role));
    const expected = n.to.filter((r) => live.has(r));
    return expected.length > 0 && expected.every((r) => who.has(r));
  };
  return all.filter((n) => n.kind === 'request' && !answered(n) && !retracted.has(n.id)
    && (!role || n.from === role || n.to == null || toHas(n.to, role)));
}

// ---- receipts: has a note's recipient SEEN it --------------------------------
// A receipt with NO note and NO state of its own — derived purely from each recipient's read
// cursor, the exact inverse of unreadFor's filter (n.ord > cursor = unread ⇒ n.ord <= cursor =
// seen). "Seen" is the mail-signature sense: the note was DELIVERED into that role's context
// (their cursor passed it), NOT read-and-agreed. This is what lets a RESULT be terminal — the
// sender can see it landed, so a content-free "received" acknowledgement (a whole extra note, and
// a WAKE if they were idle) is never needed. Returns { recipients, seen }:
//   DIRECTED (to a role): recipients = [that role] — one addressee signs for it.
//   BROADCAST (to == null): recipients = the LIVE peers (minus the sender) — an announcer can ask
//     "did everyone get it?" and read `seen.length` of `recipients.length`, and who is missing.
//     A closed chair is not counted: nobody is there to read, so it would be a permanent "unseen".
function seenBy(board, note, all) {
  if (!note) return { recipients: [], seen: [] };
  const notes = all || allNotes(board);
  const n = notes.find((x) => x.id === note.id) || note;   // ensure per-origin ord + origin are present
  const recipients = note.to == null
    ? liveRoles(board).map((l) => l.role).filter((r) => r !== note.from)   // broadcast → the live peers
    : (Array.isArray(note.to) ? note.to : [note.to]);                      // directed (one) or a subset (many)
  const hasSeen = (role) => n.ord != null && n.ord <= ((readCursorMap(board, role, notes)[noteOrigin(n)]) || 0);
  return { recipients, seen: recipients.filter(hasSeen) };
}

// Per-recipient status of a request I sent: [{ role, seen, replied }] for each addressee. This is
// what makes wait-for-all safe rather than a blind hang — the sender can SEE that one recipient has
// not even seen the note (deaf) while another has replied, and decide to proceed without the absent one.
function requestStatus(board, note, all) {
  const notes = all || allNotes(board);
  const recipients = Array.isArray(note.to) ? note.to : (note.to != null ? [note.to] : []);
  const seen = new Set(seenBy(board, note, notes).seen);
  const replied = new Set(notes.filter((n) => n.replyTo && refKey(n.replyTo) === note.id).map((n) => n.from));
  return recipients.map((r) => ({ role: r, seen: seen.has(r), replied: replied.has(r) }));
}

// Every note answering `ref`, oldest first — the thread under a request. Takes a display seq (what
// a human types) or an id; both resolve to the same thread.
function repliesTo(board, ref, all) {
  const notes = all || allNotes(board);
  const target = typeof ref === 'string' && ref.includes(':') ? ref : (notes.find((n) => n.seq === asSeq(ref)) || {}).id;
  return target ? notes.filter((n) => n.replyTo && refKey(n.replyTo) === target) : [];
}

// `seq` stays exactly what it was: the note's PHYSICAL line number. It is the number a human reads
// and types, and it is LOCAL — after a merge the same note sits at a different line on each machine,
// so seq is a display index and NOTHING may reference a note by it across machines. That is what
// `id` is for. (Deliberately NOT re-sorted into a machine-independent order: seq is the physical
// position on purpose — a torn line must leave its gap so the cursor can advance past it exactly
// once — and a stable display number buys nothing once references are ids.)
// The one addition: notes written before ids get a synthetic one. They are a FROZEN set (everything
// new carries an id), so their position cannot move and "~:<pos>" maps 1:1 onto the numeric replyTo
// they already carry.
function allNotes(board) {
  let raw; try { raw = fs.readFileSync(notesPath(board), 'utf8'); } catch { return []; }
  const out = [];
  let legacy = 0;
  const ord = {};
  raw.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let n; try { n = JSON.parse(line); } catch { return; }        // skip a torn line
    if (!n.id) n.id = legacyId(++legacy);                         // frozen prefix -> stable synthetic id
    const org = noteOrigin(n);
    // ORD: this note's index among ITS OWN origin's notes, counted at READ time. The same trick the
    // positional design already relies on, narrowed to the one scope where it still holds: a
    // position across writers is an accident, but a position WITHIN one writer's stream is that
    // writer's own append order, and git's union merge concatenates each side's lines without
    // reordering them — so every machine counts the same ordinal for the same note. This is what
    // the cursor advances on. It needs no counter at write time (that race is why seq is positional
    // at all) and, unlike a timestamp, it cannot tie: notes written in the same millisecond still
    // have distinct ordinals. BOUNDARY (audit #166): ord assumes an origin's line order never
    // changes — union-append preserves it, but a `git rebase` of a SHARED ledger would not. Out of
    // scope by design: .peer/ self-ignores, so the ledger never enters a rebased branch in normal
    // flow. If that ever changes, ord's monotonicity across the rewrite is not guaranteed.
    out.push({ seq: i + 1, ord: (ord[org] = (ord[org] || 0) + 1), ...n });
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
// A CURSOR CANNOT BE A POSITION ON A SHARED BOARD. "I have read 5 notes" is a claim about MY line
// order, and the other machine's notes interleave by timestamp — so a note that arrives from the
// office bearing an OLDER ts sorts BEHIND a home cursor and is marked read having never been shown.
// Silent, and the exact failure the whole rd()-only design exists to prevent. So the cursor is a
// HIGH-WATER PER ORIGIN: "everything origin X wrote up to here". An origin's own notes are appended
// in ts order on its own machine, so (ts,id) is monotonic within an origin, and nothing another
// machine does can move it. `seq` is still recorded — for the fail-open check below, and because a
// human debugging a cursor wants the number they saw.
const noteKey = (n) => n.ord;                      // ordinal WITHIN its origin — see allNotes
function highWater(notes) {
  const o = {};
  for (const n of notes) {
    const org = noteOrigin(n);
    if (!o[org] || n.ord > o[org]) o[org] = n.ord;
  }
  return o;
}
function readCursor(board, role) {                 // legacy scalar view — kept for callers/tests
  try { return JSON.parse(fs.readFileSync(cursorPath(board, role), 'utf8')).seq || 0; }
  catch { return 0; }
}
function readCursorMap(board, role, all) {
  let rec; try { rec = JSON.parse(fs.readFileSync(cursorPath(board, role), 'utf8')); } catch { return {}; }
  // FAIL-OPEN, unchanged in spirit: a cursor past the end means the ledger was truncated or
  // rewritten (it is supposed to be append-only). Re-read from the start rather than silently
  // skipping — a duplicate note is noise; a missed one is the bug this design exists to prevent.
  if (rec.seq && rec.seq > latestSeq(board)) return {};
  if (rec.o && typeof rec.o === 'object') return rec.o;
  // A cursor written before origins existed: "I read the first N". Every note it covers is from the
  // frozen prefix, so its high-water converts exactly.
  return highWater((all || allNotes(board)).filter((n) => n.seq <= (rec.seq || 0)));
}
function writeCursor(board, role, seq) {
  ensureBoard(board);
  const covered = allNotes(board).filter((n) => n.seq <= seq);
  atomicWriteJson(cursorPath(board, role), { o: highWater(covered), seq, at: Date.now() });
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
  const cur = readCursorMap(board, role, all);      // per-origin high-water (fail-open handled inside)
  const cursor = readCursor(board, role);           // reported for debugging, never used to filter
  const notes = all.filter(
    (n) => n.ord > (cur[noteOrigin(n)] || 0) && n.from !== role && (n.to == null || toHas(n.to, role)));
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

// ---- A PID IS NOT AN IDENTITY -------------------------------------------------
// isAlive() answers "does SOME process have this pid?", never "is it the one that wrote this
// claim?". Windows recycles pids, and arc spawns a node process for EVERY hook — so the collision
// is not theoretical. Caught on the whalephone board: the `research` claim (pid 9512) read
// dead → LIVE → dead across three probes minutes apart, with the session closed the whole time.
// A stranger had taken its pid. A dead process cannot resurrect; that flicker IS the proof.
//
// What believing it costs: `arc delegate research "…"` posts a note into a chair nobody is in and
// nobody ever answers, staffRole refuses to revive ("already held by a LIVE session"), and the
// empty-chair warning never fires. The role becomes unfillable — the exact failure the whole
// live/closed distinction exists to prevent.
//
// THE RULE, and it needs no new field: a claim is genuine only if its process started BEFORE the
// claim was written. A recycled pid always starts AFTER the claim it inherited.
//     android: process started 10:54:21, claim written 10:54:29  → genuine.
//
// THE COST, measured before choosing (this runs on the per-turn path):
//   • process.kill is 0ms and has no false NEGATIVE — a genuinely dead pid is settled for FREE,
//     with no query at all. That is the overwhelmingly common case.
//   • Only a live-LOOKING pid needs the OS. One powershell spawn is ~270ms, and ~270ms is its
//     STARTUP: asking about 3 pids costs the same as asking about 1. So we batch.
//   • A short disk cache then amortises it to ~0 across the many short-lived hook processes.
// Bounded lie: ≤ PIDSTART_TTL, instead of forever.
const PIDSTART_CACHE = path.join(os.homedir(), '.claude', 'cache', 'arc-pidstart.json');
const PIDSTART_TTL = 30000;
const FILETIME_EPOCH = 11644473600000;   // ms from 1601-01-01 (FILETIME) to 1970-01-01 (unix)
const CLAIM_SKEW_MS = 2000;              // absorb rounding only; a recycled pid is off by hours
// Printed LAST by the probe. Its presence is what proves the enumeration RAN — the exit code
// cannot, because SilentlyContinue still exits 1 when any pid in the batch has died.
const PROBE_OK = 'arc-probe-ok';
let pidStartMemo = null;                 // per-process memo, so one hook run pays at most once

// pid -> start time (epoch ms), null if no such process. Returns null ENTIRELY if the OS cannot
// be asked — the caller must then FAIL OPEN, never invent a verdict.
function procStarts(pids) {
  const want = [...new Set(pids.map(Number).filter(Boolean))];
  if (!want.length) return {};
  if (!pidStartMemo) {
    try { pidStartMemo = JSON.parse(fs.readFileSync(PIDSTART_CACHE, 'utf8')) || {}; } catch { pidStartMemo = {}; }
  }
  const now = Date.now();
  const need = want.filter((p) => {
    const e = pidStartMemo[p];
    return !e || typeof e.at !== 'number' || now - e.at > PIDSTART_TTL;
  });
  if (need.length) {
    // .ToFileTimeUtc() — NOT .Ticks. `.Ticks` on a LOCAL DateTime encodes the local wall clock, so
    // on this UTC+8 box a process started 02:54:21Z reports as 10:54:21Z: every genuine claim would
    // look like it predated its own process by 8 hours and EVERY peer would read as dead. Verified
    // against a process whose real start time was known before this was trusted.
    // A DONE MARKER, not the exit code. `-ErrorAction SilentlyContinue` suppresses the error
    // MESSAGE but NOT the exit status: ask about a batch where any pid has since died and
    // powershell prints perfect output for the survivors and still exits 1. The old guard
    // (`status !== 0 -> return null`) then threw that good answer away and FAILED OPEN, voiding
    // the impostor check for the WHOLE BATCH.
    //
    // And it voided it exactly where it was built to work: a squatter is BY DEFINITION a
    // transient process, so it is the likeliest thing in the batch to exit mid-probe — the check
    // disabled itself in its own reason for existing. (Found by the research peer, reproduced
    // here: live+dead pid => status 1, stdout correct. My own notes even warn that SilentlyContinue
    // does not clear the exit code; I wrote the guard anyway.)
    //
    // But the exit code cannot simply be IGNORED either, or the two failures become one: "every
    // pid is gone" and "powershell could not run at all" both give empty stdout + nonzero status.
    // Reading the second as the first would mark every peer an impostor — fail-CLOSED, the far
    // worse direction (it invites a second session into an occupied chair). So the pipeline prints
    // a marker LAST: see it and the enumeration provably ran, so a pid missing from stdout is
    // genuinely gone; miss it and we could not ask, so fail open.
    let r;
    try {
      r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-Process -Id ${need.join(',')} -ErrorAction SilentlyContinue | %{ "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }; "${PROBE_OK}"`],
      { encoding: 'utf8', timeout: 5000 });
    } catch { return null; }
    if (!r || r.error) return null;                        // could not spawn/timed out — cannot ask
    const out = String(r.stdout || '');
    if (!out.includes(PROBE_OK)) return null;              // it never finished — cannot ask
    const seen = {};
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) seen[m[1]] = Number(m[2]) / 10000 - FILETIME_EPOCH;
    }
    // A pid absent from the output has NO READABLE start — cache null, a real answer. Absent means
    // one of two things, and for our purpose they are the same: the pid is GONE, or it is ALIVE but
    // UNREADABLE (a protected/system process whose StartTime the query cannot see — dwm.exe on a
    // recycled number is the live example). Either way this pid is not a start we can match a claim
    // against, so isHolder treats null as "not a provable holder" — see :584.
    for (const p of need) pidStartMemo[p] = { start: seen[p] !== undefined ? seen[p] : null, at: now };
    try { fs.mkdirSync(path.dirname(PIDSTART_CACHE), { recursive: true }); atomicWriteJson(PIDSTART_CACHE, pidStartMemo); } catch {}
  }
  const out = {};
  for (const p of want) out[p] = pidStartMemo[p] ? pidStartMemo[p].start : null;
  return out;
}

// Is this claim's process still the one that WROTE it? `starts` lets a caller pre-batch.
function isHolder(claim, starts) {
  if (!claim || !claim.pid) return false;
  if (!isAlive(claim.pid)) return false;          // free, and never a false negative
  if (!claim.at) return true;                     // legacy claim, no timestamp — trust the pid
  const s = starts !== undefined ? starts : procStarts([claim.pid]);
  // FAIL OPEN when the OS cannot be asked. Reading a LIVE peer as dead is the worse error: it
  // invites a duplicate session into an occupied chair. Unsure means "behave as we always did".
  if (!s) return true;
  const t = s[claim.pid];
  // No readable start for a pid that isAlive() accepted. TWO causes, same verdict: it died between
  // the two probes, OR it is alive but its start is UNREADABLE — a recycled pid now owned by a
  // PROTECTED process (dwm.exe was the live find). In both the pid cannot be proven to be the one
  // that WROTE this claim, so fail CLOSED: the chair is vacant. This is the opposite of the !s
  // branch above (fail OPEN) on purpose — there the OS could not be asked at all; here it answered,
  // and the answer excludes this pid.
  if (t == null) return false;
  // KNOWN ACCEPTED RACE (audit #152), documented so the record does not overclaim: `t` may be a
  // CACHED start, up to PIDSTART_TTL (30s) old and NOT re-probed. So within that window a claimed
  // pid that DIED and was recycled onto another live process reads its DEAD predecessor's start,
  // which still passes this check — the chair reads genuinely held for ≤30s. This is the FAIL-SAFE
  // direction: a dead peer looks briefly alive, so a revive is momentarily REFUSED and then
  // self-heals at TTL; it never admits a SECOND session into an occupied chair (the dangerous
  // direction). a0c93bb closed the COLD-cache door (a protected pid probes to null → vacant); this
  // warm-cache door is left open on purpose — Windows does not recycle a pid onto a chosen number
  // within 30s, so the probability is low and the outcome transient. If pid-reuse ever gets faster
  // or PIDSTART_TTL grows, this window grows with it — re-probe for an isAlive-but-cache-fresh pid
  // in the impostor path if that ever changes.
  return claim.at >= t - CLAIM_SKEW_MS;
}

function roleClaim(board, role) {
  const l = readClaimFile(board, role);          // claim-*.json, or a legacy lease-*.json
  return l && isHolder(l) ? l : null;            // a dead — or IMPOSTOR — holder's claim is vacant
}

// Returns {ok:true} if claimed, or {ok:false, holder} if a LIVE *other* session holds it.
// IDENTITY IS THE SESSION, NOT THE PID: `/arc-restart` re-execs arc-runner with a NEW pid
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
// A role that WAS held and is now empty — carrying the conversation of the session that held it.
// This is what makes a closed peer revivable AS ITSELF: its transcript is still on disk, and this
// is the only record of which one is its. Without it the only way to refill a chair is to fork
// someone else's context, which hands the role's name to a session that has none of its memory.
function vacantClaimForRole(board, role) {
  const l = readClaimFile(board, role);
  // !isHolder, NOT !isAlive: a stranger squatting the pid must leave the chair REVIVABLE. This is
  // the worst face of the bug — the role reads "held" so nothing may staff it, while the session
  // that could answer is gone. Vacancy and liveness have to be decided by the same rule.
  return (l && l.convId && !isHolder(l)) ? l : null;
}

function vacantClaimForConv(board, convId) {
  if (!convId) return null;
  let files = [];
  try { files = fs.readdirSync(board.planDir); } catch { return null; }
  for (const f of files) {
    if (!CLAIM_FILE_RX.test(f)) continue;   // a legacy lease-*.json is still OUR claim
    try {
      const l = JSON.parse(fs.readFileSync(path.join(board.planDir, f), 'utf8'));
      if (l.convId && l.convId === convId && !isHolder(l)) return l;      // ours, and vacant
    } catch { /* torn claim = no claim */ }
  }
  return null;
}

// Who else is live in this flat right now (dead claims are ignored, not deleted —
// a crashed session's claim just goes vacant).
// THE place to batch: this asks about every claim on the board at once, so it must cost ONE
// query, not one per role. The pids that survive the free isAlive probe are the only ones the
// OS is asked about — usually one, often none.
function liveRoles(board) {
  let files = []; try { files = fs.readdirSync(board.planDir); } catch { return []; }
  const claims = files
    .map((f) => (f.match(CLAIM_FILE_RX) || [])[1])
    .filter((r, i, a) => r && a.indexOf(r) === i)   // one role may have BOTH names mid-migration
    .map((r) => readClaimFile(board, r))
    .filter((l) => l && isAlive(l.pid));            // free pass: settles every ordinary dead claim
  if (!claims.length) return [];
  const starts = procStarts(claims.map((l) => l.pid));
  return claims.filter((l) => isHolder(l, starts));
}

// ---- PARENTAGE: who spawned this peer -------------------------------------------------------
// arc knew a peer EXISTED and never knew who MADE it, so nothing could ever reap one: a leaked
// probe was indistinguishable from a standing team member. Every cleanup was a human recognising
// a name they had watched an agent type. In one session that cost five leaks — three test peers a
// human had to name, sixteen orphan consoles from a harness whose kill hit the wrong process, and
// a peer that survived a spawn its own caller was told had failed.
//
// The record is written by the SPAWNER at birth, not by the peer: a newborn cannot know who made
// it (it is a fresh conversation with a birth prompt), and asking it to self-report parentage
// would be trusting the thing being tracked. `bornOf` is the spawner's CONVERSATION, never its
// session id or pid — those are handles that change on a respawn, and this repo has now been
// bitten three separate times by treating one as an identity (a recycled pid squatting a chair; a
// peer wearing its caller's session; a session refused its own role after a restart).
const birthPath = (board, role) => path.join(board.planDir, `born-${role}.json`);
function recordBirth(board, role, bornOf) {
  if (!bornOf) return null;   // a caller with no conversation to name: cold birth, unparented
  try { atomicWriteJson(birthPath(board, role), { role, bornOf, at: Date.now() }); return { role, bornOf }; }
  catch { return null; }      // parentage is bookkeeping — it must never break a spawn
}
function readBirth(board, role) {
  try { return JSON.parse(fs.readFileSync(birthPath(board, role), 'utf8')); } catch { return null; }
}
function clearBirth(board, role) {
  try { fs.unlinkSync(birthPath(board, role)); } catch {}
}
// Every role THIS conversation spawned, live or not. Keyed by conv so it survives your own respawn.
function spawnsOf(board, conv) {
  if (!conv) return [];
  const out = [];
  try {
    for (const f of fs.readdirSync(board.planDir)) {
      const m = /^born-(.+)\.json$/.exec(f);
      if (!m) continue;
      const b = readBirth(board, m[1]);
      if (b && b.bornOf === conv) out.push(b);
    }
  } catch {}
  return out;
}

function releaseRole(board, role, pid) {
  for (const p of [claimPath(board, role), legacyClaimPath(board, role)]) {
    try { if (JSON.parse(fs.readFileSync(p, 'utf8')).pid === pid) fs.unlinkSync(p); } catch {}
  }
}

// ---- CLOSING A PEER: kill the TREE, in the only order that works ----------------------------
// THE CLAIM PID IS THE MIDDLE OF THE TREE, and that is the whole trap:
//     pwsh (the shell that outlives claude)  ->  node arc-runner  <-- THE CLAIM PID  ->  claude.exe
// Kill claude and arc-runner's `for(;;)` RESPAWNS IT — which is exactly why a harness's kill left
// sixteen orphan consoles alive, and why my own probe pids kept changing under me while I killed
// the same peer four times. Kill only the runner and claude is orphaned but still burning quota.
// So: RUNNER FIRST (it can no longer respawn), then claude, then the parent shell.
//
// Best-effort by design: a peer that is already half-dead must still end up fully dead and the
// claim must still be released. A close that refuses because one pid was already gone would leave
// exactly the mess it exists to clear.
function closePeer(board, role, opts) {
  const o = opts || {};
  // ONE raw snapshot at entry. The kill target and the abort baseline BOTH derive from it, so a
  // revive cannot slip between two adjacent reads and desync them — poisoning entryPid with the
  // revive's own pid so the :809 abort silently fails to fire and tombstones a live peer (audit
  // #172). `claim` is the genuineness-filtered view (inlined roleClaim = readClaimFile + isHolder)
  // so only a genuine holder is killed (a recycled-pid stranger reads vacant, untouched); `entryPid`
  // is the RAW pid so the tombstone still fires for an already-exited peer (the common close).
  const entry = readClaimFile(board, role);
  const entryPid = entry && entry.pid;
  const claim = entry && isHolder(entry) ? entry : null;
  const kill = o.kill || ((pid) => { try { process.kill(pid, 'SIGKILL'); return true; } catch { return false; } });
  const tree = o.tree || treeOf;
  const killed = [];
  if (claim && claim.pid) {
    const t = tree(claim.pid);                       // { parent, children }
    // ORDER IS LOAD-BEARING — see above.
    if (kill(claim.pid)) killed.push({ pid: claim.pid, what: 'runner' });
    for (const c of t.children) if (kill(c)) killed.push({ pid: c, what: 'claude' });
    if (t.parent && kill(t.parent)) killed.push({ pid: t.parent, what: 'shell' });
  }
  // THE CLAIM IS THE REVIVE POINTER — CLOSE MUST NOT BURN IT. This used to unlink the claim file
  // ("a chair held by a corpse is worse than an empty one"), and that reasoning belonged to the
  // pre-genuineness era: a pid-less claim cannot read as held (isHolder requires a pid), so nothing
  // refuses to staff the chair. What unlinking actually destroyed was `convId` — the ONLY thing
  // vacantClaimForRole has to find the peer's own conversation — so `arc close` printed "REVIVABLE,
  // not deleted" while guaranteeing the next delegate would silently BIRTH A STRANGER in the
  // chair's name. Caught in production the first time a real standing peer was closed between
  // assignments (audit, 2026-07-16): its transcript sat untouched on disk and the roster showed
  // "empty chair" instead of "was here; REVIVE as itself". The close-then-revive round trip is the
  // standing-duty lifecycle; the tombstone below is what makes the promise in close's own message
  // true. Unlink only when there is no conversation to point at — then the chair really is bare.
  // THE TOMBSTONE IS A CLAIM MUTATION, so it must hold the SAME lock claimRole holds — or a
  // concurrent `arc delegate <role>` (revive) writes a LIVE claim under the lock and our unlocked
  // tombstone clobbers it: the live peer reads vacant (DOUBLE-STAFFING) and its convId reverts to
  // the stale one we read before the revive (audit #167, a real race — closePeer took no lock).
  // The kill stayed OUTSIDE the lock on purpose: killing a tree can be slow, and the lock guards
  // the claim FILE, not the process. And inside the lock we RE-CHECK the pid: if it changed since
  // we entered, a revive won the chair while we were killing — do NOT tombstone a live peer.
  // Read the claim RAW (not roleClaim): roleClaim is genuineness-filtered, so a dead pid reads as
  // "no claim", and filtering here would skip the tombstone for every peer that already exited —
  // the common close. The kill above stays filtered (a recycled pid may be a stranger).
  return withLock(board, `role-${role}`, () => {
    const raw = readClaimFile(board, role);
    if (raw && raw.pid && raw.pid !== entryPid) {
      // A concurrent revive re-claimed this role after we started closing. Its live claim wins;
      // tombstoning it would erase a live peer. Leave it — we only killed the OLD peer's tree.
      return { role, killed, hadClaim: true, revivable: !!raw.convId, reclaimed: true };
    }
    if (raw && raw.convId) {
      atomicWriteJson(claimPath(board, role), { role, sessionId: raw.sessionId || null, convId: raw.convId, at: Date.now() });
    } else {
      try { fs.unlinkSync(claimPath(board, role)); } catch {}
    }
    clearBirth(board, role);
    return { role, killed, hadClaim: !!raw, revivable: !!(raw && raw.convId), reclaimed: false };
  });
}

// The pids around a runner: its parent shell and its claude child. Windows-only (WMI), and it must
// never throw — a close that dies on a query leaves the tree alive.
function treeOf(pid) {
  const out = { parent: null, children: [] };
  try {
    const q = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){ "P:"+$p.ParentProcessId };` +
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "C:"+$_.ProcessId }`],
      { encoding: 'utf8', timeout: 8000 });
    for (const line of String(q.stdout || '').split(/\r?\n/)) {
      const m = /^([PC]):(\d+)$/.exec(line.trim());
      if (!m) continue;
      if (m[1] === 'P') out.parent = parseInt(m[2], 10);
      else out.children.push(parseInt(m[2], 10));
    }
  } catch {}
  return out;
}

module.exports = {
  PLAN_DIR, GITIGNORE_BODY,
  canonical, repoRoot, resolveBoard, ensureBoard,
  notesPath, appendNote, allNotes, noteCount, latestSeq,
  KINDS, KIND_RANK, DEFAULT_KIND, normalizeKind, supersededMap, openRequests, repliesTo, seenBy, requestStatus,
  readCursor, readCursorMap, writeCursor, unreadFor, markRead, stampSeen, readSeen,
  boardOrigin, noteOrigin, noteKey, refKey, resolveRef, refSeq, legacyId,
  isAlive, isHolder, procStarts, roleClaim, readClaimFile, claimRole, releaseRole, liveRoles, vacantClaimForRole,
  atomicWriteJson, withLock, vacantClaimForConv,
  recordBirth, readBirth, clearBirth, spawnsOf, closePeer, treeOf,
};
