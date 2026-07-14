#!/usr/bin/env node
// arc-delegate: run a task HEADLESSLY on a chosen runtime and post the RESULT to the
// fridge, so the delegating session picks it up at its next turn (or immediately, if it
// is running the arc-watch waker).
//
//   node arc-delegate.js <claude|codex> <cwd> <toRole|-> <task…>
//
// Two delegation flavours exist, and they are NOT the same thing:
//   • arc:note <role> <task>   → hand work to a LIVE roommate session (arc-watch wakes it)
//   • arc:delegate <rt> <task> → fire a HEADLESS run on a chosen MODEL, report back here
// This file is the second one. It is spawned DETACHED by the sentinel (a hook must return
// instantly), so you keep working while the delegate runs.
//
// CRITICAL: the delegate runs with ARC_SESSION STRIPPED. Otherwise its own
// UserPromptSubmit hook would inject the REQUESTER's unread fridge notes into the
// delegate and ADVANCE THEIR CURSOR — silently stealing notes from the real session.
// With no session id, arc-fridge.injection() returns null and the hook stays quiet.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const R = require('./arc-room');

const MAX_BODY = 1200;             // fridge notes are a digest, never a dump
const TIMEOUT_MS = 10 * 60 * 1000; // a delegate is a task, not a residency

// An ADVISOR is a READ-ONLY reviewer with a verdict contract, so its result is a trustworthy
// GATE, not a free-form note. The runtime is sandboxed read-only (it may inspect the repo but
// not mutate it); the FIRST line MUST be the verdict, which arc parses to set note priority.
const ADVISOR_SYSTEM = `You are a READ-ONLY reviewer. You MAY inspect the repository to verify claims, but you MUST NOT edit files, run mutating commands, or make any change.
Review the request below for correctness, missing constraints, unsafe or out-of-order steps, and verification gaps.
Your FIRST line MUST be exactly one of:
VERDICT: APPROVE
VERDICT: REVISE
Use APPROVE only when no material gap remains. Use REVISE otherwise, then a short prioritized list where every item names a concrete gap AND a concrete fix. Be terse; do not restate the request.`;

// The verdict is the first non-empty line. Null when the model ignored the contract.
function parseVerdict(out) {
  const first = (String(out).split('\n').find((l) => l.trim()) || '').trim();
  const m = first.match(/VERDICT:\s*(APPROVE|REVISE)/i);
  return m ? m[1].toUpperCase() : null;
}

// Never let the delegate inherit the requester's fridge identity (ARC_*), NOR a provider
// credential from the PARENT session (ANTHROPIC_*/OPENAI_*). The delegate must use only the
// login the runtime resolves for itself, or the account arc sets in runClaude — otherwise a
// gateway key left in the parent env could silently redirect or mis-bill the delegate.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['ARC_SESSION', 'ARC_LOGICAL_SESSION', 'ARC_RUNTIME', 'ARC_RUNTIME_ACCOUNT', 'ARC_RESPAWNED']) delete env[k];
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_CUSTOM_HEADERS', 'OPENAI_API_KEY', 'OPENAI_BASE_URL']) delete env[k];
  return env;
}

// `codex exec` is a DOCUMENTED, headless surface — a task in, a text answer out. opts:
// { advisor?, model? }. A TASK runs --yolo (full action, a GLOBAL flag before the subcommand);
// an ADVISOR runs `--sandbox read-only` so it can inspect but never mutate. On Windows `codex`
// is a shim, so it must be invoked through cmd.
function runCodex(cwd, task, opts = {}) {
  const pre = opts.advisor ? [] : ['--yolo'];
  const exec = ['exec'];
  if (opts.model) exec.push('-m', opts.model);
  if (opts.advisor) exec.push('--sandbox', 'read-only');
  exec.push('--skip-git-repo-check', '-C', cwd);
  exec.push(opts.advisor ? `${ADVISOR_SYSTEM}\n\n=== REVIEW REQUEST ===\n${task}` : task);
  const args = [...pre, ...exec];
  const spec = process.platform === 'win32'
    ? { bin: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'codex', ...args] }
    : { bin: 'codex', args };
  const r = spawnSync(spec.bin, spec.args, { encoding: 'utf8', timeout: TIMEOUT_MS, env: cleanEnv(), input: '', windowsHide: true });
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim(), status: r.status };
}

