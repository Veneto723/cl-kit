#!/usr/bin/env node
// arc-feed: a read-only 127.0.0.1 status feed for the OPERATOR — the human, who holds no board
// role and so is served by no other reader (injection/badge/requestNotes all resolve a role). It
// answers the one question arc could not: "what are my agents doing, across every repo?"
//
// DOCTRINE: pure Node built-ins, bound to 127.0.0.1 ONLY, read-only (GET), no secrets. It is a
// `src/` module spawned as a detached child of node — the SAME sanctioned shape as the claudex
// proxy, NOT a standalone app. arc ships the FEED; a docked Tauri 2 widget is the opt-in FACE that
// reads it (the feed is renderer-agnostic — a browser or WPF view could read it just as well).
//
// SHAPE (lifted from arc-claudex): a fixed 127.0.0.1 port, a ~/.claude/cache/arc-feed-<port>.json
// pidfile registry, a detached+unref+windowsHide spawn, a /healthz probe, orphan-sweep on launch.
//
// DELIVERY: Server-Sent Events. A client GETs /events and receives the current snapshot immediately,
// then a fresh snapshot whenever the state actually CHANGES. Change is detected by a cheap periodic
// recompute (liveness/age drift touch no file) PLUS fs.watch on the cache dir and each live board's
// ledger dir (near-instant on a note post / a session coming or going). A push fires only when the
// snapshot differs from the last one sent (volatile timestamps excluded), so an idle board is quiet.
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');
const FEED_PORT = parseInt(process.env.ARC_FEED_PORT || '8791', 10);   // next to claudex's 8790
// BUMP whenever the feed's behavior or security changes. It is the ONLY way a running detached feed
// (which never reloads its source) can be told it is stale — ensureFeed restarts a feed whose
// /healthz version is older than this. v2 = the DNS-rebinding Host guard (audit #345: a deployed
// security fix must self-activate on the live surface, not sit inert behind a healthy old process).
// v3 = the built-in operator DASHBOARD at `/` (so the feed is viewable in a browser, not only JSON).
// v4 = procStarts/treeOf set windowsHide (audit #348): the console-less feed was making a NEW
// powershell window every ~30s cache-miss and stealing focus. The fix is in arc-board, but bumping
// HERE is what makes a running feed restart and RELOAD the fixed dependency (a require() is cached
// for the process's life) — the version is the only lever a persistent process has to know it is stale.
// v5 = the DETAIL fields the two-level arc-scope widget reads: per-role `activity` (a session's
// self-reported "working on" line, from `arc status`, stored in arc-status-<session>.json), the note
// `text` (body) on each waiting/cooperation edge so a note is click-to-read, and a per-repo `roadmap`
// parsed from docs/ROADMAP.md. All still loopback-only + read-only; the bump restarts stale feeds.
// v6 = the two-level arc-scope contract: per-role `state` (active/idle/deaf, from the listener
// marker + the transcript heartbeat), `roster` (every chair, live or closed — membership is a CLAIM,
// never an appearance in a note), `pending` (notes the recipient has NOT CONSUMED — the graph's
// edges, which is NOT `waiting`), `flow` (the last 60 ledger notes, every kind), and
// {items,file} from parseRoadmap so "no roadmap" and "a roadmap arc cannot read" stay distinct.
// v7 = `lastTurn` per role (the transcript's last write) so the operator can see when a session
// actually last worked, rather than only what it chose to self-report via `arc status`.
// v8 = per-role `doing` — the newest tool call or sentence from the tail of the session's own
// transcript, so the operator sees what a session is doing NOW rather than what it last told a
// peer. Widens what the loopback feed carries; controls unchanged (127.0.0.1 + Host allowlist).
// v9 = the doing clip widened 160 -> 420 chars, with an explicit ellipsis when truncated so a cut
// line can never read as a complete one. More assistant text on the loopback feed than v8.
// v10 = per-role `task` — the last substantive HUMAN ask from the transcript, cached on file size.
// "running Bash" answers the wrong question; the last thing a session was ASKED is the job it is on.
// v11 = the DEAF state is GONE. It was inferred from the listener marker, and a session is legitimately
// markerless while working (post-wake, and after a revive), so it painted hard-working peers red.
// States are now active / idle / closed only. Reachability lives on the statusline, where it also
// requires a MISSED NOTE as evidence.
// v12 = per-repo `bonds` — lifetime note count per PAIR, plus strength relative to the strongest pair
// on that board. A relationship, not an event: arrows say what is owed now, a bond says who has worked
// with whom. Computed over the WHOLE ledger, not the 60-note flow window.
// v13 = `priority` (high for blocker/correction) on pending + flow, so an ALERT note can be coloured
// as one. Red is reserved for exactly this; ordinary in-flight notes are the neutral accent.
// LESSON, twice over: v6's fields were added WITHOUT bumping this, and the running feed served the
// old shape for hours while `snapshot()` returned the new one correctly when called directly —
// stop/start does not settle it, because a healthy same-version feed is left alone on purpose.
// Change the snapshot's SHAPE, bump this in the same edit.
const VERSION = 18;   // 18: describeTool clips loosened (desc 160 / cmd 120 / delegate 120) — full content, NOW row wraps
const COOP_MAX = 20;               // recent reply edges kept per board
const FLOW_MAX = 60;               // recent ledger notes kept per board (the transcript, all kinds)
const pidFile = (port) => path.join(CACHE_DIR, `arc-feed-${port}.json`);

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Loopback-only Host allowlist — the DNS-rebinding guard, as a PURE function so the security logic
// is unit-tested, not only smoke-tested. Anchored ^...$ so no suffix/prefix smuggling slips through
// (127.0.0.1.evil, localhost.evil all fail); case-insensitive; the port is optional and harmless
// (a Host port can't redirect the socket, and a rebinding attacker cannot put loopback in Host).
const HOST_RX = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
function hostAllowed(host) { return HOST_RX.test(String(host || '').toLowerCase()); }

// ---- the snapshot: a pure function of on-disk state, so it is trivially testable --------------

