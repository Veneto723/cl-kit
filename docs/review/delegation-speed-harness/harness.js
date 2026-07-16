'use strict';
// Trial harness for the delegation-speed protocol (docs/review/delegation-speed-protocol-2026-07-16.md).
// Drives REAL cold-birthed worker (+ owner) sessions on `whale` and measures VERIFIED wall-clock:
// time from task-delivery to ALL named oracles passing (poll-based, never self-report), plus the
// per-owner active windows that give the concurrency factor. Pinned to whale per Amendment 1.
//
// Subcommands (see run-round.ps1 for the loop that sequences them):
//   node harness.js setup <regime> <keeperPid>   write the synthetic dispatch session state; assert COLD (no fork)
//   node harness.js start <regime> <N> <trial>   reset repo+board, claim dispatch, cold-birth worker with the N-task packet
//   node harness.js poll  <regime> <N>           run the N oracles; on first all-pass, stamp t_done; prints elapsed
//   node harness.js score <regime> <N> <trial>   append the scored row (wall-clock, induction, concurrency) to results.jsonl
//   node harness.js kill  <regime>               taskkill the worker + any spawned owner session trees
//   node harness.js reset <regime>               board+worktree reset only
process.env.ARC_RUNTIME_ACCOUNT = 'whale';                    // Amendment 1: pinned across ALL arms
process.env.ARC_SPAWN_QUIET = '1';                            // code c10c1f9: minimised (no-focus) spawn — DISCLOSED deviation from shipping default (Amendment 2)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const I = require('E:/arc/src/arc-invite');
const N = require('E:/arc/src/arc-notes');

const ROOT = 'E:/arc-ab';
const HARN = 'E:/arc/docs/review/delegation-speed-harness';
const FIXTURE = { self: '7cae87833e', deleg: '89e65727bb' };   // pinned by build-fixture.js (neutral worker charter)
const AREAS = {
  retry: { oracle: 'test/retry.test.js', owner: 'owner-retry', glob: /src[\\/]+retry[\\/]/i,
    task: 'the retry path promises a capped delay but a delay can exceed the cap — make the backoff respect its cap.' },
  money: { oracle: 'test/money.test.js', owner: 'owner-money', glob: /src[\\/]+money[\\/]/i,
    task: 'withTax returns fractional cents, but money is integer cents everywhere — make it return rounded integer cents.' },
  parse: { oracle: 'test/parse.test.js', owner: 'owner-parse', glob: /src[\\/]+parse[\\/]/i,
    task: 'parseLine leaves surrounding whitespace on CSV fields, but callers expect trimmed fields — fix it.' },
};
const EDITS = new Set(['Edit', 'Write', 'NotebookEdit']);

const repo = (rg) => path.join(ROOT, rg);
const peerDir = (rg) => path.join(repo(rg), '.arc', 'peer');
const session = (rg) => `dspeed-${rg}`;
const stateFile = (rg) => path.join(HARN, `run-${rg}.json`);   // one active trial per regime at a time
const parseAreas = (csv) => String(csv || '').split(',').map((s) => s.trim()).filter(Boolean);
const log = (s) => process.stdout.write(s + '\n');
const git = (rg, ...a) => execFileSync('git', ['-C', repo(rg), ...a], { encoding: 'utf8' }).trim();
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// Load proxy (code #76 (b)): concurrent claude+node process counts + CPU%, sampled THROUGH each trial
// (start, every poll, score). Wall-clock on a shared box is a rumour without this — a slow trial that
// also shows high load is a load artifact, not a delegation cost.
function loadProxy() {
  let claude = 0, node = 0, cpu = null;
  try { claude = (execFileSync('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/NH'], { encoding: 'utf8' }).match(/claude\.exe/gi) || []).length; } catch {}
  try { node = (execFileSync('tasklist', ['/FI', 'IMAGENAME eq node.exe', '/NH'], { encoding: 'utf8' }).match(/node\.exe/gi) || []).length; } catch {}
  try { cpu = Number(execFileSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_Processor).LoadPercentage'], { encoding: 'utf8' }).trim()); } catch {}
  return { at: new Date().toISOString(), claude, node, cpu: Number.isFinite(cpu) ? cpu : null };
}
function pushLoad(rg) {
  const st = readJson(stateFile(rg)); if (!st) return;
  (st.load_samples = st.load_samples || []).push(loadProxy());
  try { fs.writeFileSync(stateFile(rg), JSON.stringify(st, null, 1)); } catch {}
}

