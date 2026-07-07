// cl-switch-core: the shared validate + drop-trigger logic for switching/
// restarting a cl session. Used by BOTH entry points:
//   - cl-signal.js       (the /switch and /restart slash commands' !-bash)
//   - cl-switch-hook.js  (a UserPromptSubmit hook — classifier-immune fallback
//                          that works even when the account is rate-limited)
//
// Keeping it in one module means the two paths can never disagree about what a
// valid switch is or where the trigger file goes.
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');

// Resolve this session's CURRENT account from its state file (fallback: default).
function currentAccount(C, cfg, session) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `cl-state-${session}.json`), 'utf8'));
    const acc = C.findAccount(cfg, st.account);
    if (acc) return acc.id;
  } catch {}
  return cfg.defaultAccount;
}

// Count LIVE cl sessions currently pinned to `accountId` (a cl-state file says so
// AND its pid is alive). Removing an account doesn't kill sessions using it — they
// keep working and drop to the default on their next relaunch — so we warn first.
function liveSessionsOn(accountId) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!/^cl-state-.*\.json$/.test(f)) continue;
      let st; try { st = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8')); } catch { continue; }
      if (st.account !== accountId || !st.pid) continue;
      try { process.kill(st.pid, 0); n++; } catch (e) { if (e.code === 'EPERM') n++; } // EPERM = alive, not ours
    }
  } catch {}
  return n;
}

// ---- usage peek + shared launch-account decision ---------------------------
// These back BOTH the launch-time auto-select (cl-runner) and the `cl:peek`
// readout, so the "would launch on X" line always matches what actually happens.

function readUsageCache() {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'usage-monitor-cache.json'), 'utf8')); }
  catch { return null; }
}

// Headroom score for an account from the usage cache: higher = more free.
//   null = can't judge (no data)   ·   -1 = exhausted   ·   0..100 = % headroom
function accountHeadroom(acc, cache, th) {
  if (!cache) return null;
  const SW_S = (th && th.switchSessionPct) != null ? th.switchSessionPct : 92;
  const SW_W = (th && th.switchWeekPct) != null ? th.switchWeekPct : 95;
  if (acc.type === 'oauth') {
    const d = cache.usage && cache.usage.data;
    if (!d || !d.five_hour || typeof d.five_hour.utilization !== 'number') return null;
    const fh = d.five_hour.utilization;                   // seven_day may be absent in a partial cache
    const sd = d.seven_day && typeof d.seven_day.utilization === 'number' ? d.seven_day.utilization : 0;
    if (fh >= SW_S || sd >= SW_W) return -1;             // over a switch threshold = exhausted
    return 100 - fh;                                      // 5h is the binding short-term limit
  }
  if (acc.type === 'api') {
    if (!cache.pool || !Array.isArray(cache.pool.rows) || !cache.pool.rows.length) return null;
    const active = cache.pool.rows.filter((r) => r.status === 'active' && r.reason_code !== 'rate_limited' && r.fh != null);
    if (!active.length) return -1;                        // every pool account in cooldown = exhausted
    return 100 - Math.min(...active.map((r) => r.fh));    // headroom of the least-loaded pool account
  }
  return null;
}

