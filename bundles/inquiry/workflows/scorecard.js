#!/usr/bin/env node
// scorecard.js — the taste-calibration scorecard, computed from YOUR in-the-moment
// ratings in feedback.jsonl (never from memory or an LLM estimate). Answers: how
// well is the loop's "when to interrupt you" matching what you actually call worthy?
//
//   node scorecard.js [path/to/feedback.jsonl]
//   Default: INQUIRY_HOME, ~/.inquiry, or legacy ~/.claude/inquiry.
//
// feedback.jsonl reaction vocabulary (one JSON object per line):
//   escalate-worthy   — it interrupted you and you said "worth it"
//   escalate-noise    — it interrupted you and you said "not worth it"
//   missed-escalation — a finding it did NOT surface that you wish it had
//   acted / ignored   — revealed action on a surfaced finding
//   limiter-picked / limiter-rejected — Bootstrap candidate choices
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();
const configuredHome = process.env.INQUIRY_HOME;
const sharedHome = path.join(home, '.inquiry');
const legacyHome = path.join(home, '.claude', 'inquiry');
const inquiryHome = configuredHome || (fs.existsSync(sharedHome) ? sharedHome :
  (fs.existsSync(legacyHome) ? legacyHome : sharedHome));
const file = process.argv[2] || path.join(inquiryHome, 'feedback.jsonl');
let rows = [];
try {
  rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
} catch { console.log(`no feedback yet — ${file} doesn't exist. Rate a few escalations first.`); process.exit(0); }

if (!rows.length) { console.log('feedback.jsonl is empty — nothing to score yet.'); process.exit(0); }

const count = (r) => rows.filter((x) => x.reaction === r).length;
const worthy = count('escalate-worthy'), noise = count('escalate-noise'), missed = count('missed-escalation');
const acted = count('acted'), ignored = count('ignored');
const picked = count('limiter-picked'), rejected = count('limiter-rejected');
const escShown = worthy + noise;
const prec = escShown ? worthy / escShown : null;                    // of interruptions, % you called worth it
const recall = (worthy + missed) ? worthy / (worthy + missed) : null; // of things you wanted, % it caught
const runs = new Set(rows.map((r) => r.run)).size;
const pct = (x) => x == null ? 'n/a' : Math.round(x * 100) + '%';

console.log('════ inquiry · taste scorecard ════');
console.log(`feedback events: ${rows.length}   ·   runs rated: ${runs}   ·   source: ${file}`);
console.log('');
console.log(`escalation PRECISION — of the times it interrupted you, % you called WORTH IT`);
console.log(`   ${pct(prec)}   (${worthy} worthy / ${escShown} interruptions${noise ? `, ${noise} were noise` : ''})`);
console.log(`escalation RECALL — of what you'd have wanted, % it actually surfaced`);
console.log(`   ${pct(recall)}   (${missed} thing${missed === 1 ? '' : 's'} you flagged it should've raised)`);
if (acted + ignored) console.log(`acted on: ${acted}   ·   ignored: ${ignored}   (revealed action)`);
if (picked + rejected) console.log(`Bootstrap limiters: ${picked} picked / ${rejected} rejected`);
console.log('');
// tuning hints — the whole point is a metric that tells you which way to nudge
const hints = [];
if (prec != null && escShown >= 4 && prec < 0.6) hints.push('PRECISION low → raise escalateBar, or tighten/kill an over-eager YES example in taste.md.');
if (recall != null && missed > 0 && recall < 0.7) hints.push('RECALL low → lower escalateBar, and add the missed items to taste.md YES examples.');
if (prec != null && prec >= 0.8 && (recall == null || recall >= 0.8)) hints.push('Well-calibrated — the bar matches your taste; leave it.');
if (escShown < 4) hints.push(`Only ${escShown} rated interruption(s) — rate a few more runs before trusting the numbers.`);
console.log(hints.length ? 'HINTS:\n  - ' + hints.join('\n  - ') : '(no tuning hints)');
