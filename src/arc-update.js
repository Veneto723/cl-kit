// arc-update: version-awareness at launch + one-command upgrade from a GitHub Release.
//
// SHAPE. arc is a git repo you DEVELOP on more than one machine, so the updater must never touch
// your working tree — it pulls a PUBLISHED ARTIFACT (a release tarball), not your uncommitted work.
// At launch, arc-runner does a cached (once/day), fail-safe, bounded check against the repo's
// latest Release; if it is newer than the DEPLOYED version, it offers to upgrade. `arc update`
// forces that. `arc release` is the dev-side publish (bump + tag + gh release), gated on the human.
//
// FAIL-SAFE IS THE WHOLE CONTRACT. This runs on the launch path: nothing here may throw into it,
// block it, or hang it. Every network/FS/parse error resolves to "no update" and launches normally.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const REPO = 'Veneto723/arc';
const CHECK_TTL_MS = 24 * 3600 * 1000;                 // check the network at most once a day
const checkCachePath = () => path.join(os.homedir(), '.claude', 'arc-update-check.json');
const versionMarkerPath = () => path.join(__dirname, 'arc-version.json');   // written by install.ps1

// ---- version -----------------------------------------------------------------
// The DEPLOYED runner runs from ~/.claude/scripts, where package.json is NOT copied — so install.ps1
// stamps arc-version.json beside the scripts. Fall back to the repo's package.json (dev runs from
// src/), then to 0.0.0 so an un-stamped install always reads as "behind" and gets offered the fix.
function installedVersion() {
  // Strip a leading BOM: a marker written by a BOM-adding tool would otherwise fail JSON.parse and
  // read as 0.0.0 — a phantom "you're behind" that offers an endless upgrade to the SAME version.
  const noBom = (s) => String(s).replace(/^﻿/, '');
  try { const v = JSON.parse(noBom(fs.readFileSync(versionMarkerPath(), 'utf8'))).version; if (v) return String(v); } catch {}
  try { return String(require('../package.json').version); } catch {}
  return '0.0.0';
}

// Compare two dotted versions ("v2.1.3" / "2.1.3"). Returns 1 if a>b, -1 if a<b, 0 if equal.
// Numeric per-field; a missing/garbage field counts as 0, so "2.1" == "2.1.0" and junk never throws.
function cmpVer(a, b) {
  const parts = (s) => String(s || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pa = parts(a), pb = parts(b), n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

// ---- the latest release (network, bounded, fail-safe) ------------------------
// One GET to the public releases API — no auth, no `gh`, so it works on a machine that only RUNS
// arc. Returns { tag, tarball, publishedAt } or null on ANY failure (offline, timeout, 404 when no
// release exists yet, rate-limit, malformed body). Never throws.
async function latestRelease(timeoutMs = 2500) {
  const opts = {
    hostname: 'api.github.com',
    path: `/repos/${REPO}/releases/latest`,
    headers: { 'User-Agent': 'arc-updater', 'Accept': 'application/vnd.github+json' },
    timeout: timeoutMs,
  };
  const res = await getJson(opts, timeoutMs);
  if (!res || !res.tag_name) return null;
  return { tag: String(res.tag_name), tarball: res.tarball_url || null, publishedAt: res.published_at || null };
}

// A bounded GET that resolves to parsed JSON or null — never rejects, so the launch path can't be
// wedged by a hung socket, a non-200, an oversized body, or a malformed response.
function getJson(opts, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const req = https.get(opts, (r) => {
        if (r.statusCode !== 200) { r.resume(); return finish(null); }
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (c) => { body += c; if (body.length > 1_000_000) { r.destroy(); finish(null); } });
        r.on('end', () => { try { finish(JSON.parse(body)); } catch { finish(null); } });
      });
      req.on('error', () => finish(null));
      req.on('timeout', () => { try { req.destroy(); } catch {} finish(null); });
      req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} finish(null); });
    } catch { finish(null); }
  });
}

