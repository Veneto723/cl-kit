#!/usr/bin/env node
// arc statusline: live subscription rate-limit monitor (session/weekly %, not $),
// account-aware via ~/.claude/arc-config.json. Shows the ACTIVE arc account's
// label+color, oauth usage bars (from Claude Code's statusline stdin or the
// /api/oauth/usage endpoint), optional pool-DB account metrics, model+effort
// (with sticky ultracode detection), and switch warnings near the limits.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, spawn } = require('child_process');

const C = require('./arc-config');
const GW = require('./gw-usage'); // gateway (api) accounts' own usage endpoint

const CACHE_PATH = path.join(C.CACHE_DIR, 'usage-monitor-cache.json');
// Dry-run hook: if this marker file exists, the statusline forces the
// both-exhausted alert (in any mode) so it can be visually verified without
// actually exhausting the pool. Delete the file to stop.
const BOTH_EXHAUSTED_TEST = path.join(C.CACHE_DIR, 'both-exhausted.test');
const CACHE_TTL_MS = 60_000;
const POOL_CACHE_TTL_MS = 5 * 60_000;
const GW_CACHE_TTL_MS = 5 * 60_000; // gateway (api) accounts' own /v1/usage endpoint
const HISTORY_WINDOW_MS = 45 * 60 * 1000;
const ETA_LOOKBACK_MS = 20 * 60 * 1000;
const ETA_MIN_SPAN_MS = 3 * 60 * 1000;

const cfg = (() => {
  try { return C.loadConfig(); }
  catch { return null; } // render degrades gracefully with no config
})();
const TH = (cfg && cfg.thresholds) || {};
const SWITCH_SESSION = TH.switchSessionPct ?? 92;
const SWITCH_WEEK = TH.switchWeekPct ?? 95;
const WARN_SESSION = TH.warnSessionPct ?? 85;
const WARN_WEEK = TH.warnWeekPct ?? 90;

// ---- active account resolution ----------------------------------------------
// 1. Under arc: the per-session state file (written by arc-runner) is authoritative.
// 2. Else: match ANTHROPIC_BASE_URL against configured api accounts.
// 3. Else: the config's default account (plain `claude` on an oauth login).
function activeAccount() {
  if (!cfg) return null;
  const arc = process.env.ARC_SESSION;
  if (arc) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(C.CACHE_DIR, `arc-state-${arc}.json`), 'utf8'));
      const acc = C.findAccount(cfg, st.account);
      if (acc) return acc;
    } catch {}
  }
  const base = process.env.ANTHROPIC_BASE_URL || '';
  if (base) {
    const hit = cfg.accounts.find((a) => a.type === 'api' && a.baseUrl && base.startsWith(a.baseUrl));
    if (hit) return hit;
    return cfg.accounts.find((a) => a.type === 'api') || C.findAccount(cfg, cfg.defaultAccount);
  }
  // No gateway env → an oauth login is active.
  return cfg.accounts.find((a) => a.type === 'oauth') || C.findAccount(cfg, cfg.defaultAccount);
}

// The primary oauth account (whose usage the oauth endpoint reports) — shown as
// the secondary "when does it free up" segment while an api account is active.
function primaryOauth() {
  return cfg ? cfg.accounts.find((a) => a.type === 'oauth') || null : null;
}

// What arc:switch would move to — used to word the warning nudges.
function switchTargetLabel(fromId) {
  if (!cfg) return null;
  const next = C.nextAccount(cfg, fromId, null);
  return next ? next.label : null;
}

// The oauth account whose subscription numbers we DISPLAY: the active one when it
// is oauth, else the primary oauth (shown as the "frees up" segment under a gateway).
function subscriptionAccount() {
  const a = activeAccount();
  return (a && a.type === 'oauth') ? a : primaryOauth();
}

// Read ONE account's token from its own profile dir (~/.claude/arc-profiles/<id>/
// .credentials.json). Taking the account as an argument — instead of resolving the
// active one inside — is what lets a refresh fetch EVERY oauth account's usage with
// the right token, so each account's numbers can be cached under its own id.
// Falls back to the shared file (pre-migration, or under plain `claude`).
function tokenFor(acc) {
  let file = acc ? require('./arc-profile').credsPath(acc.id) : C.CRED_PATH;
  if (!fs.existsSync(file)) file = C.CRED_PATH;
  const creds = JSON.parse(fs.readFileSync(file, 'utf8'));
  return creds.claudeAiOauth.accessToken;
}

async function fetchUsageFor(acc) {
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${tokenFor(acc)}`,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function readCacheFile() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeCacheFile(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  // Write-then-rename so a concurrent statusline instance in another
  // terminal can never observe (or produce) a half-written cache file.
  const tmpPath = `${CACHE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(cache));
  fs.renameSync(tmpPath, CACHE_PATH);
}

function appendHistory(history, data) {
  const now = Date.now();
  const next = [
    ...(history || []),
    { t: now, session: data.five_hour.utilization, week: data.seven_day.utilization },
  ];
  const cutoff = now - HISTORY_WINDOW_MS;
  return next.filter((h) => h.t >= cutoff);
}

