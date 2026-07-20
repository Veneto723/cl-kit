// arc-switch-core: the shared validate + drop-trigger logic for switching/
// restarting an arc session. Entry point:
//   - arc-switch-hook.js  (a UserPromptSubmit hook catching the zero-token
//                          /arc-<verb> slash commands — classifier-immune,
//                          works even when the account is rate-limited)
// (The old arc-signal.js / /switch / /restart slash-command path was removed;
// the UserPromptSubmit hook is now the single way in.)
//
// Keeping the logic in one module means there's one definition of what a valid
// switch is and where the trigger file goes.
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');

// ISO timestamp → "MM-DD HH:MM" (local) for compact trash-list display.
function shortStamp(iso) {
  try {
    const d = new Date(iso); if (isNaN(d)) return '?';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return '?'; }
}

// Resolve this session's CURRENT account from its state file (fallback: default).
function currentAccount(C, cfg, session) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `arc-state-${session}.json`), 'utf8'));
    const acc = C.findAccount(cfg, st.account);
    if (acc) return acc.id;
  } catch {}
  return cfg.defaultAccount;
}


// Count LIVE arc sessions currently pinned to `accountId` (an arc-state file says so
// AND its pid is alive). Removing an account doesn't kill sessions using it — they
// keep working and drop to the default on their next relaunch — so we warn first.
function liveSessionsOn(accountId) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!/^arc-state-.*\.json$/.test(f)) continue;
      let st; try { st = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8')); } catch { continue; }
      if (st.account !== accountId || !st.pid) continue;
      try { process.kill(st.pid, 0); n++; } catch (e) { if (e.code === 'EPERM') n++; } // EPERM = alive, not ours
    }
  } catch {}
  return n;
}

// ---- usage peek + shared launch-account decision ---------------------------
// These back BOTH the launch-time auto-select (arc-runner) and the `/arc-peek`
// readout, so the "would launch on X" line always matches what actually happens.

function readUsageCache() {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'usage-monitor-cache.json'), 'utf8')); }
  catch { return null; }
}

// Roadmap #10: the usage payload's limits[] carries what the top-line 5h/7d numbers
// cannot — PER-MODEL weeklies and a server-authoritative severity. Field map measured
// live (research board #257, CORRECTED by #264): per-model data lives ONLY in
// limits[] entries with kind:"weekly_scoped" + scope.model.display_name — the
// top-level seven_day_opus/seven_day_sonnet fields are NULL on subscription accounts,
// and `percent` is a whole-number percent. Defensive throughout: absent or malformed
// limits[] returns [] and the caller renders exactly as before this existed.
function scopedLimits(data) {
  const out = [];
  const ls = data && Array.isArray(data.limits) ? data.limits : [];
  for (const l of ls) {
    if (!l || typeof l !== 'object' || l.kind !== 'weekly_scoped') continue;
    const model = l.scope && l.scope.model && l.scope.model.display_name;
    if (!model) continue;
    out.push({
      label: `7d · ${model}`,
      percent: typeof l.percent === 'number' ? l.percent : null,
      severity: typeof l.severity === 'string' ? l.severity : null,
      resets_at: l.resets_at || null,
    });
  }
  return out;
}
// Severity → glyph, display only. Escalated values were never OBSERVED (research #264
// inferred the escalation from the field's presence), so nothing here wires color
// semantics to guesses: any non-normal value renders ⚠, with ⛔ reserved for the one
// name whose meaning is unambiguous. Unknown strings are treated as warnings — a
// server saying anything other than "normal" deserves a glance, whatever the word.
function sevGlyph(s) {
  if (!s || s === 'normal') return '';
  return s === 'critical' ? ' ⛔' : ' ⚠';
}

// /arc-peek is an explicit "show me current usage" — it must NOT show stale data.
// Unlike the statusline (which paints instantly and refreshes DETACHED for next
// time), peek SYNCHRONOUSLY refreshes the cache first (subscription + gateways),
// bounded so it never hangs, and skips the fetch when the cache is already fresh.
// On timeout/failure it falls back to whatever's cached (still shown with its age).
function refreshUsageForPeek(cfg) {
  if (process.env.ARC_PEEK_NO_REFRESH === '1') return; // opt out → instant, cache-only peek
  const PEEK_FRESH_MS = 15_000; // a re-peek within 15s reuses the cache, no refetch
  try {
    const cache = readUsageCache();
    const now = Date.now();
    const accts = (cfg && cfg.accounts) || [];
    // Age only the slices of accounts that STILL EXIST. The cache keeps entries for
    // removed accounts, and one of those (forever old) would otherwise make every
    // peek look stale and refetch.
    const ageOf = (slice) => (slice && slice.fetchedAt ? now - slice.fetchedAt : Infinity);
    const oldest = (ages) => (ages.length ? Math.max(...ages) : 0); // nothing to age = fresh
    const oldestSub = oldest(accts.filter((a) => a.type === 'oauth')
      .map((a) => ageOf(cache && cache.usageByAccount && cache.usageByAccount[a.id])));
    const oldestGw = oldest(accts.filter((a) => a.type === 'api')
      .map((a) => ageOf(cache && cache.gwUsage && cache.gwUsage[a.id])));
    if (oldestSub < PEEK_FRESH_MS && oldestGw < PEEK_FRESH_MS) return; // already fresh
    const mon = path.join(__dirname, 'usage-monitor.js');
    // --force bypasses the per-slice TTLs: a 3-min-old gateway value is "fresh" to
    // the normal refresh (5-min TTL), but peek must show CURRENT data.
    execFileSync(process.execPath, [mon, '--refresh', '--force'], { timeout: 10_000, stdio: 'ignore', windowsHide: true });
  } catch { /* refresh timed out / failed — fall back to cached data */ }
}

// A bounded, FORCED refresh of every account's usage. Called the moment the account
// changes (/arc-switch / the picker), when the caches still hold the old account's
// numbers. A switch already kills and relaunches claude — a visible pause — so
// spending ~a second here buys a first statusline render that is both correctly
// attributed and fresh, instead of the new account's label over the old one's data.
// The refresh worker fetches EVERY oauth account, so it does not depend on the
// session state file having been rewritten first. Bounded; never throws.
function refreshUsageNow(timeoutMs) {
  try {
    const mon = path.join(__dirname, 'usage-monitor.js');
    execFileSync(process.execPath, [mon, '--refresh', '--force'],
      { timeout: timeoutMs || 6_000, stdio: 'ignore', windowsHide: true });
    return true;
  } catch { return false; } // slow network must never wedge a switch; the statusline catches up
}

// True when EVERY configured account that CAN report usage has a slice younger than
// `withinMs`. Ages only accounts that still exist (a removed account's ancient slice
// must not make the cache look forever stale). Used to decide whether a fresh launch
// needs a synchronous refresh before claude paints. No config / no accounts / no
// cache → false (nothing to trust yet), so the caller refreshes.
function usageCacheFresh(cfg, withinMs, cache) {
  cache = cache || readUsageCache(); // fixture-injectable for tests; disk by default
  if (!cache) return false;
  const accts = (cfg && cfg.accounts) || [];
  if (!accts.length) return false;
  const now = Date.now();
  const fresh = (slice) => !!(slice && slice.fetchedAt && (now - slice.fetchedAt) < withinMs);
  let GW = null; try { GW = require('./gw-usage'); } catch {}
  return accts.every((a) => {
    if (a.type === 'oauth') return fresh((cache.usageByAccount || {})[a.id]);
    if (a.type === 'api') {
      // A gateway with no usage endpoint never gets a slice — it can't be "stale",
      // so it must not hold the whole cache stale forever.
      if (!GW || !GW.usageUrlFor(a)) return true;
      return fresh((cache.gwUsage || {})[a.id]);
    }
    return true;
  });
}