// ---- the launch-time check (cached, fail-safe) -------------------------------
// Returns { available, latest, installed, declined } — available=true only when a release is
// strictly newer than what's installed. Reads the network at most once per TTL; otherwise serves the
// cached tag with zero latency. `fetch` is injectable so tests never touch the network. NEVER throws.
async function checkForUpdate(opts = {}) {
  const cp = opts.cachePath || checkCachePath();
  const installed = opts.installed || installedVersion();
  const fetch = opts.fetch || (() => latestRelease(opts.timeoutMs));
  const now = opts.now || Date.now();
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cp, 'utf8')) || {}; } catch {}
  const fresh = !opts.force && cache.checkedAt && now - cache.checkedAt < CHECK_TTL_MS;
  let latest = cache.latest || null;
  let tarball = cache.tarball || null;   // returned so callers don't re-fetch (audit #199 Q1)
  if (!fresh) {
    let got = null;
    try { got = await fetch(); } catch {}
    if (got && got.tag) {
      latest = got.tag; tarball = got.tarball || null;
      writeCache(cp, { ...cache, checkedAt: now, latest, tarball });
    } else {
      // A failed check must not retry on every single launch — stamp the attempt, keep the old tag.
      writeCache(cp, { ...cache, checkedAt: now });
    }
  }
  const available = !!latest && cmpVer(latest, installed) > 0;
  return { available, latest, installed, tarball, declined: cache.declined === latest };
}

function writeCache(cp, obj) {
  try { fs.mkdirSync(path.dirname(cp), { recursive: true }); fs.writeFileSync(cp, JSON.stringify(obj)); } catch {}
}
// Remember the human said "not now" to THIS version, so the launch prompt doesn't nag every time —
// it stays quiet until a newer tag appears (a different `declined` value → prompts again).
function recordDecline(version, cachePath) {
  const cp = cachePath || checkCachePath();
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(cp, 'utf8')) || {}; } catch {}
  writeCache(cp, { ...cache, declined: version });
}