// Subscription usage is cached PER ACCOUNT (cache.usageByAccount[id]), with each
// account's ETA series under cache.historyByAccount[id] — mirroring how gateway
// accounts are already keyed (cache.gwUsage[id]).
//
// The old single `cache.usage` slice carried no account id, so nothing could tell
// whose numbers it held. Fetched with whatever account was active, it was then read
// back for ANY oauth account: right after a switch the still-TTL-fresh numbers of the
// PREVIOUS account were painted under the new account's label (and, looking fresh,
// suppressed the background refresh that would have corrected them), while arc:peek
// and auto-select scored every oauth account off that one blob.
async function getUsageCachedFor(acc, force) {
  if (!acc) return null;
  const cache = readCacheFile();
  const cached = (cache.usageByAccount || {})[acc.id];
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
  try {
    const data = await fetchUsageFor(acc);
    // Re-read at write time: a sibling slice (pool, another account) in the same
    // --refresh worker may have been written during our await. Spreading the
    // start-of-call snapshot would clobber it.
    const fresh = readCacheFile();
    writeCacheFile({
      ...fresh,
      usageByAccount: { ...(fresh.usageByAccount || {}), [acc.id]: { fetchedAt: Date.now(), data } },
      historyByAccount: {
        ...(fresh.historyByAccount || {}),
        [acc.id]: appendHistory((fresh.historyByAccount || {})[acc.id], data),
      },
    });
    return data;
  } catch (e) {
    // Endpoint is lightly rate-limited (429s under repeated --force refreshes). Fall
    // back to the last known-good data WITHOUT restamping fetchedAt: the age must stay
    // truthful. Restamping it to now made a failed refresh look like a fresh success —
    // peek showed "0s ago" and the statusline a current-looking number over stale
    // data. Leaving the slice untouched keeps its real age (so "5m ago" shows), and
    // the next render still sees it as stale and retries, so the numbers self-heal the
    // moment the limit clears. (The gateway path already fails this way.)
    if (cached) return cached.data;
    throw e;
  }
}

// --- Pool-DB metrics (optional; only when arc-config has poolDb.neonUrl) ---

function poolConfigured() {
  return !!(cfg && cfg.poolDb && cfg.poolDb.neonUrl);
}

function fetchPool() {
  return new Promise((resolve, reject) => {
    const queryScript = path.join(C.SCRIPTS_DIR, 'pool-query.js');
    const globalMods = require('child_process').execSync('npm root -g', { shell: true, windowsHide: true }).toString().trim();
    exec(
      `node "${queryScript}"`,
      { timeout: 10000, windowsHide: true, env: { ...process.env, NODE_PATH: globalMods } },
      (err, stdout, stderr) => {
        if (!stdout && err) return reject(new Error(stderr || err.message));
        try { resolve(JSON.parse(stdout)); }
        catch (e) { reject(new Error('bad pool response: ' + stdout.slice(0, 80))); }
      }
    );
  });
}

async function getPoolCached() {
  const cache = readCacheFile();
  const cached = cache.pool;
  if (cached && Date.now() - cached.fetchedAt < POOL_CACHE_TTL_MS) return cached.rows;
  try {
    const rows = await fetchPool();
    writeCacheFile({ ...readCacheFile(), pool: { fetchedAt: Date.now(), rows } });
    return rows;
  } catch (e) {
    return cached ? cached.rows : null;
  }
}

// --- Instant cache reads + detached background refresh ---
// The statusline must paint NOW from whatever's cached, never block on a live
// fetch (the pool query alone can take seconds). A separate detached process
// refreshes the cache so the next tick is fresh.

function readCachedUsageFor(accId) {
  const c = (readCacheFile().usageByAccount || {})[accId];
  return { data: c ? c.data : null, fresh: c ? Date.now() - c.fetchedAt < CACHE_TTL_MS : false };
}
function readCachedPool() {
  const c = readCacheFile().pool;
  return { rows: c ? c.rows : null, fresh: c ? Date.now() - c.fetchedAt < POOL_CACHE_TTL_MS : false };
}

// --- Gateway (api) usage: each api account's own /v1/usage endpoint -----------
// Cached under cache.gwUsage[accountId]. resolveApiKey may DPAPI-decrypt (a
// PowerShell shell-out) — fine in the detached refresh child, never on the hot
// render path (renders only READ readCachedGwUsage).
async function getGwUsageCached(acc, force) {
  if (!GW.usageUrlFor(acc)) return null;
  const cached = (readCacheFile().gwUsage || {})[acc.id];
  if (!force && cached && Date.now() - cached.fetchedAt < GW_CACHE_TTL_MS) return cached.data;
  let key; try { key = C.resolveApiKey(acc); } catch { return cached ? cached.data : null; }
  const data = await GW.fetchGatewayUsage(acc, key);
  if (!data) return cached ? cached.data : null;
  const cur = readCacheFile();
  writeCacheFile({ ...cur, gwUsage: { ...(cur.gwUsage || {}), [acc.id]: { fetchedAt: Date.now(), data } } });
  return data;
}
function readCachedGwUsage(accId) {
  const e = (readCacheFile().gwUsage || {})[accId];
  return { data: e ? e.data : null, fresh: e ? Date.now() - e.fetchedAt < GW_CACHE_TTL_MS : false, fetchedAt: e ? e.fetchedAt : 0 };
}

