#!/usr/bin/env node
// cl-kit portable test suite — runs identically on Windows, Linux, and macOS.
// Pure Node built-ins, no dependencies, no interactive `claude`, no GUI. Every
// test runs against a THROWAWAY HOME under the OS temp dir (never the real
// ~/.claude), so CI on ubuntu-latest / macos-latest exercises the real logic.
//
//   node test/run.js
//
// Two sections:
//   • CORE — asserts the platform-neutral engine (config, per-account credential
//     isolation, trash, peek, gateway usage). A failure here fails the build.
//   • PROBE — reports the OS-specific touchpoints (symlink flavor, clipboard,
//     notifier, claude bin). Informational only — it never fails the build; it's
//     the "what would need porting" readout.
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

// ---- 7. cl-platform + storeApiKey (the Tier-1 cross-platform shim) -----------
section('cl-platform + storeApiKey (per-OS key storage)');
try {
  const plat = require(path.join(SRC, 'cl-platform.js'));
  const clip = plat.readClipboard();
  ok('readClipboard returns a string or null (never throws)', clip === null || typeof clip === 'string');
  ok('clipboardHint is a string', typeof plat.clipboardHint() === 'string');

  // storeApiKey uses DPAPI on Windows, a 0600 file on POSIX — and resolveApiKey
  // must round-trip either way. (CI proves both: windows-latest vs ubuntu/macos.)
  const stored = C.storeApiKey('gwtest', 'sk-portable-42');
  ok('storeApiKey returns fields + note', stored && stored.fields && typeof stored.note === 'string');
  ok('key field is platform-appropriate',
    process.platform === 'win32' ? !!stored.fields.apiKeyEnc : !!(stored.fields.apiKeyFrom && stored.fields.apiKeyFrom.file));
  const acc = { id: 'gwtest', type: 'api', baseUrl: 'https://x', ...stored.fields };
  ok('resolveApiKey round-trips the stored key (keychain or file, whichever backed it)', C.resolveApiKey(acc) === 'sk-portable-42');
  if (process.platform !== 'win32' && stored.fields.apiKeyFrom) {
    const st = fs.statSync(stored.fields.apiKeyFrom.file);
    ok('POSIX file fallback is mode 0600', (st.mode & 0o777) === 0o600);
  }

  // keychain helpers must be callable and type-safe on every OS (they no-op on
  // Windows and degrade to false/null when there's no secret service). Probe with
  // cleanup so a dev's real keychain is never left polluted.
  const probeId = 'cltest-keychain-probe';
  const kStored = plat.keychainStore(probeId, 'sk-kc-probe');
  ok('keychainStore returns a boolean', typeof kStored === 'boolean');
  const kGot = plat.keychainGet(probeId);
  ok('keychainGet returns string or null', kGot === null || typeof kGot === 'string');
  if (kStored) ok('keychain round-trips when it reports success', kGot === 'sk-kc-probe');
  ok('keychainDelete returns a boolean', typeof plat.keychainDelete(probeId) === 'boolean');

  // desktop notify: routes per-OS, returns a boolean, never throws. Only INVOKE it
  // where it can't pop a real toast on someone's desktop — Windows (guaranteed
  // no-op) or headless CI — so `npm test` on a dev's Mac/Linux stays quiet.
  ok('notify is a function', typeof plat.notify === 'function');
  if (process.platform === 'win32' || process.env.CI) {
    ok('notify returns a boolean (never throws)', typeof plat.notify('cl-kit test', 'suite') === 'boolean');
  }
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
} catch (e) { ok('cl-fridge works', false, e.message); }

// ---- PROBE: OS-specific touchpoints (informational — never fails build) ------
section('platform probe (informational — what a full port would wire up)');
function has(cmd, args) { try { const r = spawnSync(cmd, args || ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }); return r.status === 0 || (r.stdout || r.stderr || '').length > 0; } catch { return false; } }
// symlink-to-dir support (the credential-isolation junction relies on it)
let symlinkOk = false;
try {
  const tgt = path.join(TMP, 'ptgt'); fs.mkdirSync(tgt, { recursive: true });
  const lnk = path.join(TMP, 'plnk'); try { fs.unlinkSync(lnk); } catch {}
  fs.symlinkSync(tgt, lnk, process.platform === 'win32' ? 'junction' : 'dir');
  symlinkOk = fs.existsSync(lnk);
} catch {}
console.log(`  dir symlink/junction: ${symlinkOk ? 'OK' : 'UNSUPPORTED'}`);
console.log(`  clipboard: ${process.platform === 'darwin' ? (has('pbpaste', []) ? 'pbpaste' : 'none') : process.platform === 'win32' ? 'powershell' : (has('xclip') ? 'xclip' : has('wl-paste') ? 'wl-paste' : has('xsel') ? 'xsel' : 'none (use --file/--stdin)')}`);
console.log(`  notifier: ${process.platform === 'darwin' ? 'osascript' : process.platform === 'win32' ? 'powershell/toast' : (has('notify-send') ? 'notify-send' : 'none')}`);
console.log(`  claude on PATH: ${has('claude', ['--version']) ? 'yes' : 'no (fine for CI)'}`);

// ---- cleanup + verdict -------------------------------------------------------
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${fail === 0 ? '✓ ALL CORE TESTS PASSED' : '✗ CORE FAILURES'}: ${pass} passed, ${fail} failed${fail ? ' (' + fails.join(', ') + ')' : ''}`);
process.exit(fail === 0 ? 0 : 1);