// Decide the launch account: PREFER a subscription (oauth) with headroom; fall to
// the most-available api/pool only when all subscriptions are exhausted; else the
// least-bad. Returns { id, reason } or null when nothing can be judged (no cache).
function chooseLaunchAccount(cfg, cache) {
  const C = require('./cl-config');
  const th = cfg.thresholds || {};
  const score = (a) => accountHeadroom(a, cache, th);
  const oauth = cfg.accounts.filter((a) => a.type === 'oauth').map((a) => ({ a, s: score(a) }));
  const oauthJudged = oauth.filter((x) => x.s != null);

  if (oauth.length && !oauthJudged.length) return null;   // subs exist but unjudged → don't guess

  const oauthRoom = oauthJudged.filter((x) => x.s >= 0).sort((x, y) => y.s - x.s);
  if (oauthRoom.length) return { id: oauthRoom[0].a.id, reason: 'subscription has headroom' };

  const apiRoom = cfg.accounts.filter((a) => a.type === 'api').map((a) => ({ a, s: score(a) }))
    .filter((x) => x.s != null && x.s >= 0).sort((x, y) => y.s - x.s);
  if (apiRoom.length) {
    const subLabel = oauthJudged.length ? oauthJudged[0].a.label : 'subscription';
    return { id: apiRoom[0].a.id, reason: `${subLabel} exhausted → most available` };
  }

  if (!oauth.length) {                                    // api-only config
    const anyApi = cfg.accounts.map((a) => ({ a, s: score(a) })).filter((x) => x.s != null);
    if (!anyApi.length) return null;
    const best = anyApi.filter((x) => x.s >= 0).sort((x, y) => y.s - x.s)[0];
    if (best) return { id: best.a.id, reason: 'most available' };
  }

  const lb = (oauthJudged[0] && oauthJudged[0].a) || C.findAccount(cfg, cfg.defaultAccount) || cfg.accounts[0];
  return { id: lb.id, reason: 'all accounts exhausted → least-bad' };
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

// Standalone, ZERO-TOKEN usage readout of ALL accounts (subscription + pool),
// current account marked, plus what a fresh launch would auto-select. Read-only —
// the hook renders this directly (no trigger, no relaunch). Returns { ok, message }.
function buildPeek(session) {
  let C, cfg;
  try { C = require('./cl-config'); cfg = C.loadConfig(); }
  catch (e) { return { ok: false, message: `cl usage — config unreadable (${e.message}). Fix ~/.claude/cl-config.json or run \`cl setup\`.` }; }
  const cache = readUsageCache();
  const current = session ? currentAccount(C, cfg, session) : null;
  const pct = (v) => (v == null ? '  ?' : String(Math.round(v)).padStart(3));
  const lines = ['cl usage — peek'];
  if (!cache) lines.push('  (no usage cache yet — the statusline populates it every few minutes; try again shortly)');

  for (const a of cfg.accounts) {
    const mark = a.id === current ? '   ← current' : '';
    const label = a.label || a.id;
    if (a.type === 'oauth') {
      if (cache && cache.usage && cache.usage.data && cache.usage.data.five_hour) {
        const d = cache.usage.data;
        const sd = d.seven_day || {};                    // partial cache may lack seven_day
        const reset = fmtReset(d.five_hour.resets_at) || fmtReset(sd.resets_at);
        const rp = reset ? `  (resets ${reset})` : '';
        lines.push(`  ${label} [subscription]   5h ${pct(d.five_hour.utilization).trim()}%  ·  7d ${pct(sd.utilization).trim()}%${rp}   ${ageStr(cache.usage.fetchedAt)}${mark}`);
      } else {
        lines.push(`  ${label} [subscription]   (no usage data)${mark}`);
      }
    } else if (a.type === 'api') {
      const gw = cache && cache.gwUsage && cache.gwUsage[a.id];
      if (gw && gw.data) {
        // The gateway's OWN usage endpoint (e.g. MATE /v1/usage). Guarded — a hook
        // must never throw on a weird gateway payload (a throw = silent pass-through).
        try {
          const GW = require('./gw-usage');
          const s = GW.summarizeGatewayUsage(gw.data);
          lines.push(`  ${label} [gateway]        ${GW.gatewayUsageLine(gw.data, { withReq: true }) || '(usage)'}   ${ageStr(gw.fetchedAt)}${mark}`);
          for (const m of ((s && s.models) || []).slice(0, 4)) {
            lines.push(`      ${String(m.model || '?').replace(/^claude-/, '').slice(0, 12).padEnd(12)}  ${GW.fmtTokens(m.tokens)} tok${m.cost != null ? ` · ${GW.fmtCost(m.cost, s.unit)}` : ''}`);
          }
        } catch { lines.push(`  ${label} [gateway]        (usage unavailable)${mark}`); }
      } else if (cache && cache.pool && Array.isArray(cache.pool.rows) && cache.pool.rows.length) {
        // Legacy poolDb metrics (per-backing-account 5h/7d).
        const rows = cache.pool.rows;
        const active = rows.filter((r) => r.status === 'active' && r.reason_code !== 'rate_limited').length;
        const fhs = rows.map((r) => r.fh).filter((v) => v != null);
        const minFh = fhs.length ? Math.round(Math.min(...fhs)) : null;
        lines.push(`  ${label} [gateway]        ${active}/${rows.length} active${minFh != null ? `  ·  5h from ${minFh}%` : ''}   ${ageStr(cache.pool.fetchedAt)}${mark}`);
        for (const r of rows) {
          const nm = String(r.label || r.email || '?').split('@')[0].slice(0, 10).padEnd(10);
          const st = r.reason_code === 'rate_limited' ? 'cooldown' : (r.status || '?');
          lines.push(`      ${nm}  5h ${pct(r.fh)}%  ·  7d ${pct(r.sd)}%   ${st}`);
        }
      } else {
        lines.push(`  ${label} [gateway]        (no usage data yet)${mark}`);
      }
    } else {
      lines.push(`  ${label} [${a.type}]${mark}`);
    }
  }

  // The account a fresh launch/resume would auto-select (same decision cl-runner
  // uses) — so peek doubles as "where's my headroom / where will cl start me".
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
    `Pick by number or name: \`/switch <n|name>\`  (or \`cl:switch <n|name>\` — works even when rate-limited).`;
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
      message: 'NOT SWITCHING — this session is not running under the cl wrapper (launch with `cl` to use switching).' };
  }
  let C, cfg;
  try { C = require('./cl-config'); cfg = C.loadConfig(); }
  catch (e) {
    return { ok: false, switching: false,
      message: `NOT SWITCHING — cl config unreadable (${e.message}). Fix ~/.claude/cl-config.json or run \`cl setup\`.` };
  }

  const current = currentAccount(C, cfg, session);
  const ids = cfg.accounts.map((a) => a.id).join(', ');
  target = target ? String(target).trim() : null;

  // No explicit target: refuse (1) / cycle (below menuMin) / show the picker menu.
  // menuMin = min account count that triggers the numbered menu instead of a
  // blind cycle (cl-config features.switchMenuMin, default 3, floor 2).
  const menuMin = Math.max(2, (cfg.features && cfg.features.switchMenuMin) || 3);
  if (!target) {
    if (cfg.accounts.length < 2) {
      return { ok: false, switching: false,
        message: `NOT SWITCHING — only ONE account is configured (${ids}), so there is nothing to switch to. The session stays on "${current}". Add another with \`cl add-account <id>\`.` };
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
// already turned into an id before cl-runner sees it).
function writeSwitch(session, current, next) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `cl-switch-${session}.trigger`), JSON.stringify({ at: Date.now(), target: next.id }));
    return { ok: true, switching: true,
      message: `SWITCHING "${current}" → "${next.id}" (${next.label}) — the wrapper will relaunch this conversation on it momentarily.` };
  } catch (e) {
    return { ok: false, switching: false, message: `switch signal FAILED — ${e.message}` };
  }
}

