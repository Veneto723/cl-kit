// arc-runtime-codex: launch Codex under arc with isolated accounts and arc hooks.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const A = require('./arc-codex-account');

// Codex accepts `--dangerously-bypass-hook-trust` as a GLOBAL flag (verified: it
// parses before the subcommand — `codex --dangerously-bypass-hook-trust exec …`).
// We pass it on arc-initiated launches because arc WROTE the hook itself, from its own
// scripts dir — exactly the "automation that already vets its hook sources" the flag
// is documented for. Without it codex silently SKIPS an untrusted hook (trust is
// otherwise interactive-only; there is no `codex hooks trust` CLI and the persisted
// trust store is codex's versioned state_*.sqlite, which we must not poke).
// Codex has no per-turn permission modes like Claude's shift+tab. The closest match
// to Claude's "auto" (act without asking) is `--yolo` (verified accepted; alias of
// --dangerously-bypass-approvals-and-sandbox). arc maps Claude's auto/bypass modes to
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
const HOOK_BLOCK_BEGIN = '# >>> arc managed hooks (do not edit inside this block) >>>';
const HOOK_BLOCK_END = '# <<< arc managed hooks <<<';
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  const script = path.join(__dirname, 'arc-codex-hook.js').replace(/\\/g, '/');

  // Clean up the dead artifact the previous (wrong) implementation left behind:
  // a JSON hooks.json codex never read. Only remove it if it is CL's own — never
  // touch a file we didn't write.
  const stale = path.join(account.home, 'hooks.json');
  try {
    if (fs.existsSync(stale) && /arc-codex-hook\.js/.test(fs.readFileSync(stale, 'utf8').replace(/\\/g, '/'))) {
      fs.unlinkSync(stale);
    }
  } catch { /* best-effort */ }

  let toml = '';
  if (fs.existsSync(file)) {
    try { toml = fs.readFileSync(file, 'utf8'); }
    catch (e) { throw new Error(`cannot read Codex config ${file}: ${e.message}`); }
  }

  const block = hookBlock(script);
  // Idempotent: replace an existing arc-managed block in place (so a moved scripts
  // dir re-points cleanly); otherwise append. Appending [[hooks.*]] array-of-tables
  // at the end is valid TOML and merges with any hooks the user defined themselves.
  const re = new RegExp(`${reEsc(HOOK_BLOCK_BEGIN)}[\\s\\S]*?${reEsc(HOOK_BLOCK_END)}\\n?`);
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

// Codex has a native, configurable status line: `[tui] status_line = [<segment>…]`
// + `status_line_use_colors`. Segments incl. model-with-reasoning, git-branch,
// context-remaining/used, five-hour-limit, weekly-limit, used-tokens (codex fetches
// the limit data itself from account/rateLimits/read; it populates after a real turn).
// arc SEEDS a sensible default into an account's config.toml so every arc-launched
// codex session shows usage + context — mirroring arc's Claude statusline — but only
// if the user hasn't chosen their own via codex's /statusline (never clobbers it).
const STATUS_LINE_SEGMENTS = ['model-with-reasoning', 'git-branch', 'context-remaining', 'five-hour-limit', 'weekly-limit'];

function ensureStatusLine(account, segments = STATUS_LINE_SEGMENTS) {
  fs.mkdirSync(account.home, { recursive: true });
  const file = path.join(account.home, 'config.toml');
  let toml = '';
  try { toml = fs.readFileSync(file, 'utf8'); } catch { /* no config yet */ }
  if (/^\s*status_line\s*=/m.test(toml)) return file; // user configured it via /statusline — respect it
  // Only add status_line_use_colors if it isn't already set (a duplicate TOML key is rejected).
  const colors = /^\s*status_line_use_colors\s*=/m.test(toml) ? '' : '\nstatus_line_use_colors = true';
  const block = `status_line = [${segments.map((s) => `"${s}"`).join(', ')}]${colors}`;
  let next;
  if (/^\[tui\]\s*$/m.test(toml)) next = toml.replace(/^\[tui\]\s*$/m, (h) => `${h}\n${block}`); // add keys under existing [tui]
  else next = `${toml.replace(/\s*$/, '')}\n\n[tui]\n${block}\n`.replace(/^\n+/, '');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next);
  try { fs.renameSync(tmp, file); } catch { try { fs.unlinkSync(file); } catch {} fs.renameSync(tmp, file); }
  return file;
}

function launch(opts = {}) {
  const account = A.findAccount(opts.account);
  if (!account) throw new Error(`unknown Codex account "${opts.account}" (configured: ${A.accounts().map((a) => a.id).join(', ')})`);
  ensureHooks(account);
  ensureStatusLine(account);
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

module.exports = { commandSpec, ensureHooks, ensureStatusLine, STATUS_LINE_SEGMENTS, launch, login, loginStatus };
