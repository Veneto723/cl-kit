#!/usr/bin/env node
// arc-done: derive "done" from GIT, not from the agent's word.
//
// The board (arc-board) let peers leave each other notes. But a note is still
// something an agent has to REMEMBER to write, and bookkeeping is the first thing
// dropped when context runs short or the code gets interesting. Anthropic hit the
// same wall in their own agent-teams feature; their docs admit it:
//     "Task status can lag: teammates sometimes fail to mark tasks as completed."
// You cannot fix a behavioural failure by giving it a nicer place to write things
// down. So this file writes the note FOR the agent, out of evidence it cannot fake.
//
// The lever is Claude Code's `TaskCompleted` hook. Read out of the shipped binary
// (the docs never say), TaskUpdate does this:
//
//     if (o === "completed") {
//       let errs = [], v = execTaskCompletedHooks(id, subject, description, ...);
//       for await (const S of v) if (S.blockingError) errs.push(...);
//       if (errs.length > 0) return { success: false, ... };   // <-- refused
//     }
//     y.status = o;                                            // <-- never reached
//
// with payload { hook_event_name, task_id (required), task_subject (required),
// task_description?, teammate_name?, team_name? } plus the common fields. Crucially
// the call sits OUTSIDE any teams check — the teammate-messaging call four lines
// below it is guarded, this is not — so it fires for an ordinary session with no
// team. `team_name` is even marked "@deprecated: sessions have a single implicit team".
//
// So: ticking a task IS the handoff. The coding agent completes P-014, and the
// research agent finds a note on the board carrying the sha, the files, and the
// commit subjects — whether or not anybody remembered to say anything.
//
// Two modes (features.doneGate in arc-config.json, or ARC_DONE_GATE):
//   'note'   (default) never blocks. Derives evidence and posts it. An unevidenced
//            completion still posts, flagged as such. Zero friction, all the signal.
//   'strict' exit 2 when a completion carries no commit, which REFUSES the tick and
//            hands the agent back "no commit found". Honest but blunt: a task like
//            "investigate the flake" legitimately produces no commit. Opt in per repo.
//   'off'    do nothing.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const R = require('./arc-board');

const MAX_FILES = 12;        // a note is a sticky note, not a diff
const MAX_COMMITS = 5;
const GIT_TIMEOUT = 4000;
// A commit subject can contain anything a human types, so split on a control byte no
// keyboard produces rather than on a space/tab/pipe someone will eventually commit.
const SEP = String.fromCharCode(31);   // ASCII unit separator

// ---- git (never throws; a hook must not wedge a tool call) --------------------
function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd, timeout: GIT_TIMEOUT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { return null; }
}

const head = (cwd) => git(cwd, ['rev-parse', 'HEAD']);

// Everything that landed between `baseline` and HEAD. `baseline` may be a sha (exact,
// recorded when the task was created) or an ISO timestamp (fallback for tasks that
// predate the hook). A null baseline means we have no idea → claim nothing.
function evidenceSince(cwd, baseline) {
  if (!baseline) return null;
  const isSha = /^[0-9a-f]{7,40}$/i.test(baseline);
  const range = isSha ? `${baseline}..HEAD` : null;

  const logArgs = isSha
    ? ['log', '--no-merges', `--format=%h${SEP}%s`, range]
    : ['log', '--no-merges', `--format=%h${SEP}%s`, `--since=${baseline}`];
  const raw = git(cwd, logArgs);
  if (raw === null) return null;                 // not a repo / bad baseline
  const commits = raw ? raw.split('\n').map((l) => {
    const [sha, subject] = l.split(SEP);
    return { sha, subject };
  }) : [];
  if (!commits.length) return { commits: [], files: [] };

  const fileArgs = isSha
    ? ['diff', '--name-only', range]
    : ['diff', '--name-only', `${commits[commits.length - 1].sha}~1`, 'HEAD'];
  const fraw = git(cwd, fileArgs);
  const files = fraw ? fraw.split('\n').filter(Boolean) : [];
  return { commits, files };
}

// ---- baselines ---------------------------------------------------------------
// Task ids restart at 1 per session, so two peers both have a task "1". Key the
// baseline by SESSION + task, never by task alone.
const baselineFile = (board, session, taskId) =>
  path.join(board.planDir, `base-${session || 'nosession'}-${taskId}.json`);

function recordBaseline(board, session, taskId, sha) {
  try {
    R.ensureBoard(board);
    fs.writeFileSync(baselineFile(board, session, taskId), JSON.stringify({ sha, at: new Date().toISOString() }));
    return true;
  } catch { return false; }
}

