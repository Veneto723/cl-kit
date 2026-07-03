#!/usr/bin/env node
// cl-runner: launches Claude Code with NATIVE stdio (perfect rendering — no
// PTY/ConPTY, so claude's own slash menus work) and switches between the
// accounts defined in ~/.claude/cl-config.json (oauth subscriptions and/or
// API gateways — any number, any mix).
//
// Switching is MANUAL-only, driven by trigger files (not keystroke interception):
//   - /switch [account] and /restart are REAL Claude Code slash commands whose
//     `!`-bash drops a per-session trigger file (see commands/*.md + cl-signal.js).
//     This runner polls for its own session's trigger.
//   - There is NO usage-based auto-switch. Use /switch (or `cl --account <id>`).
//
// Subcommands:  cl setup    — interactive config wizard
//               cl capture <id> — save the current claude.ai login for an oauth account
//               cl doctor   — print resolved config + health checks
// Usage: node cl-runner.js [claude args...]   (normally via cl.cmd)
'use strict';

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const C = require('./cl-config');

const CACHE_DIR = C.CACHE_DIR;
const TRIGGER_POLL_MS = 1_000;    // how often to check for a slash-command trigger

const cfg = (() => {
  try { return C.loadConfig(); }
  catch (e) {
    process.stderr.write(`[cl] ${e.message}\n[cl] run \`cl setup\` to create ~/.claude/cl-config.json\n`);
    process.exit(1);
  }
})();
const CLAUDE_BIN = C.claudeBin(cfg);

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

// Sweep per-session state files older than a day, so ones orphaned by a hard
// kill (terminal closed with the X, machine reboot) don't accumulate forever.
// Effort memories get 7 days: they're what lets `cl --resume` restore a
// conversation's effort (incl. ultracode) days later.
function sweepStaleStates() {
  const DAY = 24 * 60 * 60 * 1000;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!/^cl-(state|prefs|active|effort|flagretry|flagretry-payload|turn)-.*\.json$/.test(f)) continue;
      const p = path.join(CACHE_DIR, f);
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

// For oauth accounts with a captured credentials file: make that login the
// active one before launching. Never deletes anything — the current login is
// backed up to cache first (kept recoverable).
function applyCredentials(acc) {
  if (!acc || acc.type !== 'oauth' || !acc.credentials) return;
  let next = null;
  try { next = fs.readFileSync(acc.credentials, 'utf8'); }
  catch {
    process.stdout.write(`\x1b[33m[cl] account "${acc.id}": credentials file missing (${acc.credentials}) — run \`cl capture ${acc.id}\` while logged in as it. Using current login.\x1b[0m\n`);
    return;
  }
  let cur = null;
  try { cur = fs.readFileSync(C.CRED_PATH, 'utf8'); } catch {}
  if (cur === next) return; // already the active login
  try {
    if (cur != null) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(path.join(CACHE_DIR, `cl-cred-backup-${Date.now()}.json`), cur);
    }
    fs.writeFileSync(C.CRED_PATH, next);
    process.stdout.write(`\x1b[2m[cl] activated claude.ai login for "${acc.id}"\x1b[0m\n`);
  } catch (e) {
    process.stdout.write(`\x1b[33m[cl] credential swap failed (${e.message}) — using current login.\x1b[0m\n`);
  }
}

// Env for the claude child under `accountId`; throws if an api key is missing.
function buildEnv(accountId) {
  const acc = C.findAccount(cfg, accountId);
  const env = C.accountEnv(acc, process.env);
  env.CL_SESSION = SESSION_ID;
  // Never leak the respawn marker into claude (and its subshells); otherwise a
  // nested `cl` would think it's a /restart and reuse this SESSION_ID.
  delete env.CL_RESPAWNED;
  return env;
}

// ---- preserve mode/model/effort across a switch ---------------------------
// On respawn we re-apply the session's current choices so a /switch or /restart
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
// Dropped by cl-flag-retry.js (Stop hook) when the model's safeguards flagged a
// message and it prepared a rephrased retry: {text, model, uuid, at}.
const flagRetryTrigger = path.join(CACHE_DIR, `cl-flagretry-${SESSION_ID}.trigger`);