// Fire a detached background refresh of any stale slices, then exit. Guarded by
// a short-lived lock file so concurrent statusline ticks don't all spawn one.
function triggerBackgroundRefresh(wantPool) {
  const lockPath = `${CACHE_PATH}.refresh.lock`;
  try {
    const st = fs.statSync(lockPath);
    if (Date.now() - st.mtimeMs < 15_000) return; // a refresh is already in flight
  } catch {}
  try { fs.writeFileSync(lockPath, String(Date.now())); } catch {}
  try {
    const child = spawn(process.execPath, [__filename, '--refresh', ...(wantPool ? ['--with-pool'] : [])], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true, // no flashing console window for the detached worker
      env: process.env,
    });
    child.unref();
  } catch {}
}

// Runs in the detached child: refresh caches, then release the lock.
async function runRefresh(wantPool, force) {
  const accts = (cfg && cfg.accounts) || [];
  const oauthAccts = accts.filter((a) => a.type === 'oauth');
  const apiAccts = accts.filter((a) => a.type === 'api' && GW.usageUrlFor(a));
  // allSettled, not all: one account's expired/absent token must not abort the
  // refresh of the others (each fetch already falls back to its own cached slice).
  // Fetching EVERY oauth account — not just the active one — is what keeps arc:peek
  // and auto-select honest, exactly as each gateway is already refreshed.
  await Promise.allSettled([
    ...oauthAccts.map((a) => getUsageCachedFor(a, force)),
    wantPool && poolConfigured() ? getPoolCached() : Promise.resolve(null),
    ...apiAccts.map((a) => getGwUsageCached(a, force)), // each gateway's own /v1/usage
  ]);
  // Forget accounts that no longer exist. Per-account slices otherwise accumulate
  // forever after a remove/rename, and a ghost's ancient timestamp would make
  // arc:peek's "is the cache fresh?" check age off an account nobody has.
  // Guarded on accts.length so an unreadable config can never empty the cache.
  try {
    if (accts.length) {
      const live = new Set(accts.map((a) => a.id));
      const cur = readCacheFile();
      const keep = (o) => Object.fromEntries(Object.entries(o || {}).filter(([id]) => live.has(id)));
      writeCacheFile({ ...cur, usageByAccount: keep(cur.usageByAccount), historyByAccount: keep(cur.historyByAccount), gwUsage: keep(cur.gwUsage) });
    }
  } catch {}
  try { fs.unlinkSync(`${CACHE_PATH}.refresh.lock`); } catch {}
}

// --- Claude Code statusline stdin ---
// Claude Code pipes a JSON blob to the statusline on stdin every render. It
// carries the live 5h/7d rate limits (oauth sessions, after the first API
// response), the session cost, and the context fill. Prefer these over polling.
function readStdinJson() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null); // manual run, no piped JSON
    let data = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try { resolve(data ? JSON.parse(data) : null); } catch { resolve(null); }
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, 250).unref(); // safety net if stdin never closes
  });
}

// Normalize Claude Code's stdin rate_limits into the same shape as our OAuth
// usage data. resets_at arrives as Unix epoch SECONDS here vs an ISO string
// from the API, so convert.
function usageFromStdin(sl) {
  const rl = sl && sl.rate_limits;
  if (!rl || !rl.five_hour || typeof rl.five_hour.used_percentage !== 'number') return null;
  const conv = (w) => (w && typeof w.used_percentage === 'number')
    ? { utilization: w.used_percentage, resets_at: w.resets_at != null ? new Date(w.resets_at * 1000).toISOString() : null }
    : { utilization: 0, resets_at: null };
  return { five_hour: conv(rl.five_hour), seven_day: conv(rl.seven_day) };
}

// Bridge ARC_SESSION (arc's per-terminal id) -> CLAUDE_CODE_SESSION_ID (the real
// session id, even for a picker-resumed one) so the arc wrapper can find, re-resume
// and preserve THIS session across an account switch.
function writeActiveConv() {
  const arc = process.env.ARC_SESSION, conv = process.env.CLAUDE_CODE_SESSION_ID;
  if (!arc || !conv) return;
  const p = path.join(C.CACHE_DIR, `arc-active-${arc}.json`);
  try {
    let cur = null; try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    if (cur && cur.convId === conv) return; // unchanged
    fs.writeFileSync(p, JSON.stringify({ convId: conv }));
  } catch {}
}

// Spinner frame derived from wall-clock so successive ticks visibly advance.
function spinnerFrame() {
  const frames = ['.  ', '.. ', '...'];
  return frames[Math.floor(Date.now() / 500) % frames.length];
}

