#!/usr/bin/env node
// arc-duty: what a ROLE owns — declared once, in the repo, outliving every session that holds it.
//
// THE DISTINCTION THIS RESTS ON: duty is a ROLE fact, presence is a SESSION fact.
//   .arc/roles/<role>.md   what "research" OWNS. A project fact: identical on every machine,
//                          true whether or not anyone is sitting in that chair right now.
//                          COMMITTED — this is CODEOWNERS for agent peers.
//   .plan/claim-<role>.json  WHO is live in that chair, on THIS machine, right now.
//                          Local, ephemeral, gitignored (see arc-board).
//
// Why it earns its keep: without it, `research` is just a STRING, and an agent asking "is this
// research's job or mine?" can only guess. Worse, when research is CLOSED the string tells you
// nothing at all — you cannot even know the board HAS a research duty. That was a real hole: a
// peer would either do work that belonged to someone else, or spawn a duplicate role under a
// synonym. A declaration is the data that makes the question answerable, and because it is a
// FILE rather than a session, it answers just as well when nobody is home.
//
// ADOPT, DON'T OVERWRITE. A session claiming `research` inherits the existing declaration — the
// duty belongs to the role, not to whoever holds it today. Rewriting it from memory on every
// restart is how a team charter silently drifts. Amend only when the duty really changed.
//
// arc never writes these and never commits them: the AGENT authors the prose (it takes judgment),
// the HUMAN commits it (it is their repo). arc only reads them and puts them where they are seen.
'use strict';

const fs = require('fs');
const path = require('path');

const ROLES_REL = path.join('.arc', 'roles');

function rolesDir(board) { return path.join(board.root, ROLES_REL); }
function dutyPath(board, role) { return path.join(rolesDir(board), `${String(role).toLowerCase()}.md`); }
// The path we SHOW an agent: repo-relative, so it is the same string on every machine and can be
// pasted straight into a Read.
function dutyRel(role) { return path.join(ROLES_REL, `${String(role).toLowerCase()}.md`).replace(/\\/g, '/'); }

// The one-line summary for the roster. This is the whole progressive-disclosure move: `arc role`
// shows ONE line per role (cheap even with six peers), and the full declaration is one Read away.
// Prefer an explicit `owns:` line; fall back to the first real prose line so a free-form
// declaration still surfaces something rather than nothing.
function dutySummary(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const owns = lines.find((l) => /^owns\s*:/i.test(l));
  if (owns) return owns.replace(/^owns\s*:\s*/i, '').slice(0, 100);
  const prose = lines.find((l) => l && !/^#/.test(l) && !/^<!--/.test(l) && !/^-{3,}$/.test(l));
  return prose ? prose.slice(0, 100) : '';
}

function readDuty(board, role) {
  const p = dutyPath(board, role);
  try {
    const text = fs.readFileSync(p, 'utf8');
    return { role: String(role).toLowerCase(), summary: dutySummary(text), path: dutyRel(role), text };
  } catch { return null; }
}

// Every role this repo has DECLARED, live or not. This is the half that survives a session
// closing — and the half a fresh clone still has.
function listDuties(board) {
  let files = [];
  try { files = fs.readdirSync(rolesDir(board)); } catch { return []; }
  return files
    .filter((f) => f.endsWith('.md'))
    .map((f) => readDuty(board, f.slice(0, -3)))
    .filter(Boolean)
    .sort((a, b) => a.role.localeCompare(b.role));
}

// THE ROSTER: declarations (what this repo says exists) merged with claims (who is actually
// here). The four states are the whole point — especially `closed`, which is the one an agent
// could never see before and the one that decides invite-vs-do-it-myself.
//
//   live       + declared    a peer you can note RIGHT NOW, and you know what they own
//   live       + undeclared  someone is here but never said what they own (nudge them)
//   closed     + declared    this repo HAS this duty; nobody is in the chair -> arc:invite <role>
//   (absent)                 not a role here at all
function roster(board, liveRoles) {
  const live = new Map((liveRoles || []).map((l) => [l.role, l]));
  const out = [];
  for (const d of listDuties(board)) {
    out.push({ role: d.role, summary: d.summary, path: d.path, declared: true, live: live.has(d.role) });
    live.delete(d.role);
  }
  for (const [role] of live) out.push({ role, summary: '', path: dutyRel(role), declared: false, live: true });
  return out.sort((a, b) => (b.live - a.live) || a.role.localeCompare(b.role));
}

// The shape an agent is asked to write. Deliberately tiny: it is read by OTHER agents, and a
// charter nobody finishes reading is a charter nobody follows. The boundary lines carry most of
// the value — "not me" is what stops a peer doing someone else's job.
function template(role) {
  return `# ${role}\n\n`
    + `owns: <the one line another agent needs — what is yours, in this repo>\n`
    + `send me: <what a peer should hand you, and in what shape>\n`
    + `not me: <what you do NOT do — the boundary that stops peers guessing>\n`;
}

module.exports = { rolesDir, dutyPath, dutyRel, dutySummary, readDuty, listDuties, roster, template, ROLES_REL };