// opts: { advisor?, model?, account? }. advisor → --permission-mode plan (read-only) + the
// verdict contract as an appended system prompt. task → --permission-mode acceptEdits so it can
// actually do the work (parity with codex --yolo, but no free-form bash).
//
// QUOTA FOLLOWS THE CALLER. A claude delegate runs on the SAME account the calling session is
// on — not the config default. Delegating to your own agent must not silently jump accounts and
// bill a quota you didn't choose. `--account <id>` overrides it, which is how you deliberately
// offload to a different pool. (opts.account is passed as an ARGUMENT, never inherited via env:
// cleanEnv strips ARC_RUNTIME_ACCOUNT so a delegate can't pick up the caller's identity by accident.)
function runClaude(cwd, task, opts = {}) {
  const C = require('./arc-config');
  const cfg = C.loadConfig();
  const acc = C.findAccount(cfg, opts.account || cfg.defaultAccount) || cfg.accounts[0];
  const env = C.accountEnv(acc, cleanEnv());
  const args = ['-p'];
  if (opts.model) args.push('--model', opts.model);
  if (opts.advisor) args.push('--permission-mode', 'plan', '--append-system-prompt', ADVISOR_SYSTEM);
  else args.push('--permission-mode', 'acceptEdits');
  args.push(task);
  const r = spawnSync(C.claudeBin(cfg), args, { cwd, encoding: 'utf8', timeout: TIMEOUT_MS, env, windowsHide: true });
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim(), status: r.status };
}

// Parse the argument tail of a delegate command into a spec, shared by every caller (both
// sentinels + the CLI) so they behave identically:  <claude|codex> [--advisor|-a] [--model X] <task>
function parseDelegateSpec(argStr) {
  const m = String(argStr || '').trim().match(/^(claude|codex)\s+([\s\S]+)$/i);
  if (!m) return null;
  const runtime = m[1].toLowerCase();
  let rest = m[2];
  let advisor = false, model = null, account = null, mm;
  for (;;) {
    if ((mm = rest.match(/^(?:--advisor|-a)\b\s*/i))) { advisor = true; rest = rest.slice(mm[0].length); continue; }
    if ((mm = rest.match(/^--model[=\s]+(\S+)\s*/i))) { model = mm[1]; rest = rest.slice(mm[0].length); continue; }
    if ((mm = rest.match(/^--account[=\s]+(\S+)\s*/i))) { account = mm[1]; rest = rest.slice(mm[0].length); continue; }
    break;
  }
  const task = rest.trim().replace(/^["']|["']$/g, '');
  if (!task) return null;
  return { runtime, advisor, model, account, task };
}

// ---- in-flight markers -------------------------------------------------------------
// A delegate takes ~a minute. If the requester goes IDLE in that window, nothing can wake
// it (see arc-stop-hook.js — arc holds no handle on the session's TTY). So a running
// delegate leaves a marker naming the session that FIRED it; the Stop hook reads these to
// arm a waker before that session stops. The marker is the delegate's own liveness, so it
// is removed in a `finally` — a crashed delegate must not strand a marker forever, hence
// the expiry sweep in pendingFor() as the backstop.
function markerDir(room) { return path.join(room.planDir, 'delegates'); }

function writeMarker(room, rec) {
  try {
    fs.mkdirSync(markerDir(room), { recursive: true });
    fs.writeFileSync(path.join(markerDir(room), `${rec.id}.json`), JSON.stringify(rec));
  } catch {}
}
function clearMarker(room, id) {
  try { fs.unlinkSync(path.join(markerDir(room), `${id}.json`)); } catch {}
}
function readMarkers(room) {
  let names = [];
  try { names = fs.readdirSync(markerDir(room)); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(markerDir(room), n);
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - (rec.started || 0) > TIMEOUT_MS + 60_000) { fs.unlinkSync(file); continue; } // dead delegate
      out.push({ ...rec, file });
    } catch { try { fs.unlinkSync(file); } catch {} }   // unreadable marker = no marker
  }
  return out;
}

// Delegates fired BY `session` that are still running and whose waker we have not yet
// asked for. Excluding the armed ones is what stops the Stop hook nagging every turn.
function pendingFor(session, cwd) {
  if (!session) return [];
  try {
    const room = R.resolveRoom(cwd || process.cwd());
    return readMarkers(room).filter((r) => r.session === session && !r.armed);
  } catch { return []; }
}
function markArmed(pending) {
  for (const p of pending) {
    try { fs.writeFileSync(p.file, JSON.stringify({ ...p, armed: true, file: undefined })); } catch {}
  }
}

