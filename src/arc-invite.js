#!/usr/bin/env node
// arc-invite: spawn a PEER session — a new tab in the CURRENT Windows Terminal window that
// forks THIS conversation's context and joins the board under its own role.
//
//   arc:invite frontend      (sentinel — zero tokens; the tab + its opening turn do the work)
//   arc invite frontend      (agent CLI — heavier initiative: on the user's order, or ACTIVE)
//
// WHY A FORK AND NOT A FRESH SESSION: the point of inviting is that the newcomer already
// KNOWS the project — `--fork-session` copies the caller's conversation into a new session id,
// so the invited peer starts with the full context and none of the re-reading. (A delegate
// used to re-derive context every run; that tool died for it.)
//
// WHY THE OPENING PROMPT IS A SENTINEL: the tab launches `arc --resume <conv> --fork-session
// "arc:role <role>"`. That first prompt hits the UserPromptSubmit hook like any typed prompt:
// the claim happens in-hook, and the fresh-claim PASS-THROUGH hands the fork one turn to run
// `arc join <role>`. So the invited session claims + arms with machinery that already exists
// and is already tested — invite adds a tab, not a mechanism.
//
// ACCOUNT PINNING IS LOAD-BEARING: conversations live in per-account profiles
// (~/.claude/arc-profiles/<id>/projects). If the new tab auto-selected a DIFFERENT account,
// the caller's transcript would not exist there and the fork would die with "No conversation
// found". So the tab is pinned to the caller's account (ARC_RUNTIME_ACCOUNT).
//
// AND THE TAB MUST NOT STOP AT "Do you trust this folder?" — an invited session has no human
// to answer it, so it would sit at the dialog claimed-but-deaf forever. Found live: invite was
// passing the CANONICAL board root (lowercased, "e:\arc") while the caller ran as "E:\arc", so
// Claude Code saw a DIFFERENT project, inherited none of the caller's trust, and prompted. Two
// fixes below: launch in the caller's OWN cwd string (no phantom project), and pre-trust that
// exact path in the caller's own profile (see ensureTrusted).
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const R = require('./arc-board');
const N = require('./arc-notes');

// Locate wt.exe once per call (~30ms). spawn()'s ENOENT surfaces async — too late for a hook
// that must answer NOW — so probe first and pick the fallback deliberately.
function hasWt() {
  try { return spawnSync('where.exe', ['wt.exe'], { timeout: 5000 }).status === 0; } catch { return false; }
}

// ---- the trust dialog --------------------------------------------------------------------
// Claude Code asks "Do you trust the files in this folder?" the first time it opens a project,
// and stores the answer PER ACCOUNT PROFILE in <CLAUDE_CONFIG_DIR>/.claude.json under
//     projects["<path with forward slashes>"].hasTrustDialogAccepted
// There is no CLI flag to pre-accept it (only -p skips it, and that is non-interactive mode —
// not a TUI tab). An invited session cannot answer a dialog, so an unaccepted folder means it
// hangs at the prompt: claimed, deaf, and silent about why.
//
// So invite pre-accepts it — under a deliberately narrow rule: ONLY the CALLER'S OWN repo root,
// ONLY in the CALLER'S OWN account profile. That is a folder where a live session is ALREADY
// running, whose hooks and settings are therefore ALREADY active in this profile — the human
// accepted this exact folder to get here. A fork of that session, in that folder, on that
// account, is not a new trust decision and gains no access the caller does not already have.
// We never trust an arbitrary path, and we never touch another profile.
//
// This writes Claude Code's live config, so: back it up, change ONE flag, swap it atomically,
// and skip entirely when it is already trusted (the common case — usually a no-op).
function trustKey(dir) { return String(dir).replace(/\\/g, '/'); }