// A baseline lives from TaskCreated until the task is genuinely DONE — and it used to outlive
// that three different ways, none with a symptom. Just files, forever:
//   * a COMPLETED task never deleted its baseline. Nothing in this file ever called unlink.
//   * an ABANDONED task's baseline outlived the session that was the only thing that could
//     have completed it.
//   * with the gate OFF, one was written on every task and never even READ (onTaskCompleted
//     returns before the read) — a pure write-only leak.
// One real board had 14 orphans from two long-dead sessions. Harmless per file; unbounded over
// time, since every task on a busy project leaves one behind.
function clearBaseline(board, session, taskId) {
  try { fs.unlinkSync(baselineFile(board, session, taskId)); return true; } catch { return false; }
}

// Sweep baselines whose SESSION is gone: it is the only thing that could ever complete that
// task, so the file is definitionally garbage. Same liveness proxy the board already trusts for
// claims — the session's arc-runner pid.
//
// Parsing: the key is `<session>-<taskId>` and a session id CONTAINS a dash (pid-random), so the
// LAST chunk is the task and everything before it is the session. `nosession` is left alone: we
// cannot judge a liveness we never recorded, and guessing would delete a live task's baseline.
function sweepBaselines(board) {
  let files = [];
  try { files = fs.readdirSync(board.planDir); } catch { return 0; }
  const F = require('./arc-notes');
  let n = 0;
  for (const f of files) {
    const m = f.match(/^base-(.+)-([^-]+)\.json$/);
    if (!m || m[1] === 'nosession') continue;
    const pid = F.sessionPid(m[1]);
    if (pid && R.isAlive(pid)) continue;        // still live: it may yet complete the task
    try { fs.unlinkSync(path.join(board.planDir, f)); n++; } catch {}
  }
  return n;
}

// Two independent baselines, because either can go missing:
//   sha  — captured at TaskCreated. Exact. But it can be ORPHANED by a rebase/amend,
//          after which `git log <sha>..HEAD` fails and we'd learn nothing.
//   born — when the task FILE was created. Always available, and it works for tasks
//          that predate the hook ever being installed. Coarser (clock, not graph).
// The caller tries the sha first and falls back to the timestamp.
function readBaseline(board, session, taskId, taskFile) {
  const out = { sha: null, born: null };
  try {
    const b = JSON.parse(fs.readFileSync(baselineFile(board, session, taskId), 'utf8'));
    if (b && b.sha) out.sha = b.sha;
  } catch {}
  try {
    const st = fs.statSync(taskFile);
    const born = st.birthtime && st.birthtime.getTime() > 0 ? st.birthtime : st.mtime;
    out.born = born.toISOString();
  } catch {}
  return out;
}

function taskFilePath(session, taskId) {
  const cfg = process.env.CLAUDE_CONFIG_DIR
    || path.join(require('os').homedir(), '.claude');
  return path.join(cfg, 'tasks', session || '', `${taskId}.json`);
}

// ---- policy ------------------------------------------------------------------
function mode() {
  const env = (process.env.ARC_DONE_GATE || '').trim().toLowerCase();
  if (env) return env;
  try {
    const C = require('./arc-config');
    const m = C.loadConfig().features && C.loadConfig().features.doneGate;
    if (m) return String(m).toLowerCase();
  } catch {}
  return 'note';
}

// The whole judgement, isolated and pure so it can be tested without a git repo.
// `evidence` is null (unknown) or {commits, files}.
function verdict(evidence, gateMode) {
  if (gateMode === 'off') return { post: false, block: false };
  const proven = !!(evidence && evidence.commits && evidence.commits.length);
  if (proven) return { post: true, block: false, proven: true };
  if (gateMode === 'strict') {
    return {
      post: false, block: true, proven: false,
      reason: 'no commit found between this task being created and now. '
        + 'A task is done when the repo says so. Commit your work (or, if this task '
        + 'genuinely produces no code, say so and ask the user to complete it).',
    };
  }
  return { post: true, block: false, proven: false };   // 'note': post it, flag it
}

// Compose the sticky note. Evidence goes in `refs`, which arc:notes and the turn-start
// injection already render.
function buildNote(payload, evidence, proven, role) {
  const subject = payload.task_subject || `task ${payload.task_id}`;
  // A proven tick CARRIES EVIDENCE (sha + files), so it is a `result` and ranks above routine
  // news. An unverified tick is a CLAIM, so it is plain `info` and sinks in the digest — the
  // note is still delivered (a peer genuinely wants to know the design spec is done), it
  // just doesn't arrive dressed like proof. That is the whole difference: weight, not silence.
  //
  // The old wording — "UNVERIFIED — taken on trust" — read like an accusation. Most uncommitted
  // ticks are simply non-code work (a design doc, a sign-off), where no commit is EXPECTED. State
  // the fact, don't raise an eyebrow.
  const body = proven
    ? `✓ done: ${subject}`
    : `✓ done: ${subject}  (no commit — not code-backed)`;
  const refs = { task: String(payload.task_id) };
  if (proven) {
    refs.sha = evidence.commits[0].sha;
    if (evidence.commits.length > 1) refs.commits = evidence.commits.slice(0, MAX_COMMITS).map((c) => c.sha);
    refs.files = evidence.files.slice(0, MAX_FILES);
    if (evidence.files.length > MAX_FILES) refs.more = evidence.files.length - MAX_FILES;
  }
  return { from: role, to: null, kind: proven ? 'result' : 'info', priority: 'normal', body, refs };
}

