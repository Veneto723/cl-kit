#!/usr/bin/env node
// cl-kit test suite — Windows 11. Pure Node built-ins, no dependencies, no
// interactive `claude`, no GUI. Every test runs against a THROWAWAY HOME under the
// temp dir (never the real ~/.claude); CI runs it on windows-latest. Section 7
// exercises the real Windows key path (a DPAPI round-trip via powershell.exe).
//
//   node test/run.js
//
// Two sections:
//   • CORE — asserts the engine (config, per-account credential isolation, trash,
//     peek, gateway usage, the board). A failure here fails the build.
//   • PROBE — reports environment touchpoints (junction support, claude bin).
//     Informational only — it never fails the build.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

// ---- throwaway HOME (must be set BEFORE requiring any src module, since
// arc-config computes CLAUDE_DIR = homedir()/.claude at load time) --------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'clkit-test-'));
process.env.HOME = TMP;          // POSIX homedir()
process.env.USERPROFILE = TMP;   // Windows homedir()
process.env.CL_PEEK_NO_REFRESH = '1'; // hermetic: buildPeek must not spawn a network refresh in tests
// Sanity: confirm the override took (libuv uv_os_homedir honors HOME/USERPROFILE).
if (path.resolve(os.homedir()) !== path.resolve(TMP)) {
  console.error(`FATAL: could not sandbox HOME (homedir=${os.homedir()} tmp=${TMP})`);
  process.exit(2);
}
const CLAUDE = path.join(TMP, '.claude');
fs.mkdirSync(CLAUDE, { recursive: true });

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

console.log(`cl-kit tests · ${process.platform} · node ${process.version} · HOME=${TMP}`);

// ---- 1. syntax check every shipped .js --------------------------------------
section('syntax (node --check, all platforms)');
const jsFiles = [];
for (const d of ['src', 'mcp', 'pool', 'test']) {
  const dir = path.join(ROOT, d);
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) jsFiles.push(path.join(dir, f)); } catch {}
}
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  ok(`--check ${path.relative(ROOT, f)}`, r.status === 0, (r.stderr || '').split('\n')[0]);
}

// A .ps1 containing NON-ASCII (we use em-dashes in comments) MUST carry a UTF-8 BOM.
// Windows PowerShell 5.1 — which is what the documented `powershell -File install.ps1`
// actually runs — decodes a BOM-less file as ANSI, mangling those bytes into mojibake
// that breaks the PARSER. install.ps1 was silently unrunnable that way; it only worked
// under pwsh 7. This guards the whole class, not just the one file.
const psFiles = [];
(function walkPs(dir) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkPs(p);
    else if (e.name.endsWith('.ps1')) psFiles.push(p);
  }
})(ROOT);
for (const f of psFiles) {
  const buf = fs.readFileSync(f);
  const hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  const nonAscii = buf.slice(hasBom ? 3 : 0).some((b) => b > 0x7f);
  ok(`${path.relative(ROOT, f)}: BOM present if non-ASCII (PS 5.1 parses it)`, !nonAscii || hasBom,
    'non-ASCII without a UTF-8 BOM — Windows PowerShell 5.1 will mis-decode and fail to parse');
}

// ---- helpers -----------------------------------------------------------------
function writeJSON(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }
const OAUTH_CRED = { claudeAiOauth: { accessToken: 'tok-TEST', subscriptionType: 'max' } };

// ---- 2. arc-config (portable core) -------------------------------------------
section('arc-config');
let C;
try {
  // A config with an oauth account + an api account keyed by ENV VAR (no DPAPI,
  // which is Windows-only) — everything here must resolve on any OS.
  writeJSON(path.join(CLAUDE, 'arc-config.json'), {
    version: 1, defaultAccount: 'sub', switchOrder: ['sub', 'gw'],
    accounts: [
      { id: 'sub', type: 'oauth', label: 'SUB' },
      { id: 'gw', type: 'api', label: 'GW', baseUrl: 'https://gw.example.com', apiKeyEnv: 'CLKIT_TEST_KEY', modelMap: { opus: 'big', sonnet: 'mid' } },
    ],
  });
  process.env.CLKIT_TEST_KEY = 'sk-test-123';
  C = require(path.join(SRC, 'arc-config.js'));
  const cfg = C.loadConfig();
  ok('loadConfig returns both accounts', cfg.accounts.length === 2);
  ok('findAccount resolves by id', !!C.findAccount(cfg, 'sub') && !!C.findAccount(cfg, 'gw'));
  ok('findAccount unknown -> null', C.findAccount(cfg, 'nope') === null);
  const env = C.accountEnv(C.findAccount(cfg, 'gw'), {});
  ok('accountEnv sets gateway key + base url + model map',
    env.ANTHROPIC_API_KEY === 'sk-test-123' && env.ANTHROPIC_BASE_URL === 'https://gw.example.com' && env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'big');
  const oenv = C.accountEnv(C.findAccount(cfg, 'sub'), { ANTHROPIC_API_KEY: 'leak' });
  ok('accountEnv strips gateway vars for oauth', oenv.ANTHROPIC_API_KEY === undefined);
  ok('claudeBin resolves to a string', typeof C.claudeBin(cfg) === 'string' && C.claudeBin(cfg).length > 0);

  // ---- per-account env: a gateway serving a FOREIGN model needs harness accommodations,
  // and those must not survive a switch back to a normal account.
  const gwx = { id: 'gwx', type: 'api', baseUrl: 'https://x.example.com', apiKeyEnv: 'CLKIT_TEST_KEY',
    modelMap: { opus: 'gpt-x' }, env: { ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '3' } };
  const xenv = C.accountEnv(gwx, {});
  ok('accountEnv applies an account\'s env map (harness accommodations)',
    xenv.ENABLE_TOOL_SEARCH === 'false' && xenv.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY === '3'
    && xenv.ANTHROPIC_DEFAULT_OPUS_MODEL === 'gpt-x');
  ok('...and RECORDS which keys it injected, so the next launch can strip exactly those',
    (xenv.ARC_ACCOUNT_ENV_KEYS || '').split(',').sort().join() === 'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY,ENABLE_TOOL_SEARCH');

  // THE bug this guards: arc switches by re-launching from the CURRENT env. Without the
  // strip, switching gwx -> sub would leave ENABLE_TOOL_SEARCH=false silently set on the
  // subscription, with nothing in its config to explain it.
  const back = C.accountEnv(C.findAccount(cfg, 'sub'), xenv);
  ok('switching AWAY unsets the previous account\'s env (no silent leak onto the next account)',
    back.ENABLE_TOOL_SEARCH === undefined && back.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY === undefined
    && back.ARC_ACCOUNT_ENV_KEYS === undefined);

  // A proxy serving a FOREIGN model pins the primary model outright (the documented lever).
  const claudex = { id: 'cx', type: 'api', baseUrl: 'https://proxy.local', apiKeyEnv: 'CLKIT_TEST_KEY',
    model: 'gpt-5.6-sol', modelMap: { opus: 'gpt-5.6-sol', sonnet: 'gpt-5.6-sol' } };
  const cxenv = C.accountEnv(claudex, {});
  ok('an account with `model` pins ANTHROPIC_MODEL (a foreign model behind an Anthropic API)',
    cxenv.ANTHROPIC_MODEL === 'gpt-5.6-sol' && cxenv.ANTHROPIC_DEFAULT_OPUS_MODEL === 'gpt-5.6-sol');
  ok('a normal Claude gateway does NOT pin ANTHROPIC_MODEL (/model stays free to choose)',
    C.accountEnv(C.findAccount(cfg, 'gw'), {}).ANTHROPIC_MODEL === undefined);
  // THE leak: switching cx -> subscription must not leave Claude asking Anthropic for a GPT model.
  ok('switching away from it CLEARS ANTHROPIC_MODEL (else the subscription asks for a model Anthropic never heard of)',
    C.accountEnv(C.findAccount(cfg, 'sub'), cxenv).ANTHROPIC_MODEL === undefined);

  // arc's own control plane and the routing vars are off-limits to an env map.
  const evil = C.accountEnv({ id: 'e', type: 'oauth', env: { ARC_SESSION: 'hijack', ANTHROPIC_BASE_URL: 'http://evil', OK_VAR: 'y' } },
    { ARC_SESSION: 'real-session' });
  ok('an env map cannot hijack ARC_* or the routing vars (but ordinary keys still apply)',
    evil.ARC_SESSION === 'real-session' && evil.ANTHROPIC_BASE_URL === undefined && evil.OK_VAR === 'y');
  ok('envKeyAllowed rejects ARC_*/routing vars, accepts ordinary names',
    !C.envKeyAllowed('ARC_SESSION') && !C.envKeyAllowed('ANTHROPIC_API_KEY') && !C.envKeyAllowed('bad name')
    && C.envKeyAllowed('ENABLE_TOOL_SEARCH'));
} catch (e) { ok('arc-config loads', false, e.message); }

// ---- 2b. arc-switch-core: chooseLaunchAccount (launch account selection) -------
// Regression: a plain API gateway with NO usage metrics (headroom=null) was excluded
// as a candidate, so launch fell back to a 100%-EXHAUSTED subscription instead of the
// available gateway. A gateway with no tracked limit must count as available.
section('arc-switch-core (launch account selection)');
try {
  const core = require(path.join(SRC, 'arc-switch-core.js'));
  const SUB = { id: 'max', type: 'oauth', label: 'MAX' };
  const GW = { id: 'whale', type: 'api', label: 'GW', baseUrl: 'https://x' };
  const cfg = (accts) => ({ accounts: accts, defaultAccount: accts[0].id, thresholds: {} });
  const subUse = (fh) => ({ usage: { data: { five_hour: { utilization: fh }, seven_day: { utilization: 0 } } } });
  const withPool = (c, fh, status = 'active') => ({ ...c, pool: { rows: [{ status, reason_code: status === 'active' ? null : 'rate_limited', fh }] } });
  const pick = (c, cache) => (core.chooseLaunchAccount(c, cache) || {}).id;

  ok('sub with headroom wins (prefer the subscription)', pick(cfg([SUB, GW]), subUse(10)) === 'max');
  ok('THE FIX: exhausted sub + no-metrics gateway -> the GATEWAY', pick(cfg([SUB, GW]), subUse(100)) === 'whale');
  ok('exhausted sub + gateway with measured headroom -> gateway', pick(cfg([SUB, GW]), withPool(subUse(100), 20)) === 'whale');
  ok('OPTIMISM: exhausted sub + gateway measured busy -> STILL the gateway', pick(cfg([SUB, GW]), withPool(subUse(100), 100, 'cooldown')) === 'whale');
  ok('sub-only (no gateway), sub exhausted -> least-bad sub', pick(cfg([SUB]), subUse(100)) === 'max');
  ok('no cache -> null (do not guess)', core.chooseLaunchAccount(cfg([SUB, GW]), null) === null);
  ok('api-only config, no metrics -> the gateway', pick(cfg([GW]), subUse(100)) === 'whale');
  // reasons must be HONEST about which gateway state was picked (guards the `null >= 0`
  // JS-coercion trap that mislabels a no-metrics gateway as "most available").
  const reason = (c, cache) => core.chooseLaunchAccount(c, cache).reason;
  ok('no-metrics gateway is labelled "assumed available"', /assumed available/.test(reason(cfg([SUB, GW]), subUse(100))));
  ok('measured-headroom gateway is labelled "most available"', /most available/.test(reason(cfg([SUB, GW]), withPool(subUse(100), 20))));
  ok('busy gateway is labelled "optimistic"', /optimistic/.test(reason(cfg([SUB, GW]), withPool(subUse(100), 100, 'cooldown'))));
} catch (e) { ok('chooseLaunchAccount works', false, e.message); }

// ---- 2b. per-account subscription usage attribution --------------------------
// Regression: subscription usage lived in ONE un-keyed slice (cache.usage), fetched
// with whichever account happened to be active. Right after a switch it was still
// TTL-fresh, so the PREVIOUS account's numbers were painted under the new account's
// label (and, looking fresh, suppressed the refresh that would have fixed them);
// arc:peek and auto-select scored every oauth account off that same blob.
section('arc-switch-core (per-account usage attribution)');
try {
  const core = require(path.join(SRC, 'arc-switch-core.js'));
  const A = { id: 'veneto', type: 'oauth', label: 'veneto' };
  const B = { id: 'whale', type: 'oauth', label: 'whale' };
  const cfg2 = { accounts: [A, B], defaultAccount: 'veneto', thresholds: {} }; // two subs
  const cfg1 = { accounts: [A], defaultAccount: 'veneto', thresholds: {} };    // one sub
  const slice = (fh, sd) => ({ fetchedAt: Date.now(), data: { five_hour: { utilization: fh }, seven_day: { utilization: sd } } });

  const keyed = { usageByAccount: { veneto: slice(96, 52), whale: slice(17, 96) } };
  const sA = core.oauthUsageSlice(A, keyed, cfg2);
  const sB = core.oauthUsageSlice(B, keyed, cfg2);
  ok('each oauth account reads its OWN slice', sA.data.five_hour.utilization === 96 && sB.data.five_hour.utilization === 17);

  const TH = { switchSessionPct: 92, switchWeekPct: 95 };
  ok('veneto exhausted via its own 5h (96 >= 92)', core.accountHeadroom(A, keyed, TH, cfg2) === -1);
  ok('whale exhausted via its own 7d (96 >= 95)', core.accountHeadroom(B, keyed, TH, cfg2) === -1);

  // A healthy account must keep its headroom even when its peer is exhausted.
  const mixed = { usageByAccount: { veneto: slice(10, 10), whale: slice(99, 99) } };
  ok('healthy account keeps headroom while peer is exhausted',
    core.accountHeadroom(A, mixed, {}, cfg2) === 90 && core.accountHeadroom(B, mixed, {}, cfg2) === -1);
  ok('auto-select picks the account that actually has headroom',
    (core.chooseLaunchAccount(cfg2, mixed) || {}).id === 'veneto');

  // THE BUG: an un-keyed legacy blob has no owner. With two subs it must not be
  // handed to either — better to admit ignorance than to mis-attribute.
  const legacy = { usage: slice(5, 5) };
  ok('legacy un-keyed blob is applied to NEITHER of two oauth accounts',
    core.oauthUsageSlice(A, legacy, cfg2) === null && core.oauthUsageSlice(B, legacy, cfg2) === null);
  ok('...so auto-select refuses to guess rather than mis-attribute',
    core.chooseLaunchAccount(cfg2, legacy) === null);

  // With exactly ONE oauth account the legacy blob is unambiguous — still honoured,
  // so an existing single-subscription install keeps working across the upgrade.
  ok('legacy blob still honoured when a single oauth account owns it',
    core.oauthUsageSlice(A, legacy, cfg1).data.five_hour.utilization === 5);

  const both = { usage: slice(1, 1), usageByAccount: { veneto: slice(42, 7) } };
  ok('a keyed slice beats the legacy blob', core.oauthUsageSlice(A, both, cfg1).data.five_hour.utilization === 42);

  // usageCacheFresh gates the launch-time refresh: fresh cache → skip, stale/missing
  // → refresh. Ages only accounts that still exist; never throws. (3rd arg injects
  // a fixture cache; on the real call site it reads the on-disk cache.)
  const aged = (ms) => ({ fetchedAt: Date.now() - ms, data: { five_hour: { utilization: 1 }, seven_day: { utilization: 1 } } });
  const freshBoth = { usageByAccount: { veneto: aged(1000), whale: aged(2000) } };
  ok('both accounts fresh → cache is fresh (skip launch refresh)', core.usageCacheFresh(cfg2, 60_000, freshBoth) === true);
  ok('one account stale → not fresh (refresh)', core.usageCacheFresh(cfg2, 60_000, { usageByAccount: { veneto: aged(1000), whale: aged(120_000) } }) === false);
  ok('one account missing its slice → not fresh (refresh)', core.usageCacheFresh(cfg2, 60_000, { usageByAccount: { veneto: aged(1000) } }) === false);
  ok('a removed account\'s ancient slice is IGNORED (only configured accounts aged)',
    core.usageCacheFresh(cfg2, 60_000, { usageByAccount: { veneto: aged(1000), whale: aged(2000), GHOST: aged(9_000_000) } }) === true);
  ok('empty cache → not fresh', core.usageCacheFresh(cfg2, 60_000, {}) === false);
  ok('no accounts → not fresh (caller must refresh)', core.usageCacheFresh({ accounts: [] }, 60_000, freshBoth) === false);
  ok('null cfg → not fresh', core.usageCacheFresh(null, 60_000, freshBoth) === false);
} catch (e) { ok('per-account usage attribution works', false, e.message); }

// ---- 2c. near/over-limit alert shows the BINDING window's reset --------------
// The compact statusline's "nearing/limit reached" alert used to drop the reset
// time the normal line shows. A near-limit 5h window may clear in a minute (skip the
// switch) while the weekly cap is stuck for days (do switch) — so the alert must say
// WHICH, and when.
section('usage-monitor (binding-window reset on alerts)');
try {
  const um = require(path.join(SRC, 'usage-monitor.js'));
  const soon = new Date(Date.now() + 7 * 60_000).toISOString();       // 5h clears soon
  const far = new Date(Date.now() + 3 * 86_400_000).toISOString();    // 7d clears in days
  const s = (u, r) => ({ utilization: u, resets_at: r });
  const SW_WEEK = 95;

  // nearing/over on the 5h session, week fine -> the SHORT window's reset.
  ok('session-bound alert shows the 5h reset', um.bindingResetLabel(s(86, soon), s(13, far), SW_WEEK) === um.formatResetTime(soon));
  ok('session-OVER alert shows the 5h reset', um.bindingResetLabel(s(95, soon), s(40, far), SW_WEEK) === um.formatResetTime(soon));
  // weekly cap over threshold -> the FAR weekly reset (the real blocker).
  ok('week-over alert shows the 7d reset', um.bindingResetLabel(s(40, soon), s(97, far), SW_WEEK) === um.formatResetTime(far));
  ok('both-over alert: weekly cap dominates -> 7d reset', um.bindingResetLabel(s(95, soon), s(97, far), SW_WEEK) === um.formatResetTime(far));
  // fall back to the other window when the binding one has no reset time (null).
  ok('null 5h reset falls back to the 7d reset', um.bindingResetLabel(s(90, null), s(13, far), SW_WEEK) === um.formatResetTime(far));
  ok('requiring usage-monitor does not run main (no stray output)', typeof um.bindingResetLabel === 'function');
} catch (e) { ok('binding-window reset works', false, e.message); }

// ---- 3. arc-profile — the per-account credential ISOLATION fix ----------------
section('arc-profile (credential isolation)');
try {
  // hooks/statusLine to sync + a home .claude.json to seed
  writeJSON(path.join(CLAUDE, 'settings.json'), { hooks: { Stop: [] }, statusLine: { type: 'command', command: 'x' }, permissions: { allow: [] }, theme: 'dark' });
  fs.writeFileSync(path.join(TMP, '.claude.json'), JSON.stringify({ mcpServers: { arc: { type: 'stdio' } }, oauthAccount: { email: 'x@y.z' } }));
  // a real shared transcript, to prove the junction/symlink shares the "brain"
  const projDir = path.join(CLAUDE, 'projects', 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'c1.jsonl'), '{"t":1}\n');

  const P = require(path.join(SRC, 'arc-profile.js'));
  const dirA = P.ensureProfile('acctA');
  ok('ensureProfile creates the profile dir', fs.existsSync(dirA));
  // The junction (Windows) / symlink (POSIX) must make the shared transcript visible.
  ok('shared projects reachable through the profile (junction/symlink works on this OS)',
    fs.existsSync(path.join(dirA, 'projects', 'proj', 'c1.jsonl')));
  const ps = JSON.parse(fs.readFileSync(path.join(dirA, 'settings.json'), 'utf8'));
  ok('cl-owned settings synced (hooks/statusLine/permissions)', ps.hooks && ps.statusLine && ps.permissions);
  ok('non-cl settings NOT synced (theme left per-profile)', ps.theme === undefined);
  const cj = JSON.parse(fs.readFileSync(path.join(dirA, '.claude.json'), 'utf8'));
  ok('.claude.json seeded with mcp servers, oauthAccount stripped', cj.mcpServers && cj.mcpServers.arc && cj.oauthAccount === undefined);

  ok('fresh profile hasCreds=false', P.hasCreds('acctA') === false);
  const src = path.join(TMP, 'seed.json'); fs.writeFileSync(src, JSON.stringify(OAUTH_CRED));
  ok('seedCreds fills an empty profile', P.seedCreds('acctA', src) === true && P.hasCreds('acctA'));
  const src2 = path.join(TMP, 'seed2.json'); fs.writeFileSync(src2, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-OTHER' } }));
  ok('seedCreds REFUSES to overwrite an existing login', P.seedCreds('acctA', src2) === false && fs.readFileSync(P.credsPath('acctA'), 'utf8').includes('tok-TEST'));

  // THE fix: two accounts => two distinct credential files (no shared file to hijack).
  P.ensureProfile('acctB'); P.seedCreds('acctB', src2);
  ok('two accounts -> distinct credential files (isolation)',
    P.credsPath('acctA') !== P.credsPath('acctB') &&
    fs.readFileSync(P.credsPath('acctA'), 'utf8').includes('tok-TEST') &&
    fs.readFileSync(P.credsPath('acctB'), 'utf8').includes('tok-OTHER'));
  ok('ensureProfile is idempotent', P.ensureProfile('acctA') === dirA);

  // removeProfile: account removal must QUARANTINE the profile dir (recoverable),
  // never abandon it in place — that abandonment is what stranded MAX/work.
  const dirB = P.profileDir('acctB');
  const trashed = P.removeProfile('acctB');
  ok('removeProfile returns a .trash path (moved, not hard-deleted)',
    !!trashed && trashed.startsWith(path.join(P.PROFILES_DIR, '.trash')) && fs.existsSync(trashed));
  ok('...the original profile dir is GONE (no orphan left in arc-profiles)', !fs.existsSync(dirB));
  ok('...the login survives in trash, so removal is recoverable',
    fs.existsSync(path.join(trashed, '.credentials.json')) &&
    fs.readFileSync(path.join(trashed, '.credentials.json'), 'utf8').includes('tok-OTHER'));
  ok('removing one account leaves the others untouched', fs.existsSync(P.profileDir('acctA')));
  ok('removeProfile on a nonexistent account is a safe no-op (null)', P.removeProfile('never-existed') === null);
  // the graveyard must never be mistaken for a profile: account ids can't start with '.'
  ok('.trash is outside the account namespace', !/^[a-z]/i.test(path.basename(path.join(P.PROFILES_DIR, '.trash'))));
} catch (e) { ok('arc-profile works', false, e.message); }

