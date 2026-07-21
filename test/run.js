#!/usr/bin/env node
// arc test suite — Windows. Pure Node built-ins, no dependencies, no
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-test-'));
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

// A pid that is PROVABLY dead on THIS machine, verified at suite start — never a guessed
// constant. A guessed "dead" pid is machine-dependent state leaking into the suite: Windows
// allocates pids as multiples of 4 (an ODD candidate is structurally unallocatable there),
// but other OSes allocate densely up to pid_max, where 999999 can be a LIVE stranger on a
// busy box — the environment-pollution class behind the listener-test flake suspicion
// (roadmap item, audit #259). Candidates stay odd (999999, 999995, …) so the Windows
// invariant holds even if a pid comes alive between this probe and a later liveness check,
// and each is verified with the SAME probe the code under test uses (arc-board.isAlive),
// so fixture and code can never disagree about what "dead" means.
const DEAD_PID = (() => {
  const { isAlive } = require(path.join(SRC, 'arc-board.js'));
  for (let p = 999999; p > 4; p -= 4) if (!isAlive(p)) return p;
  throw new Error('suite fixture: no dead pid found on this machine (should be impossible)');
})();

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

console.log(`arc tests · ${process.platform} · node ${process.version} · HOME=${TMP}`);

// ---- 1. syntax check every shipped .js --------------------------------------
section('syntax (node --check, all platforms)');
const jsFiles = [];
for (const d of ['src', 'mcp', 'test']) {
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
      { id: 'gw', type: 'api', label: 'GW', baseUrl: 'https://gw.example.com', apiKeyEnv: 'ARC_TEST_KEY', modelMap: { opus: 'big', sonnet: 'mid' } },
    ],
  });
  process.env.ARC_TEST_KEY = 'sk-test-123';
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

  // SECRET-DIR HARDENING (Orca gold-6): fs mode is inert on Windows, so the NTFS ACL is the only
  // real boundary for the per-profile oauth credential. The ARGS are the security boundary — a
  // missing /inheritance:r leaves the broad grant, and Administrators MUST be a SID (localized name
  // fails on non-English Windows). These assert the exact icacls the hardener runs.
  {
    const calls = C.secureDirArgs('C:/x/arc-profiles', 'DOM\\user');
    const args = calls.flat();
    ok('secureDirArgs REMOVES inherited ACEs (/inheritance:r) — without it the broad grant survives',
      args.includes('/inheritance:r'));
    ok('...RESETS unrelated explicit ACEs and SETS ownership before granting access',
      calls.some((a) => a[1] === '/reset') && calls.some((a) => a[1] === '/setowner' && a[2] === 'DOM\\user'));
    ok('...names Administrators by SID *S-1-5-32-544 (language-independent), not the localized name',
      args.includes('*S-1-5-32-544:(OI)(CI)F'));
    ok('...grants exactly owner + SYSTEM + Administrators in one replacement operation',
      args.includes('DOM\\user:(OI)(CI)F') && args.includes('SYSTEM:(OI)(CI)F')
      && args.filter((a) => a === '/grant:r').length === 1);
    ok('...targets the given directory in every icacls call', calls.every((a) => a[0] === 'C:/x/arc-profiles'));

    // secureFileArgs closes the EXISTING-credential-file exposure (audit #289 blocker 2): a broadly
    // readable .credentials.json keeps its own explicit ACL unless the FILE itself is reset. Same
    // exact-boundary sequence as the dir, but plain F (a file has no OI/CI container-inherit flags).
    const fcalls = C.secureFileArgs('C:/x/prof/.credentials.json', 'DOM\\user');
    const fargs = fcalls.flat();
    ok('secureFileArgs RESETS the file\'s own DACL + sets owner before granting (existing broad ACE cannot survive)',
      fcalls.some((a) => a[1] === '/setowner' && a[2] === 'DOM\\user') && fcalls.some((a) => a[1] === '/reset')
      && fargs.includes('/inheritance:r'));
    ok('...grants exactly owner + SYSTEM + Administrators-by-SID with plain F (no OI/CI on a file)',
      fargs.includes('DOM\\user:F') && fargs.includes('SYSTEM:F') && fargs.includes('*S-1-5-32-544:F')
      && fargs.filter((a) => a === '/grant:r').length === 1
      && !fargs.some((a) => /\(OI\)\(CI\)/.test(a)));
    ok('...targets the given file in every icacls call', fcalls.every((a) => a[0] === 'C:/x/prof/.credentials.json'));

    // idempotent + best-effort: a second call on the same path is a no-op, and it never throws
    let threw = false;
    try { C.secureDir('C:/x/definitely-not-a-real-dir-xyz'); C.secureDir('C:/x/definitely-not-a-real-dir-xyz'); }
    catch { threw = true; }
    ok('secureDir is best-effort (never throws) and path-cached', threw === false);
  }

  // ---- per-account env: a gateway serving a FOREIGN model needs harness accommodations,
  // and those must not survive a switch back to a normal account.
  const gwx = { id: 'gwx', type: 'api', baseUrl: 'https://x.example.com', apiKeyEnv: 'ARC_TEST_KEY',
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
  const claudex = { id: 'cx', type: 'api', baseUrl: 'https://proxy.local', apiKeyEnv: 'ARC_TEST_KEY',
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
  ok('sub-only (no gateway), sub exhausted -> least-bad sub', pick(cfg([SUB]), subUse(100)) === 'max');
  ok('no cache -> null (do not guess)', core.chooseLaunchAccount(cfg([SUB, GW]), null) === null);
  ok('api-only config, no metrics -> the gateway', pick(cfg([GW]), subUse(100)) === 'whale');
  const reason = (c, cache) => core.chooseLaunchAccount(c, cache).reason;
  ok('a gateway is labelled "assumed available" (no rate-limit metrics exist for one)',
    /assumed available/.test(reason(cfg([SUB, GW]), subUse(100))));
  // The pool-DB era is REMOVED (2026-07-18): a stale cache file may still carry pool rows,
  // and they must be dead weight — never a headroom signal, never a different label.
  ok('legacy cache.pool rows are ignored: same pick, same label',
    pick(cfg([SUB, GW]), withPool(subUse(100), 20)) === 'whale'
    && /assumed available/.test(reason(cfg([SUB, GW]), withPool(subUse(100), 100, 'cooldown'))));
} catch (e) { ok('chooseLaunchAccount works', false, e.message); }

// ---- 2b. per-account subscription usage attribution --------------------------
// Regression: subscription usage lived in ONE un-keyed slice (cache.usage), fetched
// with whichever account happened to be active. Right after a switch it was still
// TTL-fresh, so the PREVIOUS account's numbers were painted under the new account's
// label (and, looking fresh, suppressed the refresh that would have fixed them);
// /arc-peek and auto-select scored every oauth account off that same blob.
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

  // THE CLOBBER REGRESSION: /permissions inside a PROFILED session writes to the profile's
  // own settings.json; ensureProfile runs every launch and used to wholesale-replace the
  // permissions key from root — silently deleting every rule the human added. Union, not
  // replace: the human's grants survive, arc's new verbs still arrive, local scalars win.
  const profSettings = path.join(dirA, 'settings.json');
  const withUser = JSON.parse(fs.readFileSync(profSettings, 'utf8'));
  withUser.permissions = { allow: ['Bash(git commit:*)', 'Bash(git add:*)'], defaultMode: 'auto' };
  fs.writeFileSync(profSettings, JSON.stringify(withUser, null, 2));
  writeJSON(path.join(CLAUDE, 'settings.json'),
    { hooks: { Stop: [] }, statusLine: { type: 'command', command: 'x' }, permissions: { allow: ['Bash(arc close:*)'], defaultMode: 'plan' } });
  P.ensureProfile('acctA');
  const merged = JSON.parse(fs.readFileSync(profSettings, 'utf8')).permissions;
  ok('sync UNION-merges permissions: the human\'s profile-local rules SURVIVE a launch',
    merged.allow.includes('Bash(git commit:*)') && merged.allow.includes('Bash(git add:*)'));
  ok('...while arc\'s new root verbs still arrive', merged.allow.includes('Bash(arc close:*)'));
  ok('...and profile-local scalars win (defaultMode stays the profile\'s)', merged.defaultMode === 'auto');

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
  ok('encodeProject: nested dir', sync.encodeProject('E:\\arc') === 'E--arc');
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
  ok('`/arc-export all` refuses when the project is undeterminable', r.ok === false && /which project folder/.test(r.message));
  ok('  and it points at `/arc-export global`', /\/arc-export global/.test(r.message));

  try { fs.unlinkSync(path.join(cacheDir, `arc-state-${S}.json`)); } catch {}
} catch (e) { ok('arc-sync export selectors work', false, e.message); }

// ---- /arc-import destination: a BARE positional == --dest -----------------------
// Regression: `/arc-import <archive> E:` silently IGNORED the `E:` — the import ran with
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
  ok('  and the error shows BOTH forms', /--dest/.test(rel.message) && /\/arc-import <archive>/.test(rel.message));

  // the explicit flag is still honoured, and wins over a positional
  const flag = sync.doImport('nosess', `"${tgz}" --dest bad-relative --dry-run`);
  ok('an explicit --dest is still validated', flag.ok === false && /must be an ABSOLUTE/.test(flag.message));
  ok('the flag WINS over a bare positional', /bad-relative/.test(
    sync.doImport('nosess', `"${tgz}" E: --dest bad-relative --dry-run`).message));

  // a missing archive is still the first thing reported
  ok('a missing archive still errors first', /archive not found/.test(sync.doImport('nosess', 'nope.tgz E:').message));
  fs.unlinkSync(tgz);
} catch (e) { ok('arc-sync import destination works', false, e.message); }

// ---- arc-sync — /arc-import --dest re-rooting (office/home path parity) ---------
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

// ---- arc-sync — the board travels (export stages .arc, import merges it) --------
section('arc-sync (board export/import: the ledger merge + the audit-signed binning)');
try {
  const sync = require(path.join(SRC, 'arc-sync.js'));
  const RM = require(path.join(SRC, 'arc-board.js'));

  // -- mergeLedgers: the whole feature's correctness lives here --------------------
  const J = (o) => JSON.stringify(o);
  const noid1 = J({ from: 'a', body: 'legacy one' }), noid2 = J({ from: 'b', body: 'legacy two' });
  const idA = J({ id: 'org1:aa', from: 'a', body: 'A' }), idB = J({ id: 'org1:bb', from: 'b', body: 'B' });
  const idC = J({ id: 'org2:cc', from: 'c', body: 'C' });
  const led = (...ls) => ls.join('\n') + '\n';

  ok('merge: identical ledgers are a no-op (added 0)',
    (() => { const m = sync.mergeLedgers(led(noid1, idA), led(noid1, idA)); return m.ok && m.added === 0 && m.text === led(noid1, idA); })());
  ok('merge: archive ahead — new id-bearing notes append in archive order',
    (() => { const m = sync.mergeLedgers(led(noid1, idA), led(noid1, idA, idB, idC));
      return m.ok && m.added === 2 && m.text === led(noid1, idA, idB, idC); })());
  ok('merge: local ahead — local kept byte-identical, nothing added',
    (() => { const m = sync.mergeLedgers(led(noid1, idA, idB), led(noid1, idA)); return m.ok && m.added === 0 && m.text === led(noid1, idA, idB); })());
  ok('merge: both sides new — union by id, local order first, archive-only appended',
    (() => { const m = sync.mergeLedgers(led(idA, idB), led(idA, idC)); return m.ok && m.added === 1 && m.text === led(idA, idB, idC); })());
  ok('merge: the LONGER id-less prefix wins whole (same synthetic ids on both machines)',
    (() => { const m = sync.mergeLedgers(led(noid1, idA), led(noid1, noid2, idA));
      return m.ok && m.added === 1 && m.text === led(noid1, noid2, idA); })());
  ok('merge: DIVERGENT id-less prefixes REFUSE, naming the first diverging line',
    (() => { const m = sync.mergeLedgers(led(noid1, idA), led(noid2, idA));
      return m.ok === false && m.line === 1 && m.local === noid1 && m.archive === noid2 && /diverge/.test(m.reason); })());
  ok('merge: a torn archive tail line (no id) is never imported',
    (() => { const m = sync.mergeLedgers(led(idA), led(idA, idB) + '{"from":"x","bo'); return m.ok && m.added === 1 && m.text === led(idA, idB); })());
  ok('merge: a fresh destination takes the whole archive',
    (() => { const m = sync.mergeLedgers('', led(noid1, idA)); return m.ok && m.added === 2 && m.text === led(noid1, idA); })());

  // -- E2E: export a repo's board, import it twice (same repo merge; --dest fresh) --
  if (has('tar', ['--version'])) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'brd-'));
    const repoA = path.join(base, 'repoA');
    fs.mkdirSync(path.join(repoA, '.git'), { recursive: true });
    const bA = RM.resolveBoard(repoA); RM.ensureBoard(bA);
    const cidA = '99999999-aaaa-bbbb-cccc-111111111111';
    // the ledger: two frozen id-less lines, then two id-bearing
    fs.writeFileSync(path.join(bA.planDir, 'notes.jsonl'), led(noid1, noid2, idA, idB));
    // claims: one whose conversation travels (WITH a pid — export must strip it), one orphan
    fs.writeFileSync(path.join(bA.planDir, 'claim-alpha.json'), J({ role: 'alpha', pid: DEAD_PID, sessionId: 'a-sess', convId: cidA, at: 7000 }));
    fs.writeFileSync(path.join(bA.planDir, 'claim-ghost.json'), J({ role: 'ghost', pid: DEAD_PID, sessionId: 'g-sess', convId: 'no-such-conv-anywhere', at: 7000 }));
    // cursors: alpha's session travels; cursor-notes is the OTHER machine's human — must stay home
    fs.writeFileSync(path.join(bA.planDir, 'cursor-alpha.json'), J({ o: { x: 2 }, seq: 4, at: 9000 }));
    fs.writeFileSync(path.join(bA.planDir, 'cursor-notes.json'), J({ o: { x: 1 }, seq: 1, at: 9000 }));
    fs.writeFileSync(path.join(bA.planDir, 'seen-alpha.json'), J({ seq: 4, at: 9000 }));
    // machine identity + transients — none of these may enter the archive
    fs.writeFileSync(path.join(bA.planDir, 'origin.json'), J({ id: 'deadbeef', at: 1 }));
    fs.writeFileSync(path.join(bA.planDir, 'anchor-state.json'), J({ lastHead: 'abc123' }));
    fs.writeFileSync(path.join(bA.planDir, 'born-alpha.json'), J({ at: 1 }));
    fs.writeFileSync(path.join(bA.planDir, 'spill-3.txt'), 'delivery cache');
    fs.mkdirSync(path.join(repoA, '.arc', 'roles'), { recursive: true });
    fs.writeFileSync(path.join(repoA, '.arc', 'roles', 'alpha.md'), '# alpha\nowns: x\n');
    // the session whose launch cwd names this repo
    const projA = sync.encodeProject(repoA);
    const pdA = path.join(CLAUDE, 'projects', projA); fs.mkdirSync(pdA, { recursive: true });
    fs.writeFileSync(path.join(pdA, cidA + '.jsonl'),
      JSON.stringify({ type: 'user', cwd: repoA, message: { content: 'hi' }, timestamp: '2026-07-01T10:00:00.000Z' }) + '\n');

    const tgz = path.join(base, 'board.tgz');
    const ex = sync.doExport('brd-sess', `${projA} --out "${tgz}"`);
    ok('export succeeds and reports the board riding along', ex.ok === true && /board "repoa"/.test(ex.message), ex.message);
    ok('...the staging dir is cleaned up (finally)', !fs.existsSync(path.join(CLAUDE, 'projects', sync.BOARD_PREFIX + projA)));

    // crack the archive open: the binning must hold ON DISK, not just in the report
    const peek = fs.mkdtempSync(path.join(base, 'peek-'));
    sync.runTar(['-xzf', tgz], { cwd: peek });
    const stage = fs.readdirSync(peek).find((d) => d.startsWith(sync.BOARD_PREFIX));
    ok('the archive holds a staged board dir', !!stage);
    const sp = (rel) => path.join(peek, stage, rel);
    ok('...ledger travels byte-exact', fs.readFileSync(sp('peer/notes.jsonl'), 'utf8') === led(noid1, noid2, idA, idB));
    const tombA = JSON.parse(fs.readFileSync(sp('peer/claim-alpha.json'), 'utf8'));
    ok('...claims are TOMBSTONED at export — pid stripped, convId kept', tombA.pid === undefined && tombA.convId === cidA && tombA.sessionId === 'a-sess');
    ok('...origin/anchor-state/born/spill NEVER travel',
      !fs.existsSync(sp('peer/origin.json')) && !fs.existsSync(sp('peer/anchor-state.json'))
      && !fs.existsSync(sp('peer/born-alpha.json')) && !fs.existsSync(sp('peer/spill-3.txt')));
    ok('...the charter travels', /# alpha/.test(fs.readFileSync(sp('roles/alpha.md'), 'utf8')));
    ok('...board.json records the source repo root', JSON.parse(fs.readFileSync(sp('board.json'), 'utf8')).root === bA.root);

    // IMPORT 1 — same repo: local moved on (a local-only note), archive merges INTO it
    fs.appendFileSync(path.join(bA.planDir, 'notes.jsonl'), idC + '\n');
    const im1 = sync.doImport('brd-sess', `"${tgz}"`);
    ok('import into the SAME repo merges (0 new: archive is a subset of local)', im1.ok === true && /0 new note/.test(im1.message), im1.message);
    ok('...local-only note survives untouched', fs.readFileSync(path.join(bA.planDir, 'notes.jsonl'), 'utf8') === led(noid1, noid2, idA, idB, idC));
    ok('...the orphan claim is DROPPED — a revive pointer arc could not honour', /claim ghost: dropped/.test(im1.message));
    ok('...the phantom-project guard holds: no board dir leaked into ~/.claude/projects',
      !fs.readdirSync(path.join(CLAUDE, 'projects')).some((d) => d.startsWith(sync.BOARD_PREFIX)));

    // IMPORT 2 — a HELD chair is never tombstoned (the live-destination guard, audit #232)
    fs.writeFileSync(path.join(CLAUDE, 'cache', 'arc-state-brd-live.json'), J({ pid: process.pid, cwd: repoA }));
    fs.writeFileSync(path.join(bA.planDir, 'claim-alpha.json'), J({ role: 'alpha', pid: process.pid, sessionId: 'brd-live', convId: cidA, at: Date.now() }));
    const im2 = sync.doImport('brd-sess', `"${tgz}"`);
    const liveClaim = JSON.parse(fs.readFileSync(path.join(bA.planDir, 'claim-alpha.json'), 'utf8'));
    ok('a HELD chair survives import — never tombstone a live peer', /claim alpha: chair is HELD/.test(im2.message) && liveClaim.pid === process.pid, im2.message);
    try { fs.unlinkSync(path.join(CLAUDE, 'cache', 'arc-state-brd-live.json')); } catch {}

    // IMPORT 2b — a local TOMBSTONE that is newer AND revivable here beats the archive's stale
    // one. The tiebreak must read the claim RAW: through roleClaim a tombstone is null, and the
    // week-of-work-on-B revive pointer would be silently clobbered (audit #234).
    const cidB = '99999999-aaaa-bbbb-cccc-222222222222';
    fs.writeFileSync(path.join(pdA, cidB + '.jsonl'), JSON.stringify({ type: 'user', cwd: repoA, message: { content: 'newer life' }, timestamp: '2026-07-02T10:00:00.000Z' }) + '\n');
    fs.writeFileSync(path.join(bA.planDir, 'claim-alpha.json'), J({ role: 'alpha', sessionId: 'b-sess', convId: cidB, at: 8000 }));
    const im2b = sync.doImport('brd-sess', `"${tgz}"`);
    const keptTomb = JSON.parse(fs.readFileSync(path.join(bA.planDir, 'claim-alpha.json'), 'utf8'));
    ok('a NEWER local tombstone with a revivable conversation is KEPT (raw read, not roleClaim)',
      /claim alpha: local revive pointer is newer/.test(im2b.message) && keptTomb.convId === cidB && keptTomb.at === 8000, im2b.message);

    // IMPORT 2c — newer but BROKEN loses: a pointer this machine cannot revive is worth less
    // than an older one it can (the local side passes the same availability gate).
    fs.writeFileSync(path.join(bA.planDir, 'claim-alpha.json'), J({ role: 'alpha', sessionId: 'x-sess', convId: 'conv-that-exists-nowhere', at: 999999999 }));
    const im2c = sync.doImport('brd-sess', `"${tgz}"`);
    const healedTomb = JSON.parse(fs.readFileSync(path.join(bA.planDir, 'claim-alpha.json'), 'utf8'));
    ok('a newer local pointer at an UNAVAILABLE conversation loses to a working archive one',
      healedTomb.convId === cidA && healedTomb.pid === undefined, im2c.message);

    // IMPORT 3 — --dest onto a fresh clone: the board lands whole, gated correctly
    const destOuter = path.join(base, 'dest');
    fs.mkdirSync(path.join(destOuter, path.basename(bA.root), '.git'), { recursive: true });
    const im3 = sync.doImport('brd-sess', `"${tgz}" --dest "${destOuter}"`);
    const bB = RM.resolveBoard(path.join(destOuter, path.basename(bA.root)));
    ok('--dest: the board lands at the re-rooted repo', im3.ok === true && fs.existsSync(path.join(bB.planDir, 'notes.jsonl')), im3.message);
    ok('...fresh destination takes the whole archive ledger', fs.readFileSync(path.join(bB.planDir, 'notes.jsonl'), 'utf8') === led(noid1, noid2, idA, idB));
    const tombB = JSON.parse(fs.readFileSync(path.join(bB.planDir, 'claim-alpha.json'), 'utf8'));
    ok('...alpha claim lands as a pid-less tombstone (its transcript travelled)', tombB.pid === undefined && tombB.convId === cidA);
    ok('...ghost claim never lands (transcript absent)', !fs.existsSync(path.join(bB.planDir, 'claim-ghost.json')));
    ok('...cursor-alpha carried; cursor-notes stayed home',
      fs.existsSync(path.join(bB.planDir, 'cursor-alpha.json')) && !fs.existsSync(path.join(bB.planDir, 'cursor-notes.json')));
    ok('...origin was NOT imported — the destination mints its own', !fs.existsSync(path.join(bB.planDir, 'origin.json')));
    ok('...the charter arrived', fs.existsSync(path.join(bB.root, '.arc', 'roles', 'alpha.md')));

    // IMPORT 4 — divergence refuses E2E, local untouched, the LINE is named
    const before = led(noid1, idA);
    fs.writeFileSync(path.join(bA.planDir, 'notes.jsonl'), before.replace('legacy one', 'REWRITTEN HISTORY'));
    const im4 = sync.doImport('brd-sess', `"${tgz}"`);
    ok('divergent id-less prefixes REFUSE the merge and name the line',
      /merge REFUSED/.test(im4.message) && /line 1/.test(im4.message), im4.message);
    ok('...and the local board is untouched by the refusal',
      fs.readFileSync(path.join(bA.planDir, 'notes.jsonl'), 'utf8') === before.replace('legacy one', 'REWRITTEN HISTORY'));

    // IMPORT 5 — THE LANDING GATE (audit #236 defect 1): a transcript BLOCKED from landing
    // (live-protected) must take its claim down with it AT THAT ROOT. The old gate answered
    // "in the archive, or anywhere on disk?" — both true here — and minted a ghost pointer
    // a revive from the new root could not honour.
    fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-convlock-${cidA}.json`), J({ pid: process.pid }));
    const destOuter2 = path.join(base, 'dest2');
    fs.mkdirSync(path.join(destOuter2, path.basename(bA.root), '.git'), { recursive: true });
    const im5 = sync.doImport('brd-sess', `"${tgz}" --dest "${destOuter2}"`);
    const bC = RM.resolveBoard(path.join(destOuter2, path.basename(bA.root)));
    ok('a claim whose transcript could NOT land is DROPPED at that root (the ghost gate, live-protected case)',
      /skipped:.*open in a live session/.test(im5.message)
      && !fs.existsSync(path.join(bC.planDir, 'claim-alpha.json'))
      && /claim alpha: dropped — its conversation is not reachable/.test(im5.message), im5.message);
    ok('...and its cursor/seen go with it (no inherited blindness at a root with no session)',
      !fs.existsSync(path.join(bC.planDir, 'cursor-alpha.json')) && !fs.existsSync(path.join(bC.planDir, 'seen-alpha.json')));
    try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-convlock-${cidA}.json`)); } catch {}

    // IMPORT 6 — DRY-RUN PREVIEWS THE REAL DECISION (audit #236 defect 2): a HELD chair must
    // read "would keep", never "would carry" — the old branch answered before the guard ran,
    // promising the exact mutation the real run then refused.
    fs.writeFileSync(path.join(bA.planDir, 'notes.jsonl'), led(noid1, noid2, idA, idB, idC));   // heal the divergence from import 4
    fs.writeFileSync(path.join(CLAUDE, 'cache', 'arc-state-brd-live.json'), J({ pid: process.pid, cwd: repoA }));
    fs.writeFileSync(path.join(bA.planDir, 'claim-alpha.json'), J({ role: 'alpha', pid: process.pid, sessionId: 'brd-live', convId: cidA, at: Date.now() }));
    const im6 = sync.doImport('brd-sess', `"${tgz}" --dry-run`);
    const heldAfterDry = JSON.parse(fs.readFileSync(path.join(bA.planDir, 'claim-alpha.json'), 'utf8'));
    ok('--dry-run previews the HELD guard ("would keep"), never a mutation the real run refuses',
      /claim alpha: would keep — chair is HELD/.test(im6.message) && !/claim alpha: would carry/.test(im6.message), im6.message);
    ok('...and a dry run writes nothing (the live claim is untouched)', heldAfterDry.pid === process.pid);

    try { fs.unlinkSync(path.join(CLAUDE, 'cache', 'arc-state-brd-live.json')); } catch {}
    fs.rmSync(base, { recursive: true, force: true });
  } else {
    ok('(tar unavailable — skipped the board round-trip)', true);
  }
} catch (e) { ok('arc-sync board export/import', false, e.message + '\n' + (e.stack || '')); }

// ---- 5. arc-switch-core — peek + trash rendering ------------------------------
section('arc-switch-core');
try {
  const core = require(path.join(SRC, 'arc-switch-core.js'));
  const peek = core.buildPeek('no-session');
  ok('buildPeek returns a message (never throws)', peek && typeof peek.message === 'string' && peek.message.length > 0);

  // Roadmap #10 — per-model weeklies from limits[]. Field map measured live (research
  // #257, CORRECTED #264): weekly_scoped + scope.model.display_name is the ONLY true
  // source; the top-level seven_day_opus/sonnet fields are null on subscriptions.
  const FX = { limits: [
    { kind: 'session', percent: 12, severity: 'normal' },
    { kind: 'weekly_all', percent: 29, severity: 'normal' },
    { kind: 'weekly_scoped', percent: 23, severity: 'normal', resets_at: '2026-07-24T00:00:00Z', scope: { model: { display_name: 'Fable' } } },
    { kind: 'weekly_scoped', percent: 88, severity: 'warning', scope: { model: { display_name: 'Opus' } } },
    null, { kind: 'weekly_scoped', scope: {} },
  ] };
  const sc = core.scopedLimits(FX);
  ok('scopedLimits extracts ONLY weekly_scoped entries with a model name',
    sc.length === 2 && sc[0].label === '7d · Fable' && sc[0].percent === 23 && sc[1].label === '7d · Opus');
  ok('...and carries severity through (glyph: normal silent, non-normal ⚠, critical ⛔)',
    core.sevGlyph(sc[0].severity) === '' && core.sevGlyph('warning') === ' ⚠'
    && core.sevGlyph('critical') === ' ⛔' && core.sevGlyph('someday-new-value') === ' ⚠');
  ok('...and every malformed shape yields [] (enrichment can never break peek)',
    core.scopedLimits({}).length === 0 && core.scopedLimits(null).length === 0
    && core.scopedLimits({ limits: 'junk' }).length === 0);

  // End-to-end through buildPeek: fixture config + cache in the hermetic HOME. The
  // enrichment line renders only when scoped data exists; a plain payload renders
  // exactly the pre-#10 shape (no extra line).
  // Save-write-test-RESTORE, so the e2e runs regardless of what earlier tests left in
  // the hermetic HOME (a skip guard here silently skipped on the first run — the exact
  // "green light wired to nothing" this suite keeps hunting in others).
  const cfgPath = path.join(CLAUDE, 'arc-config.json');
  const cachePath = path.join(CLAUDE, 'cache', 'usage-monitor-cache.json');
  const savedCfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath) : null;
  const savedCache = fs.existsSync(cachePath) ? fs.readFileSync(cachePath) : null;
  try {
    fs.writeFileSync(cfgPath, JSON.stringify({ version: 1, defaultAccount: 'fx', accounts: [{ id: 'fx', type: 'oauth', label: 'fx' }] }));
    fs.mkdirSync(path.join(CLAUDE, 'cache'), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
      usageByAccount: { fx: { fetchedAt: Date.now(), data: {
        five_hour: { utilization: 12, resets_at: '2026-07-18T15:00:00Z' },
        seven_day: { utilization: 29, resets_at: '2026-07-24T00:00:00Z' },
        ...FX,
      } } },
    }));
    const rich = core.buildPeek('no-session');
    ok('peek renders the per-model line from limits[] (with the ⚠ glyph)',
      /7d · Fable 23%/.test(rich.message) && /7d · Opus 88% ⚠/.test(rich.message));
    fs.writeFileSync(cachePath, JSON.stringify({
      usageByAccount: { fx: { fetchedAt: Date.now(), data: {
        five_hour: { utilization: 12, resets_at: null }, seven_day: { utilization: 29, resets_at: null },
      } } },
    }));
    const plain = core.buildPeek('no-session');
    ok('...and a payload WITHOUT limits[] renders exactly the pre-enrichment shape',
      /5h 12%/.test(plain.message) && !/7d · /.test(plain.message));
  } finally {
    if (savedCfg != null) fs.writeFileSync(cfgPath, savedCfg); else fs.rmSync(cfgPath, { force: true });
    if (savedCache != null) fs.writeFileSync(cachePath, savedCache); else fs.rmSync(cachePath, { force: true });
  }
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
// arc is Windows only, so this asserts the real DPAPI round-trip (via
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
  process.env.ARC_KEY_TEST = 'sk-from-env';
  ok('resolveApiKey reads apiKeyEnv', C.resolveApiKey({ id: 'e', type: 'api', apiKeyEnv: 'ARC_KEY_TEST' }) === 'sk-from-env');
  delete process.env.ARC_KEY_TEST;
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
  const W = require(wire);
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
  // A TIMER, because arc's bar shows things no turn of YOURS produces: a peer's note badge, DEAF,
  // the time-to-limit clock. Claude Code re-renders "after each new assistant message", so an idle
  // session never re-rendered and the note badge — the ambient signal arc's premise rests on —
  // only appeared once you typed, i.e. exactly when you no longer needed it.
  ok('...with a refreshInterval, or an IDLE session never shows a peer\'s note badge',
    s.statusLine.refreshInterval === W.STATUSLINE_REFRESH_SECONDS && s.statusLine.refreshInterval >= 1);
  // THE NO-OP THAT HID FOR MONTHS: setStatusline bailed on ANY existing statusLine, so arc could
  // never update its OWN config after the first install — every later improvement silently skipped
  // every existing machine while the installer still printed "Done".
  const mine = { statusLine: { type: 'command', command: 'node "C:/old/usage-monitor.js" --compact' } };
  ok('a re-install ADOPTS arc\'s own statusline and brings it up to date',
    W.setStatusline(mine, 'node "C:/new/usage-monitor.js" --compact') === false
    && /new/.test(mine.statusLine.command) && mine.statusLine.refreshInterval === W.STATUSLINE_REFRESH_SECONDS);
  // ...but someone else's bar is still sacred.
  const theirs = { statusLine: { type: 'command', command: 'my-own-prompt.sh' } };
  ok('...while a statusline that is NOT ours is never touched',
    W.setStatusline(theirs, 'node "x/usage-monitor.js"') === false
    && theirs.statusLine.command === 'my-own-prompt.sh' && !theirs.statusLine.refreshInterval);
  // And a user's own tuning of OUR bar survives (Object.assign keeps unknown keys).
  const tuned = { statusLine: { type: 'command', command: 'node "x/usage-monitor.js"', padding: 0 } };
  W.setStatusline(tuned, 'node "y/usage-monitor.js"');
  ok('...and their own tweaks to our bar survive the update', tuned.statusLine.padding === 0);
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

  // THE SHIM THAT STOPS A SECRET LEAK. cmd.exe parses a batch command line BEFORE %* forwards
  // anything and mangles every argument three ways, silently, exit 0: truncates at the first
  // NEWLINE, strips QUOTES, and EXPANDS %VAR% — so a note merely NAMING an env var stored its
  // VALUE into notes.jsonl, a durable file injected into other peers' contexts. The POSIX shim is
  // immune and a Bash session never saw it; a STAFFED PEER may have only PowerShell, so every
  // session that exists to ANSWER posted through the mangler. arc.ps1 is what PowerShell resolves
  // a bare `arc` to, and it fixes the newline + the leak on both shells (quotes too on pwsh 7).
  ok('installer ships arc.ps1 — PowerShell must NOT reach the runner through cmd.exe',
    ps.includes("'arc.ps1'") && /\@args/.test(ps));
  ok('...and it passes args to node directly (never through a batch %* command line)',
    /\$runnerPs1 = .*arc-runner\.js.*@args/.test(ps));
  // The .cmd stays for cmd.exe — removing it would break a human's terminal.
  ok('...while arc.cmd stays for cmd.exe, and the POSIX shim for Bash',
    ps.includes("'arc.cmd'") && /\$runnerSh/.test(ps));

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
    // RE-RECORD first: task 7 was COMPLETED above, and a completed task now takes its baseline
    // with it. This assertion is about readBaseline's SHAPE, so it needs one that still exists.
    // (That this line is needed at all is the fix working — the test used to rely on the leak.)
    D.recordBaseline(board, S, '7', base);
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
// The agent's surface is the shell: it RUNS `arc note ...` via Bash. This exercises
// that dispatch end to end through the real arc-runner process.
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
  ok('`arc note` output leaks no retired colon form', !/arc:(note|role|notes)/.test(post.stdout));

  const role = spawnSync(process.execPath, [runner, 'role'], { cwd: repo, env, encoding: 'utf8' });
  ok('`arc role` reports your role', /your role: android/.test(role.stdout));

  // a session with no role can't post; the hint must point at the CLI form (`arc role`),
  // never a retired colon spelling.
  const noRole = spawnSync(process.execPath, [runner, 'note', 'all', 'x'], { cwd: repo, env: { ...process.env, ARC_SESSION: 'no-role-sess' }, encoding: 'utf8' });
  const out = noRole.stdout + noRole.stderr;
  ok('`arc note` with no role is refused and points to `arc role`', noRole.status !== 0 && /arc role/.test(out) && !/arc:role/.test(out));

  // `arc status "<text>"` self-reports activity into arc-status-<session>.json (read by the feed).
  const stPath = path.join(CLAUDE, 'cache', `arc-status-${S}.json`);
  const st1 = spawnSync(process.execPath, [runner, 'status', 'editing the widget'], { cwd: repo, env, encoding: 'utf8' });
  ok('`arc status "<text>"` exits 0 and writes arc-status-<session>.json keyed by ARC_SESSION',
    st1.status === 0 && fs.existsSync(stPath) && JSON.parse(fs.readFileSync(stPath, 'utf8')).activity === 'editing the widget');
  const st2 = spawnSync(process.execPath, [runner, 'status', '--clear'], { cwd: repo, env, encoding: 'utf8' });
  ok('`arc status --clear` removes the activity file', st2.status === 0 && !fs.existsSync(stPath));

  fs.rmSync(repo, { recursive: true, force: true });
  try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-role-${S}.json`)); } catch {}
  try { fs.unlinkSync(stPath); } catch {}
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

  // `arc operator` spawns <scripts>/arc-operator.ps1 via __dirname — so install.ps1 MUST copy it
  // there, or the deployed verb dies with "script not found" (the "src/ is not what runs" trap).
  ok('install.ps1 copies arc-operator.ps1 to $scripts (else `arc operator` has nothing to launch)',
    /Copy-Item \(Join-Path \$kit 'src\\arc-operator\.ps1'\) \$scripts/.test(ps1));
  const runnerSrc = fs.readFileSync(path.join(SRC, 'arc-runner.js'), 'utf8');
  ok('arc-runner launches the widget from __dirname/arc-operator.ps1 (deploy-relative, not src)',
    /path\.join\(__dirname, 'arc-operator\.ps1'\)/.test(runnerSrc));

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
// that do not RUN. It came back with three (the 2026-07-14 shipping-surface audit; its doc is
// retired, git history has it); each is pinned here so it cannot regrow. All are SHIPPING-
// SURFACE assertions: they test the string a human or agent is told to type, not the module.
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

  // C1 — injection() speaks ONLY to the agent, and in the agent's shell a prompt
  // command is not runnable at all. The one runnable form for its audience is the
  // space form.
  const injStart = notesSrc.indexOf('function injection(');
  const injBody = notesSrc.slice(injStart, notesSrc.indexOf('\nfunction ', injStart + 1));
  ok('the board injection tells the AGENT the runnable `arc notes`, never a retired colon form',
    injBody.length > 0 && !/arc:notes/.test(injBody) && /arc notes/.test(injBody));

  // D — the README documented cl-era names the code no longer uses: env vars that do nothing
  // when set, log/backup paths that never exist, and a credentials folder NO code ever creates.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  ok('README documents no dead cl-era names (env vars, cache paths, cl-credentials/)',
    !/CL_[A-Z_]+/.test(readme) && !/cl-(credentials|profiles|deleted|runner|export|import|notify)/.test(readme));
} catch (e) { ok('audit regressions', false, e.message + '\n' + (e.stack || '')); }

// ---- /arc-role / /arc-join auto-arm (the one command that deliberately costs a turn) ----
// Proven live: a responder claimed its role, went idle, and was DEAF — a blocked
// prompt has no turn, and only the agent's own background command can arm a
// listener. So a successful NEW claim now PASSES THROUGH: the hook does the claim (instant,
// in-hook), then hands the model one turn with orders to `arc join`. Query, refusal, and
// already-armed still block at zero tokens — the turn is spent only when it buys the one
// thing a block cannot.
section('/arc-role auto-arm (fresh claim passes through; the turn runs `arc join`)');
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
  const fresh = askRole('/arc-role research');
  const ctx = (fresh.hookSpecificOutput && fresh.hookSpecificOutput.additionalContext) || '';
  ok('a FRESH claim passes through as a turn (no block), with the claim already done',
    !fresh.decision && /claim is DONE/.test(ctx) && /you are "research"/.test(ctx));
  ok('...and the turn has exactly one job: run `arc join research` in the background',
    /run_in_background: true/.test(ctx) && /arc join research/.test(ctx));
  // The arm command must be run CLEAN: a shell & / redirect breaks the permission allowlist (so it
  // prompts) AND is not a wakeable listener. audit mis-armed with `arc join audit >/dev/null 2>&1 &`
  // and stayed deaf — the guidance now forbids decoration explicitly.
  ok('...and it forbids shell decoration on the arm (no & / redirects — the mis-arm that kept audit deaf)',
    /no &/i.test(ctx) && /redirect/i.test(ctx) && /allowlist/i.test(ctx));
  ok('...and it forbids inventing work ("do not start work nobody asked for")',
    /Do not start work nobody asked for/i.test(ctx));

  // Re-claim with a LIVE listener: nothing left for a turn to buy — block at zero tokens.
  AW.markWaiting(JS, 'research', process.pid);
  const armed = askRole('/arc-role research');
  ok('a re-claim with a LIVE listener blocks at zero tokens ("already armed")',
    armed.decision === 'block' && /already armed/.test(armed.reason || ''));

  // A listener armed for the OLD role hears nothing on the new one — that is armNeeded too.
  const moved = askRole('/arc-join android');   // join: alias, reachable programmatically
  const mctx = (moved.hookSpecificOutput && moved.hookSpecificOutput.additionalContext) || '';
  ok('/arc-join is the same command: switching roles with an OLD-role listener re-arms',
    !moved.decision && /OLD role "research"/.test(mctx) && /arc join android/.test(mctx));

  // The zero-token forms stay zero-token.
  ok('the bare `/arc-role` query still blocks (zero tokens)',
    askRole('/arc-role').decision === 'block');
  const norepo2 = fs.mkdtempSync(path.join(os.tmpdir(), 'noboard-'));
  ok('a non-repo refusal still blocks (zero tokens) — no turn spent on a failed claim',
    /not a git repository/.test(askRole('/arc-role research', norepo2).reason || ''));

  AW.clearWaiting(JS);
  fs.rmSync(jrepo, { recursive: true, force: true });
  fs.rmSync(norepo2, { recursive: true, force: true });
} catch (e) { ok('/arc-role auto-arm', false, e.message + '\n' + (e.stack || '')); }

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

// ---- the cache sweeper: a hand-maintained list that drifted ---------------------------
// Every per-session file arc writes must be swept or it lives for the life of the machine. The
// sweeper's list was written once and never revisited, so every later feature leaked: role,
// stance, armed, listen-offered, await — 15 orphaned role files and 6 dead listener markers were
// sitting in a real cache, plus a trigger from a session dead for days. Exactly the same disease
// as install.ps1's hook list, so it gets the same cure: a test that fails when the list drifts.
section('cache sweeper (no per-session file may leak, and the list cannot drift)');
try {
  const RUN2 = require(path.join(SRC, 'arc-runner.js'));

  // THE DRIFT GUARD. Scan src/ for every `arc-<kind>-${...}` file arc actually writes, and demand
  // the sweeper knows about each. A new feature that adds a file now fails here until someone
  // decides its lifetime — swept, or deliberately exempt.
  // Each kind is checked against the sweeper matching its REAL on-disk extension, so the extension
  // must be extracted too — not synthesised. The predecessor built the string `arc-<k>-x.trigger`
  // itself and tested it against a pattern accepting any lowercase kind, making covered() a
  // TAUTOLOGY: it returned true for "totally-made-up", `leaks` was always [], and this assertion
  // could never go red. It held for weeks while the thing it guarded drifted twice (audit #236) —
  // and the comment above still promised "a new feature now fails here". A test that cannot fail is
  // a green light wired to nothing.
  const kinds = new Map();   // kind -> extension ('json' | 'trigger' | 'txt' | 'tgz' | 'dir')
  for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.js'))) {
    const t = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const m of t.matchAll(/arc-([a-z][a-z-]*)-\$\{/g)) {
      // read to end-of-line, NOT to the next quote: `arc-purgepending-${session || 'x'}.json`
      // carries quotes inside its own interpolation and a quote-bounded scan stops short of .json
      const line = t.slice(m.index, m.index + 200).split(/\r?\n/)[0];
      const e = line.match(/\.(json|trigger|txt|tgz)\b/);
      const ext = e ? e[1] : 'dir';
      if (!kinds.has(m[1]) || kinds.get(m[1]) === 'dir') kinds.set(m[1], ext);
    }
  }
  const TRIGGER_RX_T = /^arc-[a-z-]+?-(.+)\.trigger$/;
  // Each exemption states WHY, so "exempt" can never become a place to hide an unswept file.
  const EXEMPT = new Map([
    ['claudex', 'keyed by PORT not session; arc-claudex reclaims a stale one itself, so it must survive to BE reclaimed'],
    ['feed', 'keyed by PORT not session (shape lifted from claudex); the feed reclaims its own stale record via sweepOrphans'],
    ['birth', 'a one-shot birth packet consumed by the newborn on first read'],
    ['export', 'an operator ARTEFACT (arc-export-<ts>.tgz) — the human owns it; arc must never reap it'],
    ['export-list', 'transient manifest, written and read inside one arc export run'],
    ['import', 'a staging DIRECTORY, removed by arc import itself when it completes'],
    ['deleted', 'the RECOVERY trash dir — reaping it would destroy the thing that makes a delete undoable'],
  ]);
  const covered = (k) => {
    const ext = kinds.get(k);
    if (ext === 'json') return RUN2.SWEEP_RX.test(`arc-${k}-x.json`);
    if (ext === 'trigger') return TRIGGER_RX_T.test(`arc-${k}-x.trigger`);
    return false;   // txt/tgz/dir have no sweeper — they must be EXEMPT with a reason, or they leak
  };
  // THE GUARD'S OWN GUARD. The defect this replaces was invisible precisely because nobody asked
  // whether covered() could ever say no. Assert it can, before trusting what it says.
  ok('the sweep-coverage guard is CAPABLE OF FAILING (a made-up kind is not covered)',
    !covered('totally-made-up') && !covered('zzz'));

  const leaks = [...kinds.keys()].filter((k) => !EXEMPT.has(k) && !covered(k));
  ok(`every per-session file kind is swept or exempt (${kinds.size} kinds found in src/)`,
    leaks.length === 0, leaks.length ? 'LEAKS: ' + leaks.map((k) => `${k}.${kinds.get(k)}`).join(', ') : '');

  // SWEEP_RX drifts BOTH ways. A kind listed but never written is dead weight that outlives the
  // feature that justified it, and reads as coverage nobody has.
  const listed = (String(RUN2.SWEEP_RX).match(/\(([a-z|-]+)\)/) || [, ''])[1].split('|').filter(Boolean);
  const dead = listed.filter((k) => kinds.get(k) !== 'json');
  ok('...and SWEEP_RX lists no kind that src/ never writes (drift the other way)',
    dead.length === 0, dead.length ? 'DEAD ENTRIES: ' + dead.join(', ') : '');

  // A LIVE session must never lose its companions to a clock. This is the reason the missing
  // kinds could not simply be bolted onto the age sweep: taking arc-role-* from a session that
  // is alive and working would stop it receiving notes, with nothing to say why.
  const C = path.join(CLAUDE, 'cache');
  fs.mkdirSync(C, { recursive: true });
  const LIVE2 = 'sweep-live-' + process.pid;
  const DEAD2 = 'sweep-dead-' + process.pid;
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000;      // a month old: the clock says "bin me"
  // A REAL other process, not process.pid: arc-runner's pidAlive deliberately treats its OWN pid
  // as dead ("a file naming my pid is not another live process"), which is right in production —
  // the sweeper always runs in a FRESH runner — and makes process.pid useless as a live fixture.
  const { spawn: spawnLive } = require('child_process');
  const liveProc = spawnLive(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(C, `arc-state-${LIVE2}.json`), JSON.stringify({ pid: liveProc.pid, cwd: TMP }));
  fs.writeFileSync(path.join(C, `arc-state-${DEAD2}.json`), JSON.stringify({ pid: DEAD_PID, cwd: TMP }));
  const mk = (name, when) => { const p = path.join(C, name); fs.writeFileSync(p, '{}'); if (when) fs.utimesSync(p, when / 1000, when / 1000); return p; };
  const liveRole = mk(`arc-role-${LIVE2}.json`, old);      // ancient, but its session is ALIVE
  const deadRole = mk(`arc-role-${DEAD2}.json`);           // fresh, but its session is DEAD
  const deadTrig = mk(`arc-mode-${DEAD2}.trigger`);        // a trigger nobody will ever consume

  RUN2.sweepStaleStates();

  ok('a LIVE session keeps its role file even when the file is a month old (life, not a clock)',
    fs.existsSync(liveRole));
  ok('a DEAD session\'s role file is swept immediately, however fresh',
    !fs.existsSync(deadRole));
  ok('a trigger whose session died is swept (it can never be consumed)',
    !fs.existsSync(deadTrig));

  // An UNKNOWABLE session (its state already swept) must not be guessed at: only bin its
  // companions once they are far too old to belong to anyone.
  const GHOST = 'sweep-ghost-' + process.pid;              // no arc-state at all
  const ghostFresh = mk(`arc-role-${GHOST}.json`);
  const ghostOld = mk(`arc-stance-${GHOST}.json`, old);
  RUN2.sweepStaleStates();
  ok('an UNKNOWABLE session\'s fresh file is left alone (absent state != dead session)',
    fs.existsSync(ghostFresh));
  ok('...but its ancient one is finally binned', !fs.existsSync(ghostOld));

  try { liveProc.kill(); } catch {}
  for (const f of [`arc-state-${LIVE2}.json`, `arc-state-${DEAD2}.json`, `arc-role-${LIVE2}.json`, `arc-role-${GHOST}.json`]) {
    try { fs.unlinkSync(path.join(C, f)); } catch {}
  }
} catch (e) { ok('cache sweeper', false, e.message + '\n' + (e.stack || '')); }

// ---- staffing a peer (new tab, revived-or-forked context, self-arming) -------------
// invite adds a TAB, not a mechanism: a REVIVE runs `arc --name <role> --resume <its own
// conv> "/arc-role <role>"` (programmatic prompts bypass the typed-command gate,
// measured 2026-07-18) and a BIRTH forks the caller with a PROSE instruction; the
// existing fresh-claim pass-through does the claiming + arming in the new session's first
// turn. These tests inject a spawn recorder — nothing real opens.
// ---- task baselines must not outlive their task --------------------------------------
// A baseline is written at TaskCreated so a completion can be checked against git. It lived
// forever: nothing in arc-done ever called unlink. Three leaks, none with a symptom — just
// files. A real board had 14 orphans from two long-dead sessions; every task on a busy project
// left one behind.
section('arc-done baselines (they must not outlive the task)');
try {
  const DN = require(path.join(SRC, 'arc-done.js'));
  const RMb = require(path.join(SRC, 'arc-board.js'));

  const brepo = fs.mkdtempSync(path.join(os.tmpdir(), 'base-'));
  spawnSync('git', ['init', '-q'], { cwd: brepo });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: brepo });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: brepo });
  fs.writeFileSync(path.join(brepo, 'a.txt'), 'one');
  spawnSync('git', ['add', '-A'], { cwd: brepo });
  spawnSync('git', ['commit', '-qm', 'first'], { cwd: brepo });
  const bb = RMb.resolveBoard(brepo); RMb.ensureBoard(bb);

  const LIVE = 'base-live-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${LIVE}.json`),
    JSON.stringify({ pid: process.pid, cwd: brepo }));

  const exists = (s, t) => fs.existsSync(DN.baselineFile(bb, s, t));
  const prevGate = process.env.ARC_DONE_GATE;

  // ---- a COMPLETED task must take its baseline with it ----
  process.env.ARC_DONE_GATE = 'note';
  DN.onTaskCreated({ cwd: brepo, task_id: 1 }, LIVE);
  ok('(setup) TaskCreated records a baseline', exists(LIVE, 1));
  fs.writeFileSync(path.join(brepo, 'b.txt'), 'two');
  spawnSync('git', ['add', '-A'], { cwd: brepo });
  spawnSync('git', ['commit', '-qm', 'the work'], { cwd: brepo });
  DN.onTaskCompleted({ cwd: brepo, task_id: 1, task_subject: 'x' }, LIVE);
  ok('a COMPLETED task deletes its baseline (it had done its job)', !exists(LIVE, 1));

  // ---- a BLOCKED completion must KEEP it: the retry needs the exact sha ----
  // This is the subtle one. Dropping it here would still leave the gate FIRING — just on the
  // coarser birth-time fallback instead of the exact sha, silently, on the retry.
  process.env.ARC_DONE_GATE = 'strict';
  DN.onTaskCreated({ cwd: brepo, task_id: 2 }, LIVE);
  const blocked = DN.onTaskCompleted({ cwd: brepo, task_id: 2, task_subject: 'no commit yet' }, LIVE);
  ok('(setup) an uncommitted completion is REFUSED under strict', blocked.block === true);
  ok('a BLOCKED completion KEEPS its baseline — the retry needs the exact sha',
    exists(LIVE, 2));
  // ...and once the agent actually commits, the retry succeeds AND cleans up.
  fs.writeFileSync(path.join(brepo, 'c.txt'), 'three');
  spawnSync('git', ['add', '-A'], { cwd: brepo });
  spawnSync('git', ['commit', '-qm', 'now committed'], { cwd: brepo });
  const retried = DN.onTaskCompleted({ cwd: brepo, task_id: 2, task_subject: 'now done' }, LIVE);
  ok('...and the retry, once committed, passes and clears it',
    retried.block === false && !exists(LIVE, 2));

  // ---- gate OFF must not litter: nothing would ever read it ----
  process.env.ARC_DONE_GATE = 'off';
  DN.onTaskCreated({ cwd: brepo, task_id: 3 }, LIVE);
  ok('with the gate OFF, no baseline is written at all (nothing would ever read it)',
    !exists(LIVE, 3));
  process.env.ARC_DONE_GATE = 'note';

  // ---- an ABANDONED task's baseline is swept once its session dies ----
  const DEAD = 'base-dead-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${DEAD}.json`),
    JSON.stringify({ pid: DEAD_PID, cwd: brepo }));          // verified-dead at suite start
  DN.recordBaseline(bb, DEAD, 7, 'deadbeef');
  DN.recordBaseline(bb, LIVE, 8, 'cafebabe');
  ok('(setup) both a dead session\'s and a live session\'s baselines exist',
    exists(DEAD, 7) && exists(LIVE, 8));

  const swept = DN.sweepBaselines(bb);
  ok('a DEAD session\'s baseline is swept — it can never complete that task',
    swept >= 1 && !exists(DEAD, 7));
  ok('...but a LIVE session\'s is untouched (it may still complete it)', exists(LIVE, 8));

  // The session id itself contains a dash (pid-random), so the parse must take the LAST chunk
  // as the task — get this backwards and it sweeps nothing, or the wrong thing.
  ok('the <session>-<taskId> key parses correctly even though a session id has a dash',
    !exists(DEAD, 7) && exists(LIVE, 8));

  // `nosession` is left alone: we cannot judge a liveness we never recorded, and guessing
  // would delete a live task's baseline.
  DN.recordBaseline(bb, '', 9, 'nosesh');
  DN.sweepBaselines(bb);
  ok('a `nosession` baseline is never swept on a guess', exists('', 9));

  // And TaskCreated does the sweeping, so it happens without anyone remembering to.
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${DEAD}.json`),
    JSON.stringify({ pid: DEAD_PID, cwd: brepo }));
  DN.recordBaseline(bb, DEAD, 10, 'deadbeef2');
  const r = DN.onTaskCreated({ cwd: brepo, task_id: 11 }, LIVE);
  ok('TaskCreated sweeps dead baselines on the way in (nobody has to remember)',
    r.swept >= 1 && !exists(DEAD, 10));

  if (prevGate === undefined) delete process.env.ARC_DONE_GATE; else process.env.ARC_DONE_GATE = prevGate;
  fs.rmSync(brepo, { recursive: true, force: true });
  for (const s of [LIVE, DEAD]) { try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-state-${s}.json`)); } catch {} }
} catch (e) { ok('arc-done baselines', false, e.message + '\n' + (e.stack || '')); }

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
  ok('the self-ignore now sits ONE LEVEL UP (.arc/.gitignore) and covers the whole .arc',
    /^\*$/m.test(fs.readFileSync(path.join(old, '.arc', '.gitignore'), 'utf8')));
  ok('...and the retired per-dir pair inside peer/ is gone (the union merge job moved into arc import)',
    !fs.existsSync(path.join(old, '.arc', 'peer', '.gitignore')) && !fs.existsSync(path.join(old, '.arc', 'peer', '.gitattributes')));
  ok('...and it DOES swallow .arc/roles/ — the operator ruled the whole .arc machine state (2026-07-17)',
    (() => { fs.mkdirSync(path.join(old, '.arc', 'roles'), { recursive: true });
      fs.writeFileSync(path.join(old, '.arc', 'roles', 'code.md'), ['# code', '', 'owns: things', ''].join('\n'));
      const r = spawnSync('git', ['check-ignore', '.arc/roles/code.md'], { cwd: old, encoding: 'utf8' });
      return r.status === 0; })());

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
  const I = require(path.join(SRC, 'arc-invite.js'));

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

  // EVERY FIXTURE ABOVE IS ONE LINE, AND THAT IS WHY THEY ALL PASSED WHILE THE ROSTER WAS WRONG.
  // We ask for three plain lines (owns:/send me:/not me:). The first real board answered with two
  // full markdown documents, hard-wrapped at ~104 columns — so "the first prose LINE" was an
  // arbitrary column cut, and the live roster read:
  //     ● android live — The **product-build** session: owns **both sides of Whale's core loop
  // …ending on a dangling article inside an unclosed paren, with the bold markers intact, in a
  // TERMINAL. Format guidance does not survive contact with a session writing its own charter, so
  // these assert the CODE copes with prose instead.
  // the source as the summary sees it: markup gone, lines joined — so "is this a whole word?"
  // is asked against the same text dutySummary was reading.
  const plainSrc = (t) => t.replace(/[*`]/g, '').replace(/\s+/g, ' ');
  const wrapped = '# Role: android — whalephone\n\n'
    + "The **product-build** session: owns **both sides** of the core loop — the on-device app (the\n"
    + '*eyes and hands*) AND the cloud edge. Named `android` for historical reasons.\n\n'
    + '## Owns\n- **The app** (`android/`): a bullet that must not be swallowed\n';
  const s = D.dutySummary(wrapped);
  // "eyes and" lives on the SECOND physical line — reaching it proves the lines were joined
  // rather than the summary stopping where the author's editor happened to wrap.
  ok('a hard-wrapped paragraph is JOINED, not cut at the author\'s column width',
    /\(the eyes and/.test(s) && !/\n/.test(s));
  ok('...markdown emphasis is stripped (the roster is a terminal, not a markdown viewer)',
    !/[*`]/.test(s));
  // The real property: the last word kept must be a WHOLE word of the source. A length check
  // cannot see the difference between "…and" (fine) and "…skeptic-verifi" (corruption).
  const lastWord = s.replace(/…$/, '').trim().split(/\s+/).pop();
  ok('...and it never chops mid-word — the last word survives whole, or not at all',
    s.length <= 101 && /…$/.test(s)
    && new RegExp('(^|\\s)' + lastWord.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '(\\s|[.,)]|$)').test(plainSrc(wrapped)));
  ok('...and a heading or bullet never leaks into the summary',
    !/##|bullet/.test(s));

  // A whole sentence beats 100 chars chopped out of the middle of one, when it fits.
  ok('a short leading SENTENCE is preferred whole (it says more, and says it cleanly)',
    D.dutySummary('# r\n\nThe read-only inquiry session. Turns questions into evidence-grounded\nfindings that survive a skeptic.\n')
      === 'The read-only inquiry session.');
  // ...but not a fragment: "e.g." must not end the summary two words in.
  ok('...but a too-short fragment is not mistaken for a sentence',
    /^Owns the edge/.test(D.dutySummary('# r\n\nOwns the edge. Everything server-side, including the deep-link recipe table.\n')));

  // An `owns:` that wraps must join too — but STOP at the next key, or the summary swallows
  // "send me:" and the one line a peer needs to route work becomes three.
  const ownsWrap = D.dutySummary('owns: the web frontend and any user-facing\nweb surface\nsend me: copy and layout asks\nnot me: the app\n');
  ok('a wrapped `owns:` joins its continuation but STOPS at the next key',
    ownsWrap === 'the web frontend and any user-facing web surface');

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
  // THE CLIPPED-WARNING BUG (field report 2026-07-17, roadmap #1): the warning above is a
  // prose TAIL — a sender piping through `| head -4` saw a clean ✓ while its work landed in
  // a closed chair (the incident transcript shows the warning's orphaned leading '\n').
  // The same truth must live ON LINE ONE, where no clip can lose it.
  ok('...and LINE ONE carries the closed-chair marker (a `| head -4` cannot decapitate it)',
    /is CLOSED/.test(req.message.split('\n')[0]));
  ok('...with the chairHandled flag omitting BOTH (the delegate path fills the chair itself)',
    !/NOBODY HOLDS|is CLOSED/.test(F8.requestNote(AS, 'research --kind request "again"', drepo, { chairHandled: true }).message));
  ok('...and uses the DUTY to make the warning actionable (the chair is real, staff it)',
    /IS a declared role/.test(req.message) && /investigation and docs/.test(req.message)
    && /arc delegate research/.test(req.message));
  ok('...and a REQUEST is called out as never-answerable — do not go idle on it',
    /nobody will answer until someone is in that chair/.test(req.message)
    && /Do not go idle/.test(req.message));
  // AN EMPTY CHAIR IS NOT ONE STATE. This role has NO prior conversation here, so the honest
  // offer is "staffed from YOUR context" — never "revived", which would promise a memory that
  // does not exist. The revivable case is asserted in the staffing section.
  ok('...and a never-held role is offered as STAFFED, not falsely promised as revivable',
    /no session\n\s+has held it/.test(req.message) && !/REVIVE/.test(req.message));

  const info = F8.requestNote(AS, 'ghost "heads up"', drepo);
  ok('an UNDECLARED, unheld role says the repo has no such job at all',
    /does not declare a "ghost" role/.test(info.message));
  ok('...and a non-request note is told it keeps for whoever claims the role next',
    /It keeps:/.test(info.message));

  // ---- parentage + arc close: spawning without closing is a leak --------------------------
  // arc knew a peer EXISTED and never who MADE it, so nothing could reap one — a leaked probe was
  // indistinguishable from a standing team member. Five leaks in one session: three test peers a
  // human had to name, sixteen orphan consoles from a harness that killed the wrong pid, and a
  // ghost holding a chair after its caller was told it never started.
  const CI = require(path.join(SRC, 'arc-invite.js'));
  {
    const BRD = RM7.resolveBoard(drepo);
    RM7.recordBirth(BRD, 'kid', 'dc');            // VS's conv — I spawned it
    RM7.recordBirth(BRD, 'stranger', 'someone-elses-conv');
    ok('a birth records WHO spawned the peer (the newborn cannot know its own parent)',
      RM7.readBirth(BRD, 'kid').bornOf === 'dc');
    ok('...and spawnsOf lists only MINE, keyed by conversation so my own respawn keeps them',
      RM7.spawnsOf(BRD, 'dc').map((b) => b.role).join() === 'kid');

    // THE ORDER IS THE WHOLE BUG. claim pid = arc-runner, the MIDDLE of pwsh -> node -> claude.
    // Kill claude and the runner's for(;;) RESPAWNS it (that is why a harness leaked 16 consoles
    // and why my own probe pids kept changing while I killed the same peer four times).
    // A REAL pid, because closePeer reads roleClaim — which returns a claim ONLY when its holder is
    // GENUINE (alive, and started before the claim was written). That inherited guard is why close
    // cannot murder a RECYCLED pid: Windows reuses numbers, so a dead peer's pid may belong to some
    // innocent process by now, and "kill whatever the claim says" would end it. Nothing is really
    // killed here — the kill is injected; only the ORDER is under test.
    RM7.claimRole(BRD, 'kid', process.pid, 'kid-sess', 'kid-conv');
    const order = [];
    const closed = RM7.closePeer(BRD, 'kid', {
      tree: () => ({ parent: 1111, children: [9999] }),
      kill: (pid) => { order.push(pid); return true; },
    });
    ok('arc close kills the RUNNER FIRST — else the runner respawns the claude you just killed',
      order[0] === process.pid);
    ok('...then claude, then the parent shell — the whole tree, not the one pid the claim names',
      order.join(',') === `${process.pid},9999,1111`);
    ok('...and frees the chair: a claim held by a corpse blocks staffing forever',
      !RM7.roleClaim(BRD, 'kid') && !RM7.readBirth(BRD, 'kid'));
    ok('...reporting what it actually killed, by role in the tree',
      closed.killed.map((k) => k.what).join() === 'runner,claude,shell');
    // THE CLAIM SURVIVES AS A PID-LESS TOMBSTONE — it is the REVIVE POINTER. Unlinking it made
    // "REVIVABLE, not deleted" a lie: the transcript stayed but vacantClaimForRole had nothing to
    // find it with, so the next delegate silently birthed a STRANGER. Caught in production the
    // first time a real standing peer (audit) was closed between assignments.
    const tomb = RM7.vacantClaimForRole(BRD, 'kid');
    ok('close leaves the chair REVIVABLE: the tombstone keeps convId, holds nobody, blocks nothing',
      closed.revivable === true && tomb && tomb.convId === 'kid-conv' && !tomb.pid
      && !RM7.liveRoles(BRD).some((l) => l.role === 'kid'));

    // A DEAD PEER'S PID MAY BELONG TO A STRANGER BY NOW. Windows recycles pids, and this repo has
    // already been bitten by treating one as an identity (d7fae3a: a stranger squatting a closed
    // peer's chair). close inherits roleClaim's genuine-holder check, so it kills NOTHING when the
    // claim points at a pid it cannot prove is the peer — and still frees the chair, which is the
    // part that matters. A claim held by a corpse blocks staffing forever.
    RM7.claimRole(BRD, 'ghost', DEAD_PID, 'ghost-sess', 'ghost-conv');   // not a running process
    let touched = 0;
    const g = RM7.closePeer(BRD, 'ghost', { tree: () => ({ parent: 5, children: [6] }), kill: () => { touched++; return true; } });
    ok('close kills NOTHING when the claim names an unprovable pid (it may be a stranger now)',
      touched === 0 && g.killed.length === 0);
    // "Frees the chair" no longer means "deletes the file": the ghost had a conversation, so its
    // tombstone stays as the revive pointer — while holding nobody (roleClaim null = staffable).
    ok('...but STILL frees the chair — a claim held by a corpse blocks staffing forever',
      !RM7.roleClaim(BRD, 'ghost') && RM7.vacantClaimForRole(BRD, 'ghost').convId === 'ghost-conv');
    // Only a chair with NOTHING to come back to is truly bare: no convId -> the file goes.
    RM7.claimRole(BRD, 'bare', DEAD_PID, 'bare-sess', null);
    RM7.closePeer(BRD, 'bare', { tree: () => ({ parent: null, children: [] }), kill: () => false });
    ok('close with no conversation unlinks outright — a tombstone pointing nowhere is clutter',
      !fs.existsSync(path.join(BRD.planDir, 'claim-bare.json')));

    // THE CLOSE-VS-REVIVE RACE (audit #167): closePeer took no lock, so a concurrent revive's live
    // claim could be clobbered by a stale tombstone — double-staffing + a reverted convId. Fixed:
    // the tombstone runs under the role lock AND aborts if the pid changed since entry. Reproduced
    // deterministically here — the kill hook lands a re-claim (a revive) DURING the close, exactly
    // the interleaving. A genuine entry claim (this live pid) so the kill (and thus the revive) fires.
    RM7.claimRole(BRD, 'raced', process.pid, 'old-sess', 'old-conv');
    const raceRes = RM7.closePeer(BRD, 'raced', {
      tree: () => ({ parent: null, children: [] }),
      // the true interleaving: the old peer dies (release) and a REVIVE claims a fresh pid+conv,
      // all in the window while close is between reading the pid and writing the tombstone.
      kill: () => { RM7.releaseRole(BRD, 'raced', process.pid); RM7.claimRole(BRD, 'raced', 424242, 'new-sess', 'new-conv'); return true; },
    });
    const racedClaim = JSON.parse(fs.readFileSync(path.join(BRD.planDir, 'claim-raced.json'), 'utf8'));
    ok('close ABORTS the tombstone when a revive re-claimed during the kill — no clobber of a live peer',
      raceRes.reclaimed === true && racedClaim.pid === 424242 && racedClaim.convId === 'new-conv');
    // and the normal path is unaffected: no concurrent reclaim -> tombstone written, reclaimed:false
    RM7.claimRole(BRD, 'calm', DEAD_PID, 'calm-sess', 'calm-conv');
    const calmRes = RM7.closePeer(BRD, 'calm', { tree: () => ({ parent: null, children: [] }), kill: () => true });
    const calmTomb = JSON.parse(fs.readFileSync(path.join(BRD.planDir, 'claim-calm.json'), 'utf8'));
    ok('...while an uncontended close still tombstones normally (convId kept, pid gone, reclaimed:false)',
      calmRes.reclaimed === false && calmRes.revivable === true && !calmTomb.pid && calmTomb.convId === 'calm-conv');
  }
  // YOU MAY ONLY CLOSE WHAT YOU SPAWNED — a board is shared, and ending someone else's peer
  // mid-conversation is not yours to do. Checked by CONVERSATION, not session id: a respawn must
  // not lock you out of your own peers (the same trap that made arc blame a caller as a rival).
  {
    const noRec = CI.requestClose(AS, 'neverborn', drepo);
    ok('close refuses a peer arc has no record of spawning', noRec.ok === false && /no record of spawning/.test(noRec.message));
    const theirs = CI.requestClose(AS, 'stranger', drepo);
    ok('...and refuses SOMEONE ELSE\'S peer — theirs to close, not yours',
      theirs.ok === false && /not spawned by you/.test(theirs.message));
    RM7.recordBirth(RM7.resolveBoard(drepo), 'mine', 'dc');
    const mine = CI.requestClose(AS, 'mine', drepo, { close: () => ({ role: 'mine', killed: [{ pid: 1, what: 'runner' }], hadClaim: true, revivable: true }) });
    ok('...but closes YOUR OWN, and says the peer comes back AS ITSELF',
      mine.ok === true && /keeps its seat/.test(mine.message) && /back AS ITSELF/.test(mine.message));
    // ...and does NOT promise revival it cannot deliver: a peer that never persisted a
    // conversation gets the honest message, not the comforting one.
    RM7.recordBirth(RM7.resolveBoard(drepo), 'mine2', 'dc');
    const bare2 = CI.requestClose(AS, 'mine2', drepo, { close: () => ({ role: 'mine2', killed: [], hadClaim: true, revivable: false }) });
    ok('close never promises revival without a conversation to revive',
      bare2.ok === true && /nothing to revive/.test(bare2.message) && !/back AS ITSELF/.test(bare2.message));
  }

  // ---- quiet spawn: the only launch that cannot take the foreground -----------------------
  // A stolen foreground is not a papercut during a MEASUREMENT: the human's Ctrl+C lands in a
  // worker, which voids a trial, and voids whose cause tracks human activity are not random —
  // they bias the wall-clock the run exists to measure. wt has no no-focus flag (1.24), and
  // capture-then-restore is a timing hack on the path that has burned this repo three times.
  // A minimised window has no foreground to take, so quiet BYPASSES wt entirely — a real trade.
  const QI = require(path.join(SRC, 'arc-invite.js'));
  const qw = (q) => QI.buildLaunch(true, 'veneto', null, 'w', 'E:/arc', 'pwsh', null, () => 'C:/T/p.txt', q);
  // HIDDEN, NOT MINIMIZED — and the difference cost a human their keystrokes. Minimised stops a
  // window RESTORING; it does not stop it taking the FOREGROUND. So a minimised peer seized focus
  // into a window with nothing on screen, and the human could not tell whether they had typed into
  // an agent's session. Strictly worse than the visible tab-steal it replaced: a Ctrl+C into a
  // worker is a clean void; text typed into a worker nobody can see is a trial that ran with
  // unknown input and looks normal. Hidden is STRUCTURAL — no visible window, nothing to activate.
  ok('quiet spawn uses -WindowStyle Hidden — MINIMIZED still takes the foreground, invisibly',
    /Start-Process -FilePath 'pwsh' -WindowStyle Hidden/.test(qw(true))
    && !/-WindowStyle Minimized/.test(qw(true)));
  // MEASURED, not preferred: `cmd /c start` is composed INSIDE `powershell -Command`, so PowerShell
  // strips the quotes and cmd reads `start "arc: w" …` as `start arc: w` — it treats `arc:` as the
  // COMMAND, hangs, and staffRole reports ETIMEDOUT. That fallback has never worked through this
  // wrapper; nobody noticed because every machine here has wt.
  ok('...and NEVER via cmd /c start, which the powershell -Command wrapper silently breaks',
    !/cmd \/c start/.test(qw(true)));
  // -ArgumentList is an ARRAY — nothing downstream re-splits it. That is the whole reason this
  // path exists rather than another carefully-quoted string.
  ok('...every argument its own quoted element, so no parser downstream can re-split a path',
    /-ArgumentList '-NoLogo','-NoProfile'/.test(qw(true)));
  ok('...and BYPASSES wt entirely, because wt IS the thing that takes focus',
    !/\bwt -w 0\b/.test(qw(true)) && /\bwt -w 0\b/.test(qw(false)));
  ok('...and it is OFF by default — an invisible peer is an invisible failure',
    QI.spawnQuiet() === false && !/Start-Process/.test(qw(false)));

  // ---- ARC_SPAWN_WINDOW: which wt window a peer's tab joins ------------------------------
  // `-w 0` is NOT "the caller's window" — our own comment claimed that for months. wt documents it
  // as the MOST RECENTLY USED window, so it follows the HUMAN: delegate while they type in another
  // terminal and the peer lands in THEIRS. Confirmed live by the research peer (two tabs with a
  // fixed name went to one separate window; the human's was untouched).
  const winOf = (w) => QI.buildLaunch(true, 'v', null, 'w', 'E:/arc', 'pwsh', null, () => 'C:/T/p.txt', false, w);
  ok('a peer tab joins the MRU window by default (-w 0) — right when a human IS the spawner',
    /^wt -w 0 new-tab/.test(winOf('0')) && QI.spawnWindow() === '0');
  ok('...and ARC_SPAWN_WINDOW pins every peer to ONE named window instead, off the human\'s',
    /^wt -w arc-trials new-tab/.test(winOf('arc-trials')));
  ok('...read from the env so a harness can ask and an interactive human never has to',
    (() => { const prev = process.env.ARC_SPAWN_WINDOW; process.env.ARC_SPAWN_WINDOW = 'arc-trials';
      const w = QI.spawnWindow(); if (prev === undefined) delete process.env.ARC_SPAWN_WINDOW; else process.env.ARC_SPAWN_WINDOW = prev;
      return w === 'arc-trials'; })());
  ok('...opt-in via ARC_SPAWN_QUIET, so a harness can ask and a human never has to',
    (() => { const prev = process.env.ARC_SPAWN_QUIET; process.env.ARC_SPAWN_QUIET = '1';
      const on = QI.spawnQuiet(); if (prev === undefined) delete process.env.ARC_SPAWN_QUIET; else process.env.ARC_SPAWN_QUIET = prev;
      return on === true; })());

  // ---- ARC_SPAWN_PROFILE: which wt profile dresses a peer's tab --------------------------
  // Unset, the launch names NO profile — the only form that works on a machine arc has never
  // seen (profile names are user-chosen, even localized; a wrong -p is wt's silent no-tab).
  // Set, wt applies that profile's icon/theme while our commandline still overrides the run.
  ok('by default a peer tab names NO wt profile (a guessed name is a failed launch elsewhere)',
    // Sample BOTH the launch line AND spawnProfile() while ARC_SPAWN_PROFILE is removed — the
    // "default" this asserts is "no env override, no config key", and spawnProfile() reads the env
    // FIRST. Checking it AFTER restoring the ambient override read the developer's real
    // ARC_SPAWN_PROFILE=PowerShell and failed on this box while passing on a bare CI runner.
    (() => { const prev = process.env.ARC_SPAWN_PROFILE; delete process.env.ARC_SPAWN_PROFILE;
      const line = winOf('0'); const prof = QI.spawnProfile();
      if (prev !== undefined) process.env.ARC_SPAWN_PROFILE = prev;
      return !/ -p /.test(line) && prof === ''; })());
  ok('...and ARC_SPAWN_PROFILE dresses the tab in a named profile, quoted through the PS chain',
    (() => { const prev = process.env.ARC_SPAWN_PROFILE; process.env.ARC_SPAWN_PROFILE = 'Power Shell';
      const line = winOf('0'); if (prev === undefined) delete process.env.ARC_SPAWN_PROFILE; else process.env.ARC_SPAWN_PROFILE = prev;
      return / new-tab -p 'Power Shell' --title /.test(line); })());
  // The DURABLE home is config, not env: an env var must exist in the CALLER's environment,
  // and a session launched before a `setx` never sees it — the day the env-only version
  // shipped, one delegate ran without the var and the peer tab came up generic again.
  ok('...and arc-config "spawnProfile" dresses the tab with NO env var to remember (env wins when both)',
    (() => { const C9 = require(path.join(SRC, 'arc-config.js'));
      const prev = process.env.ARC_SPAWN_PROFILE; delete process.env.ARC_SPAWN_PROFILE;
      const hadCfg = fs.existsSync(C9.CONFIG_PATH) ? fs.readFileSync(C9.CONFIG_PATH, 'utf8') : null;
      fs.writeFileSync(C9.CONFIG_PATH, JSON.stringify({ version: 1, accounts: [{ id: 'x', type: 'oauth' }], spawnProfile: 'Cfg Prof' }));
      const fromCfg = / new-tab -p 'Cfg Prof' --title /.test(winOf('0'));
      process.env.ARC_SPAWN_PROFILE = 'EnvWins';
      const envWins = / new-tab -p 'EnvWins' --title /.test(winOf('0'));
      if (hadCfg === null) fs.unlinkSync(C9.CONFIG_PATH); else fs.writeFileSync(C9.CONFIG_PATH, hadCfg);
      if (prev === undefined) delete process.env.ARC_SPAWN_PROFILE; else process.env.ARC_SPAWN_PROFILE = prev;
      return fromCfg && envWins; })());

  // ---- --board: the ONE hole in the filesystem isolation ----------------------------------
  // Built for an observed pain, not a hypothetical: a session dogfooding arc in ANOTHER repo
  // learns things about arc that belong on arc's board, and the only channel was a human
  // copy-pasting between two windows a few times a week. Every assertion below guards a
  // restriction, because the restrictions are the design — the flag itself is three lines.
  const xrepo = fs.mkdtempSync(path.join(os.tmpdir(), 'xboard-'));
  fs.mkdirSync(path.join(xrepo, '.git'), { recursive: true });
  const XB = RM7.resolveBoard(xrepo);

  const cross = F8.requestNote(AS, `code --board ${xrepo} "your stop hook fires twice"`, drepo);
  ok('a note CROSSES to another repo\'s board when --board names it', cross.ok === true);
  ok('...and lands THERE, not here',
    RM7.allNotes(XB).some((n) => /fires twice/.test(n.body))
    && !RM7.allNotes(RM7.resolveBoard(drepo)).some((n) => /fires twice/.test(n.body)));
  // A stranger's `code` MUST NOT be indistinguishable from the reader's OWN `code`. Same class of
  // bug as a recycled pid wearing a peer's name — this file learned that one the hard way.
  ok('...QUALIFIED as <board>/<role>, so a stranger cannot wear the reader\'s own role name',
    RM7.allNotes(XB).some((n) => n.from === `${path.basename(RM7.resolveBoard(drepo).root)}/android`));
  ok('...and the confirmation names the board it ACTUALLY landed on, and says one-way',
    new RegExp(`on the "${XB.name}" board`).test(cross.message) && /CROSS-BOARD/.test(cross.message));

  // THE RESTRICTIONS. A cross-board request would owe an answer that has no channel home — the
  // unanswerable-request bug, except the sender cannot even retract it from over there.
  const xreq = F8.requestNote(AS, `code --board ${xrepo} --kind request "can you check X?"`, drepo);
  ok('a cross-board REQUEST is refused (they could never deliver the answer)',
    xreq.ok === false && /cannot be --kind request/.test(xreq.message));
  // A seq is a LINE NUMBER in one ledger: #1 names a different note on each side.
  const xrep = F8.requestNote(AS, `code --board ${xrepo} --reply-to 1 "re: that"`, drepo);
  ok('...and --reply-to/--supersedes are refused (a seq means a different note on each board)',
    xrep.ok === false && /do not cross boards/.test(xrep.message));
  const xself = F8.requestNote(AS, `research --board ${drepo} "pointless"`, drepo);
  ok('...and --board at your OWN board is refused rather than silently posting locally',
    xself.ok === false && /points at THIS board/.test(xself.message));
  const nonrepo = fs.mkdtempSync(path.join(os.tmpdir(), 'xnorepo-'));
  const xbad = F8.requestNote(AS, `code --board ${nonrepo} "nowhere"`, drepo);
  ok('...and a target that is not a git repo has no board to post to',
    xbad.ok === false && /not a git repository/.test(xbad.message));
  // The offer to `arc delegate` is not actionable across a boundary — do not print advice the
  // reader cannot follow on a board that is not theirs to staff.
  ok('...an empty chair THERE says the note keeps, and does NOT offer to staff their board',
    /NOBODY HOLDS "code" on/.test(cross.message) && !/arc delegate code/.test(cross.message));

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
  // The live row's lead glyph is the peer's STANCE (statusline alphabet: ○◐●), with the
  // word beside it — the old presence-dot alphabet collided with the stance dial and a
  // human read "● research" as ACTIVE while research sat in balanced (2026-07-18).
  ok('`arc role` renders the roster with the stance glyph + live/closed state and the owns: summary',
    /roster:/.test(q.message) && /◐ research/.test(q.message) && /live · balanced/.test(q.message)
    && /investigation and docs/.test(q.message));

  // The Stop hook must not tell you to wait for an answer that cannot come.
  const un = F8.unarmedRequests(AS, drepo);
  ok('unarmedRequests marks whether each target is actually live (arming a dead chair is futile)',
    un.notes.length > 0 && un.notes.every((n) => 'toLive' in n));

  // ---- ONE CANONICAL TEMPLATE — the drift source was three copies (two live + one dead) ---------
  // template() used to be exported-but-uncalled while the switch-hook write-branch and requestRole
  // each hard-coded their own copy of the owns/send-me/not-me shape, already worded differently.
  // Now both render templateInstruction(); template() is the canonical file shape. Assert the two
  // renderers agree on the KEYS (the machine-read contract), so they cannot drift apart again.
  const KEYS = ['owns:', 'send me:', 'not me:', 'paths:'];
  const tmpl = D.template('demo');
  ok('template() is the canonical charter shape — all four keys, header, in order',
    KEYS.every((k) => tmpl.includes(k)) && tmpl.startsWith('# demo\n')
    && tmpl.indexOf('owns:') < tmpl.indexOf('send me:') && tmpl.indexOf('not me:') < tmpl.indexOf('paths:'));
  const inst = D.templateInstruction('demo', '    ');
  ok('templateInstruction renders the SAME four keys, indented — one source, so the two sites cannot drift',
    KEYS.every((k) => inst.includes('    ' + k)));
  // The write-branch (switch-hook) and the CLI echo (requestRole) must both go THROUGH it — grep
  // the source so a future hard-coded copy re-introducing drift fails here.
  const swSrc = fs.readFileSync(path.join(SRC, 'arc-switch-hook.js'), 'utf8');
  const ntSrc = fs.readFileSync(path.join(SRC, 'arc-notes.js'), 'utf8');
  ok('both emission sites call templateInstruction — neither hard-codes the shape any more',
    /templateInstruction\(/.test(swSrc) && /templateInstruction\(/.test(ntSrc)
    && !/owns: <what is yours in this repo>/.test(swSrc));   // the old hard-coded line is gone

  // ---- paths: is machine-read and TOLERANT (owns:-grade, plus leading indent + bold value) -----
  // paths: scopes the revive freshness brief. Its regex used to be strict (^paths:, no bold, no
  // indent) and NO real role declared one, so scoping never fired. Now it tolerates what owns: does
  // AND leading whitespace AND a bold-close before the value (or the `**` leaks in as a junk glob).
  const prepo = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-'));
  const pg = (a) => spawnSync('git', ['-C', prepo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
  pg(['init', '-qb', 'main']);
  fs.mkdirSync(path.join(prepo, '.arc', 'roles'), { recursive: true });
  fs.writeFileSync(path.join(prepo, '.arc', 'roles', 'scoped.md'), '# scoped\n\nowns: the foo area\n**paths:** src/foo/**\n');
  const pbd = RM7.resolveBoard(prepo); RM7.ensureBoard(pbd);
  const lastSat = Date.now() - 3600000;
  fs.writeFileSync(path.join(prepo, 'outside.txt'), '1'); pg(['add', '-A']); pg(['commit', '-qm', 'OUTSIDE the scope']);
  fs.mkdirSync(path.join(prepo, 'src', 'foo'), { recursive: true });
  fs.writeFileSync(path.join(prepo, 'src', 'foo', 'a'), '1'); pg(['add', '-A']); pg(['commit', '-qm', 'INSIDE the scope']);
  const pbrief = I.freshnessBrief(pbd, 'scoped', lastSat);
  ok('a **paths:** line (bold label) scopes the brief to its globs — no leaked ** junk pathspec',
    !!pbrief && /INSIDE the scope/.test(pbrief.body) && !/OUTSIDE the scope/.test(pbrief.body));
  fs.rmSync(prepo, { recursive: true, force: true });

  fs.rmSync(drepo, { recursive: true, force: true });
  for (const s of [AS, BS]) for (const f of [`arc-state-${s}.json`, `arc-role-${s}.json`]) {
    try { fs.unlinkSync(path.join(CLAUDE, 'cache', f)); } catch {}
  }
} catch (e) { ok('duty roster', false, e.message + '\n' + (e.stack || '')); }

// ---- peer identity: a fork believes it is the session it was forked FROM -------------
// Staffing a NEW peer forks the caller's conversation into it, so it inherits a transcript in
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
      input: JSON.stringify({ prompt: `/arc-role ${role}`, cwd: irepo }), encoding: 'utf8',
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
  // audit #198: the role-claim STEPS (stand by, STOP) are arc's protocol, not the human's. An agent
  // that relays them as "you told me to stand by" tells the human they ordered something they never
  // did — the exact misattribution that happened live. The frame forbidding it must ride every claim.
  ok('the role-claim guidance frames its steps as ARC speaking, not the human (no misattribution)',
    /ARC's protocol, not your human/i.test(nctx) && /never relay them back as the human's order/i.test(nctx));

  // The standing rule, on the channel every woken peer actually reads: the injection.
  const notesSrc2 = fs.readFileSync(path.join(SRC, 'arc-notes.js'), 'utf8');
  ok('the note injection teaches ANSWER WHERE YOU WERE ASKED (the deliverable is the reply note)',
    /ANSWER WHERE YOU WERE ASKED/.test(notesSrc2) && /--reply-to/.test(notesSrc2)
    && /decide something a PEER asked YOU to decide/.test(notesSrc2));

  // And in the protocol doc, so it survives beyond the birth turn.
  const skill2 = fs.readFileSync(path.join(ROOT, 'skills', 'peers', 'SKILL.md'), 'utf8');
  // A FIX NOBODY CAN FIND IS NOT A FIX. --body-file exists because arc.cmd is `node ... %*` and
  // cmd.exe ends the argument list at a NEWLINE, so a multi-line body is cut before arc runs
  // (whalephone #129: a 4,407-char review stored as 536). But agents learn `arc note` from THIS
  // file, not from NOTE_USAGE — and it taught the inline form for `--kind request "<packet>"`,
  // which is precisely the long note that gets eaten. Shipping the flag while the manual still
  // pointed at the hazard would have left the bug fully live for every agent that reads this.
  ok('the peers skill teaches --body-file for multi-line bodies, where an agent will actually meet it',
    /--body-file/.test(skill2) && /more than one line/i.test(skill2)
    && /cmd\.exe ends\s*\n?the argument list at a newline/i.test(skill2.replace(/\*\*/g, ''))
    && /chars stored/.test(skill2));
  ok('the peers skill states who you serve, and what a FORKED peer must not assume',
    /WHO YOU SERVE/.test(skill2) && /Answer where you were asked/i.test(skill2)
    && /FORKED/.test(skill2) && /did not do the work you can see above/i.test(skill2));
  // A note lost to a phantom role: a session dogfooding arc in ANOTHER repo needed to reach this
  // board's `research`, but the skill only modeled same-repo peers — so it JOINED here as a new
  // `inquiry` role and posted from there; the role was removed and the reply orphaned. The `--board`
  // tunnel existed the whole time but was UNTAUGHT. The teaching AND its anti-pattern (don't join a
  // board that isn't yours just to leave a note) must stay, or the next cross-repo session repeats it.
  const s2 = skill2.replace(/[`*]/g, '');
  ok('the peers skill teaches the --board cross-repo tunnel AND forbids joining another board just to leave a note',
    /arc note \w+ --board/.test(s2) && /different repo/i.test(s2)
    && /Never arc join or claim a role/i.test(s2) && /orphaned/i.test(s2)
    && /one-way/i.test(s2) && /--kind request .{0,30}refused/i.test(s2));
  // Staffing fills a chair two OPPOSITE ways, and the identity warning is only true for one of
  // them. A REVIVED peer resumed its OWN conversation — telling it "the history above is not
  // yours" would make it disown its own memory, which is the exact context that made reviving
  // worth building. So the doc must sort the reader before it warns them.
  ok('...and it makes a REVIVED peer sort itself out FIRST (that history really is its own)',
    /REVIVED/.test(skill2) && /this section is\s+not about you/i.test(skill2));

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
  const okInv = I5.staffRole(FS_, 'grandchild', {
    spawn: (b, a) => { spawnedFork = a; return { status: 0 }; }, hasWt: true,
    ensureTrusted: () => ({ ok: true, already: true }), hasTranscript: () => false,
  });
  ok('...so a STAFFED peer can staff another in turn (a peer tree, not a one-level star)',
    okInv.ok === true);
  // AND THE TREE INHERITS ALONG ITS REAL EDGES: the grandchild forks the conversation of the peer
  // that actually staffed it, not of whoever started the session graph. That id is only knowable
  // from the BRIDGE — this staffer is a live fork, so its own state file still says convId:null,
  // and trusting that would fork nothing and silently birth a cold grandchild while the context it
  // needed sat on disk unread. (The same null-state/live-bridge split the scout peer found.)
  ok('...forking the conversation of the peer that staffed it (via the bridge), so context follows the tree',
    spawnedFork.join(' ').includes('-Resume fork-conv-9999')
    && spawnedFork.join(' ').includes('-Fork'));

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
      RM5.claimRole(fboard, 'other', DEAD_PID, 'someone-else', null);   // a dead pid = not ours
      F5.healClaimConv(FS_, frepo);
      return RM5.roleClaim(fboard, 'other') === null;                 // still vacant, untouched
    })());

  // THE ONE THAT DESTROYED A CONVERSATION. `--fork-session` must NEVER survive into a relaunch:
  // on switch/restart the runner rebuilds args and re-adds --resume, so a surviving --fork-session
  // means claude resumes the peer's conversation and immediately BRANCHES it into a new one —
  // abandoning everything the peer built. The user hit this the first time an invited peer ran out
  // of tokens and switched accounts, which is precisely when its history mattered most.
  // The revive prompt is `/arc-role` (it travels programmatically, which bypasses the
  // typed-command gate — measured); the strip must eat BOTH the live and legacy spellings.
  const born = ['--account', 'whale', '--name', 'scout', '--resume', 'caller-conv', '--fork-session', '/arc-role scout'];
  const relaunch = RUN.stripConvArgs(born);
  ok('a relaunch NEVER re-forks: --fork-session is stripped (this is what ate a conversation)',
    !relaunch.includes('--fork-session'));
  ok('...and the birth prompt is not replayed forever (role re-adopts, listener re-arms on idle)',
    !relaunch.some((a) => /^arc:/i.test(a) || /^\/arc-/i.test(a)));
  ok('...and the LEGACY colon spelling still strips (old argv, mixed-version respawns)',
    !RUN.stripConvArgs(['--name', 'scout', 'arc:role scout']).some((a) => /^arc:/i.test(a)));
  // ...but it MUST survive the launch that creates the peer. This guard used to run
  // unconditionally, which was safe only because staffing passed an explicit --resume (that takes
  // the userManagesConv path, which strips nothing). The moment a peer was BORN instead of forked,
  // the strip ran on the FIRST launch and ate the one instruction the newborn exists to receive:
  // the tab opened, titled itself `arc: research`, claimed NO role, and sat idle forever.
  // Once = birth. Twice = a prompt loop. The difference is `respawning`, not the args.
  ok('...but the BIRTH launch KEEPS it — stripping it there opens a tab that claims nothing',
    RUN.stripConvArgs(born, { keepPrompt: true }).some((a) => /^\/arc-role scout$/i.test(a)));
  ok('...while still dropping --fork-session/--continue on birth (only the prompt is spared)',
    !RUN.stripConvArgs(born, { keepPrompt: true }).includes('--fork-session'));
  ok('...while the real flags survive untouched',
    relaunch.includes('--account') && relaunch.includes('whale') && !relaunch.includes('caller-conv'));
  // A peer that loses its NAME on a switch is back to being another "arc" in the picker — and a
  // switch is exactly when you go looking for it. It survives because stripConvArgs removes only
  // what it names; this pins that, since the strip list is where a careless `continue` would land.
  ok('...including --name, so a switched/restarted peer stays findable in the picker',
    relaunch.includes('--name') && relaunch.includes('scout'));

  // RE-ARM ON RESPAWN (roadmap #3): a /restart|/switch re-execs and leaves a reachable peer deaf
  // until its next turn (a restart-then-walk-away takes none). arc cannot self-arm, so on a respawn
  // it injects the revive's own `/arc-role <role>` — but ONLY if the session WAS armed (a surviving
  // await marker), so a never-armed session is never forced to spend a turn. THE LIVE TEST'S LESSON
  // (2026-07-18): a restart does NOT kill the listener — it spawnSyncs the new runner so the OLD
  // runner stays alive as its parent, and the listener's owner-check keys on that runner, so the old
  // listener LINGERS as an ORPHAN with a LIVE marker. That orphan can wake nobody (its claude is
  // dead), so ANY pre-respawn marker is stale: re-arm AND clear it (else the hook's armNeeded reads
  // the orphan as "already listening" and refuses to arm — the exact deafness this closes).
  {
    const A5 = require(path.join(SRC, 'arc-await.js'));
    const RS = 'rearm-sess-' + process.pid;
    fs.writeFileSync(path.join(cache, `arc-state-${RS}.json`), JSON.stringify({ pid: process.pid, cwd: frepo, convId: 'rearm-conv' }));
    F5.requestRole(RS, 'rearmer', frepo);       // a role of its own (scout is held by the fixture's live session)
    const opts = { respawning: true, convId: 'rearm-conv', userManagesConv: false, cwd: frepo };
    A5.clearWaiting(RS);
    ok('re-arm: a NEVER-armed role-holder is NOT forced to arm on respawn (no marker = pays nothing)',
      RUN.reArmPromptOnRespawn(RS, opts) === null);
    fs.writeFileSync(A5.awaitFile(RS), JSON.stringify({ pid: DEAD_PID, role: 'rearmer', at: Date.now() }));
    ok('re-arm: a KILLED listener (dead-pid marker) re-arms AND the stale marker is cleared',
      RUN.reArmPromptOnRespawn(RS, opts) === '/arc-role rearmer' && !fs.existsSync(A5.awaitFile(RS)));
    // THE ORPHAN CASE the live test found: a marker whose pid is ALIVE is STILL stale after a
    // respawn (the lingering old listener wakes nobody). It must re-arm and clear, not be trusted.
    A5.markWaiting(RS, 'rearmer', process.pid);   // a LIVE-pid marker == the orphaned old listener
    ok('re-arm: a LIVE orphan marker STILL re-arms and is cleared (a restart orphans, not kills)',
      RUN.reArmPromptOnRespawn(RS, opts) === '/arc-role rearmer' && !fs.existsSync(A5.awaitFile(RS)));
    // guards decline WITHOUT clearing the marker (a non-respawn / user-managed launch touches nothing).
    fs.writeFileSync(A5.awaitFile(RS), JSON.stringify({ pid: DEAD_PID, role: 'rearmer', at: Date.now() }));
    ok('re-arm: NOT on a fresh launch, and the marker is left intact (no listener to restore)',
      RUN.reArmPromptOnRespawn(RS, { ...opts, respawning: false }) === null && fs.existsSync(A5.awaitFile(RS)));
    ok('re-arm: NOT on a user-managed resume — that path passes args through untouched',
      RUN.reArmPromptOnRespawn(RS, { ...opts, userManagesConv: true }) === null && fs.existsSync(A5.awaitFile(RS)));
    A5.clearWaiting(RS);
    try { fs.unlinkSync(path.join(cache, `arc-state-${RS}.json`)); } catch {}
    try { fs.unlinkSync(path.join(cache, `arc-role-${RS}.json`)); } catch {}
  }

  // Every in-runner SAME-CONVERSATION relaunch must schedule re-arm centrally (audit #271 H1). This
  // is a behavioral table over the exported predicate, not a source scan: each of the six same-chat
  // reasons re-arms; restart (child re-exec reads the marker), delete (fresh chat), and a normal exit
  // do not. reArmPromptOnRespawn itself (role/marker/user-managed guards) is exercised above.
  // delete IS a re-arm reason (audit #289 blocker 1): it starts a fresh conversation but the SAME
  // session reasserts its role, so it would otherwise relaunch DEAF. Only restart is excluded (its
  // re-exec'd child computes re-arm from the surviving marker).
  for (const reason of ['addaccount', 'pick', 'mode', 'rename', 'switch', 'effort', 'delete']) {
    ok(`re-arm: a ${reason} relaunch leaves this session a reachable role-holder and re-arms the listener`,
      RUN.reArmsAfterReason(reason) === true);
  }
  for (const reason of ['restart', 'exit', undefined, 'nonsense']) {
    ok(`re-arm: a ${reason} relaunch does NOT re-arm (re-exec child handles it / no relaunch)`,
      RUN.reArmsAfterReason(reason) === false);
  }
  {
    // The birth prompt is kept ONLY on a newborn's genuine first launch, so an in-runner switch
    // strips it and the re-arm is the SOLE `/arc-role` positional (audit #265, claim 2 — closes the
    // untested two-positional edge at its source). A future edit that reverts the strip condition to
    // bare `respawning ?` re-manufactures the duplicate; assert the convStarted OR stays.
    const rs = fs.readFileSync(path.join(SRC, 'arc-runner.js'), 'utf8');
    ok('re-arm: the birth prompt is stripped on any non-first launch (respawning OR convStarted OR pendingReArm)',
      /const a = \(respawning \|\| convStarted \|\| pendingReArm\) \? stripConvArgs\(passArgs\) : stripConvArgs\(passArgs, \{ keepPrompt: true \}\)/.test(rs));
  }

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

  A6.markOffered(DS);          // arc asked it to arm — but JUST now: that is the ordinary arming window
  ok('...a FRESH offer is NOT deaf (arming window, not a squat) — so no DEAF flash every single turn',
    !(F6.badge(DS, drepo) || {}).deaf);
  // Backdate the offer past the stale threshold: offered long ago, still never armed = a real squat.
  fs.writeFileSync(A6.offerFile(DS), JSON.stringify({ at: Date.now() - 120000 }));
  ok('...but a STALE offer that never armed IS DEAF (the rate-limit squat), persistence-gated',
    (F6.badge(DS, drepo) || {}).deaf === true);

  A6.markWaiting(DS, 'code', process.pid);   // ...and complying clears it
  ok('...and arming clears the warning immediately (a live listener is never deaf)',
    !(F6.badge(DS, drepo) || {}).deaf);

  // THE INTERRUPT CASE (audit #200, research #196): a turn ended by Esc/tool-denial fires NO Stop
  // hook, so no offer is ever made — the OLD wasOffered check missed this entirely, and it is what
  // left audit deaf while the badge stayed silent. Caught now by an unread note SITTING past the
  // threshold with no listener.
  A6.clearWaiting(DS); A6.clearOffered(DS);
  RM6.appendNote(dboard2, { from: 'peer', to: 'code', kind: 'info', body: 'you there?' });
  ok('a FRESH unread note with no listener is NOT yet deaf (could be mid-arm)',
    !(F6.badge(DS, drepo) || {}).deaf);
  const dnp = RM6.notesPath(dboard2);
  (() => { const ls = fs.readFileSync(dnp, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); ls[ls.length - 1].ts = new Date(Date.now() - 120000).toISOString(); fs.writeFileSync(dnp, ls.map((l) => JSON.stringify(l)).join('\n') + '\n'); })();
  ok('...but an OLD unread note with no listener (INTERRUPT case, no offer ever made) IS DEAF',
    (F6.badge(DS, drepo) || {}).deaf === true);
  A6.clearWaiting(DS); A6.clearOffered(DS); RM6.markRead(dboard2, 'code');

  // audit #204 Q3: a single note with a malformed ts must not blind the age check (NaN via Math.min
  // would have SUPPRESSED deaf even with a genuinely-old note sitting right beside it).
  RM6.appendNote(dboard2, { from: 'peer', to: 'code', kind: 'info', body: 'good old' });
  RM6.appendNote(dboard2, { from: 'peer', to: 'code', kind: 'info', body: 'bad ts' });
  (() => { const ls = fs.readFileSync(dnp, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ls[ls.length - 2].ts = new Date(Date.now() - 120000).toISOString();   // the good note: genuinely OLD
    ls[ls.length - 1].ts = 'not-a-date';                                   // the poison note
    fs.writeFileSync(dnp, ls.map((l) => JSON.stringify(l)).join('\n') + '\n'); })();
  ok('a bad-ts note does NOT blind the age check — the old note beside it still reads DEAF (Q3)',
    (F6.badge(DS, drepo) || {}).deaf === true);
  A6.clearWaiting(DS); A6.clearOffered(DS); RM6.markRead(dboard2, 'code');

  // THE HEARTBEAT GATE (roadmap #5): stale unread alone cannot separate idle-and-deaf from
  // busy-mid-long-turn. A session whose TRANSCRIPT is still growing is mid-turn — the Stop hook
  // will deliver at turn-end, so badging it is the alarm fatigue the roadmap recorded ("DEAF
  // fires during normal long turns"). Note: every deaf assert ABOVE ran with NO transcript on
  // disk — quiet-forever — which is itself the proof that an unresolvable beat stays fail-visible
  // (the exact pre-heartbeat behavior). Now give the session a transcript and watch the beat gate.
  const dproj = path.join(CLAUDE, 'projects', 'E--deaf-beat');
  fs.mkdirSync(dproj, { recursive: true });
  const dtx = path.join(dproj, 'dc1.jsonl');            // the state file above declared convId: dc1
  fs.writeFileSync(dtx, '{"type":"assistant"}\n');      // fresh mtime = the turn is beating NOW
  RM6.appendNote(dboard2, { from: 'peer', to: 'code', kind: 'info', body: 'still there?' });
  (() => { const ls = fs.readFileSync(dnp, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); ls[ls.length - 1].ts = new Date(Date.now() - 120000).toISOString(); fs.writeFileSync(dnp, ls.map((l) => JSON.stringify(l)).join('\n') + '\n'); })();
  ok('an OLD unread note while the transcript is BEATING is NOT deaf (busy ≠ deaf — the wolf-cry)',
    !(F6.badge(DS, drepo) || {}).deaf);
  // The turn ends or is INTERRUPTED: no hook fires, no flag needs clearing — the transcript
  // simply stops growing, and the evidence itself goes stale. That is the whole reason this is
  // a timestamp and not a turn-start/turn-end flag (the a9b682c interrupt bug, mirror-imaged).
  const dold = new Date(Date.now() - 120000);
  fs.utimesSync(dtx, dold, dold);
  ok('...and once the transcript goes QUIET past the threshold, the same note IS deaf (idle-and-deaf)',
    (F6.badge(DS, drepo) || {}).deaf === true);
  // The same beat gates the SQUAT arm (stale offer), symmetrically.
  fs.writeFileSync(dtx, '{"type":"assistant"}\n{"type":"human"}\n');   // beating again
  fs.writeFileSync(A6.offerFile(DS), JSON.stringify({ at: Date.now() - 120000 }));
  ok('...a STALE offer under a beating transcript is not a squat — the session is WORKING on something',
    !(F6.badge(DS, drepo) || {}).deaf);
  fs.utimesSync(dtx, dold, dold);
  ok('...and quiet again = the squat resurfaces (the heartbeat DEFERS the badge, never buries it)',
    (F6.badge(DS, drepo) || {}).deaf === true);
  fs.rmSync(dproj, { recursive: true, force: true });
  A6.clearWaiting(DS); A6.clearOffered(DS); RM6.markRead(dboard2, 'code');

  // The statusline must actually SHOW it — a fact nobody surfaces is a fact nobody has.
  const um = fs.readFileSync(path.join(SRC, 'usage-monitor.js'), 'utf8');
  ok('the statusline renders DEAF loudly',
    /f\.deaf \?/.test(um) && /DEAF/.test(um));
  // And it must NOT tell the USER to run `arc join` — a listener started outside the session
  // cannot wake it (only a background command the SESSION launched re-invokes the agent), so it
  // would look fixed while staying deaf. Only the agent can arm.
  ok('...without telling the user to run a listener that could never wake the session',
    !/DEAF[^`]*run: arc join/.test(um));

  // THE DIAL MUST NOT LIE ABOUT WHICH WAY IT POINTS. The statusline's fallback hardcoded
  // 'passive' — correct back when passive WAS the default, and quietly wrong ever since it moved
  // to balanced: a statusline that couldn't read the stance reported the user RESTRICTED while
  // the agent ran balanced. Pin it to the source of truth so the two cannot drift apart again.
  const St5 = require(path.join(SRC, 'arc-stance.js'));
  ok('the statusline falls back to arc-stance.DEFAULT, never a hardcoded guess',
    /let stance = require\('\.\/arc-stance'\)\.DEFAULT/.test(um)
    && !/let stance = '(passive|balanced|active)'/.test(um));
  ok('...and every stance renders a visible segment (the dial stays discoverable)',
    St5.STANCES.every((s) => {
      const seg = um.match(new RegExp(`stance === '${s}'\\) return '[^']+'`)) || (s === 'passive');
      return !!seg;
    }));

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

// ---- the stance GATE: /arc-mode drives whether an agent may spawn a peer -----------
// Everything else the stance governs is a model-level STEER (injected advice), which is right
// for a note: cheap, reversible, and "was this the user's order?" is a judgment only the model
// can make. STAFFING is different in kind — it spawns a REAL SESSION (window, process, its own
// quota), and injected text cannot actually STOP an agent from running a command. So that one
// step rides a PreToolUse hook and becomes enforceable: passive DENIES, balanced ASKS, active
// ALLOWS.
//
// `arc delegate` carries BOTH costs under one verb, so the gate cannot judge the command string
// alone — it must look up whether the role is LIVE. A live peer means this is only a note, and
// gating the commonest thing an agent does would be pure noise; an empty chair means a session
// gets born, and that is the moment the dial has to mean something.
//
// And it binds the HUMAN too, unlike the rest of the stance: a PreToolUse hook sees a tool call
// and cannot tell the user's order from the agent's own idea. A prompt-command escape hatch
// (a prompt is provably yours) was removed on purpose — a human's natural act is prose, not a
// command. So passive costs you the spawn whoever wanted it.
// ── arc alarm: the board-wide fire alarm — a broadcast that INTERRUPTS busy peers ──────────────
// Raised by `arc alarm "<msg>"`: it broadcasts a note (wakes idle peers) AND writes a flag the
// pretool hook reads on every tool call, denying a BUSY peer's next tool call so it must read the
// alarm before proceeding. The design review (audit #332) required: block-once per (session,alarm),
// FAIL-OPEN on ack-write failure, DEBOUNCE raises, CAP+frame the untrusted body, and the raiser
// auto-acks. This exercises all of them against a real spawned hook.
section('arc alarm (broadcast + busy-peer interrupt at the next tool boundary)');
try {
  const AL = require(path.join(SRC, 'arc-alarm.js'));
  const RMa = require(path.join(SRC, 'arc-board.js'));
  const Fa = require(path.join(SRC, 'arc-notes.js'));
  const HOOKPa = path.join(SRC, 'arc-pretool-hook.js');

  const arepo = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-'));
  spawnSync('git', ['init', '-q'], { cwd: arepo });
  const aboard = RMa.resolveBoard(arepo); RMa.ensureBoard(aboard);
  const RAISER = 'alarm-raiser-' + process.pid;
  const BUSY = 'alarm-busy-' + process.pid;
  for (const s of [RAISER, BUSY]) fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${s}.json`),
    JSON.stringify({ pid: process.pid, cwd: arepo, convId: 'ac1' }));
  Fa.requestRole(RAISER, 'code', arepo);
  Fa.requestRole(BUSY, 'audit', arepo);

  // the pretool gate, driven exactly as the /arc-mode gate test below drives it
  const armgate = (command, session) => {
    const r = spawnSync(process.execPath, [HOOKPa], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: arepo }),
      encoding: 'utf8', env: { ...process.env, ARC_SESSION: session },
    });
    if (!r.stdout || !r.stdout.trim()) return { decision: null };
    try { const j = JSON.parse(r.stdout); return { decision: j.hookSpecificOutput.permissionDecision, reason: j.hookSpecificOutput.permissionDecisionReason, sys: j.systemMessage }; }
    catch { return { decision: 'PARSE-ERROR', raw: r.stdout }; }
  };

  // RAISE: writes the flag, broadcasts a note, and the raiser auto-acks (never blocks on its own).
  const notesBefore = RMa.allNotes(aboard).length;
  const raised = AL.raise(RAISER, 'STOP — the config schema changed, do not build on the old one', arepo);
  ok('raise writes the flag AND broadcasts a note (so idle peers wake, busy peers get interrupted)',
    raised.ok === true && !!raised.id && !!AL.readFlag(aboard)
    && RMa.allNotes(aboard).length === notesBefore + 1
    && /ALARM: STOP/.test(RMa.allNotes(aboard).slice(-1)[0].body));
  ok('the raiser auto-acks — it does NOT block on its own alarm',
    AL.checkAndAck(RAISER, aboard) === null);
  ok('badge() shows the ACTIVE alarm to a session that has NOT taken it up yet',
    /^ALARM: STOP/.test(AL.badge(aboard, BUSY)));
  ok('...and DISSOLVES for a session that HAS acked it — the raiser auto-acked, so its bar shows "on it"',
    AL.badge(aboard, RAISER) === '' && /^ALARM: STOP/.test(AL.badge(aboard)));   // no-session viewer still sees it

  // BUSY peer: interrupted ONCE at its next tool call, then never again for the same alarm.
  const first = armgate('ls -la', BUSY);
  ok('a BUSY peer is DENIED at its next tool call, the body framed as UNTRUSTED (not an instruction)',
    first.decision === 'deny' && /ALARM/i.test(first.reason || '')
    && /UNTRUSTED/i.test(first.sys || '') && /schema changed/.test(first.sys || '')
    && /NOT an instruction/i.test(first.sys || ''));
  ok('...BLOCK-ONCE: the very next tool call RUNS (the ack suppresses a re-block, no storm)',
    armgate('ls -la', BUSY).decision === null);
  ok('...`arc alarm` itself is EXEMPT so a peer can always raise/clear (no clear-deadlock)',
    armgate('arc alarm --clear', RAISER).decision === null);

  // DEBOUNCE: a second raise inside the window coalesces — no per-id block storm.
  const dbl = AL.raise(RAISER, 'a second, rapid alarm', arepo);
  ok('a rapid second raise COALESCES (debounce) — one alarm, not a board-wide storm',
    dbl.ok === false && dbl.coalesced === true && AL.readFlag(aboard).id === raised.id);

  // BODY CAP: the injected body is capped at the source (untrusted, force-fed into context).
  AL.clear(arepo);
  const big = AL.raise(RAISER, 'x'.repeat(1000), arepo);
  ok('the alarm body is CAPPED (a broadcast prompt-injection surface must be bounded)',
    big.ok === true && AL.readFlag(aboard).body.length <= AL.BODY_CAP);

  // STALE / TTL: an alarm older than the TTL no longer interrupts.
  const flag = JSON.parse(fs.readFileSync(AL.flagPath(aboard), 'utf8'));
  flag.at = Date.now() - AL.TTL_MS - 1000;
  fs.writeFileSync(AL.flagPath(aboard), JSON.stringify(flag));
  ok('a STALE alarm (past its TTL) no longer interrupts — readFlag and the gate fall through',
    AL.readFlag(aboard) === null && armgate('ls', 'alarm-fresh-' + process.pid).decision === null);

  // FAIL-OPEN: if the ack cannot be written, the gate lets the tool RUN (never block-forever).
  AL.clear(arepo);
  AL.raise(RAISER, 'fresh alarm for the fail-open probe', arepo);
  ok('an ack-write FAILURE fails OPEN — a session whose ack cannot persist is NOT wedged',
    AL.stampAck('bad<>:name', 'x') === false
    && AL.checkAndAck('bad<>:name', aboard) === null
    && AL.readFlag(aboard) !== null);   // the flag stays live for peers who CAN ack

  // CLEAR: removes the flag; the gate falls through again for everyone.
  AL.clear(arepo);
  ok('clear removes the flag — the gate falls through for everyone, and the status-bar badge clears',
    AL.readFlag(aboard) === null && armgate('ls', BUSY).decision === null && AL.badge(aboard) === '');

  // IDLE-PEER WAKE: an alarm broadcasts a note, so a CAUGHT-UP (idle) peer's listener wake-condition
  // — arc-await's check(), which fires on unreadFor > 0 — goes true. The idle session wakes and
  // absorbs the alarm like any note (the note channel; the flag is the ADDITION for busy peers).
  // Proven live with a real listener process; locked here so it can't silently regress.
  const IDLE = 'alarm-idle-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${IDLE}.json`),
    JSON.stringify({ pid: process.pid, cwd: arepo, convId: 'ac1' }));
  Fa.requestRole(IDLE, 'idler', arepo);
  RMa.markRead(aboard, 'idler');                       // catch the idle peer up: 0 unread
  const idleBefore = RMa.unreadFor(aboard, 'idler').count;
  AL.raise(RAISER, 'wake the idle peer', arepo);
  ok('an alarm wakes an IDLE peer too — a caught-up listener\'s wake-condition (unread>0) goes true',
    idleBefore === 0 && RMa.unreadFor(aboard, 'idler').count >= 1
    && /ALARM: wake the idle peer/.test(RMa.unreadFor(aboard, 'idler').notes.slice(-1)[0].body));
  AL.clear(arepo);
  try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-state-${IDLE}.json`)); } catch {}
  try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-alarmack-${IDLE}.json`)); } catch {}

  // DE-DUP (design review #332, claim 6): the alarm reaches a peer on TWO channels — the broadcast
  // note AND the pretool flag-gate. Whichever fires first stamps the shared ack; the other is
  // suppressed, so no peer sees the same alarm twice. Fresh board to isolate the channels cleanly.
  const drepo = fs.mkdtempSync(path.join(os.tmpdir(), 'alarmdd-'));
  spawnSync('git', ['init', '-q'], { cwd: drepo });
  const dboard = RMa.resolveBoard(drepo); RMa.ensureBoard(dboard);
  const DR = 'dd-raiser-' + process.pid, D1 = 'dd-note1st-' + process.pid, D2 = 'dd-flag1st-' + process.pid;
  for (const s of [DR, D1, D2]) fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${s}.json`),
    JSON.stringify({ pid: process.pid, cwd: drepo, convId: 'dc1' }));
  Fa.requestRole(DR, 'code', drepo); Fa.requestRole(D1, 'frontend', drepo); Fa.requestRole(D2, 'backend', drepo);

  const r1 = AL.raise(DR, 'schema changed — stop', drepo);
  // DIRECTION 1 (note first): the delivery SHOWS the alarm and stamps the ack -> the flag stays quiet.
  const injA = Fa.injection(D1, drepo);
  ok('de-dup, NOTE first: the note is shown and stamps the ack, so the flag-gate then stays quiet',
    !!injA && /ALARM: schema changed/.test(injA.text)
    && AL.readAck(D1) === r1.id && AL.checkAndAck(D1, dboard) === null);

  // DIRECTION 2 (flag first): the gate blocks (acks), then the note is SUPPRESSED from delivery and
  // the cursor advances so it never re-delivers. Here the alarm is the only unread note, so nothing
  // is injected at all — the peer got it via the block; a note delivery would be the double-show.
  const blocked = AL.checkAndAck(D2, dboard);
  const injB = Fa.injection(D2, drepo);
  ok('de-dup, FLAG first: the gate blocks, then the note is SUPPRESSED (no double-show, nothing injected)',
    !!blocked && AL.readAck(D2) === r1.id && injB === null);
  ok('...and the suppressed alarm never re-delivers — the cursor advanced past it',
    Fa.injection(D2, drepo) === null && AL.readFlag(dboard) !== null);

  for (const s of [DR, D1, D2]) {
    try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-alarmack-${s}.json`)); } catch {}
    try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-state-${s}.json`)); } catch {}
  }
  fs.rmSync(drepo, { recursive: true, force: true });

  for (const s of [RAISER, BUSY]) { try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-alarmack-${s}.json`)); } catch {} }
  fs.rmSync(arepo, { recursive: true, force: true });
} catch (e) { ok('arc alarm section ran without throwing', false, e.message); }

// ── arc feed: the read-only operator status feed (127.0.0.1) ────────────────────────────────────
// The human holds no role, so no board reader serves them. The feed answers "what are my agents
// doing, across every repo?" — snapshot() is a pure function of on-disk state (live arc-state files
// + the boards their cwds resolve to), so it is unit-tested here; the live SSE server is smoke-
// tested separately. Genuine liveness (isHolder), not a bare pid, or it shows recycled-pid ghosts.
section('arc feed (operator status snapshot + lifecycle)');
try {
  const F = require(path.join(SRC, 'arc-feed.js'));
  const RMf = require(path.join(SRC, 'arc-board.js'));
  const Ff = require(path.join(SRC, 'arc-notes.js'));

  const frepo = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-'));
  spawnSync('git', ['init', '-q'], { cwd: frepo });
  const fboard = RMf.resolveBoard(frepo); RMf.ensureBoard(fboard);
  const CODE = 'feed-code-' + process.pid, AUD = 'feed-aud-' + process.pid;
  for (const s of [CODE, AUD]) fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${s}.json`),
    JSON.stringify({ pid: process.pid, cwd: frepo, convId: 'fc1', account: 'sub' }));   // pid alive => live sessions
  // v5 DETAIL fixtures: a self-reported activity (its OWN file) + a docs/ROADMAP.md to parse.
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-status-${CODE}.json`), JSON.stringify({ activity: 'editing the feed', at: Date.now() }));
  fs.mkdirSync(path.join(frepo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(frepo, 'docs', 'ROADMAP.md'),
    '# roadmap\n\n## 1. First item — the gap here · **BIG** · picked up 2026-07-19\n\nBody. **Next move:** `code`.\n\n## 2. Second item — another gap · **SMALL**\n\nBody. **Owner of the next move:** `research`.\n\n## Parked elsewhere — pointers\n\n- not a numbered item.\n');
  Ff.requestRole(CODE, 'code', frepo); Ff.requestRole(AUD, 'audit', frepo);
  RMf.appendNote(fboard, { from: 'code', to: 'audit', kind: 'request', body: 'please verify X' });   // #1
  RMf.appendNote(fboard, { from: 'code', to: 'audit', kind: 'request', body: 'and Y' });              // #2 (stays open)
  RMf.appendNote(fboard, { from: 'audit', to: 'code', kind: 'result', body: 'DONE X', replyTo: 1 });  // #3 answers #1

  const snap = F.snapshot();
  const repo = (snap.repos || []).find((r) => r.root === fboard.root);
  ok('snapshot lists the repo with its genuinely-live role-holders',
    !!repo && repo.name === fboard.name && repo.roles.map((x) => x.role).sort().join(',') === 'audit,code');
  ok('...board summary carries the note count + last-activity timestamp',
    !!repo && repo.board.notes === 3 && !!repo.board.lastTs);
  ok('...the WAITING graph has code→audit for the STILL-OPEN request (#2), not the answered one (#1)',
    !!repo && repo.waiting.some((w) => w.from === 'code' && w.to === 'audit' && w.seq === 2)
    && !repo.waiting.some((w) => w.seq === 1));
  ok('...the COOPERATION graph has the reply edge audit→code (re #1)',
    !!repo && repo.cooperation.some((c) => c.from === 'audit' && c.to === 'code' && c.reSeq === 1));
  ok('...a live role carries its self-reported ACTIVITY (arc status → per-session working-on line)',
    !!repo && (repo.roles.find((x) => x.role === 'code') || {}).activity === 'editing the feed');
  ok('...each WAITING/COOPERATION edge carries the note TEXT (body) so a note is click-to-read',
    !!repo && (repo.waiting.find((w) => w.seq === 2) || {}).text === 'and Y'
    && (repo.cooperation.find((c) => c.reSeq === 1) || {}).text === 'DONE X');
  // v6 FLOW: the ledger, every kind — NOT the waiting list. The widget fed its "NOTE FLOW" section
  // from `waiting` (unanswered requests only), so a board with 3 notes and 1 open ask rendered a
  // single row and looked like the history had been lost. `flow` carries all three.
  ok('...the FLOW carries EVERY note kind, not just the unanswered ones (waiting shows 1, flow shows 3)',
    !!repo && repo.waiting.length === 1 && repo.flow.length === 3
    && repo.flow.map((n) => n.seq).join(',') === '1,2,3');
  ok('...each FLOW note carries from/to/text + an OPEN flag marking the one still awaiting an answer',
    !!repo && (repo.flow.find((n) => n.seq === 3) || {}).from === 'audit'
    && (repo.flow.find((n) => n.seq === 3) || {}).to === 'code'
    && (repo.flow.find((n) => n.seq === 3) || {}).text === 'DONE X'
    && (repo.flow.find((n) => n.seq === 2) || {}).open === true
    && (repo.flow.find((n) => n.seq === 1) || {}).open === false);

  // v6 ROSTER: the board's chairs, live AND closed. Membership is a CLAIM FILE — never an
  // appearance in a note. The graph drew a phantom `code` node on whalephone because a peer had
  // written a note ABOUT arc's `code`; that board has no claim-code.json and `code` never sat there.
  fs.writeFileSync(path.join(fboard.planDir, 'claim-gone.json'),
    JSON.stringify({ role: 'gone', pid: DEAD_PID, sessionId: 'gone-sess', convId: 'gc1', at: 7000 }));
  RMf.appendNote(fboard, { from: 'code', to: 'stranger', kind: 'info', body: 'a note NAMING a role that holds no chair here' });
  const rRepo = (F.snapshot().repos || []).find((r) => r.root === fboard.root);
  ok('...the ROSTER carries every chair, live AND closed (a closed chair is still a session here)',
    !!rRepo && rRepo.roster.map((c) => c.role).sort().join(',') === 'audit,code,gone'
    && (rRepo.roster.find((c) => c.role === 'gone') || {}).state === 'closed');
  ok('...but a role that only ever APPEARS IN A NOTE is not on the roster (the phantom-node bug)',
    !!rRepo && !rRepo.roster.some((c) => c.role === 'stranger'));
  try { fs.unlinkSync(path.join(fboard.planDir, 'claim-gone.json')); } catch {}

  // v6 PENDING: notes the recipient has NOT CONSUMED — the graph's arrows. Three rules, each of
  // which drew a false arrow on whalephone before it existed.
  {
    // audit is LIVE and has read nothing, so #2 (code->audit) is genuinely owed.
    const pRepo = (F.snapshot().repos || []).find((r) => r.root === fboard.root);
    ok('...PENDING carries a note whose recipient has not consumed it (the arrow that IS owed)',
      !!pRepo && pRepo.pending.some((p) => p.from === 'code' && p.to === 'audit' && p.seq === 2));

    // (1) a BROADCAST is in everyone's mailbox but is NOT a directed edge
    RMf.appendNote(fboard, { from: 'code', to: null, kind: 'info', body: 'ARC UPDATE — everyone' });
    const bRepo = (F.snapshot().repos || []).find((r) => r.root === fboard.root);
    ok('...a BROADCAST (to:null) is never a pending EDGE — it was aimed at nobody in particular',
      !!bRepo && !bRepo.pending.some((p) => /ARC UPDATE/.test(p.text || '')));

    // BLOCKER 1 (audit #235): the cap must run AFTER the broadcast filter, never before. Take the
    // last N unread and THEN drop broadcasts, and a chair whose N newest unread are announcements
    // reports ZERO owed notes while real asks sit behind them — this field's motivating bug,
    // inverted. Exercised with MORE than PENDING_PER_ROLE trailing broadcasts, which no earlier test
    // did: every other pending assertion runs on a ~4-note board where the slice is a no-op.
    RMf.appendNote(fboard, { from: 'audit', to: 'code', kind: 'request', body: 'THE BURIED ASK' });
    for (let i = 0; i < 20; i++) RMf.appendNote(fboard, { from: 'audit', to: null, kind: 'info', body: 'announcement ' + i });
    const capRepo = (F.snapshot().repos || []).find((r) => r.root === fboard.root);
    ok('...a directed note survives 20 TRAILING BROADCASTS — the cap filters first, then slices',
      !!capRepo && capRepo.pending.some((p) => p.to === 'code' && /THE BURIED ASK/.test(p.text || '')));
    ok('...and no broadcast is ever an edge, however many of them there are',
      !!capRepo && !capRepo.pending.some((p) => /announcement /.test(p.text || '')));

    // A cap that hides work must SAY so — a truncated backlog and a real one are otherwise identical.
    for (let i = 0; i < 15; i++) RMf.appendNote(fboard, { from: 'audit', to: 'code', kind: 'request', body: 'ask ' + i });
    const capRepo2 = (F.snapshot().repos || []).find((r) => r.root === fboard.root);
    const codePend = (capRepo2.pending || []).filter((p) => p.to === 'code');
    // derive the total rather than hardcode it — the fixture already held a directed note to `code`,
    // so a literal count here asserts my arithmetic instead of the invariant
    const directedTotal = RMf.unreadFor(fboard, 'code').notes.filter((n) => n.to != null).length;
    ok('...pending is CAPPED at PENDING_PER_ROLE and pendingMore reports exactly what it hid',
      codePend.length === 12 && directedTotal > 12
      && capRepo2.pendingMore.code === directedTotal - 12);
    ok('...every pending note ships seen:false explicitly (unconsumed IS unseen — no inferred key)',
      codePend.every((p) => p.seen === false));

    // (2) a CLOSED chair can never consume, so what it owes is a dead letter, not a live arrow
    fs.writeFileSync(path.join(fboard.planDir, 'claim-ghost2.json'),
      JSON.stringify({ role: 'ghost2', pid: DEAD_PID, sessionId: 'g2-sess', convId: 'g2', at: 7000 }));
    RMf.appendNote(fboard, { from: 'code', to: 'ghost2', kind: 'request', body: 'nobody will ever read this' });
    const gRepo = (F.snapshot().repos || []).find((r) => r.root === fboard.root);
    ok('...a CLOSED chair contributes NO pending edge — its unread pile never drains (immortal arrow)',
      !!gRepo && !gRepo.pending.some((p) => p.to === 'ghost2')
      && gRepo.roster.some((c) => c.role === 'ghost2' && c.state === 'closed'));
    try { fs.unlinkSync(path.join(fboard.planDir, 'claim-ghost2.json')); } catch {}
  }

  // THE WATCHER INVARIANT: every cache file the snapshot READS must be one the watcher WAKES on.
  // roleState began reading arc-await-<session>.json while the filter still only matched
  // state|status, so arming a listener changed the snapshot but pushed nothing — the feed reported a
  // state it was not watching, and only the 1.2s fallback tick hid it. Broken again the day someone
  // reads a new cache file, so it is asserted here rather than left to a comment.
  {
    const src = fs.readFileSync(path.join(SRC, 'arc-feed.js'), 'utf8');
    const m = src.match(/\/\^arc-\(([a-z|]+)\)-\//);
    const watched = m ? m[1].split('|') : [];
    ok('the cache watcher wakes on EVERY prefix the snapshot reads (state + status + await)',
      ['state', 'status', 'await'].every((p) => watched.indexOf(p) >= 0));
  }

  // STATUSLINE FRESHNESS: stdin vs the polled cache. Claude Code's rate_limits blob is that
  // session's LAST API RESPONSE, so an IDLE session's stdin freezes. The old rule was
  // `stdinUsage || cache` ("stdin is fresher"), true only while a session takes turns — an idle
  // session rendered every 10s and discarded the correct cached number every time, showing 93%
  // against a 5h window that had already reset while the cache held the true 9%.
  {
    const um = fs.readFileSync(path.join(SRC, 'usage-monitor.js'), 'utf8');
    const pickFresher = new Function(
      um.slice(um.indexOf('function pickFresher'), um.indexOf('// Bridge ARC_SESSION')) + '; return pickFresher;')();
    const W = (pct, iso) => ({ five_hour: { utilization: pct, resets_at: iso }, seven_day: { utilization: 0 } });
    const past = new Date(Date.now() - 5 * 3600e3).toISOString();
    const future = new Date(Date.now() + 3600e3).toISOString();
    const pct = (u) => u && u.five_hour.utilization;
    ok('an IDLE session\'s ELAPSED stdin window loses to the polled cache (the frozen-bar bug)',
      pct(pickFresher(W(93, past), W(9, future))) === 9);
    ok('...but a LIVE session\'s stdin still wins on the same or a newer window (it IS fresher there)',
      pct(pickFresher(W(12, future), W(9, future))) === 12
      && pct(pickFresher(W(3, future), W(9, past))) === 3);
    ok('...and with no cache, or an unreadable stdin timestamp, stdin still stands (never worse than before)',
      pct(pickFresher(W(93, past), null)) === 93
      && pct(pickFresher(W(50, 'garbage'), W(9, future))) === 50
      && pct(pickFresher(null, W(9, future))) === 9);
  }

  // THE REPAINT INVARIANT (audit #235 blocker 4): every snapshot field the GUI's detail view DRAWS
  // must appear in RepoSig, or the change-gate suppresses the redraw and the panel shows a state
  // that has already passed. It missed state/roster/pending/flow, which broke both headline features
  // at once — the status dot never repainted and the arrow never dissolved on consumption. C# has no
  // suite of its own, so the invariant is asserted here against the source rather than trusted.
  {
    const gui = fs.readFileSync(path.join(__dirname, '..', 'scope', 'arc-scope.cs'), 'utf8');
    const sig = gui.slice(gui.indexOf('static string RepoSig'), gui.indexOf('// ---- OVERVIEW ----'));
    const drawn = ['roster', 'pending', 'flow', 'waiting', 'roadmap', 'roadmapFile', 'state'];
    const missing = drawn.filter((f) => sig.indexOf('"' + f + '"') < 0);
    ok('RepoSig hashes every field the detail view draws (or a change never repaints): '
      + (missing.length ? 'MISSING ' + missing.join(',') : 'all present'), missing.length === 0);

    // ...and every SUB-field of each item, not just the collection's name. The check above passes as
    // soon as "roadmap" appears anywhere in RepoSig, so a per-item field could still be unhashed:
    // `owner` was drawn at RenderDetail but absent from the ;R segment, so editing only the "Owner of
    // the next move" line left the panel showing the previous owner. Same drift as audit #235
    // blocker 4, one level deeper — which is exactly how the collection-level check let it through.
    const subs = [
      ['roadmap', ['title', 'state', 'owner']],
      ['roster', ['role', 'state']],
      ['pending', ['seq', 'to', 'seen']],
    ];
    const subMissing = [];
    for (const [coll, fields] of subs) {
      const at = sig.indexOf('"' + coll + '"');
      const seg = at < 0 ? '' : sig.slice(at, sig.indexOf('\n', at) + 1 || sig.length);
      for (const f of fields) if (seg.indexOf('"' + f + '"') < 0) subMissing.push(coll + '.' + f);
    }
    ok('...including each item SUB-field the view draws: '
      + (subMissing.length ? 'MISSING ' + subMissing.join(',') : 'all present'), subMissing.length === 0);
  }

  // v6 STATE: a role's live state comes from the `arc join` listener marker, NOT from self-reported
  // activity. The distinction that matters: NO marker means the session is mid-turn (working), never
  // idle — a silent session is not an idle one, and painting it idle was a real bug in the widget.
  const awaitFile = (s) => path.join(CLAUDE, 'cache', `arc-await-${s}.json`);
  const sRepo = () => (F.snapshot().repos || []).find((r) => r.root === fboard.root);
  const stOf = (rp, role) => ((rp || {}).roles || []).find((x) => x.role === role) || {};

  // THE LISTENER MARKER NO LONGER DECIDES STATE AT ALL (operator's call). Two attempts to read it
  // both painted hard-working sessions as faulty: first "marker present" was read as idle, which
  // inverted the meaning (arm-once is the normal state, so every healthy worker went yellow); then a
  // MISSING marker was read as deaf behind a 90s heartbeat gate, which still fired on a revived
  // session whose single web-search tool call outran the gate. State is the transcript clock only.
  const projd3 = path.join(CLAUDE, 'projects', 'state-proj');
  fs.mkdirSync(projd3, { recursive: true });
  const cf3 = path.join(projd3, 'fc1.jsonl');
  const writeTurn = (msAgo) => fs.writeFileSync(cf3, JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - msAgo).toISOString() }) + '\n');

  writeTurn(2000);
  ok('...NO listener but the transcript is BEATING reads ACTIVE — mid-turn is not a fault',
    stOf(sRepo(), 'code').state === 'active');
  writeTurn(200000);   // silent 200s: once DEAF, now simply not-yet-idle
  ok('...NO listener and silent 200s is STILL ACTIVE — a missing marker is never a fault by itself',
    stOf(sRepo(), 'code').state === 'active');

  writeTurn(2000);
  fs.writeFileSync(awaitFile(CODE), JSON.stringify({ pid: process.pid, role: 'code', at: Date.now() }));
  ok('...an ARMED listener + a fresh transcript turn reads ACTIVE (armed means reachable, not idle)',
    stOf(sRepo(), 'code').state === 'active');

  // A DEAD listener pid used to force deaf. It is now irrelevant: only the heartbeat speaks.
  fs.writeFileSync(awaitFile(CODE), JSON.stringify({ pid: DEAD_PID, role: 'code', at: Date.now() }));
  ok('...a marker whose pid is DEAD does not change the state — reachability is not this feed\'s job',
    stOf(sRepo(), 'code').state === 'active');
  fs.writeFileSync(awaitFile(CODE), JSON.stringify({ pid: process.pid, role: 'audit', at: Date.now() }));
  ok('...nor does a marker belonging to a DIFFERENT role',
    stOf(sRepo(), 'code').state === 'active');

  ok('...and NO state is ever "deaf" now, whatever the marker says',
    stOf(sRepo(), 'code').state !== 'deaf');
  writeTurn(2000);

  // IDLE is the transcript's clock, and it is the SOFT state: no readable transcript must never be
  // reported as idleness — asserting a live peer is idle without evidence is the false statement.
  fs.writeFileSync(awaitFile(CODE), JSON.stringify({ pid: process.pid, role: 'code', at: Date.now() }));
  const projd2 = path.join(CLAUDE, 'projects', 'state-proj');
  fs.mkdirSync(projd2, { recursive: true });
  const convFile = path.join(projd2, 'fc1.jsonl');
  fs.writeFileSync(convFile, JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 90 * 60000).toISOString() }) + '\n');
  ok('...ARMED but silent for 90 minutes reads IDLE (the transcript is the only evidence of work)',
    stOf(sRepo(), 'code').state === 'idle');
  fs.writeFileSync(convFile, JSON.stringify({ type: 'user', timestamp: new Date().toISOString() }) + '\n');
  ok('...and a turn written just now flips it back to ACTIVE',
    stOf(sRepo(), 'code').state === 'active');
  try { fs.unlinkSync(convFile); } catch {}
  ok('...with NO readable transcript it falls back to ACTIVE — never assert idle without evidence',
    stOf(sRepo(), 'code').state === 'active');
  try { fs.unlinkSync(awaitFile(CODE)); } catch {}

  ok('...the repo ROADMAP is parsed from docs/ROADMAP.md — numbered items only, with owner + open/prog state',
    !!repo && repo.roadmap.length === 2
    && repo.roadmap[0].title === 'First item' && repo.roadmap[0].owner === 'code' && repo.roadmap[0].state === 'prog'
    && repo.roadmap[1].title === 'Second item' && repo.roadmap[1].owner === 'research' && repo.roadmap[1].state === 'open');
  ok('...and roadmapFile marks that a ROADMAP.md EXISTS (so "unreadable" never renders as "empty")',
    !!repo && repo.roadmapFile === true);

  // A ROADMAP.md that is NOT a roadmap of work. whalephone's is a doc-status INVENTORY (its own
  // subtitle says so, and points at the real build-order plan elsewhere). A looser fallback parser
  // scraped its table rows and reported 13 FILENAMES as roadmap items; that fallback was removed.
  // arc must report nothing here rather than manufacture a backlog from a file's contents.
  const drepo = fs.mkdtempSync(path.join(os.tmpdir(), 'rmdial-'));
  spawnSync('git', ['init', '-q'], { cwd: drepo });
  fs.mkdirSync(path.join(drepo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(drepo, 'docs', 'ROADMAP.md'),
    '# ROADMAP — doc status: shipped vs active vs pending\n\n'
    + '> This is the doc-status view. The build-order roadmap lives elsewhere.\n\n'
    + '## 🟡 Active — partial\n| Doc | Built / Pending |\n|---|---|\n| `speed-harness.md` | Fuse shipped; verify pending. |\n'
    + '| ★ `faster-legs.md` | residuals parked. |\n\n'
    + '## 📖 Reference — living docs\n| Doc | Note |\n|---|---|\n| `catalog.md` | not buildable. |\n');
  const dRm = F.__parseRoadmap(drepo);
  ok('a doc-INVENTORY ROADMAP.md yields NO items — arc never mints a backlog out of filenames',
    dRm.items.length === 0);
  ok('...but it still reports file:true, so the UI says "no items read", never "nothing parked"',
    dRm.file === true);

  // the honest-empty distinction
  const erepo = fs.mkdtempSync(path.join(os.tmpdir(), 'rmnone-'));
  ok('a repo with NO docs/ROADMAP.md reports file:false — distinguishable from an unreadable one',
    F.__parseRoadmap(erepo).file === false && F.__parseRoadmap(erepo).items.length === 0);
  ok('a DEAD session is NOT shown — liveness is genuine, not a stale arc-state file',
    (() => { const D = 'feed-dead-' + process.pid;
      fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${D}.json`), JSON.stringify({ pid: 999999, cwd: frepo }));
      const r2 = (F.snapshot().repos || []).find((r) => r.root === fboard.root);
      try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-state-${D}.json`)); } catch {}
      return !!r2 && r2.sessionCount === 2; })());   // pid 999999 is odd => structurally dead on Windows

  // LIFECYCLE (sync-testable): sweepOrphans drops a DEAD feed pidfile, keeps a live one.
  const fp = (p) => path.join(CLAUDE, 'cache', `arc-feed-${p}.json`);
  fs.writeFileSync(fp(18990), JSON.stringify({ pid: 999999, port: 18990 }));
  fs.writeFileSync(fp(18991), JSON.stringify({ pid: process.pid, port: 18991 }));
  const swept = F.sweepOrphans();
  ok('sweepOrphans drops a DEAD feed pidfile and keeps a live one',
    swept >= 1 && !fs.existsSync(fp(18990)) && fs.existsSync(fp(18991)));
  try { fs.unlinkSync(fp(18991)); } catch {}

  // THE HOST GUARD (audit #345) — the DNS-rebinding allowlist as a PURE function, so the security
  // logic is LOCKED in the suite (not only smoke-tested). Every angle audit probed on the wire.
  ok('hostAllowed accepts ONLY loopback; rejects rebinding + suffix/prefix smuggling (audit #345)',
    F.hostAllowed('127.0.0.1:8791') && F.hostAllowed('localhost:8791') && F.hostAllowed('[::1]:8791')
    && F.hostAllowed('127.0.0.1') && F.hostAllowed('LOCALHOST:8791')
    && !F.hostAllowed('evil.example.com') && !F.hostAllowed('evil.example.com:8791')
    && !F.hostAllowed('127.0.0.1.evil.com') && !F.hostAllowed('localhost.evil.com')
    && !F.hostAllowed('127.0.0.1:8791.evil') && !F.hostAllowed('[::ffff:127.0.0.1]') && !F.hostAllowed(''));
  // A running detached feed never reloads its source, so a deployed fix must SELF-ACTIVATE — the
  // only lever is VERSION (ensureFeed restarts a feed whose /healthz version is older). Guard the
  // discipline: this fix must have bumped it past the original 1 (audit #345).
  ok('the feed VERSION is bumped past 1 — a deployed fix can tell a running feed its code is stale',
    F.VERSION >= 2);

  // THE BUILT-IN DASHBOARD (so the feed is VIEWABLE, not only JSON): a pure function of the snapshot,
  // self-contained (no external assets — CSP/doctrine-clean), embeds the data then live-updates via SSE.
  const dash = F.dashboardHtml({ host: 'TESTBOX', at: Date.now(), version: F.VERSION,
    repos: [{ root: 'e:\\demo', name: 'demo', roles: [{ role: 'code', pid: 111 }], sessionCount: 1,
      board: { notes: 5, lastTs: null, unread: {} },
      waiting: [{ from: 'code', to: 'audit', seq: 9, id: 'x', ts: new Date().toISOString(), seen: false }],
      cooperation: [{ from: 'audit', to: 'code', seq: 10, reSeq: 8 }] }] });
  ok('dashboardHtml: self-contained page — SSR cards (renders with NO JS) + embedded snapshot + SSE wire',
    /arc . operator/.test(dash) && /<!doctype html>/i.test(dash)
    && dash.indexOf("EventSource('/events')") !== -1
    && dash.indexOf('<h2>demo</h2>') !== -1                               // SSR: the card is IN the HTML, no JS needed
    && dash.indexOf('class="edge unseen"') !== -1                        // SSR: the unseen waiting edge rendered
    && /"role":"code"/.test(dash)                                        // embedded snapshot drives live JS updates
    && dash.indexOf('__ARC_') === -1                                     // every placeholder replaced
    && !/https?:\/\//.test(dash.replace(/http:\/\/127\.0\.0\.1/g, '')));  // no EXTERNAL asset URLs (CSP-clean)

  // XSS LOCK (audit #352): the escaping IS the security boundary of the served `/` HTML surface.
  // Adversarial board data through the REAL exported renderer must never reach the DOM as markup nor
  // break out of the embedded <script>. Locks it so a future esc()/E() refactor or a new field can't
  // silently reopen XSS — the structural test above checks shape; this checks the escaping.
  const evil = F.dashboardHtml({ host: '<img src=x onerror=alert(1)>', at: Date.now(), version: F.VERSION,
    repos: [{ root: 'C:/repo/<svg/onload=alert(2)>', name: '</script><script>alert(3)</script>',
      roles: [{ role: '<img src=x onerror=alert(4)>', pid: 111 }], sessionCount: 1,
      board: { notes: 1, lastTs: null, unread: {} },
      waiting: [{ from: 'a', to: '"><svg/onload=alert(5)>', seq: 1, id: 'x', ts: new Date().toISOString(), seen: false }],
      cooperation: [] }] });
  ok('dashboardHtml NEUTRALIZES adversarial role/path/to/host — no XSS reaches the DOM (audit #352 probe)',
    !/<img[^>]*onerror/i.test(evil) && !/<svg[^>]*onload/i.test(evil)      // no live event-handler tags survive
    && evil.indexOf('</script><script>alert(3)') === -1                    // the embedded-JSON </script> breakout is dead
    && (evil.match(/<script/gi) || []).length === 1                        // exactly ONE <script — the shell's own
    && /&lt;img src=x onerror=alert\(4\)&gt;/.test(evil));                 // the role rendered as ESCAPED text

  for (const s of [CODE, AUD]) { try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-state-${s}.json`)); } catch {} }
  try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-status-${CODE}.json`)); } catch {}
  fs.rmSync(frepo, { recursive: true, force: true });
} catch (e) { ok('arc feed section ran without throwing', false, e.message); }

// ── every recurring PowerShell shell-out is windowless (audit #348) ─────────────────────────────
// A detached, CONSOLE-LESS process (the operator feed) makes a NEW console window for a child
// powershell UNLESS windowsHide is set — a pop-up that steals focus every ~30s cache-miss. procStarts
// and treeOf were the two recurring PS spawns missing it; the feed (new, runs forever) turned that
// latent gap into a continuous flash. Lint the whole class so it cannot silently come back.
section('powershell shell-outs are windowless (audit #348 — no focus-stealing pop-up)');
try {
  const bad = [];
  for (const f of fs.readdirSync(SRC)) {
    if (!f.endsWith('.js') || f === 'arc-invite.js') continue;   // arc-invite's peer-birth window is intentional
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    const rx = /spawn(?:Sync)?\(\s*['"]powershell/g;
    let m;
    while ((m = rx.exec(src))) {
      const call = src.slice(m.index, m.index + 1000);
      if (/stdio\s*:[^}]*inherit/.test(call)) continue;   // console-ATTACHED (arc update's install.ps1) — user-invoked, no window class
      if (!/windowsHide\s*:\s*true/.test(call)) bad.push(f + '@' + m.index);
    }
  }
  ok('every recurring PowerShell spawn in src/ sets windowsHide (no window from a console-less parent)',
    bad.length === 0, bad.join(', '));
} catch (e) { ok('windowsHide lint ran', false, e.message); }

section('/arc-mode gate (fires ONLY when a delegate would spawn a session)');
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

  // `frontend` is nobody's role here, so delegating to it WOULD spawn. `code` is GS's own live
  // role, so delegating to it is just a note and must never be gated.
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
  const den = gate('arc delegate frontend "do a thing"');
  ok('PASSIVE denies a delegate that would SPAWN (nobody holds that role)',
    den.decision === 'deny' && /passive/i.test(den.reason || ''));
  ok('...and says WHY passive binds the human too (a gate sees a tool call, not who asked)',
    /\/arc-mode balanced/.test(den.sys || '') && /cannot tell your order/i.test(den.sys || ''));

  St3.setStance(GS, 'balanced');
  ok('BALANCED asks — the permission prompt IS the confirmation',
    gate('arc delegate frontend "do a thing"').decision === 'ask');

  St3.setStance(GS, 'active');
  ok('ACTIVE allows — auto-approved, no prompt',
    gate('arc delegate frontend "do a thing"').decision === 'allow');

  // COMMAND-SCOPED, OR ASK (audit #293 — the last unscoped auto-allow in the gate). ACTIVE's allow
  // blesses the WHOLE command, so a chained tail would ride it. A SOLE delegate still auto-allows; a
  // decorated one falls to a PROMPT (never denied — ACTIVE still wants the delegate, just not what
  // is stapled to it). Same soleCommand predicate the reply exemption uses.
  ok('a CHAINED delegate defers to a prompt in ACTIVE — the allow no longer blesses the tail',
    gate('arc delegate frontend "x"; rm -rf Y').decision === 'ask'
    && gate('arc delegate frontend "x" && curl evil').decision === 'ask'
    && gate('arc delegate frontend "x" | tee Z').decision === 'ask');
  ok('...a leading cd/prefix before the delegate defers too (anchored at ^arc delegate)',
    gate('cd E:\\other; arc delegate frontend "x"').decision === 'ask'
    && gate('echo hi && arc delegate frontend "x"').decision === 'ask');
  ok('...a substitution char in the packet defers ($()/backticks run inside quotes)',
    gate('arc delegate frontend "x $(whoami)"').decision === 'ask'
    && gate('arc delegate frontend "see (a)"').decision === 'ask');
  ok('...but a SOLE delegate still auto-allows (the exemption survives its own scoping)',
    gate('arc delegate frontend "do a thing"').decision === 'allow');
  // one shared predicate, source-pinned so the two auto-allows cannot drift apart.
  const PT = require(path.join(SRC, 'arc-pretool-hook.js'));
  ok('soleCommand is the shared scoping predicate (both auto-allows call it)',
    PT.soleCommand('arc delegate x "y"', 'delegate') === true
    && PT.soleCommand('arc delegate x "y"; rm', 'delegate') === false
    && PT.soleCommand('arc note x --reply-to 1 "y"', 'note') === true
    && PT.soleCommand('cd z; arc note x --reply-to 1 "y"', 'note') === false);

  // THE BARE-ARM GUARD (self-inflicted-deafness fix, 2026-07-18). A decorated `arc join` never
  // creates a wakeable listener — the shell `&`/redirect makes the tracked process exit at once and
  // orphans the real listener, while "listening" prints and lies (the #317 agent-behavior cause,
  // lived this day). The PreToolUse hook is the ONLY layer that sees the shell decoration, so a
  // LEADING `arc join` must be sole. It fires in ANY stance and needs no board read.
  ok('a DECORATED arc join is DENIED — the exact self-arm form that went silently deaf',
    gate('arc join code >/dev/null 2>&1 &').decision === 'deny'
    && gate('arc join code &').decision === 'deny'
    && gate('arc join audit | head -1').decision === 'deny'
    && gate('arc join code; echo done').decision === 'deny'
    && gate('arc join code', 'PowerShell').decision === null);   // PowerShell path judged too
  ok('...the denial names the fix (malformed arm; arm bare via run_in_background)',
    /malformed arm/i.test(gate('arc join code &').reason || '')
    && /run_in_background/i.test(gate('arc join code >/dev/null 2>&1 &').sys || ''));
  ok('a BARE arc join is never touched — the CORRECT arm must pass clean',
    gate('arc join code').decision === null
    && gate('arc join audit').decision === null
    && gate('  arc join code  ').decision === null                // leading/trailing space ok
    && gate('arc join code\n').decision === null                  // trailing newline is not decoration (audit's edge-FP)
    && gate('\narc join code').decision === null);                // leading newline either
  ok('...but an INTERIOR newline (a real second command) still DENIES — trim keeps the bypass shut',
    gate('arc join code\nrm -rf x').decision === 'deny');
  ok('a note that MENTIONS or DISCUSSES arc join is NOT denied (anchored at ^, zero false positive)',
    gate('arc note audit "run EXACTLY: arc join code; NO pipe & NO redirect >x"').decision !== 'deny'
    && gate('arc note code --reply-to 5 "the bug: arc join x | head is malformed"').decision !== 'deny'
    && gate('arc delegate research "scout arc join failure modes; & pipes"').decision !== 'deny');

  // THE MERGE'S WHOLE POINT: one verb, two costs. Delegating to a LIVE peer is a note — free,
  // reversible, the commonest thing an agent does — and gating it would be pure noise. The gate
  // must therefore look up liveness, not just match the command string.
  St3.setStance(GS, 'passive');
  ok('a delegate to a LIVE peer is NEVER gated, even in passive (it is only a note)',
    gate('arc delegate code "ping"').decision === null);
  St3.setStance(GS, 'active');

  // The runaway guard: even ACTIVE asks once the board is crowded. Fails OPEN to a prompt, never
  // to a refusal — "spawn a helper" looks locally reasonable every single time, and each peer
  // burns its own quota.
  for (const r of ['a1', 'a2', 'a3']) RM4.claimRole(gboard, r, process.pid, `other-${r}`, null);
  const capped = gate('arc delegate frontend "do a thing"');
  ok('ACTIVE still ASKS once several peers are already live (runaway guard)',
    capped.decision === 'ask' && /already live/i.test(capped.reason || ''));
  for (const r of ['a1', 'a2', 'a3']) RM4.releaseRole(gboard, r, process.pid);

  // Inertness. This hook sits in front of EVERY shell call, so anything that is not a delegate
  // to an EMPTY chair must produce NO output at all (= defer to the normal permission flow).
  St3.setStance(GS, 'passive');   // the strictest stance, to prove the bail-outs are real
  ok('a non-delegate command is not touched, even in passive (no output = defer)',
    gate('git status').decision === null && gate('arc note code "hi"').decision === null
    && gate('arc join code').decision === null);
  // A REPLY IS NOT INITIATIVE (the note-permission asymmetry — the human's idea, verbatim:
  // "replying a note doesn't require user permission"). A VERIFIED reply auto-allows in every
  // stance; everything unproven defers to the normal permission flow — allow must be EARNED.
  RM4.appendNote(gboard, { from: 'research', to: 'code', kind: 'request', body: 'q for code?' }); // #1
  RM4.appendNote(gboard, { from: 'research', to: null, body: 'broadcast FYI' });                  // #2
  RM4.appendNote(gboard, { from: 'research', to: 'frontend', body: 'not for code' });             // #3
  St3.setStance(GS, 'passive');   // the strictest stance — a reply flows even here
  ok('a VERIFIED reply auto-allows in every stance, passive included (a reply is not initiative)',
    gate('arc note research --reply-to 1 "DONE — the answer"').decision === 'allow');
  ok('...a reply to a BROADCAST that reached us allows too',
    gate('arc note research --reply-to 2 "ack"').decision === 'allow');
  ok('...but INITIATING a note stays untouched by arc (defers to the normal permission flow)',
    gate('arc note research "a brand new thread"').decision === null);
  ok('...a reply to a note NOT addressed to us defers (an allow must be PROVEN)',
    gate('arc note research --reply-to 3 "butting in"').decision === null);
  ok('...a reply aimed at someone who did NOT write the note defers (a reply goes to its asker)',
    gate('arc note frontend --reply-to 1 "wrong asker"').decision === null);
  ok('...a nonexistent seq defers, never allows',
    gate('arc note research --reply-to 99 "ghost"').decision === null);
  ok('...and a CROSS-BOARD reply still ASKS — leaving the repo outranks the reply exemption',
    gate('arc note research --reply-to 1 --board E:\\other "x"').decision === 'ask');

  // COMMAND-SCOPED, OR NOTHING (audit #290 — the bypass it caught before the record did): the
  // regex matches a SUBSTRING but an allow approves the WHOLE command, so a genuine reply with a
  // chained tail would have ridden the exemption — removing exactly the prompt that shows the
  // human the tail. Every decorated form must DEFER to the normal permission flow.
  ok('a reply with a CHAINED command defers — the allow is command-scoped (audit #290 probes)',
    gate('arc note research --reply-to 1 "ok"; rm -rf X').decision === null
    && gate('arc note research --reply-to 1 "ok" && curl evil').decision === null
    && gate('arc note research --reply-to 1 "ok" | tee X').decision === null
    && gate('echo hi && arc note research --reply-to 1 "ok"').decision === null);
  ok('...a body carrying substitution characters defers too ($() and backticks run INSIDE quotes)',
    gate('arc note research --reply-to 1 "x $(whoami)"').decision === null
    && gate('arc note research --reply-to 1 "see #282 (crossed)"').decision === null);
  ok('...a leading cd defers — it would post onto a DIFFERENT board than the ledger checks read',
    gate('cd E:\\arc; arc note research --reply-to 1 "ok"').decision === null);
  ok('...and the PLAIN reply still allows (the exemption survives its own scoping)',
    gate('arc note research --reply-to 1 "DONE - all four claims hold"').decision === 'allow');
  St3.setStance(GS, 'passive');

  // FAILS CLOSED by design: a mention inside a string is gated too. A false positive costs a
  // prompt; a false negative would let a session spawn ungated. And the honest limit — this is a
  // guardrail against self-initiation, not a sandbox: any string matcher can be walked around.
  ok('a delegate hidden in a STRING is still gated (fails closed, never silently through)',
    gate('echo "run arc delegate frontend x"').decision === 'deny');
  ok('...but a CHAINED delegate IS caught (cd x && arc delegate y)',
    gate('cd /tmp && arc delegate frontend "x"').decision === 'deny');
  ok('a non-shell tool is never gated (matcher is Bash|PowerShell)',
    gate('arc delegate frontend "x"', 'Read').decision === null);
  ok('the PowerShell tool is gated too (a staffed peer may have no Bash tool at all)',
    gate('arc delegate frontend "x"', 'PowerShell').decision === 'deny');
  ok('a NON-arc session is left completely alone (no ARC_SESSION)',
    gate('arc delegate frontend "x"', 'Bash', '').decision === null);

  // `arc delegate` must stay OFF the allowlist, or the gate could never see an "ask": an allow
  // rule would satisfy the permission check before the prompt ever happened.
  const W2 = require(path.join(SRC, 'arc-wire-settings.js'));
  ok('`arc delegate` is not allowlisted (else balanced could never ask before a spawn)',
    !W2.BOARD_PERMISSIONS.some((p) => /delegate|invite/.test(p)));

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

  // MARK-AND-RE-ADD, not add-if-absent: arc must be able to UPDATE its own hook command on an
  // already-installed machine. The old model matched the existing command substring and SKIPPED,
  // so a changed invocation (a new flag) never reached a deployed box — the statusLine "adopt our
  // own" bug, one layer over (research #250 GOLD 2). Marker = the script filename, stable across
  // command changes.
  {
    const s = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node arc-stop-hook.js' }] }] } };
    W2.mergeHooks(s, [{ event: 'Stop', script: 'arc-stop-hook.js', command: 'node arc-stop-hook.js --new' }]);
    const cmds = s.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
    ok('mergeHooks UPDATES its own hook when the command changed (not add-if-absent)',
      cmds.length === 1 && cmds[0] === 'node arc-stop-hook.js --new');

    // a USER's own hook in the same event is NEVER stripped — it carries no arc marker
    const s2 = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own.sh' }, { type: 'command', command: 'node arc-stop-hook.js' }] }] } };
    W2.mergeHooks(s2, [{ event: 'Stop', script: 'arc-stop-hook.js', command: 'node arc-stop-hook.js --v2' }]);
    const survivors = s2.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
    ok('...while a USER hook in the same event survives untouched',
      survivors.includes('my-own.sh') && survivors.includes('node arc-stop-hook.js --v2')
      && !survivors.includes('node arc-stop-hook.js'));

    // OWNERSHIP IS THE SCRIPT ARGV PATH, NOT A SUBSTRING (audit #271 M3). A user hook whose script is
    // a DIFFERENT file that merely CONTAINS arc's name, or whose LATER arg mentions arc's script, must
    // survive an install — the old `command.includes(marker)` deleted both.
    const s3 = { hooks: { Stop: [{ hooks: [
      { type: 'command', command: 'node C:/my-tools/not-arc-stop-hook.js' },
      { type: 'command', command: 'node C:/mine/wrap.js --after arc-stop-hook.js' },
      { type: 'command', command: 'node "C:/.claude/scripts/arc-stop-hook.js"' },   // OURS (real deployed shape)
    ] }] } };
    W2.mergeHooks(s3, [{ event: 'Stop', script: 'arc-stop-hook.js', command: 'node "C:/.claude/scripts/arc-stop-hook.js"' }]);
    const surv3 = s3.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command));
    ok('...and a foreign script whose NAME contains arc\'s, or an arg that MENTIONS it, is NOT deleted',
      surv3.includes('node C:/my-tools/not-arc-stop-hook.js')
      && surv3.includes('node C:/mine/wrap.js --after arc-stop-hook.js')
      && surv3.filter((c) => c === 'node "C:/.claude/scripts/arc-stop-hook.js"').length === 1);
    ok('ownsHookCommand matches arc\'s own script argv path, not an arbitrary substring',
      W2.ownsHookCommand('node "C:/x/arc-stop-hook.js"', 'arc-stop-hook.js') === true
      && W2.ownsHookCommand('node C:/my-tools/not-arc-stop-hook.js', 'arc-stop-hook.js') === false
      && W2.ownsHookCommand('node wrap.js --after arc-stop-hook.js', 'arc-stop-hook.js') === false);
    // audit #289 blocker 6 — the parser must handle node flags/wrappers and reject foreign execs:
    ok('...OWNS a stale arc hook invoked with node flags (--no-warnings / --require=…) — false negative closed',
      W2.ownsHookCommand('node --no-warnings C:/old/arc-stop-hook.js', 'arc-stop-hook.js') === true
      && W2.ownsHookCommand('node --require=C:/x/preload.js C:/old/arc-stop-hook.js', 'arc-stop-hook.js') === true);
    ok('...does NOT own a FOREIGN executable that merely ends in "node" (badnode.exe) — false positive closed',
      W2.ownsHookCommand('C:/mine/badnode.exe C:/old/arc-stop-hook.js', 'arc-stop-hook.js') === false);
    ok('...does NOT claim a cmd-wrapped user hook (arc never installs that shape; keep it)',
      W2.ownsHookCommand('cmd /c node C:/old/arc-stop-hook.js', 'arc-stop-hook.js') === false);
  }

  // The stance TEXT must teach the same rule the gate enforces, or the agent learns one thing
  // and the machine does another.
  ok('the passive directive warns that delegating to an EMPTY chair is refused',
    /EMPTY chair is REFUSED/.test(St3.directive('passive')));
  ok('...while making clear a note to a LIVE peer is still fine (passive is not deaf-and-mute)',
    /LIVE peer is still just a note/.test(St3.directive('passive')));
  ok('the active directive teaches the ONE verb (and mentions the cap)',
    /arc delegate/.test(St3.directive('active')) && /auto-approved/.test(St3.directive('active')));

  fs.rmSync(grepo, { recursive: true, force: true });
  try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-state-${GS}.json`)); } catch {}
} catch (e) { ok('/arc-mode gate', false, e.message + '\n' + (e.stack || '')); }

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
  // `arc delegate` is deliberately NOT allowlisted: it is the one verb that can spawn a whole
  // session, and that stays a per-spawn decision routed through the /arc-mode gate.
  ok('`arc delegate` is NOT auto-allowed (spawning sessions stays a gated decision)',
    !perms.some((p) => /delegate|invite/.test(p)));
  // close/export/import joined later (they post-date the original list). close is the remedy the
  // stop-hook's own nag prescribes — arc must never demand a command the allowlist then blocks;
  // export/import are the board's transport. A content classifier vetoing "earlier conversation
  // content" once locked an agent out of all three mid-session — allowlisted commands skip it.
  for (const tool of ['Bash', 'PowerShell']) {
    ok(`the allowlist covers ${tool} close/export/import (the nag's remedy + the board's transport)`,
      perms.includes(`${tool}(arc close:*)`) && perms.includes(`${tool}(arc export:*)`) && perms.includes(`${tool}(arc import:*)`));
  }

  const st = {};
  W.mergePermissions(st, perms);
  W.mergePermissions(st, perms);        // idempotent: re-running the installer must not duplicate
  ok('mergePermissions is idempotent (a re-install never duplicates a rule)',
    st.permissions.allow.length === perms.length);
  ok('...and it PRESERVES rules the user added themselves',
    (() => { const u = { permissions: { allow: ['Bash(git status)'] } }; W.mergePermissions(u, perms);
      return u.permissions.allow.includes('Bash(git status)') && u.permissions.allow.length === perms.length + 1; })());
} catch (e) { ok('board permissions', false, e.message); }

section('arc delegate -> staffRole (new tab, revived-or-forked context, self-arming peer)');
try {
  const I = require(path.join(SRC, 'arc-invite.js'));
  const RM3 = require(path.join(SRC, 'arc-board.js'));
  const NI = require(path.join(SRC, 'arc-notes.js'));
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
  // THE PROMPT IS NO LONGER ON THE COMMAND LINE, so it can no longer be grepped out of one — and
  // that is the fix, not an inconvenience. It travels as a FILE, because the chain
  // node -> spawnSync -> powershell.exe -Command -> wt -> shell is five parsers and no quoting form
  // survives all five (two live pwsh attempts died proving it). So the test captures it as DATA at
  // the point it is written, which is also a truer test: it asserts what the peer will actually
  // READ, not what we hoped a string would look like after four re-parses.
  let bornPrompt = null;
  const capture = (text, role) => { bornPrompt = { text, role }; return 'C:\\Temp\\arc-birth-test.txt'; };
  const NOHIST = { spawn: rec, hasWt: true, hasTranscript: () => false, writeScript: capture };
  const okr = I.staffRole(VS, 'frontend', NOHIST);
  ok('staffing launches via SYNC PowerShell: a wt tab in the CURRENT window at the repo root',
    okr.ok === true && spawned && spawned.bin === 'powershell.exe'
    && /wt -w 0 new-tab/.test(psOf()) && psOf().includes(`-d '${vrepo}'`));
  // FORKED FROM THE CALLER — and that does NOT cost revival. This test asserted the exact opposite
  // ("never a fork of the caller"), on the theory that a forked session leaves no resumable
  // transcript. The theory was FALSE and it was encoded here, in the src comment, and in the birth
  // shape: the real culprit was env inheritance — a peer wearing the caller's
  // CLAUDE_CODE_SESSION_ID never mints a conversation of its own, fork or not — and birthEnv had
  // already fixed it one line away. Both changed at once, one test passed, wrong half credited.
  // MEASURED, the combination never run until then (fork + stripped env): own sessionId on all 2589
  // entries, 6,680,047 bytes, still on disk after the pid was gone, hasTranscript() true.
  ok('a NEW peer is FORKED from the CALLER, so it opens already knowing the project',
    /-Resume conv-abc-123\b/.test(psOf()) && /-Fork\b/.test(psOf()));
  // THE BIRTH PROMPT IS REAL PROSE, NOT A COMMAND — and that is what makes the peer revivable.
  // An /arc- command is BLOCKED at UserPromptSubmit (zero tokens, by design), so it never reaches
  // the model; every later input arrives as a hook injection or a Stop-block reason, never a user
  // message. Measured: such a session leaves NO conversation on disk — `claude --resume <its id>`
  // says "No conversation found" even after a graceful /exit — so there is nothing to revive and
  // staffing silently births a stranger. A peer that never has a real turn can never come back.
  ok('a BORN peer opens with a REAL prompt, not a blocked command (a blocked command leaves no conversation)',
    !!bornPrompt && /You were BRANCHED from another session/.test(bornPrompt.text)
    && !/^arc:role /.test(bornPrompt.text) && !/^\/arc-/.test(bornPrompt.text));
  // AND IT REACHES THE PEER AS A FILE, not as an argument. This is the property two live tabs were
  // spent learning: the prompt is prose, the chain re-parses it four times after we build it, and
  // every quoting form we tried arrived mangled or opened no tab at all. Nothing fragile may ride
  // the command line — what crosses it is a path and a handful of tokens that cannot be mangled.
  ok('...delivered as a FILE, never as an argument (five parsers, no quoting survives all of them)',
    /-PromptFile /.test(psOf()) && !psOf().includes('You were BRANCHED'));
  // BUG-4, AND WHY IT MUST COME FIRST. A fork wakes up reading a conversation in which it IS the
  // caller, and every habit in that history says keep going — watched live: a fork picked up the
  // caller's investigation, answered in the first person, and only learned it was not the caller by
  // reading arc-state. birthEnv cannot reach this: the confusion is in the CONTENT, not the env.
  // The disavowal has to land BEFORE the role instruction, or an agent already resumed into the
  // caller's task reads `arc role` as one more errand inside it.
  ok('...and the prompt DISAVOWS the inherited identity BEFORE handing over the role (BUG-4)',
    /CONTEXT ONLY/.test(bornPrompt.text) && /not your work/.test(bornPrompt.text)
    && bornPrompt.text.indexOf('CONTEXT ONLY') < bornPrompt.text.indexOf('arc role frontend'));
  ok('...telling it to claim, so the claim still happens on its own with nobody watching',
    /arc role frontend/.test(bornPrompt.text));
  // THE QUOTING, which cost two live tabs to learn — and the lesson was the WRONG one. This asserted
  // a specific quoting form ("one PS string, inner quotes doubled") and passed while the real
  // launcher opened NO TAB. That is the tell: a test that pins the SHAPE of a string cannot see
  // whether the string survives node -> spawnSync -> powershell.exe -Command -> wt -> shell. No form
  // survives all five, so the prompt stopped being a string on a wire. Assert the PROPERTY that
  // matters — nothing fragile on the command line — not a spelling that four parsers get a vote on.
  let tplPrompt = null;
  const psLaunch = I.buildLaunch(true, 'veneto', null, 'frontend', 'E:/arc', 'pwsh', null,
    (t) => { tplPrompt = t; return 'C:\\Temp\\p.txt'; });
  ok('a PowerShell launch fills the SHIPPED template and passes the prompt by path, not by value',
    /-File '[^']*arc-birth\.ps1' -Role frontend -PromptFile '/.test(psLaunch)
    && /Take the frontend role on this board now/.test(tplPrompt)
    && !psLaunch.includes('Take the frontend role'));
  ok('...and cmd keeps its own nesting, which survives there',
    /cmd \/k arc\b/.test(I.buildLaunch(true, 'veneto', null, 'frontend', 'E:/arc', 'cmd')));
  // A STAFFED PEER HAS NOBODY TO ANSWER A PROMPT. Born in `manual` it stops at the first
  // permission request and sits claimed-but-deaf — holding the role so nothing else may staff it,
  // while answering nothing. The board allowlist covers arc's OWN commands only; a research peer
  // also needs Read/Grep/Edit to do the work it was staffed for, and each would stop it.
  // (Observed live: a staffed tab showing `manual mode on` while its caller ran `auto`.)
  ok('a BORN peer starts in AUTO permission mode (it has no human to answer a prompt)',
    /-Mode auto/.test(psOf()));

  // THE ONE THAT COST A DAY. staffRole runs inside a HOOK of a live session, so its env carries
  // that session's Claude Code identity — CLAUDE_CODE_SESSION_ID (the CALLER's conversation) and
  // CLAUDE_CODE_CHILD_SESSION ("you are a child of another session"). Every peer arc ever spawned
  // inherited both, so it booted, claimed, answered, exited code=0 — and NEVER registered as a
  // conversation of its own. hasTranscript was false for its whole life and after its death, so
  // staffing could only birth a stranger. Revive had never fired once.
  //
  // It hid behind a mechanism that looked airtight and was FALSE: "a newborn writes its transcript
  // on EXIT; a resumed session appends live." A peer reproduced that with plain claude and no arc —
  // because IT was spawned from an agent process too and inherited the same poison. Eight theories
  // died against it (--session-id, --name, --permission-mode, the blocked sentinel, wt, cmd-vs-pwsh,
  // /c-vs-/k, the window). Every one was a difference between an arc SPAWN and a HUMAN typing the
  // same command; the only one that ever mattered was the env a human's terminal does not have.
  // PROOF: identical wt + cmd /k + flags, env stripped -> 21701 bytes, written WHILE STILL LIVE.
  const dirty = { PATH: 'x', CLAUDE_CONFIG_DIR: 'profile', ARC_RUNTIME_ACCOUNT: 'veneto',
    CLAUDE_CODE_SESSION_ID: 'caller-conv', CLAUDE_CODE_CHILD_SESSION: '1', ARC_SESSION: 'caller-sess',
    NO_COLOR: '1' };
  const clean = I.birthEnv(dirty);
  ok('a newborn never inherits the CALLER\'s conversation id (it would never get one of its own)',
    !('CLAUDE_CODE_SESSION_ID' in clean) && !('CLAUDE_CODE_CHILD_SESSION' in clean));
  ok('...nor ARC_SESSION, or its hooks read the CALLER\'s role, notes and cursor',
    !('ARC_SESSION' in clean));
  // Same disease, different organ: Claude Code sets NO_COLOR=1 in its TOOL subshells, every spawn
  // runs in one, and wt hands the pane the INVOKER's env (probed live, 2026-07-18, both -p and
  // profile-less) — so every spawned peer ever ran MONOCHROME next to a colored hand-launched tab.
  ok('...nor the tool-shell\'s NO_COLOR, which turned every spawned peer monochrome',
    !('NO_COLOR' in clean));
  ok('...while the account profile SURVIVES — a revive resumes a conv that exists only there',
    clean.CLAUDE_CONFIG_DIR === 'profile' && clean.ARC_RUNTIME_ACCOUNT === 'veneto' && clean.PATH === 'x');
  // And it must actually reach the spawn, not just exist as a helper.
  const invSrc = fs.readFileSync(path.join(SRC, 'arc-invite.js'), 'utf8');
  ok('...and staffRole SPAWNS with that env (a helper nobody calls fixes nothing)',
    /doSpawn\('powershell\.exe',[^)]*env: birthEnv\(\)/.test(invSrc));
  // NEVER cmd. cmd.exe parses its command line before a batch %* forwards anything — truncating
  // at newlines, stripping quotes and EXPANDING %VAR% (the secret-leak vector) — and its PATHEXT
  // cannot even see arc.ps1, so `cmd /c arc` reaches the mangler no matter what we ship. That put
  // the BIRTH PROMPT through the same corruption that was silently eating peers' notes.
  // TRIED AND REVERTED: launching via `pwsh -Command arc … '<prompt>'`. The chain is
  // powershell.exe -Command -> wt -> shell, and the OUTER PowerShell strips the quotes before wt
  // sees them, so pwsh got the prompt as BARE WORDS and claude received the single word "Take".
  // cmd /c keeps it whole, and costs nothing here: cmd's %VAR% expansion was a SECURITY bug
  // because PEERS post notes through arc.cmd, and that is fixed where it lives (arc.ps1 on PATH,
  // which is what the peer's own PowerShell tool resolves). The launcher carries only OUR birth
  // prompt — authored here, no %VAR%, no quotes, no newlines. A shell that cannot corrupt what we
  // hand it is not a risk. This asserts the ONE property the launcher must not get wrong.
  // THE SHELL OUTLIVES CLAUDE so a peer that dies on a bad flag leaves its error on screen instead
  // of the tab vanishing. That is the whole reason, and it is worth keeping for that alone: every
  // launcher bug here was caught by a human reading a window.
  // DEAD THEORY, do not re-derive it: this said the shell must survive because "a newborn writes NO
  // transcript while it runs; the file appears when it EXITS", so `cmd /c` tore the process down
  // mid-flush. FALSE — a transcript grows on disk while the session is live (measured twice). The
  // revive bug was env inheritance. The theory outlived its refutation in FOUR places: this comment,
  // the src header, a src comment, and a test name.
  ok('the launcher SURVIVES claude exiting, so a dead peer leaves its error on screen',
    /-NoExit -File/.test(I.buildLaunch(true, 'v', null, 'x', 'E:/arc', 'pwsh', null, () => 'C:\\T\\p.txt'))
    && /cmd \/k /.test(I.buildLaunch(true, 'v', null, 'x', 'E:/arc', 'cmd'))
    && !/cmd \/c arc/.test(I.buildLaunch(true, 'v', null, 'x', 'E:/arc', 'cmd')));
  // PWSH TRIED TWICE, REVERTED TWICE, AND THE CONCLUSION WAS WRONG BOTH TIMES. 1st: claude received
  // the single word "Take" (the outer powershell.exe -Command stripped the quotes before wt saw
  // them). 2nd: quoting the whole inner command as one PS string produced NO TAB AT ALL while
  // staffRole printed its ✓. I read those as "pwsh does not work" and pinned cmd — HERE, as a test
  // asserting launchShell() === 'cmd', which turned my own refusal into a requirement and would have
  // failed anyone who tried to fix it. Neither failure was the shell: both were the prompt riding a
  // command line through node -> spawnSync -> powershell.exe -Command -> wt -> shell, five parsers,
  // each re-quoting the last. The prompt now travels as a FILE, so the shell is free to be right.
  // The user asked three times. The reason was sound every time: `cmd /c arc` cannot see arc.ps1
  // (PATHEXT has no .PS1), so it always reaches arc.cmd — the batch mangler that strips quotes and
  // expands %VAR%. A PowerShell tab resolves arc.ps1, which hands argv to node unparsed.
  ok('the launcher PREFERS PowerShell — cmd cannot even see arc.ps1, so it reaches the mangler',
    I.launchShell(() => true) === 'pwsh'
    && I.launchShell((e) => e === 'powershell.exe') === 'powershell'
    && I.launchShell(() => false) === 'cmd');
  // A REVIVE must not pass --permission-mode: arc-runner's preservedFlags restores the mode the
  // peer was last in, and passing it here too hands claude the flag twice.
  ok('a REVIVE does not duplicate --permission-mode (preservedFlags restores its own)',
    !/--permission-mode/.test(I.buildLaunch(true, 'veneto', 'some-conv', 'x', 'E:/arc', 'pwsh -NoLogo -NoProfile -Command')));
  // The SESSION's name, which is not the tab title. Claude Code names a session after the project,
  // so every arc session in one repo read "arc" — including in the `--resume` picker, where a peer
  // and the session that staffed it were indistinguishable and reviving the right conversation by
  // hand was guesswork. (Caught live: the tab said "arc: research", the session still said "arc".)
  ok('...and the session is NAMED for its role (else the --resume picker is a list of "arc")',
    /-Role frontend/.test(psOf()));
  // THE CONFIRMATION MUST DESCRIBE THE BIRTH THAT ACTUALLY HAPPENED — in BOTH directions. This
  // asserted the exact opposite ("starts FRESH ... not from your context") and went on passing for a
  // commit after birth began forking: born-not-cloned prose outliving its own behaviour, telling
  // every user the peer knew nothing while it opened with their whole conversation. No unit test
  // read this string, so none of them caught it; the FIRST live delegate printed the lie on sight.
  // Hence both halves below: promising context a peer will not have is the same bug mirrored.
  ok('...and the confirmation describes the birth that ACTUALLY happened (branched, with context)',
    /staffing a new "frontend" peer/.test(okr.message)
    && /BRANCHED from this conversation/.test(okr.message)
    && !/starts FRESH with its OWN conversation/.test(okr.message));
  // The COLD fallback is real (a caller that never persisted a conversation has nothing to branch),
  // and it must NOT inherit the branched wording — that would promise context the peer lacks.
  const VSNC = 'invite-nocv-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${VSNC}.json`),
    JSON.stringify({ pid: process.pid, cwd: vrepo, convId: null }));
  const cold = I.staffRole(VSNC, 'coldpeer', NOHIST);
  ok('...and a caller with NO conversation to branch is told COLD, not promised a context',
    /starts COLD/.test(cold.message) && !/BRANCHED/.test(cold.message)
    && !/--fork-session/.test(psOf()));
  ok('...naming the two things a COLD peer DOES learn the job from: its duty file and the board',
    /roles\/coldpeer\.md and the board/.test(cold.message));

  // ---- REVIVE vs FORK: the whole reason one verb can cover a closed peer ----------------
  // A vacant claim remembers the CONVERSATION of the session that held the role. If that
  // transcript still exists, resuming it brings the peer back AS ITSELF — everything it learned,
  // still there. Forking the caller instead would hand the role's NAME to a session with none of
  // its MEMORY, which is exactly the failure that makes a peer no better than a subagent.
  //
  // And --fork-session is the bit that decides which one you get: resume WITH it and you get a
  // copy of the CALLER wearing the role's name; resume WITHOUT it and the real peer walks back in.
  RM3.ensureBoard(RM3.resolveBoard(vrepo));
  const vboard = RM3.resolveBoard(vrepo);
  RM3.claimRole(vboard, 'ghost', DEAD_PID, 'ghost-sess', 'ghost-conv-777');   // held, then died
  ok('a vacant claim (dead pid + a convId) is what makes a closed peer revivable',
    !!RM3.vacantClaimForRole(vboard, 'ghost')
    && RM3.vacantClaimForRole(vboard, 'ghost').convId === 'ghost-conv-777');

  const rev = I.staffRole(VS, 'ghost', { spawn: rec, hasWt: true, hasTranscript: () => true });
  ok('REVIVE: a closed peer with a live transcript resumes ITS OWN conversation, NOT the caller\'s',
    rev.ok === true && rev.revived === true
    && /-Resume ghost-conv-777/.test(psOf()) && !/conv-abc-123/.test(psOf()));
  ok('...and CRUCIALLY without --fork-session — a fork would be a copy of ME wearing its name',
    !/--fork-session/.test(psOf()));
  ok('...and it says so, because "it is back with what it knew" is the whole point',
    /REVIVING "ghost"/.test(rev.message) && /comes back as itself/.test(rev.message));

  // The convId is a LEAD, not a guarantee: the conversation may have been deleted or purged, and
  // `--resume <gone>` dies with "No conversation found" — a tab that opens only to fail.
  const gone = I.staffRole(VS, 'ghost', { spawn: rec, hasWt: true, hasTranscript: () => false });
  ok('a vacant claim whose TRANSCRIPT IS GONE is BORN fresh (never resumes into a corpse)',
    gone.ok === true && gone.revived === false && !/ghost-conv-777/.test(psOf()));
  // ...but "not the corpse" is not "no context": the two conversations are DIFFERENT ids and only
  // one of them is dead. Falling back to a cold birth here would silently punish the peer for
  // having been purged — it would come back knowing less than a peer who never existed.
  ok('...and it still forks the CALLER, so a purged peer is reborn with context, not blank',
    /-Resume conv-abc-123/.test(psOf()) && /-Fork/.test(psOf()));
  RM3.releaseRole(vboard, 'ghost', DEAD_PID);

  // A ROLE MOVE MUST NOT BURN THE REVIVE POINTER (fired live 2026-07-18): releaseRole used to
  // unlink the claim outright, destroying the convId — the next `arc delegate` for the old role
  // then silently BIRTHED A STRANGER in the chair's name (audit's chair, in production, after a
  // mis-adoption moved its session to another role). Now it tombstones exactly like closePeer.
  const ghostTomb = RM3.readClaimFile(vboard, 'ghost');
  ok('releaseRole leaves a TOMBSTONE, not a void — the convId survives the release',
    !!ghostTomb && !ghostTomb.pid && ghostTomb.convId === 'ghost-conv-777');
  ok('...which still reads VACANT (a pid-less claim holds nothing)',
    RM3.roleClaim(vboard, 'ghost') === null);
  ok('...and stays findable for revive (vacantClaimForRole sees the conversation)',
    (RM3.vacantClaimForRole(vboard, 'ghost') || {}).convId === 'ghost-conv-777');
  RM3.claimRole(vboard, 'bare-release', DEAD_PID, 'br-sess', null);
  RM3.releaseRole(vboard, 'bare-release', DEAD_PID);
  ok('...while releasing a claim with NO convId unlinks it (nothing to revive — the chair is bare)',
    !RM3.readClaimFile(vboard, 'bare-release'));

  // ---- THE FRESHNESS BRIEF: a revived peer must not trust a world that moved -------------------
  // The zombie failure mode: a peer working from a stale snapshot is CONFIDENTLY WRONG, not slow.
  // A revive now posts the code's movement to the peer's own chair, so its first injection hands
  // it over with the packet. Real git repo, real commits, a transcript whose mtime IS "last sat".
  {
    const frepo = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
    const g = (args, env) => spawnSync('git', ['-C', frepo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
      { encoding: 'utf8', env: { ...process.env, ...(env || {}) } });
    g(['init', '-qb', 'main']);
    fs.mkdirSync(path.join(frepo, '.arc', 'roles'), { recursive: true });
    fs.writeFileSync(path.join(frepo, '.arc', 'roles', 'sleeper.md'), 'owns: everything here\n');
    fs.writeFileSync(path.join(frepo, 'old.txt'), 'ancient');
    const back = new Date(Date.now() - 7200000).toISOString();     // 2h ago — BEFORE the nap
    g(['add', '-A'], null); g(['commit', '-qm', 'ancient history'], { GIT_AUTHOR_DATE: back, GIT_COMMITTER_DATE: back });
    // the peer slept from 1h ago; its transcript's mtime is the honest "last sat"
    const tp = path.join(frepo, 'fake-transcript.jsonl');
    fs.writeFileSync(tp, '{}\n');
    const lastSat = Date.now() - 3600000;
    fs.utimesSync(tp, new Date(lastSat), new Date(lastSat));
    // the world moves while it sleeps: one code commit, one CHARTER commit
    fs.writeFileSync(path.join(frepo, 'moved.txt'), 'new world');
    g(['add', '-A'], null); g(['commit', '-qm', 'the world moved'], null);
    fs.writeFileSync(path.join(frepo, '.arc', 'roles', 'sleeper.md'), 'owns: everything, REWRITTEN\n');
    g(['add', '-A'], null); g(['commit', '-qm', 'sleeper duty rewritten'], null);

    const fboard = RM3.resolveBoard(frepo); RM3.ensureBoard(fboard);

    // lastTurnAt reads the last CONTENT timestamp, not the file mtime — the mtime lied on the first
    // real revive because the resume bumped it before it was read. Prove content wins over mtime:
    // a transcript whose last entry is OLD but whose file was just TOUCHED must report the OLD turn.
    const realTp = path.join(path.dirname(tp), 'ct-conv.jsonl');
    const oldTurn = Date.now() - 5 * 3600000;
    fs.writeFileSync(realTp, JSON.stringify({ type: 'x' }) + '\n' + JSON.stringify({ timestamp: new Date(oldTurn).toISOString() }) + '\n');
    fs.utimesSync(realTp, new Date(), new Date());               // touch: mtime = NOW, content unchanged
    // point transcriptPath at it by putting it where the resolver looks
    const projDir = path.join(require('os').homedir(), '.claude', 'projects', 'E--fresh-ct-' + process.pid);
    fs.mkdirSync(projDir, { recursive: true }); fs.copyFileSync(realTp, path.join(projDir, 'ct-conv.jsonl'));
    const seen = I.lastTurnAt('ct-conv', { at: Date.now() });
    ok('lastTurnAt reports the last TURN from content, not the file mtime (the bug that shipped)',
      Math.abs(seen - oldTurn) < 2000);
    ok('...and falls back to the claim time when no transcript timestamp exists (safe lower bound)',
      I.lastTurnAt('no-such-conv-' + process.pid, { at: oldTurn }) === oldTurn);
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}

    const brief = I.freshnessBrief(fboard, 'sleeper', lastSat);
    ok('the brief names what landed while the peer slept — and NOT what predates its nap',
      brief && brief.commits === 2 && /the world moved/.test(brief.body)
      && /duty rewritten/.test(brief.body) && !/ancient history/.test(brief.body));
    ok('...and shouts when the CHARTER changed — a contract the peer has never read',
      brief.charterChanged === true && /YOUR CHARTER CHANGED/.test(brief.body));
    ok('...and tells the peer to verify what it remembers, not to trust it',
      /Verify anything you remember/.test(brief.body));
    // +2s: git commit dates truncate to the SECOND, so --since=now still matches a commit made in
    // this same second. "Slept later than every commit" needs to clear that granularity.
    ok('a peer whose nap saw NO commits gets NO note — a brief that always fires is noise',
      I.freshnessBrief(fboard, 'sleeper', Date.now() + 2000) === null);
    // paths: scoping — commits outside the declared globs are not the peer's movement...
    fs.writeFileSync(path.join(frepo, '.arc', 'roles', 'scoped.md'), 'owns: docs only\npaths: docs/**\n');
    g(['add', '-A'], null); g(['commit', '-qm', 'scoped role added'], null);
    const scoped = I.freshnessBrief(fboard, 'scoped', lastSat);
    ok('paths: scopes the brief — movement outside the declared globs is not this peer\'s movement',
      scoped === null || !/the world moved/.test(scoped.body));

    // THE SHA-RANGE INSTRUMENT (audit #149): --since keys off COMMITTER DATE, so on a two-machine
    // repo a commit pulled with an OLD date is HIDDEN even though the peer never saw it — a
    // confidently-incomplete brief, the cross-machine zombie. Reproduced and fixed: anchor on the
    // last-seen HEAD sha and brief <sha>..HEAD (ancestry, immune to date skew).
    const srepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sha-'));
    const sg = (a, e) => spawnSync('git', ['-C', srepo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8', env: { ...process.env, ...(e || {}) } });
    sg(['init', '-qb', 'main']);
    fs.mkdirSync(path.join(srepo, '.arc', 'roles'), { recursive: true });
    fs.writeFileSync(path.join(srepo, '.arc', 'roles', 'sl.md'), '# sl\nowns: all\n');
    const oldDate = '2026-07-17T09:00:00';
    fs.writeFileSync(path.join(srepo, 'base'), '1'); sg(['add', '-A']); sg(['commit', '-qm', 'base'], { GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate });
    const sbd = RM3.resolveBoard(srepo); RM3.ensureBoard(sbd);
    const seenSha = sg(['rev-parse', 'HEAD']).stdout.trim();
    RM3.stampSeen(sbd, 'sl', seenSha);              // the peer last saw HEAD=base
    // a commit lands with an OLD committer date (a pull of an old-dated commit) AFTER the wall-clock lastSat
    fs.writeFileSync(path.join(srepo, 'x'), '1'); sg(['add', '-A']); sg(['commit', '-qm', 'PULLED old-dated commit'], { GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate });
    const wallLastSat = Date.parse('2026-07-17T14:00:00');
    ok('the SHA-range brief CATCHES a pulled old-dated commit that --since would hide (cross-machine zombie fixed)',
      (() => { const b = I.freshnessBrief(sbd, 'sl', wallLastSat, { sinceRef: seenSha }); return b && b.anchored === 'sha' && /PULLED old-dated/.test(b.body); })());
    ok('...while the --since fallback (no sha) HIDES it — the exact hole, so the fix is load-bearing',
      I.freshnessBrief(sbd, 'sl', wallLastSat, {}) === null);
    // a sha that is NOT an ancestor of HEAD (rewritten history) falls back cleanly, never errors
    ok('an unreachable sinceRef falls back to --since instead of erroring on a bad range',
      (() => { const b = I.freshnessBrief(sbd, 'sl', wallLastSat, { sinceRef: 'deadbeef'.repeat(5) }); return b === null; })());   // falls to --since=14:00 -> old dates -> null
    fs.rmSync(srepo, { recursive: true, force: true });

    // audit #170: the seen-marker must be a LOWER bound (turn-START HEAD), not an upper bound
    // (turn-END). Stamped at turn end, a commit ANOTHER peer lands MID-turn is <= my turn-end HEAD
    // yet I never read it -> marked seen -> hidden from my next brief FOREVER (silent zombie, arc's
    // own multi-agent case). stampSeenHead records the HEAD the peer sees NOW keyed to its role, and
    // the switch-hook calls it at TURN START. Here: stamp A (turn start), another peer commits B
    // mid-life, revive -> the brief MUST include B (over-report is safe; hiding it is the bug).
    const zrepo = fs.mkdtempSync(path.join(os.tmpdir(), 'zombie-'));
    const zg = (a) => spawnSync('git', ['-C', zrepo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
    zg(['init', '-qb', 'main']);
    fs.mkdirSync(path.join(zrepo, '.arc', 'roles'), { recursive: true });
    fs.writeFileSync(path.join(zrepo, '.arc', 'roles', 'zz.md'), '# zz\nowns: all\n');
    fs.writeFileSync(path.join(zrepo, 'a'), '1'); zg(['add', '-A']); zg(['commit', '-qm', 'A base']);
    const zbd = RM3.resolveBoard(zrepo); RM3.ensureBoard(zbd);
    const ZS = 'zombie-sess-' + process.pid;
    const zRoleFile = NI.roleFile(ZS);
    fs.mkdirSync(path.dirname(zRoleFile), { recursive: true });
    fs.writeFileSync(zRoleFile, JSON.stringify({ board: zbd.root, role: 'zz' }));
    const stampedA = NI.stampSeenHead(ZS, zrepo);                       // TURN START: peer stamps the HEAD it sees (=A)
    const headA = zg(['rev-parse', 'HEAD']).stdout.trim();
    ok('stampSeenHead records the CURRENT HEAD keyed to the session role (turn-start lower bound)',
      stampedA === headA && (RM3.readSeen(zbd, 'zz') || {}).sha === headA);
    fs.writeFileSync(path.join(zrepo, 'b'), '1'); zg(['add', '-A']); zg(['commit', '-qm', 'B by another peer mid-turn']);
    const zbrief = I.freshnessBrief(zbd, 'zz', Date.now(), { sinceRef: (RM3.readSeen(zbd, 'zz') || {}).sha });
    ok('a MID-turn commit by another peer is BRIEFED, not silently skipped (audit #170 lower-bound)',
      zbrief && zbrief.anchored === 'sha' && /B by another peer/.test(zbrief.body));
    ok('stampSeenHead fails safe (returns null) for a session that holds no role',
      NI.stampSeenHead('no-such-sess-' + process.pid, zrepo) === null);

    // REGRESSION (latent, found while moving the stamp): arc-switch-hook must guard its stdin/run
    // wiring behind require.main === module. Without it, merely REQUIRING the hook runs run('') on
    // the empty-stdin `end` -> deliverBoard delivers the board and ADVANCES the read cursor as a
    // side effect of a require (a syntax check once consumed a note this way). With a role + an
    // unread note + ARC_SESSION set, requiring the module in a child MUST stay silent and leave the
    // note unread. Exports run so it is requirable as a library at all.
    RM3.appendNote(zbd, { from: 'other', to: 'zz', kind: 'fyi', body: 'unread note to prove the cursor is untouched' });  // from ANOTHER role: a self-note is not unread-to-self
    const unreadBefore = RM3.unreadFor(zbd, 'zz').count;
    // The child runs in zrepo (so resolveCwd -> zbd -> ZS's role matches and the OLD code WOULD
    // inject) and requires the hook by ABSOLUTE path (zrepo has no src/). On the guarded code the
    // require is inert, so stdout carries no injection and the cursor never moves.
    const swHook = path.join(SRC, 'arc-switch-hook.js').replace(/\\/g, '/');
    const gchild = spawnSync(process.execPath, ['-e', `const m=require(${JSON.stringify(swHook)}); process.stderr.write(typeof m.run);`],
      { cwd: zrepo, input: '', encoding: 'utf8', env: { ...process.env, ARC_SESSION: ZS } });
    ok('requiring arc-switch-hook is side-effect-free: exports run, emits NO injection, leaves the cursor unadvanced (require.main guard)',
      gchild.stderr === 'function' && !/hookSpecificOutput/.test(gchild.stdout || '') && RM3.unreadFor(zbd, 'zz').count === unreadBefore && unreadBefore >= 1);
    try { fs.unlinkSync(zRoleFile); } catch {}
    fs.rmSync(zrepo, { recursive: true, force: true });

    // INTEGRATION: a real REVIVE posts the brief to the chair; a BIRTH never does.
    const FRS = 'fresh-sess-' + process.pid;
    fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${FRS}.json`),
      JSON.stringify({ pid: process.pid, cwd: frepo, convId: 'caller-conv-fresh' }));
    RM3.claimRole(fboard, 'sleeper', DEAD_PID, 'sleeper-sess', 'sleeper-conv-1');   // held, then died
    const frec = [];
    const revd = I.staffRole(FRS, 'sleeper', {
      spawn: (cmd, args) => { frec.push({ cmd, args }); return { status: 0 }; },
      hasWt: true, hasTranscript: () => true,
      // lastSat is captured BEFORE the spawn (the race fix); inject the peer's last-turn time so
      // the test does not depend on a real transcript's content timestamp.
      lastTurnAt: () => lastSat,
      ensureTrusted: () => ({ ok: true, already: true }),
    });
    const briefNotes = RM3.allNotes(fboard).filter((n) => n.from === 'arc' && n.to === 'sleeper' && /WHILE YOU WERE OUT/.test(n.body));
    ok('a REVIVE posts the brief to the chair, from arc — the first injection will hand it over',
      revd.ok === true && revd.revived === true && briefNotes.length === 1 && /commit\(s\) landed since you last sat/.test(briefNotes[0].body));
    ok('...and tells the CALLER it briefed, with the count',
      /briefed: \d+ commit\(s\) landed while it slept/.test(revd.message));
    const born = I.staffRole(FRS, 'newcomer', {
      spawn: (cmd, args) => ({ status: 0 }), hasWt: true, hasTranscript: () => false,
      ensureTrusted: () => ({ ok: true, already: true }),
    });
    ok('a BIRTH posts no brief — a newborn has no stale memory to warn about',
      born.ok === true && born.revived === false
      && RM3.allNotes(fboard).filter((n) => n.from === 'arc' && n.to === 'newcomer').length === 0);
    try { fs.unlinkSync(path.join(CLAUDE, 'cache', `arc-state-${FRS}.json`)); } catch {}
  }

  // Account pinning: conversations live in per-account profiles — a tab that auto-selected a
  // different account would not find the transcript and the fork would die.
  const oldAcct = process.env.ARC_RUNTIME_ACCOUNT;
  process.env.ARC_RUNTIME_ACCOUNT = 'veneto';
  I.staffRole(VS, 'backend', NOHIST);
  // The account still pins: a REVIVE resumes a conversation that only exists in that profile, and
  // a birth must land in the profile whose hooks/settings the caller is already running under.
  ok('staffing PINS the caller\'s account (a revive resumes a conv that exists only there)',
    /-Account veneto/.test(psOf()) && /-Role backend/.test(psOf()));
  if (oldAcct === undefined) delete process.env.ARC_RUNTIME_ACCOUNT; else process.env.ARC_RUNTIME_ACCOUNT = oldAcct;

  // No wt: fall back to a fresh console window via `start`.
  I.staffRole(VS, 'scout', { spawn: rec, hasWt: false, hasTranscript: () => false });
  ok('without Windows Terminal, staffing falls back to a new console window',
    /cmd \/c start "arc: scout"/.test(psOf()));

  // A failing launcher must be REPORTED, not swallowed. The obvious guard was WRONG: spawnSync
  // returns status:NULL on both real failure paths — timeout (ETIMEDOUT) and missing binary
  // (ENOENT) — so `status !== 0 && status !== null` fired on NEITHER and invite printed its ✓
  // with no tab. The exact silent no-tab the guard existed to catch. (Found by the scout peer.)
  const badExit = I.staffRole(VS, 'flaky', { spawn: () => ({ status: 1 }), hasWt: true, hasTranscript: () => false });
  ok('a launcher that exits non-zero is reported (never a silent no-tab)',
    badExit.ok === false && /could not open the new tab/.test(badExit.message));
  // A TIMEOUT IS NOT A FAILURE, and this test used to assert that it was. Reported by the peer it
  // disowned: staffRole printed "no peer was started" while quiettest sat reading it — pwsh ->
  // arc-runner -> claude.exe, alive, holding the role. The launcher DETACHES (wt hands off over
  // COM; Start-Process returns before its child is up), so 5s elapsing means WE STOPPED WATCHING,
  // not that nothing started. Worse than the wrong message: requestDelegate aborts on ok:false, so
  // THE PACKET WAS NEVER POSTED — the orphan booted with no work, claimed the chair, and nothing
  // came looking for it, because the one session that knew it might exist was told it did not.
  // That is the INVERSE of the silent-no-tab above, and strictly worse: a no-tab wastes a claim; a
  // ghost-with-no-task wastes a claim, a quota, and the chair.
  const slow = I.staffRole(VS, 'flaky', {
    spawn: () => ({ status: null, error: { code: 'ETIMEDOUT' } }), hasWt: true, hasTranscript: () => false });
  ok('a TIMEOUT does NOT claim "no peer was started" — the spawn detaches and may have survived',
    slow.ok === true && slow.unverified === true && !/no peer was started/.test(slow.message));
  ok('...it says arc did not SEE it land, and how to check — an unverified spawn is not a plain ✓',
    /did NOT see this land/.test(slow.message) && /arc role/.test(slow.message));
  // ENOENT is different in kind: with no binary, nothing can have started. Keep it fatal.
  const badEnoent = I.staffRole(VS, 'flaky', {
    spawn: () => ({ status: null, error: { code: 'ENOENT' } }), hasWt: true, hasTranscript: () => false });
  ok('...but a MISSING BINARY (ENOENT) stays fatal — nothing can start without it',
    badEnoent.ok === false && /ENOENT/.test(badEnoent.message));

  // The peer's tab STARTS named by its role (--title). It is no longer pinned there with
  // --suppressApplicationTitle: that flag suppressed Claude Code's own title AND its green
  // working-icon (one OSC channel), leaving a spawned tab looking dead beside a hand-launched
  // one. The human chose the live icon over the pinned label (2026-07-17) — Claude Code
  // retitles the tab from the project folder, same as every other session.
  I.staffRole(VS, 'titled', NOHIST);
  ok('the peer tab STARTS titled by role (--title), and no longer suppresses the app title/icon',
    /--title 'titled' -d /.test(psOf()) && !/--suppressApplicationTitle/.test(psOf()));

  // ---- the trust dialog: the invited tab has NO HUMAN to answer it -------------------
  // Claude Code asks "Do you trust the files in this folder?" per PROJECT PATH, per account
  // profile. Found live: invite launched at the CANONICAL board root ("e:\\arc") while the
  // caller ran as "E:\\arc" — a DIFFERENT project key, so it inherited none of the caller's
  // trust and the tab sat at the dialog forever: claimed, deaf, silent about why.
  const canonRoot2 = RM3.resolveBoard(vrepo).root;   // canonical = LOWERCASED (board identity)
  I.staffRole(VS, 'pathcheck', NOHIST);
  ok('staffing launches at the CALLER\'s real path, NOT the canonical (lowercased) board root',
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
  // there is no path by which delegating a role can trust somewhere else.
  let trustedPath = null;
  I.staffRole(VS, 'auditor', {
    spawn: rec, hasWt: true, hasTranscript: () => false,
    ensureTrusted: (dir) => { trustedPath = dir; return { ok: true, already: true }; },
  });
  ok('staffing ONLY ever trusts the caller\'s own repo root — never an arbitrary path',
    trustedPath === RM3.repoRoot(vrepo));

  fs.rmSync(prof, { recursive: true, force: true });

  // Refusals — every one is a zero-token block and must NOT spawn anything.
  spawned = null;
  ok('delegate with no role shows usage', I.requestDelegate(VS, '', vrepo, NOHIST).ok === false);
  ok('delegate refuses an invalid role name',
    /invalid role/.test(I.requestDelegate(VS, 'bad!role', vrepo, NOHIST).message));
  // A delegation is a QUESTION, so it needs a return address: the caller must hold a role of its
  // own. This must refuse BEFORE staffing — it ran in the other order once, and a roleless caller
  // got a flat "claim a role first" while the peer it never heard about was already booting.
  spawned = null;
  const noRole = I.requestDelegate(VS, 'helper "do a thing"', vrepo, NOHIST);
  ok('delegate refuses a caller with NO ROLE of its own (nobody for the peer to reply to)',
    noRole.ok === false && /you hold no role/.test(noRole.message));
  ok('...and it refused WITHOUT spawning the tab (a refusal that opened a window would be a lie)',
    spawned === null);

  // THE ARG SPLIT: first token = the role, EVERYTHING after = the packet. `arc delegate frontend
  // fix the login bug` must not be read as a five-word role name — that split is what lets the
  // verb carry the work, and quoting the packet has to stay optional (agents forget quotes).
  NI.requestRole(VS, 'caller', vrepo);
  const split = I.requestDelegate(VS, 'splitcheck fix the login bug', vrepo, NOHIST);
  ok('delegate splits <role> from the rest as the PACKET (unquoted words are work, not a role)',
    split.ok === true && split.role === 'splitcheck'
    && /You are the splitcheck peer now/.test(bornPrompt.text));
  ok('...and the packet is posted as a REQUEST, so the caller is owed an answer',
    RM3.allNotes(RM3.resolveBoard(vrepo)).some((n) =>
      n.to === 'splitcheck' && n.kind === 'request' && /fix the login bug/.test(n.body)));
  // THE PACKET MUST SURVIVE AN UNVERIFIED SPAWN — the half of quiettest's finding that actually
  // hurt. requestDelegate aborts on !staffed.ok, so while a timeout was read as failure the packet
  // was never posted: the orphan booted with no work, claimed the chair, and nothing ever came
  // looking for it, because the one session that knew it might exist had been told it did not.
  // Posting is safe in BOTH worlds — a note to an empty chair keeps for whoever claims it next —
  // so the bad case costs one note and the good case saves a peer from booting blind.
  const dTimeout = I.requestDelegate(VS, 'ghostpeer do the thing', vrepo, {
    spawn: () => ({ status: null, error: { code: 'ETIMEDOUT' } }),
    hasWt: true, hasTranscript: () => false, writeScript: () => 'C:/T/p.txt' });
  ok('a timed-out spawn STILL posts the packet (an orphan must never boot with no work)',
    dTimeout.ok === true && RM3.allNotes(RM3.resolveBoard(vrepo)).some((n) =>
      n.to === 'ghostpeer' && n.kind === 'request' && /do the thing/.test(n.body)));
  ok('...and says the spawn was unverified rather than printing a clean ✓',
    /did NOT see this land/.test(dTimeout.message));
  // A SESSION whose own home is not a repo: there is no board to invite anyone onto.
  const noRepo3 = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-nr-'));
  const VS3 = 'invite-norepo-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${VS3}.json`),
    JSON.stringify({ pid: process.pid, cwd: noRepo3, convId: 'c9' }));
  ok('staffing refuses when the SESSION is not in a git repo (same guard as a claim)',
    /not a git repository/.test(I.staffRole(VS3, 'frontend', NOHIST).message));
  // THE ENFORCEMENT: the folder we launch in and pre-trust comes from the RUNNER'S recorded cwd,
  // never from the caller's argument — otherwise an agent could `cd` into any repo on the machine
  // and have invite pre-trust it. The security rule was documentation; now it is enforced.
  // (Found by the scout peer.)
  let trustedFrom = null;
  I.requestDelegate(VS, 'sneaky', noRepo3, {        // a HOSTILE cwd argument: a different folder
    spawn: rec, hasWt: true, hasTranscript: () => false,
    ensureTrusted: (dir) => { trustedFrom = dir; return { ok: true, already: true }; },
  });
  ok('a caller-supplied cwd CANNOT redirect the launch or the trust (agent-forgeable input)',
    trustedFrom === RM3.repoRoot(vrepo) && psOf().includes(`-d '${vrepo}'`));
  ok('...and staffRole cannot even be ASKED to: the cwd is not a parameter, it is read from the session',
    I.staffRole.length === 3);
  spawned = null;    // that one legitimately spawned; the refusal assertions below need a clean slate
  // A held role: the would-be invite target already exists — point at the note instead.
  const board3 = RM3.resolveBoard(vrepo); RM3.ensureBoard(board3);
  RM3.claimRole(board3, 'research', process.pid, 'other-sess', null);
  const heldr = I.staffRole(VS, 'research', NOHIST);
  ok('staffRole refuses a role a LIVE session already holds — that session IS the peer',
    heldr.ok === false && /already held/.test(heldr.message) && /arc note research/.test(heldr.message));
  // No conversation id: nothing to fork.
  const VS2 = 'invite-noconv-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${VS2}.json`), JSON.stringify({ pid: process.pid, cwd: vrepo }));
  // THIS REFUSAL IS GONE, and its absence is the fix. Staffing used to need the CALLER to own a
  // saved conversation, because it forked one — so a caller whose id was not yet knowable could
  // not staff anyone. A peer is now BORN with its own conversation, so the caller's id is
  // irrelevant to whether a peer can exist.
  spawned = null;
  const noConv = I.staffRole(VS2, 'frontend', NOHIST);
  ok('a caller with NO conversation of its own can still staff a peer (birth needs nothing of yours)',
    noConv.ok === true && !/nothing to fork/.test(noConv.message || ''));
  spawned = null;   // that one legitimately spawned
  ok('no refusal ever spawned anything', spawned === null);

  // The runner-side enabler: a FORK must skip the duplicate-conversation guard AND must not
  // claim (or later release) the source conversation's lock — claimConv would overwrite the
  // real owner's lock file, after which the owner could not even restart itself.
  const runnerSrc = fs.readFileSync(path.join(SRC, 'arc-runner.js'), 'utf8');
  ok('the duplicate-launch guard skips forks (staffing forks a LIVE caller by design)',
    /isFork = userArgs\.includes\('--fork-session'\)/.test(runnerSrc)
    && /!forceDup && !isFork && guardConv/.test(runnerSrc));

  fs.rmSync(vrepo, { recursive: true, force: true });
  fs.rmSync(noRepo3, { recursive: true, force: true });
} catch (e) { ok('arc delegate -> staffRole', false, e.message + '\n' + (e.stack || '')); }

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

  // ROLE-AWARE reachability (deafness-hunt, 2026-07-18): a listener armed for role X does not hear
  // role Y, so a session that changed roles is DEAF on the new one even though a listener is alive.
  ok('isWaitingAs distinguishes the role the listener is armed FOR (X-listener != reachable as Y)',
    A.isWaitingAs(WS, 'research') === true && A.isWaitingAs(WS, 'other-role') === false);

  // GENUINENESS (opt-in {genuine:true}): a marker whose pid was RECYCLED onto a new process reads
  // alive but is not our listener. Genuine iff the process started BEFORE the marker was written;
  // a recycled pid started after. Forge the recycle: our own live pid, but a marker timestamped
  // LONG BEFORE this process could have started (at: 1000 = 1970) — a genuine arm stamps `at` after
  // the process starts, so at<<start means "not the process that armed this."
  fs.writeFileSync(A.awaitFile(WS), JSON.stringify({ pid: process.pid, role: 'research', at: 1000 }));
  ok('a bare (cheap) check still trusts isAlive — the statusline badge pays no probe',
    A.isWaiting(WS) === true);
  ok('...but {genuine:true} CONVICTS a recycled pid (marker predates the live process) and sweeps it',
    A.isWaiting(WS, { genuine: true }) === false && !fs.existsSync(A.awaitFile(WS)));
  // ...while a GENUINE live listener (marker stamped at arm time, after start) survives {genuine:true}.
  A.markWaiting(WS, 'research', process.pid);            // markWaiting stamps at = now (after our start)
  ok('...and a genuine live listener survives the genuineness guard',
    A.isWaitingAs(WS, 'research', { genuine: true }) === true);
  // The genuine probe must be FRESH, not warm (audit #295): the 30s warm cache can serve a dead
  // predecessor's start and so KEEP the <=30s recycle window this guard exists to close. Source-
  // pinned (a warm/fresh contrast needs cache gymnastics in a child; the wiring is what matters).
  ok('...and it uses a FRESH probe (procStarts {fresh}), closing the warm-cache recycle window',
    /procStarts\(\[m\.pid\], \{ fresh: true \}\)/.test(fs.readFileSync(path.join(SRC, 'arc-await.js'), 'utf8')));

  // THE property that decides whether a crash makes a session permanently deaf: the test is
  // LIVENESS, not existence. A stale marker left by a dead waiter must re-arm — otherwise the
  // session never hears another note and nothing ever tells it why.
  A.markWaiting(WS, 'research', DEAD_PID);               // verified-dead at suite start
  ok('a DEAD waiter does not count — the session re-arms instead of going deaf forever',
    A.isWaiting(WS) === false);
  ok('...and the stale marker is swept, not left to rot', !fs.existsSync(A.awaitFile(WS)));

  ok('clearWaiting is idempotent (safe on an already-gone marker)',
    (() => { try { A.clearWaiting(WS); A.clearWaiting(WS); return true; } catch { return false; } })());

  // RE-ARMING must not leak. markWaiting overwrites the marker, so a previous listener for the
  // same session would keep polling while being unfindable BY session — an invisible orphan
  // that nothing could ever clean up. Re-arming is routine (a manual `arc join`, a restart's
  // re-arm), so each one would leak a process for the rest of the machine's uptime.
  // (Found by the first live peer loop: a duplicate `join code` survived a restart this way.)
  // GRACEFUL SUPERSEDE (2026-07-18): re-arming used to process.kill the previous listener,
  // which enforced one-listener-per-session but reported the DESIGNED displacement as a
  // task "failed with exit code 1" — recurring false alarm. Now the new arm just overwrites
  // the marker; the old listener notices the ownership change within one poll and stands
  // down ITSELF: exit 0, says "superseded", and — load-bearing — does NOT clear the marker,
  // which now belongs to its successor. (The successor pid below is THIS test process — the
  // marker liveness-sweep would eat a dead pid before the displaced listener could see it.)
  const sup = spawnSync(process.execPath, ['-e',
    `process.env.ARC_SESSION = ${JSON.stringify(WS)};`
    + `const A = require(${JSON.stringify(path.join(SRC, 'arc-await.js'))});`
    + `const p = A.awaitOnce('research', ${JSON.stringify(repo)}, { pollMs: 25, write: (l) => console.log(l) });`
    + `setTimeout(() => A.markWaiting(${JSON.stringify(WS)}, 'research', ${process.pid}), 80);`   // a newer listener takes the chair
    + `p.then((c) => { const w = A.waitingFor(${JSON.stringify(WS)});`
    + `console.log(JSON.stringify({ code: c, marker: w && w.pid })); process.exit(c); });`,
  ], { encoding: 'utf8', timeout: 8000, env: { ...process.env, ARC_SESSION: WS } });
  const supTail = (() => { try { return JSON.parse(sup.stdout.trim().split('\n').pop()); } catch { return {}; } })();
  ok('a displaced listener stands down GRACEFULLY: exit 0, says superseded (no false "failed" alarm)',
    sup.status === 0 && /superseded by a newer listener/.test(sup.stdout));
  ok('...and leaves the SUCCESSOR\'s marker untouched (clearing it would deafen the session)',
    supTail.marker === process.pid);
  A.clearWaiting(WS);   // test hygiene: release the marker we planted as the successor

  // DECLINE A REDUNDANT RE-ARM (audit #317): if a GENUINE live listener already holds this role, a
  // second `arc join` must NOT supersede it — a malformed/piped re-arm that prints "listening" then
  // dies would otherwise trade a WORKING listener for nothing, leaving the session deaf. Plant a
  // genuine live listener (this test process — marker.at=now is after our own start, so {genuine}
  // accepts it), then run a real awaitOnce for the same role: it must EXIT 0 saying "already armed",
  // and leave the existing marker INTACT (not overwrite it with its own about-to-die pid).
  A.markWaiting(WS, 'research', process.pid);
  const dec = spawnSync(process.execPath, ['-e',
    `process.env.ARC_SESSION = ${JSON.stringify(WS)};`
    + `const A = require(${JSON.stringify(path.join(SRC, 'arc-await.js'))});`
    + `A.awaitOnce('research', ${JSON.stringify(repo)}, { pollMs: 25, write: (l) => console.log(l) })`
    + `.then((c) => { const w = A.waitingFor(${JSON.stringify(WS)}); console.log(JSON.stringify({ code: c, marker: w && w.pid })); process.exit(c); });`,
  ], { encoding: 'utf8', timeout: 8000, env: { ...process.env, ARC_SESSION: WS } });
  const decTail = (() => { try { return JSON.parse(dec.stdout.trim().split('\n').pop()); } catch { return {}; } })();
  ok('a redundant arm DECLINES when a genuine live listener already holds the role (keeps the proven one)',
    dec.status === 0 && /ALREADY armed/i.test(dec.stdout));
  ok('...and leaves the EXISTING listener\'s marker intact (a malformed re-arm cannot orphan a working one)',
    decTail.marker === process.pid);
  A.clearWaiting(WS);

  // awaitOnce checks the board SYNCHRONOUSLY on entry (inside the Promise executor), so a note
  // that is already waiting is reported before the first poll interval — no wait, no flake.
  RM.appendNote(board, { from: 'android', to: 'research', body: 'investigate the tap drop' });
  const said = [];
  // Session-scoped like every other awaitOnce in the suite: bare, this inherited the DEVELOPER'S
  // live ARC_SESSION and displaced their real listener on every suite run (as a silent kill
  // before the graceful supersede made it visible, 2026-07-18).
  const prevEnv3 = process.env.ARC_SESSION;
  process.env.ARC_SESSION = WS;
  A.awaitOnce('research', repo, { pollMs: 5, write: (l) => said.push(l) });
  if (prevEnv3 === undefined) delete process.env.ARC_SESSION; else process.env.ARC_SESSION = prevEnv3;
  A.clearWaiting(WS);
  ok('a note already on the board is seen immediately (no polling delay)',
    said.some((l) => /investigate the tap drop/.test(l)));
  ok('...and it tells the woken agent to run `arc notes` (a wake is not a turn, so the',
    said.some((l) => /arc notes/.test(l)));   // ...turn-start injection does NOT fire for it
  ok('await only OBSERVES — it never advances the read cursor',
    RM.readCursor(board, 'research') === 0 && RM.unreadFor(board, 'research').count === 1);

  // A listener exists to WAKE ITS SESSION. When that session dies it has nothing left to wake,
  // and nothing stops it: it is a detached background process whose poll loop would happily run
  // for the rest of the machine's uptime. Found by the first live peer loop — five listeners alive,
  // most of them orphans of long-dead sessions, each still polling the board every 2.5s.
  const ORPH = 'orphan-sess-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${ORPH}.json`),
    JSON.stringify({ pid: DEAD_PID, cwd: repo }));        // verified-dead at suite start
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
  ok('tasks is shared (so /arc-switch keeps the task list)', P.SHARED_DIRS.includes('tasks'));

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

// ---- arc-help + the /arc-help hook (zero-token cheat sheet) -------------------
section('arc-help + /arc-help hook');
try {
  const renderHelp = require(path.join(SRC, 'arc-help.js'));
  ok('arc-help exports a render function', typeof renderHelp === 'function');
  const sheet = renderHelp();
  ok('cheat sheet teaches /arc-help and /arc-switch (colon retired)', /\/arc-help/.test(sheet) && /\/arc-switch/.test(sheet) && !/arc:help/.test(sheet) && !/arc:switch /.test(sheet));

  // End-to-end: the hook must BLOCK /arc-help and its alias (case-insensitive) and
  // return the sheet as the reason — zero model tokens, exactly like /arc-peek.
  const hook = path.join(SRC, 'arc-switch-hook.js');
  // /arc-help is the primary verb; /arc-arc is the alias — BOTH must trigger.
  for (const trig of ['/arc-help', '/arc-arc', '/ARC-HELP']) {
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ prompt: trig }), encoding: 'utf8' });
    let out = {}; try { out = JSON.parse(r.stdout || '{}'); } catch {}
    ok(`hook blocks "${trig}" with the cheat sheet`, out.decision === 'block' && /(arc|cl) — commands/.test(out.reason || ''));
  }
  // A non-command prompt must pass straight through (no block, empty stdout).
  const pass = spawnSync(process.execPath, [hook], { input: JSON.stringify({ prompt: 'hello world' }), encoding: 'utf8' });
  ok('non-command prompt passes through (no block)', (pass.stdout || '').trim() === '');
} catch (e) { ok('/arc-help hook works', false, e.message); }

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

  // 2) the board self-ignores — from .arc/.gitignore, covering the WHOLE .arc
  R.ensureBoard(rTop);
  const gi = fs.readFileSync(path.join(path.dirname(rTop.planDir), '.gitignore'), 'utf8');
  ok('the .arc .gitignore ignores everything (incl. itself)', /^\*$/m.test(gi));
  ok('...and peer/ carries no per-dir pair of its own', !fs.existsSync(path.join(rTop.planDir, '.gitignore')) && !fs.existsSync(path.join(rTop.planDir, '.gitattributes')));

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
  // /arc-restart re-execs arc-runner: SAME session, NEW pid → must reclaim its own role.
  ok('same session reclaims under a NEW pid (restart-safe)', R.claimRole(rTop, 'coding', process.pid + 1, 's1').ok === true);
  fs.writeFileSync(path.join(rTop.planDir, 'claim-coding.json'), JSON.stringify({ role: 'coding', pid: DEAD_PID, sessionId: 's9', at: Date.now() }));
  ok('a DEAD holder\'s claim is vacant', R.roleClaim(rTop, 'coding') === null);
  ok('a vacant role can be claimed by anyone', R.claimRole(rTop, 'coding', process.pid, 's3').ok === true);
  ok('liveRoles lists live holders only', R.liveRoles(rTop).map((l) => l.role).join(',') === 'coding');

  // ---- A PID IS NOT AN IDENTITY -----------------------------------------------------------
  // Windows recycles pids and arc spawns node for every hook, so a closed peer's pid gets taken.
  // Caught live on the whalephone board: `research` (pid 9512) read dead → LIVE → dead across
  // three probes with the session closed throughout. A dead process cannot resurrect — a stranger
  // had its pid. Cost of believing it: a note nobody answers, and staffRole refusing to revive
  // ("already held") — the chair becomes unfillable.
  //
  // No pid recycling needed to test it: an impostor is EXACTLY a claim that predates its own
  // process, so backdating one reproduces the bug deterministically.
  const genuine = { role: 'genuine', pid: process.pid, sessionId: 'g1', convId: 'g-conv', at: Date.now() };
  const impostor = { role: 'impostor', pid: process.pid, sessionId: 'i1', convId: 'i-conv',
    at: Date.now() - 6 * 60 * 60 * 1000 };   // claimed 6h ago; this process is minutes old
  fs.writeFileSync(path.join(rTop.planDir, 'claim-genuine.json'), JSON.stringify(genuine));
  fs.writeFileSync(path.join(rTop.planDir, 'claim-impostor.json'), JSON.stringify(impostor));

  ok('a claim written AFTER its process started is genuine (the normal case still works)',
    R.isHolder(genuine) === true && !!R.roleClaim(rTop, 'genuine'));
  ok('...but a claim that PREDATES its own process is an impostor — a recycled pid, not a peer',
    R.isHolder(impostor) === false && R.roleClaim(rTop, 'impostor') === null);
  ok('...so liveRoles hides it, and the ghost peer disappears from the roster',
    R.liveRoles(rTop).map((l) => l.role).sort().join(',') === 'coding,genuine');
  // The worst face of the bug: the chair reads "held" so nothing may staff it, while the session
  // that could answer is gone. Vacancy and liveness MUST be decided by the same rule.
  ok('...and CRUCIALLY the squatted chair is revivable — vacancy uses the same rule as liveness',
    !!R.vacantClaimForRole(rTop, 'impostor')
    && R.vacantClaimForRole(rTop, 'impostor').convId === 'i-conv');
  ok('...while a genuinely live role is NOT offered up for revival',
    R.vacantClaimForRole(rTop, 'genuine') === null);

  // THE FACT THAT DECIDES THE NEXT MOVE, and it was invisible. A role that HAS worked here keeps
  // its own conversation, so it can return AS ITSELF — a different and better offer than staffing
  // a stranger. The roster only ever said `closed`. Caught live on whalephone: `frontend` had
  // written the very README under review and WAS revivable (vacant claim + transcript), but the
  // android peer read "NOBODY HOLDS" and offered the human a fresh session or a hand-commit —
  // never the one option that was right. arc had the fact and did not say it.
  const N9 = require(path.join(SRC, 'arc-notes.js'));
  const S9 = 'revive-hint-' + process.pid;
  fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${S9}.json`),
    JSON.stringify({ pid: process.pid, cwd: rTop.root, convId: 'mine-9' }));
  N9.requestRole(S9, 'asker', rTop.root);
  fs.mkdirSync(path.join(rTop.root, '.arc', 'roles'), { recursive: true });
  fs.writeFileSync(path.join(rTop.root, '.arc', 'roles', 'ghostrole.md'), 'owns: the web surface\n');
  // a vacant claim whose conversation IS still on disk => revivable
  R.claimRole(rTop, 'ghostrole', DEAD_PID, 'gone-sess', 'ghost-conv-live');
  const rev = N9.requestNote(S9, 'ghostrole "please review this"', rTop.root,
    { hasTranscript: () => true });
  ok('an empty chair whose conversation SURVIVES is offered as REVIVABLE, not as a stranger',
    /HAS WORKED HERE BEFORE/.test(rev.message) && /come back AS ITSELF/.test(rev.message)
    && /REVIVES it/.test(rev.message));
  ok('...and it says to prefer that over rebuilding the context yourself',
    /already has the context you would be rebuilding/.test(rev.message));
  for (const f of [`arc-state-${S9}.json`, `arc-role-${S9}.json`]) { try { fs.unlinkSync(path.join(CLAUDE, 'cache', f)); } catch {} }
  R.releaseRole(rTop, 'ghostrole', DEAD_PID);
  try { fs.unlinkSync(path.join(rTop.root, '.arc', 'roles', 'ghostrole.md')); } catch {}

  // THE TIMEZONE TRAP, as a regression guard. PowerShell's `.StartTime.Ticks` encodes the LOCAL
  // wall clock; read as epoch it lands TZ-offset hours in the future (here: +8h), every genuine
  // claim looks like it predates its own process, and EVERY peer on the board reads as dead.
  // `.ToFileTimeUtc()` is the correct one. This catches that instantly.
  const starts = R.procStarts([process.pid]);
  if (starts) {
    const drift = Math.abs(starts[process.pid] - (Date.now() - process.uptime() * 1000));
    ok('procStarts agrees with our OWN start time (a TZ mix-up would be hours out, not seconds)',
      drift < 5000, `drift ${Math.round(drift / 1000)}s — .Ticks instead of .ToFileTimeUtc()?`);
  } else ok('procStarts agrees with our OWN start time', true, '(skipped: OS could not be asked)');

  // THE BUG THE PEER FOUND, and the reason this check nearly never ran. `-ErrorAction
  // SilentlyContinue` suppresses the error MESSAGE but NOT the exit status: probe a batch where
  // any pid has since died and powershell prints perfect output for the survivors and STILL exits
  // 1. The old guard read `status !== 0` as "cannot ask" and failed open — voiding the impostor
  // check for the whole batch, in exactly the case it exists for (a squatter is by definition a
  // transient process, so it is the likeliest thing to exit mid-probe).
  // A LIVE pid batched with a DEAD one must still resolve. This is the regression guard, and it
  // MUST run cold: procStarts memoises in-process AND caches to disk, so an in-process call here
  // answers from cache and never probes — the first version of this test passed with the bug
  // reintroduced, proving only that the cache worked. Fresh process, cache deleted.
  // DEAD_PID is INTERPOLATED into the child's source (the child process has no access to the
  // suite's consts); the all-dead batch uses its odd siblings — odd pids are unallocatable on
  // Windows, so they stay dead even without an individual liveness probe.
  const probeJs = `const fs=require('fs'),os=require('os'),path=require('path');
    try{fs.unlinkSync(path.join(os.homedir(),'.claude','cache','arc-pidstart.json'))}catch{}
    const R=require(${JSON.stringify(path.join(SRC, 'arc-board.js'))});
    const mixed=R.procStarts([process.pid,${DEAD_PID}]);
    const allDead=R.procStarts([${DEAD_PID - 4},${DEAD_PID - 8}]);
    process.stdout.write(JSON.stringify({
      liveResolved: !!mixed && typeof mixed[process.pid]==='number',
      deadIsGone:   !!mixed && mixed[${DEAD_PID}]===null,
      allDeadIsAnswer: !!allDead && allDead[${DEAD_PID - 4}]===null && allDead[${DEAD_PID - 8}]===null,
    }));`;
  let cold = {};
  try { cold = JSON.parse(spawnSync(process.execPath, ['-e', probeJs], { encoding: 'utf8' }).stdout || '{}'); } catch {}
  ok('a batch containing a pid that DIED mid-probe still resolves the survivors',
    cold.liveResolved === true,
    'powershell exits 1 here — judging by exit code fails OPEN and voids the whole check');
  ok('...and the dead pid reads as gone, not as "cannot ask"', cold.deadIsGone === true);
  // ...while a batch of ONLY dead pids is still an ANSWER (they are gone), not a failure.
  ok('a batch where EVERY pid is gone is an answer ("gone"), never mistaken for "cannot ask"',
    cold.allDeadIsAnswer === true);
  // The marker is what separates those two: "every pid gone" and "powershell never ran" both
  // give empty stdout + nonzero status. Reading the second as the first would mark every peer an
  // impostor — fail-CLOSED, which invites a second session into an occupied chair.
  const boardSrc = fs.readFileSync(path.join(SRC, 'arc-board.js'), 'utf8');
  ok('the probe proves it RAN with a marker, never with the exit code',
    /PROBE_OK/.test(boardSrc) && /out\.includes\(PROBE_OK\)/.test(boardSrc)
    && !/r\.status !== 0/.test(boardSrc));

  // FAIL OPEN when the OS cannot be asked. Reading a LIVE peer as dead is the worse error — it
  // invites a second session into an occupied chair, where two peers share one cursor and eat
  // each other's notes. Unsure must mean "behave exactly as arc always did".
  ok('when the OS cannot be asked, a live-looking claim is TRUSTED (never block work on doubt)',
    R.isHolder(impostor, null) === true);
  // A claim from before this field existed has no `at` to compare — trust the pid, as before.
  ok('a LEGACY claim with no timestamp still resolves (no flag day, no orphaned peers)',
    R.isHolder({ role: 'old', pid: process.pid }) === true);
  for (const f of ['claim-genuine.json', 'claim-impostor.json']) fs.unlinkSync(path.join(rTop.planDir, f));

  // ---- the FALSE-LIVE edge and its fresh-probe cure (audit #259) ------------------------------
  // isHolder's warm pid-start cache can serve a DEAD predecessor's start for ≤30s: a recycled pid
  // then reads as the genuine holder, and `arc delegate` posts a packet into a dead chair while
  // telling the delegator it was handled. procStarts({fresh:true}) is the cure — it bypasses
  // exactly the cache being doubted. Proven here in a FRESH child process (the suite's own memo
  // already holds our real start, so the lie must be planted before arc-board ever loads):
  // the child seeds the disk cache with a fabricated start (epoch 1000) for THIS suite's pid,
  // builds a claim written BEFORE our process really started (at: 1500 — an impostor's shape),
  // and asserts the warm path believes it while the fresh path convicts it.
  const falseLiveJs = `const fs=require('fs'),os=require('os'),path=require('path');
    const cachePath=path.join(os.homedir(),'.claude','cache','arc-pidstart.json');
    fs.mkdirSync(path.dirname(cachePath),{recursive:true});
    fs.writeFileSync(cachePath,JSON.stringify({${process.pid}:{start:1000,at:Date.now()}}));
    const R=require(${JSON.stringify(path.join(SRC, 'arc-board.js'))});
    const claim={role:'x',pid:${process.pid},sessionId:'s',at:1500};
    const warmSaysLive=R.isHolder(claim);
    const fresh=R.procStarts([${process.pid}],{fresh:true});
    const freshStart=fresh&&fresh[${process.pid}];
    const freshSaysLive=fresh?R.isHolder(claim,fresh):null;
    const warmAfter=R.procStarts([${process.pid}]);
    process.stdout.write(JSON.stringify({warmSaysLive,freshSaysLive,
      freshIsReal:typeof freshStart==='number'&&freshStart>1000000000000,
      wroteThrough:!!warmAfter&&warmAfter[${process.pid}]===freshStart}));`;
  let fl = {};
  try { fl = JSON.parse(spawnSync(process.execPath, ['-e', falseLiveJs], { encoding: 'utf8' }).stdout || '{}'); } catch {}
  ok('the warm cache BELIEVES a fabricated predecessor start (that is the documented ≤30s window)',
    fl.warmSaysLive === true, '(if this fails the fixture is broken, not the code)');
  ok('...a FRESH probe bypasses the warm lie and reads the real start',
    fl.freshIsReal === true);
  ok('...and isHolder with fresh starts CONVICTS the impostor the warm cache admitted',
    fl.freshSaysLive === false);
  ok('...and the fresh answer writes through, so later warm checks in the same flow agree',
    fl.wroteThrough === true);
  // The cure must actually be WIRED where false-live costs the most — the delegate paths.
  const invSrc2 = fs.readFileSync(path.join(SRC, 'arc-invite.js'), 'utf8');
  ok('requestDelegate fresh-probes before believing "live" (single-role path)',
    /procStarts\(\[rawClaim\.pid\], \{ fresh: true \}\)/.test(invSrc2));
  ok('...and delegateMany batch-probes its targets the same way',
    /procStarts\(alivePids, \{ fresh: true \}\)/.test(invSrc2));
  ok('...and an unaskable OS is reported as "could not verify", never asserted as live',
    /could not VERIFY/.test(invSrc2) && /liveness UNVERIFIED/.test(invSrc2));
} catch (e) { ok('arc-board works', false, e.message + '\n' + (e.stack || '')); }

// ---- arc-notes (the board commands over the ledger) ---------------------------
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

  // sessionConv: THE FRESHER FILE WINS. State-first stamped audit's conv onto research's claim
  // in the 2026-07-18 misfile (a picker-resume hosts a NEW conversation while the state still
  // names the old one until reconcile) — the claim then misdirects the role's next revive.
  {
    const SC = 'conv-fresh-' + process.pid;
    const stP = path.join(cache, `arc-state-${SC}.json`);
    const brP = path.join(cache, `arc-active-${SC}.json`);
    const old = new Date(Date.now() - 60000), fresh = new Date();
    fs.writeFileSync(stP, JSON.stringify({ pid: process.pid, cwd: repo2, convId: 'conv-state' }));
    ok('sessionConv: state alone answers (the ordinary launch)', F.sessionConv(SC) === 'conv-state');
    fs.writeFileSync(brP, JSON.stringify({ convId: 'conv-bridge' }));
    fs.utimesSync(stP, old, old); fs.utimesSync(brP, fresh, fresh);
    ok('...a FRESHER bridge wins — the statusline ticks with what the session ACTUALLY hosts',
      F.sessionConv(SC) === 'conv-bridge');
    fs.utimesSync(stP, fresh, fresh); fs.utimesSync(brP, old, old);
    ok('...and a FRESHER state wins back (a relaunch outdates the dead claude\'s last bridge)',
      F.sessionConv(SC) === 'conv-state');
    fs.unlinkSync(stP); fs.unlinkSync(brP);
    ok('...neither file = null (never an invented conversation)', F.sessionConv(SC) === null);
  }

  // roles claimed from a SUBDIR still land in the repo-root board
  const ra = F.requestRole('sa', 'research', path.join(repo2, 'sub'));
  ok('arc role claims a role from a subdir (board = repo root)', ra.ok === true && /the "proj" board/.test(ra.message));
  // The claim makes you ADDRESSABLE, not yet reachable-while-idle — a listener needs a TURN.
  // The result carries armNeeded so the prompt hook can SPEND one (pass-through) to arm; the
  // message carries the instruction for the CLI path, where the agent is already mid-turn.
  ok('...and a fresh claim reports armNeeded + the exact arm command',
    ra.armNeeded === true && ra.role === 'research' && /arc join research/.test(ra.message));
  ok('arc role coding (second peer)', F.requestRole('sb', 'coding', repo2).ok === true);
  const rc = F.requestRole('sc', 'coding', repo2);
  ok('a third session is REFUSED a held role', rc.ok === false && /already held by a LIVE session/.test(rc.message));

  // THE "RIVAL" WHO IS YOU. ARC_SESSION is pid-derived, so a Claude process that RESPAWNS gets a
  // new one — and a caller that CACHED the old id asks under a name arc has never seen, so its own
  // claim looks like a stranger's. Reported by whalephone/android (#58): four failed `arc join` in
  // a row, each blaming a pid that WAS them post-respawn, while the Stop hook kept demanding a
  // re-arm that kept failing. They escaped only by printing ARC_SESSION by hand and noticing it had
  // changed. The CONVERSATION survives a respawn and was on the claim the whole time, uncompared.
  {
    const OLD = 'respawn-old-' + process.pid, NEW = 'respawn-new-' + process.pid;
    const CONV = 'same-conv-6665bfca';
    // both ids bridge to the SAME conversation — that is what makes them the same session
    for (const s of [OLD, NEW]) {
      fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${s}.json`),
        JSON.stringify({ pid: process.pid, cwd: repo2, convId: CONV }));
    }
    ok('(setup) the post-respawn session claims the role', F.requestRole(NEW, 'respawner', repo2).ok === true);
    const stale = F.requestRole(OLD, 'respawner', repo2);
    ok('a stale ARC_SESSION re-claiming its OWN role is told THAT IS YOU, not blamed on a rival',
      stale.ok === false && /THAT IS YOU/.test(stale.message)
      && !/Pick another name, or close that session/.test(stale.message));
    ok('...showing BOTH ids, so the mismatch is visible instead of inferred',
      stale.message.includes(OLD) && stale.message.includes(NEW));
    ok('...and naming the root cause: ARC_SESSION is ambient, never cache it',
      /CACHED ARC_SESSION/.test(stale.message) && /arc join respawner/.test(stale.message));
    // A GENUINE rival — different conversation — must still be refused the old way, or this fix
    // would hand one session another's cursor.
    const OTHER = 'respawn-other-' + process.pid;
    fs.writeFileSync(path.join(CLAUDE, 'cache', `arc-state-${OTHER}.json`),
      JSON.stringify({ pid: process.pid, cwd: repo2, convId: 'a-different-conversation' }));
    const rival = F.requestRole(OTHER, 'respawner', repo2);
    ok('...but a DIFFERENT conversation is still refused as a real rival (no cursor sharing)',
      rival.ok === false && /already held by a LIVE session/.test(rival.message) && !/THAT IS YOU/.test(rival.message));
  }

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
  ok('arc note needs a role', F.requestNote('sc', 'coding hi', repo2).ok === false);
  ok('arc note rejects a note to yourself', F.requestNote('sa', 'research hi', repo2).ok === false);
  ok('arc note usage error on bad args', F.requestNote('sa', 'onlyone', repo2).ok === false);
  ok('arc note appends', F.requestNote('sa', 'coding P-014 spec changed', repo2).ok === true);
  ok('arc note broadcast (all)', F.requestNote('sa', 'all repo layout moved', repo2).ok === true);


  // notes readout + rd()-only cursor
  const n1 = F.requestNotes('sb', '', repo2);
  ok('arc notes shows both (addressed + broadcast)', /2 new from research/.test(n1.message));
  const n2 = F.requestNotes('sb', '', repo2);
  ok('arc notes is empty after reading (cursor advanced)', /nothing new/.test(n2.message));
  const board2 = R2.resolveBoard(repo2);
  ok('notes were NOT consumed', R2.noteCount(board2) === 2);
  // rd()-only, proved properly: coding just read everything, yet a DIFFERENT reader
  // still finds the broadcast waiting. A note is never taken off the board.
  ok('a fresh role still sees the broadcast after coding read it', R2.unreadFor(board2, 'qa').count === 1);
  ok('research never sees its own two notes', R2.unreadFor(board2, 'research').count === 0);
  const nAll = F.requestNotes('sc', 'all', repo2);
  ok('arc notes all = landlord view, no role needed', /ALL 2 note\(s\)/.test(nAll.message));

  // restart: same session, NEW pid → role + claim survive
  mkSession('sb', process.pid + 1);                       // simulate arc-runner re-exec
  const rr = F.refreshRole('sb', process.pid + 1, repo2);
  ok('refreshRole re-asserts the claim after restart', rr && rr.ok === true && rr.role === 'coding');
  ok('and the role still resolves for that session', F.getRole('sb', board2) === 'coding');
  ok('refreshRole is a no-op for a session with no role and no conversation', F.refreshRole('zz', 999, repo2) === null);

  // THE POST CONFIRMATION IS A RECEIPT, NOT A CHEER. `arc.cmd` is `node arc-runner.js %*`, and
  // cmd.exe ends the argument list at a NEWLINE — so a multi-line body posted through that shim
  // arrives cut at its first paragraph, and the CLI printed a ✓ over the top of it. Reported from
  // whalephone (#129) after three real losses in one session: a 4,407-char review stored as 536,
  // handoffs that kept their PROMISE ("two items below") and dropped the SUBSTANCE. arc cannot see
  // the cut — the bytes died in the shim, before the runner ran — but it must never claim more
  // than it holds. So the number it prints is read back off the STORED body, and asserted here
  // against the ledger itself: a receipt that ever reports the SENT length, or a hardcoded one,
  // fails instead of reassuring.
  // On its OWN board: this posts a note, and the shared fixture's neighbours count unread.
  const rrepo = path.join(base2, 'receipt'); fs.mkdirSync(path.join(rrepo, '.git'), { recursive: true });
  const rboard = R2.resolveBoard(rrepo); R2.ensureBoard(rboard);
  mkSession('rc', process.pid); F.requestRole('rc', 'research', rrepo);
  const multiBody = 'PROMISE: two items below\n\nITEM ONE — the substance\nITEM TWO — also the substance';
  const rcpt = F.requestNote('rc', 'coding ' + multiBody, rrepo);
  const storedBody = R2.allNotes(rboard).slice(-1)[0].body;
  const claimed = (rcpt.message.match(/(\d+) chars stored/) || [])[1];
  ok('a post reports the STORED length — a silent truncation cannot hide behind a ✓',
    rcpt.ok === true && claimed !== undefined && Number(claimed) === storedBody.length);
  ok('...and a multi-line body survives newlines end to end (the shim is what cut them, not arc)',
    storedBody === multiBody && storedBody.includes('ITEM TWO'));

  // --body-file: THE ROOT FIX for whalephone #129. The receipt above makes a truncation VISIBLE;
  // this makes it IMPOSSIBLE. cmd.exe cuts the argument list at a newline before arc ever starts,
  // so nothing arc does can recover the bytes — the body must not be in argv at all. A path has no
  // newlines. Asserted against the LEDGER: the file's full text, newlines and all, is what lands.
  const bfPath = path.join(rrepo, 'packet.md');
  const bfBody = 'PROMISE: three items\n\nONE — survives\nTWO — survives\nTHREE — the tail cmd.exe eats';
  fs.writeFileSync(bfPath, bfBody + '\n');            // a real editor leaves a trailing newline
  const bf = F.requestNote('rc', 'coding --kind request --body-file ' + bfPath, rrepo);
  const bfStored = R2.allNotes(rboard).slice(-1)[0];
  ok('--body-file carries a multi-line body whole — the text never enters argv, so it cannot be cut',
    bf.ok === true && bfStored.body === bfBody && bfStored.kind === 'request'
    && /(\d+) chars stored/.test(bf.message));
  ok('--body-file refuses when an inline body is ALSO given (one would silently win)',
    F.requestNote('rc', 'coding --body-file ' + bfPath + ' and some inline text', rrepo).ok === false);
  ok('--body-file names an unreadable path instead of posting an empty note',
    F.requestNote('rc', 'coding --body-file ' + path.join(rrepo, 'nope.md'), rrepo).ok === false);

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

  // AMBIGUITY = CORRUPTION, DO NOT GUESS. A conversation owns exactly one role; two VACANT claims
  // sharing a convId is the whalephone bug (a uiux session found both claim-quiz and claim-uiux
  // under its conversation and was silently adopted into quiz, the readdir-first). vacantClaimForConv
  // must refuse rather than hand over a chair that might not be the session's.
  {
    const arepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ambi-'));
    spawnSync('git', ['init', '-q'], { cwd: arepo });
    const ab = R2.resolveBoard(arepo); R2.ensureBoard(ab);
    const shared = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    // both vacant (dead pid), both carrying the SAME conversation — the corrupt state
    R2.claimRole(ab, 'quiz', DEAD_PID, 'q-sess', shared);
    R2.claimRole(ab, 'uiux', DEAD_PID, 'u-sess', shared);
    ok('two VACANT claims sharing a convId → vacantClaimForConv REFUSES (no silent mis-adoption)',
      R2.vacantClaimForConv(ab, shared) === null);
    // and a session resuming that conversation is NOT dropped into either chair
    writeJSON(path.join(cache, 'arc-state-resumer.json'), { pid: process.pid, cwd: arepo, convId: shared });
    const r = F.refreshRole('resumer', process.pid, arepo, shared);
    ok('...so a resuming session adopts NEITHER — it claims fresh via its charter instead',
      r === null || (r.role !== 'quiz' && r.role !== 'uiux') || r.adopted !== true);
    // the single-match case still works — this must not over-refuse
    R2.claimRole(ab, 'quiz', process.pid, 'q-live', shared);   // quiz now LIVE, so only uiux is vacant
    ok('...but exactly ONE vacant match still adopts cleanly (uiux, quiz now live)',
      (R2.vacantClaimForConv(ab, shared) || {}).role === 'uiux');
    try { fs.unlinkSync(path.join(cache, 'arc-state-resumer.json')); } catch {}
  }

  // M4 (audit #271): the FILENAME is the authority for which chair a claim file is. A corrupt payload
  // whose role disagrees with its filename must NOT rename the chair during adoption — else a
  // hand-tampered/torn claim-quiz.json carrying role:"uiux" adopts uiux, the cross-role boundary the
  // exactly-one-match guard exists to hold.
  {
    const mrepo = fs.mkdtempSync(path.join(os.tmpdir(), 'mrole-'));
    spawnSync('git', ['init', '-q'], { cwd: mrepo });
    const mb = R2.resolveBoard(mrepo); R2.ensureBoard(mb);
    const cv = 'ffffffff-1111-2222-3333-444444444444';
    // ONE physical file (claim-quiz.json) whose PAYLOAD lies about its role
    fs.writeFileSync(path.join(mb.planDir, 'claim-quiz.json'),
      JSON.stringify({ role: 'uiux', pid: DEAD_PID, sessionId: 'x', convId: cv, at: 7000 }));
    const got = R2.vacantClaimForConv(mb, cv);
    ok('vacantClaimForConv trusts the FILENAME role, never a mismatched payload.role (no cross-role adoption)',
      got === null || got.role === 'quiz');
    ok('...and it never hands back the impostor payload role', !got || got.role !== 'uiux');
  }

  // M5 (audit #271): current + legacy files for ONE logical role are migration aliases, not ambiguity.
  // A crash mid-migration leaves claim-uiux + lease-uiux with the same role/convId; that is ONE chair
  // and must still adopt, not be refused as if two different roles collided.
  {
    const lrepo = fs.mkdtempSync(path.join(os.tmpdir(), 'lrole-'));
    spawnSync('git', ['init', '-q'], { cwd: lrepo });
    const lb = R2.resolveBoard(lrepo); R2.ensureBoard(lb);
    const cv = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb';
    const rec = JSON.stringify({ role: 'uiux', pid: DEAD_PID, sessionId: 'u', convId: cv, at: 7000 });
    fs.writeFileSync(path.join(lb.planDir, 'claim-uiux.json'), rec);
    fs.writeFileSync(path.join(lb.planDir, 'lease-uiux.json'), rec);   // the migration crash window
    const got = R2.vacantClaimForConv(lb, cv);
    ok('current + legacy files for ONE logical role adopt cleanly (not a false ambiguity refusal)',
      !!got && got.role === 'uiux');
  }

  // M5 DIVERGENT (audit #289 blocker 4): current claim-uiux belongs to conversation A; a stale vacant
  // lease-uiux names a DIFFERENT conversation B. Resuming B must NOT adopt uiux — the authoritative
  // record for uiux is the CURRENT claim (A), which does not match B. The old order filtered the
  // current claim out first, then "preferred claim" within a set that no longer held it, adopting the
  // stale legacy chair and overwriting the live one.
  {
    const drepo = fs.mkdtempSync(path.join(os.tmpdir(), 'drole-'));
    spawnSync('git', ['init', '-q'], { cwd: drepo });
    const dbd = R2.resolveBoard(drepo); R2.ensureBoard(dbd);
    const convA = 'aaaaaaaa-0000-0000-0000-000000000000';
    const convB = 'bbbbbbbb-0000-0000-0000-000000000000';
    fs.writeFileSync(path.join(dbd.planDir, 'claim-uiux.json'),
      JSON.stringify({ role: 'uiux', pid: DEAD_PID, sessionId: 'a', convId: convA, at: 9000 }));   // CURRENT, conv A
    fs.writeFileSync(path.join(dbd.planDir, 'lease-uiux.json'),
      JSON.stringify({ role: 'uiux', pid: DEAD_PID, sessionId: 'b', convId: convB, at: 7000 }));    // STALE legacy, conv B
    ok('a stale legacy alias naming a DIFFERENT conversation cannot steal the role from the current claim',
      R2.vacantClaimForConv(dbd, convB) === null);
    // and resuming the CURRENT conversation A still adopts uiux cleanly
    ok('...while the current claim\'s own conversation still adopts it',
      (R2.vacantClaimForConv(dbd, convA) || {}).role === 'uiux');
  }

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
  // A REFERENCE STORES THE TARGET'S ID, NOT ITS POSITION. The caller still says `--reply-to 1`
  // (the seq it read); what lands in the ledger is the id that seq resolved to. This asserts the
  // thing that actually matters — it points at the RIGHT NOTE — which "=== 1" never did: a
  // position is only true in one file on one machine, and after a merge the same `replyTo:1`
  // named a different note on each clone.
  ok('--reply-to INFERS kind:result; --supersedes INFERS kind:correction',
    sn2.kind === 'result' && sn2.replyTo === sn1.id && sn3.kind === 'correction' && sn3.supersedes === sn2.id);
  ok('a correction (and a blocker) is auto-HIGH priority — a retraction is never routine',
    sn3.priority === 'high' && R2.appendNote(sboard, { from: 'android', to: 'research', kind: 'blocker', body: 'db down' }).priority === 'high');
  // Keyed by the retracted note's ID — a retraction must keep pointing at the same note after a
  // merge reorders the ledger, which a position cannot do.
  ok('supersededMap derives which note was RETRACTED, and by whom',
    R2.supersededMap(sboard).get(sn2.id).seq === 3 && !R2.supersededMap(sboard).has(sn1.id));
  ok('openRequests finds a request with NO reply, and ignores an answered one',
    (() => { const o = R2.openRequests(sboard).map((n) => n.seq); return o.includes(4) && !o.includes(1); })());
  // A RETRACTED request is not owed. Found by using the board, not by reading it: a request I
  // withdrew the instant I saw it was unanswerable (the packet told the peer NOT to reply) went on
  // being billed as open. Retracting is the sender saying "never mind", and the board already warns
  // readers not to act on the retracted note — so an open debt against it can never be paid, because
  // paying it means replying to a note nobody may act on.
  R2.appendNote(sboard, { from: 'android', to: 'research', kind: 'correction', supersedes: 4, body: 'never mind' });
  ok('...and a RETRACTED request is no longer owed (a debt that could never be paid)',
    !R2.openRequests(sboard).map((n) => n.seq).includes(4));
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
  ok('arc note --kind request is accepted and reported back', F3.ok && /kind: request/.test(F3.message));
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
  // The ALERT clears; the badge itself now reports quiet PRESENCE instead of null, so a healthy
  // role-holder still sees which chair it holds. Asserting `=== null` tested the old contract.
  const cleared = F.badge('sb', repo2);
  ok('badge clears itself once read (no count, no deafness — quiet presence remains)',
    !!cleared && cleared.count === 0 && !cleared.deaf && cleared.quiet === true && cleared.role === 'coding');

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

  // AN ALARM MUST NOT BE BURIED BY VOLUME. Delivery walks oldest-first and stops at the injection
  // budget, so a burst of routine notes can push a BLOCKER past the cut, where it is invisible inside
  // "…and N more still unread". The float-to-top sort cannot help — it only reorders what is SHOWN.
  // Reordering delivery is NOT the fix (the cursor is a high-water mark; picking a later note ahead
  // of an earlier one and advancing past both would silently consume the skipped ones), so the
  // deferred urgent notes must be NAMED instead.
  {
    const filler = 'x'.repeat(900);                         // ~5 of these exhaust INJECT_MAX (4000)
    for (let i = 0; i < 8; i++) R2.appendNote(board2, { from: 'research', to: 'coding', body: `routine ${i} ${filler}` });
    R2.appendNote(board2, { from: 'research', to: 'coding', kind: 'blocker', body: 'THE BURIED BLOCKER' });
    const inj2 = F.injection('sb', repo2);
    ok('a burst of routine notes DOES push the blocker out of this batch (the hazard is real)',
      !!inj2 && inj2.text.indexOf('THE BURIED BLOCKER') < 0 && /more still unread/.test(inj2.text));
    ok('...but the deferred HIGH-PRIORITY note is NAMED, not left inside "N more still unread"',
      !!inj2 && /HIGH PRIORITY/.test(inj2.text) && /<blocker>/.test(inj2.text) && /read THOSE first/.test(inj2.text));
    // and it is still there to be read — deferral must never be consumption
    const inj3 = F.injection('sb', repo2);
    ok('...and the blocker is still delivered on the NEXT batch (deferred, never consumed)',
      !!inj3 && inj3.text.indexOf('THE BURIED BLOCKER') >= 0);
  }

  // A NOTE ADDRESSED TO YOU IS YOUR WORK — deliver it whole. Caught live: `code` sent research a
  // 1400-char review request; it arrived clipped to 400, cut mid-sentence, and 4 of the 5 questions
  // never reached it. It answered anyway ONLY because it had forked the caller's context and could
  // read the original command there — a REVIVED peer has no such inheritance and would have
  // confidently answered 29% of a question. The packet IS the deliverable; clipping it makes the
  // peer do the wrong job with no idea it was shorted.
  // FIXTURE MUST EXCEED THE LIMIT or the test is decoration (research #126): the old fixture was
  // 1,228 chars against DIRECT_CLIP — it could not fail for the invariant it names, and passed GREEN
  // while a real 3,685-char packet lost its only instruction. This one is ~5,000: over the OLD 3,500
  // limit (so it fails against the truncating code) and under the current one (so it delivers whole).
  R2.markRead(board2, 'coding');
  const longPacket = 'PACKET ' + 'x'.repeat(5000) + ' TAIL-MARKER-SURVIVED';
  R2.appendNote(board2, { from: 'research', to: 'coding', kind: 'request', body: longPacket });
  const injLong = F.injection('sb', repo2);
  ok('a long note ADDRESSED TO YOU is delivered whole (the packet is the work)',
    !!injLong && injLong.text.includes('TAIL-MARKER-SURVIVED'));
  ok('...and is NOT clipped nor spilled — a packet under the ceiling arrives intact inline',
    !!injLong && !/⚠ CLIPPED/.test(injLong.text) && !/packet —/.test(injLong.text));

  // OVER the inline ceiling a directed packet is NEVER silently truncated — it SPILLS to a file and
  // hands the path, so the peer reads the WHOLE thing before acting. A bigger constant alone would
  // just move this failure; the spill is what removes it.
  R2.markRead(board2, 'coding');
  const hugePacket = 'HUGE ' + 'q'.repeat(9000) + ' TAIL-IN-FILE';
  R2.appendNote(board2, { from: 'research', to: 'coding', kind: 'request', body: hugePacket });
  const injHuge = F.injection('sb', repo2);
  ok('an over-ceiling directed packet ANNOUNCES a spill, never a silent cut',
    !!injHuge && /this is your WORK, read ALL of it/.test(injHuge.text) && !/⚠ CLIPPED/.test(injHuge.text));
  ok('...and the spilled file exists and carries the WHOLE packet, tail intact',
    !!injHuge && injHuge.spills && injHuge.spills.length === 1
    && fs.existsSync(injHuge.spills[0]) && fs.readFileSync(injHuge.spills[0], 'utf8').includes('TAIL-IN-FILE'));

  // A BROADCAST is ambient FYI — a preview is the point, but the clip must ANNOUNCE itself. An
  // ellipsis is not a warning: silent truncation reads exactly like a peer who answered badly.
  R2.markRead(board2, 'coding');
  R2.appendNote(board2, { from: 'research', to: null, body: 'BCAST ' + 'y'.repeat(900) + ' NEVER-SEEN' });
  const injB = F.injection('sb', repo2);
  ok('a long BROADCAST is previewed, not delivered whole (ambient, not addressed to you)',
    !!injB && !injB.text.includes('NEVER-SEEN'));
  ok('...and the clip SAYS SO, with the command that shows the rest',
    !!injB && /⚠ CLIPPED — \d+ more chars/.test(injB.text) && /arc notes all/.test(injB.text));

  // A CLIP THAT COSTS MORE THAN IT SAVES IS A NET LOSS. The warning is ~95 chars, so hiding four
  // spends ninety to announce them. Measured on arc's OWN first cross-board broadcast: a 404-char
  // note against a 400 limit ate the closing `ipe>"` of the example command it existed to teach,
  // and whalephone had to run `arc notes all` to recover FOUR characters. Reported from there.
  R2.markRead(board2, 'coding');
  const justOver = 'JUST-OVER ' + 'z'.repeat(380) + ' TAIL-KEPT';
  R2.appendNote(board2, { from: 'research', to: null, body: justOver });
  const injSlack = F.injection('sb', repo2);
  ok('a broadcast just OVER the limit prints WHOLE — the warning costs more than it hides',
    !!injSlack && injSlack.text.includes('TAIL-KEPT') && !/⚠ CLIPPED/.test(injSlack.text));

  // AND NEVER MID-WORD. A preview is read by a model deciding whether to fetch the rest; cutting
  // inside a token makes the last thing it sees a lie — "gr" is not a word.
  R2.markRead(board2, 'coding');
  R2.appendNote(board2, { from: 'research', to: null, body: ('alpha bravo charlie delta '.repeat(60)) });
  const injWord = F.injection('sb', repo2);
  const preview = injWord && injWord.text.split('…')[0];
  ok('...and a real clip lands on a WORD boundary, not mid-token',
    !!preview && /(alpha|bravo|charlie|delta)$/.test(preview.trimEnd()));

  // A body with no spaces near the cut (a URL, a base64 blob) must HARD-cut: word-hunting would
  // throw away most of the preview to avoid a boundary that does not exist.
  R2.markRead(board2, 'coding');
  R2.appendNote(board2, { from: 'research', to: null, body: 'h'.repeat(900) });
  const injBlob = F.injection('sb', repo2);
  ok('...but a space-less blob still hard-cuts, rather than losing the preview to word-hunting',
    !!injBlob && injBlob.text.split('…')[0].length > 300);

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
  ok('the capped burst did NOT consume the overflow', R2.unreadFor(board2, 'coding').count === 80 - big.consumed && big.consumed < 80);
  let drained = big.consumed, guard = 0;
  while (R2.unreadFor(board2, 'coding').count && guard++ < 30) drained += F.injection('sb', repo2).consumed;
  ok('the whole backlog drains over turns — every note once, none skipped',
    drained === 80 && R2.unreadFor(board2, 'coding').count === 0);
  // and a returning session catches up in ONE uncapped `arc notes`
  R2.writeCursor(board2, 'coding', 0);
  const expected = R2.unreadFor(board2, 'coding').count;
  const catchUp = F.requestNotes('sb', '', repo2);
  ok('arc notes catches a returning peer up in one uncapped call',
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
  const cxAcc = { id: 'gpt', type: 'api', baseUrl: 'https://gw.example.com', apiKeyEnv: 'ARC_TEST_KEY', model: 'gpt-5.6-sol', proxy: { port: 8791 } };
  const cxEnv = Ccfg.accountEnv(cxAcc, {});
  ok('claudex account: ANTHROPIC_BASE_URL points at the LOCAL translator, not the gateway',
    cxEnv.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8791' && cxEnv.ANTHROPIC_MODEL === 'gpt-5.6-sol');
  ok('claudex account: the real gateway key is NOT leaked into Claude Code\'s env',
    cxEnv.ANTHROPIC_API_KEY === 'claudex' && cxEnv.ANTHROPIC_AUTH_TOKEN === 'claudex' && cxEnv.ANTHROPIC_API_KEY !== 'sk-test-123');

  // MULTI-MODEL: a modelMap maps tiers to GPT models so /model switches among them; when a map
  // is present, ANTHROPIC_MODEL is NOT pinned (else the picker is stuck on one).
  const multiAcc = { id: 'gpt2', type: 'api', baseUrl: 'https://gw.example.com', apiKeyEnv: 'ARC_TEST_KEY', proxy: { port: 8792 }, model: 'gpt-5.6-sol', modelMap: { opus: 'gpt-5.6-sol', sonnet: 'gpt-5.6-terra', haiku: 'gpt-5.6-luna' } };
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
    // ACTIVE grants the ONE verb. This guard is pointed at the CURRENT truth on purpose: it
    // used to assert the opposite (that `arc delegate` was gone — it named a subagent tool we
    // deleted), and it correctly failed the moment the verb came back meaning something else.
    // `invite` is now the dead word: if a directive ever teaches it again, the dial is pointing
    // at a command that does not exist.
    && /arc delegate/.test(St.directive('active'))
    && !/invite/.test(St.directive('active')) && !/invite/.test(St.directive('passive')));
  ok('renderBar marks only the selected notch',
    St.renderBar('balanced').includes('[ balanced ]') && !St.renderBar('balanced').includes('[ active ]'));

  // through the REAL hook: set · reject · open picker
  const swhk = path.join(SRC, 'arc-switch-hook.js');
  const hookAsk = (prompt, sess) => { const r = spawnSync(process.execPath, [swhk], { input: JSON.stringify({ prompt, cwd: TMP }), encoding: 'utf8', env: { ...process.env, ARC_SESSION: sess } }); let o = {}; try { o = JSON.parse(r.stdout || '{}'); } catch {} return o; };
  const S2 = 'stance-hook-1';
  const setOut = hookAsk('/arc-mode active', S2);
  ok('/arc-mode <value> sets the stance via the hook (zero tokens, cross-process)',
    setOut.decision === 'block' && /stance: active/.test(setOut.reason) && St.getStance(S2) === 'active');
  ok('/arc-mode <bad> is rejected and the stance is unchanged',
    /unknown stance/.test(hookAsk('/arc-mode nope', S2).reason || '') && St.getStance(S2) === 'active');
  ok('bare /arc-mode opens the picker (drops a mode trigger)',
    /stance picker/.test(hookAsk('/arc-mode', S2).reason || '')
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

// ---- the headless delegate is REMOVED (and stays removed) -------------------
// It fired a headless one-shot that re-read the repo from scratch and then died: heavier
// than Claude Code's own subagent (in-session, on your quota, can pick its own model) and
// dumber than a PEER (which keeps its context across turns). Squeezed from both sides.
//
// These tests are the tombstone. They exist because /arc-delegate is deliberately STILL
// MATCHED: unmatched, `/arc-delegate <task>` would fall through to the model as an ordinary
// prompt and the agent would just do the task INLINE — the one outcome nobody typing
// "delegate" wants. So the hook must intercept AND redirect, at zero tokens.
//
// Assert against the REAL hook, never a hand-copied regex. The block that used to live here
// inlined its own copy of the hook's trigger regex, and the copy drifted — it still listed the
// long-dead `handoff`. That is exactly how a dead spelling survives a removal unnoticed. So:
// no copies.
section('/arc-delegate tombstone (the hook redirects, never leaks to the model)');
try {
  const swhook = path.join(SRC, 'arc-switch-hook.js');
  const ask = (prompt) => {
    const r = spawnSync(process.execPath, [swhook], { input: JSON.stringify({ prompt, cwd: TMP }), encoding: 'utf8' });
    try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
  };

  ok('the module is GONE', !fs.existsSync(path.join(SRC, 'arc-delegate.js')));

  // The load-bearing one: it must never reach the model. A reason == intercepted == 0 tokens.
  const d = ask('/arc-delegate codex "find why the import test is flaky"');
  ok('/arc-delegate is still INTERCEPTED on the programmatic path (never leaks as a prompt)',
    !!(d.reason || '').length);
  // THE WORD WAS REUSED, and that makes this more than a tombstone. The delegate command once
  // fired a headless one-shot; `arc delegate <role>` is now the agent's peer verb. Someone typing
  // /arc-delegate today means the CURRENT thing, so answering "that was removed" would deny a
  // command that exists and send them to advice the merge superseded.
  ok('...and it answers what the word MEANS NOW (the peer verb), not what it used to mean',
    /arc delegate <role>/.test(d.reason || '') && !/has been removed/i.test(d.reason || ''));
  ok('...and it tells the human to ask in PROSE (we chose not to build them a command)',
    /in prose/i.test(d.reason || '') && /get research on this/i.test(d.reason || ''));
  ok('...while still redirecting the case the OLD tool really served (a stateless one-shot)',
    /SUBAGENT/i.test(d.reason || ''));
  ok('...and it points at /arc-switch for GPT (claudex SURVIVES the removal)',
    /\/arc-switch/.test(d.reason || ''));
  ok('the bare form redirects too (no crash on a missing task)',
    /in prose/i.test(ask('/arc-delegate').reason || ''));
  ok('the RETIRED colon spelling is prose now — the delegate and peek colon forms reach the model unblocked',
    !ask('arc:delegate codex "x"').decision && !ask('arc:peek').decision && !ask('/arc:peek').decision);

  // The sibling removal, kept as a regression: handoff was deleted OUTRIGHT (no redirect), so
  // it must fall through with NO decision at all. Two removals, two deliberate shapes — if
  // these ever converge, someone has broken one of them.
  ok('handoff is GONE with NO redirect — its colon form falls through as a normal prompt',
    !ask('arc:handoff codex').decision && !ask('arc:handoff').decision);

  // Nothing may still import the deleted module: a stale require() throws at RUNTIME, inside
  // a hook, where it stays invisible until it wedges a real session.
  const importers = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))
    .filter((f) => /require\(['"`]\.\/arc-delegate/.test(fs.readFileSync(path.join(SRC, f), 'utf8')));
  ok('no module still requires arc-delegate (a stale require would throw inside a hook)',
    importers.length === 0, importers.join(', '));
} catch (e) { ok('/arc-delegate tombstone', false, e.message + '\n' + (e.stack || '')); }

// ---- the /arc-<verb> slash commands (arc-slash.js) ----------------------------
// One command set, one spelling: /arc-<verb>, with / autocomplete — machine senders
// like the revive prompt ride the same form, programmatically.
// Claude Code hands UserPromptSubmit the RAW typed /command BEFORE skill expansion
// (verified live 2026-07-18: "Original prompt: /arc-peek" on the block label), so the
// hook eats it at zero tokens. Assert against the REAL hook — no copied regexes.
section('/arc-<verb> slash commands (one hook, real handlers, zero tokens)');
try {
  const swhook = path.join(SRC, 'arc-switch-hook.js');
  // ISOLATED spawns: ARC_SESSION cleared (a live session here would let account/board
  // verbs arm real pending markers), ARC_PEEK_NO_REFRESH=1 (peek otherwise fires a
  // REAL synchronous usage fetch against ~/.claude from inside the suite — network
  // I/O and a cache write per ask).
  const ask = (prompt) => {
    const r = spawnSync(process.execPath, [swhook], {
      input: JSON.stringify({ prompt, cwd: TMP }), encoding: 'utf8',
      env: { ...process.env, ARC_SESSION: '', ARC_PEEK_NO_REFRESH: '1' },
    });
    try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
  };
  const SL = require(path.join(SRC, 'arc-slash.js'));
  // Digit-normalized compare: peek embeds live, time-derived text at SECOND
  // granularity ("1s ago", usage %), so byte-equality across separate spawns is a
  // coin flip on a tick boundary. Structure parity is the contract, not the clock.
  const norm = (s) => String(s || '').replace(/\d+/g, '#');
  const sameReason = (a, b) => {
    const ra = ask(a).reason, rb = ask(b).reason;
    return !!(ra || '').length && norm(ra) === norm(rb);
  };

  // PARITY: an alias must produce the same handler output as its primary verb.
  // If these ever diverge, the aliases have become two commands.
  ok('/arc-peek blocks with the usage readout', !!(ask('/arc-peek').reason || '').length);
  ok('/arc-help blocks with the cheat sheet', !!(ask('/arc-help').reason || '').length);
  ok('aliases ride the same alternation: /arc-usage === /arc-peek', sameReason('/arc-usage', '/arc-peek'));
  ok('case-insensitive: /ARC-PEEK blocks',
    !!(ask('/ARC-PEEK').reason || '').length);
  ok('args pass through: /arc-switch <name> answers',
    !!(ask('/arc-switch nosuchaccount').reason || '').length);

  // ARG POLICY: autocomplete inserts the command and the human keeps typing — a
  // trailing arg on a no-arg verb means PROSE, not a command, and firing anyway
  // would restart/erase mid-thought.
  ok('no-arg verb + trailing prose fails OPEN: "/arc-restart after the build finishes"',
    !ask('/arc-restart after the build finishes').decision);
  ok('...same for peek: "/arc-peek explain the output" passes through',
    !ask('/arc-peek explain the output').decision);
  ok('THE RETIREMENT: every colon spelling is prose now — bare, arg-carrying, and hybrid forms all pass',
    !ask('arc:peek').decision && !ask('arc:role research').decision
    && !ask('arc:peek explain').decision && !ask('/arc:peek').decision && !ask('!arc:restart').decision);
  ok('/arc-delete takes ONLY a confirm word: "/arc-delete confirm" dispatches',
    !!(ask('/arc-delete confirm').reason || '').length);
  ok('..."/arc-delete this section about X" is prose and passes through',
    !ask('/arc-delete this section about X').decision);
  // TOKEN-ARG verbs (field report 2026-07-18): "/arc-role Besides this function has
  // an error..." ate the human's message as an invalid role name. An arg that cannot
  // be the argument is prose — fail open.
  ok('/arc-role + prose passes through (a sentence is not a role name)',
    !ask('/arc-role Besides this function has an error to label').decision);
  ok('...but a role-shaped token still dispatches: "/arc-role" bare blocks with the roster',
    !!(ask('/arc-role').reason || '').length);
  ok('/arc-mode + prose passes through; only passive|balanced|active dispatch',
    !ask('/arc-mode I think balanced fits best').decision
    && !ask('/arc-switch to whichever account has headroom').decision);

  // /arc-alarm: the human's tab can raise a board-wide fire alarm at zero tokens (dispatch + EFFECT,
  // on a dedicated board so it can't couple to the shared TMP one). A message dispatches and raises;
  // --clear takes it down. This drives the REAL hook, not a copied regex.
  const AL2 = require(path.join(SRC, 'arc-alarm.js'));
  const B2 = require(path.join(SRC, 'arc-board.js'));
  const arepo3 = fs.mkdtempSync(path.join(os.tmpdir(), 'slashalarm-'));
  spawnSync('git', ['init', '-q'], { cwd: arepo3 });
  const askIn = (prompt, cwd) => {
    const r = spawnSync(process.execPath, [swhook], {
      input: JSON.stringify({ prompt, cwd }), encoding: 'utf8',
      env: { ...process.env, ARC_SESSION: '', ARC_PEEK_NO_REFRESH: '1' } });
    try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
  };
  const raiseAsk = askIn('/arc-alarm the schema changed, everyone stop', arepo3);
  ok('/arc-alarm dispatches and RAISES — blocks with the result, the flag lands on the board',
    /ALARM raised/i.test(raiseAsk.reason || '') && !!AL2.readFlag(B2.resolveBoard(arepo3)));
  ok('...and /arc-alarm --clear dispatches and clears the flag',
    /cleared/i.test(askIn('/arc-alarm --clear', arepo3).reason || '')
    && AL2.readFlag(B2.resolveBoard(arepo3)) === null);
  ok('...a bare "/arc-alarm" with prose still dispatches (a message is not a one-token verb)',
    !!(askIn('/arc-alarm', arepo3).reason || '').length);   // empty -> a helpful "refusing empty" block
  fs.rmSync(arepo3, { recursive: true, force: true });

  // ORDERING TRAP (documented in arc-slash.js): delete-account must not misfire as a
  // conversation delete. Same-handler equality proves the routing.
  ok('/arc-delete-account routes to remove-account, never conversation delete',
    norm(ask('/arc-delete-account x').reason) === norm(ask('/arc-remove-account x').reason));

  // THE FALSE-POSITIVE LINE: a prompt that merely CONTAINS or RESEMBLES a command
  // must never be eaten — a blocked prompt is ERASED, so a false positive here loses
  // the human's message outright. The adversarial review (2026-07-18) REPRODUCED an
  // erasure class in the first draft; each case below is one of its kills, kept as a
  // regression so the laxity can never come back.
  ok('mid-text mention passes through: "the /arc-peek command is neat"',
    !ask('the /arc-peek command is neat').decision);
  ok('prose without the slash passes through: "arc-peek is broken, look"',
    !ask('arc-peek is broken, look').decision);
  ok('unknown verb passes through: /arc-hello',
    !ask('/arc-hello').decision);
  ok('LEADING SPACE is the escape-a-slash-command idiom — " /arc-peek explain..." passes',
    !ask(' /arc-peek explain the output please').decision);
  ok('a second line means it is not a command: "/arc-peek\\nwhy?" passes whole',
    !ask('/arc-peek\nwhy does it show that?').decision);
  ok('...and can never smuggle an ARG: "/arc-switch\\nveneto" passes (no switch fires)',
    !ask('/arc-switch\nveneto').decision);
  ok('a hyphen EXTENDING a verb is not that verb: /arc-note-taker passes',
    !ask('/arc-note-taker hello').decision);
  ok('...nor a filename: "/arc-switch-hook.js is broken, look" passes',
    !ask('/arc-switch-hook.js is broken, look at it').decision);
  ok('a lone trailing newline is still a command: "/arc-peek\\n" blocks',
    !!(ask('/arc-peek\n').reason || '').length);

  // The tombstone: /arc-delegate must intercept — unmatched it would leak to the
  // model as an ordinary prompt.
  ok('/arc-delegate is intercepted and redirects (never reaches the model)',
    /in prose/i.test(ask('/arc-delegate codex "task"').reason || ''));

  // The PARTITION is total and machine-checked: every verb in the alternation is a
  // menu entry, a declared alias, or a declared exclusion — nothing else. A verb added
  // to VERBS without a MENU/ALIASES/EXCLUDED decision is a silent half-command
  // (dispatched by the regex, invisible in the menu, no stub contract) and fails here.
  const menuVerbs = new Set(SL.MENU.map((e) => e.verb));
  const accounted = new Set([...menuVerbs, ...SL.ALIASES, ...SL.EXCLUDED]);
  const unaccounted = SL.VERBS.split('|').filter((v) => !accounted.has(v));
  ok('every VERBS entry is accounted for as menu, alias, or exclusion', unaccounted.length === 0, unaccounted.join(', '));
  const phantom = [...accounted].filter((v) => !SL.VERBS.split('|').includes(v));
  ok('...and nothing declared is missing from the alternation', phantom.length === 0, phantom.join(', '));
  ok('MENU excludes delegate/join/restore by design',
    !SL.MENU.some((e) => ['delegate', 'join', 'restore'].includes(e.verb)));

  // DRIFT GUARD: the checked-in skill stubs are GENERATED from MENU (stubText). If a
  // stub is edited by hand or MENU changes without regenerating, this catches it.
  // CRLF-normalized: without a repo-wide eol policy, a Windows clone under
  // core.autocrlf=true checks these out as CRLF and a raw byte-compare would fail on
  // every fresh machine (.gitattributes pins them to LF, this normalization is the
  // belt to that suspender).
  const stale = SL.MENU.filter((e) => {
    const p = path.join(__dirname, '..', 'skills', `arc-${e.verb}`, 'SKILL.md');
    try { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') !== SL.stubText(e); } catch { return true; }
  }).map((e) => e.verb);
  ok('every /arc-* skill stub on disk matches stubText(MENU) exactly', stale.length === 0, stale.join(', '));

  // THE RESPAWN LOOP GUARD: anything the hook will EAT must be stripped from
  // preserved argv, or it re-submits on every respawn, the hook eats it, drops a
  // trigger, and the runner kills/relaunches FOREVER. The strip asks the hook's OWN
  // regexes: the first fix paired SLASH_RX with a bare hand-copied prefix check and
  // missed the HYBRID spellings the legacy strip tolerates — the same loop through a
  // spelling the fix skipped
  // (both reviews, 2026-07-18, proven with node). stripConvArgs IS exported
  // (arc-runner.js module.exports) — call it directly; if it is ever un-exported this
  // test must FAIL LOUDLY, not silently downgrade to a source grep.
  const RUNNER = require(path.join(SRC, 'arc-runner.js'));
  ok('stripConvArgs strips both spellings on respawn (the infinite-restart guard)',
    RUNNER.stripConvArgs(['/arc-restart']).length === 0
    && RUNNER.stripConvArgs(['/arc-role research']).length === 0
    && RUNNER.stripConvArgs(['arc:restart']).length === 0);
  ok('...including the HYBRID colon spellings the legacy strip tolerates (leading slash, bang, whitespace)',
    RUNNER.stripConvArgs(['/arc:restart']).length === 0
    && RUNNER.stripConvArgs(['!arc:restart']).length === 0
    && RUNNER.stripConvArgs(['  arc:restart']).length === 0);
  ok('...but a plain positional survives (only command spellings are stripped)',
    RUNNER.stripConvArgs(['hello']).length === 1);

  // ---- `arc --resume <role>` — nobody remembers a UUID -------------------------------------
  // The human types the chair's NAME. Before this it went straight to claude, which knows no
  // conversation by that name, so the session came up role-less and nothing said why.
  {
    const RMr = require(path.join(SRC, 'arc-board.js'));
    const rrepo = fs.mkdtempSync(path.join(os.tmpdir(), 'resrole-'));
    spawnSync('git', ['init', '-q'], { cwd: rrepo });
    const rboard = RMr.resolveBoard(rrepo); RMr.ensureBoard(rboard);
    const CONV = '11111111-2222-3333-4444-555555555555';
    // a transcript must EXIST — a vacant claim's convId is a lead, not a guarantee
    const projd = path.join(CLAUDE, 'projects', 'resrole-proj');
    fs.mkdirSync(projd, { recursive: true });
    fs.writeFileSync(path.join(projd, `${CONV}.jsonl`), '{"type":"user"}\n');
    fs.writeFileSync(path.join(rboard.planDir, 'claim-code.json'),
      JSON.stringify({ role: 'code', pid: DEAD_PID, sessionId: 'r-sess', convId: CONV, at: 7000 }));

    const a1 = ['--resume', 'code'];
    const r1 = RUNNER.resolveResumeRole(a1, rrepo);
    ok('`arc --resume <role>` rewrites the role NAME to that chair\'s conversation id',
      !!r1 && r1.ok === true && r1.role === 'code' && a1[1] === CONV);

    // BLOCKER 2 (audit #235): the inline form must NORMALISE to two tokens. Every downstream reader
    // tests exact tokens, so an emitted `--resume=<id>` is invisible to all of them — userManagesConv
    // stays false, a fresh random convId is minted alongside it, and two terminals both clear the
    // duplicate-conversation guard.
    const a2 = ['--resume=code'];
    const r2 = RUNNER.resolveResumeRole(a2, rrepo);
    ok('...the --resume=<role> inline spelling NORMALISES to the bare two-token form',
      !!r2 && r2.ok && a2.length === 2 && a2[0] === '--resume' && a2[1] === CONV);
    ok('...so the userManagesConv gate (which tests EXACT tokens) actually sees it',
      a2.includes('--resume') && RUNNER.explicitConvId(a2) === CONV);

    // audit #235 D still holds: a value outside the role grammar must NEVER touch a claim path.
    // But `--resume` belongs to Claude Code too — uppercase, spaces, and other names may be native
    // `/rename` titles, so arc leaves them for Claude rather than falsely rejecting them as roles.
    for (const nativeName of ['../../../evil', '../../../../Users/yanyu/.claude/arc-config', 'My Session', 'x'.repeat(40)]) {
      const av = ['--resume', nativeName];
      const rv = RUNNER.resolveResumeRole(av, rrepo);
      ok('...a non-role value stays Claude Code\'s native session name without touching a claim path: ' + nativeName.slice(0, 22),
        !!rv && rv.ok === true && rv.native === true && av[1] === nativeName);
    }

    // a SEPARATE-token UUID is already on the working path (explicitConvId + the user-managed gate
    // both read `--resume`), so it is left exactly alone.
    const a3 = ['--resume', CONV];
    ok('...a separate-token UUID is left exactly alone (no lookup, no rewrite)',
      RUNNER.resolveResumeRole(a3, rrepo) === null && a3[1] === CONV);
    // ...but an INLINE `--resume=<uuid>` MUST normalize to two tokens, or the user-managed gate and
    // the duplicate guard never see it and arc mints a random id alongside claude's real resume
    // (audit #289 blocker 3).
    const au = ['--resume=' + CONV];
    const ru = RUNNER.resolveResumeRole(au, rrepo);
    ok('...an inline --resume=<uuid> NORMALISES to the two-token form (gate + duplicate guard see it)',
      !!ru && ru.ok === true && au.length === 2 && au[0] === '--resume' && au[1] === CONV
      && RUNNER.explicitConvId(au) === CONV);
    const a4 = ['--resume'];
    ok('...bare `--resume` stays the interactive picker',
      RUNNER.resolveResumeRole(a4, rrepo) === null && a4.length === 1);
    const a5 = ['--session-id', 'code'];
    ok('...--session-id is NOT translated (it assigns a new id, it does not reopen one)',
      RUNNER.resolveResumeRole(a5, rrepo) === null && a5[1] === 'code');

    // A valid-looking name with no exact chair is still Claude Code's namespace. This is the solo
    // project case: `arc --resume scout` must reach Claude even when this board has no `scout` role.
    const nr = ['--resume', 'scout'];
    const r6 = RUNNER.resolveResumeRole(nr, rrepo);
    ok('...a name with no exact board chair falls through to Claude Code (solo-session projects work)',
      !!r6 && r6.ok === true && r6.native === true && nr[1] === 'scout');
    const ni = ['--resume=scout'];
    const ri = RUNNER.resolveResumeRole(ni, rrepo);
    ok('...a native --resume=<name> normalises to two tokens so arc sees the user-managed resume',
      !!ri && ri.native === true && ni.length === 2 && ni[0] === '--resume' && ni[1] === 'scout');

    fs.writeFileSync(path.join(rboard.planDir, 'claim-live.json'),
      JSON.stringify({ role: 'live', pid: process.pid, sessionId: 'l-sess', convId: CONV, at: Date.now() }));
    const r7 = RUNNER.resolveResumeRole(['--resume', 'live'], rrepo);
    ok('...a role held by a LIVE session REFUSES — two arc processes on one conversation collide',
      !!r7 && r7.ok === false && /HELD by a live session/.test(r7.message));

    fs.writeFileSync(path.join(rboard.planDir, 'claim-noconv.json'),
      JSON.stringify({ role: 'noconv', pid: DEAD_PID, sessionId: 'n-sess', convId: null, at: 7000 }));
    const r8 = RUNNER.resolveResumeRole(['--resume', 'noconv'], rrepo);
    ok('...a chair with no conversation REFUSES (claimed, never launched under arc)',
      !!r8 && r8.ok === false && /no conversation to resume/.test(r8.message));

    fs.writeFileSync(path.join(rboard.planDir, 'claim-ghost.json'),
      JSON.stringify({ role: 'ghost', pid: DEAD_PID, sessionId: 'g-sess', convId: '99999999-0000-0000-0000-000000000000', at: 7000 }));
    const r9 = RUNNER.resolveResumeRole(['--resume', 'ghost'], rrepo);
    ok('...a convId with NO transcript on this machine REFUSES by name, not claude\'s cryptic error',
      !!r9 && r9.ok === false && /no transcript/.test(r9.message));

    // the rewrite must feed the EXISTING machinery, not a parallel one
    const a10 = ['--resume', 'code'];
    RUNNER.resolveResumeRole(a10, rrepo);
    ok('...and the rewritten args flow into explicitConvId, so the launch path needs no special case',
      RUNNER.explicitConvId(a10) === CONV);
  }

  // skillOverrides wiring: only-if-absent — a user's own per-skill choice survives.
  const W = require(path.join(SRC, 'arc-wire-settings.js'));
  const s1 = {};
  W.mergeSkillOverrides(s1);
  ok('mergeSkillOverrides seeds every stub as user-invocable-only (menu yes, model listing no)',
    SL.MENU.every((e) => s1.skillOverrides[`arc-${e.verb}`] === 'user-invocable-only'));
  const s2 = { skillOverrides: { 'arc-peek': 'off', 'somebody-elses': 'on' } };
  W.mergeSkillOverrides(s2);
  ok('...but NEVER overwrites an existing user value ("off" stays "off")',
    s2.skillOverrides['arc-peek'] === 'off' && s2.skillOverrides['somebody-elses'] === 'on'
    && s2.skillOverrides['arc-help'] === 'user-invocable-only');
  // The namespace sweep, mirroring the installer's stub sweep: a verb removed from
  // MENU (anchors, 2026-07-18) must not leave an override key configuring a skill
  // that no longer exists — while non-arc names stay untouchable.
  const s3 = { skillOverrides: { 'arc-anchors': 'user-invocable-only', 'arc-peek': 'off', 'my-own-skill': 'off' } };
  W.mergeSkillOverrides(s3);
  ok('a removed verb\'s override is swept; user keys and live arc keys survive',
    !('arc-anchors' in s3.skillOverrides) && s3.skillOverrides['arc-peek'] === 'off'
    && s3.skillOverrides['my-own-skill'] === 'off');
  // The shared policy itself, behaviorally: right side wins per key; corrupt shapes
  // (arrays, strings, null — typeof [] === 'object') sanitize to {} on EITHER side
  // instead of poisoning the merge.
  ok('overlayMaps: right side wins per key, left fills the gaps',
    JSON.stringify(W.overlayMaps({ a: 1, b: 1 }, { b: 2 })) === '{"a":1,"b":2}');
  ok('overlayMaps sanitizes corrupt inputs on both sides',
    JSON.stringify(W.overlayMaps([], { a: 1 })) === '{"a":1}'
    && JSON.stringify(W.overlayMaps({ a: 1 }, 'junk')) === '{"a":1}'
    && JSON.stringify(W.overlayMaps(null, null)) === '{}');

  // Profile sync — THE POLICY TRAVELS WITH THE KEY (roadmap #7): the bare name-list
  // whose loop defaulted to wholesale replace ate profile-local values twice; now
  // every declared key carries its merge policy and an unknown policy SKIPS (never
  // replaces). Behavioral, against a real temp profile dir:
  const P7 = require(path.join(SRC, 'arc-profile.js'));
  ok('every ARC_SETTINGS_KEYS entry declares a KNOWN merge policy — no silent default left',
    Array.isArray(P7.ARC_SETTINGS_KEYS) && P7.ARC_SETTINGS_KEYS.length >= 4
    && P7.ARC_SETTINGS_KEYS.every((e) => e && typeof e.key === 'string'
      && ['replace', 'union', 'overlay'].includes(e.merge)));
  {
    const masterPath = path.join(CLAUDE, 'settings.json');
    const savedMaster = fs.existsSync(masterPath) ? fs.readFileSync(masterPath) : null;
    const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'p7-'));
    try {
      fs.writeFileSync(masterPath, JSON.stringify({
        hooks: { UserPromptSubmit: ['arc-master'] },
        permissions: { defaultMode: 'default', allow: ['Bash(arc role:*)'] },
        skillOverrides: { 'arc-peek': 'user-invocable-only' },
      }));
      fs.writeFileSync(path.join(pdir, 'settings.json'), JSON.stringify({
        hooks: { UserPromptSubmit: ['profile-drift'] },
        permissions: { defaultMode: 'auto', allow: ['Bash(my own:*)'] },
        skillOverrides: { 'arc-peek': 'off' },
        theme: 'dark',
      }));
      P7.syncSettings(pdir);
      const out = JSON.parse(fs.readFileSync(path.join(pdir, 'settings.json'), 'utf8'));
      ok('replace: arc-owned hooks take the ROOT copy (profile drift is not a choice to keep)',
        JSON.stringify(out.hooks) === JSON.stringify({ UserPromptSubmit: ['arc-master'] }));
      ok('union: profile scalars win, rule lists union — a profiled /permissions grant survives',
        out.permissions.defaultMode === 'auto'
        && out.permissions.allow.includes('Bash(my own:*)') && out.permissions.allow.includes('Bash(arc role:*)'));
      ok('overlay: the profile\'s own skill choice wins over the root default',
        out.skillOverrides['arc-peek'] === 'off');
      ok('...and keys arc does not own (theme) are untouched', out.theme === 'dark');
    } finally {
      if (savedMaster != null) fs.writeFileSync(masterPath, savedMaster); else fs.rmSync(masterPath, { force: true });
      fs.rmSync(pdir, { recursive: true, force: true });
    }
  }

  // The machine-sender contract, updated 2026-07-18: the revive prompt is
  // `/arc-role <role>`. Safe because it travels PROGRAMMATICALLY — measured:
  // `claude -p "/arc-peek"` reached the hook raw and blocked; the typed-command gate
  // only guards the input box. The strip covering both spellings (tested above) is
  // what makes this safe against the respawn replay loop.
  const inviteSrc = fs.readFileSync(path.join(SRC, 'arc-invite.js'), 'utf8');
  ok('the revive prompt is /arc-role — programmatic path, gate-immune',
    /`\/arc-role \$\{role\}`/.test(inviteSrc) && !/`arc:role \$\{role\}`/.test(inviteSrc));

  // THE /exit ROLE-DROP (field report 2026-07-17, roadmap #2, 20-check fixture repro):
  // /exit deletes session state, so on `arc --resume <uuid>` the resumed conversation id
  // lives only in explicitId — refreshRole received the null convId, adopted nothing, and
  // the session came back roleless: no stop-hook nag, no listener, notes rotting unread.
  // The launch loop must hand refreshRole the id it already knows — but NEVER on a fork,
  // whose explicitId names the CALLER's conversation (adopting it would steal the chair).
  const runnerSrc2 = fs.readFileSync(path.join(SRC, 'arc-runner.js'), 'utf8');
  ok('the resume launch hands refreshRole the explicit conversation id, fork-guarded',
    /refreshRole\(SESSION_ID, process\.pid, process\.cwd\(\), convId \|\| \(isFork \? null : explicitId\)\)/.test(runnerSrc2));
} catch (e) { ok('/arc slash commands', false, e.message + '\n' + (e.stack || '')); }

// ---- receipts: a note reports whether it landed, so an ack is never needed ---
section('arc-notes receipts (seenBy — a result is terminal, no "received" note)');
try {
  const F = require(path.join(SRC, 'arc-notes.js'));
  const RM = require(path.join(SRC, 'arc-board.js'));
  const rroot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpt-'));
  fs.mkdirSync(path.join(rroot, '.git'));
  const rboard = RM.resolveBoard(rroot);
  const cache = path.join(CLAUDE, 'cache'); fs.mkdirSync(cache, { recursive: true });
  const S = (n) => 'rcpt-' + n + '-' + process.pid;
  for (const r of ['a', 'b', 'c']) writeJSON(path.join(cache, `arc-state-${S(r)}.json`), { pid: process.pid, cwd: rroot });
  F.requestRole(S('a'), 'aa', rroot);
  F.requestRole(S('b'), 'bb', rroot);
  F.requestRole(S('c'), 'cc', rroot);

  // DIRECTED — the ack-cutting case. aa answers bb; the receipt is derived from bb's cursor, so
  // aa never sends "received" and bb never has to: aa just watches its own sent note flip to seen.
  F.requestNote(S('a'), 'bb "heads up schema changed"', rroot);
  const dn = RM.allNotes(rboard).find((n) => /schema changed/.test(n.body));
  ok('a directed note is NOT seen before the recipient reads (receipt = derived, no note of its own)',
    JSON.stringify(RM.seenBy(rboard, dn)) === JSON.stringify({ recipients: ['bb'], seen: [] }));
  const beforeRead = F.requestNotes(S('a'), '', rroot);
  ok('the SENDER sees a pull-only receipt in `arc notes` — not yet seen',
    /your recent sent/.test(beforeRead.message) && /bb hasn't read it yet/.test(beforeRead.message));
  F.requestNotes(S('b'), '', rroot);   // bb reads the board — its cursor passes the note
  ok('...which flips to ✓ seen once the recipient reads — the reason a "thanks" note is pure waste',
    JSON.stringify(RM.seenBy(rboard, dn).seen) === JSON.stringify(['bb'])
    && /seen by bb/.test(F.requestNotes(S('a'), '', rroot).message));

  // BROADCAST — the announcer's check: did everyone get it? Recipients are the LIVE peers minus me.
  F.requestNote(S('a'), 'all --kind blocker "staging down"', rroot);
  const bn = RM.allNotes(rboard).find((n) => /staging down/.test(n.body));
  ok('a broadcast\'s recipients are the LIVE peers minus the sender, none seen before any read',
    JSON.stringify(RM.seenBy(rboard, bn).recipients.slice().sort()) === JSON.stringify(['bb', 'cc'])
    && RM.seenBy(rboard, bn).seen.length === 0);
  F.requestNotes(S('b'), '', rroot);
  ok('...partial once one reads (an announcer can see WHO is missing)',
    (() => { const s = RM.seenBy(rboard, bn); return s.seen.length === 1 && s.seen[0] === 'bb'; })());
  F.requestNotes(S('c'), '', rroot);
  ok('...seen by all once every live peer reads — a blocker reached everyone, without asking',
    RM.seenBy(rboard, bn).seen.length === 2);
  // audit #192 Q2: recipients is the CURRENT live set, which shrinks as chairs close, so a bare
  // "all" would overclaim. The receipt must say "all N LIVE" and name who signed — never an absolute
  // "all" a closed-unread chair could have dodged.
  ok('...and the broadcast receipt says "all N LIVE (roles)", never a bare "all" (audit #192 Q2)',
    /seen by all 2 live \(bb, cc\)/.test(F.requestNotes(S('a'), '', rroot).message));

  // A broadcast to an empty board (no live peers) has no recipient, so it can never falsely read
  // "seen by all" — it reports having no one to receive it.
  const lone = fs.mkdtempSync(path.join(os.tmpdir(), 'rcpt1-'));
  fs.mkdirSync(path.join(lone, '.git'));
  const lb = RM.resolveBoard(lone); RM.ensureBoard(lb);
  const ln = RM.appendNote(lb, { from: 'solo', to: null, kind: 'blocker', body: 'nobody here' });
  ok('a broadcast with no live peer reports zero recipients (never a false "all seen")',
    RM.seenBy(lb, ln).recipients.length === 0 && RM.seenBy(lb, ln).seen.length === 0);

  const skillR = fs.readFileSync(path.join(ROOT, 'skills', 'peers', 'SKILL.md'), 'utf8').replace(/[`*]/g, '');
  ok('the peers skill teaches: a result is terminal, receipts are automatic, don\'t send "received"',
    /do not acknowledge a result/i.test(skillR) && /receipt/i.test(skillR)
    && /seen by research/.test(skillR) && /delivered into their context, not read-and-agreed/i.test(skillR));
  ok('...and the STRICTER cut + its WHY: a delegated decision closes on receipt; an unneeded note is a cascade root',
    /closes on receipt/i.test(skillR) && /your call/i.test(skillR) && /Don't post the decision twice/i.test(skillR)
    && /not to start it/i.test(skillR) && /built to answer/i.test(skillR));

  for (const r of ['a', 'b', 'c']) { try { fs.unlinkSync(path.join(cache, `arc-state-${S(r)}.json`)); } catch {} try { fs.unlinkSync(path.join(cache, `arc-role-${S(r)}.json`)); } catch {} }
  fs.rmSync(rroot, { recursive: true, force: true });
  fs.rmSync(lone, { recursive: true, force: true });
} catch (e) { ok('arc-notes receipts', false, e.message + '\n' + (e.stack || '')); }

// ---- multi-recipient notes (a comma-list addresses a SUBSET, delivered whole to each) -------
section('multi-recipient notes (arc note a,b — addressed subset, whole to each, per-recipient receipts)');
try {
  const F = require(path.join(SRC, 'arc-notes.js'));
  const RM = require(path.join(SRC, 'arc-board.js'));
  const mroot = fs.mkdtempSync(path.join(os.tmpdir(), 'mrec-'));
  spawnSync('git', ['-C', mroot, 'init', '-qb', 'main'], {});
  fs.mkdirSync(path.join(mroot, '.arc', 'roles'), { recursive: true });
  for (const r of ['a', 'b', 'c']) fs.writeFileSync(path.join(mroot, '.arc', 'roles', r + '.md'), '# ' + r + '\nowns: x\n');
  spawnSync('git', ['-C', mroot, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], {});
  spawnSync('git', ['-C', mroot, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], {});
  const mb = RM.resolveBoard(mroot); RM.ensureBoard(mb);
  const mcache = path.join(CLAUDE, 'cache');
  const MS = (n) => 'mrec-' + n + '-' + process.pid;
  for (const r of ['a', 'b', 'c']) { writeJSON(path.join(mcache, `arc-state-${MS(r)}.json`), { pid: process.pid, cwd: mroot }); F.requestRole(MS(r), r, mroot); }

  const big = 'PACKET ' + 'x'.repeat(1200) + ' END';
  const res = F.requestNote(MS('c'), `a,b "${big}"`, mroot);
  const n = RM.allNotes(mb).find((x) => /^PACKET/.test(x.body));
  ok('a comma-list posts, names both recipients, and stores `to` as an ARRAY (not the string "a,b")',
    res.ok && /posted for a \+ b/.test(res.message) && Array.isArray(n.to) && n.to.slice().sort().join() === 'a,b');
  ok('BOTH named roles see it unread; the sender does not — addressed, not broadcast',
    RM.unreadFor(mb, 'a').notes.some((x) => x.id === n.id) && RM.unreadFor(mb, 'b').notes.some((x) => x.id === n.id)
    && !RM.unreadFor(mb, 'c').notes.some((x) => x.id === n.id));
  ok('receipts track each recipient: [a,b], none seen, then a-only after a reads',
    JSON.stringify(RM.seenBy(mb, n).recipients.slice().sort()) === '["a","b"]' && RM.seenBy(mb, n).seen.length === 0
    && (() => { F.injection(MS('a'), mroot); const s = RM.seenBy(mb, n); return s.seen.includes('a') && !s.seen.includes('b'); })());
  ok('a subset note is delivered WHOLE (the full 1200-char packet), not the broadcast preview',
    (() => { const inj = F.injection(MS('b'), mroot); return inj && inj.text.includes(big); })());
  ok('the SENDER is dropped from a recipient list rather than erroring (note still reaches the rest)',
    (() => { const r = F.requestNote(MS('c'), 'a,c "drop me"', mroot); const dn = RM.allNotes(mb).find((x) => x.body === 'drop me'); return r.ok && dn.to === 'a'; })());
  ok('a malformed role in the list is refused (never posted to a garbage chair)',
    F.requestNote(MS('c'), 'a,BAD! "x"', mroot).ok === false);
  ok('single role still stores a STRING and broadcast still stores NULL (no regression)',
    (() => { F.requestNote(MS('c'), 'a "solo"', mroot); F.requestNote(MS('c'), 'all "everyone"', mroot);
      const s = RM.allNotes(mb).find((x) => x.body === 'solo'); const bc = RM.allNotes(mb).find((x) => x.body === 'everyone');
      return typeof s.to === 'string' && bc.to == null; })());

  for (const r of ['a', 'b', 'c']) { try { fs.unlinkSync(path.join(mcache, `arc-state-${MS(r)}.json`)); } catch {} try { fs.unlinkSync(path.join(mcache, `arc-role-${MS(r)}.json`)); } catch {} }
  fs.rmSync(mroot, { recursive: true, force: true });
} catch (e) { ok('multi-recipient notes', false, e.message + '\n' + (e.stack || '')); }

// ---- multi-recipient REQUESTS: wait-for-all (owed by each; empty chairs excluded) -----------
section('multi-recipient requests (owed-by-each: closes only when all HELD recipients reply)');
try {
  const F = require(path.join(SRC, 'arc-notes.js'));
  const RM = require(path.join(SRC, 'arc-board.js'));
  const wroot = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-'));
  spawnSync('git', ['-C', wroot, 'init', '-qb', 'main'], {});
  fs.mkdirSync(path.join(wroot, '.arc', 'roles'), { recursive: true });
  for (const r of ['a', 'b', 'c', 'ghost']) fs.writeFileSync(path.join(wroot, '.arc', 'roles', r + '.md'), '# ' + r + '\nowns: x\n');
  spawnSync('git', ['-C', wroot, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], {});
  spawnSync('git', ['-C', wroot, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], {});
  const wb = RM.resolveBoard(wroot); RM.ensureBoard(wb);
  const wcache = path.join(CLAUDE, 'cache');
  const WS = (n) => 'wall-' + n + '-' + process.pid;
  // a,b,c LIVE (genuine claim via this alive pid); ghost is DECLARED but nobody holds it
  for (const r of ['a', 'b', 'c']) { writeJSON(path.join(wcache, `arc-state-${WS(r)}.json`), { pid: process.pid, cwd: wroot }); F.requestRole(WS(r), r, wroot); }
  const openSeqs = () => RM.openRequests(wb, 'c').filter((n) => n.from === 'c').map((n) => n.seq);

  F.requestNote(WS('c'), 'a,b --kind request "both please"', wroot);
  const req = RM.allNotes(wb).find((x) => x.body === 'both please');
  ok('a multi-recipient request is OPEN before anyone replies', openSeqs().includes(req.seq));
  F.requestNote(WS('a'), `c --reply-to ${req.seq} "a done"`, wroot);
  ok('...STILL open after ONE of two replies; requestStatus shows a replied, b not',
    openSeqs().includes(req.seq)
    && RM.requestStatus(wb, req).find((s) => s.role === 'a').replied === true
    && RM.requestStatus(wb, req).find((s) => s.role === 'b').replied === false);
  F.requestNote(WS('b'), `c --reply-to ${req.seq} "b done"`, wroot);
  ok('...CLOSED only once BOTH have replied (owed by each)', !openSeqs().includes(req.seq));

  F.requestNote(WS('c'), 'a,ghost --kind request "a and a ghost"', wroot);
  const req2 = RM.allNotes(wb).find((x) => x.body === 'a and a ghost');
  ok('an EMPTY-CHAIR recipient is not waited on: a held+ghost request closes when the HELD one replies',
    (() => { const before = openSeqs().includes(req2.seq); F.requestNote(WS('a'), `c --reply-to ${req2.seq} "done"`, wroot); return before && !openSeqs().includes(req2.seq); })());

  F.requestNote(WS('c'), 'a --kind request "just a"', wroot);
  const req3 = RM.allNotes(wb).find((x) => x.body === 'just a');
  ok('single-recipient request is UNCHANGED: closes on its reply',
    (() => { const before = openSeqs().includes(req3.seq); F.requestNote(WS('a'), `c --reply-to ${req3.seq} "ok"`, wroot); return before && !openSeqs().includes(req3.seq); })());

  for (const r of ['a', 'b', 'c']) { try { fs.unlinkSync(path.join(wcache, `arc-state-${WS(r)}.json`)); } catch {} try { fs.unlinkSync(path.join(wcache, `arc-role-${WS(r)}.json`)); } catch {} }
  fs.rmSync(wroot, { recursive: true, force: true });
} catch (e) { ok('multi-recipient requests', false, e.message + '\n' + (e.stack || '')); }

// ---- multi-recipient DELEGATE: one command staffs/revives EACH role, posts ONE request ----------
section('multi-recipient delegate (arc delegate a,b — fill every chair, then ONE request to all)');
try {
  const I = require(path.join(SRC, 'arc-invite.js'));
  const RM = require(path.join(SRC, 'arc-board.js'));
  const F = require(path.join(SRC, 'arc-notes.js'));
  const droot = fs.mkdtempSync(path.join(os.tmpdir(), 'dmany-'));
  spawnSync('git', ['-C', droot, 'init', '-qb', 'main'], {});
  fs.mkdirSync(path.join(droot, '.arc', 'roles'), { recursive: true });
  for (const r of ['a', 'b', 'c', 'd', 'e']) fs.writeFileSync(path.join(droot, '.arc', 'roles', r + '.md'), '# ' + r + '\nowns: x\n');
  spawnSync('git', ['-C', droot, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], {});
  spawnSync('git', ['-C', droot, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], {});
  const db = RM.resolveBoard(droot); RM.ensureBoard(db);
  const dcache = path.join(CLAUDE, 'cache');
  const DS = (n) => 'dmany-' + n + '-' + process.pid;
  // a and c are LIVE (genuine claim, this alive pid); b,d,e are declared but nobody holds them
  for (const r of ['a', 'c']) { writeJSON(path.join(dcache, `arc-state-${DS(r)}.json`), { pid: process.pid, cwd: droot }); F.requestRole(DS(r), r, droot); }
  // staffing must NOT open a real tab: mock the spawn, count it, and stub the transcript as absent
  let spawnCount = 0;
  const dmock = { spawn: () => { spawnCount++; return { status: 0 }; }, hasWt: true, hasTranscript: () => false, writeScript: () => 'C:\\Temp\\p.txt' };
  const bodyNote = (body) => RM.allNotes(db).find((x) => x.body === body);

  // a live + b closed: a is noted live (no spawn), b is STAFFED (one spawn), ONE request to [a,b]
  spawnCount = 0;
  const r1 = I.requestDelegate(DS('c'), 'a,b "do the thing"', droot, dmock);
  const req1 = bodyNote('do the thing');
  ok('delegate a,b: a noted live + b staffed (exactly ONE spawn), ONE request to [a,b]',
    r1.ok === true && spawnCount === 1
    && req1 && req1.kind === 'request' && Array.isArray(req1.to) && req1.to.slice().sort().join() === 'a,b'
    && /a \(live\)/.test(r1.message) && /b — STAFFED/.test(r1.message), JSON.stringify(r1));

  // both closed (d,e): TWO spawns, one request to [d,e]
  spawnCount = 0;
  const r2 = I.requestDelegate(DS('c'), 'd,e "both new"', droot, dmock);
  const req2 = bodyNote('both new');
  ok('delegate d,e (both closed): staffs BOTH (two spawns), ONE request to [d,e]',
    r2.ok === true && spawnCount === 2 && req2 && Array.isArray(req2.to) && req2.to.slice().sort().join() === 'd,e');

  // the caller drops itself: a,c from c -> just a (single request, a already live so no spawn)
  spawnCount = 0;
  const r3 = I.requestDelegate(DS('c'), 'a,c "drop self"', droot, dmock);
  const req3 = bodyNote('drop self');
  ok('the caller is dropped from the list (a,c from c -> a only, single request, no spawn)',
    r3.ok === true && req3 && req3.to === 'a' && spawnCount === 0);

  // one invalid role in the list refuses the WHOLE command (nothing staffed)
  spawnCount = 0;
  ok('an invalid role anywhere in the list refuses the whole command — nothing staffed',
    I.requestDelegate(DS('c'), 'a,BAD! "x"', droot, dmock).ok === false && spawnCount === 0);

  // no packet: fill chairs only, no request posted
  spawnCount = 0;
  const before = RM.allNotes(db).length;
  const r5 = I.requestDelegate(DS('c'), 'd,e', droot, dmock);
  ok('no packet: chairs filled, NO request posted (a note-free staffing)',
    r5.ok === true && RM.allNotes(db).length === before);

  for (const r of ['a', 'c']) { try { fs.unlinkSync(path.join(dcache, `arc-state-${DS(r)}.json`)); } catch {} try { fs.unlinkSync(path.join(dcache, `arc-role-${DS(r)}.json`)); } catch {} }
  fs.rmSync(droot, { recursive: true, force: true });
} catch (e) { ok('multi-recipient delegate', false, e.message + '\n' + (e.stack || '')); }

// ---- arc-update (version-awareness at launch + one-command upgrade) ----------
section('arc-update (launch check is fail-safe; release preconditions hold)');
try {
  const U = require(path.join(SRC, 'arc-update.js'));
  ok('cmpVer: v-prefix + short forms + garbage never throw',
    U.cmpVer('v2.1.0', '2.1.0') === 0 && U.cmpVer('2.2.0', '2.1.9') === 1 && U.cmpVer('2.1.0', '2.1.1') === -1
    && U.cmpVer('2.1', '2.1.0') === 0 && U.cmpVer('3.0.0', '2.9.9') === 1 && U.cmpVer('v2.x', '2.0') === 0);

  // checkForUpdate is ASYNC (a network fetch) and this suite is synchronous, so its cache/fail-safe
  // logic is exercised in a CHILD process that awaits and exits 0/1. Fail-safe is the whole contract:
  // the launch path must never throw, hang, or be wedged by offline/timeout/garbage.
  const updPath = path.join(SRC, 'arc-update.js').split(path.sep).join('/');
  const child = [
    `const U=require(${JSON.stringify(updPath)});const fs=require('fs'),os=require('os'),p=require('path');`,
    `const c=p.join(os.tmpdir(),'arc-upd-child-'+process.pid+'.json');let ok=true;const t=(x)=>{if(!x)ok=false;};`,
    `(async()=>{`,
    `let r=await U.checkForUpdate({cachePath:c,installed:'2.1.0',fetch:async()=>({tag:'v2.2.0',tarball:'x'}),now:1000});t(r.available===true&&r.latest==='v2.2.0');`,
    `r=await U.checkForUpdate({cachePath:c,installed:'2.2.0',fetch:async()=>({tag:'v2.2.0'}),now:2000,force:true});t(r.available===false);`,
    `let n=0;await U.checkForUpdate({cachePath:c,installed:'2.1.0',fetch:async()=>{n++;return{tag:'v9'};},now:3000});t(n===0);`,
    `await U.checkForUpdate({cachePath:c,installed:'2.1.0',fetch:async()=>{n++;return{tag:'v2.3.0'};},now:3000+25*3600*1000});t(n===1);`,
    `r=await U.checkForUpdate({cachePath:c,installed:'9.9.9',fetch:async()=>null,now:5000,force:true});t(r.available===false);`,
    `let th=false;try{r=await U.checkForUpdate({cachePath:c,installed:'2.1.0',fetch:async()=>{throw new Error('x');},now:6000,force:true});}catch{th=true;}t(th===false&&typeof r.available==='boolean');`,
    `U.recordDecline('v2.3.0',c);r=await U.checkForUpdate({cachePath:c,installed:'2.1.0',fetch:async()=>({tag:'v2.3.0'}),now:7000,force:true});t(r.available===true&&r.declined===true);`,
    `try{fs.unlinkSync(c);}catch{}process.exit(ok?0:1);})();`,
  ].join('\n');
  const scriptFile = path.join(TMP, 'arc-update-async.js'); fs.writeFileSync(scriptFile, child);
  const cr = spawnSync(process.execPath, [scriptFile], { encoding: 'utf8', timeout: 15000 });
  ok('checkForUpdate: available / cache-freshness / stale-refetch / offline / throw-swallow / decline (async child)',
    cr.status === 0, (cr.stdout || '') + (cr.stderr || ''));

  // downloadAndInstall must FAIL SAFE — return {ok:false}, never throw, never half-install — when the
  // download cannot happen. A bogus loopback url refuses immediately, so this stays fast and offline.
  // (The re-nag bug was a FAILED update leaving no memory; the contract that makes the fix safe is
  // that a failed update reports ok:false loudly rather than throwing or claiming success.)
  {
    const r = U.downloadAndInstall('v9.9.9', 'http://127.0.0.1:9/nope.tgz', { quiet: true, log: () => {} });
    ok('downloadAndInstall fails safe on an unreachable tarball (ok:false, no throw, no install)',
      r && r.ok === false && typeof r.message === 'string');
  }
  ok('a null tarball is refused before any work', U.downloadAndInstall('v9.9.9', null).ok === false);

  // liveOthers feeds a FORCE-KILL, so a wrong pid is unrecoverable. It must prove GENUINE identity
  // (started before its marker), never target this process (by session id AND by pid, even through an
  // alias file), and reject a recycled pid whose start post-dates the marker (audit #271 H2).
  {
    const cp = require('child_process');
    const cache = path.join(CLAUDE, 'cache'); fs.mkdirSync(cache, { recursive: true });
    const meSess = 'upd-self-' + process.pid, aliasSess = 'upd-alias-' + process.pid;
    const peerSess = 'upd-peer-' + process.pid, deadSess = 'upd-dead-' + process.pid, recycSess = 'upd-recyc-' + process.pid;
    const w = (s, pid, cwd) => fs.writeFileSync(path.join(cache, `arc-state-${s}.json`), JSON.stringify({ pid, cwd }));
    // a REAL live process distinct from this one, so "genuine peer" is a true live pid, not our own
    const kid = cp.spawn(process.execPath, ['-e', 'setTimeout(function(){}, 60000)'], { stdio: 'ignore', detached: true });
    try { kid.unref(); } catch {}
    w(meSess, process.pid, 'E:/arc');            // MY session id — excluded by name
    w(aliasSess, process.pid, 'E:/arc');         // a stray file carrying MY pid — excluded by pid
    w(peerSess, kid.pid, 'E:/whalephone');       // a genuine live peer (marker written just after it started)
    w(deadSess, DEAD_PID, 'E:/x');               // dead
    w(recycSess, kid.pid, 'E:/y');               // same live pid, but marker predates its start → looks recycled
    const old = new Date(Date.now() - 3600_000);
    try { fs.utimesSync(path.join(cache, `arc-state-${recycSess}.json`), old, old); } catch {}

    // TWO feed pidfiles on different ports: both genuine feeds must be reported, not collapsed to one
    // scalar (audit #289 finding 7). Seed them keyed by the live kid pid (genuine), distinct ports.
    fs.writeFileSync(path.join(cache, 'arc-feed-8790.json'), JSON.stringify({ pid: kid.pid, port: 8790, started: Date.now() }));
    fs.writeFileSync(path.join(cache, 'arc-feed-8791.json'), JSON.stringify({ pid: kid.pid, port: 8791, started: Date.now() }));

    const o = U.liveOthers(meSess);
    const sessions = o.sessions.map((s) => s.session);
    ok('liveOthers EXCLUDES this session by id (never kills the upgrader itself)', !sessions.includes(meSess));
    ok('...and EXCLUDES any file carrying MY pid, even under another session id (alias self-kill closed)',
      !sessions.includes(aliasSess));
    ok('...and DROPS a dead-pid session', !sessions.includes(deadSess));
    ok('...and models feeds as an ARRAY (no scalar collapse), not a single .feed', Array.isArray(o.feeds) && o.feed === undefined);
    if (process.platform === 'win32') {
      // the procStart oracle needs the OS start time (PowerShell on Windows; arc is Windows-only)
      ok('...INCLUDES a GENUINE live peer (started before its marker)', sessions.includes(peerSess));
      ok('...but REJECTS a recycled-looking pid whose start post-dates the marker', !sessions.includes(recycSess));
      ok('...reports BOTH genuine feeds on distinct ports (multi-feed does not collapse)',
        o.feeds.length === 2 && o.feeds.map((f) => String(f.port)).sort().join() === '8790,8791');
    } else {
      ok('...off-Windows the start oracle is unavailable, so it fails CLOSED (nothing targeted)',
        sessions.length === 0 && o.feeds.length === 0);
    }
    try { process.kill(kid.pid); } catch {}
    for (const s of [meSess, aliasSess, peerSess, deadSess, recycSess]) { try { fs.unlinkSync(path.join(cache, `arc-state-${s}.json`)); } catch {} }
    for (const p of ['8790', '8791']) { try { fs.unlinkSync(path.join(cache, `arc-feed-${p}.json`)); } catch {} }
  }

  // Scope identity: arc kills a scope process only when its path matches arc's OWN build layout
  // (`…/scope/arc-scope.exe`); a foreign same-named exe is never targeted (audit #289 blocker 5).
  ok('isArcScopePath trusts arc\'s scope/ build layout and rejects a foreign same-named exe',
    U.isArcScopePath('E:/arc/scope/arc-scope.exe') === true
    && U.isArcScopePath('E:\\arc\\scope\\arc-scope.exe') === true
    && U.isArcScopePath('C:/tmp/arc-scope.exe') === false
    && U.isArcScopePath('C:/scope-tools/arc-scope.exe') === false
    && U.isArcScopePath(null) === false);

  // killOthers reports honestly AND dedupes targets (audit #289 findings 8/9): a pid in two classes is
  // killed once, never once-then-raced-as-a-failure. A dead pid cannot be killed → it lands in failed.
  {
    const res = U.killOthers({ sessions: [{ pid: DEAD_PID }], feeds: [], scope: [] });
    ok('killOthers returns {killed, failed} and counts an un-closable pid as FAILED, not closed',
      res && res.killed === 0 && res.failed === 1);
    const dup = U.killOthers({ sessions: [{ pid: DEAD_PID }], feeds: [{ pid: DEAD_PID }], scope: [{ pid: DEAD_PID }] });
    ok('...and a pid repeated across classes is deduped to ONE target (no false extra failure)',
      dup.killed + dup.failed === 1);
    const empty = U.killOthers({ sessions: [], feeds: [], scope: [] });
    ok('...and nothing to close is {killed:0, failed:0}', empty.killed === 0 && empty.failed === 0);
  }

  // doRelease preconditions — a release must be a clean, correct, pushed point. Dry-run: never pushes.
  const mkrepo = (remote, ver) => {
    const rp = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-'));
    const g = (a) => spawnSync('git', ['-C', rp, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' });
    g(['init', '-qb', 'main']); if (remote) g(['remote', 'add', 'origin', remote]);
    fs.writeFileSync(path.join(rp, 'package.json'), JSON.stringify({ name: 'arc', version: ver }, null, 2));
    g(['add', '-A']); g(['commit', '-qm', 'init']);
    return rp;
  };
  const good = mkrepo('https://github.com/Veneto723/arc.git', '2.0.0');
  ok('doRelease bumps patch/minor/major and accepts an explicit version',
    U.doRelease('patch', { cwd: good, dryRun: true }).version === 'v2.0.1'
    && U.doRelease('minor', { cwd: good, dryRun: true }).version === 'v2.1.0'
    && U.doRelease('major', { cwd: good, dryRun: true }).version === 'v3.0.0'
    && U.doRelease('2.5.1', { cwd: good, dryRun: true }).version === 'v2.5.1');
  fs.writeFileSync(path.join(good, 'dirty.txt'), 'x');
  ok('...refuses a DIRTY tree (never releases uncommitted work)',
    U.doRelease('patch', { cwd: good, dryRun: true }).ok === false && /dirty/.test(U.doRelease('patch', { cwd: good, dryRun: true }).message));
  const wrong = mkrepo('https://github.com/someone/other.git', '1.0.0');
  ok('...refuses the WRONG origin (a fork would push the release elsewhere than the tree)',
    U.doRelease('patch', { cwd: wrong, dryRun: true }).ok === false && /refusing to release the wrong repo|expected/.test(U.doRelease('patch', { cwd: wrong, dryRun: true }).message));
  // audit #199 Q4: a trailing \b let a SAME-OWNER, differently-named clone slip through, then cut a
  // release to the REAL repo (gh --repo) from the wrong tree — irreversible. The anchor ($) shuts it.
  const fork = mkrepo('https://github.com/Veneto723/arc-fork.git', '1.0.0');
  ok('...and refuses a same-owner DIFFERENTLY-NAMED clone (Veneto723/arc-fork must NOT pass; the real arc.git did, above)',
    U.doRelease('patch', { cwd: fork, dryRun: true }).ok === false);
  ok('downloadAndInstall refuses with no tarball url (never a half-install)',
    U.downloadAndInstall('v9', null).ok === false);
  for (const d of [good, wrong, fork]) fs.rmSync(d, { recursive: true, force: true });
} catch (e) { ok('arc-update', false, e.message + '\n' + (e.stack || '')); }

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

  // THE ARM-NUDGE RIDES THE DELIVERY (measured fix, 2026-07-18). This session holds a role and is
  // NOT armed, so the delivery it is already getting must ALSO tell it to arm — otherwise a busy
  // session (one that always has a note pending) reaches the standalone offer NEVER, because the
  // delivery block returns first. That is exactly how audit stayed deaf all day (reproduced cold).
  ok('a delivery to an UNARMED role-holder folds in the arm-nudge (the busy-session deaf fix)',
    /NO listener armed/.test(fed.reason) && /arc join code/.test(fed.reason));
  // ...but an ARMED role-holder sees NOTHING extra — the nudge is for the deaf, never a nag.
  {
    const A9 = require(path.join(SRC, 'arc-await.js'));
    A9.markWaiting(SESSION, 'code', process.pid);   // now listening
    RM.appendNote(board, { from: 'research', to: 'code', body: 'second note while armed', priority: 'normal' });
    const armedFed = fire({ hook_event_name: 'Stop', cwd: sboard });
    ok('...while an ARMED role-holder gets the note with NO arm-nudge appended (never a nag)',
      /second note while armed/.test(armedFed.reason) && !/NO listener armed/.test(armedFed.reason));
    A9.clearWaiting(SESSION);
    RM.markRead(board, 'code');

    // ARMED FOR THE WRONG ROLE is DEAF, not reachable (robustness — the role-blind isWaiting hole
    // the code's own comment warned about, and the exact shape of the 2026-07-18 role-misfile).
    // A listener for role X does not hear role Y, so a session that changed roles must STILL be
    // nudged/offered. isWaitingAs(role) is the fix; a bare isWaiting would call it reachable.
    ok('(setup) isWaitingAs distinguishes the role a listener is armed FOR',
      A9.isWaitingAs === undefined ? false : (() => { A9.markWaiting(SESSION, 'OTHER', process.pid);
        const wrong = A9.isWaitingAs(SESSION, 'code'); const right = A9.isWaitingAs(SESSION, 'OTHER');
        A9.clearWaiting(SESSION); return wrong === false && right === true; })());
    A9.clearOffered(SESSION);                          // a fresh cycle, so the offer can fire
    A9.markWaiting(SESSION, 'OLDROLE', process.pid);   // live listener, but for a role we no longer hold
    const misOffer = fire({ hook_event_name: 'Stop', cwd: sboard });
    ok('a session armed for the WRONG role is still OFFERED (a stale-role listener is deaf, not reachable)',
      misOffer.decision === 'block' && /hold the role "code"/.test(misOffer.reason || ''));
    RM.appendNote(board, { from: 'research', to: 'code', body: 'note while mis-armed', priority: 'normal' });
    A9.markWaiting(SESSION, 'OLDROLE', process.pid);   // re-plant (the offer above may have cleared markers)
    const misFed = fire({ hook_event_name: 'Stop', cwd: sboard });
    ok('...and a delivery to a wrong-role-armed holder STILL folds in the nudge',
      /note while mis-armed/.test(misFed.reason || '') && /NO listener armed/.test(misFed.reason || ''));
    // Restore the linear flow's state for the tests that follow: no listener, notes read, and the
    // offer marker SET (the original flow has been "already offered" since the first fire above).
    A9.clearWaiting(SESSION); A9.markOffered(SESSION); RM.markRead(board, 'code');
  }

  // idempotent: injection() advanced the cursor, so the SAME note cannot block twice
  ok('the same note can never block twice (cursor advanced -> no Stop loop)',
    !fire({ hook_event_name: 'Stop', cwd: sboard }).decision);

  // DELIVERY MUST CHAIN — the OFFERS must not. This asserted the opposite until a peer answered
  // at length and the tail sat unread until the human typed: a batch is capped at INJECT_MAX, so
  // a long answer arrives in PIECES, and bailing on stop_hook_active delivered the first piece and
  // stranded the rest. It stayed hidden while bodies were clipped to 400 (many notes fit one
  // batch); letting a peer's answer through whole is what made multi-batch normal.
  // Chaining is safe HERE because delivery is provably terminating: the cursor advances over
  // exactly what was delivered, so each block strictly shrinks the unread set.
  RM.appendNote(board, { from: 'research', to: 'code', body: 'second answer', priority: 'normal' });
  ok('a note IS delivered mid-continuation (a capped batch must drain, not wait for a keystroke)',
    /second answer/.test(fire({ hook_event_name: 'Stop', cwd: sboard, stop_hook_active: true }).reason || ''));
  // The SAME note never blocks twice — the cursor advanced, so it is not re-delivered. (A delivery
  // to an unarmed role-holder now RE-OPENS the arm offer, so an arm-offer block may follow — that is
  // the deafness fix, 2026-07-18: a still-deaf session is re-prompted after handling a task. What
  // this pins is that the NOTE does not re-deliver, never that the chain goes fully silent.)
  const afterDeliver = fire({ hook_event_name: 'Stop', cwd: sboard, stop_hook_active: true });
  ok('...and the same note never RE-delivers (cursor advanced); an arm re-offer may follow, not the note',
    !/second answer/.test(afterDeliver.reason || ''));
  // ...and that arm offer is bounded by its marker — the NEXT fire stays silent (once per cycle).
  ok('the re-opened offer fires once, then the marker bounds it (no nag loop mid-continuation)',
    !fire({ hook_event_name: 'Stop', cwd: sboard, stop_hook_active: true }).decision);

  // THE DEAF-AFTER-DELIVERY HOLE (fired live TWICE in one day, 2026-07-18 — audit went deaf both
  // times): a woken session's turn ends in a chain — Stop -> deliver a note (block) -> reply ->
  // Stop with stop_hook_active — and the old blanket guard silenced EVERY offer there. So the
  // listener arm was never offered on exactly the turn shape a busy board produces: wake, answer,
  // idle, DEAF until a human typed. A fresh cycle (as after a wake consumed the listener) must
  // get the offer even mid-continuation; the once-per-cycle marker is what bounds it, not the flag.
  const A9 = require(path.join(SRC, 'arc-await.js'));
  A9.clearOffered(SESSION);
  const armAfterFeed = fire({ hook_event_name: 'Stop', cwd: sboard, stop_hook_active: true });
  ok('a FRESH cycle gets the listener offer even mid-continuation (the deaf-after-delivery fix)',
    armAfterFeed.decision === 'block' && /arc join code/.test(armAfterFeed.reason || ''));
  ok('...exactly once — the offer marker bounds the chain, never a nag loop',
    !fire({ hook_event_name: 'Stop', cwd: sboard, stop_hook_active: true }).decision);
  // The one offer WITHOUT a marker keeps the hard guard — source-pinned so it cannot drift.
  const shSrc = fs.readFileSync(HOOK, 'utf8');
  ok('the spawns-leak nag (unmarked, would re-fire forever) alone keeps the hard guard',
    /if \(!hook\.stop_hook_active\) try \{/.test(shSrc) && !/^\s*if \(hook\.stop_hook_active\) return null;/m.test(shSrc));

  // A DELIVERY RE-OPENS THE OFFER CYCLE — the deafness root (audit's confession, 2026-07-18): the
  // offer marker is cleared ONLY when a listener actually arms, so an arm that DID NOT TAKE (a
  // malformed foreground/piped `arc join`, or an ignored offer) leaves it stuck TRUE and every
  // future offer is muted FOREVER — even across new delegated tasks. Delivering a note is proof the
  // session is engaged and still deaf, so it re-opens the cycle: a session gets re-prompted once per
  // task it handles, not one failed arm then permanent silence.
  {
    const A8 = require(path.join(SRC, 'arc-await.js'));
    A8.clearWaiting(SESSION); A8.markOffered(SESSION); RM.markRead(board, 'code');   // offered before, arm never took -> marker stuck
    ok('(setup) the offer marker is stuck TRUE and a quiet turn is muted (the deafness state)',
      A8.wasOffered(SESSION) === true && !fire({ hook_event_name: 'Stop', cwd: sboard }).decision);
    RM.appendNote(board, { from: 'research', to: 'code', kind: 'request', body: 'a NEW delegated task' });
    const del = fire({ hook_event_name: 'Stop', cwd: sboard });
    ok('a new delivery to the still-deaf holder RE-OPENS the offer (clears the stuck marker)',
      del.decision === 'block' && /a NEW delegated task/.test(del.reason) && A8.wasOffered(SESSION) === false);
    RM.markRead(board, 'code');
    ok('...so the next quiet turn OFFERS the listener again (re-prompted per task, not silenced forever)',
      /hold the role "code"/.test(fire({ hook_event_name: 'Stop', cwd: sboard }).reason || ''));
    A8.clearWaiting(SESSION); A8.clearOffered(SESSION); RM.markRead(board, 'code');
  }

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

  // CASE 2 MUST ALSO BE ROLE-AWARE (deafness-hunt, 2026-07-18: the ONE re-arm site left on the
  // role-blind isWaiting after case 1 and case 3 were converted). A session that asked a peer,
  // then holds a listener armed for a DIFFERENT role, is DEAF to the reply (that listener polls
  // the old role's notes) — so the request offer MUST still fire. A role-blind check would call it
  // "already listening" and silently drop the answer it is owed.
  {
    const A2 = require(path.join(SRC, 'arc-await.js'));
    RM.markRead(board, 'code');                          // clear the delivered reply so case 1 is empty
    RM.appendNote(board, { from: 'code', to: 'research', kind: 'request', body: 'second question, still open' });
    A2.markWaiting(SESSION, 'SOME-OLD-ROLE', process.pid);   // a live listener, but for the wrong role
    const misAsk = fire({ hook_event_name: 'Stop', cwd: sboard });
    ok('case 2: a wrong-role listener does NOT count as reachable — the request offer STILL fires',
      misAsk.decision === 'block' && /STILL UNANSWERED/.test(misAsk.reason || ''));
    A2.clearWaiting(SESSION); A2.clearOffered(SESSION); RM.markRead(board, 'code');
  }
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
  // being true: a session that idles ALONE and only then gets a peer (someone delegates to it, a second
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

  // ---- THE SPAWN NAG lists a LEAK, never a chartered standing duty -----------------------------
  // The human caught the first cut nagging to close a chartered `research`. Closing a standing peer
  // is not free (revive pays boot + prefill) and an idle armed listener burns RAM, not quota. So the
  // nag now fires ONLY for an idle spawn with NO committed charter — a temp worker. Two spawns made
  // by THIS session (spawnsOf keys by conversation): one chartered, one not; both live and idle.
  RM.markRead(board, 'code');
  // spawnsOf/recordBirth key by CONVERSATION, and a birth with no bornOf is a no-op — so the
  // session must carry a convId (every real one does). Restamp the state file with one.
  fs.writeFileSync(path.join(scache, `arc-state-${SESSION}.json`), JSON.stringify({ pid: process.pid, cwd: sboard, convId: 'stop-conv-1' }));
  const myConv = F.sessionConv(SESSION);
  // stand in a live pid for each so liveRoles counts them as present
  RM.claimRole(board, 'helper', process.pid, 'helper-sess', 'helper-conv');   // NO charter file
  RM.claimRole(board, 'auditx', process.pid, 'auditx-sess', 'auditx-conv');   // has a charter below
  RM.recordBirth(board, 'helper', myConv);
  RM.recordBirth(board, 'auditx', myConv);
  fs.mkdirSync(path.join(sboard, '.arc', 'roles'), { recursive: true });
  fs.writeFileSync(path.join(sboard, '.arc', 'roles', 'auditx.md'), '# auditx\n\nowns: verification\nnot me: building\n');
  // BIRTH-AGE GRACE: a spawn younger than 120s is not yet nagged (it is still writing its charter).
  // age helper's birth past the grace so it reads as a genuine leak; a young one is tested below.
  const bornHelper = path.join(sboard, '.arc', 'peer', 'born-helper.json');
  const bh = JSON.parse(fs.readFileSync(bornHelper, 'utf8')); bh.at = Date.now() - 5 * 60000;
  fs.writeFileSync(bornHelper, JSON.stringify(bh));
  cycle();
  const nag = fire({ hook_event_name: 'Stop', cwd: sboard });
  ok('the spawn nag lists the CHARTERLESS spawn (a temp worker = a leak) once past the birth grace',
    nag.decision === 'block' && /"helper"/.test(nag.reason) && /arc close helper/.test(nag.reason));
  // a BRAND-NEW charterless spawn (birth just now) is NOT nagged — it is still writing its charter
  RM.claimRole(board, 'newborn', process.pid, 'newborn-sess', 'newborn-conv');
  RM.recordBirth(board, 'newborn', myConv);   // at = now, inside the grace
  cycle();
  ok('a spawn inside the birth grace is NOT nagged — no false leak while it writes its charter',
    !/"newborn"/.test(fire({ hook_event_name: 'Stop', cwd: sboard }).reason || ''));
  // clean the newborn so it doesn't leak into later assertions
  try { fs.unlinkSync(path.join(sboard, '.arc', 'peer', 'claim-newborn.json')); fs.unlinkSync(path.join(sboard, '.arc', 'peer', 'born-newborn.json')); } catch {}
  ok('...and NEVER lists the chartered standing duty — closing a teammate is the human\'s call, not a nag\'s',
    !/"auditx"/.test(nag.reason) && !/arc close auditx/.test(nag.reason));
  ok('...and the nag no longer claims an idle listener "burns quota" (it is blocked on a poll)',
    !/burns its own quota/.test(nag.reason));
  // give the leak a charter -> it becomes a standing duty -> the nag goes silent (nothing to leak)
  cycle();
  fs.writeFileSync(path.join(sboard, '.arc', 'roles', 'helper.md'), '# helper\n\nowns: odd jobs\n');
  ok('once the charterless spawn EARNS a charter, the nag stops — it is now a teammate, not a leak',
    !fire({ hook_event_name: 'Stop', cwd: sboard }).decision
    || !/arc close helper/.test(fire({ hook_event_name: 'Stop', cwd: sboard }).reason || ''));

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