// ---- colors -------------------------------------------------------------------

const SUPPORTS_TRUECOLOR = (() => {
  const ct = (process.env.COLORTERM || '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit')) return true;
  if (process.env.WT_SESSION) return true; // Windows Terminal
  return false;
})();

// Colorize with a config hex color: truecolor when available, else the nearest
// 256-color cube index so labels still read colored, not unstyled.
function hexColor(s, hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `\x1b[1m${s}\x1b[0m`;
  const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
  if (SUPPORTS_TRUECOLOR) return `\x1b[38;2;${r};${g};${b};1m${s}\x1b[0m`;
  const idx = 16 + 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51);
  return `\x1b[38;5;${idx};1m${s}\x1b[0m`;
}
const label = (acc) => hexColor(acc.label, acc.color);

// Attention-grabbing warning: red background, foreground pulses white<->yellow
// each ~600ms (visible "blink" on re-render) + SGR-5 for terminals honoring it.
function blinkAlert(text) {
  const on = Math.floor(Date.now() / 600) % 2 === 0;
  const fg = on ? 97 : 93; // bright white / bright yellow
  return `\x1b[5;1;${fg};41m ${text} \x1b[0m`;
}

// Critical dead-end alert (both-exhausted): bold WHITE text on a coral background
// that pulses between two shades so it blinks even where SGR-5 is ignored.
function criticalAlert(text) {
  const on = Math.floor(Date.now() / 600) % 2 === 0;
  if (SUPPORTS_TRUECOLOR) {
    const bg = on ? '48;2;252;125;93' : '48;2;224;103;71';
    return `\x1b[5;1;38;2;255;255;255;${bg}m ${text} \x1b[0m`;
  }
  const bg = on ? '48;5;209' : '48;5;173';
  return `\x1b[5;1;97;${bg}m ${text} \x1b[0m`;
}

// Static amber — a gentle heads-up (used for the slow weekly limit) that doesn't
// blink, so it can sit on screen for a long time without becoming annoying.
function amber(s) {
  return `\x1b[33m${s}\x1b[0m`;
}

function renderPoolAccounts(rows) {
  return rows.map((r) => {
    const name = (r.label || r.email || '?').split('@')[0].slice(0, 5);
    const fh = r.fh != null ? `${Math.round(r.fh)}%` : '?';
    const sd = r.sd != null ? `${Math.round(r.sd)}%` : '?';
    const tag = r.status !== 'active' ? ` [${r.status}]` : r.reason_code === 'rate_limited' ? ' [cooldown]' : '';
    return `${name} ${fh}/${sd}${tag}`;
  }).join(' | ');
}

// A pool account is usable only if it's active AND not in rate-limit cooldown.
// "Exhausted" = we have rows and none are usable. Require length>0 so a transient
// empty/failed pool query never raises a false dead-end alarm.
function poolExhausted(rows) {
  return Array.isArray(rows) && rows.length > 0 &&
    rows.every((r) => !(r.status === 'active' && r.reason_code !== 'rate_limited'));
}

// The dead-end: on the pool, every pool account is in cooldown. If the oauth
// subscription is also exhausted there's nothing to do but wait for its reset;
// otherwise the escape is a manual arc:switch back. `data` = cached oauth usage.
function bothExhaustedAlert(data) {
  const sub = primaryOauth();
  const subLabel = sub ? sub.label : 'subscription';
  const subExhausted = !data ||
    data.five_hour.utilization >= SWITCH_SESSION ||
    (data.seven_day && data.seven_day.utilization >= SWITCH_WEEK);
  if (subExhausted) {
    const rt = data && (formatResetTime(data.five_hour.resets_at) || formatResetTime(data.seven_day.resets_at));
    const reset = rt ? ` — ${subLabel} resets @ ${rt}` : '';
    return criticalAlert(`⛔ POOL + ${subLabel} both exhausted${reset}`);
  }
  const mx = Math.round(data.five_hour.utilization);
  return criticalAlert(`⛔ POOL exhausted — arc:switch back to ${subLabel} (${mx}%)`);
}

// Projects minutes-to-limit from the observed rate of change of `key` over
// the lookback window.
function computeEtaMinutes(history, key, currentValue) {
  if (!history || history.length < 2) return null;
  const now = Date.now();
  const inWindow = history.filter((h) => now - h.t <= ETA_LOOKBACK_MS);
  if (inWindow.length < 2) return null;
  const oldest = inWindow[0];
  const span = now - oldest.t;
  if (span < ETA_MIN_SPAN_MS) return null;
  const ratePerMinute = (currentValue - oldest[key]) / (span / 60000);
  if (ratePerMinute <= 0.0001) return null;
  const remaining = 100 - currentValue;
  if (remaining <= 0) return 0;
  return remaining / ratePerMinute;
}