// ---- the upgrade: download a release tarball, run its installer ---------------
// Pulls a PUBLISHED artifact (never your working tree) and runs its own install.ps1, which is
// idempotent. curl + tar ship with Windows 11, so no extra dependency and no `gh` needed. Every
// step is checked; a failure at any point leaves the current install untouched and returns { ok:false }.
function downloadAndInstall(tag, tarball, opts = {}) {
  const log = opts.log || ((s) => process.stdout.write(s + '\n'));
  if (!tarball) return { ok: false, message: 'no tarball url for the release' };
  // PIN the Windows built-ins. Bare `tar`/`curl` can resolve to Git Bash's MSYS tar, which reads a
  // Windows path's drive letter as a remote host ("Cannot connect to C:") and dies. System32's
  // bsdtar/curl handle native paths. Fall back to bare names only if System32 is somehow absent.
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const CURL = fs.existsSync(path.join(sys, 'curl.exe')) ? path.join(sys, 'curl.exe') : 'curl';
  const TAR = fs.existsSync(path.join(sys, 'tar.exe')) ? path.join(sys, 'tar.exe') : 'tar';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-update-'));
  const tgz = path.join(work, 'arc.tgz');
  const ex = path.join(work, 'x');
  try {
    log(`[arc] downloading ${tag}…`);
    // `-#` is curl's PROGRESS BAR; the old `-sSL` had `-s` (silent), which suppressed it entirely,
    // so a slow download looked frozen. The bar goes to stderr, so stderr must be INHERITED (a
    // captured pipe shows nothing until the process ends) — which also means a curl error prints
    // straight to the user, so we key the failure off the exit status rather than a captured string.
    const showBar = !opts.quiet && process.stderr.isTTY;
    const dl = showBar
      ? spawnSync(CURL, ['-#', '-fL', '--max-time', '120', '-o', tgz, tarball], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 130_000 })
      : spawnSync(CURL, ['-sSL', '--fail', '--max-time', '120', '-o', tgz, tarball], { encoding: 'utf8', timeout: 130_000 });
    if (dl.status !== 0 || !fs.existsSync(tgz) || fs.statSync(tgz).size < 1000) {
      return { ok: false, message: `download failed${dl.stderr ? ': ' + String(dl.stderr).trim() : ''}` };
    }
    fs.mkdirSync(ex, { recursive: true });
    const un = spawnSync(TAR, ['-xzf', tgz, '-C', ex], { encoding: 'utf8', timeout: 60_000 });
    if (un.status !== 0) return { ok: false, message: `extract failed${un.stderr ? ': ' + un.stderr.trim() : ''}` };
    // GitHub tarballs unpack into a single top dir (owner-repo-<sha>/). Find the one with install.ps1.
    const roots = fs.readdirSync(ex).map((d) => path.join(ex, d)).filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
    const root = roots.find((d) => fs.existsSync(path.join(d, 'install.ps1')) && fs.existsSync(path.join(d, 'package.json')));
    if (!root) return { ok: false, message: 'release tarball has no install.ps1/package.json at its root' };
    log('[arc] installing…');
    const before = installedVersion();
    const inst = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'install.ps1')], { stdio: opts.quiet ? 'ignore' : 'inherit', timeout: 300_000 });
    if (inst.status !== 0) {
      // The most common cause on Windows is a locked file: install.ps1 cannot overwrite a script the
      // RUNNING session still holds. Say so, and point at the retry that works — a standalone shell.
      return { ok: false, locked: true,
        message: 'install.ps1 exited non-zero — your previous install is intact.\n'
          + '        This usually means a running arc session was holding the files. Close other arc\n'
          + '        sessions and run `arc update` again in a plain terminal.' };
    }
    // VERIFY THE STAMP ADVANCED. install.ps1 writes arc-version.json; if it returned 0 but the marker
    // did not move (a partial run, a stamp that silently no-op'd), treat it as a failure rather than
    // report a success that the next launch will contradict by re-offering the same version.
    const after = installedVersion();
    if (cmpVer(after, before) <= 0 && cmpVer(after, tag) < 0) {
      return { ok: false, message: `install ran but the version marker is still ${after} — the upgrade did not take. Run \`arc update\` in a standalone terminal.` };
    }
    return { ok: true, message: `upgraded to ${tag}`, version: tag };
  } catch (e) {
    return { ok: false, message: String(e && e.message) };
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

// ---- clearing file locks before an in-place upgrade --------------------------------
// The upgrade replaces ~/.claude/scripts, and Windows will not let install.ps1 overwrite a file a
// RUNNING process holds — the confirmed cause of "I upgraded and it asks again": install.ps1 exits
// non-zero, the old install stays, the marker never advances. The reliable fix is to release the
// locks, which means closing the other arc processes. This ENUMERATES them (pure, testable); the
// caller shows the list and asks before anything is killed.
//   sessions  peer node+claude that hold a role/board — the COSTLY ones (a turn's work is lost,
//             though the transcript survives so the session is revivable)
//   feed      the detached status feed — cheap, restarts on next launch
// THE SKEW window for the start-before-marker oracle (a marker is written moments AFTER launch).
const SELF_KILL_SKEW_MS = 5000;

// PROVE GENUINE IDENTITY before ever targeting a pid for a force-kill. A bare `process.kill(pid,0)`
// only says the NUMBER is in use — and Windows recycles pids, so a stale arc-state/feed file can name
// a pid the OS has since handed to an editor or the updater itself. Force-killing that tree
// (`taskkill /F /T`) is unrecoverable, so identity must be the same procStart oracle the board uses:
// a genuine arc process started BEFORE it wrote its marker; a recycled squatter started after.
// FAILS CLOSED — if the OS start cannot be read, the pid is NOT proven arc and is left alone (the
// install may then fail on a real lock, which is recoverable; killing a stranger is not).
// THIS session is excluded by ARC_SESSION and, defensively, by process.pid — the upgrader can never
// target itself even through an alias state file that happens to carry its number.
function liveOthers(selfSession) {
  const cache = path.join(os.homedir(), '.claude', 'cache');
  const out = { sessions: [], feeds: [], scope: [] };
  let files = []; try { files = fs.readdirSync(cache); } catch { return out; }

  const cands = [];   // { kind, session?, pid, cwd?, marker }
  for (const f of files) {
    const ms = f.match(/^arc-state-(.+)\.json$/);
    if (ms) {
      if (selfSession && ms[1] === selfSession) continue;          // never myself (by session id)
      const fp = path.join(cache, f);
      let st, mt; try { st = JSON.parse(fs.readFileSync(fp, 'utf8')); mt = fs.statSync(fp).mtimeMs; } catch { continue; }
      if (st.pid) cands.push({ kind: 'session', session: ms[1], pid: st.pid, cwd: st.cwd || null, marker: mt });
      continue;
    }
    const mf = f.match(/^arc-feed-(\d+)\.json$/);
    if (mf) {
      const fp = path.join(cache, f);
      let pf, mt; try { pf = JSON.parse(fs.readFileSync(fp, 'utf8')); mt = fs.statSync(fp).mtimeMs; } catch { continue; }
      if (pf.pid) cands.push({ kind: 'feed', port: mf[1], pid: pf.pid, marker: pf.started || mt });
    }
  }

  let starts = null;
  try { starts = require('./arc-board').procStarts(cands.map((c) => c.pid), { fresh: true }); } catch { starts = null; }
  const genuine = (c) => {
    if (c.pid === process.pid) return false;                       // never myself (by pid, even via an alias file)
    if (!starts) return false;                                     // cannot prove identity → fail CLOSED
    const s = starts[c.pid];
    if (s == null) return false;                                   // dead, or a live pid with an unreadable start
    return s <= c.marker + SELF_KILL_SKEW_MS;                      // started before it wrote its marker → genuinely arc
  };
  for (const c of cands) {
    if (!genuine(c)) continue;
    if (c.kind === 'session') out.sessions.push({ session: c.session, pid: c.pid, cwd: c.cwd });
    else out.feeds.push({ port: c.port, pid: c.pid });             // ARC_FEED_PORT is configurable — there can be MORE THAN ONE feed
  }
  out.scope = liveScope();
  return out;
}

// arc builds its scope viewer to `<repo>/scope/arc-scope.exe` (scope/build.ps1) — it is never
// deployed to a fixed install path, so the only identity arc can trust is that build LAYOUT: the
// executable sits in a `scope/` directory. A foreign `C:\tmp\arc-scope.exe` does NOT, so it is not
// ours and must never be force-killed (audit #289 blocker 5). A process whose path we cannot read is
// unverifiable → excluded (fail closed).
function isArcScopePath(p) {
  if (!p) return false;
  return /(?:^|[\\/])scope[\\/]arc-scope\.exe$/i.test(String(p).replace(/\\/g, '/'));
}

// Enumerate the running arc-scope viewers, but ONLY those whose executable path matches arc's own
// build layout — so the caller can COUNT them (a scope-only lock still prompts) and kill them BY PID
// (never the over-broad `/IM arc-scope.exe`). Best-effort: returns [] if the process query can't run.
function liveScope() {
  try {
    const r = require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-Command',
      "Get-Process -Name arc-scope -ErrorAction SilentlyContinue | %{ \"$($_.Id)|$($_.Path)\" }"],
      { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (!r || r.status !== 0) return [];
    return String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.indexOf('|');
      return { pid: Number(i >= 0 ? l.slice(0, i) : l), path: i >= 0 ? l.slice(i + 1) : null };
    }).filter((s) => s.pid && isArcScopePath(s.path));            // trusted path only
  } catch { return []; }
}