// Live arc sessions, from the arc-state-<session>.json files the runner writes. `cwd` is written at
// launch and no agent can forge it (arc-invite), so it is the trustworthy session -> repo handle.
function liveSessions() {
  const B = require('./arc-board');
  const cands = [];
  let files; try { files = fs.readdirSync(CACHE_DIR); } catch { return cands; }
  for (const f of files) {
    const m = f.match(/^arc-state-(.+)\.json$/);
    if (!m) continue;
    const p = path.join(CACHE_DIR, f);
    let st, at;
    try { st = JSON.parse(fs.readFileSync(p, 'utf8')); at = fs.statSync(p).mtimeMs; } catch { continue; }
    if (!st.pid || !pidAlive(st.pid)) continue;
    // Self-reported activity ("working on ..."), from `arc status`. Kept in its OWN file so it never
    // races the runner's account-state writes (writeState reconstructs arc-state and would drop it).
    let activity = null, activityAt = null;
    try { const sf = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `arc-status-${m[1]}.json`), 'utf8')); activity = sf.activity || null; activityAt = sf.at || null; } catch {}
    cands.push({ session: m[1], pid: st.pid, cwd: st.cwd || null, convId: st.convId || null, account: st.account || null, at, activity, activityAt });
  }
  if (!cands.length) return cands;
  // GENUINE liveness, not bare pid (audit #343): a recycled pid always STARTED AFTER the arc-state
  // it inherited was written, so isHolder({pid, at: file mtime}) — the SAME start-time check the
  // board uses for roles — rejects a ghost session that would otherwise inflate the count AND keep
  // a dead board in the snapshot. Batched procStarts (one powershell, 30s-cached). Fail-open like
  // isHolder itself: if the OS can't be asked, keep the session rather than blank the feed.
  let starts = null; try { starts = B.procStarts(cands.map((c) => c.pid)); } catch {}
  return cands.filter((c) => { try { return B.isHolder({ pid: c.pid, at: c.at }, starts); } catch { return true; } });
}

// The set of board ledger dirs currently in play — every live session's cwd, resolved to a board,
// deduped by root. There is no registry; this filesystem enumeration IS how arc finds boards.
function activeBoards() {
  const B = require('./arc-board');
  const byRoot = new Map();
  for (const s of liveSessions()) {
    if (!s.cwd) continue;
    let board; try { board = B.resolveBoard(s.cwd); } catch { continue; }
    if (!byRoot.has(board.root)) byRoot.set(board.root, { board, sessions: [] });
    byRoot.get(board.root).sessions.push(s);
  }
  return byRoot;
}

// Directories to watch for change (the cache dir + each live board's ledger dir).
function watchDirs() {
  const dirs = [CACHE_DIR];
  for (const { board } of activeBoards().values()) if (board.planDir) dirs.push(board.planDir);
  return [...new Set(dirs)];
}

const ROADMAP_MAX = 20;
const PENDING_PER_ROLE = 12;       // unconsumed notes reported per chair — this is a graph edge, not a mailbox

// One roadmap line, cleaned of markdown: the title up to the first ' — ' or ' · '.
function roadmapTitle(s) {
  let t = String(s || '');
  const cuts = [' — ', ' · '].map((k) => t.indexOf(k)).filter((k) => k >= 0);
  if (cuts.length) t = t.slice(0, Math.min(...cuts));
  return t.replace(/\*\*/g, '').replace(/`/g, '').replace(/^[★☆*\s]+/, '').trim().slice(0, 90);
}

// A repo's roadmap: one numbered "## N. Title" heading per open item in docs/ROADMAP.md, the owner
// from its "Owner of the next move"/"Next move: `role`" line, and a coarse open/prog state.
//
// ONE dialect, ON PURPOSE. A looser fallback (status sections, items scraped from table rows) was
// written and then REMOVED the same day: whalephone's docs/ROADMAP.md is a doc-status INVENTORY —
// its own subtitle says so, and names the real build-order roadmap in another file — so scraping
// its first table column turned 13 filenames into 13 "roadmap items". Guessing a file's MEANING
// from its NAME manufactures content, which is worse than showing none. If a repo does not write
// the numbered form, arc reports that it found no items and says the file is there; it does not
// invent a backlog out of whatever the file happened to contain.
//
// Returns { items, file } — `file` says a ROADMAP.md EXISTS, so a caller can tell "this repo has
// no roadmap" apart from "arc read no items from this repo's roadmap". Those must never look alike.
function parseRoadmap(root) {
  let md;
  try { md = fs.readFileSync(path.join(root, 'docs', 'ROADMAP.md'), 'utf8'); } catch { return { items: [], file: false }; }

  // ---- dialect 1: numbered headings ----
  const heads = [];
  const rx = /^##\s+\d+\.\s+(.+)$/gm;
  let m; while ((m = rx.exec(md))) heads.push({ idx: m.index, line: m[1] });
  const items = [];
  for (let i = 0; i < heads.length && items.length < ROADMAP_MAX; i++) {
    const h = heads[i];
    const body = md.slice(h.idx, i + 1 < heads.length ? heads[i + 1].idx : md.length);
    const title = roadmapTitle(h.line);
    const om = body.match(/(?:Owner of the next move|Next move)[^`\n]*`([a-z][a-z0-9_-]*)`/i);
    const state = /picked up|in progress|building|\bLIVE\b/i.test(h.line) ? 'prog' : 'open';
    if (title) items.push({ title, owner: om ? om[1] : null, state });
  }
  return { items, file: true };
}

const IDLE_MS = 15 * 60 * 1000;    // no transcript turn for this long => idle (see the caveat below)