// Drop a picker trigger → cl-runner opens the interactive arrow-key account
// picker (zero tokens). Refuses if <2 accounts. Returns { ok, picker, message }.
function requestPicker(session) {
  if (!session) {
    return { ok: false, picker: false, message: 'NOT SWITCHING — not running under the cl wrapper (launch with `cl`).' };
  }
  let C, cfg;
  try { C = require('./cl-config'); cfg = C.loadConfig(); }
  catch (e) { return { ok: false, picker: false, message: `NOT SWITCHING — cl config unreadable (${e.message}).` }; }
  if (cfg.accounts.length < 2) {
    return { ok: false, picker: false,
      message: `NOT SWITCHING — only ONE account is configured. Add another with \`cl add-account <id>\`.` };
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `cl-pick-${session}.trigger`), JSON.stringify({ at: Date.now() }));
    return { ok: true, picker: true, message: 'opening account picker — use ↑/↓ and Enter in the terminal…' };
  } catch (e) {
    return { ok: false, picker: false, message: `picker signal FAILED — ${e.message}` };
  }
}

// ---- add an api (gateway/pool) account inline -------------------------------
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
      const raw = fs.readFileSync(require('./cl-config').expandHome(file), 'utf8');
      const m = raw.match(/sk-[A-Za-z0-9-]+/);
      return { key: (m ? m[0] : raw.trim()), src: file };
    } catch (e) { return { key: '', src: file, error: e.message }; }
  }
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return { key: (out || '').trim(), src: 'clipboard' };
  } catch (e) { return { key: '', src: 'clipboard', error: e.message }; }
}