function formatEta(minutes) {
  if (minutes == null) return null;
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `~${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `~${h}h${m}m` : `~${h}h`;
}

// Format a reset time. Returns null when there's no valid time — the OAuth usage
// endpoint reports resets_at:null for a window with no activity yet (e.g. the
// 5-hour subscription window while you've been running on the pool). Callers
// must handle null instead of printing a bogus 1970 epoch time.
function formatResetTime(iso) {
  if (iso == null) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const opts = d.getMinutes() === 0 ? { hour: 'numeric' } : { hour: 'numeric', minute: '2-digit' };
  const timePart = d.toLocaleTimeString(undefined, opts).toLowerCase().replace(' ', '');
  if (d.toDateString() === now.toDateString()) return timePart;
  const datePart = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${datePart}, ${timePart}`;
}

// Which window's reset to show on a near/over-limit alert. When the WEEKLY cap is
// the one over its switch threshold, it is the real blocker (days away) — show its
// reset so you know a switch is worth it. Otherwise the short 5-hour window is what
// clears you (often minutes away) — show that, so you can judge whether to bother
// switching at all. Falls back to the other window when one has no reset time.
function bindingResetLabel(s, w, switchWeek) {
  const weekOver = w.utilization >= switchWeek;
  return weekOver
    ? (formatResetTime(w.resets_at) || formatResetTime(s.resets_at))
    : (formatResetTime(s.resets_at) || formatResetTime(w.resets_at));
}

function bar(pct, width = 40) {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return '#'.repeat(filled) + '-'.repeat(width - filled);
}

// Model + reasoning effort (from stdin model.display_name + effort.level). Effort
// is omitted when the model doesn't support it. Dim so it sits quietly at the end.
function formatModel(model, effort) {
  if (!model) return null;
  const lbl = effort ? `${model} ${effort}` : model;
  return `\x1b[2m${lbl}\x1b[0m`;
}

// Locate a session's transcript by id across project dirs.
function findTranscriptById(id) {
  const proj = path.join(C.CLAUDE_DIR, 'projects');
  try {
    for (const d of fs.readdirSync(proj)) {
      if (d === '.trash') continue;
      const fp = path.join(proj, d, id + '.jsonl');
      if (fs.existsSync(fp)) return fp;
    }
  } catch {}
  return null;
}

const EFFORT_OK = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'auto']);
const EFFORT_INITIAL_TAIL = 2_000_000; // bound the first scan of a long/resumed session

// Incrementally + STICKILY track this session's effort in arc-effort-<sid>.json
// { effort, offset }. Each render scans ONLY the new transcript bytes since last
// time for the genuine /effort echo and remembers the value. This never loses the
// setting to a fixed-window truncation. arc-runner SEEDS this file at each launch,
// so a launch with no echo line (e.g. right after an arc:switch) is still known.
function trackEffort() {
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) return null;
  const fp = findTranscriptById(sid);
  if (!fp) return null;
  const stateFile = path.join(C.CACHE_DIR, `arc-effort-${sid}.json`);
  let st = {};
  try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  let size = 0;
  try { size = fs.statSync(fp).size; } catch { return st.effort || null; }
  let offset = (typeof st.offset === 'number' && st.offset >= 0 && st.offset <= size)
    ? st.offset
    : Math.max(0, size - EFFORT_INITIAL_TAIL);
  let effort = st.effort || null;
  if (size > offset) {
    try {
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        const cc = e.message && e.message.content;
        const t = typeof cc === 'string' ? cc : Array.isArray(cc) ? cc.map((x) => (x && x.text) || '').join(' ') : '';
        // Anchor to the genuine /effort echo (Claude Code wraps it) so ordinary
        // chat mentioning "set effort level to X" isn't misread as the setting.
        const m = t.match(/<local-command-stdout>\s*Set effort level to (\w+)/i);
        if (m && EFFORT_OK.has(m[1].toLowerCase())) effort = m[1].toLowerCase();
      }
    } catch {}
  }
  try { fs.writeFileSync(stateFile, JSON.stringify({ effort, offset: size })); } catch {}
  return effort;
}

// Display effort: stdin is authoritative for the level, except ultracode which it
// collapses to 'xhigh' — use the sticky tracked value to reveal it.
function resolveEffort(stdinEffort) {
  const tracked = trackEffort();
  if (stdinEffort !== 'xhigh') return stdinEffort;
  return tracked === 'ultracode' ? 'ultracode' : 'xhigh';
}

// ---- renderers -----------------------------------------------------------------