function ensureTrusted(launchDir, opts) {
  const o = opts || {};
  const cfgDir = (o.configDir !== undefined ? o.configDir : process.env.CLAUDE_CONFIG_DIR || '').trim();
  if (!cfgDir) return { ok: false, why: 'no account profile (CLAUDE_CONFIG_DIR unset)' };
  const p = path.join(cfgDir, '.claude.json');
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { ok: false, why: `cannot read ${p}` }; }

  const key = trustKey(launchDir);
  const projects = j.projects || (j.projects = {});
  const entry = projects[key] || (projects[key] = { allowedTools: [], hasTrustDialogAccepted: false, projectOnboardingSeenCount: 0 });
  if (entry.hasTrustDialogAccepted) return { ok: true, already: true };

  // The dangerous race is not ours clobbering Claude Code — it is CLAUDE CODE flushing its own
  // in-memory copy over ours a moment later, silently ERASING the flag and regressing the fix
  // with no error anywhere. So: write, then READ BACK, and retry a couple of times. If the flag
  // still will not stick, say so plainly rather than promise a tab that will hang. (Raised by
  // the scout peer.)
  try { fs.copyFileSync(p, `${p}.bak-arc`); } catch { /* best effort — never block on the backup */ }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const cur = JSON.parse(fs.readFileSync(p, 'utf8'));      // re-read: keep whatever CC just wrote
      const projs = cur.projects || (cur.projects = {});
      const e2 = projs[key] || (projs[key] = { allowedTools: [], hasTrustDialogAccepted: false, projectOnboardingSeenCount: 0 });
      e2.hasTrustDialogAccepted = true;
      const tmp = `${p}.arc-tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cur, null, 2));
      fs.renameSync(tmp, p);                                    // atomic swap
      const back = JSON.parse(fs.readFileSync(p, 'utf8'));      // and PROVE it survived
      if (back.projects && back.projects[key] && back.projects[key].hasTrustDialogAccepted) {
        return { ok: true, seeded: true };
      }
    } catch (e) { if (attempt === 3) return { ok: false, why: e.message }; }
  }
  return { ok: false, why: 'the trust flag did not stick (Claude Code kept overwriting it)' };
}

// HOW THE TAB IS OPENED — two hard-won facts (bisected live; each costs a silent no-tab):
//   1. wt.exe must be reached THROUGH POWERSHELL. It is a WindowsApps execution alias, and
//      CreateProcess'd directly from node it launches but silently DROPS its arguments.
//   2. The launcher must be SYNCHRONOUS. wt hands the tab request to the running Terminal
//      over COM; a detached+unref'd spawner exits before the handoff completes and the
//      request simply evaporates — status 0, no tab, nothing to debug. spawnSync waits the
//      ~half-second the handoff needs; the session in the tab is independent after that.
// The '"arc:role <role>"' nesting is deliberate: PS strips '…' → wt/cmd sees "arc:role X" →
// arc.cmd %* keeps the quotes → node receives ONE argv slot. Verified end-to-end.
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
function buildLaunch(wt, account, conv, role, root) {
  const acct = account ? ` --account ${account}` : '';
  if (wt) {
    // --suppressApplicationTitle is what makes the title STICK. Without it the tab shows "arc"
    // like every other tab: Claude Code sets the terminal title from the project folder, and an
    // application title escape overrides wt's --title. With two identical "arc" tabs you cannot
    // tell the caller from the peer it spawned — so the peer's tab is pinned to its ROLE.
    return `wt -w 0 new-tab --title ${psQuote('arc: ' + role)} --suppressApplicationTitle -d ${psQuote(root)} `
      + `cmd /c arc${acct} --resume ${conv} --fork-session '"arc:role ${role}"'`;
  }
  // No Windows Terminal: a fresh console window via start (best-effort fallback).
  return `cmd /c start "arc: ${role}" /d "${root}" cmd /c arc${acct} --resume ${conv} --fork-session '"arc:role ${role}"'`;
}

function requestInvite(session, arg, cwd, opts) {
  const o = opts || {};
  const doSpawn = o.spawn || spawnSync;           // tests inject a recorder — nothing real opens
  const wt = o.hasWt !== undefined ? o.hasWt : hasWt();

  if (!session) return { ok: false, message: 'NOT under the arc wrapper (launch with `arc`).' };
  const role = String(arg || '').trim().toLowerCase();
  if (!role) {
    return { ok: false, message:
      'usage: arc:invite <role>   (e.g. arc:invite frontend)\n' +
      'Opens a NEW TAB in this window: a session that FORKS this conversation\'s context,\n' +
      'claims <role> on this board, and arms its own listener — a live peer, zero setup.' };
  }
  if (!N.VALID_ROLE.test(role)) return { ok: false, message: `invalid role "${role}" — letters/digits/dash/underscore, starting with a letter.` };

  // The board, the launch dir and the trusted folder ALL anchor to the session's own recorded
  // cwd (see launchDir below) — never to the caller's argument. Otherwise an agent could `cd`
  // anywhere and invite a peer onto a different repo's board than the tab it opens.
  const board = R.resolveBoard(N.resolveCwd(session, null));
  // Same guard as a claim, same reason: a board is the repo the peers SHARE.
  if (!fs.existsSync(path.join(board.root, '.git'))) {
    return { ok: false, message:
      `"${board.root}" is not a git repository, so there is no board here to invite a peer onto.\n` +
      `cd into the project repo and invite again.` };
  }
  // Refuse to invite into a collision — the invited tab would only die on the claim anyway,
  // but THERE the refusal is a corpse in a new window; HERE it is one zero-token line.
  const held = R.liveRoles(board).find((l) => l.role === role);
  if (held) {
    return { ok: false, message:
      `role "${role}" is already held by a LIVE session (pid ${held.pid}) on the "${board.name}" board.\n` +
      `That session IS your ${role} peer — leave it a note instead:  arc note ${role} "<text>"` };
  }
  const conv = N.sessionConv(session);
  if (!conv) {
    return { ok: false, message:
      'this conversation has no saved id yet, so there is nothing to fork — send one message first, then invite.' };
  }
  const account = (process.env.ARC_RUNTIME_ACCOUNT || '').trim() || null;

  // LAUNCH IN THE CALLER'S OWN PATH STRING, not board.root. board.root is CANONICAL (lowercased)
  // — right for board identity, since "E:\arc" and "e:\arc" must be ONE board. But Claude Code
  // keys a PROJECT (trust, settings, history) by the literal path, so launching the tab at the
  // canonical spelling invents a second project that inherits nothing from the caller — which is
  // exactly how the first live invite ended up stuck at the trust dialog.
  //
  // AND IT IS DERIVED FROM THE RUNNER'S RECORDED CWD, NEVER FROM THE CALLER'S ARGUMENT. This is
  // what makes "only the caller's own folder" a GUARANTEE instead of a comment: the passed cwd
  // is process.cwd() on the CLI path, so an agent could `cd` into any repo on the machine and
  // have invite pre-trust it. arc-state's cwd is written by the runner at launch and no agent
  // can forge it, so the folder we trust is always the one the session actually lives in.
  // (Caught by the scout peer: the security rule was documentation, not enforcement.)
  const launchDir = R.repoRoot(N.resolveCwd(session, null));
  const trust = (o.ensureTrusted || ensureTrusted)(launchDir, o);

  // -w 0 = a tab in the CURRENT window (verified; -w -1 would open a new window).
  //
  // FAILURE DETECTION IS THE WHOLE POINT HERE, and the obvious guard is wrong: spawnSync
  // returns status:NULL on both failure paths that matter — a timeout (error.code ETIMEDOUT)
  // and a missing binary (ENOENT) — so `status !== 0 && status !== null` fires on NEITHER, and
  // invite would print its ✓ with no tab anywhere. That is the exact silent no-tab this guard
  // exists to catch. (Caught by the scout peer reviewing the code that invited it; verified.)
  // Only status === 0 is success. And the timeout must stay SHORT: this runs inside the
  // UserPromptSubmit hook, so a wedged launcher stalls the user's own prompt. wt's COM handoff
  // takes ~0.5s.
  const psCmd = buildLaunch(wt, account, conv, role, launchDir);
  let r;
  try {
    r = doSpawn('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 5000 });
  } catch (e) {
    return { ok: false, message: `could not open the new tab: ${e.message}` };
  }
  if (!r || r.error || r.status !== 0) {
    const why = r && r.error ? r.error.code || r.error.message : `exit ${r ? r.status : '?'}`;
    return { ok: false, message: `could not open the new tab (${why}) — no peer was started.` };
  }

  const me = N.getRole(session, board);
  return { ok: true, role, trust, message:
    `✓ inviting a "${role}" peer — new ${wt ? 'tab in this window' : 'console window'}.\n` +
    `  it forks THIS conversation's context, claims "${role}" on the "${board.name}" board,\n` +
    `  and arms its own listener (one small turn in the new tab does all of it).\n` +
    (trust.seeded
      ? `  (trusted "${launchDir}" for this account so the new tab isn't stopped by the trust\n` +
        `   dialog it cannot answer — the same folder you are already working in. Backup:\n` +
        `   .claude.json.bak-arc)\n`
      : trust.ok ? '' :
        `  ⚠ could not pre-accept the folder-trust dialog (${trust.why}) — if the new tab asks\n` +
        `    "Do you trust the files in this folder?", answer it once and it will never ask again.\n`) +
    (me
      ? `  when it's up: arc role shows it — reach it with  arc note ${role} "<text>"`
      : `  tip: claim a role yourself too (arc:role <name>) so it can address you back.`) };
}

module.exports = { requestInvite, buildLaunch, ensureTrusted, trustKey, hasWt };