// GET <base>/v1/models with the key → { ok, models[] } or { ok:false, error }.
function probeGatewayModels(baseUrl, key) {
  let out;
  try {
    // Send `anthropic-version` (like Claude Code does) so a dual Claude+GPT gateway
    // keyed to ONE universal key returns its CLAUDE models here, not GPT ones.
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

// Flag-driven api add (cl:add-account <id> --api --url … / terminal). Thin wrapper
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
  return addApiAccountResolved({
    id, baseUrl: flagVal(tokens, 'url'), key, keySrc: src, keyErr: error,
    label: flagVal(tokens, 'label'), color: flagVal(tokens, 'color'), makeDefault: hasFlag(tokens, 'default'),
    headers, modelOverrides, noVerify: hasFlag(tokens, 'no-verify'),
  });
}

// Verify + register an api account from STRUCTURED params (also used by the add
// wizard). Customization: `headers` (merged over the default x-title), `modelOverrides`
// (alias→model, wins over auto-detected), `noVerify` (skip the /v1/models probe for
// gateways that don't expose it / use non-standard model names). DPAPI-encrypts the
// key, writes the account (backup + validate, restore on failure). Never throws.
function addApiAccountResolved({ id, baseUrl, key, keySrc, keyErr, label, color, makeDefault, headers, modelOverrides, noVerify }) {
  const C = require('./cl-config');
  keySrc = keySrc || 'clipboard';
  headers = headers || {}; modelOverrides = modelOverrides || {};
  if (!/^[a-z][a-z0-9_-]*$/i.test(id || '')) return { ok: false, message: `invalid id "${id || ''}" — letters/digits/dash/underscore, start with a letter.` };
  try { if (C.findAccount(C.loadConfig(), id)) return { ok: false, message: `account "${id}" already exists — pick a different id.` }; } catch {}
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return { ok: false, message: 'a gateway/pool account needs a full http(s):// URL.' };
  const badAlias = Object.keys(modelOverrides).find((a) => !['opus', 'sonnet', 'haiku', 'fable'].includes(a));
  if (badAlias) return { ok: false, message: `--model alias must be opus/sonnet/haiku/fable (got "${badAlias}").` };
  // Reject EMPTY override/header values from any caller — an empty model id would
  // set ANTHROPIC_DEFAULT_*_MODEL='' and break that alias; an empty header is malformed.
  const emptyModel = Object.entries(modelOverrides).find(([, v]) => !v);
  if (emptyModel) return { ok: false, message: `--model ${emptyModel[0]} needs a non-empty model id (e.g. ${emptyModel[0]}=claude-${emptyModel[0]}-…).` };
  const emptyHdr = Object.entries(headers).find(([, v]) => !v);
  if (emptyHdr) return { ok: false, message: `--header "${emptyHdr[0]}" needs a non-empty value.` };
  if (!key) return { ok: false, message: `no key found in ${keySrc}${keyErr ? ` (${keyErr})` : ''} — copy the key to the clipboard, or pass --file <path> / --key <sk-…>.` };

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

  // DPAPI-encrypt the key (no plaintext on disk), round-trip before committing.
  let enc; try { enc = C.dpapiEncrypt(key); if (C.dpapiDecrypt(enc) !== key) throw new Error('round-trip mismatch'); }
  catch (e) { return { ok: false, message: `DPAPI encrypt failed: ${e.message}` }; }

  const mergedHeaders = { 'x-title': 'claude', ...headers }; // user headers override the default
  const acct = {
    id, label: label || id.toUpperCase(), type: 'api',
    baseUrl: baseUrl.replace(/\/+$/, ''), apiKeyEnc: enc,
    headers: mergedHeaders, disableConnectors: true,
  };
  if (Object.keys(modelMap).length) acct.modelMap = modelMap;
  if (color) acct.color = color;

  const bak = C.CONFIG_PATH + '.bak-' + Date.now();
  let raw; try { raw = JSON.parse(fs.readFileSync(C.CONFIG_PATH, 'utf8')); }
  catch (e) { return { ok: false, message: `cl-config.json unreadable: ${e.message}` }; }
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
  return {
    ok: true,
    message: `✓ added gateway account "${id}" (${acct.label}) → ${acct.baseUrl}\n` +
      `  key ${key.slice(0, 7)}…${key.slice(-4)} DPAPI-encrypted (from ${keySrc}) · ${detail}${extraHdr}` +
      `${makeDefault ? '\n  set as the default account' : ''}\n  use it: cl:switch ${id}`,
  };
}

// Add an account. `--api`/`--url` → a gateway/pool account, done inline here.
// Otherwise an oauth subscription → drop a trigger so cl-runner runs the guided
// browser login on the freed TTY. `argStr` is everything after `cl:add-account`.
function requestAddAccount(session, argStr) {
  const tokens = (argStr || '').trim().split(/\s+/).filter(Boolean);
  // Bare `cl:add-account` (no id/flags) → open the interactive wizard (pick
  // Subscription vs Gateway on a cl:switch-style screen, then guided prompts).
  if (!tokens.length) {
    if (!session) return { ok: false, message: 'launch `cl` first — then `cl:add-account` opens the add wizard.' };
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(path.join(CACHE_DIR, `cl-addacct-${session}.trigger`), JSON.stringify({ at: Date.now(), wizard: true }));
      return { ok: true, message: 'opening the add-account wizard — pick the type in the terminal…' };
    } catch (e) { return { ok: false, message: `add wizard signal FAILED — ${e.message}` }; }
  }
  const id = tokens.find((t) => !t.startsWith('-') && !/^sk-/.test(t)); // skip a bare key token
  if (!id) {
    return { ok: false, message: 'usage: cl:add-account <id>  (subscription: browser login)  ·  or  cl:add-account <id> --api --url <gateway> [--label L] [--color #hex] [--default]  (gateway/pool; key from clipboard, or --file/--key)' };
  }
  if (!/^[a-z][a-z0-9_-]*$/i.test(id)) {
    return { ok: false, message: `invalid id "${id}" — use letters/digits/dash/underscore, starting with a letter.` };
  }
  try {
    const C = require('./cl-config');
    if (C.findAccount(C.loadConfig(), id)) {
      return { ok: false, message: `account "${id}" already exists — pick a different id (see /cl or cl doctor).` };
    }
  } catch {}

  // Gateway/pool account: no browser, no TTY — verify + register right here.
  if (hasFlag(tokens, 'api') || hasFlag(tokens, 'url')) return addApiAccount(tokens, id);

  // oauth subscription: needs the browser + terminal → hand off to cl-runner.
  if (!session) {
    return { ok: false, message: 'adding a SUBSCRIPTION needs the cl wrapper (launch with `cl`). For a gateway/pool, use: cl:add-account ' + id + ' --api --url <gateway>.' };
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `cl-addacct-${session}.trigger`), JSON.stringify({ at: Date.now(), args: argStr.trim() }));
    return { ok: true, message: `adding account "${id}" — a Claude sign-in opens in your browser; log in as the NEW account. (this takes over the terminal briefly, then returns)` };
  } catch (e) {
    return { ok: false, message: `add-account signal FAILED — ${e.message}` };
  }
}