// ---- 4. arc-sync — trash (list / restore / empty / transcriptMeta) ------------
section('arc-sync (trash)');
try {
  const sync = require(path.join(SRC, 'arc-sync.js'));
  const proj = path.join(CLAUDE, 'projects', 'E--demo');
  fs.mkdirSync(proj, { recursive: true });
  const cid = '11111111-2222-3333-4444-555555555555';
  const jl = [
    { type: 'custom-title', customTitle: 'my chat' },
    { type: 'ai-title', aiTitle: 'Doing a thing' },
    { type: 'user', message: { content: 'hello' }, cwd: '/tmp/demo', timestamp: '2026-07-01T10:00:00.000Z' },
    { type: 'assistant', message: { content: 'hi' }, timestamp: '2026-07-01T10:01:00.000Z' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n';
  fs.writeFileSync(path.join(proj, cid + '.jsonl'), jl);

  const t = sync.trashSession(cid);
  ok('trashSession moves the transcript', t.moved.includes('transcript') && !fs.existsSync(path.join(proj, cid + '.jsonl')));
  const list = sync.listTrash();
  ok('listTrash finds it', list.length === 1 && list[0].convId === cid);
  const meta = sync.transcriptMeta(list[0].file);
  ok('transcriptMeta reads titles + turns', meta.customTitle === 'my chat' && meta.aiTitle === 'Doing a thing' && meta.turns === 2);
  const r = sync.restoreSession(cid.slice(0, 8));
  ok('restoreSession puts it back', r.ok && fs.existsSync(path.join(proj, cid + '.jsonl')) && sync.listTrash().length === 0);
  // empty
  sync.trashSession(cid);
  const e = sync.emptyTrash();
  ok('emptyTrash purges', e.ok && sync.listTrash().length === 0);
} catch (e) { ok('arc-sync works', false, e.message); }

// ---- arc-sync export selectors: `all` = THIS project, `global` = everything -------
section('arc-sync (export selectors)');
try {
  const sync = require(path.join(SRC, 'arc-sync.js'));

  // Claude Code names a project dir after the cwd, non-alphanumerics -> '-'
  ok('encodeProject: drive root', sync.encodeProject('E:\\') === 'E--');
  ok('encodeProject: nested dir', sync.encodeProject('E:\\cl-kit') === 'E--cl-kit');
  ok('encodeProject: deep path', sync.encodeProject('C:\\Users\\yanyu\\AppData\\Local\\Temp') === 'C--Users-yanyu-AppData-Local-Temp');

  const fake = [
    { project: 'E--', id: 'conv-here', size: 1 },
    { project: 'E--', id: 'conv-sibling', size: 1 },
    { project: 'E--whalephone', id: 'conv-other', size: 1 },
  ];
  const cacheDir = path.join(CLAUDE, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const S = 'expsess';

  // exact path: the dir holding the CURRENT conversation wins (no encoding guess)
  fs.writeFileSync(path.join(cacheDir, `arc-state-${S}.json`), JSON.stringify({ convId: 'conv-here', cwd: 'E:\\somewhere-else' }));
  ok('currentProject uses the dir holding the current conversation', sync.currentProject(S, fake) === 'E--');

  // fallback: no convId -> encode the LAUNCH cwd, accepted only if that dir exists
  fs.writeFileSync(path.join(cacheDir, `arc-state-${S}.json`), JSON.stringify({ cwd: 'E:\\whalephone' }));
  ok('currentProject falls back to the encoded launch cwd', sync.currentProject(S, fake) === 'E--whalephone');

  // fallback rejects a cwd with no matching project dir
  fs.writeFileSync(path.join(cacheDir, `arc-state-${S}.json`), JSON.stringify({ cwd: 'Z:\\nothing-here' }));
  ok('currentProject returns null when it cannot tell', sync.currentProject(S, fake) === null);

  // and doExport refuses `all` (rather than guessing) when the project is unknown
  const r = sync.doExport(S, 'all');
  ok('`arc:export all` refuses when the project is undeterminable', r.ok === false && /which project folder/.test(r.message));
  ok('  and it points at `arc:export global`', /arc:export global/.test(r.message));

  try { fs.unlinkSync(path.join(cacheDir, `arc-state-${S}.json`)); } catch {}
} catch (e) { ok('arc-sync export selectors work', false, e.message); }

// ---- arc:import destination: a BARE positional == --dest ------------------------
// Regression: `arc:import <archive> E:` silently IGNORED the `E:` — the import ran with
// no re-rooting and landed in the archive's original project dir, so --dest looked
// broken. The bare form is what people actually type; it must mean the same as the flag.
section('arc-sync (import destination)');
try {
  const sync = require(path.join(SRC, 'arc-sync.js'));
  const tgz = path.join(TMP, 'fake.tgz');
  fs.writeFileSync(tgz, 'not-a-real-archive');       // must exist; we never get as far as untar

  // an absolute bare positional is accepted as the destination (no "must be absolute" error)
  const bare = sync.doImport('nosess', `"${tgz}" E: --dry-run`);
  ok('bare positional dest is not rejected as non-absolute', !/must be an ABSOLUTE/.test(bare.message));

  // a RELATIVE bare positional is caught and explained (not silently ignored, as before)
  const rel = sync.doImport('nosess', `"${tgz}" not-absolute --dry-run`);
  ok('a relative bare dest is REFUSED, not ignored', rel.ok === false && /must be an ABSOLUTE/.test(rel.message));
  ok('  and the error shows BOTH forms', /--dest/.test(rel.message) && /arc:import <archive>/.test(rel.message));

  // the explicit flag is still honoured, and wins over a positional
  const flag = sync.doImport('nosess', `"${tgz}" --dest bad-relative --dry-run`);
  ok('an explicit --dest is still validated', flag.ok === false && /must be an ABSOLUTE/.test(flag.message));
  ok('the flag WINS over a bare positional', /bad-relative/.test(
    sync.doImport('nosess', `"${tgz}" E: --dest bad-relative --dry-run`).message));

  // a missing archive is still the first thing reported
  ok('a missing archive still errors first', /archive not found/.test(sync.doImport('nosess', 'nope.tgz E:').message));
  fs.unlinkSync(tgz);
} catch (e) { ok('arc-sync import destination works', false, e.message); }

// ---- arc-sync — arc:import --dest re-rooting (office/home path parity) ----------
section('arc-sync (import --dest re-rooting)');
try {
  const sync = require(path.join(SRC, 'arc-sync.js'));

  // pure helpers
  ok('tokenize: quoted path with spaces is one token, quotes stripped',
    JSON.stringify(sync.tokenize('a.tgz --dest "E:\\my folder" --dry-run')) === JSON.stringify(['a.tgz', '--dest', 'E:\\my folder', '--dry-run']));
  ok('underPath: separator-boundary match', sync.underPath('E:\\proj\\sub', 'E:\\proj') === true && sync.underPath('E:\\project', 'E:\\proj') === false);
  ok('underPath: case-insensitive (Windows)', sync.underPath('e:\\PROJ\\x', 'E:\\proj') === true);
  ok('remapCwd: re-roots subdir, keeps tail', sync.remapCwd('E:\\whalephone\\src\\a', 'E:\\whalephone', 'E:\\whaletech\\whalephone') === 'E:\\whaletech\\whalephone\\src\\a');
  ok('remapCwd: exact path', sync.remapCwd('E:\\whalephone', 'E:\\whalephone', 'E:\\whaletech\\whalephone') === 'E:\\whaletech\\whalephone');
  ok('remapCwd: leaves an unrelated cwd alone', sync.remapCwd('C:\\other', 'E:\\whalephone', 'E:\\whaletech\\whalephone') === 'C:\\other');

  // sniffLaunchCwd: the launch cwd is the one whose encoding IS the project dir
  const sdir = path.join(TMP, 'sniff'); fs.mkdirSync(sdir, { recursive: true });
  const sfile = path.join(sdir, 's.jsonl');
  fs.writeFileSync(sfile, [
    JSON.stringify({ type: 'custom-title', customTitle: 't' }),                 // no cwd
    JSON.stringify({ type: 'user', cwd: 'E:\\whaletech\\secrets-vault' }),      // a drifted cwd (encode != proj)
    JSON.stringify({ type: 'user', cwd: 'E:\\whalephone' }),                    // the launch cwd (encode == proj)
  ].join('\n') + '\n');
  ok('sniffLaunchCwd finds the cwd whose encoding == the project dir', sync.sniffLaunchCwd(sfile, 'E--whalephone') === 'E:\\whalephone');
  ok('sniffLaunchCwd: null when nothing matches', sync.sniffLaunchCwd(sfile, 'E--nope') === null);

  // copyRemappingCwd: rewrites matching cwds, leaves others + non-cwd lines intact
  const cdst = path.join(sdir, 'out.jsonl');
  const n = sync.copyRemappingCwd(sfile, cdst, 'E:\\whalephone', 'E:\\whaletech\\whalephone');
  const outLines = fs.readFileSync(cdst, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  ok('copyRemappingCwd rewrites only the matching cwd (count=1)', n === 1);
  ok('  the launch cwd is re-rooted', outLines[2].cwd === 'E:\\whaletech\\whalephone');
  ok('  a drifted, unrelated cwd is untouched', outLines[1].cwd === 'E:\\whaletech\\secrets-vault');
  ok('  a line with no cwd is preserved', outLines[0].customTitle === 't');

  // full end-to-end: build a real archive, import with --dest, verify placement + rewrite
  if (has('tar', ['--version'])) {
    const expRoot = path.join(TMP, 'exp'); fs.mkdirSync(expRoot, { recursive: true });
    const cid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const sp = path.join(expRoot, 'E--whalephone'); fs.mkdirSync(sp, { recursive: true });
    fs.writeFileSync(path.join(sp, cid + '.jsonl'), [
      JSON.stringify({ type: 'user', cwd: 'E:\\whalephone', message: { content: 'hi' }, timestamp: '2026-07-01T10:00:00.000Z' }),
      JSON.stringify({ type: 'user', cwd: 'E:\\whalephone\\src', message: { content: 'in src' }, timestamp: '2026-07-01T10:01:00.000Z' }),
    ].join('\n') + '\n');
    // a "ghost" project whose launch cwd can't be recovered (no cwd encodes to its dir)
    const gid = 'ffffffff-0000-1111-2222-333333333333';
    const gp = path.join(expRoot, 'E--ghost'); fs.mkdirSync(gp, { recursive: true });
    fs.writeFileSync(path.join(gp, gid + '.jsonl'), JSON.stringify({ type: 'user', cwd: 'E:\\elsewhere' }) + '\n');

    const arc = path.join(TMP, 'exp.tgz');
    const packed = sync.runTar(['-czf', arc, '-C', expRoot, '.']);
    ok('portable tar invocation creates the import fixture', packed.status === 0 && fs.existsSync(arc), packed.stderr);
    const r = sync.doImport('imp-sess', `"${arc}" --dest "E:\\whaletech"`);

    const destProj = path.join(CLAUDE, 'projects', 'E--whaletech-whalephone', cid + '.jsonl');
    ok('doImport --dest: placed under the re-rooted project dir', r.ok && fs.existsSync(destProj), r.message);
    ok('  NOT left at the original project dir', !fs.existsSync(path.join(CLAUDE, 'projects', 'E--whalephone', cid + '.jsonl')));
    const dl = fs.existsSync(destProj)
      ? fs.readFileSync(destProj, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    ok('  stored cwd rewritten to the destination (launch)', dl[0] && dl[0].cwd === 'E:\\whaletech\\whalephone');
    ok('  stored cwd rewritten for a subdir too', dl[1] && dl[1].cwd === 'E:\\whaletech\\whalephone\\src');
    ok('  report shows the re-root plan', /E:\\whalephone.+→.+E:\\whaletech\\whalephone/.test(r.message));
    ok('  a project whose source path is unrecoverable is SKIPPED, not guessed',
      !fs.existsSync(path.join(CLAUDE, 'projects', 'E--ghost')) && /could not be recovered/.test(r.message));
  } else {
    ok('(tar unavailable — skipped the --dest end-to-end)', true);
  }
} catch (e) { ok('arc-sync --dest works', false, e.message); }

// ---- 5. arc-switch-core — peek + trash rendering ------------------------------
section('arc-switch-core');
try {
  const core = require(path.join(SRC, 'arc-switch-core.js'));
  const peek = core.buildPeek('no-session');
  ok('buildPeek returns a message (never throws)', peek && typeof peek.message === 'string' && peek.message.length > 0);
  const tr = core.requestTrash('no-session', '');
  ok('requestTrash list renders', tr && typeof tr.message === 'string');
  const del = core.requestDelete('', '');
  ok('requestDelete refuses outside a session', del.ok === false);
} catch (e) { ok('arc-switch-core works', false, e.message); }

// ---- 6. gw-usage — tolerant summarize ---------------------------------------
section('gw-usage');
try {
  const GW = require(path.join(SRC, 'gw-usage.js'));
  const s = GW.summarizeGatewayUsage({ usage: { today: 1.5 }, unit: 'USD', model_stats: [null, { model: 123 }, { model: 'x', tokens: 5 }] });
  ok('summarizeGatewayUsage tolerates null/non-string model rows', !!s);
} catch (e) { ok('gw-usage works', false, e.message); }

// ---- 7. arc-platform + storeApiKey (Windows key path: DPAPI) -------------------
// cl-kit is Windows 11 only, so this asserts the real DPAPI round-trip (via
// powershell.exe). It also proves the PORTABLE key sources (apiKeyEnv / apiKeyFrom)
// still resolve on Windows — only the POSIX OS-keychain source was dropped.
section('arc-platform + storeApiKey (DPAPI + portable key sources)');
try {
  const plat = require(path.join(SRC, 'arc-platform.js'));
  const clip = plat.readClipboard();
  ok('readClipboard returns a string or null (never throws)', clip === null || typeof clip === 'string');
  ok('clipboardHint is a string', typeof plat.clipboardHint() === 'string');
  ok('the POSIX keychain/notify helpers are gone', plat.keychainStore === undefined && plat.notify === undefined);

  // storeApiKey → a DPAPI blob (apiKeyEnc); resolveApiKey must decrypt it back.
  const stored = C.storeApiKey('gwtest', 'sk-dpapi-42');
  ok('storeApiKey returns an apiKeyEnc blob + note', !!stored.fields.apiKeyEnc && typeof stored.note === 'string');
  const acc = { id: 'gwtest', type: 'api', baseUrl: 'https://x', ...stored.fields };
  ok('resolveApiKey round-trips the DPAPI blob', C.resolveApiKey(acc) === 'sk-dpapi-42');

  // the portable sources are still first-class on Windows.
  process.env.CLKIT_KEY_TEST = 'sk-from-env';
  ok('resolveApiKey reads apiKeyEnv', C.resolveApiKey({ id: 'e', type: 'api', apiKeyEnv: 'CLKIT_KEY_TEST' }) === 'sk-from-env');
  delete process.env.CLKIT_KEY_TEST;
  const kf = path.join(TMP, 'key.txt'); fs.writeFileSync(kf, 'TOKEN=sk-from-file\n');
  ok('resolveApiKey reads apiKeyFrom {file,regex}',
    C.resolveApiKey({ id: 'f', type: 'api', apiKeyFrom: { file: kf, regex: 'TOKEN=(\\S+)' } }) === 'sk-from-file');
  ok('resolveApiKey error names the surviving sources (no keychain)',
    (() => { try { C.resolveApiKey({ id: 'x', type: 'api' }); return false; }
      catch (e) { return /apiKeyEnv/.test(e.message) && !/keychain/i.test(e.message); } })());
} catch (e) { ok('arc-platform + storeApiKey work', false, e.message); }

// ---- 8. arc-wire-settings — installer settings merge (idempotent) -------------
section('arc-wire-settings (installer hook wiring)');
try {
  const scriptsDir = path.join(CLAUDE, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const wire = path.join(SRC, 'arc-wire-settings.js');
  // start from a user settings.json with a pre-existing key to confirm we merge, not clobber
  writeJSON(path.join(CLAUDE, 'settings.json'), { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node other.js' }] }] } });
  const r1 = spawnSync(process.execPath, [wire, scriptsDir], { encoding: 'utf8' });
  ok('arc-wire-settings runs', r1.status === 0, (r1.stderr || '').split('\n')[0]);
  const s = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8'));
  const cmds = (ev) => (s.hooks[ev] || []).flatMap((g) => (g.hooks || []).map((x) => x.command)).join(' | ');
  ok('preserves the user\'s existing settings + hook', s.theme === 'dark' && cmds('Stop').includes('other.js'));
  ok('wires UserPromptSubmit (switch-hook + notify start)', cmds('UserPromptSubmit').includes('arc-switch-hook.js') && cmds('UserPromptSubmit').includes('arc-notify.js'));
  ok('wires Stop/StopFailure/Notification arc-notify', cmds('Stop').includes('arc-notify.js') && cmds('StopFailure').includes('arc-notify.js') && cmds('Notification').includes('arc-notify.js'));
  ok('sets statusline', /usage-monitor\.js/.test(JSON.stringify(s.statusLine)));
  ok('no cl-signal allow-rule (slash commands removed)', !JSON.stringify(s.permissions || {}).includes('cl-signal.js'));
  ok('wires TaskCreated -> arc-done (baseline the HEAD sha)', cmds('TaskCreated').includes('arc-done.js'));
  ok('wires TaskCompleted -> arc-done (the git-derived gate)', cmds('TaskCompleted').includes('arc-done.js'));

  // install.ps1 used to wire the same hooks BY HAND, in PowerShell — a second copy of the list
  // that drifted the instant the node side grew something it did not know about (a PreToolUse
  // hook needs a `matcher`, or it spawns node on every single tool call). A duplicated list is a
  // bug with a delay fuse: the gate would "work on this machine" and nowhere else. The installer
  // now DELEGATES to arc-wire-settings.js; this keeps it that way.
  const ps = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
  ok('install.ps1 delegates settings wiring to arc-wire-settings.js (one source of truth)',
    /arc-wire-settings\.js/.test(ps));
  ok('...and no hand-rolled hook wiring survives in the installer (that is how lists drift)',
    !/Ensure-Hook/.test(ps));

  ok('installer publishes the peer skill at the shared agent path',
    ps.includes("'.agents\\skills'") && ps.includes("'skills\\peers\\*'"));
  // the merged skill superseded two others — a stale copy would keep teaching the old split
  ok('installer sweeps the superseded skills it replaced',
    ps.includes("'share-with-roommate', 'fridge-responder', 'roommates'") && /Remove-Item -Recurse -Force \$p/.test(ps));
  // idempotent: a second run must not duplicate hooks
  spawnSync(process.execPath, [wire, scriptsDir], { encoding: 'utf8' });
  const s2 = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8'));
  const stopCount = (s2.hooks.Stop || []).flatMap((g) => g.hooks || []).filter((x) => x.command.includes('arc-notify.js')).length;
  ok('re-run is idempotent (no duplicate hooks)', stopCount === 1);

  // safety: a MALFORMED settings.json must NOT be silently overwritten (must abort, untouched)
  const bad = '{ "theme": "dark", }'; // trailing comma → invalid JSON
  fs.writeFileSync(path.join(CLAUDE, 'settings.json'), bad);
  const rbad = spawnSync(process.execPath, [wire, scriptsDir], { encoding: 'utf8' });
  ok('refuses malformed settings.json (non-zero exit)', rbad.status !== 0);
  ok('leaves the malformed file untouched (no silent clobber)', fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8') === bad);
} catch (e) { ok('arc-wire-settings works', false, e.message); }

// ---- arc-anchor (has a doc's claim about the code gone stale?) -------------------
section('arc-anchor (doc/code staleness)');
try {
  const A = require(path.join(SRC, 'arc-anchor.js'));
  const RM = require(path.join(SRC, 'arc-board.js'));
  const { execFileSync } = require('child_process');

  // --- parsing ---
  const doc = 'blah\n<!-- arc:anchor src/auth.ts#handleLogin -->\nit validates the nonce\n'
    + '# arc:anchor lib/db.py#connect\n';
  const parsed = A.parseAnchors(doc, 'docs/plan.md');
  ok('finds anchors in any comment syntax', parsed.length === 2);
  ok('splits file#symbol', parsed[0].file === 'src/auth.ts' && parsed[0].symbol === 'handleLogin');

  // --- definition detection (the fingerprint) ---
  ok('js function', A.isDefinitionLine('function handleLogin(req) {', 'handleLogin'));
  ok('js const arrow', A.isDefinitionLine('const handleLogin = (req) => {', 'handleLogin'));
  ok('python def', A.isDefinitionLine('def connect(dsn):', 'connect'));
  ok('object method', A.isDefinitionLine('  handleLogin(req) {', 'handleLogin'));
  ok('a MENTION is not a definition', !A.isDefinitionLine('  return handleLogin;', 'handleLogin'));
  ok('a COMMENT mentioning it is not a definition', !A.isDefinitionLine('// handleLogin does the thing', 'handleLogin'));

  // --- block extraction + hashing ---
  const src = ['const x = 1;', 'function handleLogin(req) {', '  check(req);', '  return ok;', '}', 'const y = 2;'].join('\n');
  const f = A.findSymbol(src, 'handleLogin');
  ok('block starts at the definition line', f.startLine === 2);
  ok('block ends at the closing brace (indent <= base)', f.endLine === 5);
  ok('missing symbol -> null', A.findSymbol(src, 'nope') === null);
  // the brace fix must not swallow the next block in an indentation-scoped language
  const py = ['import os', 'def connect(dsn):', '    return db(dsn)', '', 'def close():', '    pass'].join('\n');
  const pf = A.findSymbol(py, 'connect');
  ok('python block stops before the next def', pf.startLine === 2 && pf.endLine === 3);
  ok('python block excludes the following function', !/def close/.test(pf.slice));
  ok('hash is stable across trailing whitespace + CRLF',
    A.hashSlice('a\nb') === A.hashSlice('a  \r\nb\t'));
  ok('hash CHANGES when the body changes', A.hashSlice('a\nb') !== A.hashSlice('a\nc'));

  // --- the honest limitation, asserted rather than hidden ---
  const renamed = src.replace('handleLogin', 'handleSignIn');
  ok('a RENAME reports gone, not renamed (fingerprint, not AST)', A.findSymbol(renamed, 'handleLogin') === null);

  // --- end to end against a real repo ---
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'src')); fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'src', 'auth.js'), src);
  fs.writeFileSync(path.join(repo, 'docs', 'plan.md'),
    '<!-- arc:anchor src/auth.js#handleLogin -->\nhandleLogin validates the request.\n');
  g('add', '-A'); g('commit', '-qm', 'seed');

  const board = RM.resolveBoard(repo);
  ok('git grep finds the anchored doc', A.anchorDocs(board.root).includes('docs/plan.md'));
  // an UNCOMMITTED doc still makes claims about the code — --untracked, not just tracked
  fs.writeFileSync(path.join(repo, 'docs', 'draft.md'), '<!-- arc:anchor src/auth.js#handleLogin -->\n');
  ok('and finds an uncommitted one too', A.anchorDocs(board.root).includes('docs/draft.md'));
  fs.rmSync(path.join(repo, 'docs', 'draft.md'));
  // …but never an ignored one
  fs.writeFileSync(path.join(repo, '.gitignore'), 'secret/\n');
  fs.mkdirSync(path.join(repo, 'secret'));
  fs.writeFileSync(path.join(repo, 'secret', 'x.md'), '<!-- arc:anchor src/auth.js#handleLogin -->\n');
  ok('ignored paths are never scanned', !A.anchorDocs(board.root).some((d) => d.startsWith('secret/')));
  fs.rmSync(path.join(repo, 'secret'), { recursive: true, force: true });
  fs.rmSync(path.join(repo, '.gitignore'));

  let rep = A.inspect(board);
  ok('first sighting SEALS the anchor', rep.results.length === 1 && rep.results[0].status === 'sealed');
  A.writeState(board, rep.next);

  // A doc EXAMPLE (`arc:anchor src/auth.ts#handleLogin` in a README) points at nothing
  // and never has. It must never nag — cl-kit's own README contains exactly this.
  fs.writeFileSync(path.join(repo, 'docs', 'readme.md'),
    'Put one next to a claim: <!-- arc:anchor src/nowhere.ts#imaginary -->\n');
  g('add', '-A'); g('commit', '-qm', 'add a doc with an example anchor');
  const ex = A.checkAndNotify(board, 'coding', { force: true, quiet: true });
  const exRes = ex.results.find((r) => r.symbol === 'imaginary');
  ok('a never-resolved anchor is "unresolved", not stale', exRes.status === 'unresolved');
  ok('and posts no note (a doc example must not nag)', ex.posted === 0);
  // Regression: the `unresolved` state entry must not count as "previously sealed",
  // or the example flips to stale on the SECOND run and nags forever.
  const ex2 = A.checkAndNotify(board, 'coding', { force: true, quiet: true });
  ok('and it STAYS quiet on the second run', ex2.posted === 0
    && ex2.results.find((r) => r.symbol === 'imaginary').status === 'unresolved');

  rep = A.inspect(board);
  ok('unchanged code -> ok', rep.results[0].status === 'ok');
  ok('and head is unchanged, so a check would be skipped', rep.headChanged === false);
  A.writeState(board, rep.next);

  // change the code -> stale
  fs.writeFileSync(path.join(repo, 'src', 'auth.js'), src.replace('  check(req);', '  skipCheck(req);'));
  g('add', '-A'); g('commit', '-qm', 'weaken the check');
  rep = A.inspect(board);
  ok('changed code -> changed', rep.results[0].status === 'changed');
  ok('and head moved, so the check runs', rep.headChanged === true);

  // notify: a [!] note, once
  const S = 'clanchortest';
  const F = require(path.join(SRC, 'arc-notes.js'));
  const rf = F.roleFile(S);
  fs.mkdirSync(path.dirname(rf), { recursive: true });
  fs.writeFileSync(rf, JSON.stringify({ board: board.root, role: 'coding' }));
  try {
    const n1 = A.checkAndNotify(board, 'coding', { force: true, quiet: true });
    ok('a newly stale anchor posts exactly one note', n1.posted === 1);
    const note = RM.allNotes(board).pop();
    ok('the note is HIGH priority (jumps the queue)', note.priority === 'high');
    ok('the note names the doc AND the anchor', /docs\/plan\.md/.test(note.body) && /auth\.js#handleLogin/.test(note.body));
    ok('and carries machine-readable refs', note.refs.why === 'changed' && note.refs.doc === 'docs/plan.md');

    const n2 = A.checkAndNotify(board, 'coding', { force: true, quiet: true });
    ok('an ALREADY-stale anchor does not nag again', n2.posted === 0);

    // delete the file -> a NEW kind of staleness, so it speaks again
    fs.rmSync(path.join(repo, 'src', 'auth.js'));
    g('add', '-A'); g('commit', '-qm', 'drop auth');
    const n3 = A.checkAndNotify(board, 'coding', { force: true, quiet: true });
    ok('a gone FILE is reported (status escalated)', n3.results[0].status === 'gone-file');

    // reseal: the current code becomes the baseline again
    const rr = A.requestAnchors(S, 'reseal', repo);
    ok('arc:anchors reseal clears the stale flags', /resealed 2 anchor\(s\)/.test(rr.message));
    // Reseal means "the current code is the baseline", NOT "stop telling me". An anchor
    // whose target file is still gone is still a lie, so it speaks again on the next
    // check. Only fixing the doc (or deleting the anchor) actually silences it.
    ok('reseal does NOT silence an anchor that is still broken',
      A.checkAndNotify(board, 'coding', { force: true, quiet: true }).posted === 1);
    // Deleting the anchor from the doc is what ends it.
    fs.writeFileSync(path.join(repo, 'docs', 'plan.md'), 'handleLogin used to validate the request.\n');
    const after = A.checkAndNotify(board, 'coding', { force: true, quiet: true });
    ok('removing the anchor ends the alarm', after.posted === 0 && after.checked === 1);

    // head-unchanged short-circuit
    const n4 = A.checkAndNotify(board, 'coding');
    ok('no new commit -> the check is skipped entirely', n4.skipped === 'head-unchanged');

    // no repo -> no anchors, no crash
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'noanchor-'));
    const rb = A.requestAnchors(S, '', bare);
    ok('outside a git repo it says so, rather than throwing', rb.ok === false && /not a git repo/.test(rb.message));
    fs.rmSync(bare, { recursive: true, force: true });
  } finally {
    try { fs.unlinkSync(rf); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
  }
} catch (e) { ok('arc-anchor works', false, e.message); }

// ---- arc-done (derive "done" from git, not from the agent's word) ---------------
section('arc-done (git-derived completion)');
try {
  const D = require(path.join(SRC, 'arc-done.js'));
  const RM = require(path.join(SRC, 'arc-board.js'));
  const F = require(path.join(SRC, 'arc-notes.js'));
  const { execFileSync } = require('child_process');

  // --- the judgement, pure (no repo needed) ---
  const withCommit = { commits: [{ sha: 'abc1234', subject: 'do it' }], files: ['a.js'] };
  const noCommit = { commits: [], files: [] };
  ok("'off' does nothing at all", D.verdict(withCommit, 'off').post === false && D.verdict(noCommit, 'off').block === false);
  ok("'note' posts a proven completion", D.verdict(withCommit, 'note').post === true && D.verdict(withCommit, 'note').proven === true);
  ok("'note' NEVER blocks, even unproven", D.verdict(noCommit, 'note').block === false && D.verdict(noCommit, 'note').post === true);
  ok("'note' flags the unproven one", D.verdict(noCommit, 'note').proven === false);
  ok("'strict' blocks an unevidenced completion", D.verdict(noCommit, 'strict').block === true);
  ok("'strict' lets a committed one through", D.verdict(withCommit, 'strict').block === false);
  ok('unknown evidence (null) counts as UNPROVEN, never as proven', D.verdict(null, 'strict').block === true && D.verdict(null, 'note').proven === false);

  // ---- WEIGHT, NOT SILENCE ------------------------------------------------------------
  // A tick with no commit is still DELIVERED (non-code work — a design doc, a sign-off — is
  // real work a peer wants to know about). It just must not arrive dressed like proof:
  // proven -> <result> (ranks up, carries sha+files), unproven -> <info> (sinks in the digest).
  const provenNote = D.buildNote({ task_id: '1', task_subject: 'Ship P-014' },
    { commits: [{ sha: 'abc1234' }], files: ['src/a.js'] }, true, 'coding');
  const claimNote = D.buildNote({ task_id: '2', task_subject: 'Present design for sign-off' },
    { commits: [], files: [] }, false, 'coding');
  ok('a commit-backed tick is <result> and carries its evidence (sha + files)',
    provenNote.kind === 'result' && provenNote.refs.sha === 'abc1234' && provenNote.refs.files[0] === 'src/a.js');
  ok('an uncommitted tick is <info> — still posted, but it sinks instead of outranking proof',
    claimNote.kind === 'info' && !claimNote.refs.sha && RM.KIND_RANK.result < RM.KIND_RANK.info);
  ok('the uncommitted wording states the fact without the accusation',
    /no commit — not code-backed/.test(claimNote.body) && !/UNVERIFIED|taken on trust/.test(claimNote.body));
  ok('a non-code tick still reaches peers (weight, not silence)',
    claimNote.to === null && /Present design for sign-off/.test(claimNote.body));

  // --- evidence, against a REAL git repo ---
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'done-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'x');
  g('add', '-A'); g('commit', '-qm', 'seed');
  const base = D.head(repo);
  ok('head() reads a real sha', /^[0-9a-f]{40}$/.test(base || ''));
  ok('no commits since baseline -> proven=false', D.evidenceSince(repo, base).commits.length === 0);

  fs.writeFileSync(path.join(repo, 'feature.js'), 'ship it');
  g('add', '-A'); g('commit', '-qm', 'add feature: P-014');
  const ev = D.evidenceSince(repo, base);
  ok('one commit since baseline is found', ev.commits.length === 1);
  ok('the commit SUBJECT survives (split on 0x1F, not on spaces)', ev.commits[0].subject === 'add feature: P-014');
  ok('the changed FILES are derived', ev.files.includes('feature.js'));
  ok('a bogus baseline yields null, never a false positive', D.evidenceSince(repo, 'deadbeef') === null);

  // --- baselines are keyed by SESSION, because task ids restart at 1 per session ---
  const board = RM.resolveBoard(repo);
  ok('two sessions\' task "1" do not collide',
    D.baselineFile(board, 'sess-A', '1') !== D.baselineFile(board, 'sess-B', '1'));

  // --- end to end: a completion posts a note carrying the sha ---
  const S = 'cldonetest';
  const roleFile = F.roleFile(S);
  fs.mkdirSync(path.dirname(roleFile), { recursive: true });
  fs.writeFileSync(roleFile, JSON.stringify({ board: board.root, role: 'coding' }));
  try {
    D.recordBaseline(board, S, '7', base);
    process.env.ARC_DONE_GATE = 'note';
    const r = D.onTaskCompleted({ task_id: '7', task_subject: 'Implement P-014', cwd: repo }, S);
    ok('a proven completion posts a note', r.posted === true && r.proven === true && r.block === false);
    const notes = RM.allNotes(board);
    const n = notes[notes.length - 1];
    ok('the note is FROM the completing role', n.from === 'coding');
    ok('the note is a broadcast (any peer sees it)', n.to === null);
    ok('the note names the task', /Implement P-014/.test(n.body));
    // A commit-backed tick CARRIES EVIDENCE, so it is a <result> and ranks above routine news.
    ok('a PROVEN tick is kind:result (it proves itself, so it outranks info)', n.kind === 'result');
    ok('the note CARRIES THE SHA as evidence', typeof n.refs.sha === 'string' && n.refs.sha.length >= 7);
    ok('the note carries the changed files', n.refs.files.includes('feature.js'));

    // strict mode, nothing committed since -> the tick is refused
    const base2 = D.head(repo);
    D.recordBaseline(board, S, '8', base2);
    process.env.ARC_DONE_GATE = 'strict';
    const r2 = D.onTaskCompleted({ task_id: '8', task_subject: 'Claim without committing', cwd: repo }, S);
    ok('strict REFUSES a completion with no commit', r2.block === true);
    ok('and tells the agent why, on stderr', /no commit found/.test(r2.stderr));
    ok('and posts NOTHING when it blocks', RM.allNotes(board).length === notes.length);

    // a session with no role stays silent rather than inventing a sender
    process.env.ARC_DONE_GATE = 'note';
    const r3 = D.onTaskCompleted({ task_id: '9', task_subject: 'x', cwd: repo }, 'no-role-session');
    ok('no role -> no note, no crash', !r3.posted && r3.block === false);

    // NO REPO, NO GATE. "there is no git here" != "git says you committed nothing".
    // Caught live: a cwd that drifted to a non-repo made strict refuse EVERY completion.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'norepo-'));
    process.env.ARC_DONE_GATE = 'strict';
    const r4 = D.onTaskCompleted({ task_id: '1', task_subject: 'x', cwd: bare }, S);
    ok('strict does NOT block outside a git repo', r4.block === false);
    fs.rmSync(bare, { recursive: true, force: true });

    // An ORPHANED baseline sha (rebase/amend) must fall back to the task's birth time,
    // not silently become "unknown" and block a legitimately committed task. The task
    // FILE is the fallback, so the fixture must actually have one — point CLAUDE_CONFIG_DIR
    // at a sandbox rather than fake it.
    const bl = D.readBaseline(board, S, '7', path.join(repo, 'seed.txt'));
    ok('readBaseline returns BOTH a sha and a birth time', bl.sha === base && typeof bl.born === 'string');

    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    const prevCfg = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      fs.mkdirSync(path.join(cfg, 'tasks', S), { recursive: true });
      fs.writeFileSync(path.join(cfg, 'tasks', S, '10.json'), '{"id":"10"}');   // born NOW
      D.recordBaseline(board, S, '10', 'dead1234beefdead1234beefdead1234beefdead'); // never existed
      fs.writeFileSync(path.join(repo, 'after.js'), 'work');
      g('add', '-A'); g('commit', '-qm', 'work done after the task was born');

      process.env.ARC_DONE_GATE = 'strict';
      const r5 = D.onTaskCompleted({ task_id: '10', task_subject: 'orphaned baseline', cwd: repo }, S);
      ok('an orphaned baseline sha falls back to birth time, does not block', r5.block === false);
      ok('and it still posts PROVEN, with the real sha', r5.posted === true && r5.proven === true);
    } finally {
      if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  } finally {
    delete process.env.ARC_DONE_GATE;
    try { fs.unlinkSync(roleFile); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
  }
} catch (e) { ok('arc-done works', false, e.message); }

// ---- arc-postcommit (every commit -> a board note, no task list needed) --------
section('arc-postcommit (commit -> board note)');
try {
  const PC = require(path.join(SRC, 'arc-postcommit.js'));
  const RM = require(path.join(SRC, 'arc-board.js'));
  const { execFileSync } = require('child_process');

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  const board = RM.resolveBoard(repo); RM.ensureBoard(board);
  // arm a role for our session (cache is under the sandbox HOME)
  const cacheDir = path.join(os.homedir(), '.claude', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'arc-role-pcsess.json'), JSON.stringify({ board: board.root, role: 'android' }));

  // no ARC_SESSION -> no note (a non-cl commit must not spam the board)
  fs.writeFileSync(path.join(repo, 'a.js'), 'x'); g('add', '-A'); g('commit', '-qm', 'first');
  delete process.env.ARC_SESSION;
  ok('a commit with no ARC_SESSION posts nothing', PC.run(repo).posted === false);
  ok('  and the board is still empty', RM.allNotes(board).length === 0);

  // ARC_SESSION with a role -> a note attributed to that role
  fs.writeFileSync(path.join(repo, 'feature.js'), 'y'); g('add', '-A'); g('commit', '-qm', 'add the overlay fix');
  process.env.ARC_SESSION = 'pcsess';
  try {
    const r = PC.run(repo);
    ok('a cl commit posts a note', r.posted === true && r.role === 'android');
    const n = RM.allNotes(board).pop();
    ok('  from the committing role, broadcast', n.from === 'android' && n.to === null);
    ok('  body names the commit subject', /committed: add the overlay fix/.test(n.body));
    ok('  refs carry the real sha + files', n.refs.sha === PC.git(repo, ['rev-parse', '--short', 'HEAD']) && n.refs.files.includes('feature.js'));
    ok('  the peer sees it, the committer does not',
      RM.unreadFor(board, 'frontend').count === 1 && RM.unreadFor(board, 'android').count === 0);

    // a role claimed in a DIFFERENT board does not attribute here
    fs.writeFileSync(path.join(cacheDir, 'arc-role-elsewhere.json'), JSON.stringify({ board: 'z:\\other', role: 'x' }));
    ok('roleFor ignores a role from another board', PC.roleFor('elsewhere', board) === null);
  } finally {
    delete process.env.ARC_SESSION;
    try { fs.unlinkSync(path.join(cacheDir, 'arc-role-pcsess.json')); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
  }
} catch (e) { ok('arc-postcommit works', false, e.message); }

// ---- arc-runner board CLI (arc note / arc role — the AGENT-facing surface) --------
// The agent can't TYPE arc:note (the hook eats it), but it can RUN `cl note ...` via
// Bash. This exercises that dispatch end to end through the real arc-runner process.
section('arc-runner board CLI (arc note / arc role)');
try {
  const runner = path.join(SRC, 'arc-runner.js');
  const RM = require(path.join(SRC, 'arc-board.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clicli-'));
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const board = RM.resolveBoard(repo); RM.ensureBoard(board);
  const S = 'clicli-sess';
  fs.mkdirSync(path.join(CLAUDE, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-role-${S}.json`), JSON.stringify({ board: board.root, role: 'android' }));
  const env = { ...process.env, ARC_SESSION: S };

  const post = spawnSync(process.execPath, [runner, 'note', 'all', 'shared: /login is 202 now'], { cwd: repo, env, encoding: 'utf8' });
  ok('`arc note` exits 0', post.status === 0, (post.stderr || '').split('\n')[0]);
  ok('`arc note` posts to the board, attributed to the role',
    RM.allNotes(board).some((n) => /login is 202/.test(n.body) && n.from === 'android'));
  ok('`arc note` output leaks no arc: sentinel form', !/arc:(note|role|notes)/.test(post.stdout));

  const role = spawnSync(process.execPath, [runner, 'role'], { cwd: repo, env, encoding: 'utf8' });
  ok('`arc role` reports your role', /your role: android/.test(role.stdout));

  // a session with no role can't post; the hint is rewritten to the CLI form (this is
  // where the arc:role -> cl role rewrite is actually exercised).
  const noRole = spawnSync(process.execPath, [runner, 'note', 'all', 'x'], { cwd: repo, env: { ...process.env, ARC_SESSION: 'no-role-sess' }, encoding: 'utf8' });
  const out = noRole.stdout + noRole.stderr;
  ok('`arc note` with no role is refused and points to `arc role`', noRole.status !== 0 && /arc role/.test(out) && !/arc:role/.test(out));

  fs.rmSync(repo, { recursive: true, force: true });
  try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-role-${S}.json`)); } catch {}
} catch (e) { ok('arc-runner board CLI works', false, e.message); }

// ---- the bin shims: `arc` must be runnable BY THE AGENT ---------------------------
// Found in the wild, not by a test: the Stop hook told this very session to run
// `arc await code`, and it died with exit 127. The installer shipped only arc.cmd —
// cmd.exe and PowerShell resolve a bare `arc` through PATHEXT, but BASH DOES NOT. It looks
// for a file literally named `arc`. So every `arc role` / `arc notes` / `arc note` /
// `arc await` was dead inside Claude Code's Bash tool: precisely where the `peers` skill
// tells agents to run them. The bin dir was on PATH all along; the NAME was unresolvable.
//
// The unit tests all passed while this was broken, because they call the MODULE
// (require('arc-await.js')) and never the COMMAND the hook actually hands the agent. So this
// section asserts the SHIPPING SURFACE — what a user installs, and what an agent is told to
// type — rather than the internals.
section('bin shims (the `arc` an AGENT types must exist for BOTH shells)');
try {
  const ps1 = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');

  ok('install.ps1 still writes arc.cmd (cmd.exe + PowerShell, via PATHEXT)',
    /Join-Path \$bin 'arc\.cmd'/.test(ps1));
  ok('install.ps1 ALSO writes an extensionless `arc` (bash does not do PATHEXT -> 127)',
    /Join-Path \$bin 'arc'\)/.test(ps1));

  // The shim's two content traps, both silent and both nasty:
  // Grab the whole assignment line: PowerShell escapes a quote as `" , so [^"]* would stop
  // at the first escape and silently capture a fragment (it did — and "failed" a good shim).
  const shim = (ps1.match(/\$runnerSh = (.*)/) || [])[1] || '';
  ok('the POSIX shim has a #!/bin/sh shebang', /#!\/bin\/sh/.test(shim));
  ok('the POSIX shim uses $USERPROFILE, not $HOME (node.exe cannot read /c/Users/... MSYS paths)',
    /\$USERPROFILE/.test(shim) && !/\$HOME/.test(shim));
  ok('the POSIX shim forwards args ("$@") — else `arc await code` would drop the role',
    /\$@/.test(shim));
  ok('the POSIX shim is written LF + no BOM (a CRLF shebang fails as "not found")',
    /WriteAllText\(\(Join-Path \$bin 'arc'\)/.test(ps1) && /UTF8Encoding \$false/.test(ps1));

  // The hook must not name a specific tool: it named "Bash tool" — the one that was broken.
  const hookSrc = fs.readFileSync(path.join(SRC, 'arc-stop-hook.js'), 'utf8');
  ok('the Stop hook does not hard-code one shell/tool when telling the agent to arm',
    !/Bash tool/.test(hookSrc) && /run_in_background/.test(hookSrc));
} catch (e) { ok('bin shims', false, e.message); }

// ---- audit regressions (board note #2: what the research peer found) ---------------
// The first live board request was an audit for more 127-class bugs — commands arc TEACHES
// that do not RUN. It came back with three (docs/audit/shipping-surface-2026-07-14.md); each
// is pinned here so it cannot regrow. All are SHIPPING-SURFACE assertions: they test the
// string a human or agent is told to type, not the module underneath.
section('audit regressions (taught commands must run)');
try {
  // A3 — THE CATCH-22. A config that PARSES but normalizes to zero valid accounts used to
  // kill EVERY subcommand at module load — including `arc setup` and `arc doctor`, the exact
  // two commands every error message says to run. The doctor died of the disease it treats.
  const sick = fs.mkdtempSync(path.join(os.tmpdir(), 'sick-home-'));
  fs.mkdirSync(path.join(sick, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(sick, '.claude', 'arc-config.json'), '{"accounts":[]}');
  const sickEnv = { ...process.env, HOME: sick, USERPROFILE: sick };

  const doc = spawnSync(process.execPath, [path.join(SRC, 'arc-runner.js'), 'doctor'],
    { encoding: 'utf8', env: sickEnv, timeout: 30000 });
  ok('`arc doctor` RUNS on a broken config and DIAGNOSES it (it used to die of it)',
    /BROKEN/.test(doc.stdout || '') && /arc setup/.test(doc.stdout || ''), (doc.stdout || doc.stderr || '').slice(0, 200));
  ok('...and still exits 1 — broken config is a failed checkup, not a healthy one',
    doc.status === 1);

  // The carve-out is for the two REPAIR commands only: anything else still hard-exits, since
  // it genuinely cannot work without accounts.
  const peek = spawnSync(process.execPath, [path.join(SRC, 'arc-runner.js'), 'peek'],
    { encoding: 'utf8', env: sickEnv, timeout: 30000 });
  ok('other subcommands still refuse loudly on a broken config (they really need accounts)',
    peek.status === 1 && /arc setup/.test(peek.stderr || '') && !/BROKEN/.test(peek.stdout || ''));
  fs.rmSync(sick, { recursive: true, force: true });

  // A1 — the MCP guidance taught the PRE-RENAME binary (`cl add-account`): exit 127 on any
  // fresh install. Nothing named `cl` may be taught anywhere in the MCP server.
  const mcpSrc = fs.readFileSync(path.join(ROOT, 'mcp', 'server.js'), 'utf8');
  ok('mcp/server.js teaches `arc add-account`, not the dead `cl` binary',
    !/`cl /.test(mcpSrc) && /`arc add-account /.test(mcpSrc));

  // B1 — `--reply-to #8` in a SHELL comments out everything from the `#`: the thread link and
  // the answer text silently vanish, and a garbage note posts "successfully". The parser takes
  // the bare number, so every terminal-context example must teach the bare number. (The one
  // allowed mention is the warning ABOUT the trap.)
  const notesSrc = fs.readFileSync(path.join(SRC, 'arc-notes.js'), 'utf8');
  const skillSrc = fs.readFileSync(path.join(ROOT, 'skills', 'peers', 'SKILL.md'), 'utf8');
  const cmdWithHash = /arc[: ]note [^\n]*--(?:reply-to|supersedes)[= ]#\d/;
  ok('NOTE_USAGE examples use bare note numbers (a `#` would be eaten by the shell)',
    !cmdWithHash.test(notesSrc));
  ok('the peers skill examples use bare note numbers too',
    !cmdWithHash.test(skillSrc.replace(/^# NB:.*$/m, '')));
  ok('...and the parser still ACCEPTS the # form (tolerance stays even though docs stopped teaching it)',
    /#\?\(\\d\+\)/.test(notesSrc));

  // C1 — injection() speaks ONLY to the agent, and an agent cannot type sentinels: the hook
  // eats `arc:notes` from a human, and in the agent's shell it is not a command at all. The
  // one runnable form for its audience is the space form.
  const injStart = notesSrc.indexOf('function injection(');
  const injBody = notesSrc.slice(injStart, notesSrc.indexOf('\nfunction ', injStart + 1));
  ok('the board injection tells the AGENT `arc notes`, never the untypeable `arc:notes`',
    injBody.length > 0 && !/arc:notes/.test(injBody) && /arc notes/.test(injBody));

  // D — the README documented cl-era names the code no longer uses: env vars that do nothing
  // when set, log/backup paths that never exist, and a credentials folder NO code ever creates.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  ok('README documents no dead cl-era names (env vars, cache paths, cl-credentials/)',
    !/CL_[A-Z_]+/.test(readme) && !/cl-(credentials|profiles|deleted|runner|export|import|notify)/.test(readme));
} catch (e) { ok('audit regressions', false, e.message + '\n' + (e.stack || '')); }

// ---- arc:role / arc:join auto-arm (the one sentinel that deliberately costs a turn) ----
// Proven live: a responder claimed via the arc:role sentinel, went idle, and was DEAF — a
// blocked sentinel has no turn, and only the agent's own background command can arm a
// listener. So a successful NEW claim now PASSES THROUGH: the hook does the claim (instant,
// in-hook), then hands the model one turn with orders to `arc join`. Query, refusal, and
// already-armed still block at zero tokens — the turn is spent only when it buys the one
// thing a block cannot.
section('arc:role auto-arm (fresh claim passes through; the turn runs `arc join`)');
try {
  const AW = require(path.join(SRC, 'arc-await.js'));
  const swhook2 = path.join(SRC, 'arc-switch-hook.js');

  const jrepo = fs.mkdtempSync(path.join(os.tmpdir(), 'autoarm-'));
  fs.mkdirSync(path.join(jrepo, '.git'), { recursive: true });
  const JS = 'autoarm-sess-' + process.pid;
  fs.mkdirSync(path.join(CLAUDE, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${JS}.json`),
    JSON.stringify({ pid: process.pid, cwd: jrepo }));

  const askRole = (prompt, cwd) => {
    const r = spawnSync(process.execPath, [swhook2], {
      input: JSON.stringify({ prompt, cwd: cwd || jrepo }), encoding: 'utf8',
      env: { ...process.env, ARC_SESSION: JS },
    });
    try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
  };

  // The headline: a fresh claim does NOT block — it hands the model a turn with join orders.
  AW.clearWaiting(JS);
  const fresh = askRole('arc:role research');
  const ctx = (fresh.hookSpecificOutput && fresh.hookSpecificOutput.additionalContext) || '';
  ok('a FRESH claim passes through as a turn (no block), with the claim already done',
    !fresh.decision && /claim is DONE/.test(ctx) && /you are "research"/.test(ctx));
  ok('...and the turn has exactly one job: run `arc join research` in the background',
    /run_in_background: true/.test(ctx) && /arc join research/.test(ctx));
  ok('...and it forbids inventing work ("do not start work nobody asked for")',
    /Do not start work nobody asked for/i.test(ctx));

  // Re-claim with a LIVE listener: nothing left for a turn to buy — block at zero tokens.
  AW.markWaiting(JS, 'research', process.pid);
  const armed = askRole('arc:role research');
  ok('a re-claim with a LIVE listener blocks at zero tokens ("already armed")',
    armed.decision === 'block' && /already armed/.test(armed.reason || ''));

  // A listener armed for the OLD role hears nothing on the new one — that is armNeeded too.
  const moved = askRole('arc:join android');
  const mctx = (moved.hookSpecificOutput && moved.hookSpecificOutput.additionalContext) || '';
  ok('arc:join is the same sentinel: switching roles with an OLD-role listener re-arms',
    !moved.decision && /OLD role "research"/.test(mctx) && /arc join android/.test(mctx));

  // The zero-token forms stay zero-token.
  ok('the bare `arc:role` query still blocks (zero tokens)',
    askRole('arc:role').decision === 'block');
  const norepo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'noboard-'));
  ok('a non-repo refusal still blocks (zero tokens) — no turn spent on a failed claim',
    /not a git repository/.test(askRole('arc:role research', norepo2).reason || ''));

  AW.clearWaiting(JS);
  fs.rmSync(jrepo, { recursive: true, force: true });
  fs.rmSync(norepo2, { recursive: true, force: true });
} catch (e) { ok('arc:role auto-arm', false, e.message + '\n' + (e.stack || '')); }

// ---- arc join (claim if needed + listen, one background command) --------------------
// The agent-facing verb: `arc role` DECLARES, `arc join` LISTENS (claiming on the way if the
// role isn't yet held). Meant for run_in_background — the exit is the wake.
section('arc join (claim + listen in one command)');
try {
  const RM2 = require(path.join(SRC, 'arc-board.js'));
  const jrepo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'join-'));
  fs.mkdirSync(path.join(jrepo2, '.git'), { recursive: true });
  const board2 = RM2.resolveBoard(jrepo2); RM2.ensureBoard(board2);
  const JS2 = 'join-sess-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${JS2}.json`),
    JSON.stringify({ pid: process.pid, cwd: jrepo2 }));

  const runJoin = (args, env) => spawnSync(process.execPath,
    [path.join(SRC, 'arc-runner.js'), 'join', ...args],
    { encoding: 'utf8', cwd: jrepo2, timeout: 30000, env: { ...process.env, ARC_SESSION: JS2, ...(env || {}) } });

  // A note is already waiting → join claims, reports, and EXITS immediately (that exit is
  // the wake). This is the whole command's contract in one run.
  RM2.appendNote(board2, { from: 'android', to: 'research', kind: 'request', body: 'first job' });
  const j1 = runJoin(['research']);
  ok('`arc join research` claims the role and exits the moment a note is waiting',
    j1.status === 0 && /you are "research"/.test(j1.stdout) && /first job/.test(j1.stdout)
    && /arc notes/.test(j1.stdout));
  ok('...and it only OBSERVES — the note is still unread for the waking turn to deliver',
    RM2.unreadFor(board2, 'research').count === 1);

  // Re-join (role already mine) — no re-claim, straight to listening.
  const j2 = runJoin(['research']);
  ok('re-joining your own role says so and listens (no duplicate claim)',
    j2.status === 0 && /already "research"/.test(j2.stdout));

  // Bare `arc join` falls back to the session's claimed role.
  const j3 = runJoin([]);
  ok('bare `arc join` reuses the role this session already holds',
    j3.status === 0 && /already "research"/.test(j3.stdout));

  // Refusals EXIT non-zero — backgrounded, that exit reports the failure instead of hanging.
  const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'joinnr-'));
  const j4 = spawnSync(process.execPath, [path.join(SRC, 'arc-runner.js'), 'join', 'research'],
    { encoding: 'utf8', cwd: noRepo, timeout: 30000, env: { ...process.env, ARC_SESSION: JS2 } });
  ok('`arc join` in a NON-REPO refuses and exits 1 (a failed claim must not listen)',
    j4.status === 1 && /not a git repository/.test(j4.stderr || ''));
  const j5 = spawnSync(process.execPath, [path.join(SRC, 'arc-runner.js'), 'join'],
    { encoding: 'utf8', cwd: noRepo, timeout: 30000, env: { ...process.env, ARC_SESSION: JS2 } });
  ok('bare `arc join` with no role anywhere explains itself and exits 1',
    j5.status === 1 && /which role/.test(j5.stderr || ''));

  fs.rmSync(jrepo2, { recursive: true, force: true });
  fs.rmSync(noRepo, { recursive: true, force: true });
} catch (e) { ok('arc join', false, e.message + '\n' + (e.stack || '')); }

// ---- arc:invite (spawn a peer session: new tab, forked context, self-arming) --------
// invite adds a TAB, not a mechanism: the new tab runs `arc --account <caller's> --resume
// <caller conv> --fork-session "arc:role <role>"`, and the existing fresh-claim pass-through
// does the claiming + arming in the new session's first turn. These tests inject a spawn
// recorder — nothing real opens.
// ---- .plan -> .peer : renaming the board folder without losing a session ------------
// The folder was `.plan` — a name left from before the room->board rename, confusing enough that
// it had to be explained out loud ("there is no .board; .plan IS the board"). Renaming it moves
// LIVE STATE, which is the dangerous kind: get it wrong and two sessions write to different
// folders and silently stop seeing each other (the wrong-board split, which has already cost one
// drill). So the migration is read-fallback + one atomic rename, and these are its guards.
section('board folder migration -> .arc/peer (live state moves without a silent split)');
try {
  const RM8 = require(path.join(SRC, 'arc-board.js'));

  // A board frozen exactly as the old code left it: ledger, cursor, claim, self-ignore.
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  spawnSync('git', ['init', '-q'], { cwd: old });
  const legacy = path.join(old, '.plan');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'notes.jsonl'),
    '{"from":"android","to":"research","body":"first"}\n{"from":"research","to":"android","body":"second"}\n');
  fs.writeFileSync(path.join(legacy, 'cursor-android.json'), JSON.stringify({ seq: 1 }));
  fs.writeFileSync(path.join(legacy, 'claim-android.json'),
    JSON.stringify({ role: 'android', pid: process.pid, sessionId: 'mig-s', convId: 'mig-c', at: Date.now() }));
  fs.writeFileSync(path.join(legacy, '.gitignore'), '*\n');

  // READ FALLBACK: before any write, the ledger must still be fully visible. Pointing at an
  // empty `.peer` and reporting "no notes" would be a lie, and the silent kind.
  const b1 = RM8.resolveBoard(old);
  // NB compare against b1.root: resolveBoard CANONICALISES (lowercases) the path, so the raw
  // mkdtemp string never matches on Windows.
  ok('before any write, a legacy board is still READ in full (never a silently empty board)',
    b1.planDir === path.join(b1.root, '.plan') && RM8.allNotes(b1).length === 2);
  ok('...and the fallback walks the WHOLE legacy chain, so a machine that skipped a hop is fine',
    (() => { const two = fs.mkdtempSync(path.join(os.tmpdir(), 'mig4-'));
      spawnSync('git', ['init', '-q'], { cwd: two });
      fs.mkdirSync(path.join(two, '.peer'), { recursive: true });      // the intermediate name
      fs.writeFileSync(path.join(two, '.peer', 'notes.jsonl'), JSON.stringify({ from: 'x', body: 'mid' }) + '\n');
      const b = RM8.resolveBoard(two);
      const found = b.planDir === path.join(b.root, '.peer') && RM8.allNotes(b).length === 1;
      RM8.ensureBoard(b);                                              // ...and it migrates in ONE hop
      const moved = b.planDir === path.join(b.root, '.arc', 'peer') && RM8.allNotes(b).length === 1;
      fs.rmSync(two, { recursive: true, force: true });
      return found && moved; })());
  ok('...and its claim is still seen, so nobody steals a role that is genuinely held',
    (RM8.roleClaim(b1, 'android') || {}).sessionId === 'mig-s');
  ok('...and its cursor still counts (unread is 1, not "all of it again")',
    RM8.unreadFor(b1, 'android').count === 1);

  // THE MIGRATION: one atomic rename on the first write. Everything arrives; nothing is copied.
  RM8.ensureBoard(b1);
  ok('the first write MIGRATES the board into .arc/peer, atomically',
    fs.existsSync(path.join(old, '.arc', 'peer')) && !fs.existsSync(legacy));
  ok('...and mutates the caller\'s board object (or it would write to the folder we just moved)',
    b1.planDir === path.join(b1.root, '.arc', 'peer'));
  ok('...carrying the whole ledger', RM8.allNotes(b1).length === 2);
  ok('...the cursor', RM8.unreadFor(b1, 'android').count === 1);
  ok('...and the live claim (a session does not lose its role to a rename)',
    (RM8.roleClaim(b1, 'android') || {}).sessionId === 'mig-s');

  // And a freshly resolved board now finds the new name with no fallback.
  const b2 = RM8.resolveBoard(old);
  ok('a fresh resolve now points at .arc/peer (then the fallback never fires again)',
    b2.planDir === path.join(b2.root, '.arc', 'peer') && RM8.allNotes(b2).length === 2);
  ok('the self-ignore came along, so the board still never enters the project history',
    /^\*$/m.test(fs.readFileSync(path.join(old, '.arc', 'peer', '.gitignore'), 'utf8')));
  ok('...and it does NOT swallow its committed sibling .arc/roles/',
    (() => { fs.mkdirSync(path.join(old, '.arc', 'roles'), { recursive: true });
      fs.writeFileSync(path.join(old, '.arc', 'roles', 'code.md'), ['# code', '', 'owns: things', ''].join('\n'));
      const r = spawnSync('git', ['check-ignore', '.arc/roles/code.md'], { cwd: old, encoding: 'utf8' });
      return r.status !== 0; })());

  // A BRAND-NEW board must simply be .peer — no legacy anything.
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'mig2-'));
  spawnSync('git', ['init', '-q'], { cwd: fresh });
  const b3 = RM8.resolveBoard(fresh);
  RM8.ensureBoard(b3);
  ok('a NEW board is born at .arc/peer, with no legacy folder anywhere',
    fs.existsSync(path.join(fresh, '.arc', 'peer'))
    && !fs.existsSync(path.join(fresh, '.plan')) && !fs.existsSync(path.join(fresh, '.peer')));

  // NEVER clobber: if BOTH exist (a half-migrated repo, or someone made .peer by hand), the
  // rename must not fire — silently merging two ledgers would be far worse than leaving it.
  const both = fs.mkdtempSync(path.join(os.tmpdir(), 'mig3-'));
  spawnSync('git', ['init', '-q'], { cwd: both });
  fs.mkdirSync(path.join(both, '.plan'), { recursive: true });
  fs.mkdirSync(path.join(both, '.arc', 'peer'), { recursive: true });
  fs.writeFileSync(path.join(both, '.arc', 'peer', 'notes.jsonl'), '{"from":"x","body":"new"}\n');
  const b4 = RM8.resolveBoard(both);
  RM8.ensureBoard(b4);
  ok('with BOTH present, the CURRENT folder wins and the legacy is left alone (never merge two ledgers)',
    b4.planDir === path.join(b4.root, '.arc', 'peer') && fs.existsSync(path.join(both, '.plan'))
    && RM8.allNotes(b4).length === 1);

  for (const d of [old, fresh, both]) fs.rmSync(d, { recursive: true, force: true });
} catch (e) { ok('.plan -> .peer migration', false, e.message + '\n' + (e.stack || '')); }

// ---- the listener must not go deaf when its board moves ------------------------------
// A listener captures its folder at spawn and polls that exact path forever. A rename underneath
// it would leave it polling a corpse — and WORSE than merely missing notes: the armed marker
// still names a LIVE pid, so the Stop hook sees "already listening" and stays quiet. The session
// would be deaf forever while arc reported it reachable. So it exits, and the next idle re-arms.
section('listener self-heal (a board that moves must not make a session silently deaf)');
try {
  const A9 = require(path.join(SRC, 'arc-await.js'));
  const RM9 = require(path.join(SRC, 'arc-board.js'));
  const mrepo = fs.mkdtempSync(path.join(os.tmpdir(), 'moved-'));
  spawnSync('git', ['init', '-q'], { cwd: mrepo });
  const mb = RM9.resolveBoard(mrepo); RM9.ensureBoard(mb);
  const MS = 'moved-sess-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${MS}.json`),
    JSON.stringify({ pid: process.pid, cwd: mrepo }));

  // Run a listener in a real subprocess (its exit IS the property), then move the board.
  const child = spawnSync(process.execPath, ['-e',
    `process.env.ARC_SESSION = ${JSON.stringify(MS)};`
    + `const A = require(${JSON.stringify(path.join(SRC, 'arc-await.js'))});`
    + `setTimeout(() => { try { require('fs').renameSync(${JSON.stringify(mb.planDir)}, ${JSON.stringify(mb.planDir + '-moved')}); } catch {} }, 120);`
    + `A.awaitOnce('code', ${JSON.stringify(mrepo)}, { pollMs: 30 }).then((c) => process.exit(c));`,
  ], { encoding: 'utf8', timeout: 8000, env: { ...process.env, ARC_SESSION: MS } });

  ok('a listener whose board FOLDER moves exits instead of polling a corpse forever',
    child.status === 0 && !child.error, child.error ? 'timed out — it kept polling a dead path' : '');
  ok('...and says why, so the wake is not a mystery',
    /board folder moved/i.test(child.stdout || ''));
  ok('...and clears its armed marker, so the next idle RE-ARMS on the new folder',
    !A9.isWaiting(MS));

  fs.rmSync(mrepo, { recursive: true, force: true });
  try { fs.rmSync(mb.planDir + '-moved', { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-state-${MS}.json`)); } catch {}
} catch (e) { ok('listener self-heal', false, e.message + '\n' + (e.stack || '')); }

// ---- the duty roster: what a ROLE owns, declared once, outliving every session -------
// `research` used to be just a STRING. An agent asking "is this research's job or mine?" could
// only guess — and when research was CLOSED the string said nothing at all, so a peer would
// either do someone else's work or spawn a duplicate under a synonym. A declaration is the data
// that makes the question answerable, and because it is a FILE it answers just as well when
// nobody is home. Committed (a project fact, same on every machine); presence stays local.
section('duty roster (.arc/roles — a role outlives the session holding it)');
try {
  const D = require(path.join(SRC, 'arc-duty.js'));
  const RM7 = require(path.join(SRC, 'arc-board.js'));
  const F8 = require(path.join(SRC, 'arc-notes.js'));

  const drepo = fs.mkdtempSync(path.join(os.tmpdir(), 'duty-'));
  spawnSync('git', ['init', '-q'], { cwd: drepo });
  const dbd = RM7.resolveBoard(drepo); RM7.ensureBoard(dbd);
  fs.mkdirSync(path.join(drepo, '.arc', 'roles'), { recursive: true });
  fs.writeFileSync(path.join(drepo, '.arc', 'roles', 'research.md'),
    '# research\n\nowns: investigation and docs; READ-ONLY on code\nsend me: bounded questions\nnot me: writing code\n');

  ok('a duty is read from .arc/roles/<role>.md, keyed by ROLE (not by session)',
    (D.readDuty(dbd, 'research') || {}).summary === 'investigation and docs; READ-ONLY on code');
  ok('...and the path it reports is repo-relative (identical on every machine)',
    D.readDuty(dbd, 'research').path === '.arc/roles/research.md');
  ok('the summary prefers the `owns:` line — that is the one line a peer needs to route work',
    D.dutySummary('# x\n\nowns: the thing\nsend me: stuff') === 'the thing');
  ok('...and falls back to the first prose line, so a free-form charter still surfaces something',
    D.dutySummary('# x\n\njust some prose here\n') === 'just some prose here');

  // THE ROSTER: declarations merged with claims. The `closed` row is the whole point — the state
  // an agent could not see before, and the one that decides invite-vs-do-it-myself.
  const ros = D.roster(dbd, [{ role: 'android' }]);
  const research = ros.find((r) => r.role === 'research');
  const android = ros.find((r) => r.role === 'android');
  ok('a DECLARED role with nobody in it shows as closed — an empty chair you can read',
    research && research.declared === true && research.live === false && !!research.summary);
  ok('a LIVE role with no declaration shows as undeclared (a nudge, not a lie)',
    android && android.live === true && android.declared === false);
  ok('live roles sort first (you can act on them now)', ros[0].role === 'android');

  // THE BLACK HOLE, closed. A note to a role nobody holds used to return a cheerful ✓ and
  // nothing else; a request would then have the sender arm a listener and wait forever.
  const AS = 'duty-sess-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${AS}.json`),
    JSON.stringify({ pid: process.pid, cwd: drepo, convId: 'dc' }));
  F8.requestRole(AS, 'android', drepo);

  const req = F8.requestNote(AS, 'research --kind request "why does the tap drop?"', drepo);
  ok('a note to an EMPTY CHAIR still posts (the cursor is per-role — it keeps)', req.ok === true);
  ok('...but says so, loudly, instead of a bare ✓',
    /NOBODY HOLDS "research"/.test(req.message));
  ok('...and uses the DUTY to make the warning actionable (the chair is real, revive it)',
    /IS a declared role/.test(req.message) && /investigation and docs/.test(req.message)
    && /arc:invite research/.test(req.message));
  ok('...and a REQUEST is called out as never-answerable — do not go idle on it',
    /NEVER be answered/.test(req.message) && /Do not go\n {4}idle/.test(req.message));

  const info = F8.requestNote(AS, 'ghost "heads up"', drepo);
  ok('an UNDECLARED, unheld role says the repo has no such job at all',
    /does not declare a "ghost" role/.test(info.message));
  ok('...and a non-request note is told it keeps for whoever claims the role next',
    /It keeps:/.test(info.message));

  // A live target must stay silent — the warning has to be rare or it is noise.
  const BS = 'duty-live-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${BS}.json`),
    JSON.stringify({ pid: process.pid, cwd: drepo, convId: 'dc2' }));
  F8.requestRole(BS, 'research', drepo);
  ok('a note to a LIVE role is not warned about (no noise when the chair is filled)',
    !/NOBODY HOLDS/.test(F8.requestNote(AS, 'research "ping"', drepo).message));

  // Claiming a role INHERITS its charter — the duty belongs to the role, not the holder.
  const claim = F8.requestRole(BS, 'research', drepo);
  ok('claiming a declared role tells you to ADOPT the existing charter, not rewrite it',
    /already declared/.test(claim.message) && /it is yours now/i.test(claim.message));
  const fresh = F8.requestRole(AS, 'android', drepo);
  ok('claiming an UNdeclared role asks you to write it (you are the first in this chair)',
    /NOT DECLARED/.test(fresh.message) && /\.arc\/roles\/android\.md/.test(fresh.message));

  // The roster is what `arc role` shows — one line per role, full charter one Read away.
  const q = F8.requestRole(AS, '', drepo);
  ok('`arc role` renders the roster with live/closed marks and the owns: summary',
    /roster:/.test(q.message) && /● research/.test(q.message)
    && /investigation and docs/.test(q.message));

  // The Stop hook must not tell you to wait for an answer that cannot come.
  const un = F8.unarmedRequests(AS, drepo);
  ok('unarmedRequests marks whether each target is actually live (arming a dead chair is futile)',
    un.notes.length > 0 && un.notes.every((n) => 'toLive' in n));

  fs.rmSync(drepo, { recursive: true, force: true });
  for (const s of [AS, BS]) for (const f of [`arc-state-${s}.json`, `arc-role-${s}.json`]) {
    try { fs.unlinkSync(path.join(CLAUDE, 'cache', f)); } catch {}
  }
} catch (e) { ok('duty roster', false, e.message + '\n' + (e.stack || '')); }

// ---- peer identity: a fork believes it is the session it was forked FROM -------------
// arc:invite forks the caller's conversation into the peer, so the peer inherits a transcript in
// which "the assistant" has been talking to the human for hours. Its default self-model is
// therefore "I am that session, reporting to that human" — and it behaves accordingly: it
// addresses the user, offers THEM work, and asks THEM to decide things a PEER asked it to decide.
// Observed twice, live. Claiming a role gives it a NAME; it does not overwrite an inherited
// relationship. Only the birth instruction can say the thing the transcript cannot.
section('peer identity (a forked peer must be told it is not who it remembers being)');
try {
  const F7 = require(path.join(SRC, 'arc-notes.js'));
  const swhook3 = path.join(SRC, 'arc-switch-hook.js');
  const irepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ident-'));
  fs.mkdirSync(path.join(irepo, '.git'), { recursive: true });
  const cache3 = path.join(CLAUDE, 'cache');

  const claim = (session, role = 'scout') => {
    const r = spawnSync(process.execPath, [swhook3], {
      input: JSON.stringify({ prompt: `arc:role ${role}`, cwd: irepo }), encoding: 'utf8',
      env: { ...process.env, ARC_SESSION: session },
    });
    try {
      const j = JSON.parse(r.stdout || '{}');
      return (j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || '';
    } catch { return ''; }
  };

  // A FORKED session — the runner records it, because the model cannot know it.
  const FK = 'ident-fork-' + process.pid;
  fs.writeFileSync(path.join(cache3, `arc-state-${FK}.json`),
    JSON.stringify({ pid: process.pid, cwd: irepo, convId: 'c-fork', forked: true }));
  ok('the runner records forkedness (the model cannot infer it — the transcript lies)',
    F7.isForkedSession(FK) === true);

  const fctx = claim(FK);
  ok('a forked peer is told the inherited transcript is NOT its history',
    /FORKED PEER/.test(fctx) && /INHERITED CONTEXT, not your history/.test(fctx));
  ok('...that the session it remembers being is now a PEER, and is not it',
    /is now a PEER of yours/.test(fctx) && /is NOT you/i.test(fctx));
  ok('...that the human in its tab is not its principal (do not offer them work)',
    /do not offer them work/i.test(fctx));
  ok('...and that a peer\'s decision goes back to that PEER, never to the human',
    /never ask them to decide something a peer asked/i.test(fctx) && /--reply-to/.test(fctx));

  // A NORMAL session (started by hand, no inherited context) must NOT get the identity lecture —
  // it has no false self-model to correct, and the words would just be confusing noise.
  const NM = 'ident-normal-' + process.pid;
  fs.writeFileSync(path.join(cache3, `arc-state-${NM}.json`),
    JSON.stringify({ pid: process.pid, cwd: irepo, convId: 'c-normal' }));
  const nctx = claim(NM, 'code');     // its OWN role: the fork above already holds "scout"
  ok('a normally-started session gets NO identity lecture (nothing to correct)',
    !/FORKED PEER/.test(nctx) && /arc join code/.test(nctx));

  // The standing rule, on the channel every woken peer actually reads: the injection.
  const notesSrc2 = fs.readFileSync(path.join(SRC, 'arc-notes.js'), 'utf8');
  ok('the note injection teaches ANSWER WHERE YOU WERE ASKED (the deliverable is the reply note)',
    /ANSWER WHERE YOU WERE ASKED/.test(notesSrc2) && /--reply-to/.test(notesSrc2)
    && /decide something a PEER asked YOU to decide/.test(notesSrc2));

  // And in the protocol doc, so it survives beyond the birth turn.
  const skill2 = fs.readFileSync(path.join(ROOT, 'skills', 'peers', 'SKILL.md'), 'utf8');
  ok('the peers skill states who you serve, and what an INVITED peer must not assume',
    /WHO YOU SERVE/.test(skill2) && /Answer where you were asked/i.test(skill2)
    && /forked peer/i.test(skill2) && /did not do the work you can see above/i.test(skill2));

  fs.rmSync(irepo, { recursive: true, force: true });
  for (const s of [FK, NM]) {
    for (const f of [`arc-state-${s}.json`, `arc-role-${s}.json`]) {
      try { fs.unlinkSync(path.join(cache3, f)); } catch {}
    }
  }
} catch (e) { ok('peer identity', false, e.message + '\n' + (e.stack || '')); }

// ---- BUG-4: a FORKED session had no conversation identity ---------------------------
// A fork's conversation id does not exist at launch — Claude Code mints it after the runner has
// already written arc-state, and the runner only reconciles the real id AFTER claude exits. So
// arc-state said `null` forever while the peer was alive, and THREE things broke off that one
// fact. (Found by the scout peer, whose own claim carried convId:null; the third one was found
// by the user, who lived it: an invited peer ran out of tokens, switched accounts to keep
// going, and its conversation vanished.)
section('BUG-4 (a forked peer had no conversation: could not invite, lost its role, re-forked)');
try {
  const F5 = require(path.join(SRC, 'arc-notes.js'));
  const RM5 = require(path.join(SRC, 'arc-board.js'));
  const RUN = require(path.join(SRC, 'arc-runner.js'));

  const frepo = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-'));
  spawnSync('git', ['init', '-q'], { cwd: frepo });
  const fboard = RM5.resolveBoard(frepo); RM5.ensureBoard(fboard);
  const FS_ = 'fork-sess-' + process.pid;
  const cache = path.join(CLAUDE, 'cache');
  fs.mkdirSync(cache, { recursive: true });

  // A LIVE FORK, exactly as the runner leaves it: state written with convId:null, while the
  // statusline has already bridged the real id to disk.
  fs.writeFileSync(path.join(cache, `arc-state-${FS_}.json`),
    JSON.stringify({ pid: process.pid, cwd: frepo, convId: null }));
  fs.writeFileSync(path.join(cache, `arc-active-${FS_}.json`),
    JSON.stringify({ convId: 'fork-conv-9999' }));

  ok('a fork\'s conversation id is read from the statusline bridge, not the stale state file',
    F5.sessionConv(FS_) === 'fork-conv-9999');

  // …which is what lets an invited peer INVITE. Without it, invite refused "nothing to fork",
  // so the peer graph could only ever be a one-level star around whoever started it.
  const I5 = require(path.join(SRC, 'arc-invite.js'));
  let spawnedFork = null;
  const okInv = I5.requestInvite(FS_, 'grandchild', frepo, {
    spawn: (b, a) => { spawnedFork = a; return { status: 0 }; }, hasWt: true,
    ensureTrusted: () => ({ ok: true, already: true }),
  });
  ok('...so an INVITED peer can now invite in turn (a peer tree, not a one-level star)',
    okInv.ok === true && spawnedFork.join(' ').includes('--resume fork-conv-9999'));

  // The CLAIM was written before the id was knowable, so it carries null — and role adoption on
  // restart matches a vacant claim BY CONVERSATION. That peer would silently lose its role.
  F5.requestRole(FS_, 'scout', frepo);
  const raw = RM5.roleClaim(fboard, 'scout');
  ok('(setup) a fork\'s claim is born with a conversation, now that one is readable',
    !!raw && raw.convId === 'fork-conv-9999');

  // And a claim that ALREADY carries null — every fork born before this fix — heals in place; the
  // Stop hook calls it every turn until it sticks. Write the broken shape DIRECTLY: claimRole
  // deliberately refuses to overwrite a known conversation with null, which is the right instinct
  // and also means it cannot be used to reproduce the damage.
  fs.writeFileSync(path.join(fboard.planDir, 'claim-scout.json'),
    JSON.stringify({ role: 'scout', pid: process.pid, sessionId: FS_, convId: null, at: Date.now() }));
  ok('(setup) the broken shape is reproduced', RM5.roleClaim(fboard, 'scout').convId === null);
  const healed = F5.healClaimConv(FS_, frepo);
  ok('a null-conversation claim HEALS once the id becomes knowable (role survives a restart)',
    healed && healed.conv === 'fork-conv-9999'
    && RM5.roleClaim(fboard, 'scout').convId === 'fork-conv-9999');
  ok('...and healing is idempotent — a no-op once the claim carries a conversation',
    F5.healClaimConv(FS_, frepo) === null);
  ok('...and it NEVER touches a claim held by another live session',
    (() => {
      RM5.claimRole(fboard, 'other', 999999, 'someone-else', null);   // a dead pid = not ours
      F5.healClaimConv(FS_, frepo);
      return RM5.roleClaim(fboard, 'other') === null;                 // still vacant, untouched
    })());

  // THE ONE THAT DESTROYED A CONVERSATION. `--fork-session` must NEVER survive into a relaunch:
  // on switch/restart the runner rebuilds args and re-adds --resume, so a surviving --fork-session
  // means claude resumes the peer's conversation and immediately BRANCHES it into a new one —
  // abandoning everything the peer built. The user hit this the first time an invited peer ran out
  // of tokens and switched accounts, which is precisely when its history mattered most.
  const born = ['--account', 'whale', '--resume', 'caller-conv', '--fork-session', 'arc:role scout'];
  const relaunch = RUN.stripConvArgs(born);
  ok('a relaunch NEVER re-forks: --fork-session is stripped (this is what ate a conversation)',
    !relaunch.includes('--fork-session'));
  ok('...and the birth prompt is not replayed forever (role re-adopts, listener re-arms on idle)',
    !relaunch.some((a) => /^arc:/i.test(a)));
  ok('...while the real flags survive untouched',
    relaunch.includes('--account') && relaunch.includes('whale') && !relaunch.includes('caller-conv'));

  fs.rmSync(frepo, { recursive: true, force: true });
  for (const f of [`arc-state-${FS_}.json`, `arc-active-${FS_}.json`, `arc-role-${FS_}.json`]) {
    try { fs.unlinkSync(path.join(cache, f)); } catch {}
  }
} catch (e) { ok('BUG-4', false, e.message + '\n' + (e.stack || '')); }

// ---- (d) the rate-limit SQUAT: holding a role while deaf ----------------------------
// A claim costs ZERO tokens (it is handled in-hook), but ARMING a listener costs a turn. On a
// rate-limited account the claim lands and the arming turn cannot run — so the session SQUATS the
// role while hearing nothing, and every peer addressing it is talking to an empty chair. Nothing
// in arc would have said so. The statusline already knew both facts. (Raised by the scout peer.)
section('(d) the rate-limit squat — a role-holder that never armed is shown as DEAF');
try {
  const F6 = require(path.join(SRC, 'arc-notes.js'));
  const A6 = require(path.join(SRC, 'arc-await.js'));
  const RM6 = require(path.join(SRC, 'arc-board.js'));
  const drepo = fs.mkdtempSync(path.join(os.tmpdir(), 'deaf-'));
  spawnSync('git', ['init', '-q'], { cwd: drepo });
  const dboard2 = RM6.resolveBoard(drepo); RM6.ensureBoard(dboard2);
  const DS = 'deaf-sess-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${DS}.json`),
    JSON.stringify({ pid: process.pid, cwd: drepo, convId: 'dc1' }));
  F6.requestRole(DS, 'code', drepo);
  A6.clearWaiting(DS); A6.clearOffered(DS);

  ok('a role-holder we have NOT yet asked to arm is not called deaf (that is just a fresh claim)',
    !(F6.badge(DS, drepo) || {}).deaf);

  A6.markOffered(DS);          // arc asked it to arm...
  ok('...but once arc ASKED and it never armed, it is DEAF (the rate-limit squat)',
    (F6.badge(DS, drepo) || {}).deaf === true);

  A6.markWaiting(DS, 'code', process.pid);   // ...and complying clears it
  ok('...and arming clears the warning immediately',
    !(F6.badge(DS, drepo) || {}).deaf);

  // The statusline must actually SHOW it — a fact nobody surfaces is a fact nobody has.
  const um = fs.readFileSync(path.join(SRC, 'usage-monitor.js'), 'utf8');
  ok('the statusline renders DEAF loudly',
    /f\.deaf \?/.test(um) && /DEAF/.test(um));
  // And it must NOT tell the USER to run `arc join` — a listener started outside the session
  // cannot wake it (only a background command the SESSION launched re-invokes the agent), so it
  // would look fixed while staying deaf. Only the agent can arm.
  ok('...without telling the user to run a listener that could never wake the session',
    !/DEAF[^`]*run: arc join/.test(um));

  // THE BUG THE WARNING CAUGHT, minutes after it shipped — in the session that wrote it.
  // "Ask once per cycle" used to close the cycle only when a Stop hook happened to OBSERVE a live
  // listener. That observation is not guaranteed: the hook that asked has already blocked the
  // turn, so its next firing returns immediately on stop_hook_active — and if a note lands before
  // any LATER turn ends, the listener exits with the offer marker never cleared. The session is
  // then deaf, and the hook says "already asked" forever. Arming is the compliance, so the cycle
  // must close when the listener is ARMED, not when someone gets lucky enough to see it.
  A6.clearWaiting(DS); A6.clearOffered(DS);
  A6.markOffered(DS);                                  // arc asked
  const prevEnv2 = process.env.ARC_SESSION;
  process.env.ARC_SESSION = DS;
  A6.awaitOnce('code', drepo, { pollMs: 5, maxPolls: 1, write: () => {} });   // the agent armed
  if (prevEnv2 === undefined) delete process.env.ARC_SESSION; else process.env.ARC_SESSION = prevEnv2;
  ok('ARMING clears the offer — so a listener that exits on a wake gets RE-OFFERED, not left deaf',
    A6.wasOffered(DS) === false);

  A6.clearWaiting(DS); A6.clearOffered(DS);
  fs.rmSync(drepo, { recursive: true, force: true });
  try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-state-${DS}.json`)); } catch {}
} catch (e) { ok('(d) rate-limit squat', false, e.message + '\n' + (e.stack || '')); }

// ---- the stance GATE: arc:mode drives whether an agent may spawn a peer ------------
// Everything else the stance governs is a model-level STEER (injected advice), which is right
// for a note: cheap, reversible, and "was this the user's order?" is a judgment only the model
// can make. `arc invite` is different in kind — it spawns a REAL SESSION (window, process, its
// own quota), and injected text cannot actually STOP an agent from running a command. So this
// one rides a PreToolUse hook and becomes enforceable: passive DENIES, balanced ASKS, active
// ALLOWS. The user's own `arc:invite` is a PROMPT, not a tool call, so it never reaches the gate
// — passive restrains the AGENT, never the human.
section('arc:mode gate (PreToolUse: passive denies · balanced asks · active allows)');
try {
  const HOOKP = path.join(SRC, 'arc-pretool-hook.js');
  const St3 = require(path.join(SRC, 'arc-stance.js'));
  const RM4 = require(path.join(SRC, 'arc-board.js'));
  const F4 = require(path.join(SRC, 'arc-notes.js'));

  const grepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  spawnSync('git', ['init', '-q'], { cwd: grepo });
  const gboard = RM4.resolveBoard(grepo); RM4.ensureBoard(gboard);
  const GS = 'gate-sess-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${GS}.json`),
    JSON.stringify({ pid: process.pid, cwd: grepo, convId: 'gc1' }));
  F4.requestRole(GS, 'code', grepo);

  const gate = (command, tool = 'Bash', session = GS) => {
    const r = spawnSync(process.execPath, [HOOKP], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd: grepo }),
      encoding: 'utf8', env: { ...process.env, ARC_SESSION: session },
    });
    if (!r.stdout || !r.stdout.trim()) return { decision: null, raw: '' };   // no output = defer
    try { const j = JSON.parse(r.stdout); return { decision: j.hookSpecificOutput.permissionDecision, reason: j.hookSpecificOutput.permissionDecisionReason, sys: j.systemMessage }; }
    catch { return { decision: 'PARSE-ERROR', raw: r.stdout }; }
  };

  // The three dial positions.
  St3.setStance(GS, 'passive');
  const den = gate('arc invite frontend');
  ok('PASSIVE denies an agent-initiated `arc invite`',
    den.decision === 'deny' && /passive/i.test(den.reason || ''));
  ok('...and tells the USER how to get the peer anyway (type arc:invite yourself)',
    /arc:invite/.test(den.sys || '') && /arc:mode balanced/.test(den.sys || ''));

  St3.setStance(GS, 'balanced');
  ok('BALANCED asks — the permission prompt IS the confirmation',
    gate('arc invite frontend').decision === 'ask');

  St3.setStance(GS, 'active');
  ok('ACTIVE allows — auto-approved, no prompt',
    gate('arc invite frontend').decision === 'allow');

  // The runaway guard: even ACTIVE asks once the board is crowded. Fails OPEN to a prompt, never
  // to a refusal — "spawn a helper" looks locally reasonable every single time, and each peer
  // burns its own quota.
  for (const r of ['a1', 'a2', 'a3']) RM4.claimRole(gboard, r, process.pid, `other-${r}`, null);
  const capped = gate('arc invite frontend');
  ok('ACTIVE still ASKS once several peers are already live (runaway guard)',
    capped.decision === 'ask' && /already live/i.test(capped.reason || ''));
  for (const r of ['a1', 'a2', 'a3']) RM4.releaseRole(gboard, r, process.pid);

  // Inertness. This hook sits in front of EVERY shell call, so anything that is not an invite
  // must produce NO output at all (= defer to the normal permission flow).
  St3.setStance(GS, 'passive');   // the strictest stance, to prove the bail-outs are real
  ok('a non-invite command is not touched, even in passive (no output = defer)',
    gate('git status').decision === null && gate('arc note code "hi"').decision === null
    && gate('arc join code').decision === null);
  // FAILS CLOSED by design: a mention inside a string is gated too. A false positive costs a
  // prompt; a false negative would let a session spawn ungated. And the honest limit — this is a
  // guardrail against self-initiation, not a sandbox: any string matcher can be walked around.
  ok('an invite hidden in a STRING is still gated (fails closed, never silently through)',
    gate('echo "run arc invite frontend"').decision === 'deny');
  ok('...but a CHAINED invite IS caught (cd x && arc invite y)',
    gate('cd /tmp && arc invite frontend').decision === 'deny');
  ok('a non-shell tool is never gated (matcher is Bash|PowerShell)',
    gate('arc invite frontend', 'Read').decision === null);
  ok('the PowerShell tool is gated too (an invited peer may have no Bash tool at all)',
    gate('arc invite frontend', 'PowerShell').decision === 'deny');
  ok('a NON-arc session is left completely alone (no ARC_SESSION)',
    gate('arc invite frontend', 'Bash', '').decision === null);

  // `arc invite` must stay OFF the allowlist, or the gate could never see an "ask": an allow
  // rule would satisfy the permission check before the prompt ever happened.
  const W2 = require(path.join(SRC, 'arc-wire-settings.js'));
  ok('`arc invite` is not allowlisted (else balanced could never ask)',
    !W2.BOARD_PERMISSIONS.some((p) => /invite/.test(p)));

  // The hook must be wired with a MATCHER — unmatched it would spawn node on every Read/Grep.
  const entries = W2.coreHookEntries('C:/x/scripts');
  const pre = entries.find((e) => e.event === 'PreToolUse');
  ok('the gate is wired on PreToolUse, MATCHED to the shell tools only',
    !!pre && pre.matcher === 'Bash|PowerShell' && /arc-pretool-hook\.js/.test(pre.command));
  const st2 = {};
  W2.mergeHooks(st2, entries);
  W2.mergeHooks(st2, entries);      // idempotent
  const grp = st2.hooks.PreToolUse.filter((g) => g.matcher === 'Bash|PowerShell');
  ok('...and it merges into its own matcher group, idempotently',
    grp.length === 1 && grp[0].hooks.length === 1);

  // The stance TEXT must teach the same rule the gate enforces, or the agent learns one thing
  // and the machine does another.
  ok('the passive directive warns that invite is refused',
    /arc invite/.test(St3.directive('passive')) && /REFUSED/.test(St3.directive('passive')));
  ok('the active directive grants the spawn (and mentions the cap)',
    /arc invite/.test(St3.directive('active')) && /auto-approved/.test(St3.directive('active')));

  fs.rmSync(grepo, { recursive: true, force: true });
  try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-state-${GS}.json`)); } catch {}
} catch (e) { ok('arc:mode gate', false, e.message + '\n' + (e.stack || '')); }

// ---- board permissions (an unattended peer must be able to run the board commands) -------
// The first INVITED peer reported `No such tool available: Bash` — it had only PowerShell. A
// Bash-only allowlist therefore matched nothing, `arc join` raised a permission prompt, and the
// tab sat there claimed-but-deaf: the exact failure the allowlist exists to prevent. (Found by
// the scout peer, in its own runtime.)
section('board permissions (every shell tool, or an invited peer hangs)');
try {
  const W = require(path.join(SRC, 'arc-wire-settings.js'));
  const perms = W.BOARD_PERMISSIONS;
  for (const tool of ['Bash', 'PowerShell']) {
    ok(`the allowlist covers ${tool} (a session may be given either shell tool)`,
      perms.includes(`${tool}(arc join:*)`) && perms.includes(`${tool}(arc notes:*)`)
      && perms.includes(`${tool}(arc note:*)`) && perms.includes(`${tool}(arc role:*)`));
  }
  // `arc invite` is deliberately NOT allowlisted: an agent spawning whole sessions stays a
  // per-spawn human decision.
  ok('`arc invite` is NOT auto-allowed (spawning sessions stays a human decision)',
    !perms.some((p) => /invite/.test(p)));

  const st = {};
  W.mergePermissions(st, perms);
  W.mergePermissions(st, perms);        // idempotent: re-running the installer must not duplicate
  ok('mergePermissions is idempotent (a re-install never duplicates a rule)',
    st.permissions.allow.length === perms.length);
  ok('...and it PRESERVES rules the user added themselves',
    (() => { const u = { permissions: { allow: ['Bash(git status)'] } }; W.mergePermissions(u, perms);
      return u.permissions.allow.includes('Bash(git status)') && u.permissions.allow.length === perms.length + 1; })());
} catch (e) { ok('board permissions', false, e.message); }

section('arc:invite (new tab, forked context, self-arming peer)');
try {
  const I = require(path.join(SRC, 'arc-invite.js'));
  const RM3 = require(path.join(SRC, 'arc-board.js'));
  const vrepo = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-'));
  fs.mkdirSync(path.join(vrepo, '.git'), { recursive: true });
  const VS = 'invite-sess-' + process.pid;
  fs.mkdirSync(path.join(CLAUDE, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${VS}.json`),
    JSON.stringify({ pid: process.pid, cwd: vrepo, convId: 'conv-abc-123' }));

  let spawned = null;
  const rec = (bin, args) => { spawned = { bin, args }; return { status: 0 }; };
  const psOf = () => (spawned ? spawned.args[spawned.args.indexOf('-Command') + 1] : '');

  // The happy path, wt present. The launcher is SYNCHRONOUS POWERSHELL — both facts are
  // load-bearing and were bisected live: wt.exe is a WindowsApps execution alias that drops
  // its args when CreateProcess'd from node, and its COM handoff to the running Terminal dies
  // if the spawner exits first (detached => status 0, no tab, silence).
  const okr = I.requestInvite(VS, 'frontend', vrepo, { spawn: rec, hasWt: true });
  ok('invite launches via SYNC PowerShell: a wt tab in the CURRENT window at the repo root',
    okr.ok === true && spawned && spawned.bin === 'powershell.exe'
    && /wt -w 0 new-tab/.test(psOf()) && psOf().includes(`-d '${vrepo}'`));
  ok('...running a FORK of the caller\'s conversation',
    /--resume conv-abc-123 --fork-session/.test(psOf()));
  ok('...whose opening prompt is the arc:role sentinel, quote-nested to survive PS->wt->cmd',
    psOf().includes(`'"arc:role frontend"'`));
  ok('...and the confirmation tells the caller how to reach the newcomer',
    /inviting a "frontend" peer/.test(okr.message));

  // Account pinning: conversations live in per-account profiles — a tab that auto-selected a
  // different account would not find the transcript and the fork would die.
  const oldAcct = process.env.ARC_RUNTIME_ACCOUNT;
  process.env.ARC_RUNTIME_ACCOUNT = 'veneto';
  I.requestInvite(VS, 'backend', vrepo, { spawn: rec, hasWt: true });
  ok('invite PINS the caller\'s account (the transcript only exists in that profile)',
    /arc --account veneto --resume/.test(psOf()));
  if (oldAcct === undefined) delete process.env.ARC_RUNTIME_ACCOUNT; else process.env.ARC_RUNTIME_ACCOUNT = oldAcct;

  // No wt: fall back to a fresh console window via `start`.
  I.requestInvite(VS, 'scout', vrepo, { spawn: rec, hasWt: false });
  ok('without Windows Terminal, invite falls back to a new console window',
    /cmd \/c start "arc: scout"/.test(psOf()));

  // A failing launcher must be REPORTED, not swallowed. The obvious guard was WRONG: spawnSync
  // returns status:NULL on both real failure paths — timeout (ETIMEDOUT) and missing binary
  // (ENOENT) — so `status !== 0 && status !== null` fired on NEITHER and invite printed its ✓
  // with no tab. The exact silent no-tab the guard existed to catch. (Found by the scout peer.)
  const badExit = I.requestInvite(VS, 'flaky', vrepo, { spawn: () => ({ status: 1 }), hasWt: true });
  ok('a launcher that exits non-zero is reported (never a silent no-tab)',
    badExit.ok === false && /could not open the new tab/.test(badExit.message));
  const badTimeout = I.requestInvite(VS, 'flaky', vrepo, {
    spawn: () => ({ status: null, error: { code: 'ETIMEDOUT' } }), hasWt: true });
  ok('...and a TIMEOUT (status null + ETIMEDOUT) is reported, not read as success',
    badTimeout.ok === false && /ETIMEDOUT/.test(badTimeout.message));
  const badEnoent = I.requestInvite(VS, 'flaky', vrepo, {
    spawn: () => ({ status: null, error: { code: 'ENOENT' } }), hasWt: true });
  ok('...and a MISSING BINARY (status null + ENOENT) is reported, not read as success',
    badEnoent.ok === false && /ENOENT/.test(badEnoent.message));

  // The peer's tab must be identifiable. Claude Code sets the terminal title from the project
  // folder, so without --suppressApplicationTitle both tabs read "arc" and you cannot tell the
  // caller from the peer it spawned.
  I.requestInvite(VS, 'titled', vrepo, { spawn: rec, hasWt: true });
  ok('the peer tab is titled by ROLE and keeps it (--suppressApplicationTitle)',
    /--title 'arc: titled' --suppressApplicationTitle/.test(psOf()));

  // ---- the trust dialog: the invited tab has NO HUMAN to answer it -------------------
  // Claude Code asks "Do you trust the files in this folder?" per PROJECT PATH, per account
  // profile. Found live: invite launched at the CANONICAL board root ("e:\\arc") while the
  // caller ran as "E:\\arc" — a DIFFERENT project key, so it inherited none of the caller's
  // trust and the tab sat at the dialog forever: claimed, deaf, silent about why.
  const canonRoot2 = RM3.resolveBoard(vrepo).root;   // canonical = LOWERCASED (board identity)
  I.requestInvite(VS, 'pathcheck', vrepo, { spawn: rec, hasWt: true });
  ok('invite launches at the CALLER\'s real path, NOT the canonical (lowercased) board root',
    psOf().includes(`-d '${vrepo}'`) && !psOf().includes(`-d '${canonRoot2}'`)
    && vrepo !== canonRoot2);   // the two really do differ, or this proves nothing

  // The profile config it must seed (a throwaway stand-in for ~/.claude/arc-profiles/<id>).
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
  const pcfg = path.join(prof, '.claude.json');
  fs.writeFileSync(pcfg, JSON.stringify({ projects: { 'E:/other': { hasTrustDialogAccepted: true } } }, null, 2));

  const t1 = I.ensureTrusted('E:\\arc', { configDir: prof });
  const after = JSON.parse(fs.readFileSync(pcfg, 'utf8'));
  ok('ensureTrusted pre-accepts the folder, keyed with FORWARD SLASHES like Claude Code does',
    t1.ok === true && t1.seeded === true && after.projects['E:/arc'].hasTrustDialogAccepted === true);
  ok('...and it backs up Claude Code\'s live config before touching it',
    fs.existsSync(pcfg + '.bak-arc'));
  ok('...and it leaves every OTHER project untouched',
    after.projects['E:/other'].hasTrustDialogAccepted === true && Object.keys(after.projects).length === 2);

  // Already trusted => a no-op. The common case must not rewrite the user's config every invite.
  fs.unlinkSync(pcfg + '.bak-arc');
  const t2 = I.ensureTrusted('E:\\arc', { configDir: prof });
  ok('an already-trusted folder is a NO-OP (no needless rewrite of a live config)',
    t2.ok === true && t2.already === true && !fs.existsSync(pcfg + '.bak-arc'));

  // No profile => say so plainly; never guess a path to write.
  ok('with no account profile, ensureTrusted refuses and explains (never writes blind)',
    I.ensureTrusted('E:\\arc', { configDir: '' }).ok === false);

  // THE SAFETY PROPERTY: invite only ever trusts the folder the CALLER is already working in.
  // It is spawn-time-derived from the caller's own session, never taken from the argument, so
  // there is no path by which `arc:invite <role>` can trust somewhere else.
  let trustedPath = null;
  I.requestInvite(VS, 'auditor', vrepo, {
    spawn: rec, hasWt: true,
    ensureTrusted: (dir) => { trustedPath = dir; return { ok: true, already: true }; },
  });
  ok('invite ONLY ever trusts the caller\'s own repo root — never an arbitrary path',
    trustedPath === RM3.repoRoot(vrepo));

  fs.rmSync(prof, { recursive: true, force: true });

  // Refusals — every one is a zero-token block and must NOT spawn anything.
  spawned = null;
  ok('invite with no role shows usage', I.requestInvite(VS, '', vrepo, { spawn: rec, hasWt: true }).ok === false);
  ok('invite refuses an invalid role name',
    /invalid role/.test(I.requestInvite(VS, 'Bad Role!', vrepo, { spawn: rec, hasWt: true }).message));
  // A SESSION whose own home is not a repo: there is no board to invite anyone onto.
  const noRepo3 = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-nr-'));
  const VS3 = 'invite-norepo-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${VS3}.json`),
    JSON.stringify({ pid: process.pid, cwd: noRepo3, convId: 'c9' }));
  ok('invite refuses when the SESSION is not in a git repo (same guard as a claim)',
    /not a git repository/.test(I.requestInvite(VS3, 'frontend', noRepo3, { spawn: rec, hasWt: true }).message));
  // THE ENFORCEMENT: the folder we launch in and pre-trust comes from the RUNNER'S recorded cwd,
  // never from the caller's argument — otherwise an agent could `cd` into any repo on the machine
  // and have invite pre-trust it. The security rule was documentation; now it is enforced.
  // (Found by the scout peer.)
  let trustedFrom = null;
  I.requestInvite(VS, 'sneaky', noRepo3, {          // a HOSTILE cwd argument: a different folder
    spawn: rec, hasWt: true,
    ensureTrusted: (dir) => { trustedFrom = dir; return { ok: true, already: true }; },
  });
  ok('a caller-supplied cwd CANNOT redirect the launch or the trust (agent-forgeable input)',
    trustedFrom === RM3.repoRoot(vrepo) && psOf().includes(`-d '${vrepo}'`));
  spawned = null;    // that one legitimately spawned; the refusal assertions below need a clean slate
  // A held role: the would-be invite target already exists — point at the note instead.
  const board3 = RM3.resolveBoard(vrepo); RM3.ensureBoard(board3);
  RM3.claimRole(board3, 'research', process.pid, 'other-sess', null);
  const heldr = I.requestInvite(VS, 'research', vrepo, { spawn: rec, hasWt: true });
  ok('invite refuses a role a LIVE session already holds — that session IS the peer',
    heldr.ok === false && /already held/.test(heldr.message) && /arc note research/.test(heldr.message));
  // No conversation id: nothing to fork.
  const VS2 = 'invite-noconv-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${VS2}.json`), JSON.stringify({ pid: process.pid, cwd: vrepo }));
  ok('invite refuses when the conversation has no id yet (nothing to fork)',
    /nothing to fork/.test(I.requestInvite(VS2, 'frontend', vrepo, { spawn: rec, hasWt: true }).message));
  ok('no refusal ever spawned anything', spawned === null);

  // The runner-side enabler: a FORK must skip the duplicate-conversation guard AND must not
  // claim (or later release) the source conversation's lock — claimConv would overwrite the
  // real owner's lock file, after which the owner could not even restart itself.
  const runnerSrc = fs.readFileSync(path.join(SRC, 'arc-runner.js'), 'utf8');
  ok('the duplicate-launch guard skips forks (invite forks a LIVE caller by design)',
    /isFork = userArgs\.includes\('--fork-session'\)/.test(runnerSrc)
    && /!forceDup && !isFork && guardConv/.test(runnerSrc));

  fs.rmSync(vrepo, { recursive: true, force: true });
  fs.rmSync(noRepo3, { recursive: true, force: true });
} catch (e) { ok('arc:invite', false, e.message + '\n' + (e.stack || '')); }

