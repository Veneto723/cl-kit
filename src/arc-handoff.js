#!/usr/bin/env node
// arc-handoff: take the CURRENT Claude Code conversation into a Codex session that Codex
// RESUMES natively — the human keeps re-reading the real chat history, not a summary.
//
// Why seed-then-inject (proven, not guessed): a Codex rollout needs version-correct
// scaffolding (the developer role-setup / multi-agent records). A hand-built minimal
// rollout is rejected with "direct app-server input is not allowed for multi-agent v2
// sub-agents". So we let CODEX ITSELF mint a valid, current-version session with a throwaway
// seed turn, then splice our transpiled conversation in where the seed turn was. Keeping
// Codex's own scaffolding reduces format coupling, but the rollout remains undocumented.
//
// Flow:  locate transcript -> transpile (text-first, tools-as-text) -> seed a codex session
//        -> replace the seed turn with the transplanted history -> print `codex resume <id>`.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const T = require('./arc-transpile');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');
const defaultCodexHome = () => path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));

// ---- locate the Claude transcript for a conversation -------------------------
// Project dirs are named after the launch cwd, which can differ from the shell cwd, so we
// SEARCH every project dir for <convId>.jsonl rather than trust an encoding.
function findTranscript(convId) {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  let dirs = []; try { dirs = fs.readdirSync(projects); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(projects, d, `${convId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  // fall back to ~/.claude/projects if CLAUDE_CONFIG_DIR is a profile without a junction
  const home = path.join(os.homedir(), '.claude', 'projects');
  if (home !== projects) { try { for (const d of fs.readdirSync(home)) { const f = path.join(home, d, `${convId}.jsonl`); if (fs.existsSync(f)) return f; } } catch {} }
  return null;
}

// The current session's convId + cwd, from arc-runner's state file.
function currentSession(session) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `arc-state-${session}.json`), 'utf8'));
    return { convId: s.convId || null, cwd: s.cwd || null }; }
  catch { return { convId: null, cwd: null }; }
}

// The transcript records a `cwd` on each turn; use the last one (the session's real repo).
function transcriptCwd(records, fallback) {
  for (let i = records.length - 1; i >= 0; i--) if (records[i] && records[i].cwd) return records[i].cwd;
  return fallback;
}

// ---- codex rollout records ---------------------------------------------------
const rand = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
function userRec(text, turnId, ts) {
  return { timestamp: ts, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } };
}
function asstRec(text, turnId, ts) {
  return { timestamp: ts, type: 'response_item', payload: { type: 'message', id: 'msg_' + rand(48), role: 'assistant', content: [{ type: 'output_text', text }], phase: 'final_answer', internal_chat_message_metadata_passthrough: { turn_id: turnId } } };
}

// Find the rollout Codex just wrote for our seed (newest file whose text contains marker).
function findSeedRollout(marker, sessionsDir) {
  let hits = [];
  (function walk(d) { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const x of e) { const p = path.join(d, x.name); if (x.isDirectory()) walk(p);
      else if (/^rollout-.*\.jsonl$/.test(x.name)) hits.push({ p, t: fs.statSync(p).mtimeMs }); } })(sessionsDir || path.join(defaultCodexHome(), 'sessions'));
  hits.sort((a, b) => b.t - a.t);
  for (const h of hits.slice(0, 8)) { try { if (fs.readFileSync(h.p, 'utf8').includes(marker)) return h.p; } catch {} }
  return null;
}

// Replace the seed turn with the transplanted conversation, keeping all scaffolding.
function rebuild(rolloutPath, messages) {
  const recs = fs.readFileSync(rolloutPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // scaffolding = everything BEFORE the seed's user prompt (which carries the marker).
  const markerIdx = recs.findIndex((r) => r.type === 'response_item' && r.payload && r.payload.type === 'message'
    && r.payload.role === 'user' && JSON.stringify(r.payload.content).includes(HANDOFF_MARKER_TAG));
  const cut = markerIdx >= 0 ? markerIdx : recs.length;
  const scaffold = recs.slice(0, cut);
  // reuse a scaffolding turn_id (Codex ids are version-shaped; don't fabricate the format).
  let turnId = null;
  for (const r of scaffold) { const t = r.payload && r.payload.internal_chat_message_metadata_passthrough && r.payload.internal_chat_message_metadata_passthrough.turn_id; if (t) { turnId = t; break; } }
  turnId = turnId || (recs[0].payload && recs[0].payload.session_id) || rand(32);
  const now = new Date().toISOString();

  const intro = userRec('[Imported from a Claude Code session. The messages below are our prior conversation — continue from where it left off. Tool calls appear as short "[ran …]" / "[result …]" markers; the actual files are already on disk in this repo.]', turnId, now);
  const body = messages.map((m) => (m.role === 'assistant' ? asstRec(m.text, turnId, now) : userRec(m.text, turnId, now)));
  const out = [...scaffold, intro, ...body];
  fs.writeFileSync(rolloutPath, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { sessionId: recs[0].payload.session_id, scaffoldKept: scaffold.length, injected: body.length + 1 };
}

const HANDOFF_MARKER_TAG = '__ARC_HANDOFF_SEED__';

// ---- the command -------------------------------------------------------------
// opts: { transcript, convId, cwd, keepLast, dryRun }
// The `arc:handoff` hook passes `transcript` directly (UserPromptSubmit carries
// transcript_path); the terminal/test path resolves it from a convId.
function handoff(session, opts = {}) {
  const cur = currentSession(session);
  let transcript = opts.transcript;
  if (!transcript) {
    const convId = opts.convId || cur.convId;
    if (!convId) return { ok: false, message: 'no conversation to hand off — run this inside an arc session (`arc:handoff codex`).' };
    transcript = findTranscript(convId);
  }
  if (!transcript || !fs.existsSync(transcript)) return { ok: false, message: `couldn't find the transcript to hand off (${transcript || opts.convId || '?'}).` };

  const records = T.readTranscript(transcript);
  const cwd = opts.cwd || transcriptCwd(records, cur.cwd) || process.cwd();
  const { messages, stats } = T.transpile(records, { keepLast: opts.keepLast || 0 });
  if (!messages.length) return { ok: false, message: 'the transcript transpiled to zero messages — nothing to hand off.' };

  if (opts.dryRun) {
    return { ok: true, dryRun: true, message:
      `[dry run] would transpile ${transcript}\n  ${stats.emitted} message(s) (${stats.droppedTurns} empty/tool-only turns dropped${stats.trimmed ? `, ${stats.trimmed} trimmed to keepLast` : ''})\n  cwd: ${cwd}\n  (pass without --dry-run to seed a Codex session and inject them)` };
  }

  // codex must be present. It ships as codex.cmd on Windows; Node ≥20 refuses to spawn a
  // .cmd without a shell, so route through cmd.exe. The seed prompt is kept to spaces +
  // word chars only so no cmd metacharacter needs escaping.
  const marker = `${HANDOFF_MARKER_TAG} ${Date.now()} ${rand(8)}`;
  const codexArgs = ['exec', '--skip-git-repo-check', '-s', 'read-only', '-C', cwd, `${marker} reply only ok`];
  const codexHome = path.resolve(opts.codexHome || defaultCodexHome());
  const seed = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'codex', ...codexArgs],
    { encoding: 'utf8', timeout: 180000, windowsHide: true, env: { ...process.env, CODEX_HOME: codexHome } });
  if (seed.error) return { ok: false, message: `couldn't run codex (${seed.error.message}). Is the codex CLI on PATH?` };
  const rollout = findSeedRollout(marker, path.join(codexHome, 'sessions'));
  if (!rollout) return { ok: false, message: 'seeded a Codex session but could not locate its rollout file. (codex output: ' + (seed.stdout || seed.stderr || '').slice(-200) + ')' };

  const r = rebuild(rollout, messages);
  return { ok: true, sessionId: r.sessionId, cwd, transcript, stats, injected: r.injected,
    message:
      `✓ handed off ${r.injected} message(s) into a Codex session (kept ${r.scaffoldKept} scaffolding records).\n` +
      `  resume it:  cd "${cwd}"  then  codex resume ${r.sessionId}\n` +
      `  (tool calls became short text markers; the repo files are already shared, so the code state is intact.)` };
}

module.exports = { handoff, findTranscript, currentSession, findSeedRollout, rebuild, HANDOFF_MARKER_TAG };
