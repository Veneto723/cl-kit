// cl-runtime-codex: launch Codex under cl with isolated accounts and cl hooks.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const A = require('./cl-codex-account');

// Codex accepts `--dangerously-bypass-hook-trust` as a GLOBAL flag (verified: it
// parses before the subcommand — `codex --dangerously-bypass-hook-trust exec …`).
// We pass it on cl-initiated launches because cl WROTE the hook itself, from its own
// scripts dir — exactly the "automation that already vets its hook sources" the flag
// is documented for. Without it codex silently SKIPS an untrusted hook (trust is
// otherwise interactive-only; there is no `codex hooks trust` CLI and the persisted
// trust store is codex's versioned state_*.sqlite, which we must not poke).
// Codex has no per-turn permission modes like Claude's shift+tab. The closest match
// to Claude's "auto" (act without asking) is `--yolo` (verified accepted; alias of
// --dangerously-bypass-approvals-and-sandbox). cl maps Claude's auto/bypass modes to
// it on handoff so the runtime swap doesn't silently start asking for approvals.
// Both --yolo and --dangerously-bypass-hook-trust are GLOBAL flags — they parse
// before the subcommand (`codex <flags> exec|resume …`).
function commandSpec(args, opts = {}) {
  const pre = [];
  if (opts.bypassHookTrust) pre.push('--dangerously-bypass-hook-trust');
  if (opts.yolo) pre.push('--yolo');
  if (process.platform === 'win32') {
    return { bin: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'codex', ...pre, ...args] };
  }
  return { bin: 'codex', args: [...pre, ...args] };
}

// Marker so the managed block is idempotent and human-recognisable.
const HOOK_BLOCK_BEGIN = '# >>> cl-kit managed hooks (do not edit inside this block) >>>';
const HOOK_BLOCK_END = '# <<< cl-kit managed hooks <<<';

// Build the [hooks] TOML block. Codex reads lifecycle hooks from `[hooks]` in
// config.toml (TOML array-of-tables, `HookEventsToml`) — NOT a JSON hooks.json.
// VERIFIED empirically against codex 0.144.x: this exact shape fires, delivers
// Claude-shaped input ({hook_event_name, session_id, cwd, prompt, model, …}) on
// stdin, and honours `{hookSpecificOutput:{additionalContext}}` injection +
// `{decision:'block'}`. `command` MUST be a single TOML basic string (a sequence
// is rejected: "invalid type: sequence, expected a string in `hooks`"); a
// forward-slash path needs no escaping, only the inner quotes do.
function hookBlock(script) {
  const cmd = `node \\"${script.replace(/\\/g, '/')}\\"`;
  const one = (event) => [
    `[[hooks.${event}]]`,
    `[[hooks.${event}.hooks]]`,
    'type = "command"',
    `command = "${cmd}"`,
    'timeout = 30',
  ].join('\n');
  return `${HOOK_BLOCK_BEGIN}\n${one('SessionStart')}\n\n${one('UserPromptSubmit')}\n${HOOK_BLOCK_END}\n`;
}

function ensureHooks(account) {
  fs.mkdirSync(account.home, { recursive: true });
  const file = path.join(account.home, 'config.toml');
  const script = path.join(__dirname, 'cl-codex-hook.js').replace(/\\/g, '/');

  // Clean up the dead artifact the previous (wrong) implementation left behind:
  // a JSON hooks.json codex never read. Only remove it if it is CL's own — never
  // touch a file we didn't write.
  const stale = path.join(account.home, 'hooks.json');
  try {
    if (fs.existsSync(stale) && fs.readFileSync(stale, 'utf8').replace(/\\/g, '/').includes('cl-codex-hook.js')) {
      fs.unlinkSync(stale);
    }
  } catch { /* best-effort */ }

  let toml = '';
  if (fs.existsSync(file)) {
    try { toml = fs.readFileSync(file, 'utf8'); }
    catch (e) { throw new Error(`cannot read Codex config ${file}: ${e.message}`); }
  }

  const block = hookBlock(script);
  // Idempotent: replace an existing cl-managed block in place (so a moved scripts
  // dir re-points cleanly); otherwise append. Appending [[hooks.*]] array-of-tables
  // at the end is valid TOML and merges with any hooks the user defined themselves.
  const re = new RegExp(`${HOOK_BLOCK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${HOOK_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);
  let next;
  if (re.test(toml)) {
    next = toml.replace(re, block);
  } else {
    next = (toml.replace(/\s*$/, '') + '\n\n' + block).replace(/^\n+/, '');
  }
  if (next === toml) return file; // nothing to do

  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next);
  try { fs.renameSync(tmp, file); }
  catch { try { fs.unlinkSync(file); } catch {} fs.renameSync(tmp, file); }
  return file;
}

function launch(opts = {}) {
  const account = A.findAccount(opts.account);
  if (!account) throw new Error(`unknown Codex account "${opts.account}" (configured: ${A.accounts().map((a) => a.id).join(', ')})`);
  ensureHooks(account);
  const env = A.buildEnv(account, opts.sessionId, opts.logicalSessionId);
  const spec = commandSpec(opts.args || [], { bypassHookTrust: true, yolo: !!opts.yolo });
  const child = spawn(spec.bin, spec.args, { cwd: opts.cwd || process.cwd(), env, stdio: 'inherit' });
  return { child, account };
}

function login(account) {
  ensureHooks(account);
  const spec = commandSpec(['login']);
  return spawnSync(spec.bin, spec.args, { env: { ...process.env, CODEX_HOME: account.home }, stdio: 'inherit' });
}

function loginStatus(account) {
  const spec = commandSpec(['login', 'status']);
  const r = spawnSync(spec.bin, spec.args, {
    env: { ...process.env, CODEX_HOME: account.home }, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  return { ok: r.status === 0, status: r.status, message: String(r.stdout || r.stderr || '').trim() };
}

module.exports = { commandSpec, ensureHooks, launch, login, loginStatus };