// One oauth account's usage slice, by id. Subscription usage is cached per account
// (cache.usageByAccount[id]) because the endpoint reports whoever's token was used.
// The legacy un-keyed cache.usage records no owner, so it is only attributable when
// exactly ONE oauth account is configured; with two, trusting it hands one account's
// numbers to the other (which is precisely how every account came out "exhausted").
// `cfg` omitted → assume the single-account case, preserving the old behaviour.
function oauthUsageSlice(acc, cache, cfg) {
  if (!cache) return null;
  const keyed = cache.usageByAccount && cache.usageByAccount[acc.id];
  if (keyed) return keyed;
  const oauthCount = cfg ? (cfg.accounts || []).filter((a) => a.type === 'oauth').length : 1;
  return oauthCount <= 1 && cache.usage ? cache.usage : null;
}

// Headroom score for an account from the usage cache: higher = more free.
//   null = can't judge (no data)   ·   -1 = exhausted   ·   0..100 = % headroom
function accountHeadroom(acc, cache, th, cfg) {
  if (!cache) return null;
  const SW_S = (th && th.switchSessionPct) != null ? th.switchSessionPct : 92;
  const SW_W = (th && th.switchWeekPct) != null ? th.switchWeekPct : 95;
  if (acc.type === 'oauth') {
    const slice = oauthUsageSlice(acc, cache, cfg);
    const d = slice && slice.data;
    if (!d || !d.five_hour || typeof d.five_hour.utilization !== 'number') return null;
    const fh = d.five_hour.utilization;                   // seven_day may be absent in a partial cache
    const sd = d.seven_day && typeof d.seven_day.utilization === 'number' ? d.seven_day.utilization : 0;
    if (fh >= SW_S || sd >= SW_W) return -1;             // over a switch threshold = exhausted
    return 100 - fh;                                      // 5h is the binding short-term limit
  }
  // api (gateway) accounts carry no rate-limit metrics — null = "cannot judge",
  // which chooseLaunchAccount already ranks as assumed-available (optimistic by design).
  return null;
}

// Decide the launch account: PREFER a subscription (oauth) with headroom; when every
// subscription is exhausted, fall to an API gateway — OPTIMISTICALLY. A gateway is
// preferred over an exhausted sub even when its own metrics look busy (a gateway's limit
// is soft; a maxed sub is a hard wall). Only a config with NO gateway settles for the
// least-bad exhausted sub. Returns { id, reason } or null when nothing can be judged.
function chooseLaunchAccount(cfg, cache) {
  const C = require('./arc-config');
  const th = cfg.thresholds || {};
  const score = (a) => accountHeadroom(a, cache, th, cfg);
  const oauth = cfg.accounts.filter((a) => a.type === 'oauth').map((a) => ({ a, s: score(a) }));
  const oauthJudged = oauth.filter((x) => x.s != null);

  if (oauth.length && !oauthJudged.length) return null;   // subs exist but unjudged → don't guess

  const oauthRoom = oauthJudged.filter((x) => x.s >= 0).sort((x, y) => y.s - x.s);
  if (oauthRoom.length) return { id: oauthRoom[0].a.id, reason: 'subscription has headroom' };

  // Be OPTIMISTIC about gateways: once every subscription is exhausted, prefer a gateway.
  // A gateway's limit is soft where a subscription at 100% is a hard wall — and a gateway
  // carries no rate-limit metrics (headroom is always null = cannot judge), so it is
  // ASSUMED available. Multiple gateways tie: config order picks. Only a config with NO
  // gateway settles for the least-bad sub.
  const api = cfg.accounts.filter((a) => a.type === 'api');
  if (api.length) {
    const via = oauthJudged.length ? `${oauthJudged[0].a.label} exhausted → ` : '';
    return { id: api[0].id, reason: `${via}gateway (assumed available)` };
  }

  // No gateway configured — least-bad among the (exhausted) subscriptions.
  const lb = (oauthJudged[0] && oauthJudged[0].a) || C.findAccount(cfg, cfg.defaultAccount) || cfg.accounts[0];
  return { id: lb.id, reason: 'all subscriptions exhausted → least-bad' };
}

// Compact reset-time label, e.g. "Jul 12, 4pm". null on null/invalid.
function fmtReset(iso) {
  if (iso == null) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  let h = d.getHours(); const ap = h < 12 ? 'am' : 'pm'; h = h % 12 || 12;
  const mm = d.getMinutes(); const min = mm ? ':' + String(mm).padStart(2, '0') : '';
  return `${mon} ${d.getDate()}, ${h}${min}${ap}`;
}

function ageStr(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '?';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 0) return '?';
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

// Standalone, ZERO-TOKEN usage readout of ALL accounts (subscription + gateway),
// current account marked, plus what a fresh launch would auto-select. Read-only —
// the hook renders this directly (no trigger, no relaunch). Returns { ok, message }.
function buildPeek(session) {
  let C, cfg;
  try { C = require('./arc-config'); cfg = C.loadConfig(); }
  catch (e) { return { ok: false, message: `arc usage — config unreadable (${e.message}). Fix ~/.claude/arc-config.json or run \`arc setup\`.` }; }
  refreshUsageForPeek(cfg); // fire a fresh fetch first — peek must not show stale data
  const cache = readUsageCache();
  const current = session ? currentAccount(C, cfg, session) : null;
  const pct = (v) => (v == null ? '  ?' : String(Math.round(v)).padStart(3));
  const lines = ['arc usage — peek'];
  if (!cache) lines.push('  (no usage cache yet — the statusline populates it every few minutes; try again shortly)');

  for (const a of cfg.accounts) {
    // The CURRENT account is marked by COLOR, not an arrow suffix (human's call,
    // 2026-07-18): bold cyan — arc's neutral-highlight — on the account's lines.
    // Applied PER LINE (the host re-emits display rows across soft-wraps and drops
    // color mid-wrap — same reason clBlock paints per line). Everyone else plain.
    const tint = (s) => (a.id === current ? `\x1b[1;96m${s}\x1b[0m` : s);
    const label = a.label || a.id;
    if (a.type === 'oauth') {
      const slice = oauthUsageSlice(a, cache, cfg); // THIS account's numbers, not whoever refreshed last
      if (slice && slice.data && slice.data.five_hour) {
        const d = slice.data;
        const sd = d.seven_day || {};                    // partial cache may lack seven_day
        const reset = fmtReset(d.five_hour.resets_at) || fmtReset(sd.resets_at);
        const rp = reset ? `  (resets ${reset})` : '';
        lines.push(tint(`  ${label} [sub]   5h ${pct(d.five_hour.utilization).trim()}%  ·  7d ${pct(sd.utilization).trim()}%${rp}   ${ageStr(slice.fetchedAt)}`));
        // Roadmap #10 enrichment: ONE extra line, only when the payload carries
        // per-model weeklies — and only the facts the line above does not already
        // say. Guarded: enrichment must never break peek.
        try {
          const scoped = scopedLimits(d);
          if (scoped.length) {
            lines.push(tint(`      ${scoped.map((l) => `${l.label} ${l.percent == null ? '?' : Math.round(l.percent)}%${sevGlyph(l.severity)}`).join('  ·  ')}`));
          }
        } catch { /* never */ }
      } else {
        lines.push(tint(`  ${label} [sub]   (no usage data)`));
      }
    } else if (a.type === 'api') {
      const gw = cache && cache.gwUsage && cache.gwUsage[a.id];
      if (gw && gw.data) {
        // The gateway's OWN usage endpoint (e.g. MATE /v1/usage). Guarded — a hook
        // must never throw on a weird gateway payload (a throw = silent pass-through).
        try {
          const GW = require('./gw-usage');
          const s = GW.summarizeGatewayUsage(gw.data);
          lines.push(tint(`  ${label} [gw]    ${GW.gatewayUsageLine(gw.data, { withReq: true }) || '(usage)'}   ${ageStr(gw.fetchedAt)}`));
          for (const m of ((s && s.models) || []).slice(0, 4)) {
            lines.push(`      ${String(m.model || '?').replace(/^claude-/, '').slice(0, 12).padEnd(12)}  ${GW.fmtTokens(m.tokens)} tok${m.cost != null ? ` · ${GW.fmtCost(m.cost, s.unit)}` : ''}`);
          }
        } catch { lines.push(tint(`  ${label} [gw]    (usage unavailable)`)); }
      } else {
        lines.push(tint(`  ${label} [gw]    (no usage data yet)`));
      }
    } else {
      lines.push(tint(`  ${label} [${a.type}]`));
    }
  }

  // The account a fresh launch/resume would auto-select (same decision arc-runner
  // uses) — so peek doubles as "where's my headroom / where will arc start me".
  if (cfg.features && cfg.features.autoBest !== false && cfg.accounts.length > 1) {
    const pick = chooseLaunchAccount(cfg, cache);
    if (pick) {
      const pl = (C.findAccount(cfg, pick.id) || {}).label || pick.id;
      lines.push(`  → a new launch/resume auto-selects: ${pl} (${pick.reason})`);
    }
  }
  lines.push('  (read-only peek · no switch · zero model tokens · works when rate-limited)');
  return { ok: true, message: lines.join('\n') };
}

