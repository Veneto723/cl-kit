#!/usr/bin/env node
// arc-stance: a per-session behavioural dial — how much INITIATIVE an agent takes with arc's
// agent-facing tools (arc note / join / delegate). Set it like /effort: `arc:mode active`, or
// slide a passive·balanced·active bar with `arc:mode` (see the picker in arc-runner).
//
// WHY a model-level STEER and not a CLI gate: "passive = act only on the USER's order" is a
// distinction only the model can make — when you say "ask research about X", the agent runs
// `arc note research --kind request`, and that IS on your order. A CLI gate can't tell that from
// self-initiation. So the stance is INJECTED into the agent's context each turn (see
// arc-switch-hook.deliverBoard) and the agent self-governs.
//
// ONE EXCEPTION, AND IT IS ENFORCED: `arc delegate <role>` to an EMPTY chair spawns a REAL
// SESSION — a window, a process, its own quota. An injected sentence cannot stop an agent from
// running a command, and that is fine for a note (cheap, reversible) but not for a spawn. So the
// dial ALSO drives a PreToolUse gate (arc-pretool-hook.js), which checks liveness first: to a
// LIVE peer it defers (just a note), and only an empty chair is judged — passive DENIES, balanced
// ASKS, active ALLOWS. Note this binds the HUMAN too: a gate sees a tool call and cannot tell
// your order from the agent's own idea, so passive refuses the spawn whoever wanted it.
//
// THE DEFAULT IS `balanced`, AND IT INJECTS NOTHING. Two facts drove that:
//   * A default of `passive` silently BROKE a real workflow: two live sessions on the whalephone
//     board had built 37 notes of genuine collaboration, and a passive default would have told
//     them "do not self-initiate a note" — they'd have just stopped talking, with nothing to say
//     why. Noting a peer is cheap, reversible, and the entire point of the board. The heavier
//     initiative — pulling a peer off their own work to ASK them something, arming a background
//     watch — is what stays opt-in.
//   * Those same 37 notes were written with NO stance system at all — the `peers` skill alone
//     already produces balanced behaviour. So the default needs no injection; only a DEVIATION
//     from it does. `passive` injects a RESTRICTION, `active` injects a GRANT, `balanced` is
//     silent — the common case costs zero tokens.
// And when you are solo, balanced changes nothing: the skill says "no peer → do nothing".
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');
const STANCES = ['passive', 'balanced', 'active'];
const DEFAULT = 'balanced';   // see the header: a passive default silently broke a real workflow

function stanceFile(session) { return path.join(CACHE_DIR, `arc-stance-${session}.json`); }

function getStance(session) {
  try {
    const s = JSON.parse(fs.readFileSync(stanceFile(String(session)), 'utf8')).stance;
    return STANCES.includes(s) ? s : DEFAULT;
  } catch { return DEFAULT; }
}

function setStance(session, stance) {
  const s = String(stance || '').toLowerCase();
  if (!STANCES.includes(s) || !session) return null;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = stanceFile(session) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ stance: s, at: Date.now() }));
    fs.renameSync(tmp, stanceFile(session));
  } catch {}
  return s;
}

// The per-turn directive injected into the agent's context. null = inject nothing.
// Only a DEVIATION from the default speaks: passive restricts, active grants, balanced is silent.
function directive(stance) {
  if (stance === 'passive') {
    return "[arc stance: PASSIVE] Do NOT self-initiate anything with arc's tools this turn — no notes to peers, no asking peers for help, and no spawning peer sessions (delegating to an EMPTY chair is REFUSED in passive, because it would start one; delegating to a LIVE peer is still just a note and is fine). Act only on the user's explicit order. (Listening is exempt and always on: if arc asks you to run `arc join`, do it, and if a peer's note wakes you, read it and tell the user. Passive means you don't START things, not that you go deaf.) They can lift this with `arc:mode balanced`.";
  }
  if (stance === 'active') {
    return "[arc stance: ACTIVE] Beyond noting peers, you MAY self-initiate the rest of the board when it clearly helps: when you're STUCK, hand the job to whoever owns that area — `arc delegate <role> \"<packet>\"` — instead of grinding alone. That ONE verb covers it whether they are live, closed, or have never existed here: arc notes a live peer, revives a closed one as itself, and staffs an empty chair from your context. Staffing is auto-approved in this mode (arc still asks once several peers are already live, since each burns its own quota). Still confirm anything irreversible or outward-facing before doing it.";
  }
  return null; // balanced (the default): the `peers` skill already teaches it — say nothing, cost nothing
}

// One-line description, for the picker help + the set confirmation.
function summary(stance) {
  return stance === 'active' ? 'also ask a peer when stuck, and STAFF an empty chair without asking'
    : stance === 'balanced' ? 'the default — note peers on real changes; spawning a peer asks you first'
      : 'silent — act only on your order; delegating to an EMPTY chair is REFUSED (it spawns)';
}

// A plain-text spectrum bar with the selection marked, reused by the set-confirmation and
// (with its own ANSI) mirrored by the picker:  passive ─ [ balanced ] ─ active
function renderBar(sel) {
  return STANCES.map((s) => (s === sel ? `[ ${s} ]` : ` ${s} `)).join('─');
}

module.exports = { STANCES, DEFAULT, getStance, setStance, directive, summary, renderBar, stanceFile };