// ---- the task packet (IDENTICAL across regimes; names the problem, never a file or a doer) --------
function packet(areas) {
  if (areas.length === 1) return AREAS[areas[0]].task;
  const items = areas.map((a, i) => `(${i + 1}) ${AREAS[a].task}`).join('  ');
  return `Several independent problems in this repo need fixing — they touch different areas and no shared files:  ${items}`;
}

// ---- board + worktree reset (pristine fixture; dispatch keeper survives) ---------------------------
// REAP BEFORE WIPING. The wipe deletes claim-*.json — the only handle on a live peer — so a peer that
// outlives its trial becomes unkillable the moment we reset. That is exactly how zombie 9fa28d80
// survived trial 4's VOID and then did trials 5+6's work, fabricating both N=3 data points.
function reset(rg) {
  kill(rg);
  git(rg, 'checkout', '--', '.');
  git(rg, 'clean', '-fdq');
  git(rg, 'reset', '--hard', '-q', FIXTURE[rg]);
  const pd = peerDir(rg);
  if (fs.existsSync(pd)) for (const f of fs.readdirSync(pd)) {
    if (f === '.gitignore') continue;
    fs.rmSync(path.join(pd, f), { force: true, recursive: true });
  }
  log(`[${rg}] reset to ${FIXTURE[rg]} (board wiped, peers reaped)`);
}

// ---- a VOID must never leave a spawn behind -------------------------------------------------------
// A TIMEOUT OBSERVES THE WATCHER, NOT THE WORLD (arc learned this once already: eb53c3c). The launcher
// can spawn LATE, so "chair never filled in 60s" means "not yet" — never "nobody". At void time the
// claim usually does not exist yet, so reaping once is not enough: keep watching through a grace
// window and reap the late arrival. An orphan holding a task packet is not idle — it WORKS, and its
// work is indistinguishable from a real worker's.
const VOID_GRACE_MS = 90000;
function claimedRoles(rg) {
  try { return fs.readdirSync(peerDir(rg)).filter((f) => /^claim-(worker|owner-).*\.json$/.test(f)); }
  catch { return []; }
}
function voidExit(rg, why) {
  log(`[${rg}] !! ${why} — VOID`);
  kill(rg);                                             // reap anything that already claimed
  const end = Date.now() + VOID_GRACE_MS;               // then out-wait the late spawn
  let late = false;
  while (Date.now() < end) {
    if (claimedRoles(rg).length) {
      late = true;
      log(`[${rg}] LATE SPAWN after void — reaping (this is the 9fa28d80 case)`);
      kill(rg);
    }
    sleepMs(3000);
  }
  if (claimedRoles(rg).length) kill(rg);                // one last sweep
  log(`[${rg}] void reap complete${late ? ' (a late spawn WAS caught)' : ' (no late spawn appeared)'}`);
  process.exit(3);
}

