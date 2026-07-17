#!/usr/bin/env node
// arc-duty: what a ROLE owns — declared once, in the repo, outliving every session that holds it.
//
// THE DISTINCTION THIS RESTS ON: duty is a ROLE fact, presence is a SESSION fact.
//   .arc/roles/<role>.md   what "research" OWNS. A project fact: identical on every machine,
//                          true whether or not anyone is sitting in that chair right now.
//                          COMMITTED — this is CODEOWNERS for agent peers.
//   .peer/claim-<role>.json  WHO is live in that chair, on THIS machine, right now.
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
// The roster renders to a TERMINAL, not to a markdown viewer, so `**bold**` and `` `code` ``
// arrive as literal punctuation. We ask for three plain lines (owns:/send me:/not me:) and the
// first real board answered with two full documents — headings, bold, bullets. That is the honest
// default: a session writing its own charter writes prose. So strip the markup here rather than
// pretend the format guidance will hold.
function plainly(s) {
  return String(s)
    .replace(/`([^`]+)`/g, '$1')            // `code` -> code
    .replace(/\*\*([^*]+)\*\*/g, '$1')      // **bold** -> bold
    .replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, '$1$2')   // *ital* -> ital (never touches a*b)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')          // [text](url) -> text
    .replace(/\s+/g, ' ')
    .trim();
}

// Cut on a WORD boundary. A mid-word chop ("evidence-grounded, skeptic-verifi") reads as data
// corruption in a roster whose whole job is telling an agent who owns what.
function clip(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, '') + '…';
}

// A duty file is hard-wrapped prose, so ONE PHYSICAL LINE is an arbitrary column cut, not a
// thought: the first real board's `android` ended its summary at "the on-device Android app (the"
// — a dangling article and an unclosed paren, because the author's editor wrapped at 104 columns.
// So read a PARAGRAPH (consecutive lines, joined) and let the sentence decide where it ends.
const isBreak = (l) => !l || /^#/.test(l) || /^<!--/.test(l) || /^-{3,}$/.test(l) || /^[-*+]\s/.test(l);

function paragraphFrom(lines, i, stopAtKey) {
  const out = [];
  for (let j = i; j < lines.length; j++) {
    const l = lines[j];
    if (j > i && (isBreak(l) || (stopAtKey && /^\**[a-z][a-z ]{1,12}\**\s*:/i.test(l)))) break;
    out.push(l);
  }
  return out.join(' ');
}

// Prefer a whole SENTENCE when one fits — "The read-only inquiry / research session." says more,
// and says it cleanly, than 100 characters chopped out of the middle of a paragraph.
function summarize(para, max) {
  const s = plainly(para);
  const dot = s.search(/[.!?](?:\s|$)/);
  if (dot >= 24 && dot + 1 <= max) return s.slice(0, dot + 1);
  return clip(s, max);
}

function dutySummary(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const oi = lines.findIndex((l) => /^\**owns\**\s*:/i.test(l));
  if (oi >= 0) return summarize(paragraphFrom(lines, oi, true).replace(/^\**owns\**\s*:\s*/i, ''), 100);
  const pi = lines.findIndex((l) => l && !isBreak(l));
  return pi >= 0 ? summarize(paragraphFrom(lines, pi, false), 100) : '';
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
// could never see before: the duty EXISTS here, so the work has an owner even with the chair empty.
//
//   live       + declared    a peer you can note RIGHT NOW, and you know what they own
//   live       + undeclared  someone is here but never said what they own (nudge them)
//   closed     + declared    this repo HAS this duty; nobody is in the chair right now
//   (absent)                 not a role here at all
//
// The roster answers WHO OWNS THIS, which is the agent's judgment to make. It deliberately does
// NOT tell the agent what to DO about an empty chair: `arc delegate <role>` covers live, closed
// and never-existed alike, so branching on this state is arc's job, not the model's.
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

// THE ONE CANONICAL SHAPE — the single source of truth for what a charter looks like. It used to
// be dead code (exported, never called) while TWO other sites hard-coded their own copies of the
// same instruction, which had already drifted from each other and from this — so every agent riffed
// and no two role files matched. Now the switch-hook write-branch and requestRole both render THIS,
// via templateInstruction(). Deliberately tiny: it is read by OTHER agents, and a charter nobody
// finishes reading is a charter nobody follows. The boundary line ("not me") carries most of the
// value — it is what stops a peer doing someone else's job.
//
// FOUR KEYS, in a fixed order. Three are for humans AND double as delimiters (their presence stops
// the `owns:` summary from swallowing the rest — see dutySummary). `paths:` is the only OPTIONAL
// one, and the only one a MACHINE parses beyond `owns:`: it scopes the revive freshness brief to a
// role's own files. It sits last and says "delete me" so a repo-wide role isn't forced to invent
// globs. Everything below the header is free: expand into ## sections and file lists as the role
// warrants — `android` legitimately needs them; a one-file role does not.
function template(role) {
  return `# ${role}\n\n`
    + `owns: <the one line another agent needs — what is yours, in this repo>\n`
    + `send me: <what a peer should hand you, and in what shape>\n`
    + `not me: <what you do NOT do — the boundary that stops peers guessing>\n`
    + `paths: <optional — git globs that are yours, e.g. src/foo/** test/foo* — so a revive briefs\n`
    + `        you on only YOUR changes. Delete this line if your role spans the whole repo.>\n`;
}
// The same shape as an INDENTED instruction for the claim-time injection (a numbered step inside a
// larger message). One renderer so the write-branch and the CLI echo cannot drift again.
function templateInstruction(role, indent) {
  const p = indent || '       ';
  return `${p}owns: <what is yours in this repo>\n`
    + `${p}send me: <what a peer should hand you, in what shape>\n`
    + `${p}not me: <the boundary — what you do NOT do>\n`
    + `${p}paths: <optional git globs that are yours; delete if you span the whole repo>\n`;
}

module.exports = { rolesDir, dutyPath, dutyRel, dutySummary, readDuty, listDuties, roster, template, templateInstruction, ROLES_REL };