// Decide + (if valid) perform a switch signal. Returns { ok, switching, message }.
// switching=true only when a trigger was actually written. `menu:true` marks a
// picker listing (no switch happened — the user should choose). Never throws.
//
// `target` may be an account id/name OR a 1-based number from the menu. With no
// target: 1 account → refuse; 2 accounts → cycle to the other; 3+ → show the menu
// (can't sensibly auto-pick — this is the "hard to recall names" case).

// Numbered picker of all accounts, current marked. Numbers match resolveTarget.
function renderMenu(cfg, current, lead) {
  const rows = cfg.accounts.map((a, i) => {
    const mark = a.id === current ? '  ← current' : '';
    return `  ${i + 1}. ${a.id}${a.label && a.label !== a.id.toUpperCase() ? ` (${a.label})` : ''} [${a.type}]${mark}`;
  });
  return `${lead}\n${rows.join('\n')}\n` +
    `Pick by number or name: \`/arc-switch <n|name>\` — zero tokens, works even when rate-limited.`;
}

// Resolve a target token to an account: a 1-based menu number, or an id/name.
function resolveTarget(C, cfg, target) {
  if (/^\d+$/.test(target)) {
    const idx = parseInt(target, 10) - 1;
    return (idx >= 0 && idx < cfg.accounts.length) ? cfg.accounts[idx] : null;
  }
  return C.findAccount(cfg, target);
}

function requestSwitch(session, target) {
  if (!session) {
    return { ok: false, switching: false,
      message: 'NOT SWITCHING — this session is not running under the arc wrapper (launch with `arc` to use switching).' };
  }
  let C, cfg;
  try { C = require('./arc-config'); cfg = C.loadConfig(); }
  catch (e) {
    return { ok: false, switching: false,
      message: `NOT SWITCHING — arc config unreadable (${e.message}). Fix ~/.claude/arc-config.json or run \`arc setup\`.` };
  }

  const current = currentAccount(C, cfg, session);
  const ids = cfg.accounts.map((a) => a.id).join(', ');
  target = target ? String(target).trim() : null;

  // No explicit target: refuse (1) / cycle (below menuMin) / show the picker menu.
  // menuMin = min account count that triggers the numbered menu instead of a
  // blind cycle (arc-config features.switchMenuMin, default 3, floor 2).
  const menuMin = Math.max(2, (cfg.features && cfg.features.switchMenuMin) || 3);
  if (!target) {
    if (cfg.accounts.length < 2) {
      return { ok: false, switching: false,
        message: `NOT SWITCHING — only ONE account is configured (${ids}), so there is nothing to switch to. The session stays on "${current}". Add another with \`arc add-account <id>\`.` };
    }
    if (cfg.accounts.length >= menuMin) {
      return { ok: true, switching: false, menu: true,
        message: renderMenu(cfg, current, `SWITCH ACCOUNT — you're on "${current}". ${cfg.accounts.length} accounts configured:`) };
    }
    // below the menu threshold → cycle to the other
    const next = C.nextAccount(cfg, current, null);
    if (!next) return { ok: false, switching: false, message: `NOT SWITCHING — no other account to cycle to (current: "${current}").` };
    return writeSwitch(session, current, next);
  }

  // Explicit target (number or name).
  const acc = resolveTarget(C, cfg, target);
  if (!acc) {
    return { ok: false, switching: false, menu: true,
      message: renderMenu(cfg, current, `NOT SWITCHING — "${target}" is not a valid account number or name. Choose one:`) };
  }
  if (acc.id === current) {
    return { ok: false, switching: false,
      message: `NOT SWITCHING — this session is ALREADY on "${current}". Nothing happened.` };
  }
  return writeSwitch(session, current, acc);
}

// Write the switch trigger carrying the RESOLVED account id (so a menu number is
// already turned into an id before arc-runner sees it).
function writeSwitch(session, current, next) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `arc-switch-${session}.trigger`), JSON.stringify({ at: Date.now(), target: next.id }));
    return { ok: true, switching: true,
      message: `SWITCHING "${current}" → "${next.id}" (${next.label}) — the wrapper will relaunch this conversation on it momentarily.` };
  } catch (e) {
    return { ok: false, switching: false, message: `switch signal FAILED — ${e.message}` };
  }
}

// Drop a picker trigger → arc-runner opens the interactive arrow-key account
// picker (zero tokens). Refuses if <2 accounts. Returns { ok, picker, message }.
function requestPicker(session) {
  if (!session) {
    return { ok: false, picker: false, message: 'NOT SWITCHING — not running under the arc wrapper (launch with `arc`).' };
  }
  let C, cfg;
  try { C = require('./arc-config'); cfg = C.loadConfig(); }
  catch (e) { return { ok: false, picker: false, message: `NOT SWITCHING — arc config unreadable (${e.message}).` }; }
  if (cfg.accounts.length < 2) {
    return { ok: false, picker: false,
      message: `NOT SWITCHING — only ONE account is configured. Add another with \`arc add-account <id>\`.` };
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `arc-pick-${session}.trigger`), JSON.stringify({ at: Date.now() }));
    return { ok: true, picker: true, message: 'opening account picker — use ↑/↓ and Enter in the terminal…' };
  } catch (e) {
    return { ok: false, picker: false, message: `picker signal FAILED — ${e.message}` };
  }
}

// Drop a stance-picker trigger → arc-runner opens the ←/→ passive·balanced·active bar
// (zero tokens, then a --resume relaunch, exactly like the account picker).
function requestModePicker(session) {
  if (!session) return { ok: false, message: 'NOT PICKING — not running under the arc wrapper (launch with `arc`).' };
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `arc-mode-${session}.trigger`), JSON.stringify({ at: Date.now() }));
    return { ok: true, message: 'opening the stance picker — use ← / → and Enter in the terminal…' };
  } catch (e) {
    return { ok: false, message: `picker signal FAILED — ${e.message}` };
  }
}

// ---- add an api (gateway) account inline -------------------------------
// No browser / TTY needed (unlike an oauth subscription), so this runs right in
// the hook: verify the gateway, auto-detect its model names, DPAPI-encrypt the
// key (no plaintext on disk), write the account. Mirrors how `mate` was added.
function hasFlag(tokens, name) { return tokens.includes(`--${name}`); }
function flagVal(tokens, name) {
  const i = tokens.indexOf(`--${name}`);
  return (i !== -1 && tokens[i + 1] && !tokens[i + 1].startsWith('--')) ? tokens[i + 1] : null;
}
// All values for a REPEATABLE flag (e.g. --header X:Y --header A:B). Values are
// single tokens (no spaces) since the prompt is whitespace-split.
function flagVals(tokens, name) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === `--${name}` && tokens[i + 1] && !tokens[i + 1].startsWith('--')) { out.push(tokens[i + 1]); i++; }
  }
  return out;
}

