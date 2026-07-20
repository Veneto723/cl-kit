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
const VERSION = 5;
const COOP_MAX = 20;               // recent reply edges kept per board
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

// A repo's roadmap, parsed from docs/ROADMAP.md: one numbered "## N. Title ..." heading per open
// item, the owner from its "Owner of the next move"/"Next move: `role`" line, and a coarse open/prog
// state. The "## Parked elsewhere" section is not numbered, so it is naturally excluded. Read fresh
// per snapshot (the file is small); a missing file just means no roadmap for that repo.
function parseRoadmap(root) {
  let md; try { md = fs.readFileSync(path.join(root, 'docs', 'ROADMAP.md'), 'utf8'); } catch { return []; }
  const heads = [];
  const rx = /^##\s+\d+\.\s+(.+)$/gm;
  let m; while ((m = rx.exec(md))) heads.push({ idx: m.index, line: m[1] });
  const items = [];
  for (let i = 0; i < heads.length && items.length < 20; i++) {
    const h = heads[i];
    const body = md.slice(h.idx, i + 1 < heads.length ? heads[i + 1].idx : md.length);
    let title = h.line;                                            // title: up to the first ' — ' or ' · '
    const cuts = [' — ', ' · '].map((d) => title.indexOf(d)).filter((k) => k >= 0);
    if (cuts.length) title = title.slice(0, Math.min(...cuts));
    title = title.replace(/\*\*/g, '').replace(/`/g, '').trim().slice(0, 90);
    let owner = null;
    const om = body.match(/(?:Owner of the next move|Next move)[^`\n]*`([a-z][a-z0-9_-]*)`/i);
    if (om) owner = om[1];
    const state = /picked up|in progress|building|\bLIVE\b/i.test(h.line) ? 'prog' : 'open';
    if (title) items.push({ title, owner, state });
  }
  return items;
}

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

    const unread = {};
    for (const rc of roles) { try { unread[rc.role] = B.unreadFor(board, rc.role).count; } catch {} }

    repos.push({
      root: board.root,
      name: board.name,
      roles: roles.map((rc) => {
        const a = actBy.get(rc.sessionId) || {};   // the session behind this role, for its activity
        return { role: rc.role, pid: rc.pid, session: rc.sessionId, convId: rc.convId || null, since: rc.at, activity: a.activity || null, activityAt: a.activityAt || null };
      }),
      sessionCount: sessions.length,
      board: { notes: notes.length, lastTs: notes.length ? notes[notes.length - 1].ts : null, unread },
      waiting,
      cooperation: coop.slice(-COOP_MAX),
      roadmap: parseRoadmap(board.root),
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
    try { fs.watch(CACHE_DIR, { persistent: false }, (ev, fn) => {
      if (!fn || /^arc-(state|status)-/.test(String(fn))) debouncedPush();
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
  sweepOrphans, health, readPid, pidFile, FEED_PORT, VERSION };

if (require.main === module) serve(parseInt(process.argv[2] || FEED_PORT, 10));