// ---- synthetic dispatch session: anchor claims/liveness to a long-lived keeper; assert COLD birth --
function setup(rg, keeperPid) {
  const cache = path.join(os.homedir(), '.claude', 'cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, `arc-state-${session(rg)}.json`),
    JSON.stringify({ pid: Number(keeperPid), cwd: repo(rg).replace(/\//g, '\\') }));
  const conv = N.sessionConv(session(rg));
  log(`[${rg}] dispatch state written (keeper ${keeperPid}); sessionConv=${JSON.stringify(conv)} ${conv ? '!! would FORK — abort' : '(cold birth OK)'}`);
  if (conv) process.exit(1);
}

function claimDispatch(rg) {
  const prev = process.cwd(); process.chdir(repo(rg));
  try {
    const r = N.requestRole(session(rg), 'dispatch', repo(rg));
    if (!r.ok) { log(`[${rg}] dispatch claim FAILED: ${r.message}`); process.exit(1); }
    log(`[${rg}] dispatch claimed`);
  } finally { process.chdir(prev); }
}

function birthWorker(rg, areas) {
  const prev = process.cwd(); process.chdir(repo(rg));
  try {
    const r = I.requestDelegate(session(rg), `worker ${packet(areas)}`, repo(rg));
    log(`[${rg}] birth worker: ok=${r.ok}\n${String(r.message).split('\n').map((l) => '    ' + l).join('\n')}`);
    if (!r.ok) process.exit(1);
  } finally { process.chdir(prev); }
}

// ---- regime (a): LIVE-IDLE-LISTENING owner (code #69: PRIMARY; the warm standing team) ----------
const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
const OWNER_WARM = (role) =>
  `You own the code area in your charter (run \`arc role ${role}\` to see it). ARM YOUR LISTENER so a teammate can reach you: run \`arc join ${role}\` in the BACKGROUND, then stay idle. Do NOT edit anything yet. When a note assigns you a specific bug in YOUR area, fix it there, verify it, and reply DONE. Until a note comes, just listen.`;

// Poll for a role's claim file + a live pid (code #67: never trust a delegate ok:true; CONFIRM the
// chair actually filled — a detached launch that timed out may have spawned anyway or not at all).
function waitClaim(rg, role, deadlineMs) {
  const f = path.join(peerDir(rg), `claim-${role}.json`);
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const c = readJson(f);
    if (c && c.pid) { try { if (execFileSync('tasklist', ['/FI', `PID eq ${c.pid}`, '/NH']).toString().includes(String(c.pid))) return true; } catch {} }
    sleepMs(2000);
  }
  return false;
}

function birthOwnerWarm(rg, role) {
  const prev = process.cwd(); process.chdir(repo(rg));
  try {
    const r = I.requestDelegate(session(rg), `${role} ${OWNER_WARM(role)}`, repo(rg));
    log(`[${rg}] warm owner ${role}: ok=${r.ok}${r.unverified ? ' (UNVERIFIED per #67 — confirming by claim)' : ''}`);
  } finally { process.chdir(prev); }
}

// Full warm-DELEG trial setup: pre-spawn LIVE owners for the areas, wait for their chairs to fill +
// arm, THEN (t_start) birth the worker. Owner boot is the standing-team cost and is NOT timed.
function warmStart(rg, areas, trial) {
  reset(rg); claimDispatch(rg);
  for (const a of areas) birthOwnerWarm(rg, AREAS[a].owner);
  for (const a of areas) {
    if (!waitClaim(rg, AREAS[a].owner, 90000)) voidExit(rg, `owner ${AREAS[a].owner} chair NEVER FILLED`);
  }
  sleepMs(25000);   // let owners arm `arc join` + go idle before the worker delegates
  const t_start = new Date().toISOString();
  birthWorker(rg, areas);
  if (!waitClaim(rg, 'worker', 60000)) voidExit(rg, 'worker chair NEVER FILLED');
  fs.writeFileSync(stateFile(rg), JSON.stringify({ regime: rg, mode: 'warm', N: areas.length, trial: Number(trial), areas, t_start, t_done: null }, null, 1));
  pushLoad(rg);   // load sample at t_start
  log(`[${rg}] WARM N=${areas.length} [${areas.join(',')}] trial ${trial} STARTED at ${t_start} (owners pre-live)`);
}

function start(rg, areasCsv, trial) {
  const areas = parseAreas(areasCsv);
  if (!areas.length || areas.some((a) => !AREAS[a])) { log(`bad areas "${areasCsv}" (use retry,money,parse)`); process.exit(1); }
  reset(rg);
  claimDispatch(rg);
  const t_start = new Date().toISOString();
  birthWorker(rg, areas);
  if (!waitClaim(rg, 'worker', 60000)) voidExit(rg, 'worker chair NEVER FILLED');   // code #67
  fs.writeFileSync(stateFile(rg), JSON.stringify({ regime: rg, mode: rg === 'self' ? 'self' : 'cold', N: areas.length, trial: Number(trial), areas, t_start, t_done: null }, null, 1));
  pushLoad(rg);   // load sample at t_start
  log(`[${rg}] ${rg === 'self' ? 'SELF' : 'COLD'} N=${areas.length} [${areas.join(',')}] trial ${trial} STARTED at ${t_start}`);
}

// ---- oracle poll: run each area's failing test; all-pass stamps t_done (verified, not self-report) -
function oracleStatus(rg, areas) {
  const res = {};
  for (const a of areas) {
    let code = 0;
    try { execFileSync('node', [path.join(repo(rg), AREAS[a].oracle)], { encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { code = e.status == null ? -1 : e.status; }
    res[a] = code === 0;
  }
  return res;
}
function poll(rg) {
  const st = readJson(stateFile(rg));
  if (!st) { log(`[${rg}] no run-state`); process.exit(1); }
  const res = oracleStatus(rg, st.areas);
  const allPass = st.areas.every((a) => res[a]);
  const elapsed = ((Date.now() - Date.parse(st.t_start)) / 1000).toFixed(1);
  if (allPass && !st.t_done) { st.t_done = new Date().toISOString(); fs.writeFileSync(stateFile(rg), JSON.stringify(st, null, 1)); }
  pushLoad(rg);   // load sample each poll — builds the per-trial load profile
  const done = st.t_done ? `DONE @ ${st.t_done} (wall ${((Date.parse(st.t_done) - Date.parse(st.t_start)) / 1000).toFixed(1)}s)` : `elapsed ${elapsed}s`;
  log(`[${rg}] N=${st.N} [${st.areas.join(',')}] oracles ${JSON.stringify(res)} ${allPass ? 'ALL PASS' : ''} — ${done}`);
}

// ---- transcript scoring (secondaries: induction, first-edit, per-owner concurrency windows) --------
function findTranscript(convId) {
  if (!convId) return null;
  const home = os.homedir();
  const bases = [path.join(home, '.claude', 'projects')];
  const prof = path.join(home, '.claude', 'arc-profiles');
  try { for (const p of fs.readdirSync(prof)) bases.push(path.join(prof, p, 'projects')); } catch {}
  for (const b of bases) {
    let dirs = []; try { dirs = fs.readdirSync(b); } catch { continue; }
    for (const d of dirs) { const fp = path.join(b, d, convId + '.jsonl'); if (fs.existsSync(fp)) return fp; }
  }
  return null;
}
// Active window + edit accounting from a transcript: first/last tool_use ts, first owned/other edit,
// whether the cold-birth prompt is the first user turn (integrity).
function windowOf(fp, ownGlob, since) {
  const out = { firstTool: null, lastTool: null, firstEdit: null, ownedEdits: 0, otherEdits: 0, toolCalls: 0, firstUserOk: false, entries: 0 };
  const sinceMs = since ? Date.parse(since) : 0;
  let text; try { text = fs.readFileSync(fp, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    out.entries++;
    const msg = j.message || {};
    if (!out.firstUserOk && j.type === 'user' && JSON.stringify(msg.content || '').includes('Take the worker role')) out.firstUserOk = true;
    for (const c of (Array.isArray(msg.content) ? msg.content : [])) {
      if (c && c.type === 'tool_use') {
        const ts = j.timestamp || null;
        if (sinceMs && ts && Date.parse(ts) < sinceMs) continue;   // warm owners: ignore pre-delegation warm-up
        out.toolCalls++;
        if (ts) { if (!out.firstTool) out.firstTool = ts; out.lastTool = ts; }
        const f = (c.input && (c.input.file_path || c.input.path)) || '';
        if (EDITS.has(c.name)) {
          if (ownGlob && ownGlob.test(f)) { out.ownedEdits++; if (!out.firstEdit) out.firstEdit = ts; }
          else { out.otherEdits++; if (!out.firstEdit) out.firstEdit = ts; }
        }
      }
    }
  }
  return out;
}
// Do a set of [firstTool,lastTool] windows overlap? Returns union span, summed busy, and a 0..N factor.
function concurrency(windows) {
  const iv = windows.filter((w) => w.firstTool && w.lastTool)
    .map((w) => [Date.parse(w.firstTool), Date.parse(w.lastTool)]).filter(([a, b]) => b >= a);
  if (iv.length < 2) return { owners: iv.length, factor: iv.length ? 1 : 0, spanS: null, busyS: null };
  const span = Math.max(...iv.map((x) => x[1])) - Math.min(...iv.map((x) => x[0]));
  const busy = iv.reduce((s, [a, b]) => s + (b - a), 0);
  // factor ~ busy/span: ~1 = fully serialized, ~owners = fully overlapped.
  return { owners: iv.length, factor: +(busy / Math.max(1, span)).toFixed(2), spanS: +(span / 1000).toFixed(1), busyS: +(busy / 1000).toFixed(1) };
}

function score(rg, trial) {
  const st = readJson(stateFile(rg)) || {};
  const pd = peerDir(rg);
  const wc = readJson(path.join(pd, 'claim-worker.json'));
  const wtr = wc && findTranscript(wc.convId);
  const w = wtr ? windowOf(wtr, /src[\\/]/i) : null;
  // Owners present on the board (pre-live in WARM, spawned in COLD). Their WORK is clipped to
  // post-t_start — warm owners have pre-delegation warm-up (arming their listener) that must not count.
  const ownersPresent = st.areas ? st.areas.map((a) => AREAS[a].owner)
    .filter((role) => fs.existsSync(path.join(pd, `claim-${role}.json`))) : [];
  const ownerWins = ownersPresent.map((role) => {
    const oc = readJson(path.join(pd, `claim-${role}.json`));
    const otr = oc && findTranscript(oc.convId);
    return { role, conv: oc ? oc.convId : null, ...(otr ? windowOf(otr, /src[\\/]/i, st.t_start) : {}), transcript: otr };
  });
  const ownerEdits = ownerWins.reduce((s, o) => s + (o.ownedEdits || 0), 0);
  // Robust delegation signal (works for WARM, where owner claims ALWAYS exist from pre-spawn): the
  // worker made ZERO owned edits AND some owner did. A hand-off, whether the chair was warm or cold.
  const delegated = (w ? w.ownedEdits === 0 : false) && ownerEdits > 0;
  const wall = (st.t_start && st.t_done) ? +((Date.parse(st.t_done) - Date.parse(st.t_start)) / 1000).toFixed(1) : null;
  const samples = st.load_samples || [];
  const stat = (k) => samples.length ? { min: Math.min(...samples.map((s) => s[k] ?? 0)), max: Math.max(...samples.map((s) => s[k] ?? 0)), mean: +(samples.reduce((a, s) => a + (s[k] ?? 0), 0) / samples.length).toFixed(1) } : null;
  const load = { samples: samples.length, claude: stat('claude'), node: stat('node'), cpu: stat('cpu') };  // code #76(b)
  const row = {
    trial: Number(trial), regime: rg, mode: st.mode || null, N: st.N, areas: st.areas, at: new Date().toISOString(),
    wall_clock_s: wall, t_start: st.t_start || null, t_done: st.t_done || null, load,
    delegated, owner_edits: ownerEdits, owners_present: ownersPresent,
    worker_conv: wc ? wc.convId : null,
    worker_owned_edits: w ? w.ownedEdits : null, worker_other_edits: w ? w.otherEdits : null,
    worker_tool_calls: w ? w.toolCalls : null, worker_first_edit: w ? w.firstEdit : null,
    worker_integrity_ok: w ? w.firstUserOk : null,
    owner_windows: ownerWins.map((o) => ({ role: o.role, conv: o.conv, firstTool: o.firstTool, lastTool: o.lastTool, ownedEdits: o.ownedEdits, toolCalls: o.toolCalls })),
    concurrency: concurrency(ownerWins),
  };
  fs.appendFileSync(path.join(HARN, 'results.jsonl'), JSON.stringify(row) + '\n');
  log(JSON.stringify(row, null, 1));
  if (w && !w.firstUserOk) log(`[${rg}] !! INTEGRITY: worker's first user turn is not the cold-birth prompt — inspect + likely VOID`);
}

// Close the peers this trial spawned. Uses arc-board.closePeer (code #83): kills the tree in the
// load-bearing order runner->claude->shell — my old taskkill hit the claim pid (the RUNNER) with /T,
// which left the parent SHELL alive and leaked 16 consoles. closePeer also releases the claim.
function kill(rg) {
  const pd = peerDir(rg);
  let roles = [];
  try { roles = fs.readdirSync(pd).filter((f) => /^claim-(worker|owner-).*\.json$/.test(f)).map((f) => f.replace(/^claim-|\.json$/g, '')); } catch {}
  let board = null;
  try { const R = require('E:/arc/src/arc-board'); const N = require('E:/arc/src/arc-notes'); board = R.resolveBoard(N.resolveCwd(session(rg), repo(rg))); } catch {}
  for (const role of roles) {
    if (board) {
      try { const R = require('E:/arc/src/arc-board'); const r = R.closePeer(board, role); log(`[${rg}] closed ${role}: ${r.killed.map((k) => k.what).join('+') || 'nothing alive'}`); continue; } catch {}
    }
    const c = readJson(path.join(pd, `claim-${role}.json`));   // fallback
    if (c && c.pid) { try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'pipe' }); log(`[${rg}] taskkill fallback ${role} pid ${c.pid}`); } catch {} }
  }
  if (!roles.length) log(`[${rg}] no worker/owner claims to close`);
}

if (require.main === module) main();

function main() {
const [, , cmd, rg, a, b] = process.argv;
if (cmd === 'setup') setup(rg, a);
else if (cmd === 'reset') reset(rg);
else if (cmd === 'start') start(rg, a, b);   // start <regime> <areasCsv> <trial>  (cold/self: worker spawns owners or self-fixes)
else if (cmd === 'warm') warmStart(rg, parseAreas(a), b);   // warm <deleg> <areasCsv> <trial>  (regime a: pre-live owners)
else if (cmd === 'poll') poll(rg);
else if (cmd === 'score') score(rg, a);      // score <regime> <trial>
else if (cmd === 'kill') kill(rg);
else { log('subcommands: setup|start|poll|score|kill|reset'); process.exit(1); }
}

module.exports = { reset, kill, voidExit, claimedRoles, VOID_GRACE_MS };