// Get the key from --key (inline), --file <path> (regex/whole), else the clipboard.
function readAddKey(tokens) {
  const inline = flagVal(tokens, 'key');
  if (inline) return { key: inline.trim(), src: 'inline' };
  const file = flagVal(tokens, 'file');
  if (file) {
    try {
      const raw = fs.readFileSync(require('./arc-config').expandHome(file), 'utf8');
      const m = raw.match(/sk-[A-Za-z0-9-]+/);
      return { key: (m ? m[0] : raw.trim()), src: file };
    } catch (e) { return { key: '', src: file, error: e.message }; }
  }
  const out = require('./arc-platform').readClipboard();
  if (out == null) return { key: '', src: 'clipboard', error: `couldn't read the clipboard — ${require('./arc-platform').clipboardHint()}` };
  return { key: out.trim(), src: 'clipboard' };
}

// GET <base>/v1/models with the key → { ok, models[] } or { ok:false, error }.
function probeGatewayModels(baseUrl, key) {
  let out;
  try {
    // Send `anthropic-version` (like Claude Code does) so a dual Claude+GPT gateway
    // keyed to ONE universal key returns its CLAUDE models here, not GPT ones.
    // curl ships as curl.exe on Win10+.
    out = execFileSync('curl.exe', ['-sS', '-m', '20',
      '-H', `Authorization: Bearer ${key}`, '-H', 'anthropic-version: 2023-06-01',
      `${baseUrl.replace(/\/+$/, '')}/v1/models`],
      { encoding: 'utf8', windowsHide: true, timeout: 25000 });
  } catch (e) { return { ok: false, error: `could not reach ${baseUrl}/v1/models (${String(e.message).split('\n')[0]})` }; }
  let j; try { j = JSON.parse(out); } catch { return { ok: false, error: `/v1/models did not return JSON (got: ${out.slice(0, 120).replace(/\s+/g, ' ')})` }; }
  if (j && j.error) return { ok: false, error: `gateway rejected the key: ${JSON.stringify(j.error).slice(0, 160)}` };
  const arr = Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : null);
  if (!arr) return { ok: false, error: 'unexpected /v1/models response shape' };
  return { ok: true, models: arr.map((m) => m.id || m.name).filter(Boolean) };
}

// Pick the newest model in a family (e.g. opus → claude-opus-4-8). Version-aware:
// compares numeric version parts, treating an 8-digit group as a date tiebreak.
// Also matches a bare family alias ("opus") for gateways that name models that way.
function pickFamilyModel(models, family) {
  const cands = models.filter((m) => m === family || m === `claude-${family}` || m.startsWith(`claude-${family}-`));
  if (!cands.length) return null;
  const score = (m) => {
    const nums = (m.slice(`claude-${family}`.length).match(/\d+/g) || []).map(Number);
    let date = 0; const v = [];
    for (const n of nums) { if (n >= 20200000) date = n; else v.push(n); }
    return { v, date };
  };
  return cands.slice().sort((a, b) => {
    const sa = score(a), sb = score(b);
    for (let i = 0; i < Math.max(sa.v.length, sb.v.length); i++) { const d = (sb.v[i] || 0) - (sa.v[i] || 0); if (d) return d; }
    return sb.date - sa.date;
  })[0];
}

// Flag-driven api add (/arc-add-account <id> --api --url … / terminal). Thin wrapper
// that resolves the key from tokens, then delegates to addApiAccountResolved.
function addApiAccount(tokens, id) {
  const { key, src, error } = readAddKey(tokens);
  // --header Key:Value (repeatable) → custom headers. Delimiter required (values
  // are single tokens — no spaces); empty values are rejected in the resolver.
  const headers = {};
  for (const h of flagVals(tokens, 'header')) {
    const ci = h.indexOf(':');
    if (ci <= 0) return { ok: false, message: `--header must be "Key:Value" with no spaces (got "${h}").` };
    headers[h.slice(0, ci).trim()] = h.slice(ci + 1).trim();
  }
  // --model alias=model (repeatable) → pin/override a family's model.
  const modelOverrides = {};
  for (const m of flagVals(tokens, 'model')) {
    const eq = m.indexOf('=');
    if (eq <= 0) return { ok: false, message: `--model must be "alias=model" with no spaces (e.g. opus=claude-opus-4-6), got "${m}".` };
    modelOverrides[m.slice(0, eq).trim().toLowerCase()] = m.slice(eq + 1).trim();
  }
  // --env KEY=VALUE (repeatable) → harness accommodations this gateway needs (a foreign
  // model behind an Anthropic-shaped API may not support tool search, high concurrency, …).
  const envMap = {};
  for (const e of flagVals(tokens, 'env')) {
    const eq = e.indexOf('=');
    if (eq <= 0) return { ok: false, message: `--env must be "KEY=VALUE" with no spaces (e.g. ENABLE_TOOL_SEARCH=false), got "${e}".` };
    envMap[e.slice(0, eq).trim()] = e.slice(eq + 1).trim();
  }
  return addApiAccountResolved({
    id, baseUrl: flagVal(tokens, 'url'), key, keySrc: src, keyErr: error,
    label: flagVal(tokens, 'label'), color: flagVal(tokens, 'color'), makeDefault: hasFlag(tokens, 'default'),
    headers, modelOverrides, envMap, noVerify: hasFlag(tokens, 'no-verify'),
  });
}

// Next free local port for a claudex translator: 8790, or one past the highest already in
// use, so two codex accounts never collide on 127.0.0.1.
function nextClaudexPort(cfg) {
  const base = 8790;
  const used = ((cfg && cfg.accounts) || []).map((a) => a.proxy && a.proxy.port).filter(Boolean);
  return used.length ? Math.max(base - 1, ...used) + 1 : base;
}

// List the GPT/OpenAI model ids a gateway serves. Uses the OpenAI style (Bearer, NO
// anthropic-version) so a dual Claude+GPT gateway returns its GPT side here. Returns [] on any
// trouble — the wizard then just asks the user to type model ids.
function probeGatewayGptModels(baseUrl, key) {
  let out;
  try {
    out = execFileSync('curl.exe', ['-sS', '-m', '20', '-H', `Authorization: Bearer ${key}`,
      `${baseUrl.replace(/\/+$/, '')}/v1/models`], { encoding: 'utf8', windowsHide: true, timeout: 25000 });
  } catch { return []; }
  let j; try { j = JSON.parse(out); } catch { return []; }
  const arr = Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : []);
  return arr.map((m) => m.id || m.name).filter((id) => id && /^(gpt|o[0-9]|codex)/i.test(id));
}