// A live chair's state, from TWO independent signals — reachability and recent work.
//
// REACHABILITY is the `arc join` marker at arc-await-<session>.json. Read its meaning carefully: the
// marker says the listener is ARMED, which is arc's normal steady state — the doctrine is arm ONCE
// and leave it armed for the session's whole life, so a peer working flat out has a marker the entire
// time. An earlier version read "marker present" as "idle" and painted every healthy working peer
// yellow while painting an UNARMED one green; that was the meaning exactly inverted. A live
// chair-holder with no armed listener is arc's DEAF condition (the rate-limit squat) — no note can
// wake it — so that, not idleness, is the fault worth a colour.
// The role must MATCH: arc-await:85 is explicit that "waiting" without "waiting-as-whom" reports a
// deaf session as reachable.
//
// WORKING vs IDLE is the transcript's last entry timestamp — when the session last actually wrote.
// It is the only evidence arc has of work; self-reported `activity` cannot answer it, because a
// session that never called `arc status` is SILENT, not idle. A bounded 64KB tail read, so a 130MB
// transcript costs the same as a small one.
// CAVEAT: one very long tool call (a big build) writes nothing meanwhile and can read as idle. Idle
// is therefore the SOFT state — unknown or unreadable always falls back to 'active', never to a
// claim of idleness, because asserting a live peer is idle is the false statement to avoid.
//   no/dead/mismatched marker -> 'deaf'    live but unreachable — a note cannot wake it
//   armed, wrote recently     -> 'active'
//   armed, silent > IDLE_MS   -> 'idle'
// WHAT THE SESSION IS DOING RIGHT NOW, read from the tail of its own transcript.
//
// The alternatives both fail: `arc status` is optional and almost nobody calls it, and a session's
// most recent NOTE is what it last told a peer — often hours old, and never "now". The transcript is
// the only always-present evidence, and its newest entry is literally the thing in progress: the
// tool being run, or the sentence being written.
//
// EXPOSURE, stated plainly: this puts a slice of assistant output on the loopback feed, which is
// more than the metadata it used to carry. Controls are unchanged and still the right ones —
// 127.0.0.1 bind plus the Host allowlist — but the value behind them goes up again, so it is clipped
// hard and prefers the tool NAME (an action, not content) whenever a tool call is the newest thing.
const DOING_MAX = 420;   // long enough to read a real thought; still bounded (exposure + payload)
const TASK_MAX = 200;
const TASK_TAIL = 256 * 1024;    // enough history to reach past a long run of assistant turns