// ---- arc-await (the ONLY thing that can reach an idle session) -------------------
// arc runs claude on a real TTY and holds no handle into it; Claude Code has no timer hook.
// So exactly one thing pulls back an idle session: a background command IT started, whose
// EXIT re-invokes it. `arc await` is that command. (`arc watch` used to live here — it
// streamed forever and never exited, so it could never wake anything on its own.)
//
// That EXIT is covered by a real subprocess further down (it is the property under test, so
// it must be a real process). What is tested here is the ARMED MARKER — the state that lets
// the Stop hook arm a listener at every idle without stacking up a waiter per turn.
section('arc-await (blocks, then its EXIT is the wake)');
try {
  const A = require(path.join(SRC, 'arc-await.js'));
  const RM = require(path.join(SRC, 'arc-board.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clawait-'));
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const board = RM.resolveBoard(repo); RM.ensureBoard(board);

  ok('resolveRole prefers an explicit arg', A.resolveRole('research', 'sess', board) === 'research');
  ok('resolveRole with no arg + no session -> null', A.resolveRole('', '', board) === null);

  const WS = 'await-sess-' + process.pid;
  A.clearWaiting(WS);
  ok('a session with no waiter is NOT waiting (so the hook will arm one)',
    A.isWaiting(WS) === false);

  A.markWaiting(WS, 'research', process.pid);            // a LIVE pid: this very test process
  ok('a live waiter marks the session as already listening (no duplicate arm per turn)',
    A.isWaiting(WS) === true);

  // THE property that decides whether a crash makes a session permanently deaf: the test is
  // LIVENESS, not existence. A stale marker left by a dead waiter must re-arm — otherwise the
  // session never hears another note and nothing ever tells it why.
  A.markWaiting(WS, 'research', 999999);                 // a pid that cannot be alive
  ok('a DEAD waiter does not count — the session re-arms instead of going deaf forever',
    A.isWaiting(WS) === false);
  ok('...and the stale marker is swept, not left to rot', !fs.existsSync(A.awaitFile(WS)));

  ok('clearWaiting is idempotent (safe on an already-gone marker)',
    (() => { try { A.clearWaiting(WS); A.clearWaiting(WS); return true; } catch { return false; } })());

  // RE-ARMING must not leak. markWaiting overwrites the marker, so a previous listener for the
  // same session would keep polling while being unfindable BY session — an invisible orphan
  // that nothing could ever clean up. Re-arming is routine (a manual `arc join`, a restart's
  // re-arm), so each one would leak a process for the rest of the machine's uptime.
  // (Found by the arc:invite loop: a duplicate `join code` survived a restart exactly this way.)
  const { spawn: spawnBg } = require('child_process');
  const ghost = spawnBg(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  A.markWaiting(WS, 'research', ghost.pid);
  const prevEnv = process.env.ARC_SESSION;            // awaitOnce reads the session from the env
  process.env.ARC_SESSION = WS;
  A.awaitOnce('research', repo, { pollMs: 5, maxPolls: 1, write: () => {} });
  if (prevEnv === undefined) delete process.env.ARC_SESSION; else process.env.ARC_SESSION = prevEnv;
  ok('re-arming SUPERSEDES the session\'s previous listener (never leaks a polling orphan)',
    (() => { try { process.kill(ghost.pid, 0); return false; } catch { return true; } })());
  try { ghost.kill(); } catch {}

  // awaitOnce checks the board SYNCHRONOUSLY on entry (inside the Promise executor), so a note
  // that is already waiting is reported before the first poll interval — no wait, no flake.
  RM.appendNote(board, { from: 'android', to: 'research', body: 'investigate the tap drop' });
  const said = [];
  A.awaitOnce('research', repo, { pollMs: 5, write: (l) => said.push(l) });
  ok('a note already on the board is seen immediately (no polling delay)',
    said.some((l) => /investigate the tap drop/.test(l)));
  ok('...and it tells the woken agent to run `arc notes` (a wake is not a turn, so the',
    said.some((l) => /arc notes/.test(l)));   // ...turn-start injection does NOT fire for it
  ok('await only OBSERVES — it never advances the read cursor',
    RM.readCursor(board, 'research') === 0 && RM.unreadFor(board, 'research').count === 1);

  // A listener exists to WAKE ITS SESSION. When that session dies it has nothing left to wake,
  // and nothing stops it: it is a detached background process whose poll loop would happily run
  // for the rest of the machine's uptime. Found by the arc:invite loop — five listeners alive,
  // most of them orphans of long-dead sessions, each still polling the board every 2.5s.
  const ORPH = 'orphan-sess-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${ORPH}.json`),
    JSON.stringify({ pid: 999999, cwd: repo }));          // an owner pid that cannot be alive
  const before = fs.existsSync(A.awaitFile(ORPH));
  const orphRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'orph-'));
  fs.mkdirSync(path.join(orphRepo, '.git'), { recursive: true });
  const oc = spawnSync(process.execPath, ['-e',
    `process.env.ARC_SESSION = ${JSON.stringify(ORPH)};`
    + `require(${JSON.stringify(path.join(SRC, 'arc-await.js'))}).awaitOnce('research', ${JSON.stringify(orphRepo)}, { pollMs: 20 })`
    + `.then((c) => process.exit(c));`,
  ], { encoding: 'utf8', timeout: 8000, env: { ...process.env, ARC_SESSION: ORPH } });
  ok('a listener whose SESSION DIED exits instead of polling forever (no leaked process)',
    oc.status === 0 && !oc.error, oc.error ? 'timed out — it kept polling' : '');
  ok('...and it clears its own armed marker on the way out',
    !before && !fs.existsSync(A.awaitFile(ORPH)));
  fs.rmSync(orphRepo, { recursive: true, force: true });
  try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-state-${ORPH}.json`)); } catch {}

  fs.rmSync(repo, { recursive: true, force: true });
} catch (e) { ok('arc-await works', false, e.message + '\n' + (e.stack || '')); }

// ---- arc-profile: adoptIntoShared (migrate a real dir into the shared one) -------
// Regression: `tasks` joined SHARED_DIRS. The old code did rmSync(recursive) on the
// profile's REAL dir before junctioning — which would have DELETED every profile's
// task lists on the next launch. Nothing may ever be destroyed here.
section('arc-profile (adoptIntoShared: migrate, never clobber)');
try {
  const P = require(path.join(SRC, 'arc-profile.js'));
  ok('tasks is shared (so arc:switch keeps the task list)', P.SHARED_DIRS.includes('tasks'));

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-'));
  const shared = path.join(base, 'shared');
  const link = path.join(base, 'profile', 'tasks');
  fs.mkdirSync(path.join(shared, 'sess-A'), { recursive: true });   // shared has real work
  fs.writeFileSync(path.join(shared, 'sess-A', '44.json'), '{"id":"44"}');
  fs.mkdirSync(path.join(link, 'sess-A'), { recursive: true });     // profile: empty shell
  fs.writeFileSync(path.join(link, 'sess-A', '.lock'), '');
  fs.mkdirSync(path.join(link, 'sess-B'), { recursive: true });     // profile: unique work
  fs.writeFileSync(path.join(link, 'sess-B', '1.json'), '{"id":"1"}');

  // C.CLAUDE_DIR drives the backup path; point it at our sandbox for the duration.
  const C = require(path.join(SRC, 'arc-config.js'));
  const realClaudeDir = C.CLAUDE_DIR;
  Object.defineProperty(C, 'CLAUDE_DIR', { value: base, configurable: true });
  const cleared = P.adoptIntoShared(link, shared, 'acct1', 'tasks');
  Object.defineProperty(C, 'CLAUDE_DIR', { value: realClaudeDir, configurable: true });

  ok('reports the link is clear', cleared === true);
  ok('the real dir is gone (rmdir succeeded => it was empty)', !fs.existsSync(link));
  ok('unique session MOVED into shared', fs.existsSync(path.join(shared, 'sess-B', '1.json')));
  ok('collision: the SHARED copy survives untouched',
    fs.readFileSync(path.join(shared, 'sess-A', '44.json'), 'utf8') === '{"id":"44"}');
  const bak = path.join(base, 'cl-backup', 'profile-merge', 'acct1', 'tasks', 'sess-A');
  ok('collision: the profile copy is PARKED, not deleted', fs.existsSync(path.join(bak, '.lock')));

  // A FILE where the junction goes must never be removed.
  const f = path.join(base, 'afile');
  fs.writeFileSync(f, 'precious');
  ok('refuses to clear a FILE', P.adoptIntoShared(f, shared, 'acct1', 'x') === false);
  ok('the file is untouched', fs.readFileSync(f, 'utf8') === 'precious');

  // Nothing there at all -> clear to junction.
  ok('missing link is trivially clear', P.adoptIntoShared(path.join(base, 'nope'), shared, 'a', 'x') === true);

  fs.rmSync(base, { recursive: true, force: true });
} catch (e) { ok('arc-profile adoptIntoShared works', false, e.message); }

// ---- arc-conv (convId reconciliation — the "switch resumes a new session" fix) --
section('arc-conv (convId reconciliation)');
try {
  const { pickConvId } = require(path.join(SRC, 'arc-conv.js'));
  // hasTranscript predicate over a fixed set of "real" (persisted) ids.
  const real = new Set(['live-28118b62']);
  const has = (id) => real.has(id);

  // Managed session DRIFTED: we track a phantom (no transcript); the statusline
  // bridged the real live id → must adopt the real one (else --session-id mints a
  // new empty session — the reported bug).
  ok('adopts real bridged id over a phantom tracked id',
    pickConvId('phantom-62babd46', 'live-28118b62', false, has) === 'live-28118b62');

  // Bare picker resume (`cl --resume`): cl assigned no id → always adopt the
  // bridged id the user picked.
  ok('picker resume adopts the bridged id (userManagesConv)',
    pickConvId(null, 'live-28118b62', true, has) === 'live-28118b62');

  // Healthy managed session: what we track already matches reality → no change.
  ok('keeps tracked id when it matches the bridge',
    pickConvId('live-28118b62', 'live-28118b62', false, has) === 'live-28118b62');

  // Do NOT adopt a bridged id that has no transcript (transient/bogus) over a
  // tracked managed id — only real persisted conversations are adopted.
  ok('ignores a bogus bridged id with no transcript (managed)',
    pickConvId('live-28118b62', 'ghost-00000000', false, has) === 'live-28118b62');

  // No bridge yet (statusline hasn't rendered) → keep whatever we track.
  ok('keeps tracked id when bridge is empty',
    pickConvId('live-28118b62', null, false, has) === 'live-28118b62');
} catch (e) { ok('arc-conv pickConvId works', false, e.message); }

// ---- arc-help + the arc:help hook (zero-token cheat sheet) --------------------
section('arc-help + arc:help hook');
try {
  const renderHelp = require(path.join(SRC, 'arc-help.js'));
  ok('arc-help exports a render function', typeof renderHelp === 'function');
  const sheet = renderHelp();
  ok('cheat sheet lists arc:help and arc:switch', /arc:help/.test(sheet) && /arc:switch/.test(sheet));

  // End-to-end: the hook must BLOCK arc:help / arc:cl (case-insensitive) and return
  // the sheet as the reason — zero model tokens, exactly like arc:peek.
  const hook = path.join(SRC, 'arc-switch-hook.js');
  // arc: is the current prefix; arc: is the deprecated alias — BOTH must trigger.
  for (const trig of ['arc:help', 'arc:arc', 'ARC:HELP']) {
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ prompt: trig }), encoding: 'utf8' });
    let out = {}; try { out = JSON.parse(r.stdout || '{}'); } catch {}
    ok(`hook blocks "${trig}" with the cheat sheet`, out.decision === 'block' && /(arc|cl) — commands/.test(out.reason || ''));
  }
  // A non-sentinel prompt must pass straight through (no block, empty stdout).
  const pass = spawnSync(process.execPath, [hook], { input: JSON.stringify({ prompt: 'hello world' }), encoding: 'utf8' });
  ok('non-sentinel prompt passes through (no block)', (pass.stdout || '').trim() === '');
} catch (e) { ok('arc:help hook works', false, e.message); }

// ---- arc-board (the "board": per-board append-only sticky-note ledger) ---------
section('arc-board (sticky-note ledger)');
try {
  const R = require(path.join(SRC, 'arc-board.js'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clboard-'));
  const repo = path.join(base, 'proj');
  fs.mkdirSync(path.join(repo, 'sub', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'));                       // fake repo root

  // 1) board = git repo root, from anywhere inside it
  const rTop = R.resolveBoard(repo), rDeep = R.resolveBoard(path.join(repo, 'sub', 'deep'));
  ok('board resolves to the git repo root from a subdir', rTop.root === rDeep.root);
  const outside = path.join(base, 'loose'); fs.mkdirSync(outside);
  ok('no repo → the folder itself is the board', R.resolveBoard(outside).root === R.canonical(outside));
  ok('a board is never nameless', !!R.resolveBoard(repo).name && !!R.resolveBoard('C:\\').name);

  // 2) the board self-ignores
  R.ensureBoard(rTop);
  const gi = fs.readFileSync(path.join(rTop.planDir, '.gitignore'), 'utf8');
  ok('the board .gitignore ignores everything (incl. itself)', /^\*$/m.test(gi));

  // 3) append + seq is the LINE NUMBER (race-free: two writers can't collide)
  R.appendNote(rTop, { from: 'research', to: 'coding', body: 'spec for P-014 changed' });
  R.appendNote(rTop, { from: 'coding', to: 'research', body: 'P-012 done', refs: { sha: 'abc123' } });
  R.appendNote(rTop, { from: 'research', body: 'broadcast: repo layout moved' }); // to=null
  const all = R.allNotes(rTop);
  ok('seq is the 1-based line number, in order', all.map((n) => n.seq).join(',') === '1,2,3');
  ok('notes round-trip (refs preserved)', all[1].refs && all[1].refs.sha === 'abc123');
  ok('note count matches', R.noteCount(rTop) === 3);

  // 4) unread: addressed-to-me + broadcast, never my own, respects cursor
  const uCoding = R.unreadFor(rTop, 'coding');
  ok('coding sees the note addressed to it + the broadcast', uCoding.count === 2);
  ok('coding never sees its OWN note', !uCoding.notes.some((n) => n.from === 'coding'));
  ok('senders listed', uCoding.senders.join(',') === 'research');
  const uResearch = R.unreadFor(rTop, 'research');
  ok('research sees only the note addressed to it (not its own broadcast)', uResearch.count === 1);

  // 5) rd()-only: markRead advances a cursor, never removes a note
  R.markRead(rTop, 'coding');
  ok('after markRead, coding has 0 unread', R.unreadFor(rTop, 'coding').count === 0);
  ok('notes were NOT consumed (rd()-only)', R.noteCount(rTop) === 3);
  ok('the OTHER role\'s cursor is untouched', R.unreadFor(rTop, 'research').count === 1);

  // 6) a new note after markRead shows up again
  R.appendNote(rTop, { from: 'research', to: 'coding', body: 'one more' });
  ok('new note reappears for coding', R.unreadFor(rTop, 'coding').count === 1);

  // 7) torn/garbage line is skipped, not fatal
  fs.appendFileSync(R.notesPath(rTop), '{not json\n');
  ok('a torn line is skipped, remaining notes survive', R.allNotes(rTop).length === 4);
  R.markRead(rTop, 'coding');
  ok('markRead advances past a torn physical line', R.readCursor(rTop, 'coding') === 5);
  R.appendNote(rTop, { from: 'research', to: 'coding', body: 'after torn line' });
  const afterTorn = R.unreadFor(rTop, 'coding');
  ok('a note after a torn line is delivered exactly once at its physical seq',
    afterTorn.count === 1 && afterTorn.notes[0].seq === 6);
  R.markRead(rTop, 'coding');
  ok('a note after a torn line does not redeliver forever', R.unreadFor(rTop, 'coding').count === 0);

  // 8) role claim. IDENTITY IS THE SESSION; the pid is only a liveness probe.
  ok('claim a free role', R.claimRole(rTop, 'coding', process.pid, 's1').ok === true);
  // A different LIVE session must be refused even if it reports the SAME pid.
  // (This is the bug the end-to-end test caught — pid alone is not identity.)
  const second = R.claimRole(rTop, 'coding', process.pid, 's2');
  ok('a different live session is refused (even with same pid)', second.ok === false && second.holder.sessionId === 's1');
  // arc:restart re-execs arc-runner: SAME session, NEW pid → must reclaim its own role.
  ok('same session reclaims under a NEW pid (restart-safe)', R.claimRole(rTop, 'coding', process.pid + 1, 's1').ok === true);
  fs.writeFileSync(path.join(rTop.planDir, 'claim-coding.json'), JSON.stringify({ role: 'coding', pid: 999999, sessionId: 's9', at: Date.now() }));
  ok('a DEAD holder\'s claim is vacant', R.roleClaim(rTop, 'coding') === null);
  ok('a vacant role can be claimed by anyone', R.claimRole(rTop, 'coding', process.pid, 's3').ok === true);
  ok('liveRoles lists live holders only', R.liveRoles(rTop).map((l) => l.role).join(',') === 'coding');
} catch (e) { ok('arc-board works', false, e.message); }

// ---- arc-notes (the arc: sentinels over the ledger) ---------------------------
section('arc-notes (role / note / notes)');
try {
  const F = require(path.join(SRC, 'arc-notes.js'));
  const R2 = require(path.join(SRC, 'arc-board.js'));
  const base2 = fs.mkdtempSync(path.join(os.tmpdir(), 'clboard-'));
  const repo2 = path.join(base2, 'proj');
  fs.mkdirSync(path.join(repo2, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(repo2, '.git'));
  const cache = path.join(CLAUDE, 'cache'); fs.mkdirSync(cache, { recursive: true });
  const mkSession = (sid, pid) => writeJSON(path.join(cache, `arc-state-${sid}.json`), { pid, cwd: repo2 });
  mkSession('sa', process.pid); mkSession('sb', process.pid); mkSession('sc', process.pid);

  // roles claimed from a SUBDIR still land in the repo-root board
  const ra = F.requestRole('sa', 'research', path.join(repo2, 'sub'));
  ok('arc:role claims a role from a subdir (board = repo root)', ra.ok === true && /the "proj" board/.test(ra.message));
  // The claim makes you ADDRESSABLE, not yet reachable-while-idle — a listener needs a TURN.
  // The result carries armNeeded so the sentinel hook can SPEND one (pass-through) to arm; the
  // message carries the instruction for the CLI path, where the agent is already mid-turn.
  ok('...and a fresh claim reports armNeeded + the exact arm command',
    ra.armNeeded === true && ra.role === 'research' && /arc join research/.test(ra.message));
  ok('arc:role coding (second peer)', F.requestRole('sb', 'coding', repo2).ok === true);
  const rc = F.requestRole('sc', 'coding', repo2);
  ok('a third session is REFUSED a held role', rc.ok === false && /already held by a LIVE session/.test(rc.message));

  // Caught live in the first two-session drill: a responder launched in a NON-REPO dir (E:\)
  // claimed its role on a junk "e:\" board while its peer sat on "e:\arc" — two boards, zero
  // contact, no error anywhere. A claim in a non-repo must REFUSE and say where to go, and it
  // must not leave a .plan/ behind (minting one at a drive root is how the junk spreads).
  const norepo = fs.mkdtempSync(path.join(os.tmpdir(), 'norepo-'));
  const nrc = F.requestRole('sd', 'research', norepo);
  ok('claiming a role in a NON-REPO dir is refused (wrong-board drill bug)',
    nrc.ok === false && /not a git repository/.test(nrc.message) && /cd into the project repo/.test(nrc.message));
  ok('...and the refusal leaves no .plan behind (no junk boards at drive roots)',
    !fs.existsSync(path.join(norepo, '.plan')));
  fs.rmSync(norepo, { recursive: true, force: true });

  // notes
  ok('arc:note needs a role', F.requestNote('sc', 'coding hi', repo2).ok === false);
  ok('arc:note rejects a note to yourself', F.requestNote('sa', 'research hi', repo2).ok === false);
  ok('arc:note usage error on bad args', F.requestNote('sa', 'onlyone', repo2).ok === false);
  ok('arc:note appends', F.requestNote('sa', 'coding P-014 spec changed', repo2).ok === true);
  ok('arc:note broadcast (all)', F.requestNote('sa', 'all repo layout moved', repo2).ok === true);

  // notes readout + rd()-only cursor
  const n1 = F.requestNotes('sb', '', repo2);
  ok('arc:notes shows both (addressed + broadcast)', /2 new from research/.test(n1.message));
  const n2 = F.requestNotes('sb', '', repo2);
  ok('arc:notes is empty after reading (cursor advanced)', /nothing new/.test(n2.message));
  const board2 = R2.resolveBoard(repo2);
  ok('notes were NOT consumed', R2.noteCount(board2) === 2);
  // rd()-only, proved properly: coding just read everything, yet a DIFFERENT reader
  // still finds the broadcast waiting. A note is never taken off the board.
  ok('a fresh role still sees the broadcast after coding read it', R2.unreadFor(board2, 'qa').count === 1);
  ok('research never sees its own two notes', R2.unreadFor(board2, 'research').count === 0);
  const nAll = F.requestNotes('sc', 'all', repo2);
  ok('arc:notes all = landlord view, no role needed', /ALL 2 note\(s\)/.test(nAll.message));

  // restart: same session, NEW pid → role + claim survive
  mkSession('sb', process.pid + 1);                       // simulate arc-runner re-exec
  const rr = F.refreshRole('sb', process.pid + 1, repo2);
  ok('refreshRole re-asserts the claim after restart', rr && rr.ok === true && rr.role === 'coding');
  ok('and the role still resolves for that session', F.getRole('sb', board2) === 'coding');
  ok('refreshRole is a no-op for a session with no role and no conversation', F.refreshRole('zz', 999, repo2) === null);

  // ---- LEGACY SHIMS: the board/peer/claim rename must not orphan LIVE state -----------
  // A board used to be a "room" and a claim used to be a "lease". Sessions were live when the
  // rename landed, holding state written in the old shape. Reading only the new keys would
  // silently drop their role — they'd receive nothing, with nothing to say why.
  writeJSON(path.join(cache, 'arc-role-legacy1.json'), { room: board2.root, role: 'legacyrole', at: Date.now() });
  ok('a LEGACY role file (room: key) still resolves — a live session keeps its role',
    F.getRole('legacy1', board2) === 'legacyrole');
  writeJSON(path.join(cache, 'arc-role-legacy2.json'), { board: board2.root, role: 'newrole', at: Date.now() });
  ok('...and the new (board: key) shape resolves too', F.getRole('legacy2', board2) === 'newrole');
  // a legacy lease-*.json IS a claim: if it went invisible, a second session would take the
  // same role, share its cursor, and eat its notes — the exact failure claims prevent.
  fs.writeFileSync(path.join(board2.planDir, 'lease-legacyclaim.json'),
    JSON.stringify({ role: 'legacyclaim', pid: process.pid, sessionId: 'old-sess', at: Date.now() }));
  ok('a LEGACY claim file (lease-*.json) is still seen as HELD, not vacant',
    !!R2.roleClaim(board2, 'legacyclaim') && R2.liveRoles(board2).some((l) => l.role === 'legacyclaim'));
  ok('...so another session is REFUSED that role (no shared cursor)',
    R2.claimRole(board2, 'legacyclaim', process.pid, 'different-session').ok === false);
  // claiming it as its OWN holder migrates it onto the new name
  R2.claimRole(board2, 'legacyclaim', process.pid, 'old-sess');
  ok('claiming migrates a legacy lease-*.json onto claim-*.json (one name from then on)',
    fs.existsSync(path.join(board2.planDir, 'claim-legacyclaim.json'))
    && !fs.existsSync(path.join(board2.planDir, 'lease-legacyclaim.json')));

  // ---- ROLE FOLLOWS THE CONVERSATION -------------------------------------------------
  // A relaunch mints a NEW ARC_SESSION. The role was keyed by session, so it was silently
  // lost and the session then received NOTHING. A resumed conversation must reclaim its role.
  const CONV = 'conv-abc-123';
  const DEAD_PID = 999999;                                  // not a running process
  writeJSON(path.join(cache, 'arc-state-old.json'), { pid: process.pid, cwd: repo2, convId: CONV });
  F.requestRole('old', 'android', repo2);
  ok('claiming a role records the CONVERSATION on the claim',
    R2.roleClaim(board2, 'android').convId === CONV);
  R2.writeCursor(board2, 'android', 1);                      // it had read up to note #1

  // the holding session DIES (its own claim now names a dead pid)
  R2.claimRole(board2, 'android', DEAD_PID, 'old', CONV);
  ok('a vacant claim is findable by CONVERSATION', R2.vacantClaimForConv(board2, CONV).role === 'android');

  // a NEW session id resumes the SAME conversation → it must get its role back
  writeJSON(path.join(cache, 'arc-state-new.json'), { pid: process.pid, cwd: repo2, convId: CONV });
  const adopted = F.refreshRole('new', process.pid, repo2, CONV);
  ok('a resumed conversation ADOPTS its old role (no more silent blackout)',
    adopted && adopted.adopted === true && adopted.role === 'android' && F.getRole('new', board2) === 'android');
  ok('...and it resumes IN PLACE — the cursor is keyed by role, not session, so nothing is re-read',
    R2.readCursor(board2, 'android') === 1);
  ok('a LIVE holder is never adopted away (only a vacant claim is)',
    R2.vacantClaimForConv(board2, CONV) === null && R2.roleClaim(board2, 'android').sessionId === 'new');

  // ---- the claim RACE: check-then-write let two sessions both "win" ------------------
  // claimRole now does check+write under an atomic lock, so a second live session is refused.
  mkSession('racer', process.pid);
  const first = R2.claimRole(board2, 'painter', process.pid, 'racer');
  const second = R2.claimRole(board2, 'painter', process.pid, 'other-session');
  ok('two live sessions cannot BOTH claim one role (they would share a cursor and eat notes)',
    first.ok === true && second.ok === false && !!second.holder);
  ok('the same session re-claiming its own role still succeeds (restart keeps its seat)',
    R2.claimRole(board2, 'painter', process.pid, 'racer').ok === true);
  // atomic write: no torn claim/cursor left behind
  ok('state writes are atomic (no .tmp files left in the board)',
    !fs.readdirSync(board2.planDir).some((f) => f.includes('.tmp-')));

  // ---- the NOTE SCHEMA: kind · replyTo · supersedes ---------------------------------
  // Two real sessions invented this taxonomy BY HAND ("DELEGATION:", "Re your #8",
  // "CORRECTION to #13 — I was WRONG"). These fields make it machine-readable — and every
  // one is OPTIONAL, so a bare note and every pre-schema note stay valid.
  const sboard = R2.resolveBoard(path.join(base2, 'schema')); fs.mkdirSync(path.join(base2, 'schema', '.git'), { recursive: true });
  R2.ensureBoard(sboard);
  const sn1 = R2.appendNote(sboard, { from: 'android', to: 'research', kind: 'request', body: 'investigate X' });
  const sn2 = R2.appendNote(sboard, { from: 'research', to: 'android', replyTo: 1, body: 'they are mutually exclusive' });
  const sn3 = R2.appendNote(sboard, { from: 'research', to: 'android', supersedes: 2, body: 'CORRECTION: I was WRONG' });
  R2.appendNote(sboard, { from: 'android', to: 'research', kind: 'request', body: 'never answered' });
  const plain = R2.appendNote(sboard, { from: 'android', to: 'research', body: 'just news' });
  ok('a plain note still needs no flags and defaults to kind:info',
    plain.kind === 'info' && plain.replyTo === undefined && plain.supersedes === undefined);
  ok('an unknown kind degrades to info rather than throwing',
    R2.appendNote(sboard, { from: 'android', to: 'research', kind: 'nonsense', body: 'x' }).kind === 'info');
  ok('--reply-to INFERS kind:result; --supersedes INFERS kind:correction',
    sn2.kind === 'result' && sn2.replyTo === 1 && sn3.kind === 'correction' && sn3.supersedes === 2);
  ok('a correction (and a blocker) is auto-HIGH priority — a retraction is never routine',
    sn3.priority === 'high' && R2.appendNote(sboard, { from: 'android', to: 'research', kind: 'blocker', body: 'db down' }).priority === 'high');
  ok('supersededMap derives which note was RETRACTED, and by whom',
    R2.supersededMap(sboard).get(2).seq === 3 && !R2.supersededMap(sboard).has(1));
  ok('openRequests finds a request with NO reply, and ignores an answered one',
    (() => { const o = R2.openRequests(sboard).map((n) => n.seq); return o.includes(4) && !o.includes(1); })());
  ok('repliesTo threads the answers under a request', R2.repliesTo(sboard, 1).length === 1);
  ok('KINDS/KIND_RANK rank a blocker + correction ABOVE routine info',
    R2.KIND_RANK.blocker < R2.KIND_RANK.info && R2.KIND_RANK.correction < R2.KIND_RANK.info && R2.KINDS.includes('decision'));

  // the READ path must make a retraction impossible to miss
  const F2 = F;
  mkSession('reader', process.pid);
  writeJSON(path.join(cache, 'arc-state-reader.json'), { pid: process.pid, cwd: path.join(base2, 'schema') });
  F2.requestRole('reader', 'android', path.join(base2, 'schema'));
  const readOut = F2.requestNotes('reader', '', path.join(base2, 'schema')).message;
  ok('reading a RETRACTED note warns loudly and names the note that retracts it',
    /RETRACTED by #3/.test(readOut) && /do NOT act on this/.test(readOut));
  ok('the readout shows the kind and the thread link',
    /<correction>/.test(readOut) && /↩ re #1/.test(readOut));

  // flags parse through the real requestNote, and a dangling reference is refused
  const F3 = F2.requestNote('reader', 'research --kind request "check the thing"', path.join(base2, 'schema'));
  ok('arc:note --kind request is accepted and reported back', F3.ok && /kind: request/.test(F3.message));
  ok('a dangling --reply-to is REFUSED (a note must never point at nothing)',
    !F2.requestNote('reader', 'research --reply-to #9999 "x"', path.join(base2, 'schema')).ok);
  ok('an unknown --kind is REFUSED with the valid list',
    /unknown --kind/.test(F2.requestNote('reader', 'research --kind wat "x"', path.join(base2, 'schema')).message));

  // the AMBIENT badge (what the statusline paints) — derived, self-clearing
  // NO-ROLE BLACKOUT: badge used to return null with no role, so a session that had fallen off
  // the board received nothing AND was never told — notes piled up invisibly. It must WARN.
  const emptyRepo = path.join(base2, 'emptyboard');
  fs.mkdirSync(path.join(emptyRepo, '.git'), { recursive: true });
  ok('badge stays null with no role AND no notes (nothing to say)', F.badge('zz', emptyRepo) === null);
  R2.appendNote(board2, { from: 'research', to: 'coding', body: 'fresh' });
  const noRoleBg = F.badge('zz', repo2);
  ok('badge WARNS when you hold no role but the board HAS notes (never a silent blackout)',
    noRoleBg && noRoleBg.noRole === true && noRoleBg.count === R2.noteCount(board2));
  const bg = F.badge('sb', repo2);
  ok('badge counts unread + names the sender', bg && bg.count === 1 && bg.senders[0] === 'research');
  R2.markRead(board2, 'coding');
  ok('badge clears itself once read', F.badge('sb', repo2) === null);

  // FAIL-OPEN: a truncated ledger must not silently swallow notes
  R2.writeCursor(board2, 'coding', 999);                    // cursor past the end
  ok('a cursor past the end re-reads rather than skipping', R2.unreadFor(board2, 'coding').count > 0);

  // ---- turn-start injection (the "board at the door") ----
  // Proven live: a hook's additionalContext really does reach the model.
  R2.markRead(board2, 'coding');
  ok('injection is null when there is no delta (hook stays silent)', F.injection('sb', repo2) === null);
  ok('injection is null with no role', F.injection('zz', repo2) === null);
  R2.appendNote(board2, { from: 'research', to: 'coding', body: 'ordinary note' });
  R2.appendNote(board2, { from: 'research', to: 'coding', priority: 'high', body: 'URGENT anchor broke' });
  const countBeforeInject = R2.noteCount(board2);
  const inj = F.injection('sb', repo2);
  ok('injection returns a digest for unread notes', inj && inj.count === 2);
  ok('digest names the board + role', /the "proj" board/.test(inj.text) && /for "coding"/.test(inj.text));
  ok('HIGH priority is ranked first', inj.text.indexOf('URGENT anchor broke') < inj.text.indexOf('ordinary note'));
  ok('digest stays far under the 10k hook cap', inj.text.length < 10000);
  ok('injection marks them read — delivered exactly once', F.injection('sb', repo2) === null);
  ok('but the notes stay on the board (rd()-only)', R2.noteCount(board2) === countBeforeInject);

  // a burst must be ranked + summarised, never dumped (the 10k cap is a hard limit)
  for (let i = 0; i < 80; i++) R2.appendNote(board2, { from: 'research', to: 'coding', body: 'filler '.repeat(40) + i });
  const big = F.injection('sb', repo2);
  ok('a burst is capped, not dumped', big && big.text.length < 10000);
  ok('and the overflow is summarised', /…and \d+ more/.test(big.text));
  ok('while still reporting the true total', big.count === 80);

  // CATCH-UP after an absence: a peer back from a long trip must lose NOTHING.
  // The capped burst above must NOT have consumed the overflow — the cursor advances
  // only over what was actually delivered, so the rest stay unread. (Regression for the
  // bug where injection showed ~30 but marked ALL 80 read, silently dropping the tail.)
  ok('the capped burst did NOT consume the overflow', R2.unreadFor(board2, 'coding').count === 80 - big.shown && big.shown < 80);
  let drained = big.shown, guard = 0;
  while (R2.unreadFor(board2, 'coding').count && guard++ < 30) drained += F.injection('sb', repo2).shown;
  ok('the whole backlog drains over turns — every note once, none skipped',
    drained === 80 && R2.unreadFor(board2, 'coding').count === 0);
  // and a returning session catches up in ONE uncapped `arc:notes`
  R2.writeCursor(board2, 'coding', 0);
  const expected = R2.unreadFor(board2, 'coding').count;
  const catchUp = F.requestNotes('sb', '', repo2);
  ok('arc:notes catches a returning peer up in one uncapped call',
    (catchUp.message.match(/#\s*\d+/g) || []).length === expected && expected > 40 && R2.unreadFor(board2, 'coding').count === 0);
} catch (e) { ok('arc-notes works', false, e.message); }

// ---- claudex (run a GPT model inside Claude Code via a translator) -----------
section('claudex (Anthropic<->OpenAI translator + sidecar lifecycle)');
try {
  const P = require(path.join(SRC, 'arc-claudex-proxy.js'));

  // asText: EVERY content must coerce to a STRING (this is the fix for the gateway's
  // "Invalid type for 'input': expected a string, but got an object" 400).
  ok('asText coerces string/array/object/null all to strings',
    P.asText('x') === 'x'
    && P.asText([{ type: 'text', text: 'a' }, { type: 'image' }]) === 'a\n[image omitted]'
    && typeof P.asText({ foo: 1 }) === 'string'
    && P.asText(null) === '');

  // toOpenAI: Anthropic Messages -> OpenAI chat/completions shape.
  const oreq = P.toOpenAI({
    model: 'gpt-5.6-sol', system: 'be terse', stream: true, max_tokens: 100,
    tools: [{ name: 'run', description: 'd', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'any' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'run', input: { a: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'done' }] }] },
    ],
  }, 'gpt-5.6-sol');
  ok('toOpenAI: system -> system message, tools mapped, tool_choice any -> required',
    oreq.messages[0].role === 'system' && oreq.tools[0].type === 'function' && oreq.tools[0].function.name === 'run' && oreq.tool_choice === 'required');
  ok('toOpenAI: assistant tool_use -> tool_calls with JSON-string arguments',
    oreq.messages[2].role === 'assistant' && oreq.messages[2].tool_calls[0].function.arguments === '{"a":1}');
  ok('toOpenAI: tool_result -> a role:tool message with STRING content (the 400 fix)',
    oreq.messages[3].role === 'tool' && oreq.messages[3].tool_call_id === 't1' && oreq.messages[3].content === 'done');
  ok('toOpenAI: every message content is a string (never an object)',
    oreq.messages.every((m) => m.content === undefined || typeof m.content === 'string'));
  ok('toOpenAI: a non-gpt model name falls back to the pinned model',
    P.toOpenAI({ model: 'claude-sonnet-4', messages: [] }, 'gpt-5.6-sol').model === 'gpt-5.6-sol');

  // account env routing: a claudex account points Claude Code at the LOCAL translator and
  // must NEVER leak the real gateway key into Claude Code's env.
  const Ccfg = require(path.join(SRC, 'arc-config.js'));
  const cxAcc = { id: 'gpt', type: 'api', baseUrl: 'https://gw.example.com', apiKeyEnv: 'CLKIT_TEST_KEY', model: 'gpt-5.6-sol', proxy: { port: 8791 } };
  const cxEnv = Ccfg.accountEnv(cxAcc, {});
  ok('claudex account: ANTHROPIC_BASE_URL points at the LOCAL translator, not the gateway',
    cxEnv.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8791' && cxEnv.ANTHROPIC_MODEL === 'gpt-5.6-sol');
  ok('claudex account: the real gateway key is NOT leaked into Claude Code\'s env',
    cxEnv.ANTHROPIC_API_KEY === 'claudex' && cxEnv.ANTHROPIC_AUTH_TOKEN === 'claudex' && cxEnv.ANTHROPIC_API_KEY !== 'sk-test-123');

  // MULTI-MODEL: a modelMap maps tiers to GPT models so /model switches among them; when a map
  // is present, ANTHROPIC_MODEL is NOT pinned (else the picker is stuck on one).
  const multiAcc = { id: 'gpt2', type: 'api', baseUrl: 'https://gw.example.com', apiKeyEnv: 'CLKIT_TEST_KEY', proxy: { port: 8792 }, model: 'gpt-5.6-sol', modelMap: { opus: 'gpt-5.6-sol', sonnet: 'gpt-5.6-terra', haiku: 'gpt-5.6-luna' } };
  const multiEnv = Ccfg.accountEnv(multiAcc, {});
  ok('claudex multi-model: tiers map to GPT models (/model opus|sonnet|haiku switches in-session)',
    multiEnv.ANTHROPIC_DEFAULT_OPUS_MODEL === 'gpt-5.6-sol' && multiEnv.ANTHROPIC_DEFAULT_SONNET_MODEL === 'gpt-5.6-terra' && multiEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'gpt-5.6-luna');
  ok('claudex multi-model: ANTHROPIC_MODEL is NOT pinned when a tier map is present',
    multiEnv.ANTHROPIC_MODEL === undefined && multiEnv.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8792');
  // probeGatewayGptModels filters a /v1/models list down to GPT/OpenAI ids (not covered live).
  ok('probeGatewayGptModels is exported for gateway model discovery',
    typeof require(path.join(SRC, 'arc-switch-core.js')).probeGatewayGptModels === 'function');

  // sidecar lifecycle helpers (sync). The async ensureProxy spawn/reuse tests run in the
  // subprocess below (they need await).
  const CX = require(path.join(SRC, 'arc-claudex.js'));
  ok('isClaudex detects the proxy block; portFor/localBaseUrl derive the local endpoint',
    CX.isClaudex(cxAcc) && CX.portFor(cxAcc) === 8791 && CX.localBaseUrl(cxAcc) === 'http://127.0.0.1:8791' && !CX.isClaudex({ type: 'api', baseUrl: 'x' }));
  // nextClaudexPort avoids collisions.
  const core2 = require(path.join(SRC, 'arc-switch-core.js'));
  ok('nextClaudexPort: 8790 when free, else one past the highest in use',
    core2.nextClaudexPort({ accounts: [] }) === 8790 && core2.nextClaudexPort({ accounts: [{ proxy: { port: 8790 } }, { proxy: { port: 8792 } }] }) === 8793);

  // the streaming + sidecar-lifecycle tests need top-level await, which this synchronous
  // CommonJS harness can't host — run them in a subprocess and fold results back in.
  const casync = spawnSync(process.execPath, [path.join(__dirname, 'claudex-async.js')], { encoding: 'utf8' });
  const lines = (casync.stdout || '').split('\n').map((l) => l.match(/^(ok|notok)\t(.+)$/)).filter(Boolean);
  if (!lines.length) ok('claudex async subprocess produced results', false, `status=${casync.status} stderr=${(casync.stderr || '').slice(0, 300)}`);
  for (const m of lines) ok(m[2], m[1] === 'ok');
} catch (e) { ok('claudex works', false, e.message + '\n' + (e.stack || '')); }

// ---- arc-stance (the passive·balanced·active initiative dial) -----------------
section('arc-stance (agent initiative dial)');
try {
  const St = require(path.join(SRC, 'arc-stance.js'));
  const S = 'stance-sess-1';
  // The default is BALANCED, not passive: a passive default silently told two live, productive
  // sessions "do not self-initiate a note" — they'd have stopped talking with nothing to say why.
  // Noting a peer is cheap and reversible; only the heavier initiative (ASKING a peer for
  // help, arming a background watch) is opt-in.
  ok('default stance is BALANCED (a passive default broke a real workflow)',
    St.getStance(S) === 'balanced' && St.getStance('never-set') === 'balanced' && St.DEFAULT === 'balanced');
  ok('setStance persists a valid value, rejects an invalid one (leaves it unchanged)',
    St.setStance(S, 'active') === 'active' && St.getStance(S) === 'active'
    && St.setStance(S, 'zoom') === null && St.getStance(S) === 'active');
  // Only a DEVIATION from the default speaks. The `peers` skill alone already produces balanced
  // behaviour (37 real notes were written before the stance system existed), so the common case
  // needs no injection at all — passive RESTRICTS, active GRANTS, balanced is silent + free.
  ok('directive: balanced (the default) injects NOTHING — the common case is free',
    St.directive('balanced') === null);
  ok('directive: passive injects a RESTRICTION; active injects a GRANT',
    /PASSIVE/.test(St.directive('passive')) && /Do NOT self-initiate/.test(St.directive('passive'))
    && /ACTIVE/.test(St.directive('active'))
    // ACTIVE grants the PEER tools, not a delegate — that tool is gone. If this ever
    // mentions delegating again, the dial is pointing at something that does not exist.
    && /--kind request/.test(St.directive('active')) && !/arc delegate/.test(St.directive('active')));
  ok('renderBar marks only the selected notch',
    St.renderBar('balanced').includes('[ balanced ]') && !St.renderBar('balanced').includes('[ active ]'));

  // through the REAL hook: set · reject · open picker
  const swhk = path.join(SRC, 'arc-switch-hook.js');
  const hookAsk = (prompt, sess) => { const r = spawnSync(process.execPath, [swhk], { input: JSON.stringify({ prompt, cwd: TMP }), encoding: 'utf8', env: { ...process.env, ARC_SESSION: sess } }); let o = {}; try { o = JSON.parse(r.stdout || '{}'); } catch {} return o; };
  const S2 = 'stance-hook-1';
  const setOut = hookAsk('arc:mode active', S2);
  ok('arc:mode <value> sets the stance via the hook (zero tokens, cross-process)',
    setOut.decision === 'block' && /stance: active/.test(setOut.reason) && St.getStance(S2) === 'active');
  ok('arc:mode <bad> is rejected and the stance is unchanged',
    /unknown stance/.test(hookAsk('arc:mode nope', S2).reason || '') && St.getStance(S2) === 'active');
  ok('bare arc:mode opens the picker (drops a mode trigger)',
    /stance picker/.test(hookAsk('arc:mode', S2).reason || '')
    && fs.existsSync(path.join(CLAUDE, 'cache', `arc-mode-${S2}.trigger`)));

  // injection through the REAL hook: the default is free; both deviations announce themselves.
  const S3 = 'stance-inj-1';
  St.setStance(S3, 'balanced');
  ok('the DEFAULT (balanced) injects NOTHING on a normal prompt — zero tokens for the common case',
    !hookAsk('what is 2+2', S3).hookSpecificOutput);
  St.setStance(S3, 'passive');
  const pj = hookAsk('what is 2+2', S3);
  ok('passive injects the RESTRICTION on a normal prompt (a deviation must announce itself)',
    pj.hookSpecificOutput && /arc stance: PASSIVE/.test(pj.hookSpecificOutput.additionalContext));
  St.setStance(S3, 'active');
  const aj = hookAsk('what is 2+2', S3);
  ok('active injects the GRANT on a normal prompt',
    aj.hookSpecificOutput && /arc stance: ACTIVE/.test(aj.hookSpecificOutput.additionalContext));
} catch (e) { ok('arc-stance works', false, e.message + '\n' + (e.stack || '')); }

// ---- arc:delegate is REMOVED (and stays removed) ----------------------------
// It fired a headless one-shot that re-read the repo from scratch and then died: heavier
// than Claude Code's own subagent (in-session, on your quota, can pick its own model) and
// dumber than a PEER (which keeps its context across turns). Squeezed from both sides.
//
// These tests are the tombstone. They exist because the sentinel is deliberately STILL
// MATCHED: unmatched, `arc:delegate <task>` would fall through to the model as an ordinary
// prompt and the agent would just do the task INLINE — the one outcome nobody typing
// "delegate" wants. So the hook must intercept AND redirect, at zero tokens.
//
// Assert against the REAL hook, never a hand-copied regex. The block that used to live here
// inlined its own copy of TRIGGER_RX, and the copy drifted — it still listed the long-dead
// `handoff`. That is exactly how a dead sentinel survives a removal unnoticed. So: no copies.
section('arc:delegate (removed — the hook redirects, never leaks to the model)');
try {
  const swhook = path.join(SRC, 'arc-switch-hook.js');
  const ask = (prompt) => {
    const r = spawnSync(process.execPath, [swhook], { input: JSON.stringify({ prompt, cwd: TMP }), encoding: 'utf8' });
    try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
  };

  ok('the module is GONE', !fs.existsSync(path.join(SRC, 'arc-delegate.js')));

  // The load-bearing one: it must never reach the model. A reason == intercepted == 0 tokens.
  const d = ask('arc:delegate codex "find why the import test is flaky"');
  ok('arc:delegate is still INTERCEPTED (never falls through to the model as a prompt)',
    !!(d.reason || '').length);
  ok('...and it REDIRECTS to the two things that replaced it (subagent + peer)',
    /removed/i.test(d.reason || '') && /SUBAGENT/i.test(d.reason || '') && /--kind request/.test(d.reason || ''));
  ok('...and it points at arc:switch for GPT (claudex SURVIVES the removal)',
    /arc:switch/.test(d.reason || ''));
  ok('the bare form redirects too (no crash on a missing task)',
    /removed/i.test(ask('arc:delegate').reason || ''));

  // The sibling removal, kept as a regression: handoff was deleted OUTRIGHT (no redirect), so
  // it must fall through with NO decision at all. Two removals, two deliberate shapes — if
  // these ever converge, someone has broken one of them.
  ok('arc:handoff is GONE with NO redirect — falls through as a normal prompt',
    !ask('arc:handoff codex').decision && !ask('arc:handoff').decision);

  // Nothing may still import the deleted module: a stale require() throws at RUNTIME, inside
  // a hook, where it stays invisible until it wedges a real session.
  const importers = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))
    .filter((f) => /require\(['"`]\.\/arc-delegate/.test(fs.readFileSync(path.join(SRC, f), 'utf8')));
  ok('no module still requires arc-delegate (a stale require would throw inside a hook)',
    importers.length === 0, importers.join(', '));
} catch (e) { ok('arc:delegate removal', false, e.message + '\n' + (e.stack || '')); }