// Fire a delegate in the BACKGROUND. Used by the arc:delegate sentinel and by `arc delegate`
// — a hook/CLI must return immediately, so we detach. The caller's identity (session, role,
// ACCOUNT) travels as an ARGUMENT, never in the env: cleanEnv strips ARC_* so a delegate can
// never inherit the requester's fridge cursor or account by accident.
//   opts: { toRole?, session?, advisor?, model?, account? }
// Encoded as ONE json argv slot rather than a row of positional flags — the positional form
// had grown to seven slots, which is exactly how an off-by-one lands in the wrong field.
function spawnDelegate(runtime, cwd, task, opts = {}) {
  const child = spawn(process.execPath, [__filename, runtime, cwd, JSON.stringify(opts || {}), task], { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}

// `runners` is injectable so the note-posting path is testable without a real model call.
// argv:  <runtime> <cwd> <optsJSON> <task…>
function run(argv, runners) {
  const RUN = runners || { codex: runCodex, claude: runClaude };
  const [runtime, cwd, optsRaw, ...rest] = argv;
  let o = {};
  try { o = JSON.parse(optsRaw || '{}') || {}; } catch {}
  const task = rest.join(' ').trim();
  const toRole = o.toRole || null;
  const session = o.session || null;
  const advisor = !!o.advisor;
  const model = o.model || null;
  const account = o.account || null;
  if (!/^(claude|codex)$/.test(String(runtime)) || !cwd || !task) {
    process.stderr.write('usage: arc-delegate.js <claude|codex> <cwd> <optsJSON> <task…>\n');
    return 2;
  }

  const room = R.resolveRoom(cwd);
  R.ensureRoom(room);
  const started = Date.now();
  const kind = advisor ? 'advisor' : 'delegate';
  const id = `${runtime}-${started}-${process.pid}`;
  writeMarker(room, { id, session, role: toRole, runtime, task, started, advisor });
  let res;
  try { res = RUN[runtime](cwd, task, { advisor, model, account }); }
  catch (e) { res = { ok: false, out: '', err: String(e && e.message), status: -1 }; }
  const secs = Math.round((Date.now() - started) / 1000);
  const verdict = advisor && res.ok ? parseVerdict(res.out) : null;

  // The full run lives beside the room's other coordination state (.plan is gitignored),
  // so the NOTE can stay a digest and still point at everything.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const full = path.join(room.planDir, `${kind}-${runtime}-${stamp}.md`);
  try { fs.writeFileSync(full, `# ${kind} ${runtime}${model ? ' ' + model : ''}\n\n## task\n${task}\n\n## stdout\n${res.out}\n\n## stderr\n${res.err}\n`); } catch {}

  const clip = (s) => (s.length > MAX_BODY ? s.slice(0, MAX_BODY) + '…' : s);
  const from = `${kind}:${runtime}`;                              // never collides with a real role
  // Name the QUOTA it actually ran on, so a delegate can never quietly bill an account you
  // didn't expect — the thing that was wrong before the caller's account started being inherited.
  const label = `${from}${model ? ' ' + model : ''}${account && runtime === 'claude' ? ` @${account}` : ''}`;
  let body, priority;
  if (!res.ok) {
    body = `[${label}] FAILED "${task}" — exit ${res.status} after ${secs}s\n${clip(res.err || res.out) || '(no output)'}\n(full: ${full})`;
    priority = 'high';
  } else if (advisor) {
    // The verdict IS the gate: a REVISE (or an ignored contract) must not be missed → HIGH.
    body = `[${label}] VERDICT: ${verdict || 'UNCLEAR'} — "${task}"\n\n${clip(res.out) || '(no output)'}\n\n(${secs}s · full: ${full})`;
    priority = verdict === 'APPROVE' ? 'normal' : 'high';
  } else {
    body = `[${label}] "${task}"\n\n${clip(res.out) || '(no output)'}\n\n(${secs}s · full: ${full})`;
    priority = 'normal';
  }
  R.appendNote(room, { from, to: toRole, body, priority });
  // ORDER MATTERS: the note must exist BEFORE the marker goes. If we cleared first, a Stop
  // firing in the gap would see no note AND no in-flight delegate — and go idle with the
  // result seconds away and no waker armed. Appending first makes the gap harmless.
  clearMarker(room, id);
  process.stdout.write(`${res.ok ? '✓' : '✗'} ${kind} ${runtime} finished (${secs}s)${verdict ? ` — VERDICT ${verdict}` : ''} → fridge note in room "${room.name}"\n`);
  return res.ok ? 0 : 1;
}

module.exports = { spawnDelegate, run, cleanEnv, pendingFor, markArmed, markerDir, parseDelegateSpec, parseVerdict };

if (require.main === module) process.exit(run(process.argv.slice(2)));
