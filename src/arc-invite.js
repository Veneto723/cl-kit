#!/usr/bin/env node
// arc-invite: STAFF a role — put a session in an empty chair on this board.
//
// Reached only through `arc delegate <role>` (arc-runner). There is no `arc:invite` sentinel and
// no bare `arc invite`: a human's natural act is PROSE ("get research on this"), not a command,
// and an agent should never have to know whether a chair is occupied before asking for work to be
// done in it. One verb; arc decides live-vs-closed-vs-new. See requestDelegate below.
//
// TWO WAYS TO FILL A CHAIR, and picking right is the whole value:
//   REVIVE  the role was held before and its own conversation still exists -> resume THAT, with
//           no --fork-session. It comes back as ITSELF: everything it learned, still there, and
//           it re-adopts its role automatically (a resumed conversation reclaims its vacant
//           claim). This is the one that matters — accumulated context is the entire reason a
//           peer beats a subagent, and forking the caller would hand the role's NAME to a
//           session with none of its MEMORY.
//   FORK    no history to return to -> --fork-session from the caller, so the newcomer at least
//           starts knowing the project instead of re-reading it.
//
// WHY THE OPENING PROMPT IS A SENTINEL: the tab launches `arc … --resume <conv> "arc:role <role>"`.
// That first prompt hits UserPromptSubmit like any typed prompt: the claim happens in-hook, and
// the fresh-claim PASS-THROUGH hands the new session one turn to run `arc join <role>`. So it
// claims and arms with machinery that already exists and is already tested — staffing adds a TAB,
// not a mechanism.
//
// ACCOUNT PINNING IS LOAD-BEARING: conversations live in per-account profiles
// (~/.claude/arc-profiles/<id>/projects). If the new tab auto-selected a DIFFERENT account, the
// conversation would not exist there and the resume would die with "No conversation found". So the
// tab is pinned to the caller's account (ARC_RUNTIME_ACCOUNT).
//
// AND THE TAB MUST NOT STOP AT "Do you trust this folder?" — a staffed session has no human to
// answer it, so it would sit at the dialog claimed-but-deaf forever. Found live: it was passing
// the CANONICAL board root (lowercased, "e:\arc") while the caller ran as "E:\arc", so Claude Code
// saw a DIFFERENT project, inherited none of the caller's trust, and prompted. Two fixes below:
// launch in the caller's OWN cwd string (no phantom project), and pre-trust that exact path in the
// caller's own profile (see ensureTrusted).
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
// `fork:false` = REVIVE: we are resuming the role's OWN conversation, so it must NOT be forked —
// it comes back as itself, with everything it learned. `fork:true` = a NEW peer born from the
// caller's context, which is the only sensible thing when the role has no history to return to.
function buildLaunch(wt, account, conv, role, root, fork) {
  const acct = account ? ` --account ${account}` : '';
  const inner = `arc${acct} --resume ${conv}${fork ? ' --fork-session' : ''} '"arc:role ${role}"'`;
  if (wt) {
    // --suppressApplicationTitle is what makes the title STICK. Without it the tab shows "arc"
    // like every other tab: Claude Code sets the terminal title from the project folder, and an
    // application title escape overrides wt's --title. With two identical "arc" tabs you cannot
    // tell the caller from the peer it spawned — so the peer's tab is pinned to its ROLE.
    return `wt -w 0 new-tab --title ${psQuote('arc: ' + role)} --suppressApplicationTitle -d ${psQuote(root)} cmd /c ${inner}`;
  }
  // No Windows Terminal: a fresh console window via start (best-effort fallback).
  return `cmd /c start "arc: ${role}" /d "${root}" cmd /c ${inner}`;
}

// Does a conversation still have a transcript on disk? A revive is `--resume <conv>`, and that
// fails outright ("No conversation found") if the transcript is gone — deleted, trashed, purged.
// So a vacant claim's convId is a LEAD, not a guarantee, and it must be checked before it is
// trusted. Profiles junction projects/ to the shared dir, so the account does not matter here.
function hasTranscript(convId) {
  if (!convId) return false;
  const root = path.join(require('os').homedir(), '.claude', 'projects');
  try {
    for (const d of fs.readdirSync(root)) {
      if (d === '.trash') continue;
      if (fs.existsSync(path.join(root, d, `${convId}.jsonl`))) return true;
    }
  } catch {}
  return false;
}