// Force-close what liveOthers PROVED genuine. /T takes the whole tree, so a session's claude child —
// the more likely lock holder — dies with its node parent. Targets are DEDUPED by pid first: a pid
// that appears in two classes (or twice) would otherwise be killed once (ok) then race a dead pid and
// be counted as a FAILURE, making the runner falsely warn a process would not close (audit #289
// findings 8/9). taskkill's EXIT STATUS is honoured per unique target: a pid that could not be closed
// (access denied, race) is reported as a failure, never a silent success. Returns { killed, failed }.
function killOthers(others) {
  const cp = require('child_process');
  const tk = (pid) => { try { const r = cp.spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', timeout: 15000 }); return !!r && r.status === 0; } catch { return false; } };
  const targets = [...new Set([
    ...(others.sessions || []).map((s) => s.pid),
    ...(others.feeds || []).map((f) => f.pid),
    ...(others.scope || []).map((s) => s.pid),
  ].filter(Boolean))];
  let killed = 0, failed = 0;
  for (const pid of targets) { if (tk(pid)) killed++; else failed++; }
  return { killed, failed };
}

// ---- the dev-side publish (gated on the human) --------------------------------
// Bumps package.json, commits, tags vX.Y.Z, pushes, and cuts a GitHub Release. Refuses on a dirty
// tree, the wrong remote, or being behind origin — a release must be a clean, pushed point. `bump`
// is 'patch'|'minor'|'major' or an explicit 'X.Y.Z'. Returns { ok, version, message }. Outward-facing:
// only ever runs when a human explicitly invokes `arc release`.
function doRelease(bump, opts = {}) {
  const repo = opts.cwd || process.cwd();
  const git = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const pkgPath = path.join(repo, 'package.json');
  if (!fs.existsSync(path.join(repo, '.git')) || !fs.existsSync(pkgPath)) return { ok: false, message: `not an arc repo (need .git + package.json in ${repo})` };
  const remote = (git(['remote', 'get-url', 'origin']).stdout || '').trim();
  // Strict: origin must be Veneto723/arc (https OR ssh both contain "Veneto723/arc"). The release
  // itself is pushed to REPO explicitly via `gh --repo`, so releasing from a fork's clone would send
  // it somewhere the working tree isn't — refuse rather than surprise. ANCHOR to end (audit #199):
  // a trailing \b let "Veneto723/arc-fork" and "…/arc-experiments" pass (\b sits between 'c' and '-'),
  // so a same-owner differently-named clone would publish the WRONG tree to the real repo. `$` shuts it.
  if (!/Veneto723[/:]arc(\.git)?$/.test(remote)) {
    return { ok: false, message: `origin is "${remote}", expected ${REPO} — refusing to release the wrong repo` };
  }
  if ((git(['status', '--porcelain']).stdout || '').trim()) return { ok: false, message: 'working tree is dirty — commit or stash before releasing' };
  git(['fetch', '--quiet', 'origin']);
  const behind = (git(['rev-list', '--count', 'HEAD..@{upstream}']).stdout || '0').trim();
  if (behind !== '0' && behind !== '') return { ok: false, message: `local is ${behind} commit(s) behind origin — pull first` };

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const cur = String(pkg.version || '0.0.0');
  let next;
  if (/^\d+\.\d+\.\d+/.test(bump || '')) next = String(bump).replace(/^v/i, '');
  else {
    const [maj, min, pat] = cur.split('.').map((n) => parseInt(n, 10) || 0);
    next = bump === 'major' ? `${maj + 1}.0.0` : bump === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
  }
  const tag = `v${next}`;
  if ((git(['tag', '-l', tag]).stdout || '').trim()) return { ok: false, message: `tag ${tag} already exists` };
  if (opts.dryRun) return { ok: true, dryRun: true, version: tag, message: `would release ${cur} → ${tag}` };

  pkg.version = next;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  if (git(['commit', '-am', `release ${tag}`]).status !== 0) return { ok: false, message: 'commit failed' };
  if (git(['tag', tag]).status !== 0) return { ok: false, message: 'tag failed' };
  if (git(['push']).status !== 0) return { ok: false, message: 'push failed (commit + tag are local; `git push` when ready)' };
  if (git(['push', 'origin', tag]).status !== 0) return { ok: false, message: 'tag push failed' };
  const rel = spawnSync('gh', ['release', 'create', tag, '--repo', REPO, '--title', `arc ${tag}`, '--generate-notes'], { encoding: 'utf8' });
  if (rel.status !== 0) return { ok: false, message: `pushed ${tag}, but gh release failed: ${(rel.stderr || '').trim()}` };
  return { ok: true, version: tag, message: `released ${tag}` };
}

module.exports = { installedVersion, cmpVer, latestRelease, checkForUpdate, recordDecline, downloadAndInstall, doRelease, REPO, checkCachePath, versionMarkerPath, liveOthers, liveScope, killOthers, isArcScopePath };