// ---- remove account (double-confirmed, pure config edit — no wrapper needed) ---
const CONFIRM_WORDS = new Set(['confirm', '--confirm', 'yes', '--yes', 'y']);
function pendingRmPath(session) { return path.join(CACHE_DIR, `cl-rmpending-${session}.json`); }

// Remove `id` from cl-config.json: backup → remove → fix references → validate
// (rollback on failure). NEVER deletes the captured credential file (recoverable).
// Returns { backup, fixes[], credFile }.
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
  return { backup: bak, fixes, credFile };
}

// Two-step removal. `argStr` = "<id>" (step 1: arm + show impact) or
// "<id> confirm" (step 2: verify the fresh pending marker, then remove).
// Returns { ok, pending?, removed?, message }.
function requestRemoveAccount(session, argStr) {
  if (!session) return { ok: false, message: 'NOT running under the cl wrapper (launch with `cl`).' };
  let C, cfg;
  try { C = require('./cl-config'); cfg = C.loadConfig(); }
  catch (e) { return { ok: false, message: `cl config unreadable (${e.message}).` }; }

  const tokens = (argStr || '').trim().split(/\s+/).filter(Boolean);
  const isConfirm = tokens.some((t) => CONFIRM_WORDS.has(t.toLowerCase()));
  const id = tokens.find((t) => !t.startsWith('-') && !CONFIRM_WORDS.has(t.toLowerCase()));
  if (!id) return { ok: false, message: 'usage: cl:remove-account <id>   (then confirm) — an account id is required.' };

  const acc = C.findAccount(cfg, id);
  if (!acc) return { ok: false, message: `no account "${id}". Configured: ${cfg.accounts.map((a) => a.id).join(', ')}.` };
  if (cfg.accounts.length < 2) return { ok: false, message: `refusing to remove the LAST account ("${acc.id}") — cl needs at least one.` };

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
      + `  Move one off now: cl:switch ${newDefault} in it.\n`
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
        `  • cl-config.json is backed up first; references (switch order / default) are auto-fixed\n` +
        `  • its captured login file is KEPT (never deleted) so removal is recoverable\n` +
        `  CONFIRM within 2 min:  cl:remove-account ${acc.id} confirm     ·     or ignore this to cancel`,
    };
  }

  // STEP 2 — require a fresh pending marker for THIS id (enforces the two-step).
  let pend = null;
  try { pend = JSON.parse(fs.readFileSync(pendingRmPath(session), 'utf8')); } catch {}
  if (!pend || pend.id !== acc.id || Date.now() - pend.at > 120_000) {
    return { ok: false, message: `no pending confirmation for "${acc.id}" (or it expired) — run \`cl:remove-account ${acc.id}\` first to review what will be removed.` };
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
      (res.credFile ? `  its login file was KEPT at ${res.credFile} — delete it yourself if you want it gone.\n` : '') +
      `  reverse it by restoring the backup: ${res.backup}`,
  };
}