function renderFull(data, sessionEta, weekEta, poolRows, acc, model, effort) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const sEta = formatEta(sessionEta);
  const wEta = formatEta(weekEta);
  const isApi = acc && acc.type === 'api';
  const footer = (lines) => {
    if (model) lines.push('', `Model: ${model}${effort ? ` (${effort})` : ''}`);
  };

  if (!acc) return `arc: no config — run \`arc setup\``;

  // API account with pool metrics
  if (isApi && poolConfigured()) {
    if (!poolRows) return `Account: ${acc.label}\n\nconnecting to pool${spinnerFrame()}`;
    const lines = [`Account: ${label(acc)}`];
    if (poolExhausted(poolRows)) lines.push('', bothExhaustedAlert(data));
    lines.push(
      '',
      'Pool accounts',
      ...poolRows.map((r) => {
        const name = (r.label || r.email || '?').split('@')[0].slice(0, 5);
        const fh = r.fh != null ? `${Math.round(r.fh)}%` : '?';
        const sd = r.sd != null ? `${Math.round(r.sd)}%` : '?';
        const tag = r.status !== 'active' ? ` [${r.status}]` : r.reason_code === 'rate_limited' ? ' [cooldown]' : '';
        return `  ${name}  session ${fh} | week ${sd}${tag}`;
      }),
    );
    footer(lines);
    return lines.join('\n');
  }

  // API gateway account: show its own usage endpoint (e.g. MATE /v1/usage).
  if (isApi) {
    const lines = [`Account: ${label(acc)}`];
    try {
      const gw = readCachedGwUsage(acc.id);
      if (gw.data) {
        const s = GW.summarizeGatewayUsage(gw.data);
        lines.push('', GW.gatewayUsageLine(gw.data, { withReq: true }) || '(usage)');
        if (s && s.models.length) {
          lines.push('', 'By model (today)', ...s.models.slice(0, 6).map((m) =>
            `  ${String(m.model || '?').replace(/^claude-/, '').slice(0, 16).padEnd(16)} ${GW.fmtTokens(m.tokens)} tok${m.cost != null ? ` · ${GW.fmtCost(m.cost, s.unit)}` : ''}`));
        }
        if (s && s.plan) lines.push('', `plan: ${s.plan}`);
      } else {
        lines.push('', 'API gateway account (no usage data yet)');
      }
    } catch { lines.push('', 'API gateway account (usage unavailable)'); }
    footer(lines);
    return lines.join('\n');
  }

  // oauth account: usage bars
  if (!data) return `Account: ${acc.label}\n\nloading usage${spinnerFrame()}`;
  const session = data.five_hour;
  const week = data.seven_day;
  const over = session.utilization >= SWITCH_SESSION || week.utilization >= SWITCH_WEEK;
  const nearSession = session.utilization >= WARN_SESSION && session.utilization < SWITCH_SESSION;
  const target = switchTargetLabel(acc.id);
  const lines = [`Account: ${label(acc)}`];
  if ((over || nearSession) && target) {
    lines.push('', blinkAlert(over ? `⚠ ${acc.label} limit reached — arc:switch to ${target} now` : `⚠ Nearing ${acc.label} limit — arc:switch to ${target}`));
  }
  const sReset = formatResetTime(session.resets_at);
  const wReset = formatResetTime(week.resets_at);
  lines.push(
    '',
    'Current session',
    `  ${bar(session.utilization)} ${Math.round(session.utilization)}% used`,
    sReset ? `  Resets ${sReset} (${tz})${sEta ? `, ${sEta} to limit at current pace` : ''}` : `  No active 5-hour window yet`,
    '',
    'Current week (all models)',
    `  ${bar(week.utilization)} ${Math.round(week.utilization)}% used`,
    wReset ? `  Resets ${wReset} (${tz})${wEta ? `, ${wEta} to limit at current pace` : ''}` : `  No active weekly window`,
  );
  footer(lines);
  return lines.join('\n');
}

// The AMBIENT board surface: "📌 2 from research". Derived arithmetic (ledger
// length − this role's cursor), so it cannot lie and clears itself the moment the
// notes are read. Nothing has to remember to tell you.
function boardSeg(f) {
  if (!f) return '';
  // Holding NO role means you receive nothing — so say it loudly rather than showing an
  // empty statusline while notes quietly pile up in the board.
  if (f.noRole) return `\x1b[1;91m⚠ ${f.count} notes · no role — arc:role <name>\x1b[0m`;
  // DEAF: you hold a role but never armed a listener, so every peer addressing you is talking to
  // an empty chair. The usual cause is an arming turn that could not run — a rate-limited account
  // still CLAIMS for free (the claim is handled in-hook, zero tokens) and then cannot take the
  // turn that arms, so the session SQUATS the role in silence. Loud, because nothing else would
  // ever tell you. (Raised by the scout peer: "the statusline already knows both facts".)
  // NB the hint is aimed at the USER, and it must not tell them to run `arc join` themselves: a
  // listener started outside the session cannot wake it (only a background command the SESSION
  // launched re-invokes the agent), so it would look fixed while staying deaf. Only the agent can
  // arm — so ask the agent.
  const deaf = f.deaf ? `\x1b[1;91m⚠ ${f.role} · DEAF (tell me to re-arm)\x1b[0m` : '';
  if (!f.count) return deaf;
  const notes = `\x1b[1;93m📌 ${f.count} from ${f.senders.join(', ')}\x1b[0m`;
  return deaf ? `${deaf} ${notes}` : notes;
}

