#!/usr/bin/env node
// arc-anchor: notice when a DOC's claim about the CODE has gone stale.
//
// The research session writes `docs/plan.md` saying "auth.ts#handleLogin validates the
// nonce". The coding session then rewrites handleLogin. Nothing breaks; no test fails;
// the doc is now a lie, and nobody finds out until someone acts on it. This is the
// half of the drift problem that arc-done.js does not touch: arc-done proves that work
// HAPPENED, and this proves that what we WROTE about the code still describes it.
//
// An anchor is a comment you put next to the claim, in the doc:
//
//     <!-- arc:anchor src/auth.ts#handleLogin -->
//     handleLogin validates the nonce before issuing a session.
//
// The FIRST time arc sees an anchor it seals it: it resolves the symbol, hashes the
// block, and remembers the hash in .plan/anchor-state.json. Afterwards, whenever the
// repo moves, it re-resolves. If the block's hash changed, or the symbol vanished, or
// the file is gone, a HIGH-PRIORITY note lands on the fridge — which the research
// session then receives at the top of its next turn, without asking.
//
// WHY NOT AN AST. fiberplane/drift resolves anchors with tree-sitter, which is the
// right answer and the one we cannot have: arc has ZERO dependencies and must run
// on Windows, macOS and Linux, and tree-sitter means native prebuilds per platform per
// grammar. So the anchor is a fingerprint, not a parse:
//   * find the first line that both names the symbol as a word AND looks like a
//     definition (a brace/paren/colon/= after it, or a def/class/function keyword);
//   * take the block from there to the next non-blank line indented no deeper;
//   * hash that.
// The honest consequence: it tracks a NAMED BLOCK. Rename the symbol and the anchor
// reports "gone" rather than "renamed". Reformat the block and it reports "changed"
// even if the meaning did not. It over-reports rather than under-reports, which is the
// correct bias for a staleness alarm — a false STALE costs a glance, a missed one
// costs a wrong decision.
//
// We never rewrite the user's doc. The seal lives in .plan/, so the doc stays the
// doc.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const R = require('./arc-room');

const STATE = 'anchor-state.json';
const MAX_ANCHORS = 200;      // an alarm, not an index
const MAX_BLOCK_LINES = 400;
const GIT_TIMEOUT = 4000;

// `<!-- arc:anchor path/to/file.ts#symbol -->`, or any comment syntax — we only look
// for the token. The path may not contain whitespace or '#'.
const ANCHOR_RX = /arc:anchor\s+([^\s#]+)#([A-Za-z_$][\w$-]*)/g;

const statePath = (room) => path.join(room.planDir, STATE);
const anchorKey = (a) => `${a.doc}|${a.file}#${a.symbol}`;

function readState(room) {
  try { return JSON.parse(fs.readFileSync(statePath(room), 'utf8')); } catch { return { lastHead: null, anchors: {} }; }
}
function writeState(room, st) {
  try { R.ensureRoom(room); fs.writeFileSync(statePath(room), JSON.stringify(st, null, 2)); return true; } catch { return false; }
}

// ---- parsing ------------------------------------------------------------------
function parseAnchors(text, docPath) {
  const out = [];
  let m;
  ANCHOR_RX.lastIndex = 0;
  while ((m = ANCHOR_RX.exec(text)) && out.length < MAX_ANCHORS) {
    out.push({ doc: docPath, file: m[1].replace(/\\/g, '/'), symbol: m[2] });
  }
  return out;
}

// ---- resolution ---------------------------------------------------------------
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const indentOf = (line) => (line.match(/^[ \t]*/) || [''])[0].length;

// Does this line DEFINE `symbol`, rather than merely mention it? Deliberately loose:
// covers js/ts (function/const/class/=>/method), python (def/class), go/rust (func/fn),
// and plain `symbol(` / `symbol:` / `symbol =` forms.
function isDefinitionLine(line, symbol) {
  const word = new RegExp(`\\b${escapeRx(symbol)}\\b`);
  if (!word.test(line)) return false;
  if (/^\s*(?:\/\/|#|\*|<!--)/.test(line)) return false;            // a comment mentioning it
  if (/\b(?:function|class|def|fn|func|interface|type|struct|enum)\b/.test(line)) return true;
  return new RegExp(`\\b${escapeRx(symbol)}\\b\\s*(?:[=:(]|=>)`).test(line);
}

// The block: from the definition line down to the next non-blank line indented no
// deeper than it. Crude, language-agnostic, and good enough to notice a rewrite.
function findSymbol(source, symbol) {
  const lines = source.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (isDefinitionLine(lines[i], symbol)) { start = i; break; }
  }
  if (start === -1) return null;
  const base = indentOf(lines[start]);
  let end = lines.length - 1;
  for (let i = start + 1; i < lines.length && i - start < MAX_BLOCK_LINES; i++) {
    if (!lines[i].trim()) continue;
    if (indentOf(lines[i]) <= base) {
      // In brace languages the block's OWN closing line sits at the base indent, so a
      // naive "first line indented no deeper ends the block" drops the `}` and hashes a
      // truncated body. A line made only of closing delimiters belongs to this block;
      // anything else (`const y = 2;`, the next `def`) starts the following one.
      end = /^[\s)}\];,]+$/.test(lines[i]) ? i : i - 1;
      break;
    }
    end = i;
  }
  // `end` can land on the blank line separating this block from the next one (python).
  // Trailing blanks are not part of the block, and including them would make the hash
  // sensitive to whitespace edits below the code.
  while (end > start && !lines[end].trim()) end--;
  const slice = lines.slice(start, end + 1).join('\n');
  return { startLine: start + 1, endLine: end + 1, slice };
}