// Does this gateway serve `model` on the ANTHROPIC endpoint Claude Code uses? If yes, arc can
// point Claude Code straight at it (DIRECT mode, no local translator). If it 4xx/errs, the
// gateway is OpenAI-only for GPT and arc must run the local translator. Best-effort; on any
// doubt we return false (translator), which always works.
function gatewayTranslatesMessages(baseUrl, key, model) {
  try {
    const body = JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    const out = execFileSync('curl.exe', ['-sS', '-m', '25', '-o', '/dev/null', '-w', '%{http_code}',
      '-H', `x-api-key: ${key}`, '-H', 'anthropic-version: 2023-06-01', '-H', 'content-type: application/json',
      '-d', body, `${baseUrl.replace(/\/+$/, '')}/v1/messages`],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return /^2\d\d$/.test(String(out).trim());
  } catch { return false; }
}

// Verify + register an api account from STRUCTURED params (also used by the add
// wizard). Customization: `headers` (merged over the default x-title), `modelOverrides`
// (alias→model, wins over auto-detected), `noVerify` (skip the /v1/models probe for
// gateways that don't expose it / use non-standard model names). DPAPI-encrypts the
// key, writes the account (backup + validate, restore on failure). Never throws.
function addApiAccountResolved({ id, baseUrl, key, keySrc, keyErr, label, color, makeDefault, headers, modelOverrides, envMap, model, proxyPort, noVerify }) {
  const C = require('./arc-config');
  keySrc = keySrc || 'clipboard';
  headers = headers || {}; modelOverrides = modelOverrides || {}; envMap = envMap || {};
  if (!/^[a-z][a-z0-9_-]*$/i.test(id || '')) return { ok: false, message: `invalid id "${id || ''}" — letters/digits/dash/underscore, start with a letter.` };
  try { if (C.findAccount(C.loadConfig(), id)) return { ok: false, message: `account "${id}" already exists — pick a different id.` }; } catch {}
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return { ok: false, message: 'a gateway account needs a full http(s):// URL.' };
  const badAlias = Object.keys(modelOverrides).find((a) => !['opus', 'sonnet', 'haiku', 'fable'].includes(a));
  if (badAlias) return { ok: false, message: `--model alias must be opus/sonnet/haiku/fable (got "${badAlias}").` };
  // Reject EMPTY override/header values from any caller — an empty model id would
  // set ANTHROPIC_DEFAULT_*_MODEL='' and break that alias; an empty header is malformed.
  const emptyModel = Object.entries(modelOverrides).find(([, v]) => !v);
  if (emptyModel) return { ok: false, message: `--model ${emptyModel[0]} needs a non-empty model id (e.g. ${emptyModel[0]}=claude-${emptyModel[0]}-…).` };
  const emptyHdr = Object.entries(headers).find(([, v]) => !v);
  if (emptyHdr) return { ok: false, message: `--header "${emptyHdr[0]}" needs a non-empty value.` };
  // An env map must not fight the fields that OWN routing (baseUrl/modelMap/headers), and
  // must never touch arc's control plane (ARC_SESSION etc. — that would detach the session
  // from its runner and its board role). Reject loudly rather than silently dropping.
  const badEnv = Object.keys(envMap).find((k) => !C.envKeyAllowed(k));
  if (badEnv) {
    return { ok: false, message: /^ARC_/i.test(badEnv)
      ? `--env cannot set "${badEnv}" — ARC_* is arc's own control plane.`
      : `--env cannot set "${badEnv}" — it is owned by --url / --model / --header (or is not a valid env name).` };
  }
  const emptyEnv = Object.entries(envMap).find(([, v]) => v === '');
  if (emptyEnv) return { ok: false, message: `--env "${emptyEnv[0]}" needs a non-empty value.` };
  if (!key) return { ok: false, message: `no key found in ${keySrc}${keyErr ? ` (${keyErr})` : ''} — copy the key to the clipboard, or pass --file <path> / --key <sk-…>.` };

  // Claudex auto-detect: if the caller wants a translator (proxyPort) but the gateway ALREADY
  // serves this GPT model on the Anthropic /v1/messages endpoint, skip the local process and
  // run DIRECT (drop proxyPort). Otherwise keep the translator. Either way it works.
  let claudexMode = null;
  if (proxyPort && model) {
    if (gatewayTranslatesMessages(baseUrl, key, model)) { proxyPort = null; claudexMode = 'direct'; }
    else claudexMode = 'translator';
  }

  // Build the modelMap: auto-detect from /v1/models (default), or trust overrides
  // when --no-verify. Overrides always win. Unmapped families → Claude Code defaults.
  let modelMap = {}, detail;
  if (noVerify) {
    modelMap = { ...modelOverrides };
    detail = `models: ${Object.keys(modelMap).length ? Object.entries(modelMap).map(([k, v]) => `${k}→${v}`).join(', ') : 'Claude Code defaults'} (unverified)`;
  } else {
    const probe = probeGatewayModels(baseUrl, key);
    if (!probe.ok) return { ok: false, message: `gateway check FAILED — ${probe.error}. Account NOT added. (If this gateway has no /v1/models, retry with --no-verify.)` };
    const claude = probe.models.filter((m) => /claude/i.test(m) || ['opus', 'sonnet', 'haiku', 'fable'].includes(m));
    if (!claude.length) return { ok: false, message: `that gateway serves no Claude models (${probe.models.slice(0, 6).join(', ') || 'none'}). If it's Claude-compatible under other names, add it with --no-verify [--model opus=<name> …]. Account NOT added.` };
    for (const fam of ['haiku', 'sonnet', 'opus', 'fable']) { const p = pickFamilyModel(claude, fam); if (p) modelMap[fam] = p; }
    Object.assign(modelMap, modelOverrides); // overrides win over auto-detected
    detail = `models: ${Object.entries(modelMap).map(([k, v]) => `${k}→${v}`).join(', ')}`;
  }

  // Store the key at rest (DPAPI on Windows; 0600 file on POSIX) before committing.
  let stored; try { stored = C.storeApiKey(id, key); }
  catch (e) { return { ok: false, message: `could not store key: ${e.message}` }; }

  const mergedHeaders = { 'x-title': 'claude', ...headers }; // user headers override the default
  const acct = {
    id, label: label || id.toUpperCase(), type: 'api',
    baseUrl: baseUrl.replace(/\/+$/, ''), ...stored.fields,
    headers: mergedHeaders, disableConnectors: true,
  };
  if (Object.keys(modelMap).length) acct.modelMap = modelMap;
  if (Object.keys(envMap).length) acct.env = envMap;
  if (model) acct.model = model;   // ANTHROPIC_MODEL — a proxy serving a FOREIGN model must pin it
  // proxyPort marks a CLAUDEX account: baseUrl is the GATEWAY (the translator's upstream), and
  // arc runs a LOCAL translator on this port that Claude Code actually talks to (see arc-claudex).
  if (proxyPort) acct.proxy = { port: proxyPort };
  if (color) acct.color = color;

  const bak = C.CONFIG_PATH + '.bak-' + Date.now();
  let raw; try { raw = JSON.parse(fs.readFileSync(C.CONFIG_PATH, 'utf8')); }
  catch (e) { return { ok: false, message: `arc-config.json unreadable: ${e.message}` }; }
  fs.copyFileSync(C.CONFIG_PATH, bak);
  raw.accounts = (raw.accounts || []).filter((a) => a.id !== id);
  raw.accounts.push(acct);
  if (!Array.isArray(raw.switchOrder)) raw.switchOrder = raw.accounts.map((a) => a.id);
  else if (!raw.switchOrder.includes(id)) raw.switchOrder.push(id);
  if (makeDefault) raw.defaultAccount = id;
  fs.writeFileSync(C.CONFIG_PATH, JSON.stringify(raw, null, 2));
  try { if (C.resolveApiKey(C.findAccount(C.loadConfig(), id)) !== key) throw new Error('resolved key mismatch'); }
  catch (e) { fs.copyFileSync(bak, C.CONFIG_PATH); return { ok: false, message: `validation failed — restored backup. ${e.message}` }; }

  const extraHdr = Object.keys(headers).length ? ` · headers: ${Object.keys(mergedHeaders).join(', ')}` : '';
  const modeNote = claudexMode === 'direct'
    ? `\n  claudex: DIRECT — the gateway serves ${model} on /v1/messages, so no local translator is needed`
    : claudexMode === 'translator'
      ? `\n  claudex: local translator on 127.0.0.1:${acct.proxy.port} (auto-started on switch) → ${model} at ${acct.baseUrl}`
      : '';
  return {
    ok: true,
    message: `✓ added gateway account "${id}" (${acct.label}) → ${acct.baseUrl}\n` +
      `  key ${key.slice(0, 7)}…${key.slice(-4)} ${stored.note} (from ${keySrc}) · ${detail}${extraHdr}${modeNote}` +
      `${makeDefault ? '\n  set as the default account' : ''}\n  use it: /arc-switch ${id}`,
  };
}

// Add an account. `--api`/`--url` → a gateway account, done inline here.
// Otherwise an oauth subscription → drop a trigger so arc-runner runs the guided
// browser login on the freed TTY. `argStr` is everything after the add-account
// verb (/arc-add-account, or the `arc add-account` CLI).
function requestAddAccount(session, argStr) {
  const tokens = (argStr || '').trim().split(/\s+/).filter(Boolean);
  // Bare `/arc-add-account` (no id/flags) → open the interactive wizard (pick
  // Subscription vs Gateway on an /arc-switch-style screen, then guided prompts).
  if (!tokens.length) {
    if (!session) return { ok: false, message: 'launch `arc` first — then `/arc-add-account` opens the add wizard.' };
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(path.join(CACHE_DIR, `arc-addacct-${session}.trigger`), JSON.stringify({ at: Date.now(), wizard: true }));
      return { ok: true, message: 'opening the add-account wizard — pick the type in the terminal…' };
    } catch (e) { return { ok: false, message: `add wizard signal FAILED — ${e.message}` }; }
  }
  const id = tokens.find((t) => !t.startsWith('-') && !/^sk-/.test(t)); // skip a bare key token
  if (!id) {
    return { ok: false, message: 'usage: /arc-add-account <id>  (subscription: browser login)  ·  or  /arc-add-account <id> --api --url <gateway> [--label L] [--color #hex] [--default]  (gateway; key from clipboard, or --file/--key)' };
  }
  if (!/^[a-z][a-z0-9_-]*$/i.test(id)) {
    return { ok: false, message: `invalid id "${id}" — use letters/digits/dash/underscore, starting with a letter.` };
  }
  try {
    const C = require('./arc-config');
    if (C.findAccount(C.loadConfig(), id)) {
      return { ok: false, message: `account "${id}" already exists — pick a different id (see /arc-help or arc doctor).` };
    }
  } catch {}

  // Gateway account: no browser, no TTY — verify + register right here.
  if (hasFlag(tokens, 'api') || hasFlag(tokens, 'url')) return addApiAccount(tokens, id);

  // oauth subscription: needs the browser + terminal → hand off to arc-runner.
  if (!session) {
    return { ok: false, message: 'adding a SUBSCRIPTION needs the arc wrapper (launch with `arc`). For a gateway, use: /arc-add-account ' + id + ' --api --url <gateway>.' };
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `arc-addacct-${session}.trigger`), JSON.stringify({ at: Date.now(), args: argStr.trim() }));
    return { ok: true, message: `adding account "${id}" — a Claude sign-in opens in your browser; log in as the NEW account. (this takes over the terminal briefly, then returns)` };
  } catch (e) {
    return { ok: false, message: `add-account signal FAILED — ${e.message}` };
  }
}