// ---- arc-stop-hook (auto-feed at TURN END, no human keystroke) ---------------
section('arc-stop-hook (a note is never left sitting on the board)');
try {
  const RM = require(path.join(SRC, 'arc-board.js'));
  const F = require(path.join(SRC, 'arc-notes.js'));
  const HOOK = path.join(SRC, 'arc-stop-hook.js');

  const sboard = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-'));
  spawnSync('git', ['init', '-q'], { cwd: sboard });
  const board = RM.resolveBoard(sboard);
  RM.ensureBoard(board);

  // A real session that has claimed a role (that is what makes notes addressable). A role
  // claim requires a LIVE arc-runner behind the session, so stand in its state file first.
  const SESSION = 'stop-sess-1';
  const scache = path.join(CLAUDE, 'cache'); fs.mkdirSync(scache, { recursive: true });
  fs.writeFileSync(path.join(scache, `arc-state-${SESSION}.json`), JSON.stringify({ pid: process.pid, cwd: sboard }));
  const claimed = F.requestRole(SESSION, 'code', sboard);
  ok('(setup) the stop-hook session holds a role', claimed.ok === true);

  const fire = (payload, env) => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload), encoding: 'utf8',
      env: { ...process.env, ARC_SESSION: SESSION, ...(env || {}) },
    });
    try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
  };

  // Nothing on the board, nothing in flight — but this session HOLDS A ROLE, so a peer can
  // address it at any moment, and an idle session cannot be reached (both delivery points need
  // a TURN). So the one thing left to say is "arm your listener", said exactly once.
  const first = fire({ hook_event_name: 'Stop', cwd: sboard });
  ok('with nothing to deliver, the hook arms the LISTENER (an idle role-holder is unreachable)',
    first.decision === 'block' && /arc join code/.test(first.reason || ''));
  ok('...and then goes SILENT — asked once per cycle, never nagged every turn',
    !fire({ hook_event_name: 'Stop', cwd: sboard }).decision);

  // a note lands mid-turn (e.g. a peer answering) -> handed over at turn END
  RM.appendNote(board, { from: 'research', to: 'code', body: 'ANSWER: the flake is a tar bug', priority: 'normal' });
  const fed = fire({ hook_event_name: 'Stop', cwd: sboard });
  ok('a note that lands MID-TURN is fed to the model at turn end — no human keystroke',
    fed.decision === 'block' && /ANSWER: the flake is a tar bug/.test(fed.reason) && /END of your turn/.test(fed.reason));

  // idempotent: injection() advanced the cursor, so the SAME note cannot block twice
  ok('the same note can never block twice (cursor advanced -> no Stop loop)',
    !fire({ hook_event_name: 'Stop', cwd: sboard }).decision);

  // the loop guard: we NEVER chain a block onto our own block
  RM.appendNote(board, { from: 'research', to: 'code', body: 'second answer', priority: 'normal' });
  ok('stop_hook_active is honoured (never chains a block onto its own block)',
    !fire({ hook_event_name: 'Stop', cwd: sboard, stop_hook_active: true }).decision);
  ok('...and the note it held back is still delivered on the NEXT stop (nothing is lost)',
    /second answer/.test(fire({ hook_event_name: 'Stop', cwd: sboard }).reason || ''));

  // a non-arc session (no ARC_SESSION) must be left completely alone
  const bare = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'Stop', cwd: sboard }), encoding: 'utf8',
    env: { ...process.env, ARC_SESSION: '' },
  });
  ok('a session with no ARC_SESSION is never touched', bare.stdout.trim() === '');

  // ---- an UNANSWERED PEER REQUEST must wake you too -------------------------------
  // Asking a peer and then going idle used to lose the answer: a peer replies on THEIR
  // schedule, and nothing wakes an idle session — the reply just sat there until a human
  // typed something. You asked, so you are owed the answer: arm the waker before stopping.
  const askSeq = RM.appendNote(board, { from: 'code', to: 'research', kind: 'request', body: 'why is the import flaky?' }) && RM.latestSeq(board);
  const asked = fire({ hook_event_name: 'Stop', cwd: sboard });
  ok('an UNANSWERED request you asked a peer arms the waker before you go idle',
    asked.decision === 'block' && /STILL UNANSWERED/.test(asked.reason) && /arc join code/.test(asked.reason)
    && /why is the import flaky/.test(asked.reason));
  ok('...and it is offered ONCE, never nagged every turn',
    !fire({ hook_event_name: 'Stop', cwd: sboard }).decision);
  // once a peer REPLIES, it is no longer open — and the reply itself is delivered as a note
  RM.appendNote(board, { from: 'research', to: 'code', replyTo: askSeq, body: 'DONE — tar --force-local' });
  const replied = fire({ hook_event_name: 'Stop', cwd: sboard });
  ok('a peer\'s reply is delivered as a note, not as another nag',
    replied.decision === 'block' && /tar --force-local/.test(replied.reason) && !/STILL UNANSWERED/.test(replied.reason));
  ok('an ANSWERED request is no longer open (the loop closed)',
    !RM.openRequests(board, 'code').some((n) => n.seq === askSeq));

  // (The delegate in-flight arming tests lived here. `arc delegate` is gone — a headless
  //  one-shot was worse than a native subagent AND worse than a peer. Its one good property,
  //  "arm the waker exactly once, never nag", now belongs to the unanswered-request tests
  //  directly above: same Stop hook, same channel, same once-only guarantee.)

  // ---- case 3: holding a role means being REACHABLE ------------------------------
  // Both automatic delivery points need a TURN — the turn-start injection needs a human
  // prompt, and this hook needs a turn to end. An idle session has neither, so a role-holder
  // that stops without a listener is simply unreachable until a human types. That defeats the
  // point of asking a peer who is "sitting there ready". So the listener is armed on the way
  // out, at every idle.
  const A2 = require(path.join(SRC, 'arc-await.js'));
  const St2 = require(path.join(SRC, 'arc-stance.js'));
  const cycle = () => { A2.clearWaiting(SESSION); A2.clearOffered(SESSION); };  // a fresh listening cycle
  cycle();
  RM.markRead(board, 'code');                       // nothing unread, nothing pending

  const lis = fire({ hook_event_name: 'Stop', cwd: sboard });
  ok('holding a role, with nothing pending, the hook ARMS the listener before going idle',
    lis.decision === 'block' && /arc join code/.test(lis.reason || '')
    && /run_in_background/.test(lis.reason || ''));
  ok('...and it says WHY (an idle session cannot be reached), not just what to run',
    /idle/i.test(lis.reason || '') && /reach/i.test(lis.reason || ''));

  // Once a listener is live the hook must go quiet — else every turn stacks another waiter,
  // and they would all wake at once on the next note.
  A2.markWaiting(SESSION, 'code', process.pid);
  ok('with a listener already live, the hook stays SILENT (not one waiter per turn)',
    !fire({ hook_event_name: 'Stop', cwd: sboard }).decision);

  // A live listener also RESETS the offer, so the next cycle (after a note wakes it and the
  // waiter exits) gets a fresh one. Otherwise a session would be offered a listener exactly
  // once in its whole life and go deaf after the first note.
  ok('a live listener resets the offer, so the NEXT cycle can arm again',
    !A2.wasOffered(SESSION));

  // A crashed listener must not leave the session deaf: liveness is the test, not existence.
  A2.markWaiting(SESSION, 'code', 999999);
  A2.clearOffered(SESSION);
  ok('a DEAD listener re-arms (a crash must not make a session permanently unreachable)',
    /arc join code/.test(fire({ hook_event_name: 'Stop', cwd: sboard }).reason || ''));

  // NOT gated on a peer existing. Such a check is evaluated at the exact moment it stops
  // being true: a session that idles ALONE and only then gets a peer (arc:invite, a second
  // tab) would be asleep and unarmed, with no way to ever learn about them.
  cycle();
  const others = RM.liveRoles(board).filter((r) => (r.role || r) !== 'code');
  const solo = fire({ hook_event_name: 'Stop', cwd: sboard });
  ok('armed even with NO peer on the board — a peer can join while you are idle',
    others.length === 0 && /arc join code/.test(solo.reason || ''));

  // NOT gated on stance. Listening is not acting: a passive session that wakes on a note
  // reads it and tells the user; it still won't self-initiate work. Muting the ear would not
  // make it more passive, only deaf.
  const prevStance = St2.getStance(SESSION);
  St2.setStance(SESSION, 'passive');
  cycle();
  ok('a PASSIVE session is armed too (listening is not acting)',
    /arc join code/.test(fire({ hook_event_name: 'Stop', cwd: sboard }).reason || ''));
  ok('...and the passive directive no longer contradicts it by forbidding the listener',
    !/no background watching/i.test(St2.directive('passive'))
    && /listening is exempt/i.test(St2.directive('passive')));
  St2.setStance(SESSION, prevStance || 'balanced');
  cycle();

  // No role = not addressable = nothing to listen for. Never nag a session nobody can reach.
  const NOROLE = 'sess-norole-' + process.pid;
  ok('a session with NO role is never nagged (nobody can address it)',
    !fire({ hook_event_name: 'Stop', cwd: sboard }, { ARC_SESSION: NOROLE }).decision);

  // An unanswered request while a listener is ALREADY live: the wake is guaranteed — the
  // reply will exit the listener and re-invoke us. Prompting "arm the waker" for an armed
  // waker is exactly the nag this hook promises not to be.
  A2.markWaiting(SESSION, 'code', process.pid);
  RM.appendNote(board, { from: 'code', to: 'research', kind: 'request', body: 'second ask, listener live' });
  ok('an unanswered request with a LIVE listener stays SILENT (wake already guaranteed)',
    !fire({ hook_event_name: 'Stop', cwd: sboard }).decision);
  A2.clearWaiting(SESSION);

  // ---- arc await: the EXIT is the wake --------------------------------------------
  // Run it as a real subprocess, because "it exits" IS the property under test — in Claude
  // Code a background command's exit re-invokes the agent, and a command that merely prints
  // does not. If this ever stops exiting, an idle session silently never wakes.
  RM.appendNote(board, { from: 'research', to: 'code', body: 'the reply landed', priority: 'normal' });
  const aw = spawnSync(process.execPath, ['-e',
    `require(${JSON.stringify(path.join(SRC, 'arc-await.js'))}).awaitOnce('code', ${JSON.stringify(sboard)}, { pollMs: 20 }).then((c) => process.exit(c));`,
  ], { encoding: 'utf8', timeout: 8000, env: { ...process.env, ARC_SESSION: SESSION } });
  ok('`arc await` EXITS the moment a note lands (that exit is what wakes an idle session)',
    aw.status === 0 && !aw.error && /the reply landed/.test(aw.stdout) && /arc notes/.test(aw.stdout));

  // and it does NOT consume the note — the board still delivers it on the waking turn
  ok('`arc await` only OBSERVES — it never advances the read cursor',
    RM.unreadFor(board, 'code').count === 1);

  fs.rmSync(sboard, { recursive: true, force: true });
} catch (e) { ok('arc-stop-hook works', false, e.message + '\n' + (e.stack || '')); }

