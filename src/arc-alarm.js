#!/usr/bin/env node
// arc-alarm: a board-wide "fire alarm". One raise reaches EVERY peer on two channels that share a
// single identity:
//   - IDLE peers  — a broadcast note wakes their listener (its EXIT re-invokes them), the same path
//                   any note uses. Free.
//   - BUSY peers  — a flag file (`.arc/peer/alarm.json`) that the pretool hook reads on every tool
//                   call; a peer mid-turn cannot be interrupted mid-generation (Claude Code exposes
//                   no such lever — confirmed), so the NEXT tool boundary is the earliest it can
//                   react. The gate denies that one tool call, hands over the alarm, and the peer
//                   re-issues after handling it.
//
// The two channels share ONE identity — the broadcast note's stable id (never a line position: the
// board's whole doctrine is that a seq is a merge-fragile ordinal, an id is not). A per-session ack
// records "I have SEEN alarm <id>", stamped by whichever channel delivers first, so neither fires
// twice for the same alarm. (Increment 1 stamps on the flag-block; the note-read stamp — closing
// the last benign double-show for a peer that was idle at raise time — is the stop-hook half.)
//
// Deliberate safeties (all from the design review):
//   - ONE read on the hot path. An absent flag ENOENTs and we fall through — no separate stat, and
//     the same catch tolerates a clear/TTL sweep racing the read (no half-read wedge).
//   - FAIL-OPEN. The gate blocks only AFTER the ack durably persisted; if the ack write fails, the
//     tool runs. A disk/permission failure must never invert block-once into block-forever.
//   - DEBOUNCE. Raises inside a short window coalesce — block-once is per-id, so N rapid raises
//     would be N board-wide blocks. A buggy loop cannot turn `arc alarm` into a DoS.
//   - UNTRUSTED BODY. It is force-fed into every busy peer's context — a broadcast prompt-injection
//     surface stronger than a note. It is capped at the source and framed as coordination text, not
//     an instruction (the framing lives in the pretool deny reason).
//   - ACKS LIVE OUTSIDE THE REPO (~/.claude/cache, like the await/offer markers): zero gitignore
//     surface, and the per-call throwaway hook never contends with long-lived runner state.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');
const TTL_MS = 15 * 60 * 1000;   // an alarm older than this no longer interrupts (stale-flag cap)
const DEBOUNCE_MS = 5 * 1000;    // raises inside this window coalesce — no per-id block storm
const BODY_CAP = 400;            // the injected body is capped (untrusted, force-fed into context)

const flagPath = (board) => path.join(board.planDir, 'alarm.json');       // under .arc/peer/ (gitignored)
const ackPath = (session) => path.join(CACHE_DIR, `arc-alarmack-${session}.json`);

function readAck(session) {
  try { return String(JSON.parse(fs.readFileSync(ackPath(session), 'utf8')).id || ''); }
  catch { return ''; }
}

// Returns TRUE iff the ack durably persisted. The caller FAILS OPEN on false — a failed ack write
// must let the tool run, never block it forever.
function stampAck(session, id) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = ackPath(session) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ id: String(id), at: Date.now() }));
    fs.renameSync(tmp, ackPath(session));
    return true;
  } catch { return false; }
}

// The current alarm, or null: absent, cleared mid-read, unparseable, or STALE past its TTL. ONE
// read — an absent flag throws ENOENT and we fall through; no separate stat, no two-syscall race.
function readFlag(board) {
  let raw;
  try { raw = fs.readFileSync(flagPath(board), 'utf8'); }
  catch { return null; }
  let f; try { f = JSON.parse(raw); } catch { return null; }
  if (!f || !f.id) return null;
  if (typeof f.at === 'number' && Date.now() - f.at > TTL_MS) return null;   // stale — do not interrupt
  return f;
}

// THE GATE — called by the pretool hook on every tool call. Returns {id, body, from} to BLOCK this
// one call, or null to let it run. Stamps the ack BEFORE signalling a block and FAILS OPEN if the
// stamp did not persist. Suppressed once this session has seen the alarm (via a prior block, or —
// once the stop-hook half lands — via the note-read).
function checkAndAck(session, board) {
  const f = readFlag(board);
  if (!f) return null;                                  // hot path: no alarm
  if (readAck(session) === f.id) return null;           // already seen this alarm — do not re-block
  if (!stampAck(session, f.id)) return null;            // FAIL-OPEN: only block if the ack persisted
  return { id: f.id, body: String(f.body || ''), from: String(f.from || 'a peer') };
}

// RAISE. Broadcasts a note (wakes idle peers) AND writes the flag (interrupts busy peers), both
// carrying the note's id as the shared alarm identity. Debounced against the live flag; the raiser
// auto-acks so it never blocks on its own alarm.
function raise(session, body, cwd) {
  const B = require('./arc-board');
  const N = require('./arc-notes');
  const board = B.resolveBoard(cwd);
  B.ensureBoard(board);

  const text = String(body || '').replace(/\s+/g, ' ').trim().slice(0, BODY_CAP);
  if (!text) return { ok: false, message: 'refusing to raise an EMPTY alarm — give it a message.' };

  const existing = readFlag(board);
  if (existing && typeof existing.at === 'number' && Date.now() - existing.at < DEBOUNCE_MS) {
    return { ok: false, coalesced: true,
      message: `an alarm is already live (raised ${Math.round((Date.now() - existing.at) / 1000)}s ago) — `
        + 'coalescing, not raising a second. Clear it first (arc alarm --clear) to raise a new one.' };
  }

  const from = N.getRole(session, board) || 'unknown';
  const rec = B.appendNote(board, { from, to: null, kind: 'blocker', priority: 'high', body: `ALARM: ${text}` });
  const id = rec.id;

  // atomic temp+rename: a reader sees the old flag or the new one whole, never half.
  const tmp = flagPath(board) + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ id, at: Date.now(), from, body: text }));
    fs.renameSync(tmp, flagPath(board));
  } catch (e) {
    return { ok: false, message: `raised the note but could not write the interrupt flag: ${e.message}` };
  }
  stampAck(session, id);   // the raiser never blocks on its own alarm (best-effort; it self-heals if it fails)

  return { ok: true, id, from, body: text,
    message: `⚠ ALARM raised on "${board.name}" — broadcast to every peer AND set to interrupt each at its\n`
      + '  next tool call. Take it down when resolved:  arc alarm --clear' };
}

function clear(cwd) {
  const B = require('./arc-board');
  const board = B.resolveBoard(cwd);
  try { fs.unlinkSync(flagPath(board)); return { ok: true, cleared: true, message: `alarm cleared on "${board.name}".` }; }
  catch { return { ok: true, cleared: false, message: `no active alarm on "${board.name}".` }; }
}

module.exports = { raise, clear, checkAndAck, readFlag, readAck, stampAck,
  flagPath, ackPath, TTL_MS, DEBOUNCE_MS, BODY_CAP };