// STAFF a role: put a session in an empty chair. Two ways, and picking the right one is the
// whole value:
//   REVIVE  the role was held before and its own conversation still exists -> resume THAT.
//           It comes back as ITSELF, with everything it learned. This is the one that matters:
//           the entire reason a peer beats a subagent is accumulated context, and forking the
//           caller instead would hand the role's NAME to a session with none of its MEMORY.
//   FORK    no history to return to -> fork the caller's context, so the newcomer at least
//           knows the project.
function staffRole(session, role, opts) {
  const o = opts || {};
  const doSpawn = o.spawn || spawnSync;           // tests inject a recorder — nothing real opens
  const wt = o.hasWt !== undefined ? o.hasWt : hasWt();

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
  // REVIVE OR FORK. A vacant claim remembers the conversation of the session that held this
  // role; if that transcript still exists, resuming it brings the real peer back. The convId is
  // a LEAD, not a guarantee — the conversation may have been deleted or purged — so it is only
  // trusted once the transcript is confirmed on disk. Otherwise: fork the caller.
  const vacant = R.vacantClaimForRole(board, role);
  const revive = !!(vacant && (o.hasTranscript || hasTranscript)(vacant.convId));
  const conv = revive ? vacant.convId : N.sessionConv(session);
  if (!conv) {
    return { ok: false, message:
      'this conversation has no saved id yet, so there is nothing to fork from — send one message first, then try again.' };
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
  const psCmd = buildLaunch(wt, account, conv, role, launchDir, !revive);
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

  return { ok: true, role, revived: revive, trust, message:
    (revive
      ? `✓ REVIVING "${role}" — new ${wt ? 'tab in this window' : 'console window'}.\n`
        + `  it resumes ${role}'s OWN conversation, so it comes back as itself: everything it\n`
        + `  learned before, still there. It re-adopts the role and arms its own listener.\n`
      : `✓ staffing a new "${role}" peer — new ${wt ? 'tab in this window' : 'console window'}.\n`
        + `  no ${role} has worked here before, so it FORKS this conversation's context — it starts\n`
        + `  knowing the project. It claims "${role}" and arms its own listener.\n`) +
    (trust.seeded
      ? `  (trusted "${launchDir}" for this account so the new tab isn't stopped by the trust\n` +
        `   dialog it cannot answer — the same folder you are already working in. Backup:\n` +
        `   .claude.json.bak-arc)\n`
      : trust.ok ? '' :
        `  ⚠ could not pre-accept the folder-trust dialog (${trust.why}) — if the new tab asks\n` +
        `    "Do you trust the files in this folder?", answer it once and it will never ask again.\n`) };
}

// ---- THE ONE VERB ------------------------------------------------------------------------
//     arc delegate <role> [<packet>]
//
// "Get <role> on this." One verb, because the AGENT'S INTENT never changes: it wants a job done
// by whoever owns that area. What changes is only the plumbing — is that peer live, closed, or
// has it never existed? — and that is DATA arc already holds in the roster. Making the agent
// branch on it meant four steps of judgment written in prose, and prose is where agents drift:
// we watched a peer bounce its own decision to a human, and a fork believe it was its caller.
//
//     THE AGENT DECIDES WHO. arc DECIDES HOW.
//
// "Is this research's job or mine?" is real judgment and stays with the model (that is what the
// duty file is for). "Is research live, and what do I do if not?" is a lookup, and it lives here.
//
// The work and the worker never merge into one act, though — they COMPOSE. A note is free and
// reversible; staffing spawns a session with its own quota. So the note always posts, and the
// spawn is gated by arc:mode (arc-pretool-hook, which checks liveness so the gate fires ONLY when
// a session would actually be created).
function requestDelegate(session, arg, cwd, opts) {
  const o = opts || {};
  if (!session) return { ok: false, message: 'NOT under the arc wrapper (launch with `arc`).' };
  const m = String(arg || '').trim().match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (!m) {
    return { ok: false, message:
      'usage: arc delegate <role> "<packet>"     get <role> on a job — they may be live, closed, or new\n' +
      '       arc delegate <role>                just put someone in that chair, no job attached\n' +
      '  A live peer is noted (free). A closed one is REVIVED as itself. A role nobody has ever\n' +
      '  held is staffed from your context. You do not have to know which — that is arc\'s job.' };
  }
  const role = m[1].toLowerCase();
  const packet = (m[2] || '').trim();
  if (!N.VALID_ROLE.test(role)) return { ok: false, message: `invalid role "${role}" — letters/digits/dash/underscore, starting with a letter.` };

  const board = R.resolveBoard(N.resolveCwd(session, null));
  const live = R.liveRoles(board).some((l) => l.role === role);

  // CHECK BEFORE YOU SPAWN. A note is posted BY a role — that is what the reply is addressed back
  // to — so a caller holding no role cannot delegate work, only staff an empty chair. Verifying
  // that here rather than at the note is not tidiness: staffing OPENS A TAB, and this ran in the
  // other order once. A roleless session got "claim a role first" as a flat failure while a peer
  // it never heard about was booting in a new window — the refusal was a lie about what happened.
  // Every refusal in this function must be reachable without a session existing because of it.
  if (packet && !N.getRole(session, board)) {
    return { ok: false, message:
      `you hold no role on the "${board.name}" board, so there is no one for "${role}" to reply TO —\n` +
      `a delegation is a question, and the answer has to come back to somebody.\n` +
      `  claim yours first:  arc:role <yours>    then delegate again (nothing was started).` };
  }

  // Not live -> STAFF first, so the work lands in a chair that has someone in it. (The note would
  // survive an empty chair anyway — the cursor is per-role — but "delegate" means someone is on
  // it, not that it is filed.)
  let staffed = null;
  if (!live) {
    staffed = staffRole(session, role, o);
    if (!staffed.ok) return staffed;
  }
  if (!packet) return staffed || { ok: true, message: `"${role}" is already live — nothing to staff. Give it a job:  arc delegate ${role} "<packet>"` };

  // Then the work. Always a request: a delegation is a question you are owed an answer to, and
  // that is what makes it tracked and what wakes you when they reply.
  const note = N.requestNote(session, `${role} --kind request ${packet}`, cwd);
  if (!note.ok) return note;
  return { ok: true, role, revived: staffed && staffed.revived, message:
    (staffed ? staffed.message + '\n' : '') +
    note.message.replace(/\n\s+⚠ NOBODY HOLDS[\s\S]*$/, '') +
    (staffed ? `\n  the note is waiting in ${role}'s inbox — it reads it on arrival.`
             : `\n  ${role} is live: its listener will wake it within seconds.`) };
}

module.exports = { staffRole, requestDelegate, buildLaunch, ensureTrusted, trustKey, hasWt, hasTranscript };