// THE TASK — what this session was last ASKED to do. "running Bash" is a true answer to the wrong
// question: it describes a keystroke, not a job. The last substantive human turn is the job, and it
// is already on disk. Measured against live transcripts, it reads like a task list:
//   arc/code            "user wants a more global status, e.g. working on feat X"
//   whalephone/research "mine the OCR failures from our data"
//   whalephone/android  "tear down the local test server"
// Harness noise is skipped (hook feedback, system notifications, <tags>), as are one-word replies
// like "ok"/"yes" — they are answers to a question, never a statement of the work.
// A board note delivered to a peer also arrives as a user turn, which is correct: for a peer, "audit
// this diff" IS the ask.
//
// CACHED on (convId, size): a transcript only gains meaning when it GROWS, so an idle session is
// read once and then answered from memory — otherwise this is a 256KB read per role per snapshot,
// and the snapshot rebuilds on a 1.2s tick.
const taskMemo = new Map();
function transcriptTask(convId) {
  try {
    const tp = require('./arc-invite').transcriptPath(convId);
    if (!tp) return null;
    const size = fs.statSync(tp).size;
    const memo = taskMemo.get(convId);
    if (memo && memo.size === size) return memo.task;

    const fd = fs.openSync(tp, 'r');
    const span = Math.min(TASK_TAIL, size);
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, size - span);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    let task = null;
    for (let i = lines.length - 1; i >= 0 && task == null; i--) {
      const ln = lines[i].trim();
      if (!ln.startsWith('{')) continue;
      let j; try { j = JSON.parse(ln); } catch { continue; }
      if (j.type !== 'user' || !j.message) continue;
      const c = j.message.content;
      let t = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ') : '';
      t = String(t || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length < 12) continue;                                  // "ok", "yes", "hi"
      if (/^(<|\[|Stop hook|Caveat:|SYSTEM NOTIFICATION|This session is being continued)/i.test(t)) continue;
      // A PASTE IS NOT AN ASK. Measured on a live board: the newest human turn was a pasted API
      // document, and it rendered as that session's "task". A real instruction is a sentence or two;
      // past this length it is material handed over, and the instruction is the turn before it.
      if (t.length > 600) continue;
      // NOR IS A FOLLOW-UP. "whats the result?", "continue", "go on" are the newest human turns but
      // carry no job — they refer to one stated earlier, which is the one worth showing.
      if (/^(what'?s?\b.{0,24}\?$|how about|and\b.{0,12}\?$|continue|go on|carry on|proceed|next|any (update|progress)|done\?|result\??)/i.test(t)) continue;
      task = t.length > TASK_MAX ? t.slice(0, TASK_MAX - 1) + '…' : t;
    }
    if (taskMemo.size > 64) taskMemo.clear();                            // bounded, never a leak
    taskMemo.set(convId, { size, task });
    return task;
  } catch { return null; }
}
// A live one-liner for what a session is doing NOW, read from the CURRENT tool call's INPUT rather than
// its bare name — "running Bash" says nothing; the tool's own description/target says everything. Falls
// back to "running <name>" for anything unmapped, so a new tool is never worse than before.
function describeTool(name, input) {
  const inp = input || {};
  const base = (p) => String(p || '').split(/[\\/]/).pop() || '';
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  switch (name) {
    case 'Bash':
    case 'PowerShell': {
      const d = clip(inp.description, 160); if (d) return d;
      const c = clip(inp.command, 120); return c ? 'shell: ' + c : 'a shell command';
    }
    case 'Edit':
    case 'MultiEdit': return 'editing ' + base(inp.file_path);
    case 'Write': return 'writing ' + base(inp.file_path);
    case 'Read': return 'reading ' + base(inp.file_path);
    case 'NotebookEdit': return 'editing ' + base(inp.notebook_path);
    case 'Grep': return 'searching ' + clip(inp.pattern, 44);
    case 'Glob': return 'finding ' + clip(inp.pattern, 44);
    case 'Task':
    case 'Agent': return 'delegating: ' + clip(inp.description || inp.subagent_type, 120);
    case 'Skill': return 'running /' + clip(inp.skill || inp.command, 40);
    case 'WebFetch': return 'fetching ' + clip(String(inp.url || '').replace(/^https?:\/\//, ''), 44);
    case 'WebSearch': return 'web search: ' + clip(inp.query, 44);
    case 'Workflow': return 'orchestrating a workflow';
    case 'ExitPlanMode': return 'presenting a plan';
    default:
      if (name && name.startsWith('mcp__')) return 'calling ' + name.split('__').slice(-1)[0];
      return 'running ' + name;
  }
}
function transcriptDoing(convId) {
  try {
    const tp = require('./arc-invite').transcriptPath(convId);
    if (!tp) return null;
    const fd = fs.openSync(tp, 'r');
    const size = fs.fstatSync(fd).size;
    const span = Math.min(96 * 1024, size);          // same bounded tail as the heartbeat read
    const buf = Buffer.alloc(span);
    fs.readSync(fd, buf, 0, span, size - span);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    // "Doing" = the most recent tool ACTION in the tail — a clean, COMPLETE answer ("editing X", "Rebuild
    // Y") — preferred over reply PROSE, which is a wall or a clause cut mid-thought. Only a pure-
    // conversation turn (no tool_use anywhere in the tail) falls back to the reply's first clause.
    let firstText = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i].trim();
      if (!ln.startsWith('{')) continue;
      let j; try { j = JSON.parse(ln); } catch { continue; }
      if (j.type !== 'assistant' || !j.message || !Array.isArray(j.message.content)) continue;
      const tool = j.message.content.find((c) => c && c.type === 'tool_use');
      if (tool && tool.name) { const d = describeTool(tool.name, tool.input); return d.length > DOING_MAX ? d.slice(0, DOING_MAX - 1) + '…' : d; }
      if (firstText === null) {
        const text = j.message.content.find((c) => c && c.type === 'text' && c.text);
        if (text) firstText = String(text.text);
      }
    }
    if (firstText !== null) {
      let t = firstText
        .replace(/```[\s\S]*?```/g, ' ')     // drop fenced code blocks
        .replace(/[*_`#>|]+/g, ' ')          // strip emphasis / headings / table pipes
        .replace(/\s+/g, ' ').trim();
      const m = t.match(/^.{20,}?[.!?:;—]/);        // clip to the first CLAUSE boundary (sentence / colon / dash)
      if (m) t = m[0].trim();
      return t.length > 84 ? t.slice(0, 83) + '…' : t;
    }
  } catch {}
  return null;
}

// Returns { state, lastTurn } — lastTurn is the transcript's last write (ms epoch, or null when
// unreadable). It was computed here and discarded; the operator view needs it, because "when did
// this session last actually do something" is the one evidence-backed answer to "what is it doing"
// that does not depend on the session having self-reported via `arc status`.
function roleStateOf(claim) {
  if (!claim || !claim.sessionId) return { state: 'active', lastTurn: null, doing: null, task: null };

  // THE HEARTBEAT FIRST. The transcript beats only during work — it advances with every tool call
  // while a turn runs and stops the moment the session idles (arc-notes.js:748).
  let last = null;
  try { last = require('./arc-invite').lastTurnAt(claim.convId, null); } catch {}
  const doing = transcriptDoing(claim.convId);
  const task = transcriptTask(claim.convId);
  // null, NOT Infinity: an unreadable transcript is NO EVIDENCE, and Infinity would quietly read as
  // "silent forever" — asserting idle (or deaf) about a session nothing is known about. Both are
  // accusations; neither may be made without the heartbeat to back it.
  const quiet = last ? Date.now() - last : null;

  // NO DEAF STATE. It was derived from the `arc join` listener marker, and it cried wolf twice on
  // sessions that were working their hardest:
  //   1. the listener EXITS on delivery (that exit IS the wake) and only re-arms at turn end, so a
  //      session is markerless for the whole turn a note triggered;
  //   2. a REVIVE deletes the marker outright (arc-runner.js:591), and the revived session then does
  //      a long tool call — a web search, a build — writing nothing meanwhile. Unarmed plus quiet
  //      looked exactly like deafness while `research` was mid-investigation.
  // A 90s heartbeat gate did not save it, because a single tool call can exceed 90s. The honest
  // position is that this feed cannot distinguish "cannot be reached" from "busy and not writing",
  // and a status colour that is wrong when it matters most is worse than one fewer colour.
  // Reachability still has a home: arc-notes.js:820 badges DEAF on the statusline, where it also
  // requires evidence of a MISSED NOTE — not merely a missing marker — which is the check this
  // never had. (Operator's call, this session.)
  return { state: (quiet != null && quiet > IDLE_MS) ? 'idle' : 'active', lastTurn: last, doing, task };
}
// The state alone, for callers that do not want the heartbeat.
function roleState(claim) { return roleStateOf(claim).state; }

// The whole operator view. Timestamps (not computed ages) so the widget derives elapsed locally and
// the change-detector stays quiet on an idle board.
function snapshot() {
  const B = require('./arc-board');
  const clip = (s) => String(s == null ? '' : s).slice(0, 1000);   // note body, bounded for the feed
  const repos = [];
  for (const { board, sessions } of activeBoards().values()) {
    const actBy = new Map(sessions.map((s) => [s.session, s]));     // session id -> its self-reported activity
    let roles = []; try { roles = B.liveRoles(board); } catch {}
    let notes = []; try { notes = B.allNotes(board); } catch {}
    let open = []; try { open = B.openRequests(board); } catch {}

    // WAITING GRAPH: a directed edge from -> to for every unanswered request, per recipient.
    const waiting = [];
    for (const n of open) {
      let rs = []; try { rs = B.requestStatus(board, n, notes); } catch {}
      if (rs.length) {
        for (const r of rs) if (!r.replied) waiting.push({ from: n.from, to: r.role, seq: n.seq, id: n.id, ts: n.ts, seen: !!r.seen, text: clip(n.body) });
      } else if (n.to != null) {
        // DEFENSIVE (audit #343 claim 3): requestStatus returns [] only for a broadcast (to==null),
        // so for a NAMED recipient this branch never fires under the current contract — kept as a
        // belt-and-suspenders so a named request that ever yields no status still shows as an edge.
        const to = Array.isArray(n.to) ? n.to.join('+') : String(n.to);
        waiting.push({ from: n.from, to, seq: n.seq, id: n.id, ts: n.ts, seen: false });
      }
      // a broadcast request (to == null) has no single waited-on peer — left out of the edge list.
    }

    // COOPERATION GRAPH: recent reply edges (who answered whom). Per-board only — the data holds no
    // cross-repo session link, so this is honest within a repo and not stitched across.
    const bySeq = new Map(notes.map((n) => [n.seq, n]));
    const coop = [];
    for (const n of notes) {
      if (!n.replyTo) continue;
      let tseq = null; try { tseq = B.refSeq(notes, n.replyTo); } catch {}
      const tgt = tseq ? bySeq.get(tseq) : null;
      if (tgt) coop.push({ from: n.from, to: tgt.from, seq: n.seq, reSeq: tgt.seq, text: clip(n.body) });
    }

    // NOTE FLOW: the ledger itself — every kind, newest last, capped. This is deliberately NOT the
    // waiting list. `waiting` holds only UNANSWERED requests, so a board with 300 notes and 2 open
    // asks renders two rows and reads as "the history is gone" — replies, results, broadcasts and
    // every answered request are all missing from it. The GRAPH still draws from `waiting` (an arrow
    // means an unconsumed note and dissolves when consumed); this is the transcript underneath it.
    const openIds = new Set(open.map((n) => n.id));
    // BONDS — how much each PAIR has ever worked together. A different kind of fact from `pending`:
    // an arrow is an event (this note is owed, right now), a bond is a relationship (these two have
    // exchanged 84 notes). Both directions are merged, because a bond is mutual — who asked and who
    // answered is what the arrows are for.
    // Computed over the WHOLE ledger, deliberately, NOT over `flow`: flow is the last 60 notes, so a
    // bond derived from it would silently be "recent traffic" wearing the word history.
    // `strength` is RELATIVE to the strongest pair on this board (0..1). An absolute count cannot be
    // drawn — a 500-note board would saturate every line — and the operator's question is "who works
    // together MOST here", which is a comparison within one board.
    const bondN = new Map();
    for (const n of notes) {
      const from = n.from, to = n.to;
      if (!from || to == null) continue;                       // a broadcast has no pair
      if (from === 'arc') continue;                            // the tool's own freshness briefs
      for (const t of (Array.isArray(to) ? to : [to])) {
        if (!t || t === from) continue;
        const key = from < t ? from + '|' + t : t + '|' + from;
        bondN.set(key, (bondN.get(key) || 0) + 1);
      }
    }
    let bondMax = 0;
    for (const v of bondN.values()) if (v > bondMax) bondMax = v;
    const bonds = [];
    for (const [key, v] of bondN) {
      const [a, b] = key.split('|');
      bonds.push({ a, b, notes: v, strength: bondMax ? v / bondMax : 0 });
    }
    bonds.sort((x, y) => y.notes - x.notes);

    const flow = notes.slice(-FLOW_MAX).map((n) => ({
      from: n.from,
      // a broadcast has no single recipient (to == null) — say so rather than inventing one
      to: n.to == null ? null : Array.isArray(n.to) ? n.to.join('+') : String(n.to),
      seq: n.seq, id: n.id, ts: n.ts, kind: n.kind || null, priority: n.priority === 'high' ? 'high' : 'normal',
      open: openIds.has(n.id),        // still awaiting an answer
      text: clip(n.body),
    }));

    // THE ROSTER: every chair ever claimed on this board, live or closed. A CLAIM FILE is what makes
    // a role a member here — not appearing in a note. Reasoning from note text put a `code` node on
    // whalephone's graph because a peer had written *about* arc's `code`; the board has no
    // claim-code.json, so `code` was never a session there at all. Membership is a claim, full stop.
    const roster = [];
    try {
      const files = fs.readdirSync(board.planDir)
        .map((f) => (f.match(/^(?:claim|lease)-(.+)\.json$/) || [])[1])
        .filter((r, i, a) => r && a.indexOf(r) === i);
      const liveNames = new Set(roles.map((r) => r.role));
      for (const r of files) {
        const live = roles.find((x) => x.role === r);
        const rs = live && liveNames.has(r) ? roleStateOf(live) : null;
        roster.push(live ? { role: r, state: rs ? rs.state : 'closed', pid: live.pid, lastTurn: rs && rs.lastTurn ? new Date(rs.lastTurn).toISOString() : null, doing: rs ? rs.doing : null, task: rs ? rs.task : null }
                         : { role: r, state: 'closed', pid: 0, lastTurn: null });
      }
    } catch {}

    // PENDING: notes the recipient has NOT CONSUMED — its cursor has not passed them. This, not
    // `waiting`, is what an arrow on the graph means: "a note is owed until consumed", so the arrow
    // dissolves when the note is READ. `waiting` answers a different question (which REQUESTS are
    // unanswered), and a request can sit open for days after being read — whalephone drew a quiz→
    // research arrow for note #114 that had been consumed long ago, while the live android↔research
    // traffic was invisible.
    const pending = [];
    const pendingMore = {};        // role -> directed notes the cap discarded (0 entries = nothing hidden)
    for (const chair of roster) {
      // A CLOSED chair can never consume, so its unread pile never drains and every note in it
      // becomes an immortal arrow — the exact staleness this field exists to remove. What a departed
      // session owes is a dead letter, not pending cooperation.
      if (chair.state === 'closed') continue;
      try {
        const u = B.unreadFor(board, chair.role);
        // FILTER FIRST, THEN CAP. The other order silently loses every directed note older than the
        // trailing window: take the last 12 unread and THEN drop broadcasts, and a chair whose 12
        // newest unread are announcements reports ZERO owed notes while real asks sit behind them.
        // That is this field's own motivating bug inverted — not a phantom arrow, a missing one
        // (audit #235 blocker 1). Directedness decides membership; the cap only bounds the payload.
        const directed = u.notes.filter((n) => n.to != null);
        const kept = directed.slice(-PENDING_PER_ROLE);
        for (const n of kept) {
          pending.push({
            from: n.from, to: chair.role, seq: n.seq, id: n.id, ts: n.ts, text: clip(n.body),
            // an ALERT note (blocker/correction) is stamped high by arc-board.js:326 — the operator
            // needs that on the graph, not only in a list they may not scroll to
            kind: n.kind || null, priority: n.priority === 'high' ? 'high' : 'normal',
            // UNCONSUMED IS UNSEEN — by definition, this is the recipient's unread pile. The GUI
            // colours an edge by `seen`, and a missing key reads as false there, so every arrow
            // rendered permanently red once edges moved from waiting[] to pending[] (blocker 3).
            // Ship it explicitly rather than let the consumer infer it from an absent field.
            seen: false,
          });
        }
        // A cap that hides work must SAY it hid work: a genuine backlog and a truncated one are
        // otherwise byte-identical to the consumer — the same reason roadmapFile exists.
        if (directed.length > kept.length) {
          pendingMore[chair.role] = directed.length - kept.length;
        }
      } catch {}
    }

    const rm = parseRoadmap(board.root);
    const unread = {};
    for (const rc of roles) { try { unread[rc.role] = B.unreadFor(board, rc.role).count; } catch {} }

    repos.push({
      root: board.root,
      name: board.name,
      roles: roles.map((rc) => {
        const a = actBy.get(rc.sessionId) || {};   // the session behind this role, for its activity
        const rst = roleStateOf(rc);
        return { role: rc.role, pid: rc.pid, session: rc.sessionId, convId: rc.convId || null, since: rc.at, activity: a.activity || null, activityAt: a.activityAt || null, state: rst.state, lastTurn: rst.lastTurn ? new Date(rst.lastTurn).toISOString() : null, doing: rst.doing, task: rst.task };
      }),
      sessionCount: sessions.length,
      board: { notes: notes.length, lastTs: notes.length ? notes[notes.length - 1].ts : null, unread },
      roster,      // every chair on this board, live or closed — the graph's node set
      bonds,       // per-PAIR lifetime note counts + relative strength — the relationship layer
      pending,     // notes NOT YET CONSUMED by their recipient — the graph's edges
      pendingMore, // role -> how many directed notes the cap hid, so "capped" never looks like "none"
      waiting,
      flow,
      cooperation: coop.slice(-COOP_MAX),
      roadmap: rm.items,
      roadmapFile: rm.file,     // a ROADMAP.md exists — lets the UI say "unreadable", never "empty"
    });
  }
  repos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { at: Date.now(), host: os.hostname(), version: VERSION, repos };
}

// ---- the built-in dashboard (so the feed is VIEWABLE, not only JSON) ---------------------------
// A self-contained page (no external assets — CSP-clean, doctrine-clean) served at `/`. It renders
// the snapshot embedded at request time, then live-updates over the /events SSE stream. The Tauri
// widget remains the opt-in nicer FACE; this is the "open it and see it works" view.
const DASHBOARD_SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>arc · operator</title><style>
:root{--bg:#0d1117;--card:#161b22;--bd:#30363d;--fg:#e6edf3;--dim:#8b949e;--grn:#3fb950;--amb:#d29922;--red:#f85149;--blu:#58a6ff;--mono:'Cascadia Code',ui-monospace,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--mono);font-size:13px;line-height:1.5}
header{display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--bd);position:sticky;top:0;background:var(--bg);z-index:1}
.dot{width:8px;height:8px;border-radius:50%;background:var(--grn);box-shadow:0 0 7px var(--grn);flex:none}.dot.stale{background:var(--amb);box-shadow:none}
.logo{font-weight:700;color:var(--blu)}.meta{color:var(--dim);font-size:12px;margin-left:auto}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px;padding:18px;max-width:1400px}
.repo{background:var(--card);border:1px solid var(--bd);border-radius:9px;padding:15px}
.repo h2{margin:0;font-size:15px}.path{color:var(--dim);font-size:11px;margin:2px 0 11px;word-break:break-all}
.roles{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:9px}
.chip{display:inline-flex;align-items:center;gap:5px;background:#21262d;border:1px solid var(--bd);border-radius:12px;padding:2px 9px;font-size:12px}
.chip .d{width:7px;height:7px;border-radius:50%;background:var(--grn)}.chip .pid{color:var(--dim)}
.stat{color:var(--dim);font-size:12px;margin-bottom:6px}
.sec{margin-top:11px}.sec h3{margin:0 0 5px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
.edge{display:flex;align-items:baseline;gap:6px;padding:2px 0;font-size:12px}
.edge .f{color:var(--blu)}.edge .t{color:var(--amb)}.edge .a{color:var(--dim)}.edge .g{margin-left:auto;color:var(--dim);font-size:11px}
.edge.unseen .t{color:var(--red)}.coop .f{color:var(--grn)}
.empty{color:var(--dim);font-style:italic;font-size:12px}
</style></head><body>
<header><span class="dot" id="dot"></span><span class="logo">arc · operator</span><span class="meta" id="meta">__ARC_META__</span></header>
<div class="grid" id="grid">__ARC_CARDS__</div><script>
var INITIAL=__ARC_SNAPSHOT__,last=INITIAL;
var grid=document.getElementById('grid'),meta=document.getElementById('meta'),dot=document.getElementById('dot');
function ago(ts){if(!ts)return'';var s=Math.max(0,(Date.now()-new Date(ts).getTime())/1000);return s<60?Math.round(s)+'s':s<3600?Math.round(s/60)+'m':Math.round(s/3600)+'h';}
function E(s){return String(s==null?'':s).replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
function render(snap){if(!snap){return;}last=snap;
 meta.textContent=E(snap.host)+' · '+snap.repos.length+' repo'+(snap.repos.length===1?'':'s')+' · '+ago(snap.at)+' ago';
 grid.innerHTML=snap.repos.map(function(r){
  var roles=r.roles.length?r.roles.map(function(x){return '<span class="chip"><span class="d"></span>'+E(x.role)+' <span class="pid">'+E(x.pid)+'</span></span>';}).join(''):'<span class="empty">no live roles</span>';
  var w=r.waiting.length?r.waiting.map(function(e){return '<div class="edge '+(e.seen?'':'unseen')+'"><span class="f">'+E(e.from)+'</span><span class="a">→</span><span class="t">'+E(e.to)+'</span><span class="g">#'+e.seq+' · '+ago(e.ts)+(e.seen?'':' · unseen')+'</span></div>';}).join(''):'<span class="empty">nobody waiting</span>';
  var c=r.cooperation.length?r.cooperation.slice(-6).reverse().map(function(e){return '<div class="edge coop"><span class="f">'+E(e.from)+'</span><span class="a">↩</span><span class="t">'+E(e.to)+'</span><span class="g">re #'+e.reSeq+'</span></div>';}).join(''):'<span class="empty">no replies yet</span>';
  return '<div class="repo"><h2>'+E(r.name)+'</h2><div class="path">'+E(r.root)+'</div><div class="roles">'+roles+'</div><div class="stat">'+r.sessionCount+' session'+(r.sessionCount===1?'':'s')+' · '+r.board.notes+' notes</div><div class="sec"><h3>⧗ waiting on</h3>'+w+'</div><div class="sec"><h3>↩ recent replies</h3>'+c+'</div></div>';
 }).join('')||'<div class="empty" style="padding:24px">no live arc sessions right now</div>';}
render(INITIAL);
try{var es=new EventSource('/events');es.onmessage=function(e){try{render(JSON.parse(e.data));dot.classList.remove('stale');}catch(x){}};es.onerror=function(){dot.classList.add('stale');};}catch(e){}
setInterval(function(){render(last);},5000);
</script></body></html>`;

// Server-side render of the card grid (SSR) so the dashboard shows content WITHOUT JS — a better
// first paint, and a preview that renders anywhere. The client re-renders the same shape over SSE.
function renderCards(snap) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const ago = (ts) => { if (!ts) return ''; const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000); return s < 60 ? Math.round(s) + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };
  if (!snap || !snap.repos || !snap.repos.length) return '<div class="empty" style="padding:24px">no live arc sessions right now</div>';
  return snap.repos.map((r) => {
    const roles = (r.roles || []).length ? r.roles.map((x) => `<span class="chip"><span class="d"></span>${esc(x.role)} <span class="pid">${esc(x.pid)}</span></span>`).join('') : '<span class="empty">no live roles</span>';
    const w = (r.waiting || []).length ? r.waiting.map((e) => `<div class="edge ${e.seen ? '' : 'unseen'}"><span class="f">${esc(e.from)}</span><span class="a">→</span><span class="t">${esc(e.to)}</span><span class="g">#${e.seq} · ${ago(e.ts)}${e.seen ? '' : ' · unseen'}</span></div>`).join('') : '<span class="empty">nobody waiting</span>';
    const c = (r.cooperation || []).length ? r.cooperation.slice(-6).reverse().map((e) => `<div class="edge coop"><span class="f">${esc(e.from)}</span><span class="a">↩</span><span class="t">${esc(e.to)}</span><span class="g">re #${e.reSeq}</span></div>`).join('') : '<span class="empty">no replies yet</span>';
    return `<div class="repo"><h2>${esc(r.name)}</h2><div class="path">${esc(r.root)}</div><div class="roles">${roles}</div><div class="stat">${r.sessionCount} session${r.sessionCount === 1 ? '' : 's'} · ${r.board.notes} notes</div><div class="sec"><h3>⧗ waiting on</h3>${w}</div><div class="sec"><h3>↩ recent replies</h3>${c}</div></div>`;
  }).join('');
}

function dashboardHtml(snap) {
  const s = snap || { repos: [], host: '', at: Date.now() };
  // Escape < so </script> cannot break out of the embedded <script> (audit #352 — verified SOUND).
  const data = JSON.stringify(s).replace(/</g, '\\u003c');
  const n = s.repos ? s.repos.length : 0;
  const meta = `${String(s.host || '')} · ${n} repo${n === 1 ? '' : 's'}`.replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
  // Function replacements so a `$` in a path/role/JSON is literal, never a $&/$1 substitution. ORDER
  // MATTERS (audit #352 R4): the shell must keep __ARC_META__ before __ARC_CARDS__ before
  // __ARC_SNAPSHOT__ in document order — first-occurrence replace is only safe while no earlier fill
  // can reintroduce a later placeholder. Do NOT move the embedded-snapshot <script> above the grid.
  return DASHBOARD_SHELL
    .replace('__ARC_SNAPSHOT__', () => data)
    .replace('__ARC_CARDS__', () => renderCards(s))
    .replace('__ARC_META__', () => meta);
}

// ---- lifecycle: pidfile registry + detached spawn + health, lifted from arc-claudex -----------

function readPid(port) { try { return JSON.parse(fs.readFileSync(pidFile(port), 'utf8')); } catch { return null; } }
function writePid(port, rec) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = pidFile(port) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec)); fs.renameSync(tmp, pidFile(port)); } catch {}
}

// GET /healthz, resolves the parsed JSON or null (down / not ours). Never throws.
function health(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Drop any feed pidfile whose process is dead. Returns the count swept.
function sweepOrphans() {
  let n = 0, files = [];
  try { files = fs.readdirSync(CACHE_DIR); } catch { return 0; }
  for (const f of files) {
    const m = f.match(/^arc-feed-(\d+)\.json$/);
    if (!m) continue;
    const rec = readPid(parseInt(m[1], 10));
    if (!rec || !pidAlive(rec.pid)) { try { fs.unlinkSync(path.join(CACHE_DIR, f)); n++; } catch {} }
  }
  return n;
}

// Ensure the feed is up — reuse if healthy, else spawn it detached. BEST-EFFORT and fast: it is
// called on every launch and must never delay or wedge a session, so it does not wait for health.
async function ensureFeed(opts = {}) {
  const port = opts.port || FEED_PORT;
  const url = `http://127.0.0.1:${port}`;
  const probe = opts.health || health;
  try {
    const h = await probe(port, 600);
    if (h && h.ok) {
      if (Number(h.version) >= VERSION) return { ok: true, port, url, reused: true };   // up-to-date — reuse
      // A LIVE feed running OLDER code. A persistent detached process never reloads its source, and
      // reusing on health alone let a DEPLOYED security fix sit inert on the running surface (audit
      // #345). Restart it so the live feed matches the deployed bytes; reuse ONLY on a version match.
      stopFeed(port);
      await new Promise((r) => setTimeout(r, 250));   // let the port free before respawning
    }
  } catch {}
  const rec = readPid(port);
  // health-first already caught a feed that is actually up, so /healthz just failed. Only decline to
  // spawn if the pidfile is RECENT (a feed genuinely mid-startup). An OLD pidfile whose pid is alive
  // is a stale/recycled FOREIGN pid — trusting it would leave the feed DOWN forever (audit #343
  // claim-4 residual); reclaim it and spawn.
  if (rec && rec.pid && pidAlive(rec.pid) && Date.now() - (rec.started || 0) < 10000) {
    return { ok: true, port, url, reused: true };
  }
  if (rec) { try { fs.unlinkSync(pidFile(port)); } catch {} }                    // stale/recycled — reclaim
  try {
    const spawnFn = opts.spawn || spawn;
    const child = spawnFn(process.execPath, [__filename, String(port)], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    writePid(port, { pid: child.pid, port, started: Date.now(), version: VERSION });
    return { ok: true, port, url, pid: child.pid, reused: false };
  } catch (e) { return { ok: false, port, url, error: e.message }; }
}

function stopFeed(port = FEED_PORT) {
  const rec = readPid(port);
  try { if (rec && rec.pid) process.kill(rec.pid); } catch {}
  try { fs.unlinkSync(pidFile(port)); } catch {}
  return { ok: true, port, wasRunning: !!(rec && rec.pid) };
}

async function feedStatus(port = FEED_PORT) {
  const h = await health(port, 800);
  const rec = readPid(port);
  return { port, url: `http://127.0.0.1:${port}`, healthy: !!(h && h.ok), pid: rec && rec.pid, version: h && h.version };
}

// ---- the server (run as `node arc-feed.js <port>`) --------------------------------------------

function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

function serve(port) {
  const clients = new Set();
  let lastStable = null;   // JSON of the last-pushed snapshot with volatile fields zeroed

  const build = () => { try { const s = snapshot(); return { s, body: JSON.stringify(s) }; } catch { return null; } };
  const stableOf = (s) => JSON.stringify({ ...s, at: 0 });   // exclude the wall-clock stamp from change-detection

  const boardWatchers = new Map();   // dir -> FSWatcher
  const push = () => {
    const c = build(); if (!c) return;
    syncWatches();                                           // the board set may have changed
    const stable = stableOf(c.s);
    if (stable === lastStable) return;                       // nothing actually changed — stay quiet
    lastStable = stable;
    const frame = `data: ${c.body}\n\n`;
    for (const res of clients) { try { res.write(frame); } catch {} }
  };
  const debouncedPush = debounce(push, 300);

  const syncWatches = () => {
    const want = new Set(watchDirs());
    for (const [dir, w] of boardWatchers) if (!want.has(dir)) { try { w.close(); } catch {} boardWatchers.delete(dir); }
    for (const dir of want) if (!boardWatchers.has(dir)) {
      try { boardWatchers.set(dir, fs.watch(dir, { persistent: false }, debouncedPush)); } catch {}
    }
  };

  const server = http.createServer((req, res) => {
    // DNS-REBINDING GUARD (audit #343): a page that rebinds its own domain to 127.0.0.1 reaches us
    // SAME-ORIGIN and CORS won't stop it, but the browser still sends the attacker's domain in Host —
    // so a loopback-only Host allowlist closes the rebinding read of our cross-repo metadata.
    if (!hostAllowed(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end('{"error":"forbidden host"}');
    }
    const u = (req.url || '/').split('?')[0];
    if (u === '/' || u === '/dashboard') {                  // the built-in operator view (HTML)
      const c = build();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(dashboardHtml(c ? c.s : null));
    }
    if (u === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, version: VERSION, uptime: Math.round(process.uptime()) }));
    }
    if (u === '/status') {                                   // one-shot JSON (poll / debugging)
      const c = build();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(c ? c.body : '{"repos":[]}');
    }
    if (u === '/events') {                                   // SSE stream
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(': arc-feed\n\n');
      const c = build(); if (c) res.write(`data: ${c.body}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not found"}');
  });

  // A bind failure must exit(1) cleanly (another feed already owns the port), not crash — the
  // supervisor reads "did not come up", exactly like the claudex proxy.
  server.on('error', () => process.exit(1));
  server.listen(port, '127.0.0.1', () => {
    writePid(port, { pid: process.pid, port, started: Date.now(), version: VERSION });   // claim as the real owner
    syncWatches();
    // Only a SESSION change (arc-state) matters from this BUSY dir — ignore await/offer/alarm-ack/
    // pidfile churn, which would otherwise trigger a full multi-board rebuild for nothing (audit
    // #343 perf note). Note posts are caught by the per-board ledger watches in syncWatches().
    // `await` joined this list when roleState started reading the listener marker: arming or losing
    // a listener CHANGES THE SNAPSHOT, so a filter that ignored it left the feed reporting a state
    // it was no longer watching — visible only when the 1.2s tick happened to catch up.
    // The rule: every file the snapshot READS must be a file the watcher WAKES on.
    try { fs.watch(CACHE_DIR, { persistent: false }, (ev, fn) => {
      if (!fn || /^arc-(state|status|await)-/.test(String(fn))) debouncedPush();
    }); } catch {}
  });

  // Periodic recompute: liveness and request-age changes touch NO file, so fs.watch alone would
  // miss a session dying or a chair going empty. push() is a no-op when nothing changed.
  const tick = setInterval(push, 1200);
  if (tick.unref) tick.unref();
  // SSE keepalive so proxies/clients don't drop an idle stream.
  const ka = setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch {} } }, 25000);
  if (ka.unref) ka.unref();
}

module.exports = { snapshot, liveSessions, activeBoards, watchDirs, hostAllowed, dashboardHtml, ensureFeed, stopFeed, feedStatus,
  sweepOrphans, health, readPid, pidFile, FEED_PORT, VERSION,
  __parseRoadmap: parseRoadmap };   // exported for the dialect tests — parsing is the part that silently lies

if (require.main === module) serve(parseInt(process.argv[2] || FEED_PORT, 10));
