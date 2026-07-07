#!/usr/bin/env node
// cl-runner: launches Claude Code with NATIVE stdio (perfect rendering — no
// PTY/ConPTY, so claude's own slash menus work) and switches between the
// accounts defined in ~/.claude/cl-config.json (oauth subscriptions and/or
// API gateways — any number, any mix).
//
// Switching is MANUAL mid-session, driven by trigger files (not keystroke
// interception):
//   - `cl:switch [account]` / `cl:restart` are plain-text sentinels caught by the
//     UserPromptSubmit hook (cl-switch-hook.js -> cl-switch-core.js), which drops a
//     per-session trigger file BEFORE any model turn (zero tokens, classifier-immune).
//     This runner polls for its own session's trigger. (The old /switch and
//     /restart slash commands were removed — they cost a model turn and
//     deadlocked when rate-limited.)
//   - There is NO MID-SESSION auto-switch (removed — it was disruptive).
//   - At LAUNCH/RESUME only, cl auto-selects the best account: prefer a
//     subscription while it has headroom, fall to the most-available pool only
//     when the subscription is exhausted. Disable with features.autoBest=false;
//     override per-launch with `cl --account <id>`.
//
// Subcommands:  cl setup           — interactive config wizard
//               cl add-account <id> — drive native login + auto-capture a NEW account
//               cl capture <id>     — save the current claude.ai login for an account
//               cl doctor           — print resolved config + health checks
// Usage: node cl-runner.js [claude args...]   (normally via cl.cmd)
'use strict';

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const C = require('./cl-config');
const core = require('./cl-switch-core'); // shared launch-account decision + peek
const { pickConvId } = require('./cl-conv'); // pure convId reconciliation (testable)

const CACHE_DIR = C.CACHE_DIR;
const TRIGGER_POLL_MS = 1_000;    // how often to check for a slash-command trigger

let cfg = (() => {
  try { return C.loadConfig(); }
  catch (e) {
    process.stderr.write(`[cl] ${e.message}\n[cl] run \`cl setup\` to create ~/.claude/cl-config.json\n`);
    process.exit(1);
  }
})();
const CLAUDE_BIN = C.claudeBin(cfg);

// Re-read cl-config.json (accounts can be added/edited mid-session via the cl
// MCP server or by hand). Keeps the last good config if the file is broken.
function reloadCfg() {
  try { cfg = C.loadConfig(); } catch {}
  return cfg;
}

// A stable per-session id. Reuse an inherited CL_SESSION ONLY for our own /restart
// re-exec (which sets CL_RESPAWNED=1); otherwise mint a fresh one. This stops a
// nested `cl` (launched from a shell inside a running cl-managed claude, which
// inherits CL_SESSION) from colliding on the same state/active/trigger files.
const SESSION_ID = (process.env.CL_RESPAWNED === '1' && process.env.CL_SESSION)
  ? process.env.CL_SESSION
  : `${process.pid}-${Math.floor(Math.random() * 1e6)}`;

// Per-session state file. With multiple cl terminals open, a single global state
// file would let them stomp each other's account — so key it by SESSION_ID.
const STATE_PATH = path.join(CACHE_DIR, `cl-state-${SESSION_ID}.json`);

// ---- state ----------------------------------------------------------------

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    const acc = C.findAccount(cfg, s.account); // tolerates legacy ids
    return {
      account: acc ? acc.id : cfg.defaultAccount,
      switchCount: s.switchCount || 0,
      convId: s.convId || null,
      pinnedEffort: s.pinnedEffort || null,
    };
  }
  catch { return { account: cfg.defaultAccount, switchCount: 0, convId: null, pinnedEffort: null }; }
}