// ---- hook entry points -------------------------------------------------------
function onTaskCreated(payload, session) {
  // With the gate OFF nothing ever reads a baseline (onTaskCompleted returns first), so writing
  // one is pure litter. Don't.
  if (mode() === 'off') return { ok: true };
  const board = R.resolveBoard(payload.cwd || process.cwd());
  const sha = head(board.root);
  if (sha) recordBaseline(board, session, payload.task_id, sha);
  // Creating a task is the natural moment to bin the baselines of sessions that will never
  // complete theirs: we are already here, it is infrequent, and it costs one readdir.
  const swept = sweepBaselines(board);
  return { ok: true, swept };
}

// Returns {block, stderr} — the caller decides the exit code.
function onTaskCompleted(payload, session) {
  const g = mode();
  if (g === 'off') return { block: false };

  const board = R.resolveBoard(payload.cwd || process.cwd());

  // NO REPO, NO GATE. "There is no git here" and "git says you committed nothing" are
  // completely different facts, and conflating them is a trap: a session whose cwd has
  // drifted outside a repo (or a project simply not under git) would have EVERY task
  // completion refused, with a bewildering "no commit found". A gate that fires where
  // it cannot possibly gather evidence is not strict, it is broken.
  if (!head(board.root)) return { block: false };

  const base = readBaseline(board, session, payload.task_id, taskFilePath(session, payload.task_id));
  // Prefer the exact sha; fall back to the task's birth time when that sha is unknown
  // to git (an amend or rebase orphaned it) or was never recorded.
  let evidence = base.sha ? evidenceSince(board.root, base.sha) : null;
  if (evidence === null && base.born) evidence = evidenceSince(board.root, base.born);
  const v = verdict(evidence, g);

  if (v.block) return { block: true, stderr: `[arc] ${v.reason}` };

  // The task is genuinely done now (we are not blocking), so the baseline has done its job.
  // Deliberately NOT on the blocked path above: a refused completion gets retried after the
  // agent commits, and that retry needs the EXACT sha. Dropping it there would silently
  // downgrade the gate to the coarser birth-time fallback — the gate would still fire, just on
  // worse evidence, and nothing would say so.
  clearBaseline(board, session, payload.task_id);

  // Post only if this session has a role — the board is opt-in, and a note needs a
  // sender. No role means nobody is listening; stay silent rather than invent one.
  const F = require('./arc-notes');
  const role = F.getRole(session, board);
  if (!v.post || !role) return { block: false };
  try { R.appendNote(board, buildNote(payload, evidence, v.proven, role)); } catch {}

  // A completion is the moment the code most recently moved, so it is also the moment
  // to ask whether the DOCS still describe it. Any anchor that just went stale becomes
  // a [!] note, which the research session receives at the top of its next turn.
  let stale = 0;
  try { stale = require('./arc-anchor').checkAndNotify(board, role).posted || 0; } catch {}
  return { block: false, posted: true, proven: v.proven, stale };
}

module.exports = { git, head, evidenceSince, recordBaseline, readBaseline, clearBaseline, sweepBaselines, verdict, buildNote, onTaskCreated, onTaskCompleted, mode, baselineFile };

// ---- main: read the hook payload on stdin ------------------------------------
if (require.main === module) {
  let raw = '';
  let done = false;
  const finish = () => {
    if (done) return; done = true;
    let p = {};
    try { p = JSON.parse(raw || '{}'); } catch { process.exit(0); }
    const session = (process.env.ARC_SESSION || '').trim();
    try {
      if (p.hook_event_name === 'TaskCreated') { onTaskCreated(p, session); process.exit(0); }
      if (p.hook_event_name === 'TaskCompleted') {
        const r = onTaskCompleted(p, session);
        if (r.block) { process.stderr.write(r.stderr + '\n'); process.exit(2); }
      }
    } catch { /* a hook must NEVER wedge a tool call */ }
    process.exit(0);
  };
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
  setTimeout(finish, 3000).unref();
}