// ---- delete current session (double-confirmed, moves to recoverable trash) ---
function pendingDelPath(session) { return path.join(CACHE_DIR, `cl-delpending-${session}.json`); }

// The conversation id THIS cl session is on.
function sessionConvId(session) {
  for (const p of [path.join(CACHE_DIR, `cl-state-${session}.json`), path.join(CACHE_DIR, `cl-active-${session}.json`)]) {
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); if (j.convId) return j.convId; } catch {}
  }
  return null;
}

// Two-step deletion of the CURRENT conversation. Step 1 (bare `cl:delete`) shows
// the impact and arms a 2-min pending marker; step 2 (`cl:delete confirm`) drops
// a delete trigger — cl-runner kills claude, moves the transcript to recoverable
// trash, and starts a FRESH session. Returns { ok, pending?, deleting?, message }.
function requestDelete(session, argStr) {
  if (!session) return { ok: false, message: 'NOT running under the cl wrapper (launch with `cl`).' };
  const convId = sessionConvId(session);
  if (!convId) return { ok: false, message: 'no current conversation id yet (the statusline hasn\'t bridged it) — try again in a moment.' };

  let fp = null;
  try { fp = require('./cl-sync').findTranscriptFile(convId); } catch {}
  if (!fp) {
    // No transcript = an EMPTY session (no messages saved yet) → nothing to trash.
    // This is the usual "cl:delete did nothing" case: you delete a chat, a fresh
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
        `  • it is MOVED to recoverable trash, never hard-deleted (cl:trash to list/restore/purge)\n` +
        `  • this conversation ENDS and a fresh empty session starts in its place\n` +
        `  CONFIRM within 2 min:  cl:delete confirm     ·     or ignore this to cancel`,
    };
  }

  let pend = null;
  try { pend = JSON.parse(fs.readFileSync(pendingDelPath(session), 'utf8')); } catch {}
  if (!pend || pend.convId !== convId || Date.now() - pend.at > 120_000) {
    return { ok: false, message: `no pending confirmation for this conversation (or it expired) — run \`cl:delete\` first to review.` };
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `cl-delete-${session}.trigger`), JSON.stringify({ at: Date.now(), convId }));
    fs.unlinkSync(pendingDelPath(session));
  } catch (e) { return { ok: false, message: `delete signal FAILED — ${e.message}` }; }
  return { ok: true, deleting: true, message: `deleting this conversation and starting fresh — one moment…` };
}