// Hash the block, normalised for line endings and trailing whitespace only. We do NOT
// normalise indentation or blank lines: a reformat IS a change we want to hear about.
function hashSlice(slice) {
  const norm = slice.split(/\r?\n/).map((l) => l.replace(/[ \t]+$/, '')).join('\n');
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

// ---- discovery ----------------------------------------------------------------
// `git grep` respects .gitignore and is far faster than walking. No repo -> no anchors.
// --untracked matters: a doc you have written but not yet committed still makes claims
// about the code, and without it the anchor stays invisible until the doc is committed.
// (.gitignore is still honoured, so .plan/ and node_modules never get scanned.)
function anchorDocs(root) {
  try {
    const out = execFileSync('git', ['grep', '-l', '-I', '-F', '--untracked', 'arc:anchor'],
      { cwd: root, timeout: GIT_TIMEOUT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }   // exit 1 = no matches, which is not an error
}

function gitHead(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'],
      { cwd: root, timeout: GIT_TIMEOUT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

// ---- the check ----------------------------------------------------------------
// Statuses: 'sealed' (first sighting), 'ok', 'changed', 'gone-symbol', 'gone-file'.
const STALE_STATUSES = new Set(['changed', 'gone-symbol', 'gone-file']);

function checkAnchor(root, a) {
  const target = path.join(root, a.file);
  let src;
  try { src = fs.readFileSync(target, 'utf8'); } catch { return { ...a, status: 'gone-file' }; }
  const found = findSymbol(src, a.symbol);
  if (!found) return { ...a, status: 'gone-symbol' };
  return { ...a, status: 'ok', hash: hashSlice(found.slice), startLine: found.startLine };
}

// Read every anchor in the room and classify it against the sealed state.
// Pure-ish: returns the report AND the next state; the caller decides to persist.
function inspect(room) {
  const root = room.root;
  const st = readState(room);
  const docs = anchorDocs(root);
  const anchors = [];
  for (const d of docs) {
    let text; try { text = fs.readFileSync(path.join(root, d), 'utf8'); } catch { continue; }
    anchors.push(...parseAnchors(text, d));
    if (anchors.length >= MAX_ANCHORS) break;
  }

  const next = { lastHead: gitHead(root), anchors: {} };
  const results = [];
  for (const a of anchors) {
    const key = anchorKey(a);
    const prev = st.anchors[key];
    const r = checkAnchor(root, a);

    if (r.status === 'ok' && !prev) {
      results.push({ ...r, status: 'sealed' });
      next.anchors[key] = { hash: r.hash, stale: false };
      continue;
    }
    if (r.status === 'ok') {
      const same = prev.hash === r.hash;
      results.push({ ...r, status: same ? 'ok' : 'changed', wasStale: !!prev.stale });
      next.anchors[key] = { hash: r.hash, stale: same ? false : true };
      continue;
    }
    // gone-file / gone-symbol. If we NEVER sealed this anchor, it has never once
    // resolved — so it is not a claim that went stale, it is a claim that was never
    // true. Documentation EXAMPLES are exactly this shape (`arc:anchor src/auth.ts#…`
    // inside a README), and nagging about them would make the alarm worthless on its
    // first run. Report it, don't post it.
    // `prev.unresolved` means we recorded it but NEVER sealed a hash, so it still has
    // never resolved. Treating that entry as "previously seen" would flip a doc example
    // to stale on the SECOND run — the exact nagging this branch exists to prevent.
    if (!prev || prev.unresolved) {
      results.push({ ...r, status: 'unresolved' });
      next.anchors[key] = { hash: null, stale: false, unresolved: true };
      continue;
    }
    results.push({ ...r, wasStale: !!prev.stale });
    next.anchors[key] = { hash: prev.hash, stale: true };
  }
  // Anchors that disappeared from the docs simply drop out of the state.
  return { results, next, headChanged: st.lastHead !== next.lastHead, lastHead: st.lastHead };
}

const REASON = {
  changed: 'the code it points at CHANGED',
  'gone-symbol': 'the symbol no longer exists',
  'gone-file': 'the file no longer exists',
  unresolved: 'it has never resolved — a doc example, or a typo',
};

function noteFor(r, role) {
  return {
    from: role,
    to: null,                 // broadcast: whoever wrote the doc may not be who reads it
    priority: 'high',         // [!] — it jumps the queue at turn start
    body: `STALE: ${r.doc} describes ${r.file}#${r.symbol}, but ${REASON[r.status]}. `
      + 'Re-read the code and correct the doc (or delete the anchor if the claim is gone).',
    refs: { doc: r.doc, anchor: `${r.file}#${r.symbol}`, why: r.status },
  };
}

// Run the check and post a [!] note for each anchor that has JUST gone stale.
// Only newly-stale ones: an anchor that was already stale stays quiet until it is fixed
// or the code changes again, otherwise every completion would re-nag about the same doc.
function checkAndNotify(room, role, opts = {}) {
  const { results, next, headChanged } = inspect(room);
  if (!opts.force && !headChanged) return { checked: 0, posted: 0, skipped: 'head-unchanged' };

  const newlyStale = results.filter((r) => STALE_STATUSES.has(r.status) && !r.wasStale);
  let posted = 0;
  if (role) {
    for (const r of newlyStale) {
      try { R.appendNote(room, noteFor(r, role)); posted++; } catch {}
    }
  }
  writeState(room, next);

  // A [!] note is the one kind that shouldn't wait for the recipient's next turn to be
  // noticed — the docs are wrong RIGHT NOW, and the other session may be mid-task on
  // them. The note still arrives at the turn boundary (nothing can interrupt an agent);
  // the toast just tells the HUMAN that it's coming. Best-effort, never fatal.
  if (posted && !opts.quiet) {
    try {
      require('./arc-notify').toast(
        `⚠ ${posted} doc${posted > 1 ? 's' : ''} went stale`,
        newlyStale.map((r) => `${r.doc} → ${r.file}#${r.symbol}`).join('\n').slice(0, 200),
        'fail');
    } catch {}
  }
  return { checked: results.length, posted, newlyStale, results };
}

// ---- arc:anchors (zero-token readout) ------------------------------------------
const MARK = {
  ok: '  ok  ', sealed: 'sealed', unresolved: '   ?  ',
  changed: '  [!] ', 'gone-symbol': '  [!] ', 'gone-file': '  [!] ',
};

function requestAnchors(session, arg, cwd) {
  const room = R.resolveRoom(cwd || process.cwd());
  if (!gitHead(room.root)) {
    return { ok: false, message: `room "${room.name}" is not a git repo — anchors need one.` };
  }
  const wantReseal = String(arg || '').trim().toLowerCase() === 'reseal';
  const { results, next } = inspect(room);
  if (wantReseal) {
    for (const k of Object.keys(next.anchors)) next.anchors[k].stale = false;
    writeState(room, next);
    return { ok: true, plain: true, message:
      `arc anchors — room "${room.name}"\n  resealed ${results.length} anchor(s): the current code is now the baseline.` };
  }
  writeState(room, next);
  if (!results.length) {
    return { ok: true, plain: true, message:
      `arc anchors — room "${room.name}"\n  no anchors found.\n`
      + '  Put one next to a claim in a doc:  <!-- arc:anchor src/auth.ts#handleLogin -->' };
  }
  const rows = results.map((r) =>
    `  ${MARK[r.status] || '  ?   '}  ${r.doc}  →  ${r.file}#${r.symbol}`
    + (r.status === 'ok' || r.status === 'sealed' ? `  (line ${r.startLine})` : `  — ${REASON[r.status]}`));
  const stale = results.filter((r) => STALE_STATUSES.has(r.status)).length;
  return { ok: true, plain: true, message:
    `arc anchors — room "${room.name}"   ${results.length} anchor(s), ${stale} stale\n${rows.join('\n')}\n`
    + (stale ? '  fix the docs, then:  arc:anchors reseal\n' : '') };
}

module.exports = {
  ANCHOR_RX, STALE_STATUSES, parseAnchors, isDefinitionLine, findSymbol, hashSlice,
  anchorDocs, gitHead, checkAnchor, inspect, checkAndNotify, noteFor, requestAnchors,
  statePath, anchorKey, readState, writeState,
};
