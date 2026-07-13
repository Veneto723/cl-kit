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
//     peek, gateway usage, the fridge). A failure here fails the build.
//   • PROBE — reports environment touchpoints (junction support, claude bin).
//     Informational only — it never fails the build.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ---- throwaway HOME (must be set BEFORE requiring any src module, since
// cl-config computes CLAUDE_DIR = homedir()/.claude at load time) --------------
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

// ---- 2. cl-config (portable core) -------------------------------------------
section('cl-config');
let C;
try {
  // A config with an oauth account + an api account keyed by ENV VAR (no DPAPI,
  // which is Windows-only) — everything here must resolve on any OS.
  writeJSON(path.join(CLAUDE, 'cl-config.json'), {
    version: 1, defaultAccount: 'sub', switchOrder: ['sub', 'gw'],
    accounts: [
      { id: 'sub', type: 'oauth', label: 'SUB' },
      { id: 'gw', type: 'api', label: 'GW', baseUrl: 'https://gw.example.com', apiKeyEnv: 'CLKIT_TEST_KEY', modelMap: { opus: 'big', sonnet: 'mid' } },
    ],
  });
  process.env.CLKIT_TEST_KEY = 'sk-test-123';
  C = require(path.join(SRC, 'cl-config.js'));
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
} catch (e) { ok('cl-config loads', false, e.message); }