// Drop a restart trigger. Returns { ok, message }. Never throws.
function requestRestart(session) {
  if (!session) {
    return { ok: false, message: 'NOT RESTARTING — this session is not running under the cl wrapper (launch with `cl`).' };
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `cl-restart-${session}.trigger`), JSON.stringify({ at: Date.now() }));
    return { ok: true, message: 'RESTARTING — the wrapper will reload and relaunch this conversation momentarily.' };
  } catch (e) {
    return { ok: false, message: `restart signal FAILED — ${e.message}` };
  }
}

// ---- cl:trash — list / restore / permanently empty the conversation trash --
// (~/.claude/backups/cl-deleted-*, written by cl:delete). Pure file ops that run
// synchronously in the hook — zero tokens, no relaunch. `plain: true` results are
// self-contained readouts (rendered uncolored, like cl:peek).
function pendingPurgePath(session) { return path.join(CACHE_DIR, `cl-purgepending-${session || 'terminal'}.json`); }

function requestTrash(session, argStr) {
  const sync = require('./cl-sync');
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
          `  CONFIRM within 2 min:  cl:trash empty confirm     ·     or ignore this to cancel`,
      };
    }
    let pend = null;
    try { pend = JSON.parse(fs.readFileSync(pendingPurgePath(session), 'utf8')); } catch {}
    if (!pend || Date.now() - pend.at > 120_000) {
      return { ok: false, message: 'no pending confirmation (or it expired) — run `cl:trash empty` first to review what gets purged.' };
    }
    try { fs.unlinkSync(pendingPurgePath(session)); } catch {}
    const r = sync.emptyTrash();
    return r.ok
      ? { ok: true, message: `✓ trash emptied — permanently deleted ${r.count} conversation${r.count > 1 ? 's' : ''} (${sync.human(r.bytes)}).` }
      : { ok: false, message: `purge INCOMPLETE — ${r.failed} trash folder(s) would not delete (file in use?). cl:trash shows what's left.` };
  }

  if (sub && sub !== 'list') {
    return { ok: false, message: `unknown trash action "${toks[0]}" — use: cl:trash · cl:trash restore <id> · cl:trash empty` };
  }

  const entries = sync.listTrash();
  if (!entries.length) return { ok: true, plain: true, message: 'trash — empty. (cl:delete moves conversations here; nothing is hard-deleted until cl:trash empty.)' };
  const bytes = entries.reduce((s, e) => s + e.bytes, 0);
  const lines = [`trash — ${entries.length} deleted conversation${entries.length > 1 ? 's' : ''}, ${sync.human(bytes)} total`];
  for (const e of entries) {
    lines.push(`  ${e.convId.slice(0, 8)}  ${sync.human(e.bytes).padStart(9)}  deleted ${e.deletedAt}  ${e.proj}${e.sidecar ? '  (+sidecar)' : ''}`);
  }
  lines.push('', '  restore one:  cl:trash restore <id>        purge all:  cl:trash empty');
  return { ok: true, plain: true, message: lines.join('\n') };
}

module.exports = { requestSwitch, requestRestart, requestPicker, requestAddAccount, requestRemoveAccount, requestDelete, requestTrash, currentAccount, buildPeek, chooseLaunchAccount, accountHeadroom, readUsageCache, addApiAccountResolved, readAddKey, CACHE_DIR };