function writeState(s) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    // Stamp the live pid + cwd for out-of-band tooling (pid liveness checks).
    const full = { ...s, pid: process.pid, cwd: process.cwd() };
    const tmp = `${STATE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(full));
    fs.renameSync(tmp, STATE_PATH);
  } catch {}
}

function deleteState() {
  try { fs.unlinkSync(STATE_PATH); } catch {}
}

// ---- crash / exit logging --------------------------------------------------
// cl used to throw away claude's exit code, so a silent crash left NO trace and
// was undebuggable. Every launch + exit now appends one line here.
const LOG_PATH = path.join(CACHE_DIR, 'cl-runner.log');
function logLine(msg) {
  try {
    try { if (fs.statSync(LOG_PATH).size > 256_000) fs.truncateSync(LOG_PATH, 0); } catch {}
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {}
}

// ---- duplicate-live-session guard ------------------------------------------
// Is `pid` an alive process? (Windows + POSIX.) signal 0 = existence probe.
function pidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // exists but not ours to signal
}

// cl-focus support: snapshot the PID that owns the FOREGROUND window at launch —
// the user's terminal — so a clicked toast can raise exactly that window. This is
// authoritative even under a ConPTY host (Windows Terminal), where the terminal
// process is NOT in the claude process tree and an ancestry climb can't find it.
// Captured once, while our terminal is still foreground (before claude takes the
// TTY), then written per-child so cl-focus.vbs can read cl-win-<claude pid>.json.
let launchWinPid = null;
function captureLaunchWinPid() {
  if (launchWinPid !== null) return launchWinPid;
  launchWinPid = 0;
  if (process.platform !== 'win32') return 0;
  try {
    const ps = "Add-Type 'using System;using System.Runtime.InteropServices;" +
      "public class F{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();" +
      "[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}';" +
      "$p=0;[F]::GetWindowThreadProcessId([F]::GetForegroundWindow(),[ref]$p)|Out-Null;$p";
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const n = parseInt((r.stdout || '').trim(), 10);
    if (n > 0) launchWinPid = n;
  } catch {}
  return launchWinPid;
}
function winPidPath(childPid) { return path.join(CACHE_DIR, `cl-win-${childPid}.json`); }
function writeWinPid(childPid) {
  if (!launchWinPid || !childPid) return;
  try { fs.writeFileSync(winPidPath(childPid), String(launchWinPid)); } catch {}
}

// Per-conversation lock file. Keyed by the ACTUAL conversation id (not the state
// file, whose convId is null until the statusline bridges a picker-resume), so
// the guard is unambiguous. Holds the owning pid + cwd + session id.
function convLockPath(convId) { return path.join(CACHE_DIR, `cl-convlock-${convId}.json`); }

// If conversation `convId` is already held by a LIVE cl process, return its
// { pid, cwd }; otherwise reclaim any stale lock and return null. Two cl
// processes on one conversation both write its transcript .jsonl and can crash
// together — the confirmed cause of the "both sessions died at once" bug.
function liveOwnerOf(convId) {
  if (!convId) return null;
  const lp = convLockPath(convId);
  let lock; try { lock = JSON.parse(fs.readFileSync(lp, 'utf8')); } catch { return null; }
  if (lock.session === SESSION_ID) return null;      // our own lock (respawn) — fine
  if (lock.pid && pidAlive(lock.pid)) return { pid: lock.pid, cwd: lock.cwd || '?' };
  try { fs.unlinkSync(lp); } catch {}                // stale (owner dead) — reclaim
  return null;
}

// Claim the conversation for THIS process. Call after the guard passes.
function claimConv(convId) {
  if (!convId) return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(convLockPath(convId), JSON.stringify({ pid: process.pid, cwd: process.cwd(), session: SESSION_ID, at: Date.now() }));
  } catch {}
}
function releaseConv(convId) {
  if (!convId) return;
  try {
    const lock = JSON.parse(fs.readFileSync(convLockPath(convId), 'utf8'));
    if (lock.session === SESSION_ID) fs.unlinkSync(convLockPath(convId)); // only release our own
  } catch {}
}

// Sweep per-session state files older than a day, so ones orphaned by a hard
// kill (terminal closed with the X, machine reboot) don't accumulate forever.
// Effort memories get 7 days: they're what lets `cl --resume` restore a
// conversation's effort (incl. ultracode) days later.
function sweepStaleStates() {
  const DAY = 24 * 60 * 60 * 1000;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!/^cl-(state|prefs|active|effort|turn|convlock|rmpending|delpending|win)-.*\.json$/.test(f)) continue;
      const p = path.join(CACHE_DIR, f);
      // convlock files are cleaned by LIVENESS, not age: a still-running session
      // days old must keep its lock. Remove only if its owner pid is dead.
      if (f.startsWith('cl-convlock-')) {
        try { const l = JSON.parse(fs.readFileSync(p, 'utf8')); if (!pidAlive(l.pid)) fs.unlinkSync(p); } catch { try { fs.unlinkSync(p); } catch {} }
        continue;
      }
      // cl-win-<pid> maps a claude pid -> its terminal window (for toast focus).
      // Also liveness-cleaned: keep it while that claude pid is alive, drop it once
      // the pid is gone (a crash-exit that skipped finish()'s own unlink).
      if (f.startsWith('cl-win-')) {
        const m = f.match(/^cl-win-(\d+)\.json$/);
        if (m && !pidAlive(parseInt(m[1], 10))) { try { fs.unlinkSync(p); } catch {} }
        continue;
      }
      const limit = f.startsWith('cl-effort-') ? 7 * DAY : DAY;
      try { if (Date.now() - fs.statSync(p).mtimeMs > limit) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}

// ---- accounts ---------------------------------------------------------------

function accountLabel(id) {
  const a = C.findAccount(cfg, id);
  return a ? a.label : id;
}

// --- credentials: per-account CLAUDE_CONFIG_DIR profile (see cl-profile.js) ----
// The old model swapped one global ~/.claude/.credentials.json between accounts,
// which let concurrent sessions on different accounts hijack/corrupt each other's
// login. That system is gone: each account now has its OWN config dir (its own
// private .credentials.json + .claude.json), pointed at via CLAUDE_CONFIG_DIR.
// Nothing is shared or swapped, so there is nothing to race on.
const P = require('./cl-profile');

// One-time migration: give existing accounts a login in their new profile so
// nobody has to re-authenticate. Runs once (guarded by a marker), safe & idempotent
// (seedCreds only ever fills an EMPTY profile). For each oauth account: prefer its
// old captured `credentials` file; otherwise adopt the live ~/.claude/.credentials.json
// for the account that owns it (matched by email via `claude auth status`, else the
// default/only oauth account). Never overwrites a profile that already has a login.
function migrateProfilesOnce() {
  const marker = path.join(P.PROFILES_DIR, '.migrated');
  try { if (fs.existsSync(marker)) return; } catch {}
  try {
    const oauth = cfg.accounts.filter((a) => a.type === 'oauth');
    // 1. captured-file logins → their profile.
    for (const a of oauth) if (a.credentials) P.seedCreds(a.id, a.credentials);
    // 2. the live shared login → the account that owns it (or the default oauth).
    let liveOwner = null;
    const st = authStatus(); // identity currently in ~/.claude/.credentials.json
    if (st && st.email) liveOwner = oauth.find((a) => a.email && a.email.toLowerCase() === st.email.toLowerCase());
    if (!liveOwner) liveOwner = oauth.find((a) => a.id === cfg.defaultAccount) || (oauth.length === 1 ? oauth[0] : null);
    if (liveOwner) P.seedCreds(liveOwner.id, C.CRED_PATH);
    fs.mkdirSync(P.PROFILES_DIR, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
  } catch {}
}

// Env for the claude child under `accountId`; throws if an api key is missing.
function buildEnv(accountId) {
  const acc = C.findAccount(cfg, accountId);
  const env = C.accountEnv(acc, process.env);
  env.CL_SESSION = SESSION_ID;
  // Point Claude Code at THIS account's isolated config dir (its own credentials +
  // .claude.json), while the "brain" (projects/commands/skills/…) is junctioned
  // back to the real ~/.claude so conversations stay shared across accounts. This
  // is what makes concurrent sessions on different accounts safe.
  env.CLAUDE_CONFIG_DIR = P.ensureProfile(accountId);
  // Never leak the respawn marker into claude (and its subshells); otherwise a
  // nested `cl` would think it's a /restart and reuse this SESSION_ID.
  delete env.CL_RESPAWNED;
  return env;
}

// ---- preserve mode/model/effort across a switch ---------------------------
// On respawn we re-apply the session's current choices so a cl:switch or cl:restart
// doesn't reset them. model + permissionMode come from the transcript tail;
// effort from the sticky per-conversation file the statusline maintains.

const EFFORT_OK = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'auto']);
// The only values the --effort FLAG accepts. ultracode/auto are /effort-menu-only:
// the flag (and the effortLevel settings key) reject them — the CLI prints a
// warning and silently falls back to the default. ultracode has its own
// documented settings key instead ({"ultracode": true}); auto has no
// non-interactive mechanism at all.
const CLI_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const PMODE_OK  = new Set(['default', 'auto', 'plan', 'acceptEdits', 'bypassPermissions']);

// The effort a plain launch lands on (user settings.json) — used to decide
// whether a resumed conversation's remembered effort still needs re-applying.
function defaultEffort() {
  try {
    const e = JSON.parse(fs.readFileSync(path.join(C.CLAUDE_DIR, 'settings.json'), 'utf8')).effortLevel;
    return EFFORT_OK.has(e) ? e : 'high';
  } catch { return 'high'; }
}

const effortStateFile = (convId) => path.join(CACHE_DIR, `cl-effort-${convId}.json`);

// The session's current effort — read from the sticky cl-effort-<convId>.json the
// statusline maintains (it scans the transcript incrementally for the genuine
// /effort echo, so ultracode is captured and never lost to truncation). Returns
// null if unknown (statusline hasn't run yet) → claude uses the settings default.
function detectedEffort(convId) {
  try {
    const e = JSON.parse(fs.readFileSync(effortStateFile(convId), 'utf8')).effort;
    return e && EFFORT_OK.has(e) ? e : null;
  } catch { return null; }
}

// Seed the sticky effort file at each launch: record the effort we're applying and
// reset the scan offset to the current transcript end, so (a) a launch with no
// /effort echo still shows the right effort, and (b) the statusline only scans NEW
// bytes (won't re-read stale pre-launch effort lines).
function seedEffort(convId, effort) {
  if (!convId) return;
  let offset = 0;
  const fp = findTranscript(convId);
  if (fp) { try { offset = fs.statSync(fp).size; } catch {} }
  try { fs.writeFileSync(effortStateFile(convId), JSON.stringify({ effort: effort || null, offset })); } catch {}
}

// The real session id claude is using, as bridged by the statusline (handles a
// picker-resumed session whose id cl didn't assign). Keyed by our SESSION_ID.
function readActiveConv() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `cl-active-${SESSION_ID}.json`), 'utf8')).convId || null;
  } catch { return null; }
}

function findTranscript(convId) {
  const projects = path.join(C.CLAUDE_DIR, 'projects');
  try {
    for (const d of fs.readdirSync(projects)) {
      if (d === '.trash') continue;
      const fp = path.join(projects, d, convId + '.jsonl');
      if (fs.existsSync(fp)) return fp;
    }
  } catch {}
  return null;
}

// Strip conversation-control flags (and their values) so the managed path can
// re-add exactly one --resume/--session-id. Prevents a duplicate when a
// `cl --resume` session gets adopted into managed mode after the first launch.
function stripConvArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (x === '--continue' || x === '-c') continue;
    if (x === '--resume' || x === '-r' || x === '--session-id') {
      if (args[i + 1] && !args[i + 1].startsWith('-')) i++; // also drop its value
      continue;
    }
    out.push(x);
  }
  return out;
}

// A conversation id the user passed explicitly (`cl --resume <uuid>` /
// `--session-id <uuid>`). Lets us restore that conversation's effort at launch;
// a bare picker `cl --resume` has no id until the statusline bridges it.
function explicitConvId(args) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    let v = null;
    if (x === '--resume' || x === '-r' || x === '--session-id') v = args[i + 1];
    else if (x.startsWith('--resume=') || x.startsWith('--session-id=')) v = x.split('=')[1];
    if (v && UUID.test(v)) return v;
  }
  return null;
}

// Map a full model id to a cross-account alias (opus/sonnet/haiku/fable) so the
// flag works on every account (gateways map aliases via modelMap env vars).
function modelAlias(id) {
  const s = String(id || '').toLowerCase();
  for (const a of ['opus', 'sonnet', 'haiku', 'fable']) if (s.includes(a)) return a;
  return null;
}

function preservedFlags(convId) {
  let model = null, pmode = null, markerMode = null;
  const fp = findTranscript(convId);
  if (fp) {
    try {
      const size = fs.statSync(fp).size;
      const start = Math.max(0, size - 500_000); // tail is enough for the latest state
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        // The dedicated `type:"permission-mode"` marker is the AUTHORITATIVE mode
        // (written on each shift+tab toggle). Ordinary user/assistant entries also
        // carry a `permissionMode` that can be a stale value (e.g. a trailing
        // "default") — those would clobber the real "auto", so prefer the marker.
        if (e.type === 'permission-mode' && e.permissionMode) markerMode = e.permissionMode;
        if (e.permissionMode) pmode = e.permissionMode; // fallback if no marker present
        const m = (e.message && e.message.model) || e.model;
        if (m) model = m;
      }
    } catch {}
  }
  const mode = markerMode || pmode;
  const flags = [];
  const alias = modelAlias(model);
  if (alias) flags.push('--model', alias);
  if (mode && PMODE_OK.has(mode)) flags.push('--permission-mode', mode);
  return flags; // effort handled separately (pin > detected; ultracode needs a settings key)
}

// ---- trigger files --------------------------------------------------------

const switchTrigger    = path.join(CACHE_DIR, `cl-switch-${SESSION_ID}.trigger`);
const restartTrigger   = path.join(CACHE_DIR, `cl-restart-${SESSION_ID}.trigger`);
// Dropped by the cl:switch hook to open the interactive arrow-key
// account picker. cl-runner kills claude, renders the picker on the freed TTY,
// and relaunches on the chosen account — zero model tokens.
const pickTrigger      = path.join(CACHE_DIR, `cl-pick-${SESSION_ID}.trigger`);
// Dropped by the cl:add-account hook: carries { args } (the id + flags). cl-runner
// kills claude, runs the guided browser login on the freed TTY, and relaunches.
const addAcctTrigger   = path.join(CACHE_DIR, `cl-addacct-${SESSION_ID}.trigger`);
// Dropped by the cl:delete hook (after confirm): carries { convId }. cl-runner
// kills claude, moves the transcript to recoverable trash, and starts fresh.
const deleteTrigger    = path.join(CACHE_DIR, `cl-delete-${SESSION_ID}.trigger`);

function clearTriggers() {
  for (const t of [switchTrigger, restartTrigger, pickTrigger, addAcctTrigger, deleteTrigger]) {
    try { fs.unlinkSync(t); } catch {}
  }
}

// Return the terminal to a clean primary-screen state after a hard-killed claude
// (which may leave the alt screen + raw mode set). Used before the picker and the
// in-session add-account login.
function resetTerminal() {
  try { process.stdout.write('\x1b[?1049l\x1b[?25h\x1b[0m'); } catch {}
}

// A short usage summary for an account, read from the statusline's cache
// (usage-monitor-cache.json) — so the picker shows the same info as cl:peek
// without any network call. oauth → subscription 5h/7d %; api → the gateway's
// own usage line (e.g. "$103.60 today · 62.9M tok"); legacy poolDb → active/5h.
// '' when there's no data to show. Never throws.
function accountUsage(acc) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'usage-monitor-cache.json'), 'utf8'));
    const stale = (t) => (t && Date.now() - t > 10 * 60_000 ? ' (stale)' : '');
    if (acc.type === 'oauth' && c.usage && c.usage.data && c.usage.data.five_hour) {
      const d = c.usage.data;
      return `5h ${Math.round(d.five_hour.utilization)}% · 7d ${Math.round(d.seven_day.utilization)}%${stale(c.usage.fetchedAt)}`;
    }
    if (acc.type === 'api') {
      const gw = c.gwUsage && c.gwUsage[acc.id];
      if (gw && gw.data) {
        try { const line = require('./gw-usage').gatewayUsageLine(gw.data); if (line) return `${line}${stale(gw.fetchedAt)}`; } catch {}
      }
      if (c.pool && Array.isArray(c.pool.rows) && c.pool.rows.length) { // legacy poolDb metrics
        const rows = c.pool.rows;
        const active = rows.filter((r) => r.status === 'active' && r.reason_code !== 'rate_limited').length;
        const fhs = rows.map((r) => r.fh).filter((v) => v != null);
        const minFh = fhs.length ? Math.round(Math.min(...fhs)) : null;
        return `pool: ${active}/${rows.length} active${minFh != null ? ` · 5h from ${minFh}%` : ''}${stale(c.pool.fetchedAt)}`;
      }
    }
  } catch {}
  return '';
}

// ---- auto-select the best account at launch/resume -------------------------
// Policy: PREFER a subscription (oauth) while it has headroom; only when all
// subscriptions are exhausted fall to the most-available api/pool; if everything
// is exhausted, stay on a subscription (least-bad). Launch/resume only — NEVER
// mid-session (that's the auto-switch that was removed). Skipped when `--account`
// forces one or `features.autoBest` is false.
//
// The DECISION functions live in cl-switch-core (accountHeadroom /
// chooseLaunchAccount) so the launch path here and the `cl:peek` recommendation
// always agree — one source of truth. cl-runner just reads the cache and calls it.
function readUsageCache() {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'usage-monitor-cache.json'), 'utf8')); } catch { return null; }
}

// True if this conversation has a saved transcript (so `--resume` works). A fresh
// session where only a blocked cl: command ran (e.g. cl:add-account in a new
// terminal) never persisted one — then `--resume` fails with "No conversation
// found", and the caller must `--session-id` to (re)create it instead.
function hasTranscript(convId) {
  if (!convId) return false;
  try { return !!require('./cl-sync').findTranscriptFile(convId); } catch { return false; }
}

// ---- interactive account picker (native arrow-key TUI, zero tokens) --------
// Rendered by cl-runner itself after killing claude, so it owns the real
// terminal. Returns the chosen account id, or null on cancel (keep current).
function pickAccount(currentId) {
  return new Promise((resolve) => {
    const accounts = cfg.accounts;
    const stdin = process.stdin, out = process.stdout;
    if (!stdin.isTTY || accounts.length < 2) return resolve(null);

    let sel = Math.max(0, accounts.findIndex((a) => a.id === currentId));
    const cols = (out.columns || 80);
    out.write('\x1b[?1049l\x1b[?25l');       // leave claude's alt screen, hide cursor

    function render() {
      out.write('\x1b[2J\x1b[H');            // clear screen, home
      out.write('\r\n  \x1b[1;36mSwitch cl account\x1b[0m   \x1b[2m↑/↓ move · 1-9 jump · Enter confirm · Esc keep current\x1b[0m\r\n\r\n');
      accounts.forEach((a, i) => {
        const cur = a.id === currentId ? '  \x1b[2m← current\x1b[0m' : '';
        const use = accountUsage(a);
        const body = ` ${String(i + 1)}. ${a.id}  ·  ${a.label} [${a.type}] `;
        const useDim = use ? `  \x1b[2m${use}\x1b[0m` : '';
        out.write(i === sel
          ? `  \x1b[7m${body}\x1b[0m${useDim}${cur}\r\n`   // reverse-video selection
          : `   ${body}${useDim}${cur}\r\n`);
      });
      // Footer reinforces the memorable entry points every time they switch.
      out.write('\r\n  \x1b[2mtip: `cl:switch <name>` jumps directly · `/cl` lists all commands\x1b[0m\r\n');
    }

    function done(id) {
      try { stdin.removeListener('data', onKey); } catch {}
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
      out.write('\x1b[?25h\x1b[2J\x1b[H');   // show cursor, clear (claude re-enters its own screen next)
      resolve(id);
    }

    function onKey(buf) {
      const k = buf.toString('utf8');
      if (k === '\x1b[A' || k === 'k') { sel = (sel - 1 + accounts.length) % accounts.length; render(); }
      else if (k === '\x1b[B' || k === 'j') { sel = (sel + 1) % accounts.length; render(); }
      else if (k >= '1' && k <= '9') { const n = +k - 1; if (n < accounts.length) done(accounts[n].id); } // number = jump + confirm
      else if (k === '\r' || k === '\n') done(accounts[sel].id);
      else if (k === '\x1b' || k === 'q' || k === '\x03') done(null); // Esc / q / Ctrl-C → cancel
    }

    try { stdin.setRawMode(true); } catch {}
    stdin.resume();
    stdin.on('data', onKey);
    render();
  });
}

// ---- generic arrow-key menu (add-account wizard) ---------------------------
function selectMenu(title, options, hint) {
  return new Promise((resolve) => {
    const stdin = process.stdin, out = process.stdout;
    if (!stdin.isTTY) return resolve(null);
    let sel = 0;
    out.write('\x1b[?1049l\x1b[?25l');
    const render = () => {
      out.write('\x1b[2J\x1b[H');
      out.write(`\r\n  \x1b[1;36m${title}\x1b[0m   \x1b[2m${hint || '↑/↓ move · Enter select · Esc cancel'}\x1b[0m\r\n\r\n`);
      options.forEach((o, i) => {
        const desc = o.desc ? `  \x1b[2m${o.desc}\x1b[0m` : '';
        out.write(i === sel ? `  \x1b[7m ${o.label} \x1b[0m${desc}\r\n` : `    ${o.label}${desc}\r\n`);
      });
    };
    const done = (v) => { try { stdin.removeListener('data', onKey); } catch {} try { stdin.setRawMode(false); } catch {} stdin.pause(); out.write('\x1b[?25h'); resolve(v); };
    const onKey = (buf) => {
      const k = buf.toString('utf8');
      if (k === '\x1b[A' || k === 'k') { sel = (sel - 1 + options.length) % options.length; render(); }
      else if (k === '\x1b[B' || k === 'j') { sel = (sel + 1) % options.length; render(); }
      else if (k >= '1' && k <= String(Math.min(9, options.length))) done(+k - 1);
      else if (k === '\r' || k === '\n') done(sel);
      else if (k === '\x1b' || k === 'q' || k === '\x03') done(null);
    };
    try { stdin.setRawMode(true); } catch {}
    stdin.resume(); stdin.on('data', onKey); render();
  });
}

// ---- single-line TTY input (add-account wizard) ----------------------------
function promptLine(label, opts = {}) {
  return new Promise((resolve) => {
    const stdin = process.stdin, out = process.stdout;
    if (!stdin.isTTY) return resolve(null);
    let buf = '';
    out.write('\x1b[?25h');
    const render = () => { out.write('\r\x1b[K  ' + label + (opts.secret ? '*'.repeat(buf.length) : buf)); };
    const done = (v) => { try { stdin.removeListener('data', onKey); } catch {} try { stdin.setRawMode(false); } catch {} stdin.pause(); out.write('\r\n'); resolve(v); };
    const onKey = (chunk) => {
      const s = chunk.toString('utf8');
      if (s === '\x1b') return done(null);          // bare Esc → cancel
      if (s.startsWith('\x1b')) return;             // arrow/nav escape seq → ignore
      for (const c of s) {
        if (c === '\r' || c === '\n') return done(buf.trim());
        if (c === '\x03') return done(null);        // Ctrl-C → cancel
        if (c === '\x7f' || c === '\b') { buf = buf.slice(0, -1); continue; }
        if (c >= ' ') buf += c;
      }
      render();
    };
    try { stdin.setRawMode(true); } catch {}
    stdin.resume(); stdin.on('data', onKey); render();
  });
}

// ---- interactive add-account wizard ----------------------------------------
// Type-select (Subscription vs Gateway) then guided prompts. cl-runner owns the
// TTY (claude was killed by the wizard trigger). Delegates the real work to
// doAddAccount (oauth) / core.addApiAccountResolved (api). Any Esc/Ctrl-C cancels.
async function runAddWizard() {
  resetTerminal();
  const out = process.stdout;
  const cancel = () => out.write('\x1b[2m[cl] add cancelled.\x1b[0m\n');

  const type = await selectMenu('Add a cl account — what type?', [
    { label: 'Subscription', desc: 'claude.ai login (MAX / Pro / Team) — opens a browser' },
    { label: 'Gateway / pool', desc: 'an API key + URL (e.g. mate, APIHub)' },
  ]);
  out.write('\x1b[2J\x1b[H');
  if (type === null) return cancel();

  let id;
  while (true) {
    id = await promptLine('Account id (short name, e.g. work): ');
    if (id === null) return cancel();
    if (!/^[a-z][a-z0-9_-]*$/i.test(id)) { out.write('  \x1b[31m✗ letters/digits/dash/underscore, starting with a letter\x1b[0m\n'); continue; }
    if (C.findAccount(reloadCfg(), id)) { out.write(`  \x1b[31m✗ "${id}" already exists — pick another\x1b[0m\n`); continue; }
    break;
  }

  if (type === 0) { // subscription → browser login flow
    out.write(`\r\n\x1b[2m[cl] adding subscription "${id}" — a browser sign-in will open; log in as the NEW account…\x1b[0m\n`);
    doAddAccount([id]);
    return;
  }

  // gateway / pool
  let url;
  while (true) {
    url = await promptLine('Gateway URL (https://…): ');
    if (url === null) return cancel();
    if (/^https?:\/\/.+/i.test(url.trim())) { url = url.trim(); break; }
    out.write('  \x1b[31m✗ enter a full http(s):// URL\x1b[0m\n');
  }
  const label = id; // one name per account: the id you typed is the display name

  out.write('\r\n  \x1b[1mCopy your API key to the clipboard now\x1b[0m \x1b[2m(never shown or typed)\x1b[0m\n');
  const go = await promptLine('  press Enter to read the key (or Esc to cancel): ');
  if (go === null) return cancel();

  out.write('\x1b[2m  reading key + verifying gateway/models…\x1b[0m\n');
  const { key, src, error } = core.readAddKey([]); // clipboard
  const p = { id, baseUrl: url, key, keySrc: src, keyErr: error, label };
  let r = core.addApiAccountResolved(p);
  // If verification failed (e.g. a flaky gateway timing out), don't throw away all
  // the input — offer to add it unverified (models fall back to Claude Code defaults).
  if (!r.ok && /gateway check FAILED/i.test(r.message)) {
    out.write(`\x1b[33m  ${r.message}\x1b[0m\n`);
    const ans = await promptLine('add anyway WITHOUT verifying? (models = defaults) [y/N]: ');
    if (ans && /^y(es)?$/i.test(ans.trim())) {
      out.write('\x1b[2m  adding unverified…\x1b[0m\n');
      r = core.addApiAccountResolved({ ...p, noVerify: true });
    }
  }
  out.write((r.ok ? '\x1b[32m' : '\x1b[31m') + r.message + '\x1b[0m\r\n');
}

// ---- one claude session ---------------------------------------------------
// Resolves with { reason: 'switch'|'restart'|'effort'|'pick'|'addaccount'|'delete'|'exit', exitCode, payload }.

function runClaude(claudeArgs, account, extraSettings, watchAdopt) {
  return new Promise(resolve => {
    clearTriggers();

    // Inline --settings JSON adds to (not replaces) the settings hierarchy:
    //  - api accounts: the API key takes auth precedence, so claude.ai connectors
    //    are unavailable anyway — disable them quietly (configurable per account).
    //  - extraSettings: e.g. {ultracode: true}, the documented way to start a
    //    session at ultracode (--effort rejects that value).
    const acc = C.findAccount(cfg, account);
    const settings = { ...(extraSettings || {}) };
    if (acc && acc.type === 'api' && acc.disableConnectors) settings.disableClaudeAiConnectors = true;
    const args = Object.keys(settings).length
      ? [...claudeArgs, '--settings', JSON.stringify(settings)]
      : claudeArgs;

    let env;
    try { env = buildEnv(account); }
    catch (e) {
      process.stderr.write(`\x1b[31m[cl] cannot use account "${account}": ${e.message}\x1b[0m\n`);
      return resolve({ reason: 'exit', exitCode: 1 });
    }

    const child = spawn(CLAUDE_BIN, args, {
      stdio: 'inherit',              // native TTY — perfect rendering, slash menus work
      env,
      cwd: process.cwd(),
    });
    writeWinPid(child.pid); // map this claude pid -> the terminal window (toast focus)

    let done = false;
    const finish = (reason, exitCode, payload) => {
      if (done) return;
      done = true;
      clearInterval(triggerPoll);
      try { fs.unlinkSync(winPidPath(child.pid)); } catch {} // pid retiring — drop its window map
      resolve({ reason, exitCode, payload });
    };

    // Poll for this session's trigger files: cl:switch / cl:restart (and the other
    // cl: sentinels) each drop a per-session trigger file via the UserPromptSubmit
    // hook (cl-switch-core), which we act on here.
    // Switching is MANUAL-only — there is no automatic usage-based switching.
    const t0 = Date.now();
    let adoptPending = !!watchAdopt;
    const triggerPoll = setInterval(() => {
      if (fs.existsSync(restartTrigger)) { clearTriggers(); killChild(child); finish('restart'); }
      else if (fs.existsSync(pickTrigger)) {
        // Interactive picker: kill claude, then cl-runner renders the arrow-key UI.
        clearTriggers(); killChild(child); finish('pick');
      }
      else if (fs.existsSync(addAcctTrigger)) {
        // Guided add-account: kill claude, run the browser login on the freed TTY.
        let payload = null;
        try { payload = JSON.parse(fs.readFileSync(addAcctTrigger, 'utf8')); } catch {}
        clearTriggers(); killChild(child); finish('addaccount', undefined, payload || {});
      }
      else if (fs.existsSync(deleteTrigger)) {
        // Delete current session: kill claude (releases the transcript handle),
        // then cl-runner trashes it and starts fresh.
        let payload = null;
        try { payload = JSON.parse(fs.readFileSync(deleteTrigger, 'utf8')); } catch {}
        clearTriggers(); killChild(child); finish('delete', undefined, payload || {});
      }
      else if (fs.existsSync(switchTrigger)) {
        // The trigger may carry a target account id (from `cl:switch <id>`).
        let target = null;
        try {
          const raw = fs.readFileSync(switchTrigger, 'utf8');
          try { target = JSON.parse(raw).target || null; } catch { /* legacy timestamp content */ }
        } catch {}
        clearTriggers(); killChild(child); finish('switch', undefined, { target });
      }
      // Picker resume (`cl --resume` with no id): once the statusline bridges the
      // real conversation id, check the effort that conversation remembers. A
      // plain resume drops it back to the default, so if it's re-appliable,
      // relaunch once (managed, with the effort restored). Give up after 60s —
      // a late surprise restart would be worse than a wrong effort.
      else if (adoptPending) {
        if (Date.now() - t0 > 60_000) { adoptPending = false; return; }
        const actual = readActiveConv();
        if (!actual) return;
        adoptPending = false;
        const want = detectedEffort(actual);
        if (want && want !== watchAdopt.applied && want !== defaultEffort()
            && (CLI_EFFORT.has(want) || want === 'ultracode')) {
          killChild(child);
          finish('effort');
        }
      }
    }, TRIGGER_POLL_MS);

    // Log the raw exit so a silent crash is never traceless. `done` is only true
    // here if a switch/restart trigger already fired — otherwise this
    // is a real claude exit (clean OR crash), captured with its code + signal.
    child.on('exit', (code, signal) => {
      if (!done) logLine(`claude exited code=${code} signal=${signal || '-'} account=${account}`);
      finish('exit', code);
    });
    child.on('error', (err) => {
      logLine(`claude spawn error: ${err && err.message} account=${account}`);
      finish('exit', 1);
    });
  });
}

function killChild(child) {
  try {
    // On Windows, taskkill /T ensures the whole claude process tree dies.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  } catch {}
}

// ---- subcommands ------------------------------------------------------------

// Adopt the CURRENT active login (~/.claude/.credentials.json) into an account's
// own profile dir — a manual migration/repair tool for the profile model. (Fresh
// accounts are normally established by logging in directly into the profile via
// `cl add-account` / cl:switch → /login.)
function cmdCapture(id) {
  const acc = C.findAccount(cfg, id);
  if (!acc || acc.type !== 'oauth') {
    process.stderr.write(`[cl] capture: "${id}" is not a configured oauth account.\n`);
    process.exit(1);
  }
  let cur;
  try { cur = fs.readFileSync(C.CRED_PATH, 'utf8'); }
  catch { process.stderr.write('[cl] capture: no active claude.ai login found (.credentials.json missing).\n'); process.exit(1); }
  try { if (!JSON.parse(cur).claudeAiOauth.accessToken) throw 0; }
  catch { process.stderr.write('[cl] capture: the active login is not a claude.ai OAuth login.\n'); process.exit(1); }
  const dir = P.ensureProfile(acc.id);
  fs.writeFileSync(P.credsPath(acc.id), cur);
  process.stdout.write(`[cl] adopted the CURRENT claude.ai login into account "${acc.id}"'s profile → ${dir}\n`);
  process.stdout.write(`[cl] tip: to add ANOTHER subscription end-to-end, use \`cl add-account <id>\` (it drives the login into its own profile).\n`);
  process.exit(0);
}

// The identity of a claude.ai login. With no arg: the shared ~/.claude login.
// With a profile dir: the login inside that account's CLAUDE_CONFIG_DIR profile.
function authStatus(configDir) {
  try {
    const env = configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env;
    const r = spawnSync(CLAUDE_BIN, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 20_000, windowsHide: true, env });
    const j = JSON.parse((r.stdout || '').trim());
    return j && j.loggedIn ? j : null;
  } catch { return null; }
}

// Append an account to cl-config.json with backup + validate (rollback on error).
function addAccountToConfig(accObj, makeDefault) {
  const bak = C.CONFIG_PATH + '.bak-' + Date.now();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(C.CONFIG_PATH, 'utf8')); }
  catch { raw = { version: 1, accounts: [], switchOrder: [] }; }
  try { fs.copyFileSync(C.CONFIG_PATH, bak); } catch {}
  raw.accounts = raw.accounts || [];
  raw.accounts.push(accObj);
  raw.switchOrder = Array.isArray(raw.switchOrder) ? raw.switchOrder : raw.accounts.map((a) => a.id);
  if (!raw.switchOrder.includes(accObj.id)) raw.switchOrder.push(accObj.id);
  if (makeDefault || !raw.defaultAccount) raw.defaultAccount = accObj.id;
  fs.writeFileSync(C.CONFIG_PATH, JSON.stringify(raw, null, 2));
  try { C.loadConfig(); } catch (e) {
    if (fs.existsSync(bak)) fs.copyFileSync(bak, C.CONFIG_PATH);
    throw new Error(`config rejected (${e.message}) — restored previous`);
  }
  return bak;
}

// The guided add-account flow. Drives the NATIVE Claude login, auto-captures the
// resulting credential, and registers a new oauth account. Returns { code:0|1 }
// and prints its own progress — it NEVER exits, so it works both as the `cl
// add-account` CLI subcommand AND in-session (cl:add-account, run by the wrapper
// after it kills claude and owns the TTY).
function doAddAccount(argv) {
  const id = argv.find((a) => !a.startsWith('-'));
  const opt = (name) => { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : null; };
  const has = (name) => argv.includes(name);
  if (!id || !/^[a-z][a-z0-9_-]*$/i.test(id)) {
    process.stderr.write('[cl] usage: add-account <id> [--label L] [--email E] [--color #hex] [--console] [--default]\n       id must be alphanumeric (dash/underscore ok)\n');
    return { code: 1 };
  }
  if (C.findAccount(reloadCfg(), id)) { process.stderr.write(`[cl] account "${id}" already exists (see \`cl doctor\`).\n`); return { code: 1 }; }

  // Log in DIRECTLY into this account's OWN profile dir (CLAUDE_CONFIG_DIR). The
  // login is written to the profile's private .credentials.json — no other
  // account's login is read, written, or restored. Nothing shared to disturb.
  const profile = P.ensureProfile(id);
  process.stdout.write(
    `\x1b[36m[cl] Adding account "${id}".\x1b[0m\n` +
    `\x1b[2m    A Claude sign-in will open in your browser. Log in as the account you want to ADD.\n` +
    `    The login is saved privately to this account's profile — every other account stays untouched.\x1b[0m\n\n`);

  const loginArgs = ['auth', 'login', has('--console') ? '--console' : '--claudeai'];
  const email = opt('--email'); if (email) loginArgs.push('--email', email);
  const r = spawnSync(CLAUDE_BIN, loginArgs, { stdio: 'inherit', windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: profile } });

  // Verify the login actually landed in this profile.
  if (r.status !== 0 || !P.hasCreds(id)) {
    process.stderr.write(`\x1b[31m[cl] login did not complete — no account added. (no other account was touched)\x1b[0m\n`);
    return { code: 1 };
  }
  const who = authStatus(profile); // identity now inside this profile

  const acc = {
    id,
    // One name per account: the id the user typed IS the display name. (--label
    // stays as an optional override; email is kept only as metadata, not shown.)
    label: opt('--label') || id,
    color: opt('--color') || '#D97757',
    type: 'oauth',
    email: (who && who.email) || null,
    subscriptionType: (who && who.subscriptionType) || null,
  };
  let cfgBak;
  try { cfgBak = addAccountToConfig(acc, has('--default')); }
  catch (e) { process.stderr.write(`\x1b[31m[cl] ${e.message}\x1b[0m\n`); return { code: 1 }; }
  reloadCfg(); // the new account is now switchable

  process.stdout.write(
    `\n\x1b[32m[cl] ✓ added account "${id}"${acc.email ? ` (${acc.email}, ${acc.subscriptionType || 'subscription'})` : ''}.\x1b[0m` +
    `\n[cl] use it:  cl:switch ${id}\n` +
    `[cl] config backed up at ${cfgBak}\n`);
  return { code: 0 };
}

// CLI entry: `cl add-account <id> ...` — run the flow, then exit.
function cmdAddAccount(argv) {
  // Gateway/pool account (--api/--url): verify + register inline (shared core), no
  // browser. Otherwise fall through to the oauth guided-login flow.
  if (argv.includes('--api') || argv.includes('--url')) {
    const r = core.requestAddAccount('', argv.join(' '));
    process.stdout.write(r.message + '\n');
    process.exit(r.ok ? 0 : 1);
  }
  process.exit(doAddAccount(argv).code);
}

function cmdDoctor() {
  const lines = [];
  lines.push(`cl doctor — config: ${C.CONFIG_PATH}${cfg._legacy ? ' (LEGACY fallback — run `cl setup`)' : ''}`);
  lines.push(`claude bin: ${CLAUDE_BIN} ${fs.existsSync(CLAUDE_BIN) || CLAUDE_BIN === 'claude' ? '✓' : '✗ MISSING'}`);
  lines.push(`default account: ${cfg.defaultAccount}   switch order: ${cfg.switchOrder.join(' → ')}`);
  for (const a of cfg.accounts) {
    let status = '✓';
    let detail = '';
    if (a.type === 'api') {
      try { C.resolveApiKey(a); detail = a.baseUrl; }
      catch (e) { status = '✗'; detail = e.message; }
    } else {
      // oauth: the login lives in the account's own CLAUDE_CONFIG_DIR profile.
      if (P.hasCreds(a.id)) detail = 'signed in · own profile';
      else { status = '⚠'; detail = `NO login yet — cl:switch ${a.id} then /login (or cl capture ${a.id})`; }
    }
    lines.push(`  [${a.type}] ${a.id} "${a.label}" ${status} ${detail}`);
  }
  lines.push(`pool metrics: ${cfg.poolDb ? 'configured' : 'off'}`);
  if (cfg.features.autoBest !== false && cfg.accounts.length > 1) {
    const pick = core.chooseLaunchAccount(cfg, readUsageCache());
    lines.push(`auto-select: on — ${pick ? `would launch on ${accountLabel(pick.id)}: ${pick.reason}` : 'no usage data yet → saved/default'}`);
  } else {
    lines.push(`auto-select: off (features.autoBest=false)`);
  }
  // hook wiring
  try {
    const st = JSON.parse(fs.readFileSync(path.join(C.CLAUDE_DIR, 'settings.json'), 'utf8'));
    const has = (ev, frag) => JSON.stringify((st.hooks || {})[ev] || []).includes(frag);
    lines.push(`hooks: notify=${has('Stop', 'cl-notify') ? '✓' : '✗'} wait=${has('Notification', 'cl-notify') ? '✓' : '✗'} fail=${has('StopFailure', 'cl-notify') ? '✓' : '✗'}`);
    lines.push(`statusline: ${st.statusLine && JSON.stringify(st.statusLine).includes('usage-monitor') ? '✓' : '✗ not wired'}`);
  } catch { lines.push('settings.json: unreadable'); }
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

// ---- cl set-key <id> : store an api account's key DPAPI-encrypted in config ---
// Reads the key from the clipboard (default), a file (--file), or stdin (--stdin),
// DPAPI-encrypts it (bound to this Windows user+machine), writes it as `apiKeyEnc`
// in cl-config.json and DROPS any other key source — so no plaintext key lives on
// disk. Backs up + validates (round-trips the decrypt); restores on failure.
function cmdSetKey(argv) {
  const id = argv.find((a) => !a.startsWith('-'));
  if (!id) { process.stderr.write('usage: cl set-key <id> [--file <path> | --stdin]   (default: read key from clipboard)\n'); process.exit(1); }
  const acc = C.findAccount(cfg, id);
  if (!acc) { process.stderr.write(`[cl] unknown account "${id}" (configured: ${cfg.accounts.map((a) => a.id).join(', ')})\n`); process.exit(1); }
  if (acc.type !== 'api') { process.stderr.write(`[cl] set-key applies to api (gateway) accounts; "${id}" is ${acc.type}.\n`); process.exit(1); }

  // 1. obtain the plaintext key
  let key = '', src = 'clipboard';
  const fi = argv.indexOf('--file');
  try {
    if (fi !== -1 && argv[fi + 1]) {
      src = argv[fi + 1];
      const raw = fs.readFileSync(C.expandHome(argv[fi + 1]), 'utf8');
      const m = raw.match(/sk-[A-Za-z0-9-]+/);
      key = m ? m[0] : raw.trim();
    } else if (argv.includes('--stdin')) {
      src = 'stdin'; key = fs.readFileSync(0, 'utf8').trim();
    } else {
      const clip = require('./cl-platform').readClipboard();
      if (clip == null) { process.stderr.write(`[cl] couldn't read the clipboard — ${require('./cl-platform').clipboardHint()}\n`); process.exit(1); }
      key = clip;
    }
  } catch (e) { process.stderr.write(`[cl] could not read key from ${src}: ${e.message}\n`); process.exit(1); }
  key = (key || '').trim();
  if (!key) { process.stderr.write(`[cl] no key found in ${src} (clipboard empty? try --file <path> or --stdin)\n`); process.exit(1); }
  if (!/^sk-/.test(key)) process.stderr.write(`[cl] note: key from ${src} doesn't start with "sk-" (len ${key.length}) — proceeding.\n`);

  // 2. store the key at rest (DPAPI on Windows; 0600 file on POSIX) before touching config
  let stored;
  try { stored = C.storeApiKey(id, key); }
  catch (e) { process.stderr.write(`[cl] could not store key: ${e.message}\n`); process.exit(1); }

  // 3. backup -> write the stored key fields + drop other key sources -> validate -> rollback on fail
  const bak = C.CONFIG_PATH + '.bak-' + Date.now();
  let raw; try { raw = JSON.parse(fs.readFileSync(C.CONFIG_PATH, 'utf8')); }
  catch (e) { process.stderr.write(`[cl] cl-config.json unreadable: ${e.message}\n`); process.exit(1); }
  fs.copyFileSync(C.CONFIG_PATH, bak);
  const a = (raw.accounts || []).find((x) => x.id === id);
  delete a.apiKey; delete a.apiKeyEnv; delete a.apiKeyFrom; delete a.apiKeyEnc; delete a.apiKeyKeychain;
  Object.assign(a, stored.fields);
  fs.writeFileSync(C.CONFIG_PATH, JSON.stringify(raw, null, 2));
  try {
    const k = C.resolveApiKey(C.findAccount(C.loadConfig(), id));
    if (k !== key) throw new Error('resolved key mismatch after write');
  } catch (e) {
    fs.copyFileSync(bak, C.CONFIG_PATH);
    process.stderr.write(`[cl] validation failed — restored backup. ${e.message}\n`); process.exit(1);
  }
  process.stdout.write(`[cl] ✓ "${id}" key stored — ${stored.note}; other key sources removed.\n`);
  process.stdout.write(`     ${key.slice(0, 7)}…${key.slice(-4)} (len ${key.length}) · backup ${path.basename(bak)}\n`);
  process.stdout.write(`     ${process.platform === 'win32'
    ? `DPAPI is per user+machine — on another PC run \`cl set-key ${id}\` there too.`
    : `The key file is machine-local — copy it or re-run \`cl set-key ${id}\` on another machine.`} If you kept a plaintext copy, delete it now.\n`);
  process.exit(0);
}

// ---- main loop ------------------------------------------------------------

async function main() {
  const userArgs = process.argv.slice(2);

  // Subcommands (never claude flags): setup / capture / doctor.
  if (userArgs[0] === 'setup') {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'cl-setup.js')], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
  }
  if (userArgs[0] === 'capture') return cmdCapture(userArgs[1]);
  if (userArgs[0] === 'add-account' || userArgs[0] === 'add') return cmdAddAccount(userArgs.slice(1));
  if (userArgs[0] === 'export' || userArgs[0] === 'import') {
    const sync = require('./cl-sync');
    const fn = userArgs[0] === 'export' ? sync.doExport : sync.doImport;
    const r = fn(process.env.CL_SESSION || '', userArgs.slice(1).join(' '));
    process.stdout.write(r.message + '\n');
    process.exit(r.ok ? 0 : 1);
  }
  if (userArgs[0] === 'peek' || userArgs[0] === 'usage') {
    const r = core.buildPeek(process.env.CL_SESSION || '');
    process.stdout.write(r.message + '\n');
    process.exit(r.ok ? 0 : 1);
  }
  if (userArgs[0] === 'trash') {
    // cl trash [restore <id> | empty [confirm]] — same two-step confirm as the
    // in-session cl:trash (run `cl trash empty`, then `cl trash empty confirm`).
    const r = core.requestTrash(process.env.CL_SESSION || '', userArgs.slice(1).join(' '));
    process.stdout.write(r.message.replace(/cl:trash/g, 'cl trash') + '\n');
    process.exit(r.ok ? 0 : 1);
  }
  if (userArgs[0] === 'set-key') return cmdSetKey(userArgs.slice(1));
  if (userArgs[0] === 'doctor') return cmdDoctor();

  let respawning = process.env.CL_RESPAWNED === '1';
  if (!respawning) { sweepStaleStates(); migrateProfilesOnce(); } // only the original launch; not re-execs
  // Snapshot the terminal window now, while it is still foreground (before claude
  // takes over the TTY), so a clicked toast can focus it later. Once per process.
  captureLaunchWinPid();

  // Parse cl-managed flags out of the args before they reach claude:
  //  --account <id> (or --<id> for any configured account id; legacy --pool/
  //  --apihub/--max still work when such accounts exist) → starting account.
  //  --effort <level> → PIN the effort for the whole cl session, re-applied on
  //  every respawn (pin > per-conversation detection).
  let forceAccount = null, argEffort = null, forceDupFlag = false;
  const passArgs = [];
  const idFlags = new Set(cfg.accounts.map((a) => `--${a.id}`));
  for (let i = 0; i < userArgs.length; i++) {
    const x = userArgs[i];
    if (x === '--account' && userArgs[i + 1]) { forceAccount = userArgs[i + 1]; i++; continue; }
    if (idFlags.has(x)) { forceAccount = x.slice(2); continue; }
    if (x === '--apihub' && C.findAccount(cfg, 'apihub')) { forceAccount = 'apihub'; continue; } // legacy alias
    if (x === '--effort') { argEffort = userArgs[i + 1] || null; i++; continue; }
    if (x === '--force-duplicate') { forceDupFlag = true; continue; } // cl-only; strip before claude
    passArgs.push(x);
  }

  const state = readState();
  let account = state.account;
  let switchCount = state.switchCount;
  if (!respawning && forceAccount) {
    const acc = C.findAccount(cfg, forceAccount);
    if (!acc) {
      process.stderr.write(`[cl] unknown account "${forceAccount}" (configured: ${cfg.accounts.map(a => a.id).join(', ')})\n`);
      process.exit(1);
    }
    account = acc.id;
  } else if (!respawning && cfg.features.autoBest !== false && cfg.accounts.length > 1) {
    // Auto-select the launch account (fresh `cl` + `cl --resume`, NOT /switch or
    // /restart which are respawns). Prefer the subscription; fall to the most
    // available only when it's exhausted. No override when we can't judge (cache
    // missing) — then the saved/default account stands.
    const pick = core.chooseLaunchAccount(cfg, readUsageCache());
    if (pick && pick.id !== account) {
      process.stdout.write(`\x1b[2m[cl] auto-selected ${accountLabel(pick.id)} — ${pick.reason}\x1b[0m\n`);
      account = pick.id;
    } else if (pick && pick.id === account) {
      process.stdout.write(`\x1b[2m[cl] ${pick.reason}\x1b[0m\n`);
    }
  }

  // Pinned effort: from the --effort flag, else carried in state across /restart.
  let pinnedEffort = argEffort || state.pinnedEffort || null;
  if (pinnedEffort && !EFFORT_OK.has(pinnedEffort)) pinnedEffort = null;

  // Per-terminal conversation isolation. Each cl terminal owns ONE conversation
  // identified by a UUID. We pin it explicitly (--session-id to create, --resume
  // to re-open) instead of --continue, which grabs "most recent in cwd" and would
  // cross-contaminate when several cl terminals share a directory. If the user
  // passed their own --resume/-r/--session-id, respect it and don't manage one.
  // Once state has a convId, the managed path owns it (so /restart re-resumes it).
  let userManagesConv =
    (passArgs.includes('--resume') || passArgs.includes('-r') || passArgs.includes('--session-id')) &&
    !state.convId;
  let convId = state.convId;
  let convStarted = respawning && !!convId; // has this conv been created already?
  if (!userManagesConv && !convId) {
    convId = crypto.randomUUID();
    convStarted = false;
  }

  // An explicitly-passed conversation id lets us restore that conversation's
  // remembered effort right at launch (a bare picker resume can't — see the
  // adoption watch in runClaude / the 'effort' relaunch below).
  const explicitId = userManagesConv ? explicitConvId(passArgs) : null;
  let adoptFixDone = false; // at most ONE effort-restoring relaunch per cl process

  // DUPLICATE-LIVE-SESSION GUARD (fixes the confirmed "both sessions crash at
  // once" bug). Two cl processes resuming the SAME conversation both write its
  // transcript .jsonl and can die together; re-resuming re-collides. Refuse to
  // open a conversation another LIVE cl already owns — unless --force. Skipped
  // on a /restart re-exec (CL_RESPAWNED): that's the same logical session handing
  // off to itself, and the old process is already exiting.
  const forceDup = forceDupFlag || process.env.CL_FORCE_DUP === '1';
  // Guard the ids we know pre-launch: a managed convId (incl. /restart re-exec),
  // OR an explicit `cl --resume <uuid>`. A bare picker resume has no id yet — it
  // gets claimed once the statusline bridges its real id (see below).
  const guardConv = convId || explicitId;
  if (!forceDup && guardConv) {
    const owner = liveOwnerOf(guardConv);
    if (owner) {
      process.stderr.write(
        `\x1b[31m[cl] REFUSING TO LAUNCH — conversation ${guardConv.slice(0, 8)} is already open in a live cl session ` +
        `(pid ${owner.pid}, cwd ${owner.cwd}).\x1b[0m\n` +
        `\x1b[33m[cl] Two sessions on one conversation corrupt each other and can crash together (this is that bug).\n` +
        `      • Use the EXISTING window, or\n` +
        `      • start a fresh chat: \`cl\` (no --resume), or\n` +
        `      • fork it read-only: \`claude --resume ${guardConv} --fork-session\`, or\n` +
        `      • override (NOT recommended): \`cl --force-duplicate ...\`\x1b[0m\n`);
      logLine(`refused duplicate launch of conv=${guardConv} (live owner pid=${owner.pid})`);
      process.exit(1);
    }
    claimConv(guardConv); // this session now owns it
  } else if (!userManagesConv && convId) {
    // Brand-new managed conversation (fresh `cl`): claim its just-minted id so a
    // second terminal can't collide on it either.
    claimConv(convId);
  }
  // Release our conversation lock on ANY exit path (clean quit, crash, Ctrl-C).
  const releaseOnExit = () => releaseConv(convId || explicitId);
  process.on('exit', releaseOnExit);
  process.on('SIGINT', () => { releaseOnExit(); process.exit(130); });
  process.on('SIGTERM', () => { releaseOnExit(); process.exit(143); });
  // Heal a PHANTOM convId inherited from state on a re-exec (/restart) or crash
  // recovery: if what we're about to launch has NO transcript but the statusline
  // bridge still points at a REAL conversation, adopt the real one BEFORE the
  // first launch. Otherwise the first --session-id would mint a new empty session
  // before the post-run reconcile could correct it — which would make /restart
  // (the very way a user picks up this fix) briefly open an empty chat.
  if (respawning && convId && !userManagesConv && !hasTranscript(convId)) {
    const bridged = readActiveConv();
    if (bridged && bridged !== convId && hasTranscript(bridged)) {
      releaseConv(convId);
      logLine(`pre-launch reconcile: phantom ${convId.slice(0, 8)} → ${bridged.slice(0, 8)} (statusline bridge)`);
      convId = bridged;
      if (!(forceDup ? null : liveOwnerOf(convId))) claimConv(convId);
    }
  }
  logLine(`launch account=${account} conv=${guardConv || '(picker/new)'} cwd=${process.cwd()}${forceDup ? ' [FORCED DUP]' : ''}`);

  for (;;) {
    // Build claude args, pinning THIS terminal's conversation by UUID so parallel
    // cl sessions never resume each other's chat (the --continue footgun).
    //   - first time we launch this conv  -> --session-id <uuid>  (create it)
    //   - every subsequent launch         -> --resume <uuid>      (re-open it)
    // If the user manages their own conversation, pass their args untouched.
    // Effort to apply: a pin (--effort flag / state) always wins; otherwise use
    // the conversation's sticky effort (statusline-tracked; includes ultracode).
    const effConv = convId || explicitId;
    const eff = pinnedEffort || (effConv ? detectedEffort(effConv) : null);
    // How to apply it: low..max ride the --effort flag. ultracode is REJECTED by
    // the flag (the CLI warns, then silently drops to the default) but has a
    // documented settings key. auto has no non-interactive mechanism at all.
    let effFlag = [], effSettings = null, applied = null;
    if (eff === 'ultracode') { effSettings = { ultracode: true }; applied = eff; }
    else if (eff && CLI_EFFORT.has(eff)) { effFlag = ['--effort', eff]; applied = eff; }

    let claudeArgs;
    if (userManagesConv) {
      claudeArgs = [...passArgs, ...effFlag];
    } else {
      const a = stripConvArgs(passArgs); // no lingering --resume/--session-id to duplicate
      // On respawn (switch/restart), also re-apply the session's model + mode.
      // Only --resume if the conversation was actually persisted; a fresh session
      // that just ran a blocked cl: command has no transcript, so --resume would
      // fail ("No conversation found") — (re)create it with --session-id instead.
      const canResume = convStarted && hasTranscript(convId);
      claudeArgs = canResume
        ? [...a, '--resume', convId, ...preservedFlags(convId), ...effFlag]
        : [...a, '--session-id', convId, ...effFlag];
    }

    writeState({ account, switchCount, convId, pinnedEffort });
    // Seed the sticky baseline with what we ACTUALLY applied, so the statusline
    // never claims an effort the session isn't really at.
    if (effConv) seedEffort(effConv, applied);
    // Credentials are isolated per account via CLAUDE_CONFIG_DIR (set in buildEnv →
    // P.ensureProfile); there is no shared login to swap.
    process.stdout.write(`\x1b[2m[cl] starting on ${accountLabel(account)}...\x1b[0m\n`);

    // Watch for conversation adoption only on a picker resume (no id known
    // pre-launch), and only until the first effort-restoring relaunch.
    const watch = (userManagesConv && !explicitId && !adoptFixDone) ? { applied } : null;
    const { reason, exitCode, payload } = await runClaude(claudeArgs, account, effSettings, watch);
    // After the first successful launch the conversation exists; from now on we
    // must --resume it, never re-create it with --session-id.
    convStarted = true;
    // Reconcile our tracked convId with the GROUND TRUTH the statusline bridges —
    // the conversation claude is ACTUALLY showing. Adopt the bridged id when it
    // diverges. This covers BOTH:
    //   (a) a `cl --resume` picker session whose id cl never assigned (userManagesConv), and
    //   (b) a MANAGED session that DRIFTED — our convId points at a phantom with no
    //       transcript (e.g. the user used claude's own resume, or the real id
    //       diverged from the minted one). Without this, a switch/restart re-opens
    //       the phantom via --session-id and mints a brand-new EMPTY session — the
    //       "cl:switch opens a new session instead of resuming" bug.
    // Guard (managed case) via hasTranscript: only adopt a bridged id that is a
    // REAL persisted conversation, never a transient/bogus one. (pickConvId in
    // cl-conv.js is the pure, unit-tested decision.)
    const actual = readActiveConv();
    const resolved = pickConvId(convId, actual, userManagesConv, hasTranscript);
    if (resolved !== convId) {
      const prev = convId;
      convId = resolved;
      if (prev) releaseConv(prev); // drop the stale/phantom claim we no longer track
      // Enforce the duplicate-session guard on the newly-revealed real id: if
      // another live cl already owns it we collided — warn (can't un-launch
      // retroactively) — otherwise claim it so the NEXT launch and other
      // terminals see it as taken.
      const owner = !forceDup ? liveOwnerOf(convId) : null;
      if (owner) {
        process.stderr.write(`\x1b[31m[cl] WARNING — the resumed conversation ${convId.slice(0, 8)} is ALSO open in cl pid ${owner.pid} (${owner.cwd}). Two sessions on one conversation can corrupt/crash. Close one.\x1b[0m\n`);
        logLine(`duplicate detected post-adopt conv=${convId} other pid=${owner.pid}`);
      } else {
        claimConv(convId);
      }
      logLine(`reconciled convId ${prev ? prev.slice(0, 8) : '(none)'} → ${convId.slice(0, 8)} (statusline bridge)`);
    }
    // Once the statusline has revealed the real id we track, the managed path owns
    // it (--resume), so a switch/restart re-opens THIS chat instead of the picker.
    if (actual && convId === actual) userManagesConv = false;

    if (reason === 'restart') {
      // Re-exec the whole wrapper so freshly-edited on-disk code loads too. State
      // (incl. convId) persists and CL_SESSION is inherited, so the child re-opens
      // THIS same conversation with --resume; pass only the user's original args.
      writeState({ account, switchCount, convId, pinnedEffort });
      process.stdout.write('\x1b[36m[cl] reloading wrapper + restarting claude...\x1b[0m\n');
      const r = spawnSync(process.execPath, [__filename, ...passArgs], {
        stdio: 'inherit',
        env: { ...process.env, CL_SESSION: SESSION_ID, CL_RESPAWNED: '1' },
      });
      process.exit(r.status == null ? 0 : r.status);
    }

    if (reason === 'delete') {
      // claude is dead → its transcript handle is released → safe to move it.
      const delConv = (payload && payload.convId) || convId;
      let res = { trashDir: null, moved: [] };
      try { res = require('./cl-sync').trashSession(delConv); } catch (e) { logLine(`delete failed: ${e.message}`); }
      releaseConv(delConv);
      try { fs.unlinkSync(effortStateFile(delConv)); } catch {}
      logLine(`deleted conv=${delConv} → ${res.trashDir || '(not found)'} (${res.moved.join('+') || 'nothing'})`);
      // Start a brand-new empty conversation in this same terminal.
      convId = crypto.randomUUID();
      convStarted = false; userManagesConv = false;
      claimConv(convId);
      writeState({ account, switchCount, convId, pinnedEffort });
      process.stdout.write(res.moved.length
        ? `\x1b[33m[cl] deleted this conversation → recoverable trash: ${res.trashDir}\x1b[0m\n\x1b[2m[cl] list/restore/purge later with cl:trash — starting a fresh session…\x1b[0m\n`
        : `\x1b[33m[cl] (no transcript found to delete) — starting a fresh session…\x1b[0m\n`);
      await new Promise(r => setTimeout(r, 300));
      continue; // loop launches --session-id <new convId>
    }

    if (reason === 'addaccount') {
      // claude is dead, cl-runner owns the TTY. Wizard (bare cl:add-account) →
      // type-select + prompts; otherwise the flag-driven guided login/api add.
      if (payload && payload.wizard) {
        await runAddWizard();
      } else {
        resetTerminal();
        const argv = (payload && typeof payload.args === 'string' ? payload.args : '').trim().split(/\s+/).filter(Boolean);
        doAddAccount(argv); // prints its own progress; never exits
      }
      process.stdout.write('\x1b[2m[cl] returning to your conversation…\x1b[0m\n');
      writeState({ account, switchCount, convId, pinnedEffort });
      await new Promise(r => setTimeout(r, 300));
      continue; // relaunch --resume convId on the SAME account
    }

    if (reason === 'pick') {
      // Interactive account picker: claude is dead, cl-runner owns the TTY.
      reloadCfg(); // reflect accounts added/edited since launch
      const chosen = await pickAccount(account);
      if (chosen && chosen !== account) {
        switchCount++;
        account = chosen;
        process.stdout.write(`\x1b[36m[cl] switching to ${accountLabel(account)} — continuing conversation...\x1b[0m\n`);
      } else {
        process.stdout.write(`\x1b[2m[cl] staying on ${accountLabel(account)}.\x1b[0m\n`);
      }
      writeState({ account, switchCount, convId, pinnedEffort });
      await new Promise(r => setTimeout(r, 200));
      continue; // loop top relaunches --resume convId on `account`
    }

    if (reason === 'switch') {
      // Pick up accounts added/edited since launch (cl MCP / manual edits).
      const next = C.nextAccount(reloadCfg(), account, payload && payload.target);
      if (!next) {
        process.stdout.write('\x1b[33m[cl] only one account configured — nothing to switch to. Relaunching...\x1b[0m\n');
      } else {
        switchCount++;
        account = next.id;
      }
      writeState({ account, switchCount, convId, pinnedEffort });
      // The loop top re-opens THIS conversation via --resume convId (convStarted
      // is now true), so the same chat continues on the other account.
      process.stdout.write(`\x1b[36m[cl] switching to ${accountLabel(account)} — continuing conversation...\x1b[0m\n`);
      await new Promise(r => setTimeout(r, 400));
      continue;
    }

    if (reason === 'effort') {
      // Picker resume adopted a conversation that remembers an effort a plain
      // resume dropped — relaunch managed so the loop top re-applies it.
      adoptFixDone = true;
      const actual = readActiveConv();
      if (actual) { convId = actual; userManagesConv = false; }
      writeState({ account, switchCount, convId, pinnedEffort });
      process.stdout.write(`\x1b[36m[cl] restoring this conversation's effort — relaunching...\x1b[0m\n`);
      await new Promise(r => setTimeout(r, 400));
      continue;
    }

    // Normal exit — the user quit claude. Clean up this session's bookkeeping
    // (state + session-id bridge; the conversation itself is preserved by claude).
    deleteState();
    try { fs.unlinkSync(path.join(CACHE_DIR, `cl-active-${SESSION_ID}.json`)); } catch {}
    process.exit(exitCode ?? 0);
  }
}

main().catch(e => {
  process.stderr.write('[cl] fatal: ' + e.message + '\n');
  process.exit(1);
});