// ---- remove account (double-confirmed, pure config edit — no wrapper needed) ---
const CONFIRM_WORDS = new Set(['confirm', '--confirm', 'yes', '--yes', 'y']);
function pendingRmPath(session) { return path.join(CACHE_DIR, `arc-rmpending-${session}.json`); }

// Remove `id` from arc-config.json: backup → remove → fix references → validate
// (rollback on failure) → quarantine the account's profile dir to recoverable trash.
// Nothing is hard-deleted. Returns { backup, fixes[], credFile, profileTrash, profileInUse }.
function removeAccountFromConfig(C, id) {
  const bak = C.CONFIG_PATH + '.bak-' + Date.now();
  const raw = JSON.parse(fs.readFileSync(C.CONFIG_PATH, 'utf8'));
  fs.copyFileSync(C.CONFIG_PATH, bak);
  const idx = (raw.accounts || []).findIndex((a) => a.id === id);
  if (idx === -1) throw new Error(`account "${id}" not found`);
  const removed = raw.accounts[idx];
  raw.accounts.splice(idx, 1);
  const fixes = [];
  if (Array.isArray(raw.switchOrder)) raw.switchOrder = raw.switchOrder.filter((x) => x !== id);
  if (raw.defaultAccount === id) { raw.defaultAccount = raw.accounts[0].id; fixes.push(`default → ${raw.defaultAccount}`); }
  fs.writeFileSync(C.CONFIG_PATH, JSON.stringify(raw, null, 2));
  try { C.loadConfig(); }
  catch (e) { fs.copyFileSync(bak, C.CONFIG_PATH); throw new Error(`config rejected (${e.message}) — restored`); }
  const credFile = (removed.type === 'oauth' && removed.credentials && fs.existsSync(removed.credentials)) ? removed.credentials : null;
  // Quarantine the per-account profile dir so removal doesn't leave an orphan in
  // arc-profiles (the bug that stranded MAX/work). Recoverable (moved, not deleted).
  // If a live session still holds the dir the move fails — leave it and report.
  let profileTrash = null, profileInUse = false;
  try { profileTrash = require('./arc-profile').removeProfile(id); }
  catch (e) { profileInUse = true; }
  return { backup: bak, fixes, credFile, profileTrash, profileInUse };
}

// Rename an account in arc-config.json: id + (one-name) label + all references
// (switchOrder / default / rephrase). Backup + validate + rollback on error.
// Returns the backup path. Does NOT move the profile dir — the caller does that
// (arc-profile.renameProfile) so the two stay in step.
function renameAccountInConfig(C, oldId, newId) {
  const bak = C.CONFIG_PATH + '.bak-' + Date.now();
  const raw = JSON.parse(fs.readFileSync(C.CONFIG_PATH, 'utf8'));
  const a = (raw.accounts || []).find((x) => x.id === oldId);
  if (!a) throw new Error(`account "${oldId}" not found`);
  // Case-insensitive collision (Windows/macOS profile dirs collide on case) — but
  // exclude oldId itself so a case-only rename (work → Work) is allowed.
  if ((raw.accounts || []).some((x) => x.id !== oldId && String(x.id).toLowerCase() === String(newId).toLowerCase()))
    throw new Error(`"${newId}" collides with an existing account (names are case-insensitive on this filesystem)`);
  fs.copyFileSync(C.CONFIG_PATH, bak);
  a.id = newId;
  if (!a.label || a.label === oldId) a.label = newId; // keep the single name in sync
  if (Array.isArray(raw.switchOrder)) raw.switchOrder = raw.switchOrder.map((x) => (x === oldId ? newId : x));
  if (raw.defaultAccount === oldId) raw.defaultAccount = newId;
  if (raw.features && raw.features.rephraseAccount === oldId) raw.features.rephraseAccount = newId;
  fs.writeFileSync(C.CONFIG_PATH, JSON.stringify(raw, null, 2));
  try { C.loadConfig(); }
  catch (e) { fs.copyFileSync(bak, C.CONFIG_PATH); throw new Error(`config rejected (${e.message}) — restored`); }
  return bak;
}

// Perform a full rename NOW (config + profile dir). Move the profile dir FIRST so
// a config/profile split can't happen: if the config edit then fails, move it back.
// Returns { backup }. Throws on failure (nothing left half-done).
function doRename(C, oldId, newId) {
  const P = require('./arc-profile');
  const moved = P.renameProfile(oldId, newId); // login folder old → new (may be false if none yet)
  let backup;
  try { backup = renameAccountInConfig(C, oldId, newId); }
  catch (e) { if (moved) { try { P.renameProfile(newId, oldId); } catch {} } throw e; } // roll the dir back
  return { backup };
}