// ---- arc-bundle (first-party bundle installer) -------------------------------
section('arc-bundle (manifest + installer)');
try {
  const B = require(path.join(SRC, 'arc-bundle.js'));
  // satisfies() — the minimal >= range check
  ok('satisfies >= ranges', B.satisfies('22.3.1', '>=22') && B.satisfies('2.1.0', '>=2.1') && !B.satisfies('18.0.0', '>=22') && B.satisfies('1.0.0', undefined));
  // validate() — schema + requires
  const host = { node: '22.0.0', arc: '2.0.0', claude: true, codex: false };
  ok('validate accepts a good skill-only manifest',
    B.validate({ manifest: 1, name: 'x', provides: { skills: [{ path: '.' }] } }, host).ok);
  ok('validate rejects wrong schema / bad name / missing provides',
    !B.validate({ manifest: 2, name: 'x', provides: {} }, host).ok
    && !B.validate({ manifest: 1, name: 'Bad Name', provides: {} }, host).ok
    && !B.validate({ manifest: 1, name: 'x' }, host).ok);
  ok('validate rejects an unmet node requirement',
    !B.validate({ manifest: 1, name: 'x', provides: { skills: [] }, requires: { node: '>=99' } }, host).ok);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'arcbundle-'));
  const opts = { claudeDir: path.join(home, '.claude'), agentsDir: path.join(home, '.agents'), arcHome: path.join(home, '.arc'), scriptsDir: path.join(home, '.claude', 'scripts'), host };

  // a fixture bundle: a dual-runtime skill + a hook + a supporting file
  const bdir = path.join(home, 'src', 'demo'); fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'arc-bundle.json'), JSON.stringify({
    manifest: 1, name: 'demo', version: '1.2.0',
    requires: { node: '>=18', host: ['claude', 'codex'] },
    provides: { skills: [{ path: '.', targets: ['claude', 'codex'] }], hooks: [{ event: 'Stop', command: 'node "{scripts}/demo.js"' }] },
  }));
  fs.writeFileSync(path.join(bdir, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\nbody');
  fs.writeFileSync(path.join(bdir, 'helper.js'), '// helper');

  const r = B.install(bdir, opts);
  const claudeSkill = path.join(opts.claudeDir, 'skills', 'demo');
  ok('install deploys the skill (with its supporting files) to the claude skills home',
    fs.existsSync(path.join(claudeSkill, 'SKILL.md')) && fs.existsSync(path.join(claudeSkill, 'helper.js')));
  ok('install excludes the manifest from the deployed skill', !fs.existsSync(path.join(claudeSkill, 'arc-bundle.json')));
  const settings = JSON.parse(fs.readFileSync(path.join(opts.claudeDir, 'settings.json'), 'utf8'));
  ok('install merged the bundle hook into settings.json (with {scripts} resolved)',
    JSON.stringify(settings.hooks.Stop).includes('/.claude/scripts/demo.js') && !JSON.stringify(settings.hooks.Stop).includes('{scripts}'));
  ok('lockfile records the bundle', !!B.list(opts).demo && B.list(opts).demo.version === '1.2.0');

  // idempotent — re-install adds no duplicate hook
  B.install(bdir, opts);
  const s2 = JSON.parse(fs.readFileSync(path.join(opts.claudeDir, 'settings.json'), 'utf8'));
  const demoHookCount = JSON.stringify(s2.hooks.Stop).split('demo.js').length - 1;
  ok('re-install is idempotent (no duplicate hook)', demoHookCount === 1);

  // remove — inverse of install
  const rm = B.remove('demo', opts);
  const s3 = JSON.parse(fs.readFileSync(path.join(opts.claudeDir, 'settings.json'), 'utf8'));
  ok('remove deletes the skill home + pulls the hook back out + clears the lockfile',
    rm.removed && !fs.existsSync(claudeSkill)
    && !JSON.stringify(s3.hooks || {}).includes('demo.js') && !B.list(opts).demo);

  // junction-safety: a dev install of a skill can be a symlink/junction to a checkout.
  // Installing over it must remove the LINK, never recurse into + delete the target.
  const canary = path.join(home, 'canary'); fs.mkdirSync(canary, { recursive: true });
  fs.writeFileSync(path.join(canary, 'PRECIOUS.txt'), 'do not delete');
  const skillDest = path.join(opts.claudeDir, 'skills', 'demo');
  fs.mkdirSync(path.dirname(skillDest), { recursive: true });
  let linked = false; try { fs.symlinkSync(canary, skillDest, 'junction'); linked = true; } catch {}
  if (linked) {
    B.install(bdir, opts);
    ok('install over a junctioned skill dir preserves the link target (no data loss)',
      fs.existsSync(path.join(canary, 'PRECIOUS.txt')) && fs.existsSync(path.join(skillDest, 'SKILL.md')) && !fs.existsSync(path.join(skillDest, 'canary')));
    B.remove('demo', opts);
  } else { ok('(junction-safety test skipped — could not create a junction here)', true); }

  // the real first-party bundles discover + validate
  const found = B.discover(path.join(ROOT, 'bundles'));
  ok('discover finds the first-party bundles (show-image + inquiry)',
    found.some((f) => f.manifest.name === 'show-image') && found.some((f) => f.manifest.name === 'inquiry'));
  ok('every first-party bundle manifest validates',
    found.every((f) => B.validate(f.manifest, { ...host, codex: true }).ok));

  // each bundle's OWN test suite passes from inside arc (node-version gated so a
  // node-20 CI leg skips a node>=22 bundle). This is how bundle tests reach arc's CI.
  for (const b of found) {
    const req = (b.manifest.requires && b.manifest.requires.node) || '>=18';
    if (!b.manifest.test || !B.satisfies(process.versions.node, req)) continue;
    const tdir = path.join(b.dir, 'tests');
    const files = fs.existsSync(tdir) ? fs.readdirSync(tdir).filter((f) => f.endsWith('.test.js')).map((f) => path.join('tests', f)) : [];
    if (!files.length) continue;
    const r = spawnSync(process.execPath, ['--test', ...files], { cwd: b.dir, encoding: 'utf8', timeout: 60000 });
    ok(`bundle "${b.manifest.name}": its own node --test suite passes from inside arc`, r.status === 0,
      ((r.stdout || '') + (r.stderr || '')).split('\n').filter((l) => /not ok|fail /.test(l)).slice(0, 2).join(' | '));
  }

  fs.rmSync(home, { recursive: true, force: true });
} catch (e) { ok('arc-bundle works', false, e.message + '\n' + (e.stack || '')); }

// ---- PROBE: environment touchpoints (informational — never fails build) ------
section('environment probe (informational)');
function has(cmd, args) { try { const r = spawnSync(cmd, args || ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }); return r.status === 0 || (r.stdout || r.stderr || '').length > 0; } catch { return false; } }
// directory junction support — the per-account credential isolation depends on it
let junctionOk = false;
try {
  const tgt = path.join(TMP, 'ptgt'); fs.mkdirSync(tgt, { recursive: true });
  const lnk = path.join(TMP, 'plnk'); try { fs.unlinkSync(lnk); } catch {}
  fs.symlinkSync(tgt, lnk, 'junction');
  junctionOk = fs.existsSync(lnk);
} catch {}
console.log(`  directory junction: ${junctionOk ? 'OK' : 'UNSUPPORTED'}`);
console.log(`  claude on PATH: ${has('claude', ['--version']) ? 'yes' : 'no (fine for CI)'}`);

// ---- cleanup + verdict -------------------------------------------------------
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓ ALL CORE TESTS PASSED' : '✗ CORE FAILURES'}: ${pass} passed, ${fail} failed${fail ? ' (' + fails.join(', ') + ')' : ''}`);
process.exit(fail === 0 ? 0 : 1);