// The initiative dial (arc:mode). The circle FILLS as the agent gets more proactive:
// ○ passive (dim) → ◐ balanced (cyan) → ● active (green). Always shown, so the dial stays
// discoverable even when you have never touched it.
//
// The DEFAULT is `balanced`, not passive — see arc-stance.DEFAULT. (This comment claimed passive
// was the default long after that stopped being true, and the fallback below acted on it.)
//
// DELIBERATE, do not "fix": passive renders DIM even though it is a deviation, which is the
// opposite of the injected directive's rule (only a deviation speaks). Weighed and kept on the
// user's call — the dial is a persistent ambient readout, not a per-turn announcement, and a bar
// that changes colour under you is worse than one you have to look at. Note the trade: a stance
// set by a SENTINEL lands with no re-render (a blocked prompt is not a turn), so the bar can lag
// until the next real turn.
function stanceSeg(stance) {
  if (stance === 'active') return '\x1b[1;92m● active\x1b[0m';
  if (stance === 'balanced') return '\x1b[1;96m◐ balanced\x1b[0m';
  return '\x1b[2m○ passive\x1b[0m';
}

function renderCompact(data, sessionEta, poolRows, acc, model, effort, board, stance) {
  // Two-row layout: line 1 = accounts/usage (switching-critical), line 2 = this
  // session's stats (model/effort · stance · unread notes). Loading/alert states stay single line.
  const line2 = [formatModel(model, effort), stanceSeg(stance), boardSeg(board)].filter(Boolean).join(' | ');
  const withL2 = (line1) => (line2 ? `${line1}\n${line2}` : line1);

  if (!acc) return 'arc: run `arc setup`';
  const isApi = acc.type === 'api';

  if (isApi) {
    const sub = primaryOauth();
    // Secondary segment: the subscription's usage — that's what frees up next.
    // The OAuth endpoint is account-wide, so it reports the subscription's real
    // numbers even though this session runs against the gateway. While you've been
    // on the pool the 5h window is usually 0/null (no recent sub activity), so
    // prefer whichever reset actually exists (5h, else the always-populated 7d)
    // and drop the "(reset …)" clause entirely when neither is valid.
    let subPart = '';
    if (sub && data) {
      const fh = Math.round(data.five_hour.utilization);
      const sd = Math.round(data.seven_day.utilization);
      const reset = formatResetTime(data.five_hour.resets_at) || formatResetTime(data.seven_day.resets_at);
      const resetPart = reset ? ` (resets ${reset})` : '';
      subPart = ` | ${hexColor(`${sub.label} ${fh}%/${sd}%${resetPart}`, sub.color)}`;
    }
    if (poolConfigured()) {
      if (!poolRows) return `${label(acc)} connecting${spinnerFrame()}`;
      if (poolExhausted(poolRows)) return bothExhaustedAlert(data);
      return withL2(`${label(acc)} ${renderPoolAccounts(poolRows)}${subPart}`);
    }
    // Gateway account's own usage (e.g. MATE /v1/usage), from cache. Guarded so a
    // weird payload can never break the statusline (falls back to the plain label).
    let gwPart = '';
    try { const gw = readCachedGwUsage(acc.id); const l = gw.data ? GW.gatewayUsageLine(gw.data) : null; gwPart = l ? ` ${l}` : ''; } catch {}
    return withL2(`${label(acc)}${gwPart}${subPart}`);
  }

  // oauth account
  if (!data) return `${label(acc)} loading${spinnerFrame()}`;
  const s = data.five_hour;
  const w = data.seven_day;
  const sv = Math.round(s.utilization);
  const wv = Math.round(w.utilization);

  const over = s.utilization >= SWITCH_SESSION || w.utilization >= SWITCH_WEEK;
  const nearSession = s.utilization >= WARN_SESSION && s.utilization < SWITCH_SESSION;
  const target = switchTargetLabel(acc.id);
  if ((over || nearSession) && target) {
    const lbl = over ? 'limit reached' : 'nearing limit';
    // Show WHEN the binding limit resets — a near-limit account may clear in a minute
    // (5h window) or be stuck for days (weekly cap). See bindingResetLabel.
    const bindReset = bindingResetLabel(s, w, SWITCH_WEEK);
    const resetPart = bindReset ? ` (resets ${bindReset})` : '';
    return withL2(blinkAlert(`⚠ ${acc.label} ${sv}%/${wv}% ${lbl}${resetPart} — arc:switch to ${target}`));
  }

  const sEta = formatEta(sessionEta);
  const sEtaPart = sEta ? `, ${sEta} to limit` : '';
  const weekStr = w.utilization >= WARN_WEEK ? amber(`${wv}%`) : `${wv}%`;
  // 5h reset may be null (no activity yet) — fall back to the 7d reset, and drop
  // the parenthetical entirely if neither exists, rather than print a 1970 time.
  const oReset = formatResetTime(s.resets_at) || formatResetTime(w.resets_at);
  const oResetPart = oReset ? ` (resets ${oReset}${sEtaPart})` : '';
  return withL2(`${label(acc)} ${sv}%/${weekStr}${oResetPart}`);
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live') || args.includes('-l');
  const compact = args.includes('--compact') || args.includes('-c');
  const refresh = args.includes('--refresh');

  // Detached refresh worker: repopulate caches, then exit. `--force` bypasses the
  // per-slice TTLs (used by arc:peek, which must show truly current data).
  if (refresh) {
    await runRefresh(args.includes('--with-pool') || args.includes('--apihub'), args.includes('--force')); // --apihub = legacy spelling
    return;
  }

  const acc = activeAccount();
  const isApi = acc && acc.type === 'api';

  if (live) {
    const intervalMs = 30_000;
    for (;;) {
      try {
        const [data, poolRows] = await Promise.all([
          fetchUsageFor(subscriptionAccount()),
          isApi && poolConfigured() ? getPoolCached() : Promise.resolve(null),
        ]);
        const history = (readCacheFile().historyByAccount || {})[(subscriptionAccount() || {}).id] || [];
        const sessionEta = computeEtaMinutes(history, 'session', data.five_hour.utilization);
        const weekEta = computeEtaMinutes(history, 'week', data.seven_day.utilization);
        process.stdout.write('\x1Bc'); // clear screen
        console.log(renderFull(data, sessionEta, weekEta, poolRows, acc));
        console.log(`\n(refreshing every ${intervalMs / 1000}s - Ctrl+C to stop)`);
      } catch (e) {
        console.error('Error fetching usage:', e.message);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  // Statusline path: paint INSTANTLY from stdin + caches; refresh detached.
  const sl = await readStdinJson();
  const model = sl && sl.model ? sl.model.display_name : undefined;
  const effort = resolveEffort(sl && sl.effort ? sl.effort.level : undefined); // xhigh->ultracode via transcript
  writeActiveConv(); // bridge cl<->claude session id so `arc` can preserve this session on switch
  const stdinUsage = usageFromStdin(sl);

  // Read the slice belonging to the account whose numbers we're showing — never a
  // slice that some other account happened to populate.
  const subAcc = subscriptionAccount();
  const usage = readCachedUsageFor(subAcc && subAcc.id);
  const usageData = stdinUsage || usage.data; // stdin is fresher/more accurate
  const pool = isApi && poolConfigured() ? readCachedPool() : { rows: null, fresh: true };

  // Dry-run hook: force the "both exhausted" alert for visual verification.
  if (fs.existsSync(BOTH_EXHAUSTED_TEST)) {
    const fake = { five_hour: { utilization: 100, resets_at: usageData && usageData.five_hour.resets_at }, seven_day: { utilization: 100 } };
    process.stdout.write(bothExhaustedAlert(fake));
    return;
  }

  // Keep the background refresh running (it maintains the ETA history and the
  // api-mode subscription numbers) whenever the cache is stale.
  // Refresh when the subscription usage is stale OR any gateway account's usage is
  // stale (kept fresh even while on the subscription, so arc:peek isn't stale).
  const anyGwStale = ((cfg && cfg.accounts) || []).some((a) => a.type === 'api' && GW.usageUrlFor(a) && !readCachedGwUsage(a.id).fresh);
  const needRefresh = !usage.fresh || (isApi && poolConfigured() && !pool.fresh) || anyGwStale;
  if (needRefresh) triggerBackgroundRefresh(isApi);

  // This account's OWN series — a shared one interleaved both accounts' utilization
  // and produced a nonsense trend (and ETA) across a switch.
  const history = (readCacheFile().historyByAccount || {})[subAcc && subAcc.id] || [];
  const sessionEta = usageData ? computeEtaMinutes(history, 'session', usageData.five_hour.utilization) : null;
  const weekEta = usageData ? computeEtaMinutes(history, 'week', usageData.seven_day.utilization) : null;

  // Unread sticky notes from this session's peers. Cheap (one stat when there's
  // no role) and best-effort — the statusline must never fail because of the board.
  let board = null;
  try {
    board = require('./arc-notes').badge(
      process.env.ARC_SESSION, sl && sl.workspace ? sl.workspace.current_dir : null);
  } catch {}
  // Fall back to the DEFAULT the stance module actually declares — never a hardcoded guess.
  // This said 'passive' from back when passive WAS the default, so after the default moved to
  // balanced a statusline that couldn't read the stance would report you RESTRICTED while the
  // agent happily ran balanced. A dial that lies about which way it points is worse than no dial.
  let stance = require('./arc-stance').DEFAULT;
  try { stance = require('./arc-stance').getStance(process.env.ARC_SESSION); } catch {}

  process.stdout.write(
    compact
      ? renderCompact(usageData, sessionEta, pool.rows, acc, model, effort, board, stance)
      : renderFull(usageData, sessionEta, weekEta, pool.rows, acc, model, effort)
  );
}

// Run as a script (statusline, --refresh worker, --live); stay silent when merely
// require()'d for its pure helpers in tests.
if (require.main === module) main();

module.exports = { bindingResetLabel, formatResetTime };