// ---- 2b. cl-switch-core: chooseLaunchAccount (launch account selection) -------
// Regression: a plain API gateway with NO usage metrics (headroom=null) was excluded
// as a candidate, so launch fell back to a 100%-EXHAUSTED subscription instead of the
// available gateway. A gateway with no tracked limit must count as available.
section('cl-switch-core (launch account selection)');
try {
  const core = require(path.join(SRC, 'cl-switch-core.js'));
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
// cl:peek and auto-select scored every oauth account off that same blob.
section('cl-switch-core (per-account usage attribution)');
try {
  const core = require(path.join(SRC, 'cl-switch-core.js'));
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

  // A healthy account must keep its headroom even when its roommate is exhausted.
  const mixed = { usageByAccount: { veneto: slice(10, 10), whale: slice(99, 99) } };
  ok('healthy account keeps headroom while roommate is exhausted',
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

// ---- 3. cl-profile — the per-account credential ISOLATION fix ----------------
section('cl-profile (credential isolation)');
try {
  // hooks/statusLine to sync + a home .claude.json to seed
  writeJSON(path.join(CLAUDE, 'settings.json'), { hooks: { Stop: [] }, statusLine: { type: 'command', command: 'x' }, permissions: { allow: [] }, theme: 'dark' });
  fs.writeFileSync(path.join(TMP, '.claude.json'), JSON.stringify({ mcpServers: { cl: { type: 'stdio' } }, oauthAccount: { email: 'x@y.z' } }));
  // a real shared transcript, to prove the junction/symlink shares the "brain"
  const projDir = path.join(CLAUDE, 'projects', 'proj');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'c1.jsonl'), '{"t":1}\n');

  const P = require(path.join(SRC, 'cl-profile.js'));
  const dirA = P.ensureProfile('acctA');
  ok('ensureProfile creates the profile dir', fs.existsSync(dirA));
  // The junction (Windows) / symlink (POSIX) must make the shared transcript visible.
  ok('shared projects reachable through the profile (junction/symlink works on this OS)',
    fs.existsSync(path.join(dirA, 'projects', 'proj', 'c1.jsonl')));
  const ps = JSON.parse(fs.readFileSync(path.join(dirA, 'settings.json'), 'utf8'));
  ok('cl-owned settings synced (hooks/statusLine/permissions)', ps.hooks && ps.statusLine && ps.permissions);
  ok('non-cl settings NOT synced (theme left per-profile)', ps.theme === undefined);
  const cj = JSON.parse(fs.readFileSync(path.join(dirA, '.claude.json'), 'utf8'));
  ok('.claude.json seeded with mcp servers, oauthAccount stripped', cj.mcpServers && cj.mcpServers.cl && cj.oauthAccount === undefined);

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
  ok('...the original profile dir is GONE (no orphan left in cl-profiles)', !fs.existsSync(dirB));
  ok('...the login survives in trash, so removal is recoverable',
    fs.existsSync(path.join(trashed, '.credentials.json')) &&
    fs.readFileSync(path.join(trashed, '.credentials.json'), 'utf8').includes('tok-OTHER'));
  ok('removing one account leaves the others untouched', fs.existsSync(P.profileDir('acctA')));
  ok('removeProfile on a nonexistent account is a safe no-op (null)', P.removeProfile('never-existed') === null);
  // the graveyard must never be mistaken for a profile: account ids can't start with '.'
  ok('.trash is outside the account namespace', !/^[a-z]/i.test(path.basename(path.join(P.PROFILES_DIR, '.trash'))));
} catch (e) { ok('cl-profile works', false, e.message); }

// ---- 4. cl-sync — trash (list / restore / empty / transcriptMeta) ------------
section('cl-sync (trash)');
try {
  const sync = require(path.join(SRC, 'cl-sync.js'));
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
} catch (e) { ok('cl-sync works', false, e.message); }

// ---- cl-sync export selectors: `all` = THIS project, `global` = everything -------
section('cl-sync (export selectors)');
try {
  const sync = require(path.join(SRC, 'cl-sync.js'));

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
  fs.writeFileSync(path.join(cacheDir, `cl-state-${S}.json`), JSON.stringify({ convId: 'conv-here', cwd: 'E:\\somewhere-else' }));
  ok('currentProject uses the dir holding the current conversation', sync.currentProject(S, fake) === 'E--');

  // fallback: no convId -> encode the LAUNCH cwd, accepted only if that dir exists
  fs.writeFileSync(path.join(cacheDir, `cl-state-${S}.json`), JSON.stringify({ cwd: 'E:\\whalephone' }));
  ok('currentProject falls back to the encoded launch cwd', sync.currentProject(S, fake) === 'E--whalephone');

  // fallback rejects a cwd with no matching project dir
  fs.writeFileSync(path.join(cacheDir, `cl-state-${S}.json`), JSON.stringify({ cwd: 'Z:\\nothing-here' }));
  ok('currentProject returns null when it cannot tell', sync.currentProject(S, fake) === null);

  // and doExport refuses `all` (rather than guessing) when the project is unknown
  const r = sync.doExport(S, 'all');
  ok('`cl:export all` refuses when the project is undeterminable', r.ok === false && /which project folder/.test(r.message));
  ok('  and it points at `cl:export global`', /cl:export global/.test(r.message));

  try { fs.unlinkSync(path.join(cacheDir, `cl-state-${S}.json`)); } catch {}
} catch (e) { ok('cl-sync export selectors work', false, e.message); }

// ---- cl:import destination: a BARE positional == --dest ------------------------
// Regression: `cl:import <archive> E:` silently IGNORED the `E:` — the import ran with
// no re-rooting and landed in the archive's original project dir, so --dest looked
// broken. The bare form is what people actually type; it must mean the same as the flag.
section('cl-sync (import destination)');
try {
  const sync = require(path.join(SRC, 'cl-sync.js'));
  const tgz = path.join(TMP, 'fake.tgz');
  fs.writeFileSync(tgz, 'not-a-real-archive');       // must exist; we never get as far as untar

  // an absolute bare positional is accepted as the destination (no "must be absolute" error)
  const bare = sync.doImport('nosess', `"${tgz}" E: --dry-run`);
  ok('bare positional dest is not rejected as non-absolute', !/must be an ABSOLUTE/.test(bare.message));

  // a RELATIVE bare positional is caught and explained (not silently ignored, as before)
  const rel = sync.doImport('nosess', `"${tgz}" not-absolute --dry-run`);
  ok('a relative bare dest is REFUSED, not ignored', rel.ok === false && /must be an ABSOLUTE/.test(rel.message));
  ok('  and the error shows BOTH forms', /--dest/.test(rel.message) && /cl:import <archive>/.test(rel.message));

  // the explicit flag is still honoured, and wins over a positional
  const flag = sync.doImport('nosess', `"${tgz}" --dest bad-relative --dry-run`);
  ok('an explicit --dest is still validated', flag.ok === false && /must be an ABSOLUTE/.test(flag.message));
  ok('the flag WINS over a bare positional', /bad-relative/.test(
    sync.doImport('nosess', `"${tgz}" E: --dest bad-relative --dry-run`).message));

  // a missing archive is still the first thing reported
  ok('a missing archive still errors first', /archive not found/.test(sync.doImport('nosess', 'nope.tgz E:').message));
  fs.unlinkSync(tgz);
} catch (e) { ok('cl-sync import destination works', false, e.message); }

// ---- cl-sync — cl:import --dest re-rooting (office/home path parity) ----------
section('cl-sync (import --dest re-rooting)');
try {
  const sync = require(path.join(SRC, 'cl-sync.js'));

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
} catch (e) { ok('cl-sync --dest works', false, e.message); }

// ---- 5. cl-switch-core — peek + trash rendering ------------------------------
section('cl-switch-core');
try {
  const core = require(path.join(SRC, 'cl-switch-core.js'));
  const peek = core.buildPeek('no-session');
  ok('buildPeek returns a message (never throws)', peek && typeof peek.message === 'string' && peek.message.length > 0);
  const tr = core.requestTrash('no-session', '');
  ok('requestTrash list renders', tr && typeof tr.message === 'string');
  const del = core.requestDelete('', '');
  ok('requestDelete refuses outside a session', del.ok === false);
} catch (e) { ok('cl-switch-core works', false, e.message); }

// ---- 6. gw-usage — tolerant summarize ---------------------------------------
section('gw-usage');
try {
  const GW = require(path.join(SRC, 'gw-usage.js'));
  const s = GW.summarizeGatewayUsage({ usage: { today: 1.5 }, unit: 'USD', model_stats: [null, { model: 123 }, { model: 'x', tokens: 5 }] });
  ok('summarizeGatewayUsage tolerates null/non-string model rows', !!s);
} catch (e) { ok('gw-usage works', false, e.message); }

// ---- 7. cl-platform + storeApiKey (Windows key path: DPAPI) -------------------
// cl-kit is Windows 11 only, so this asserts the real DPAPI round-trip (via
// powershell.exe). It also proves the PORTABLE key sources (apiKeyEnv / apiKeyFrom)
// still resolve on Windows — only the POSIX OS-keychain source was dropped.
section('cl-platform + storeApiKey (DPAPI + portable key sources)');
try {
  const plat = require(path.join(SRC, 'cl-platform.js'));
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
} catch (e) { ok('cl-platform + storeApiKey work', false, e.message); }

// ---- 8. cl-wire-settings — installer settings merge (idempotent) -------------
section('cl-wire-settings (installer hook wiring)');
try {
  const scriptsDir = path.join(CLAUDE, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const wire = path.join(SRC, 'cl-wire-settings.js');
  // start from a user settings.json with a pre-existing key to confirm we merge, not clobber
  writeJSON(path.join(CLAUDE, 'settings.json'), { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node other.js' }] }] } });
  const r1 = spawnSync(process.execPath, [wire, scriptsDir], { encoding: 'utf8' });
  ok('cl-wire-settings runs', r1.status === 0, (r1.stderr || '').split('\n')[0]);
  const s = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8'));
  const cmds = (ev) => (s.hooks[ev] || []).flatMap((g) => (g.hooks || []).map((x) => x.command)).join(' | ');
  ok('preserves the user\'s existing settings + hook', s.theme === 'dark' && cmds('Stop').includes('other.js'));
  ok('wires UserPromptSubmit (switch-hook + notify start)', cmds('UserPromptSubmit').includes('cl-switch-hook.js') && cmds('UserPromptSubmit').includes('cl-notify.js'));
  ok('wires Stop/StopFailure/Notification cl-notify', cmds('Stop').includes('cl-notify.js') && cmds('StopFailure').includes('cl-notify.js') && cmds('Notification').includes('cl-notify.js'));
  ok('sets statusline', /usage-monitor\.js/.test(JSON.stringify(s.statusLine)));
  ok('no cl-signal allow-rule (slash commands removed)', !JSON.stringify(s.permissions || {}).includes('cl-signal.js'));
  ok('wires TaskCreated -> cl-done (baseline the HEAD sha)', cmds('TaskCreated').includes('cl-done.js'));
  ok('wires TaskCompleted -> cl-done (the git-derived gate)', cmds('TaskCompleted').includes('cl-done.js'));

  // install.ps1 wires the SAME hooks by hand. If the two lists drift, a fresh install
  // silently lacks whatever the newer one added — which is exactly how the gate would
  // "work on this machine" and nowhere else.
  const ps = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
  const wireSrc = fs.readFileSync(wire, 'utf8');
  const events = [...wireSrc.matchAll(/event:\s*'([A-Za-z]+)',\s*script:\s*'([\w.-]+)'/g)]
    .map(([, ev, sc]) => `${ev}:${sc}`);
  const missing = events.filter((e) => {
    const [ev, sc] = e.split(':');
    return !new RegExp(`Ensure-Hook \\$settings '${ev}'[^\\n]*${sc.replace('.', '\\.')}`).test(ps);
  });
  ok(`install.ps1 wires every hook cl-wire-settings does (${events.length})`, missing.length === 0, `missing: ${missing.join(', ')}`);
  ok('installer publishes the roommate skill at the shared agent path',
    ps.includes("'.agents\\skills'") && ps.includes("'skills\\share-with-roommate\\*'"));
  // idempotent: a second run must not duplicate hooks
  spawnSync(process.execPath, [wire, scriptsDir], { encoding: 'utf8' });
  const s2 = JSON.parse(fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8'));
  const stopCount = (s2.hooks.Stop || []).flatMap((g) => g.hooks || []).filter((x) => x.command.includes('cl-notify.js')).length;
  ok('re-run is idempotent (no duplicate hooks)', stopCount === 1);

  // safety: a MALFORMED settings.json must NOT be silently overwritten (must abort, untouched)
  const bad = '{ "theme": "dark", }'; // trailing comma → invalid JSON
  fs.writeFileSync(path.join(CLAUDE, 'settings.json'), bad);
  const rbad = spawnSync(process.execPath, [wire, scriptsDir], { encoding: 'utf8' });
  ok('refuses malformed settings.json (non-zero exit)', rbad.status !== 0);
  ok('leaves the malformed file untouched (no silent clobber)', fs.readFileSync(path.join(CLAUDE, 'settings.json'), 'utf8') === bad);
} catch (e) { ok('cl-wire-settings works', false, e.message); }

// ---- cl-anchor (has a doc's claim about the code gone stale?) -------------------
section('cl-anchor (doc/code staleness)');
try {
  const A = require(path.join(SRC, 'cl-anchor.js'));
  const RM = require(path.join(SRC, 'cl-room.js'));
  const { execFileSync } = require('child_process');

  // --- parsing ---
  const doc = 'blah\n<!-- cl:anchor src/auth.ts#handleLogin -->\nit validates the nonce\n'
    + '# cl:anchor lib/db.py#connect\n';
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
    '<!-- cl:anchor src/auth.js#handleLogin -->\nhandleLogin validates the request.\n');
  g('add', '-A'); g('commit', '-qm', 'seed');

  const room = RM.resolveRoom(repo);
  ok('git grep finds the anchored doc', A.anchorDocs(room.root).includes('docs/plan.md'));
  // an UNCOMMITTED doc still makes claims about the code — --untracked, not just tracked
  fs.writeFileSync(path.join(repo, 'docs', 'draft.md'), '<!-- cl:anchor src/auth.js#handleLogin -->\n');
  ok('and finds an uncommitted one too', A.anchorDocs(room.root).includes('docs/draft.md'));
  fs.rmSync(path.join(repo, 'docs', 'draft.md'));
  // …but never an ignored one
  fs.writeFileSync(path.join(repo, '.gitignore'), 'secret/\n');
  fs.mkdirSync(path.join(repo, 'secret'));
  fs.writeFileSync(path.join(repo, 'secret', 'x.md'), '<!-- cl:anchor src/auth.js#handleLogin -->\n');
  ok('ignored paths are never scanned', !A.anchorDocs(room.root).some((d) => d.startsWith('secret/')));
  fs.rmSync(path.join(repo, 'secret'), { recursive: true, force: true });
  fs.rmSync(path.join(repo, '.gitignore'));

  let rep = A.inspect(room);
  ok('first sighting SEALS the anchor', rep.results.length === 1 && rep.results[0].status === 'sealed');
  A.writeState(room, rep.next);

  // A doc EXAMPLE (`cl:anchor src/auth.ts#handleLogin` in a README) points at nothing
  // and never has. It must never nag — cl-kit's own README contains exactly this.
  fs.writeFileSync(path.join(repo, 'docs', 'readme.md'),
    'Put one next to a claim: <!-- cl:anchor src/nowhere.ts#imaginary -->\n');
  g('add', '-A'); g('commit', '-qm', 'add a doc with an example anchor');
  const ex = A.checkAndNotify(room, 'coding', { force: true, quiet: true });
  const exRes = ex.results.find((r) => r.symbol === 'imaginary');
  ok('a never-resolved anchor is "unresolved", not stale', exRes.status === 'unresolved');
  ok('and posts no note (a doc example must not nag)', ex.posted === 0);
  // Regression: the `unresolved` state entry must not count as "previously sealed",
  // or the example flips to stale on the SECOND run and nags forever.
  const ex2 = A.checkAndNotify(room, 'coding', { force: true, quiet: true });
  ok('and it STAYS quiet on the second run', ex2.posted === 0
    && ex2.results.find((r) => r.symbol === 'imaginary').status === 'unresolved');

  rep = A.inspect(room);
  ok('unchanged code -> ok', rep.results[0].status === 'ok');
  ok('and head is unchanged, so a check would be skipped', rep.headChanged === false);
  A.writeState(room, rep.next);

  // change the code -> stale
  fs.writeFileSync(path.join(repo, 'src', 'auth.js'), src.replace('  check(req);', '  skipCheck(req);'));
  g('add', '-A'); g('commit', '-qm', 'weaken the check');
  rep = A.inspect(room);
  ok('changed code -> changed', rep.results[0].status === 'changed');
  ok('and head moved, so the check runs', rep.headChanged === true);

  // notify: a [!] note, once
  const S = 'clanchortest';
  const F = require(path.join(SRC, 'cl-fridge.js'));
  const rf = F.roleFile(S);
  fs.mkdirSync(path.dirname(rf), { recursive: true });
  fs.writeFileSync(rf, JSON.stringify({ room: room.root, role: 'coding' }));
  try {
    const n1 = A.checkAndNotify(room, 'coding', { force: true, quiet: true });
    ok('a newly stale anchor posts exactly one note', n1.posted === 1);
    const note = RM.allNotes(room).pop();
    ok('the note is HIGH priority (jumps the queue)', note.priority === 'high');
    ok('the note names the doc AND the anchor', /docs\/plan\.md/.test(note.body) && /auth\.js#handleLogin/.test(note.body));
    ok('and carries machine-readable refs', note.refs.why === 'changed' && note.refs.doc === 'docs/plan.md');

    const n2 = A.checkAndNotify(room, 'coding', { force: true, quiet: true });
    ok('an ALREADY-stale anchor does not nag again', n2.posted === 0);

    // delete the file -> a NEW kind of staleness, so it speaks again
    fs.rmSync(path.join(repo, 'src', 'auth.js'));
    g('add', '-A'); g('commit', '-qm', 'drop auth');
    const n3 = A.checkAndNotify(room, 'coding', { force: true, quiet: true });
    ok('a gone FILE is reported (status escalated)', n3.results[0].status === 'gone-file');

    // reseal: the current code becomes the baseline again
    const rr = A.requestAnchors(S, 'reseal', repo);
    ok('cl:anchors reseal clears the stale flags', /resealed 2 anchor\(s\)/.test(rr.message));
    // Reseal means "the current code is the baseline", NOT "stop telling me". An anchor
    // whose target file is still gone is still a lie, so it speaks again on the next
    // check. Only fixing the doc (or deleting the anchor) actually silences it.
    ok('reseal does NOT silence an anchor that is still broken',
      A.checkAndNotify(room, 'coding', { force: true, quiet: true }).posted === 1);
    // Deleting the anchor from the doc is what ends it.
    fs.writeFileSync(path.join(repo, 'docs', 'plan.md'), 'handleLogin used to validate the request.\n');
    const after = A.checkAndNotify(room, 'coding', { force: true, quiet: true });
    ok('removing the anchor ends the alarm', after.posted === 0 && after.checked === 1);

    // head-unchanged short-circuit
    const n4 = A.checkAndNotify(room, 'coding');
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
} catch (e) { ok('cl-anchor works', false, e.message); }

// ---- cl-done (derive "done" from git, not from the agent's word) ---------------
section('cl-done (git-derived completion)');
try {
  const D = require(path.join(SRC, 'cl-done.js'));
  const RM = require(path.join(SRC, 'cl-room.js'));
  const F = require(path.join(SRC, 'cl-fridge.js'));
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
  const room = RM.resolveRoom(repo);
  ok('two sessions\' task "1" do not collide',
    D.baselineFile(room, 'sess-A', '1') !== D.baselineFile(room, 'sess-B', '1'));

  // --- end to end: a completion posts a note carrying the sha ---
  const S = 'cldonetest';
  const roleFile = F.roleFile(S);
  fs.mkdirSync(path.dirname(roleFile), { recursive: true });
  fs.writeFileSync(roleFile, JSON.stringify({ room: room.root, role: 'coding' }));
  try {
    D.recordBaseline(room, S, '7', base);
    process.env.CL_DONE_GATE = 'note';
    const r = D.onTaskCompleted({ task_id: '7', task_subject: 'Implement P-014', cwd: repo }, S);
    ok('a proven completion posts a note', r.posted === true && r.proven === true && r.block === false);
    const notes = RM.allNotes(room);
    const n = notes[notes.length - 1];
    ok('the note is FROM the completing role', n.from === 'coding');
    ok('the note is a broadcast (any roommate sees it)', n.to === null);
    ok('the note names the task', /Implement P-014/.test(n.body));
    ok('the note CARRIES THE SHA as evidence', typeof n.refs.sha === 'string' && n.refs.sha.length >= 7);
    ok('the note carries the changed files', n.refs.files.includes('feature.js'));

    // strict mode, nothing committed since -> the tick is refused
    const base2 = D.head(repo);
    D.recordBaseline(room, S, '8', base2);
    process.env.CL_DONE_GATE = 'strict';
    const r2 = D.onTaskCompleted({ task_id: '8', task_subject: 'Claim without committing', cwd: repo }, S);
    ok('strict REFUSES a completion with no commit', r2.block === true);
    ok('and tells the agent why, on stderr', /no commit found/.test(r2.stderr));
    ok('and posts NOTHING when it blocks', RM.allNotes(room).length === notes.length);

    // a session with no role stays silent rather than inventing a sender
    process.env.CL_DONE_GATE = 'note';
    const r3 = D.onTaskCompleted({ task_id: '9', task_subject: 'x', cwd: repo }, 'no-role-session');
    ok('no role -> no note, no crash', !r3.posted && r3.block === false);

    // NO REPO, NO GATE. "there is no git here" != "git says you committed nothing".
    // Caught live: a cwd that drifted to a non-repo made strict refuse EVERY completion.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'norepo-'));
    process.env.CL_DONE_GATE = 'strict';
    const r4 = D.onTaskCompleted({ task_id: '1', task_subject: 'x', cwd: bare }, S);
    ok('strict does NOT block outside a git repo', r4.block === false);
    fs.rmSync(bare, { recursive: true, force: true });

    // An ORPHANED baseline sha (rebase/amend) must fall back to the task's birth time,
    // not silently become "unknown" and block a legitimately committed task. The task
    // FILE is the fallback, so the fixture must actually have one — point CLAUDE_CONFIG_DIR
    // at a sandbox rather than fake it.
    const bl = D.readBaseline(room, S, '7', path.join(repo, 'seed.txt'));
    ok('readBaseline returns BOTH a sha and a birth time', bl.sha === base && typeof bl.born === 'string');

    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
    const prevCfg = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cfg;
    try {
      fs.mkdirSync(path.join(cfg, 'tasks', S), { recursive: true });
      fs.writeFileSync(path.join(cfg, 'tasks', S, '10.json'), '{"id":"10"}');   // born NOW
      D.recordBaseline(room, S, '10', 'dead1234beefdead1234beefdead1234beefdead'); // never existed
      fs.writeFileSync(path.join(repo, 'after.js'), 'work');
      g('add', '-A'); g('commit', '-qm', 'work done after the task was born');

      process.env.CL_DONE_GATE = 'strict';
      const r5 = D.onTaskCompleted({ task_id: '10', task_subject: 'orphaned baseline', cwd: repo }, S);
      ok('an orphaned baseline sha falls back to birth time, does not block', r5.block === false);
      ok('and it still posts PROVEN, with the real sha', r5.posted === true && r5.proven === true);
    } finally {
      if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevCfg;
      fs.rmSync(cfg, { recursive: true, force: true });
    }
  } finally {
    delete process.env.CL_DONE_GATE;
    try { fs.unlinkSync(roleFile); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
  }
} catch (e) { ok('cl-done works', false, e.message); }

// ---- cl-postcommit (every commit -> a fridge note, no task list needed) --------
section('cl-postcommit (commit -> fridge note)');
try {
  const PC = require(path.join(SRC, 'cl-postcommit.js'));
  const RM = require(path.join(SRC, 'cl-room.js'));
  const { execFileSync } = require('child_process');

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  const room = RM.resolveRoom(repo); RM.ensureRoom(room);
  // arm a role for our session (cache is under the sandbox HOME)
  const cacheDir = path.join(os.homedir(), '.claude', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'cl-role-pcsess.json'), JSON.stringify({ room: room.root, role: 'android' }));

  // no CL_SESSION -> no note (a non-cl commit must not spam the fridge)
  fs.writeFileSync(path.join(repo, 'a.js'), 'x'); g('add', '-A'); g('commit', '-qm', 'first');
  delete process.env.CL_SESSION;
  ok('a commit with no CL_SESSION posts nothing', PC.run(repo).posted === false);
  ok('  and the fridge is still empty', RM.allNotes(room).length === 0);

  // CL_SESSION with a role -> a note attributed to that role
  fs.writeFileSync(path.join(repo, 'feature.js'), 'y'); g('add', '-A'); g('commit', '-qm', 'add the overlay fix');
  process.env.CL_SESSION = 'pcsess';
  try {
    const r = PC.run(repo);
    ok('a cl commit posts a note', r.posted === true && r.role === 'android');
    const n = RM.allNotes(room).pop();
    ok('  from the committing role, broadcast', n.from === 'android' && n.to === null);
    ok('  body names the commit subject', /committed: add the overlay fix/.test(n.body));
    ok('  refs carry the real sha + files', n.refs.sha === PC.git(repo, ['rev-parse', '--short', 'HEAD']) && n.refs.files.includes('feature.js'));
    ok('  the roommate sees it, the committer does not',
      RM.unreadFor(room, 'frontend').count === 1 && RM.unreadFor(room, 'android').count === 0);

    // a role claimed in a DIFFERENT room does not attribute here
    fs.writeFileSync(path.join(cacheDir, 'cl-role-elsewhere.json'), JSON.stringify({ room: 'z:\\other', role: 'x' }));
    ok('roleFor ignores a role from another room', PC.roleFor('elsewhere', room) === null);
  } finally {
    delete process.env.CL_SESSION;
    try { fs.unlinkSync(path.join(cacheDir, 'cl-role-pcsess.json')); } catch {}
    fs.rmSync(repo, { recursive: true, force: true });
  }
} catch (e) { ok('cl-postcommit works', false, e.message); }

// ---- cl-runner fridge CLI (cl note / cl role — the AGENT-facing surface) --------
// The agent can't TYPE cl:note (the hook eats it), but it can RUN `cl note ...` via
// Bash. This exercises that dispatch end to end through the real cl-runner process.
section('cl-runner fridge CLI (cl note / cl role)');
try {
  const runner = path.join(SRC, 'cl-runner.js');
  const RM = require(path.join(SRC, 'cl-room.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clicli-'));
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const room = RM.resolveRoom(repo); RM.ensureRoom(room);
  const S = 'clicli-sess';
  fs.mkdirSync(path.join(CLAUDE, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(CLAUDE, 'cache', `cl-role-${S}.json`), JSON.stringify({ room: room.root, role: 'android' }));
  const env = { ...process.env, CL_SESSION: S };

  const post = spawnSync(process.execPath, [runner, 'note', 'all', 'shared: /login is 202 now'], { cwd: repo, env, encoding: 'utf8' });
  ok('`cl note` exits 0', post.status === 0, (post.stderr || '').split('\n')[0]);
  ok('`cl note` posts to the fridge, attributed to the role',
    RM.allNotes(room).some((n) => /login is 202/.test(n.body) && n.from === 'android'));
  ok('`cl note` output leaks no cl: sentinel form', !/cl:(note|role|notes)/.test(post.stdout));

  const role = spawnSync(process.execPath, [runner, 'role'], { cwd: repo, env, encoding: 'utf8' });
  ok('`cl role` reports your role', /your role: android/.test(role.stdout));

  // a session with no role can't post; the hint is rewritten to the CLI form (this is
  // where the cl:role -> cl role rewrite is actually exercised).
  const noRole = spawnSync(process.execPath, [runner, 'note', 'all', 'x'], { cwd: repo, env: { ...process.env, CL_SESSION: 'no-role-sess' }, encoding: 'utf8' });
  const out = noRole.stdout + noRole.stderr;
  ok('`cl note` with no role is refused and points to `cl role`', noRole.status !== 0 && /cl role/.test(out) && !/cl:role/.test(out));

  fs.rmSync(repo, { recursive: true, force: true });
  try { fs.unlinkSync(path.join(CLAUDE, 'cache', `cl-role-${S}.json`)); } catch {}
} catch (e) { ok('cl-runner fridge CLI works', false, e.message); }

// ---- cl-watch (wake a delegate session on an incoming delegation) ---------------
// A delegate (e.g. research) can't be pushed to while idle; it runs `cl watch` in the
// background so a delegation prints a line that re-invokes it. This tests the emit
// logic: each unread note once, own notes excluded, the read cursor never touched.
section('cl-watch (delegation waker)');
try {
  const W = require(path.join(SRC, 'cl-watch.js'));
  const RM = require(path.join(SRC, 'cl-room.js'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clwatch-'));
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const room = RM.resolveRoom(repo); RM.ensureRoom(room);

  ok('resolveRole prefers an explicit arg', W.resolveRole('research', 'sess', room) === 'research');
  ok('resolveRole with no arg + no session -> null', W.resolveRole('', '', room) === null);

  RM.appendNote(room, { from: 'android', to: 'research', body: 'investigate the tap drop' });
  RM.appendNote(room, { from: 'android', to: null, body: 'broadcast: bumped node' });   // to:null = real broadcast
  RM.appendNote(room, { from: 'research', to: 'android', body: 'my own note' });

  const out = []; const emitted = new Set();
  W.poll(room, 'research', emitted, (l) => out.push(l));
  ok('emits the addressed delegation', out.some((l) => /from android: investigate the tap drop/.test(l)));
  ok('emits a real broadcast (to:null)', out.some((l) => /broadcast: bumped node/.test(l)));
  ok('does NOT emit the watcher\'s own note', !out.some((l) => /my own note/.test(l)));
  ok('emits exactly the two for-me notes', out.length === 2);

  const dup = []; W.poll(room, 'research', emitted, (l) => dup.push(l));
  ok('a second poll re-emits nothing (each note once)', dup.length === 0);
  ok('watching never advances the read cursor (cl notes still delivers)',
    RM.readCursor(room, 'research') === 0 && RM.unreadFor(room, 'research').count === 2);

  // a high-priority delegation is flagged
  RM.appendNote(room, { from: 'android', to: 'research', priority: 'high', body: 'URGENT: prod is down' });
  const hi = []; W.poll(room, 'research', emitted, (l) => hi.push(l));
  ok('a [!] delegation is flagged in the emit', hi.length === 1 && /\[!\]/.test(hi[0]));

  fs.rmSync(repo, { recursive: true, force: true });
} catch (e) { ok('cl-watch works', false, e.message); }

// ---- cl-transpile (Claude transcript -> text-first codex messages) --------------
// Proven live end to end: these messages, injected into a Codex rollout, let `codex
// resume` recall a fact that only existed in the Claude session. This locks the pure
// conversion: text at full fidelity, tools as short markers, noise dropped.
section('cl-transpile (Claude -> Codex text-first)');
try {
  const T = require(path.join(SRC, 'cl-transpile.js'));
  const recs = [
    { type: 'system', subtype: 'x' },                                                    // meta -> skip
    { type: 'user', message: { role: 'user', content: 'Add retries to the task_log schema.' } },
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'internal deliberation' },                            // dropped
      { type: 'text', text: 'Reading the schema first.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'grep -n retries db.sql' } }] } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent noise' } }, // sidechain -> skip
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'db.sql: no match', is_error: false }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Added retries INT DEFAULT 0.' }] } },
  ];
  const { messages, stats } = T.transpile(recs);
  ok('meta + sidechain turns are dropped', stats.records === 6 && messages.length === 4 && stats.droppedTurns === 1);
  ok('user string content becomes a user turn', messages[0].role === 'user' && /Add retries/.test(messages[0].text));
  ok('thinking is dropped', !/internal deliberation/.test(JSON.stringify(messages)));
  ok('tool_use renders as a short text marker (Bash -> command)', /\[ran Bash: grep -n retries db\.sql\]/.test(messages[1].text));
  ok('tool_result renders as a short text marker on a user turn', /\[result: db\.sql: no match\]/.test(messages[2].text));
  ok('an errored tool_result is flagged', /\(error\)/.test(T.blockToText({ type: 'tool_result', content: 'boom', is_error: true })));
  ok('history alternates and starts on a user turn', messages[0].role === 'user' && messages[3].role === 'assistant');
  // huge tool output is clipped, not dumped
  ok('a giant tool result is clipped', T.blockToText({ type: 'tool_result', content: 'x'.repeat(5000) }).length < 400);
  // keepLast tail-cap keeps the recent messages and never starts on assistant
  const many = []; for (let i = 0; i < 10; i++) many.push({ type: i % 2 ? 'assistant' : 'user', message: { role: i % 2 ? 'assistant' : 'user', content: `m${i}` } });
  const tail = T.transpile(many, { keepLast: 4 });
  ok('keepLast keeps the recent messages, starting on a user turn', tail.messages.length <= 4 && tail.messages[0].role === 'user');
} catch (e) { ok('cl-transpile works', false, e.message); }

// ---- cl-handoff (locate transcript + dry-run, no codex needed) ------------------
section('cl-handoff (transcript locate + dry-run)');
try {
  const H = require(path.join(SRC, 'cl-handoff.js'));
  // a fixture transcript under the sandbox HOME's projects dir
  const conv = 'ffff0000-1111-2222-3333-444455556666';
  const projDir = path.join(CLAUDE, 'projects', 'C--proj-x');
  fs.mkdirSync(projDir, { recursive: true });
  const repo = path.join(TMP, 'ho-repo');
  const line = (t, c) => JSON.stringify({ type: t, cwd: repo, message: { role: t, content: c } });
  fs.writeFileSync(path.join(projDir, `${conv}.jsonl`),
    [line('user', 'the codename is Osprey.'), line('assistant', [{ type: 'text', text: 'Noted: Osprey.' }])].join('\n') + '\n');

  ok('findTranscript locates the conversation by id', H.findTranscript(conv) === path.join(projDir, `${conv}.jsonl`));
  ok('findTranscript returns null for an unknown id', H.findTranscript('no-such-id') === null);

  const dry = H.handoff('nosession', { convId: conv, dryRun: true });
  ok('dry-run transpiles without invoking codex', dry.ok === true && dry.dryRun === true && /2 message\(s\)/.test(dry.message));
  ok('dry-run recovers the repo cwd from the transcript', /ho-repo/.test(dry.message));
  const direct = H.handoff('', { transcript: path.join(projDir, `${conv}.jsonl`), dryRun: true });
  ok('hook-style direct transcript handoff does not depend on cl state', direct.ok === true && /ho-repo/.test(direct.message));
  const miss = H.handoff('nosession', { convId: 'no-such-id', dryRun: true });
  ok('a missing transcript is reported, not crashed', miss.ok === false && /couldn't find the transcript/.test(miss.message));
  const seeds = path.join(TMP, 'codex-seeds');
  fs.mkdirSync(seeds, { recursive: true });
  const seedA = path.join(seeds, 'rollout-a.jsonl');
  const seedB = path.join(seeds, 'rollout-b.jsonl');
  fs.writeFileSync(seedA, 'CL_HANDOFF_SEED unique-a\n');
  fs.writeFileSync(seedB, 'CL_HANDOFF_SEED unique-b\n');
  ok('handoff seed discovery matches the unique marker, not another concurrent seed',
    H.findSeedRollout('CL_HANDOFF_SEED unique-a', seeds) === seedA);
} catch (e) { ok('cl-handoff works', false, e.message); }

// ---- orchestration registry + Codex runtime account isolation ----------------
section('runtime orchestration (logical sessions + Codex accounts)');
try {
  const O = require(path.join(SRC, 'cl-orchestrator.js'));
  const A = require(path.join(SRC, 'cl-codex-account.js'));
  const CR = require(path.join(SRC, 'cl-runtime-codex.js'));

  const first = O.ensureSession({ runtime: 'claude', nativeSessionId: 'claude-native-1', account: 'work', cwd: TMP });
  const same = O.ensureSession({ runtime: 'claude', nativeSessionId: 'claude-native-1', account: 'work', cwd: TMP });
  ok('native session lookup reuses one logical session', first.id === same.id && O.listSessions().length === 1);
  const handed = O.bindRuntime(first.id, 'codex', { nativeSessionId: 'codex-native-1', account: 'default', cwd: TMP }, { reason: 'handoff' });
  ok('a handoff keeps logical identity and records both runtime bindings',
    handed.id === first.id && handed.activeRuntime === 'codex' && handed.bindings.claude && handed.bindings.codex);
  ok('runtime lineage records the transition once', handed.lineage.length === 1 && handed.lineage[0].from === 'claude');
  O.bindRuntime(first.id, 'codex', { model: 'test-model' });
  ok('refreshing the active binding does not invent another handoff', O.readSession(first.id).lineage.length === 1);
  const brokenSession = O.sessionPath('broken-session');
  fs.mkdirSync(path.dirname(brokenSession), { recursive: true });
  fs.writeFileSync(brokenSession, '{broken');
  let sessionRefused = false;
  try { O.ensureSession({ id: 'broken-session', runtime: 'codex', cwd: TMP }); } catch { sessionRefused = true; }
  ok('a malformed logical session is refused and not overwritten',
    sessionRefused && fs.readFileSync(brokenSession, 'utf8') === '{broken');
  fs.unlinkSync(brokenSession);

  writeJSON(A.REGISTRY_PATH, { version: 1, futureRuntime: { keep: true } });
  const fallback = A.findAccount();
  ok('Codex has an implicit default account mapped to the native home', fallback.id === 'default' && /\.codex$/.test(fallback.home));
  const work = A.addAccount('codex-work');
  ok('Codex account metadata uses an isolated CODEX_HOME', work.id === 'codex-work' && work.home !== fallback.home);
  ok('Codex account writes preserve unknown future registry sections',
    JSON.parse(fs.readFileSync(A.REGISTRY_PATH, 'utf8')).futureRuntime.keep === true);
  const registryGood = fs.readFileSync(A.REGISTRY_PATH, 'utf8');
  fs.writeFileSync(A.REGISTRY_PATH, '{broken');
  let registryRefused = false;
  try { A.accounts(); } catch { registryRefused = true; }
  ok('a malformed account registry is refused and not overwritten',
    registryRefused && fs.readFileSync(A.REGISTRY_PATH, 'utf8') === '{broken');
  fs.writeFileSync(A.REGISTRY_PATH, registryGood);
  const env = A.buildEnv(work, 'wrapper-1', first.id);
  ok('Codex child env carries runtime, account, wrapper, and logical identities',
    env.CODEX_HOME === work.home && env.CL_SESSION === 'wrapper-1' && env.CL_LOGICAL_SESSION === first.id
    && env.CL_RUNTIME === 'codex' && env.CL_RUNTIME_ACCOUNT === 'codex-work');

  // Codex reads lifecycle hooks from `[hooks]` in config.toml (TOML array-of-tables),
  // NOT a JSON hooks.json — verified empirically against the real codex binary + a live
  // turn. ensureHooks appends a managed block, preserving the user's config, idempotently,
  // and clears any dead hooks.json a prior (wrong) version left behind.
  fs.writeFileSync(path.join(work.home, 'config.toml'), 'model = "gpt-x"\n[windows]\nsandbox = "elevated"\n');
  writeJSON(path.join(work.home, 'hooks.json'), { hooks: { SessionStart: [{ hooks: [{ command: 'node "z/cl-codex-hook.js"' }] }] } }); // dead artifact
  CR.ensureHooks(work); CR.ensureHooks(work);
  const cfg = fs.readFileSync(path.join(work.home, 'config.toml'), 'utf8');
  ok('Codex hook install preserves the user config.toml', /sandbox = "elevated"/.test(cfg) && /model = "gpt-x"/.test(cfg));
  ok('Codex hook install writes [hooks] for both lifecycle events',
    /\[\[hooks\.SessionStart\.hooks\]\]/.test(cfg) && /\[\[hooks\.UserPromptSubmit\.hooks\]\]/.test(cfg)
    && /type = "command"/.test(cfg) && /cl-codex-hook\.js/.test(cfg));
  ok('Codex hook install is idempotent', (cfg.match(/cl-kit managed hooks \(do not edit/g) || []).length === 1);
  ok('Codex hook install clears the dead hooks.json a prior version wrote', !fs.existsSync(path.join(work.home, 'hooks.json')));
  ok('Codex command adapter uses the Windows cmd shim', process.platform !== 'win32' || /cmd\.exe$/i.test(CR.commandSpec([]).bin));
  ok('Codex launch bypasses hook trust (cl vets its own hook source)',
    CR.commandSpec(['exec'], { bypassHookTrust: true }).args.includes('--dangerously-bypass-hook-trust')
    && !CR.commandSpec(['exec']).args.includes('--dangerously-bypass-hook-trust'));
  const yoloSpec = CR.commandSpec(['resume', 'x'], { bypassHookTrust: true, yolo: true }).args;
  ok('Codex --yolo is a global flag placed before the subcommand',
    yoloSpec.includes('--yolo') && yoloSpec.indexOf('--yolo') < yoloSpec.indexOf('resume')
    && !CR.commandSpec(['resume', 'x'], { bypassHookTrust: true }).args.includes('--yolo'));

  const codexHook = path.join(SRC, 'cl-codex-hook.js');
  const hookEnv = {
    ...process.env,
    CL_SESSION: 'codex-wrapper-1',
    CL_LOGICAL_SESSION: first.id,
    CL_RUNTIME_ACCOUNT: 'codex-work',
  };
  const start = spawnSync(process.execPath, [codexHook], {
    env: hookEnv,
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'codex-native-2', cwd: TMP, model: 'test-model' }),
    encoding: 'utf8',
  });
  ok('Codex SessionStart hook is silent and succeeds', start.status === 0 && !(start.stdout || '').trim());
  ok('Codex SessionStart binds the native id into the logical session',
    O.readSession(first.id).bindings.codex.nativeSessionId === 'codex-native-2');
  const codexHelp = spawnSync(process.execPath, [codexHook], {
    env: hookEnv,
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'codex-native-2', cwd: TMP, prompt: 'cl:help' }),
    encoding: 'utf8',
  });
  let codexHelpOut = {}; try { codexHelpOut = JSON.parse(codexHelp.stdout || '{}'); } catch {}
  ok('Codex UserPromptSubmit hook blocks cl:help before the model',
    codexHelpOut.decision === 'block' && /cl — Codex commands/.test(codexHelpOut.reason || '')
    && !/cl:switch/.test(codexHelpOut.reason || ''));
} catch (e) { ok('runtime orchestration works', false, e.message); }

section('cl-runner Codex launch adapter');
try {
  const fakeBin = path.join(TMP, 'fake-codex-bin');
  const fakeJs = path.join(fakeBin, 'fake-codex.js');
  const capture = path.join(fakeBin, 'capture.json');
  const launchHome = path.join(TMP, 'launch-cl-home');
  const nativeHome = path.join(TMP, 'launch-codex-home');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(fakeJs,
    `require('fs').writeFileSync(process.env.FAKE_CODEX_CAPTURE, JSON.stringify({args:process.argv.slice(2),env:{CODEX_HOME:process.env.CODEX_HOME,CL_SESSION:process.env.CL_SESSION,CL_LOGICAL_SESSION:process.env.CL_LOGICAL_SESSION,CL_RUNTIME:process.env.CL_RUNTIME,CL_RUNTIME_ACCOUNT:process.env.CL_RUNTIME_ACCOUNT}}));`);
  fs.writeFileSync(path.join(fakeBin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${fakeJs}" %*\r\n`);
  const launched = spawnSync(process.execPath, [path.join(SRC, 'cl-runner.js'), 'codex', '--account', 'default', '--help'], {
    cwd: TMP,
    env: {
      ...process.env,
      PATH: `${fakeBin};${process.env.PATH || ''}`,
      CL_HOME: launchHome,
      CODEX_HOME: nativeHome,
      FAKE_CODEX_CAPTURE: capture,
    },
    encoding: 'utf8',
    timeout: 15000,
  });
  ok('cl codex launches and returns the child exit code', launched.status === 0, launched.stderr);
  const got = JSON.parse(fs.readFileSync(capture, 'utf8'));
  ok('cl codex forwards native arguments (after the hook-trust flag)',
    got.args[0] === '--dangerously-bypass-hook-trust' && got.args.slice(1).join(' ') === '--help');
  ok('cl codex supplies isolated account and orchestration environment',
    got.env.CODEX_HOME === nativeHome && got.env.CL_RUNTIME === 'codex' && got.env.CL_RUNTIME_ACCOUNT === 'default'
    && got.env.CL_SESSION && got.env.CL_LOGICAL_SESSION);
  const launchSessions = fs.readdirSync(path.join(launchHome, 'sessions')).map((f) => JSON.parse(fs.readFileSync(path.join(launchHome, 'sessions', f), 'utf8')));
  ok('cl codex persists a logical session and marks the exited binding',
    launchSessions.length === 1 && launchSessions[0].bindings.codex.state === 'exited');
  const installedCfg = fs.readFileSync(path.join(nativeHome, 'config.toml'), 'utf8');
  ok('cl codex installs lifecycle hooks into the selected CODEX_HOME config.toml',
    /\[\[hooks\.SessionStart\.hooks\]\]/.test(installedCfg) && /\[\[hooks\.UserPromptSubmit\.hooks\]\]/.test(installedCfg));
} catch (e) { ok('cl-runner Codex launch works', false, e.message); }

section('cl-runner supervised Claude -> Codex handoff loop');
try {
  const loopRoot = path.join(TMP, 'handoff-loop');
  const loopUser = path.join(loopRoot, 'user');
  const loopBin = path.join(loopRoot, 'bin');
  const loopClHome = path.join(loopRoot, 'cl-home');
  const loopCodexHome = path.join(loopRoot, 'codex-home');
  const fakeClaude = path.join(loopRoot, 'fake-claude.js');
  const fakeCodex = path.join(loopRoot, 'fake-codex.js');
  const codexCalls = path.join(loopRoot, 'codex-calls.jsonl');
  fs.mkdirSync(loopBin, { recursive: true });

  fs.writeFileSync(fakeClaude, [
    "const fs=require('fs'),path=require('path');",
    "const root=process.env.FAKE_LOOP_ROOT;",
    "const transcript=path.join(root,'source.jsonl');",
    "const cwd=root;",
    "fs.writeFileSync(transcript,[JSON.stringify({type:'permission-mode',permissionMode:'auto',cwd}),JSON.stringify({type:'user',cwd,message:{role:'user',content:'continue this work'}}),JSON.stringify({type:'assistant',cwd,message:{role:'assistant',content:[{type:'text',text:'ready to continue'}]}})].join('\\n')+'\\n');",
    "const cache=path.join(process.env.USERPROFILE,'.claude','cache');fs.mkdirSync(cache,{recursive:true});",
    "const trigger=path.join(cache,'cl-handoff-'+process.env.CL_SESSION+'.trigger');",
    "fs.writeFileSync(trigger,JSON.stringify({source:'claude',target:'codex',account:null,keepLast:0,transcriptPath:transcript,cwd,nativeSessionId:'claude-loop-native',logicalSessionId:process.env.CL_LOGICAL_SESSION,at:Date.now()}));",
    "setInterval(()=>{},1000);",
  ].join('\n'));
  fs.writeFileSync(fakeCodex, [
    "const fs=require('fs'),path=require('path');",
    "const args=process.argv.slice(2);fs.appendFileSync(process.env.FAKE_CODEX_CALLS,JSON.stringify({args,logical:process.env.CL_LOGICAL_SESSION||null})+'\\n');",
    "if(args[0]==='exec'){",
    " const id='11111111-2222-4333-8444-555555555555',dir=path.join(process.env.CODEX_HOME,'sessions');fs.mkdirSync(dir,{recursive:true});",
    " const marker=args.join(' '),turn='turn-loop';",
    " const rows=[{type:'session_meta',payload:{session_id:id,internal_chat_message_metadata_passthrough:{turn_id:turn}}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:marker}],internal_chat_message_metadata_passthrough:{turn_id:turn}}}];",
    " fs.writeFileSync(path.join(dir,'rollout-loop.jsonl'),rows.map(JSON.stringify).join('\\n')+'\\n');",
    "}",
  ].join('\n'));
  fs.writeFileSync(path.join(loopBin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${fakeCodex}" %*\r\n`);
  writeJSON(path.join(loopUser, '.claude', 'cl-config.json'), {
    version: 1,
    defaultAccount: 'sub',
    switchOrder: ['sub'],
    claudeBin: process.execPath,
    accounts: [{ id: 'sub', label: 'SUB', type: 'oauth' }],
    features: { autoBest: false },
  });

  const loop = spawnSync(process.execPath, [path.join(SRC, 'cl-runner.js'), fakeClaude], {
    cwd: loopRoot,
    env: {
      ...process.env,
      HOME: loopUser,
      USERPROFILE: loopUser,
      PATH: `${loopBin};${process.env.PATH || ''}`,
      CL_HOME: loopClHome,
      CODEX_HOME: loopCodexHome,
      FAKE_LOOP_ROOT: loopRoot,
      FAKE_CODEX_CALLS: codexCalls,
    },
    encoding: 'utf8',
    timeout: 30000,
  });
  ok('supervisor completes the runtime replacement in one process', loop.status === 0, loop.stderr);
  const calls = fs.readFileSync(codexCalls, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  // The seed is a throwaway `codex exec` spawned directly (no trust flag — the untrusted
  // hook is harmlessly skipped, keeping the seed rollout clean). The resume goes through
  // the launch adapter, which prepends --dangerously-bypass-hook-trust so the fridge hook
  // fires on the resumed session; and because the handed-off Claude transcript is in
  // "auto" mode, --yolo carries the hands-off posture into Codex.
  const resumeArgs = calls[1].args;
  const resumeIdx = resumeArgs.indexOf('resume');
  ok('handoff seeds Codex and then resumes the minted native session',
    calls.length === 2 && calls[0].args[0] === 'exec'
    && resumeIdx >= 0 && resumeArgs[resumeIdx + 1] === '11111111-2222-4333-8444-555555555555');
  ok('handoff carries the hook-trust bypass so the fridge hook fires on resume',
    resumeArgs.includes('--dangerously-bypass-hook-trust'));
  ok('handoff maps Claude "auto" mode to codex --yolo on resume',
    resumeArgs.includes('--yolo') && resumeArgs.indexOf('--yolo') < resumeIdx);
  const loopSessions = fs.readdirSync(path.join(loopClHome, 'sessions'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(loopClHome, 'sessions', f), 'utf8')));
  const loopSession = loopSessions[0];
  ok('the loop retains one logical identity with both native bindings',
    loopSessions.length === 1 && loopSession.bindings.claude && loopSession.bindings.codex);
  ok('the loop records Claude -> Codex lineage and final Codex exit state',
    loopSession.lineage.length === 1 && loopSession.lineage[0].from === 'claude'
    && loopSession.lineage[0].to === 'codex' && loopSession.bindings.codex.state === 'exited');
} catch (e) { ok('supervised handoff loop works', false, e.message); }

// ---- cl-profile: adoptIntoShared (migrate a real dir into the shared one) -------
// Regression: `tasks` joined SHARED_DIRS. The old code did rmSync(recursive) on the
// profile's REAL dir before junctioning — which would have DELETED every profile's
// task lists on the next launch. Nothing may ever be destroyed here.
section('cl-profile (adoptIntoShared: migrate, never clobber)');
try {
  const P = require(path.join(SRC, 'cl-profile.js'));
  ok('tasks is shared (so cl:switch keeps the task list)', P.SHARED_DIRS.includes('tasks'));

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
  const C = require(path.join(SRC, 'cl-config.js'));
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
} catch (e) { ok('cl-profile adoptIntoShared works', false, e.message); }

// ---- cl-conv (convId reconciliation — the "switch resumes a new session" fix) --
section('cl-conv (convId reconciliation)');
try {
  const { pickConvId } = require(path.join(SRC, 'cl-conv.js'));
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
} catch (e) { ok('cl-conv pickConvId works', false, e.message); }

// ---- cl-help + the cl:help hook (zero-token cheat sheet) --------------------
section('cl-help + cl:help hook');
try {
  const renderHelp = require(path.join(SRC, 'cl-help.js'));
  ok('cl-help exports a render function', typeof renderHelp === 'function');
  const sheet = renderHelp();
  ok('cheat sheet lists cl:help and cl:switch', /cl:help/.test(sheet) && /cl:switch/.test(sheet));
  const codexSheet = renderHelp('codex');
  ok('Codex help lists only implemented sentinels and names pending directions',
    /cl:notes/.test(codexSheet) && !/cl:switch/.test(codexSheet) && /not implemented yet/.test(codexSheet));

  // End-to-end: the hook must BLOCK cl:help / cl:cl (case-insensitive) and return
  // the sheet as the reason — zero model tokens, exactly like cl:peek.
  const hook = path.join(SRC, 'cl-switch-hook.js');
  for (const trig of ['cl:help', 'cl:cl', 'CL:HELP']) {
    const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ prompt: trig }), encoding: 'utf8' });
    let out = {}; try { out = JSON.parse(r.stdout || '{}'); } catch {}
    ok(`hook blocks "${trig}" with the cheat sheet`, out.decision === 'block' && /cl — commands/.test(out.reason || ''));
  }
  // A non-cl prompt must pass straight through (no block, empty stdout).
  const pass = spawnSync(process.execPath, [hook], { input: JSON.stringify({ prompt: 'hello world' }), encoding: 'utf8' });
  ok('non-cl prompt passes through (no block)', (pass.stdout || '').trim() === '');

  const handoffTranscript = path.join(TMP, 'hook-handoff.jsonl');
  fs.writeFileSync(handoffTranscript, '{}\n');
  const handoffSession = 'hook-handoff-session';
  const handoff = spawnSync(process.execPath, [hook], {
    env: { ...process.env, CL_SESSION: handoffSession, CL_LOGICAL_SESSION: 'logical-hook-1' },
    input: JSON.stringify({
      prompt: 'cl:handoff codex --account default --keep-last 20',
      transcript_path: handoffTranscript,
      session_id: 'claude-native-hook',
      cwd: TMP,
    }),
    encoding: 'utf8',
  });
  let handoffOut = {}; try { handoffOut = JSON.parse(handoff.stdout || '{}'); } catch {}
  const handoffTrigger = path.join(CLAUDE, 'cache', `cl-handoff-${handoffSession}.trigger`);
  const handoffPayload = JSON.parse(fs.readFileSync(handoffTrigger, 'utf8'));
  ok('cl:handoff is blocked and queued for the supervisor',
    handoffOut.decision === 'block' && handoffPayload.target === 'codex');
  ok('handoff trigger carries transcript, account, cap, and logical identity',
    handoffPayload.transcriptPath === handoffTranscript && handoffPayload.account === 'default'
    && handoffPayload.keepLast === 20 && handoffPayload.logicalSessionId === 'logical-hook-1');
  fs.unlinkSync(handoffTrigger);
} catch (e) { ok('cl:help hook works', false, e.message); }

// ---- cl-room (the "fridge": per-room append-only sticky-note ledger) ---------
section('cl-room (sticky-note ledger)');
try {
  const R = require(path.join(SRC, 'cl-room.js'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clroom-'));
  const repo = path.join(base, 'proj');
  fs.mkdirSync(path.join(repo, 'sub', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'));                       // fake repo root

  // 1) room = git repo root, from anywhere inside it
  const rTop = R.resolveRoom(repo), rDeep = R.resolveRoom(path.join(repo, 'sub', 'deep'));
  ok('room resolves to the git repo root from a subdir', rTop.root === rDeep.root);
  const outside = path.join(base, 'loose'); fs.mkdirSync(outside);
  ok('no repo → the folder itself is the room', R.resolveRoom(outside).root === R.canonical(outside));
  ok('a room is never nameless', !!R.resolveRoom(repo).name && !!R.resolveRoom('C:\\').name);

  // 2) the fridge self-ignores
  R.ensureRoom(rTop);
  const gi = fs.readFileSync(path.join(rTop.planDir, '.gitignore'), 'utf8');
  ok('.plan/.gitignore ignores everything (incl. itself)', /^\*$/m.test(gi));

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

  // 8) role lease. IDENTITY IS THE SESSION; the pid is only a liveness probe.
  ok('claim a free role', R.claimRole(rTop, 'coding', process.pid, 's1').ok === true);
  // A different LIVE session must be refused even if it reports the SAME pid.
  // (This is the bug the end-to-end test caught — pid alone is not identity.)
  const second = R.claimRole(rTop, 'coding', process.pid, 's2');
  ok('a different live session is refused (even with same pid)', second.ok === false && second.holder.sessionId === 's1');
  // cl:restart re-execs cl-runner: SAME session, NEW pid → must reclaim its own role.
  ok('same session reclaims under a NEW pid (restart-safe)', R.claimRole(rTop, 'coding', process.pid + 1, 's1').ok === true);
  fs.writeFileSync(path.join(rTop.planDir, 'lease-coding.json'), JSON.stringify({ role: 'coding', pid: 999999, sessionId: 's9', at: Date.now() }));
  ok('a DEAD holder\'s lease is vacant', R.roleHolder(rTop, 'coding') === null);
  ok('a vacant role can be claimed by anyone', R.claimRole(rTop, 'coding', process.pid, 's3').ok === true);
  ok('liveRoles lists live holders only', R.liveRoles(rTop).map((l) => l.role).join(',') === 'coding');
} catch (e) { ok('cl-room works', false, e.message); }

// ---- cl-fridge (the cl: sentinels over the ledger) ---------------------------
section('cl-fridge (role / note / notes)');
try {
  const F = require(path.join(SRC, 'cl-fridge.js'));
  const R2 = require(path.join(SRC, 'cl-room.js'));
  const base2 = fs.mkdtempSync(path.join(os.tmpdir(), 'clfridge-'));
  const repo2 = path.join(base2, 'proj');
  fs.mkdirSync(path.join(repo2, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(repo2, '.git'));
  const cache = path.join(CLAUDE, 'cache'); fs.mkdirSync(cache, { recursive: true });
  const mkSession = (sid, pid) => writeJSON(path.join(cache, `cl-state-${sid}.json`), { pid, cwd: repo2 });
  mkSession('sa', process.pid); mkSession('sb', process.pid); mkSession('sc', process.pid);

  // roles claimed from a SUBDIR still land in the repo-root room
  const ra = F.requestRole('sa', 'research', path.join(repo2, 'sub'));
  ok('cl:role claims a role from a subdir (room = repo root)', ra.ok === true && /room "proj"/.test(ra.message));
  ok('cl:role coding (second roommate)', F.requestRole('sb', 'coding', repo2).ok === true);
  const rc = F.requestRole('sc', 'coding', repo2);
  ok('a third session is REFUSED a held role', rc.ok === false && /already held by a LIVE session/.test(rc.message));

  // notes
  ok('cl:note needs a role', F.requestNote('sc', 'coding hi', repo2).ok === false);
  ok('cl:note rejects a note to yourself', F.requestNote('sa', 'research hi', repo2).ok === false);
  ok('cl:note usage error on bad args', F.requestNote('sa', 'onlyone', repo2).ok === false);
  ok('cl:note appends', F.requestNote('sa', 'coding P-014 spec changed', repo2).ok === true);
  ok('cl:note broadcast (all)', F.requestNote('sa', 'all repo layout moved', repo2).ok === true);

  // notes readout + rd()-only cursor
  const n1 = F.requestNotes('sb', '', repo2);
  ok('cl:notes shows both (addressed + broadcast)', /2 new from research/.test(n1.message));
  const n2 = F.requestNotes('sb', '', repo2);
  ok('cl:notes is empty after reading (cursor advanced)', /nothing new/.test(n2.message));
  const room2 = R2.resolveRoom(repo2);
  ok('notes were NOT consumed', R2.noteCount(room2) === 2);
  // rd()-only, proved properly: coding just read everything, yet a DIFFERENT reader
  // still finds the broadcast waiting. A note is never taken off the fridge.
  ok('a fresh role still sees the broadcast after coding read it', R2.unreadFor(room2, 'qa').count === 1);
  ok('research never sees its own two notes', R2.unreadFor(room2, 'research').count === 0);
  const nAll = F.requestNotes('sc', 'all', repo2);
  ok('cl:notes all = landlord view, no role needed', /ALL 2 note\(s\)/.test(nAll.message));

  // restart: same session, NEW pid → role + lease survive
  mkSession('sb', process.pid + 1);                       // simulate cl-runner re-exec
  const rr = F.refreshRole('sb', process.pid + 1, repo2);
  ok('refreshRole re-asserts the lease after restart', rr && rr.ok === true && rr.role === 'coding');
  ok('and the role still resolves for that session', F.getRole('sb', room2) === 'coding');
  ok('refreshRole is a no-op for a session with no role', F.refreshRole('zz', 999, repo2) === null);

  // the AMBIENT badge (what the statusline paints) — derived, self-clearing
  ok('badge is null with no role', F.badge('zz', repo2) === null);
  R2.appendNote(room2, { from: 'research', to: 'coding', body: 'fresh' });
  const bg = F.badge('sb', repo2);
  ok('badge counts unread + names the sender', bg && bg.count === 1 && bg.senders[0] === 'research');
  R2.markRead(room2, 'coding');
  ok('badge clears itself once read', F.badge('sb', repo2) === null);

  // FAIL-OPEN: a truncated ledger must not silently swallow notes
  R2.writeCursor(room2, 'coding', 999);                    // cursor past the end
  ok('a cursor past the end re-reads rather than skipping', R2.unreadFor(room2, 'coding').count > 0);

  // ---- turn-start injection (the "fridge at the door") ----
  // Proven live: a hook's additionalContext really does reach the model.
  R2.markRead(room2, 'coding');
  ok('injection is null when there is no delta (hook stays silent)', F.injection('sb', repo2) === null);
  ok('injection is null with no role', F.injection('zz', repo2) === null);
  R2.appendNote(room2, { from: 'research', to: 'coding', body: 'ordinary note' });
  R2.appendNote(room2, { from: 'research', to: 'coding', priority: 'high', body: 'URGENT anchor broke' });
  const countBeforeInject = R2.noteCount(room2);
  const inj = F.injection('sb', repo2);
  ok('injection returns a digest for unread notes', inj && inj.count === 2);
  ok('digest names the room + role', /room "proj"/.test(inj.text) && /for "coding"/.test(inj.text));
  ok('HIGH priority is ranked first', inj.text.indexOf('URGENT anchor broke') < inj.text.indexOf('ordinary note'));
  ok('digest stays far under the 10k hook cap', inj.text.length < 10000);
  ok('injection marks them read — delivered exactly once', F.injection('sb', repo2) === null);
  ok('but the notes stay on the fridge (rd()-only)', R2.noteCount(room2) === countBeforeInject);

  // a burst must be ranked + summarised, never dumped (the 10k cap is a hard limit)
  for (let i = 0; i < 80; i++) R2.appendNote(room2, { from: 'research', to: 'coding', body: 'filler '.repeat(40) + i });
  const big = F.injection('sb', repo2);
  ok('a burst is capped, not dumped', big && big.text.length < 10000);
  ok('and the overflow is summarised', /…and \d+ more/.test(big.text));
  ok('while still reporting the true total', big.count === 80);

  // CATCH-UP after an absence: a roommate back from a long trip must lose NOTHING.
  // The capped burst above must NOT have consumed the overflow — the cursor advances
  // only over what was actually delivered, so the rest stay unread. (Regression for the
  // bug where injection showed ~30 but marked ALL 80 read, silently dropping the tail.)
  ok('the capped burst did NOT consume the overflow', R2.unreadFor(room2, 'coding').count === 80 - big.shown && big.shown < 80);
  let drained = big.shown, guard = 0;
  while (R2.unreadFor(room2, 'coding').count && guard++ < 30) drained += F.injection('sb', repo2).shown;
  ok('the whole backlog drains over turns — every note once, none skipped',
    drained === 80 && R2.unreadFor(room2, 'coding').count === 0);
  // and a returning session catches up in ONE uncapped `cl:notes`
  R2.writeCursor(room2, 'coding', 0);
  const expected = R2.unreadFor(room2, 'coding').count;
  const catchUp = F.requestNotes('sb', '', repo2);
  ok('cl:notes catches a returning roommate up in one uncapped call',
    (catchUp.message.match(/#\s*\d+/g) || []).length === expected && expected > 40 && R2.unreadFor(room2, 'coding').count === 0);
} catch (e) { ok('cl-fridge works', false, e.message); }

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