function clearTriggers() {
  for (const t of [switchTrigger, restartTrigger, flagRetryTrigger]) {
    try { fs.unlinkSync(t); } catch {}
  }
}

// ---- one claude session ---------------------------------------------------
// Resolves with { reason: 'switch'|'restart'|'flagretry'|'effort'|'exit', exitCode, payload }.

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

    let done = false;
    const finish = (reason, exitCode, payload) => {
      if (done) return;
      done = true;
      clearInterval(triggerPoll);
      resolve({ reason, exitCode, payload });
    };

    // Poll for slash-command triggers (this session only): /switch and /restart
    // each drop a per-session trigger file (via cl-signal.js) that we act on here.
    // Switching is MANUAL-only — there is no automatic usage-based switching.
    const t0 = Date.now();
    let adoptPending = !!watchAdopt;
    const triggerPoll = setInterval(() => {
      if (fs.existsSync(restartTrigger)) { clearTriggers(); killChild(child); finish('restart'); }
      else if (fs.existsSync(switchTrigger)) {
        // The trigger may carry a target account id (from `/switch <id>`).
        let target = null;
        try {
          const raw = fs.readFileSync(switchTrigger, 'utf8');
          try { target = JSON.parse(raw).target || null; } catch { /* legacy timestamp content */ }
        } catch {}
        clearTriggers(); killChild(child); finish('switch', undefined, { target });
      }
      else if (fs.existsSync(flagRetryTrigger)) {
        // Safeguard-flag auto-retry: relaunch on the original model and
        // auto-submit the rephrased message. Read BEFORE clearTriggers.
        let payload = null;
        try { payload = JSON.parse(fs.readFileSync(flagRetryTrigger, 'utf8')); } catch {}
        clearTriggers();
        if (payload && payload.text) { killChild(child); finish('flagretry', undefined, payload); }
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

    child.on('exit', code => finish('exit', code));
    child.on('error', () => finish('exit', 1));
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

function cmdCapture(id) {
  const acc = C.findAccount(cfg, id);
  if (!acc || acc.type !== 'oauth') {
    process.stderr.write(`[cl] capture: "${id}" is not a configured oauth account.\n`);
    process.exit(1);
  }
  let cur;
  try { cur = fs.readFileSync(C.CRED_PATH, 'utf8'); }
  catch { process.stderr.write('[cl] capture: no active claude.ai login found (.credentials.json missing).\n'); process.exit(1); }
  let dest = acc.credentials;
  if (!dest) {
    dest = path.join(C.CLAUDE_DIR, 'cl-credentials', `${acc.id}.json`);
    // Persist the default path into the config so switches know where to look.
    try {
      const raw = JSON.parse(fs.readFileSync(C.CONFIG_PATH, 'utf8'));
      const a = (raw.accounts || []).find((x) => x.id === acc.id);
      if (a) { a.credentials = dest; fs.writeFileSync(C.CONFIG_PATH, JSON.stringify(raw, null, 2)); }
    } catch {}
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, cur);
  process.stdout.write(`[cl] captured the CURRENT claude.ai login as account "${acc.id}" → ${dest}\n`);
  process.stdout.write(`[cl] tip: to capture another subscription, /logout, log in as it, then \`cl capture <otherId>\`.\n`);
  process.exit(0);
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
      if (a.credentials) detail = fs.existsSync(a.credentials) ? `credentials captured` : `credentials NOT captured (run \`cl capture ${a.id}\`)`;
      else detail = 'uses active login';
      if (a.credentials && !fs.existsSync(a.credentials)) status = '⚠';
    }
    lines.push(`  [${a.type}] ${a.id} "${a.label}" ${status} ${detail}`);
  }
  lines.push(`pool metrics: ${cfg.poolDb ? 'configured' : 'off'}`);
  // hook wiring
  try {
    const st = JSON.parse(fs.readFileSync(path.join(C.CLAUDE_DIR, 'settings.json'), 'utf8'));
    const has = (ev, frag) => JSON.stringify((st.hooks || {})[ev] || []).includes(frag);
    lines.push(`hooks: notify=${has('Stop', 'cl-notify') ? '✓' : '✗'} flagRetry=${has('Stop', 'cl-flag-retry') ? '✓' : '✗'} wait=${has('Notification', 'cl-notify') ? '✓' : '✗'} fail=${has('StopFailure', 'cl-notify') ? '✓' : '✗'}`);
    lines.push(`statusline: ${st.statusLine && JSON.stringify(st.statusLine).includes('usage-monitor') ? '✓' : '✗ not wired'}`);
  } catch { lines.push('settings.json: unreadable'); }
  process.stdout.write(lines.join('\n') + '\n');
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
  if (userArgs[0] === 'doctor') return cmdDoctor();

  let respawning = process.env.CL_RESPAWNED === '1';
  if (!respawning) sweepStaleStates(); // only the original launch; not re-execs

  // Parse cl-managed flags out of the args before they reach claude:
  //  --account <id> (or --<id> for any configured account id; legacy --pool/
  //  --apihub/--max still work when such accounts exist) → starting account.
  //  --effort <level> → PIN the effort for the whole cl session, re-applied on
  //  every respawn (pin > per-conversation detection).
  let forceAccount = null, argEffort = null;
  const passArgs = [];
  const idFlags = new Set(cfg.accounts.map((a) => `--${a.id}`));
  for (let i = 0; i < userArgs.length; i++) {
    const x = userArgs[i];
    if (x === '--account' && userArgs[i + 1]) { forceAccount = userArgs[i + 1]; i++; continue; }
    if (idFlags.has(x)) { forceAccount = x.slice(2); continue; }
    if (x === '--apihub' && C.findAccount(cfg, 'apihub')) { forceAccount = 'apihub'; continue; } // legacy alias
    if (x === '--effort') { argEffort = userArgs[i + 1] || null; i++; continue; }
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
  let flagRetry = null;     // {text, model} — pending safeguard-flag auto-retry

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
      claudeArgs = convStarted
        ? [...a, '--resume', convId, ...preservedFlags(convId), ...effFlag]
        : [...a, '--session-id', convId, ...effFlag];
    }

    // Safeguard-flag auto-retry: force the ORIGINAL model (the fallback latched
    // the transcript's last model to the fallback, so preservedFlags would keep
    // it) and auto-submit the rephrased message as the initial prompt.
    if (flagRetry) {
      const i = claudeArgs.indexOf('--model');
      if (i !== -1) claudeArgs.splice(i, 2);
      claudeArgs.push('--model', flagRetry.model || 'fable', flagRetry.text);
      flagRetry = null;
    }

    writeState({ account, switchCount, convId, pinnedEffort });
    // Seed the sticky baseline with what we ACTUALLY applied, so the statusline
    // never claims an effort the session isn't really at.
    if (effConv) seedEffort(effConv, applied);
    applyCredentials(C.findAccount(cfg, account)); // multi-subscription swap (no-op otherwise)
    process.stdout.write(`\x1b[2m[cl] starting on ${accountLabel(account)}...\x1b[0m\n`);

    // Watch for conversation adoption only on a picker resume (no id known
    // pre-launch), and only until the first effort-restoring relaunch.
    const watch = (userManagesConv && !explicitId && !adoptFixDone) ? { applied } : null;
    const { reason, exitCode, payload } = await runClaude(claudeArgs, account, effSettings, watch);
    // After the first successful launch the conversation exists; from now on we
    // must --resume it, never re-create it with --session-id.
    convStarted = true;
    // Learn the ACTUAL session id claude used (via the statusline bridge). For a
    // `cl --resume` picker session, this is the id the user picked — adopt it so
    // switches re-resume it precisely AND preserve its model/mode/effort.
    if (userManagesConv) {
      const actual = readActiveConv();
      if (actual) { convId = actual; userManagesConv = false; }
    }

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

    if (reason === 'switch') {
      const next = C.nextAccount(cfg, account, payload && payload.target);
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

    if (reason === 'flagretry') {
      // A safeguard flag dropped this conversation to the fallback model.
      // Relaunch on the original model, auto-submitting the rephrased message.
      flagRetry = payload;
      writeState({ account, switchCount, convId, pinnedEffort });
      process.stdout.write(`\x1b[35m[cl] safeguard flag — retrying rephrased message on ${payload.model || 'fable'}...\x1b[0m\n`);
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
