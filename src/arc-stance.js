#!/usr/bin/env node
// arc-stance: a per-session behavioural dial — how much INITIATIVE an agent takes with arc's
// agent-facing tools (arc note / delegate / watch). Set it like /effort: `arc:mode active`, or
// slide a passive·balanced·active bar with `arc:mode` (see the picker in arc-runner).
//
// WHY a model-level STEER and not a CLI gate: "passive = act only on the USER's order" is a
// distinction only the model can make — when you say "delegate this", the agent runs `arc
// delegate`, and that IS on your order. A CLI gate can't tell that from self-initiation. So the
// stance is INJECTED into the agent's context each turn (see arc-switch-hook.deliverFridge) and
// the agent self-governs. PASSIVE injects nothing — the baseline is the model's natural reactive
// default (no grant), so it costs zero tokens; BALANCED/ACTIVE inject an explicit GRANT.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');
const STANCES = ['passive', 'balanced', 'active'];
const DEFAULT = 'passive';

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
function directive(stance) {
  if (stance === 'active') {
    return "[arc stance: ACTIVE] You MAY use arc's agent tools on your own judgment when they clearly help — leave a roommate a note (`arc note`) when you change something that affects them, delegate heavy sub-tasks (`arc delegate`), watch for results (`arc await`). Still confirm anything irreversible or outward-facing before doing it.";
  }
  if (stance === 'balanced') {
    return "[arc stance: BALANCED] You MAY leave a roommate a note (`arc note`) when you change something that affects their work — but do NOT delegate, fan out background work, or broadcast unless the user asks.";
  }
  return null; // passive: no proactivity granted (the reactive baseline)
}

// One-line description, for the picker help + the set confirmation.
function summary(stance) {
  return stance === 'active' ? 'self-initiate arc tools when they clearly help (note · delegate · watch)'
    : stance === 'balanced' ? 'may note roommates on real changes; no delegate / fan-out unless asked'
      : 'act only on your order — no self-initiated notes, delegates, or fan-out';
}

// A plain-text spectrum bar with the selection marked, reused by the set-confirmation and
// (with its own ANSI) mirrored by the picker:  passive ─ [ balanced ] ─ active
function renderBar(sel) {
  return STANCES.map((s) => (s === sel ? `[ ${s} ]` : ` ${s} `)).join('─');
}

module.exports = { STANCES, DEFAULT, getStance, setStance, directive, summary, renderBar, stanceFile };
