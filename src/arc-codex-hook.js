#!/usr/bin/env node
// Codex lifecycle adapter: register native sessions and deliver the shared fridge.
'use strict';

const O = require('./arc-orchestrator');

function write(value) { process.stdout.write(JSON.stringify(value)); }
function block(reason) { write({ decision: 'block', reason }); }

function register(hook) {
  const logical = process.env.ARC_LOGICAL_SESSION;
  if (!logical || !hook.session_id) return null;
  return O.ensureSession({
    id: logical,
    runtime: 'codex',
    nativeSessionId: hook.session_id,
    account: process.env.ARC_RUNTIME_ACCOUNT || 'default',
    model: hook.model || null,
    transcriptPath: hook.transcript_path || null,
    cwd: hook.cwd || process.cwd(),
    pid: process.ppid,
    state: 'active',
  });
}

function fridge(session, cwd) {
  try { return require('./arc-fridge').injection(session, cwd); } catch { return null; }
}

function run(raw) {
  let hook = {};
  try { hook = JSON.parse(raw || '{}'); } catch {}
  try { register(hook); } catch {}
  if (hook.hook_event_name === 'SessionStart') return;
  if (hook.hook_event_name !== 'UserPromptSubmit') return;

  const prompt = typeof hook.prompt === 'string' ? hook.prompt : '';
  const command = prompt.match(/^\s*[/!]?\s*arc:(role|note|notes|delegate|help|arc)\b\s*(.*)$/i);
  if (command) {
    const action = command[1].toLowerCase();
    const arg = (command[2] || '').trim();
    if (action === 'help' || action === 'arc') return block(require('./arc-help')('codex'));
    const F = require('./arc-fridge');
    const session = (process.env.ARC_SESSION || '').trim();
    const cwd = hook.cwd || process.cwd();
    if (action === 'delegate') {
      // Delegate FROM codex too — e.g. hand a task back to Claude while you stay here.
      const m = arg.match(/^(claude|codex)\s+([\s\S]+)$/i);
      if (!m) return block('[arc] usage: arc:delegate <claude|codex> <task>   (runs headless in the background; result lands on the fridge)');
      const room = require('./arc-room').resolveRoom(cwd);
      const myRole = F.getRole(session, room);
      const task = m[2].trim().replace(/^["']|["']$/g, '');
      require('./arc-delegate').spawnDelegate(m[1].toLowerCase(), room.root, myRole, task);
      return block(`[arc] ✓ delegated to ${m[1].toLowerCase()} (background) — the result lands on the fridge`
        + (myRole ? ` for "${myRole}"` : ' as a broadcast') + '. Read it with arc:notes.');
    }
    const r = action === 'role' ? F.requestRole(session, arg, cwd)
      : action === 'note' ? F.requestNote(session, arg, cwd)
        : F.requestNotes(session, arg, cwd);
    return block(`[arc] ${r.message}`);
  }

  const inj = fridge((process.env.ARC_SESSION || '').trim(), hook.cwd || process.cwd());
  if (inj) write({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: inj.text } });
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => { try { run(raw); } catch {} });

module.exports = { run, register };