// Rename an account. `argStr`:  "<new>" renames the CURRENT session's account;
// "<old> <new>" renames a named one. Renaming an account that has a LIVE session
// (its profile dir is open) must go through arc-runner — it kills claude, moves the
// dir, then relaunches — so for the CURRENT session we drop a rename trigger; a
// live OTHER account is refused (close it first). Otherwise we rename in-place now.
function requestRename(session, argStr) {
  if (!session) return { ok: false, message: 'NOT running under the arc wrapper (launch with `arc`).' };
  let C, cfg;
  try { C = require('./arc-config'); cfg = C.loadConfig(); }
  catch (e) { return { ok: false, message: `arc config unreadable (${e.message}).` }; }

  const tokens = (argStr || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { ok: false, message: 'usage: /arc-rename [<old>] <new>  — e.g. `/arc-rename work` renames THIS session\'s account, or `/arc-rename work personal`.' };
  const current = currentAccount(C, cfg, session);
  const oldId = tokens.length >= 2 ? tokens[0] : current;
  const newId = tokens.length >= 2 ? tokens[1] : tokens[0];

  if (!/^[a-z][a-z0-9_-]*$/i.test(newId)) return { ok: false, message: `invalid new name "${newId}" — use letters/digits/dash/underscore, starting with a letter.` };
  const acc = C.findAccount(cfg, oldId);
  if (!acc) return { ok: false, message: `no account "${oldId}". Configured: ${cfg.accounts.map((a) => a.id).join(', ')}.` };
  if (oldId === newId) return { ok: false, message: `"${oldId}" is already its name — nothing to rename.` };
  // Collision check is case-INSENSITIVE (dirs collide on case), but ignores oldId
  // itself so recasing the same account (work → Work) is allowed.
  const clash = cfg.accounts.find((x) => x.id !== oldId && x.id.toLowerCase() === newId.toLowerCase());
  if (clash) return { ok: false, message: `"${newId}" collides with existing account "${clash.id}" (names are case-insensitive here) — pick a different name.` };

  const live = liveSessionsOn(oldId);
  if (oldId === current) {
    // The account THIS session is on — its profile dir is open, so arc-runner must
    // do it (kill claude → move dir → relaunch on the new name).
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(path.join(CACHE_DIR, `arc-rename-${session}.trigger`), JSON.stringify({ oldId, newId, at: Date.now() }));
      return { ok: true, viaRunner: true, message: `renaming "${oldId}" → "${newId}" — relaunching this session on the new name…` };
    } catch (e) { return { ok: false, message: `rename signal FAILED — ${e.message}` }; }
  }
  if (live > 0) {
    return { ok: false, message: `"${oldId}" has ${live} other live session(s) — its login folder is in use. Close them (or run \`/arc-rename ${newId}\` from that session) first.` };
  }
  // No live session on it → safe to rename right here.
  try {
    const { backup } = doRename(C, oldId, newId);
    return { ok: true, renamed: true, message: `✓ renamed "${oldId}" → "${newId}". Its login + conversations are preserved. (config backup: ${backup})` };
  } catch (e) { return { ok: false, message: `rename FAILED — ${e.message}` }; }
}

// Two-step removal. `argStr` = "<id>" (step 1: arm + show impact) or
// "<id> confirm" (step 2: verify the fresh pending marker, then remove).
// Returns { ok, pending?, removed?, message }.
function requestRemoveAccount(session, argStr) {
  if (!session) return { ok: false, message: 'NOT running under the arc wrapper (launch with `arc`).' };
  let C, cfg;
  try { C = require('./arc-config'); cfg = C.loadConfig(); }
  catch (e) { return { ok: false, message: `arc config unreadable (${e.message}).` }; }

  const tokens = (argStr || '').trim().split(/\s+/).filter(Boolean);
  const isConfirm = tokens.some((t) => CONFIRM_WORDS.has(t.toLowerCase()));
  const id = tokens.find((t) => !t.startsWith('-') && !CONFIRM_WORDS.has(t.toLowerCase()));
  if (!id) return { ok: false, message: 'usage: /arc-remove-account <id>   (then confirm) — an account id is required.' };

  const acc = C.findAccount(cfg, id);
  if (!acc) return { ok: false, message: `no account "${id}". Configured: ${cfg.accounts.map((a) => a.id).join(', ')}.` };
  if (cfg.accounts.length < 2) return { ok: false, message: `refusing to remove the LAST account ("${acc.id}") — arc needs at least one.` };

  // Where sessions on this account fall back to on their next relaunch (removing
  // the default reassigns it to the first remaining account).
  const newDefault = cfg.defaultAccount === acc.id
    ? ((cfg.accounts.find((a) => a.id !== acc.id) || {}).id || '?')
    : cfg.defaultAccount;
  const live = liveSessionsOn(acc.id);
  // Plain text in short lines (CAPS + ⚠ for prominence even without colour). The
  // hook paints the whole destructive message RED per-line, so short lines keep the
  // colour across soft-wraps.
  const Subj = live > 1 ? 'They' : 'It', keep = live > 1 ? 'keep' : 'keeps', drop = live > 1 ? 'drop' : 'drops', them = live > 1 ? 'them' : 'it';
  const liveWarn = live > 0
    ? `⚠ ${live} LIVE SESSION${live > 1 ? 'S' : ''} STILL ON "${acc.id.toUpperCase()}"\n`
      + `  ${Subj} ${keep} running (removal won't stop ${them}).\n`
      + `  ${Subj} ${drop} to "${newDefault}" on next switch/restart.\n`
      + `  Move one off now: /arc-switch ${newDefault} in it.\n`
    : '';

  if (!isConfirm) {
    // STEP 1 — arm a short-lived pending marker and show exactly what happens.
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(pendingRmPath(session), JSON.stringify({ id: acc.id, at: Date.now() })); } catch {}
    return {
      ok: true, pending: true,
      message:
        liveWarn +
        `REMOVE account "${acc.id}"${acc.label && acc.label !== acc.id.toUpperCase() ? ` (${acc.label})` : ''}` +
        ` · ${acc.type}${acc.email ? ` · ${acc.email}` : ''}?` + '\n' +
        `  • arc-config.json is backed up first; references (switch order / default) are auto-fixed\n` +
        `  • its profile (login + local data) is MOVED to recoverable trash (arc-profiles/.trash), never hard-deleted\n` +
        `  CONFIRM within 2 min:  /arc-remove-account ${acc.id} confirm     ·     or ignore this to cancel`,
    };
  }

  // STEP 2 — require a fresh pending marker for THIS id (enforces the two-step).
  let pend = null;
  try { pend = JSON.parse(fs.readFileSync(pendingRmPath(session), 'utf8')); } catch {}
  if (!pend || pend.id !== acc.id || Date.now() - pend.at > 120_000) {
    return { ok: false, message: `no pending confirmation for "${acc.id}" (or it expired) — run \`/arc-remove-account ${acc.id}\` first to review what will be removed.` };
  }
  let res;
  try { res = removeAccountFromConfig(C, acc.id); }
  catch (e) { return { ok: false, message: `remove FAILED — ${e.message}` }; }
  try { fs.unlinkSync(pendingRmPath(session)); } catch {}
  return {
    ok: true, removed: true,
    message:
      `✓ removed account "${acc.id}".${res.fixes.length ? ` (${res.fixes.join('; ')})` : ''}\n` +
      (live > 0
        ? `  ${live} live session${live > 1 ? 's' : ''} ${keep} running (same key);\n`
          + `  ${live > 1 ? 'they' : 'it'} will drop to "${newDefault}" on next switch/restart.\n`
        : '') +
      (res.profileTrash ? `  its profile (login + local data) → recoverable trash: ${res.profileTrash}\n` : '') +
      (res.profileInUse ? `  ⚠ profile dir left in place — a live session is using it; remove arc-profiles/${acc.id} after it exits.\n` : '') +
      (res.credFile ? `  its legacy login file was KEPT at ${res.credFile} — delete it yourself if you want it gone.\n` : '') +
      `  reverse it by restoring the backup: ${res.backup}${res.profileTrash ? ' (and moving the profile dir back)' : ''}`,
  };
}

// ---- delete current session (double-confirmed, moves to recoverable trash) ---
function pendingDelPath(session) { return path.join(CACHE_DIR, `arc-delpending-${session}.json`); }

// The conversation id THIS arc session is on.
function sessionConvId(session) {
  for (const p of [path.join(CACHE_DIR, `arc-state-${session}.json`), path.join(CACHE_DIR, `arc-active-${session}.json`)]) {
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); if (j.convId) return j.convId; } catch {}
  }
  return null;
}

