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

// Never let the delegate inherit the requester's fridge identity (see header).
function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['ARC_SESSION', 'ARC_LOGICAL_SESSION', 'ARC_RUNTIME', 'ARC_RUNTIME_ACCOUNT', 'ARC_RESPAWNED']) delete env[k];
  return env;
}

function runCodex(cwd, task) {
  const CX = require('./arc-runtime-codex');
  const spec = CX.commandSpec(['exec', '--skip-git-repo-check', '-C', cwd, task], { bypassHookTrust: true, yolo: true });
  const r = spawnSync(spec.bin, spec.args, { encoding: 'utf8', timeout: TIMEOUT_MS, env: cleanEnv(), input: '', windowsHide: true });
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim(), status: r.status };
}

function runClaude(cwd, task) {
  const C = require('./arc-config');
  const cfg = C.loadConfig();
  const acc = C.findAccount(cfg, cfg.defaultAccount) || cfg.accounts[0];
  const env = C.accountEnv(acc, cleanEnv());
  const r = spawnSync(C.claudeBin(cfg), ['-p', task], { cwd, encoding: 'utf8', timeout: TIMEOUT_MS, env, windowsHide: true });
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim(), status: r.status };
}

// Fire a delegate in the BACKGROUND. Used by the arc:delegate sentinel (both runtimes'
// hooks) and by `arc delegate` — a hook/CLI must return immediately, so we detach.
function spawnDelegate(runtime, cwd, toRole, task) {
  const child = spawn(process.execPath, [__filename, runtime, cwd, toRole || '-', task], { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}

// `runners` is injectable so the note-posting path is testable without a real model call.
function run(argv, runners) {
  const RUN = runners || { codex: runCodex, claude: runClaude };
  const [runtime, cwd, toRoleRaw, ...rest] = argv;
  const task = rest.join(' ').trim();
  const toRole = toRoleRaw && toRoleRaw !== '-' ? toRoleRaw : null;
  if (!/^(claude|codex)$/.test(String(runtime)) || !cwd || !task) {
    process.stderr.write('usage: arc-delegate.js <claude|codex> <cwd> <toRole|-> <task…>\n');
    return 2;
  }

  const room = R.resolveRoom(cwd);
  R.ensureRoom(room);
  const started = Date.now();
  let res;
  try { res = RUN[runtime](cwd, task); }
  catch (e) { res = { ok: false, out: '', err: String(e && e.message), status: -1 }; }
  const secs = Math.round((Date.now() - started) / 1000);

  // The full run lives beside the room's other coordination state (.plan is gitignored),
  // so the NOTE can stay a digest and still point at everything.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const full = path.join(room.planDir, `delegate-${runtime}-${stamp}.md`);
  try { fs.writeFileSync(full, `# delegate ${runtime}\n\n## task\n${task}\n\n## stdout\n${res.out}\n\n## stderr\n${res.err}\n`); } catch {}

  const clip = (s) => (s.length > MAX_BODY ? s.slice(0, MAX_BODY) + '…' : s);
  const body = res.ok
    ? `[delegate:${runtime}] "${task}"\n\n${clip(res.out) || '(no output)'}\n\n(${secs}s · full: ${full})`
    : `[delegate:${runtime}] FAILED "${task}" — exit ${res.status} after ${secs}s\n${clip(res.err || res.out) || '(no output)'}\n(full: ${full})`;

  // from a delegate:<runtime> pseudo-role, so it never collides with a real roommate and
  // is always DELIVERED (unreadFor only excludes a role's own notes).
  R.appendNote(room, { from: `delegate:${runtime}`, to: toRole, body, priority: res.ok ? 'normal' : 'high' });
  process.stdout.write(`${res.ok ? '✓' : '✗'} delegate ${runtime} finished (${secs}s) → fridge note in room "${room.name}"\n`);
  return res.ok ? 0 : 1;
}

module.exports = { spawnDelegate, run, cleanEnv };

if (require.main === module) process.exit(run(process.argv.slice(2)));