// Two-step deletion of the CURRENT conversation. Step 1 (bare `/arc-delete`) shows
// the impact and arms a 2-min pending marker; step 2 (`/arc-delete confirm`) drops
// a delete trigger — arc-runner kills claude, moves the transcript to recoverable
// trash, and starts a FRESH session. Returns { ok, pending?, deleting?, message }.
function requestDelete(session, argStr) {
  if (!session) return { ok: false, message: 'NOT running under the arc wrapper (launch with `arc`).' };
  const convId = sessionConvId(session);
  if (!convId) return { ok: false, message: 'no current conversation id yet (the statusline hasn\'t bridged it) — try again in a moment.' };

  let fp = null;
  try { fp = require('./arc-sync').findTranscriptFile(convId); } catch {}
  if (!fp) {
    // No transcript = an EMPTY session (no messages saved yet) → nothing to trash.
    // This is the usual "/arc-delete did nothing" case: you delete a chat, a fresh
    // empty session starts, and deleting THAT finds nothing — so say so clearly
    // instead of arming a confirm that then reports "(not found)".
    return { ok: false, message: 'nothing to delete — this conversation has no saved messages yet. (An empty session leaves no transcript; just send a message first, or switch/exit.)' };
  }
  let sizeStr = '';
  try { const b = fs.statSync(fp).size; sizeStr = b < 1024 ? ` (${b} B)` : b < 1048576 ? ` (${Math.round(b / 1024)} KB)` : ` (${(b / 1048576).toFixed(1)} MB)`; } catch {}

  const isConfirm = (argStr || '').trim().split(/\s+/).some((t) => CONFIRM_WORDS.has(t.toLowerCase()));
  if (!isConfirm) {
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(pendingDelPath(session), JSON.stringify({ convId, at: Date.now() })); } catch {}
    return {
      ok: true, pending: true,
      message:
        `DELETE the CURRENT conversation (${convId.slice(0, 8)}${sizeStr})?\n` +
        `  • it is MOVED to recoverable trash, never hard-deleted (/arc-trash to list/restore/purge)\n` +
        `  • this conversation ENDS and a fresh empty session starts in its place\n` +
        `  CONFIRM within 2 min:  /arc-delete confirm     ·     or ignore this to cancel`,
    };
  }

  let pend = null;
  try { pend = JSON.parse(fs.readFileSync(pendingDelPath(session), 'utf8')); } catch {}
  if (!pend || pend.convId !== convId || Date.now() - pend.at > 120_000) {
    return { ok: false, message: `no pending confirmation for this conversation (or it expired) — run \`/arc-delete\` first to review.` };
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `arc-delete-${session}.trigger`), JSON.stringify({ at: Date.now(), convId }));
    fs.unlinkSync(pendingDelPath(session));
  } catch (e) { return { ok: false, message: `delete signal FAILED — ${e.message}` }; }
  return { ok: true, deleting: true, message: `deleting this conversation and starting fresh — one moment…` };
}

// Drop a restart trigger. Returns { ok, message }. Never throws.
function requestRestart(session) {
  if (!session) {
    return { ok: false, message: 'NOT RESTARTING — this session is not running under the arc wrapper (launch with `arc`).' };
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `arc-restart-${session}.trigger`), JSON.stringify({ at: Date.now() }));
    return { ok: true, message: 'RESTARTING — the wrapper will reload and relaunch this conversation momentarily.' };
  } catch (e) {
    return { ok: false, message: `restart signal FAILED — ${e.message}` };
  }
}

// ---- /arc-trash — list / restore / permanently empty the conversation trash --
// (~/.claude/backups/arc-deleted-*, written by /arc-delete). Pure file ops that run
// synchronously in the hook — zero tokens, no relaunch. `plain: true` results are
// self-contained readouts (rendered uncolored, like /arc-peek).
function pendingPurgePath(session) { return path.join(CACHE_DIR, `arc-purgepending-${session || 'terminal'}.json`); }

function requestTrash(session, argStr) {
  const sync = require('./arc-sync');
  const toks = (argStr || '').trim().split(/\s+/).filter(Boolean);
  const sub = (toks[0] || '').toLowerCase();

  if (sub === 'restore') return sync.restoreSession(toks[1] || '');

  if (sub === 'empty' || sub === 'purge' || sub === 'clear') {
    const entries = sync.listTrash();
    if (!entries.length) return { ok: false, message: 'trash is already empty — nothing to purge.' };
    const bytes = entries.reduce((s, e) => s + e.bytes, 0);
    const isConfirm = toks.slice(1).some((t) => CONFIRM_WORDS.has(t.toLowerCase()));
    if (!isConfirm) {
      try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(pendingPurgePath(session), JSON.stringify({ at: Date.now() })); } catch {}
      return {
        ok: true, pending: true,
        message:
          `EMPTY TRASH — PERMANENTLY delete ${entries.length} trashed conversation${entries.length > 1 ? 's' : ''} (${sync.human(bytes)})?\n` +
          `  ⚠ NOT recoverable: this deletes the recoverable copies themselves\n` +
          `  CONFIRM within 2 min:  /arc-trash empty confirm     ·     or ignore this to cancel`,
      };
    }
    let pend = null;
    try { pend = JSON.parse(fs.readFileSync(pendingPurgePath(session), 'utf8')); } catch {}
    if (!pend || Date.now() - pend.at > 120_000) {
      return { ok: false, message: 'no pending confirmation (or it expired) — run `/arc-trash empty` first to review what gets purged.' };
    }
    try { fs.unlinkSync(pendingPurgePath(session)); } catch {}
    const r = sync.emptyTrash();
    return r.ok
      ? { ok: true, message: `✓ trash emptied — permanently deleted ${r.count} conversation${r.count > 1 ? 's' : ''} (${sync.human(r.bytes)}).` }
      : { ok: false, message: `purge INCOMPLETE — ${r.failed} trash folder(s) would not delete (file in use?). /arc-trash shows what's left.` };
  }

  if (sub && sub !== 'list') {
    return { ok: false, message: `unknown trash action "${toks[0]}" — use: /arc-trash · /arc-trash restore <id> · /arc-trash empty` };
  }

  const entries = sync.listTrash();
  if (!entries.length) return { ok: true, plain: true, message: 'trash — empty. (/arc-delete moves conversations here; nothing is hard-deleted until /arc-trash empty.)' };
  const bytes = entries.reduce((s, e) => s + e.bytes, 0);
  const lines = [`trash — ${entries.length} deleted conversation${entries.length > 1 ? 's' : ''}, ${sync.human(bytes)} total (newest deletion first)`, ''];
  for (const e of entries) {
    let m = {}; try { m = sync.transcriptMeta(e.file); } catch {}
    // Title: a /rename'd name is most meaningful; show the AI title alongside it
    // when both exist and differ; else the AI title, else a first-prompt snippet.
    let title = m.customTitle && m.aiTitle && m.aiTitle !== m.customTitle
      ? `${m.customTitle} — ${m.aiTitle}`
      : (m.customTitle || m.aiTitle || m.firstPrompt || null);
    title = title ? (title.length > 64 ? title.slice(0, 63) + '…' : title) : '(untitled)';
    const used = m.lastActive ? `last used ${shortStamp(m.lastActive)}` : `deleted ${e.deletedAt.slice(5)}`;
    const turns = m.turns == null ? 'large' : `${m.turns} msg${m.turns === 1 ? '' : 's'}`;
    const where = m.cwd || e.proj;
    lines.push(`  ${e.convId.slice(0, 8)}  ${title}`);
    lines.push(`            ${turns} · ${used} · ${sync.human(e.bytes)} · ${where}${e.sidecar ? ' · +files' : ''}`);
  }
  lines.push('', '  restore one:  /arc-trash restore <id>   (then: arc --resume <id>)        purge all:  /arc-trash empty');
  return { ok: true, plain: true, message: lines.join('\n') };
}

module.exports = { scopedLimits, sevGlyph, requestSwitch, requestRestart, requestPicker, requestModePicker, requestAddAccount, requestRemoveAccount, requestRename, doRename, requestDelete, requestTrash, currentAccount, buildPeek, chooseLaunchAccount, accountHeadroom, oauthUsageSlice, refreshUsageNow, usageCacheFresh, readUsageCache, addApiAccountResolved, readAddKey, nextClaudexPort, gatewayTranslatesMessages, probeGatewayGptModels, CACHE_DIR };
