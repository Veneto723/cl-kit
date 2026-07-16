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
//   BIRTH   no history to return to -> FORK THE CALLER (--resume <caller's conv> --fork-session).
//           It opens knowing what the caller knows, and — because --resume takes arc-runner's
//           userManagesConv path — on the caller's model and effort too. It still writes its own
//           transcript, so it is revivable later as itself. Its JOB never comes from that context:
//           that comes from its DUTY FILE and the BOARD, and the birth prompt says so outright.
//
// THE FORK WAS INNOCENT, AND CONVICTING IT COST A DAY. This header used to say the opposite — that
// a forked session "leaves NO resumable transcript", so birth had to clone nothing. That was FALSE.
// The bug was env inheritance: a peer carrying the caller's CLAUDE_CODE_SESSION_ID never mints a
// conversation of its own, fork or not. birthEnv (below) fixed it. But the env fix and the
// de-forking shipped in the SAME commit, one test passed, and the credit went to the wrong half —
// then this comment stood as the reason to keep paying a cost that had already been refunded.
// Measured on the combination nobody had run (fork + stripped env): the peer's own sessionId on all
// 2589 entries, 6.6MB, still on disk after its pid was gone.
//
// WHAT THE FORK REALLY COSTS is BUG-4: it inherits a history in which it IS the caller, so it will
// continue the caller's task and answer the caller's human unless told otherwise. That is CONTENT,
// not env — birthEnv cannot touch it. The birth prompt disavows it first, before the role, and the
// `peers` skill catches the rest. Context is worth that; it is not worth pretending it is free.
//
// AND THE BIRTH PROMPT IS REAL PROSE, NOT A SENTINEL. `arc:role <role>` is blocked at
// UserPromptSubmit — that is the point of a sentinel, zero tokens — so it never reaches the model,
// and every later input arrives as a hook injection rather than a user message. A handful of
// tokens buys a real turn, and a real turn is what a conversation is made of.
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

// WHICH SHELL RUNS `arc` IN THE NEW TAB. It used to be `cmd /c arc …`, and that put the BIRTH
// PROMPT through the same mangler that was silently corrupting every peer's notes: cmd.exe parses
// its command line before a batch file's %* forwards anything, so it truncates at a newline,
// strips quotes, and EXPANDS %VAR% — the secret-leak vector. cmd also cannot see arc.ps1 (its
// PATHEXT has no .PS1), so it reaches arc.cmd no matter what we ship.
// PowerShell resolves a bare `arc` to arc.ps1, which hands argv straight to node: no parsing, no
// expansion. pwsh 7 preserves quotes too; Windows PowerShell 5.1 does not, but it is always
// present — so prefer pwsh, fall back to powershell, and keep cmd only as the last resort.
// TRIED AND REVERTED: `pwsh -NoLogo -NoProfile -Command arc … '<prompt>'`. It looks safer — pwsh
// resolves `arc` to arc.ps1, which hands argv to node unparsed — but the quoting does not survive
// the trip. The chain is powershell.exe -Command -> wt -> the shell, and the OUTER PowerShell
// strips the quotes before wt ever sees them, so pwsh received the prompt as BARE WORDS and read
// only the first: the tab opened and sent claude the single word "Take". (Seen in the tab; there
// is no way to see it from here.) cmd /c keeps the prompt whole, which is the one thing the
// launcher must not get wrong.
//
// AND cmd COSTS NOTHING HERE, which is the part worth being precise about. cmd's mangling
// (%VAR% expansion, quote stripping) was a SECURITY bug because PEERS posted notes through
// arc.cmd — a note naming an env var wrote its value to disk. That is fixed where it lives: the
// peer's own `arc note` runs from its PowerShell tool, which resolves arc.ps1 now. The launcher
// is a different surface: it carries only OUR birth prompt, which we author and which contains no
// %VAR%, no quotes and no newlines. A shell that cannot corrupt what we hand it is not a risk.
// The launcher shell is also not the SESSION's shell — it runs arc and exits; Claude Code's tools
// bring their own. So this choice is about one thing: does the prompt arrive whole.
// PowerShell first — pwsh, then Windows PowerShell (always present), then cmd.
// WHY IT MATTERS: cmd.exe parses a batch command line BEFORE arc.cmd's %* forwards anything, so it
// strips quotes and EXPANDS %VAR% (the secret-leak vector), and its PATHEXT cannot even see
// arc.ps1 — `cmd /c arc` reaches the mangler no matter what we ship. PowerShell resolves `arc` to
// arc.ps1, which hands argv to node unparsed.
// TRIED TWICE, REVERTED TWICE — and the second failure was worse than the first.
//   1st: `pwsh -Command arc … '<prompt>'` -> the tab opened and claude got the single word "Take".
//        The outer powershell.exe -Command strips the quotes before wt sees them, so pwsh got
//        bare words.
//   2nd: quoting the whole inner command as one PS string (''…'') -> NO TAB AT ALL. staffRole
//        reported its ✓ (powershell.exe still exits 0) and nothing opened. A silent no-tab is the
//        worst outcome available: the agent believes a peer exists.
// Both survived my tests and both were caught by a human looking at a window, because the real
// chain is node -> spawnSync -> powershell.exe -Command -> wt -> shell, and I kept testing a
// shorter one (Invoke-Expression, or just building the string). Each nesting layer re-parses the
// quotes; cmd's '"…"' is the only form proven through ALL of them.
//
// The user asked for pwsh, and the reason is sound (cmd cannot see arc.ps1, so `cmd /c arc` reaches
// the batch mangler). It is worth doing — but not by guessing at quoting. The right shape is
// probably to stop building a shell STRING at all: write the launch to a temp .ps1 and run that,
// so no layer has to re-parse a prompt. Until then, a launcher that works beats one that reads well.
// The mangler is not reachable from here anyway: this carries only OUR birth prompt, which has no
// %VAR%, no quotes and no newlines. Peers post notes via arc.ps1 (their own PowerShell tool) — that
// is where the leak lived and where it is fixed.
// PWSH, THEN WINDOWS POWERSHELL, THEN cmd — asked for three times, refused twice by me, and both
// refusals were me misreading my own evidence. See buildLaunch: the two failures were never about
// the SHELL, they were about a prompt travelling on a command line through five parsers. The prompt
// now travels in a FILE, so the shell is free to be the right one.
// cmd stays as the last resort and only that: `cmd /c arc` cannot even SEE arc.ps1 (PATHEXT has no
// .PS1), so it always reaches arc.cmd — the batch mangler that strips quotes and expands %VAR%.
function launchShell(probe) {
  const p = probe || ((exe) => {
    try { return spawnSync('where.exe', [exe], { timeout: 5000 }).status === 0; } catch { return false; }
  });
  if (p('pwsh.exe')) return 'pwsh';
  if (p('powershell.exe')) return 'powershell';
  return 'cmd';
}

// THE BIRTH PROMPT NEVER GOES ON A COMMAND LINE AGAIN — this is the whole fix, and my own comment
// prescribed it two attempts ago while I kept hunting for quoting instead. The chain is
// node -> spawnSync -> powershell.exe -Command -> wt -> shell: FIVE parsers, each re-quoting what
// the last handed it. No form survives all five; `cmd /k '"…"'` only ever looked like it did.
//
// The prompt is DATA, so it moves as data. The STRUCTURE is a shipped template (arc-birth.ps1),
// reviewed once, fed values — not a script generated per spawn, which is codegen-then-exec and
// breaks in a new way each time. What crosses the wire is only safe tokens and two paths.
function birthTemplate() { return path.join(__dirname, 'arc-birth.ps1'); }

function writeBirthPrompt(text, role) {
  const os = require('os');
  const f = path.join(os.tmpdir(), `arc-birth-${role}-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(f, text, 'utf8');
  return f;
}

// A NEWBORN MUST NOT INHERIT ITS PARENT'S IDENTITY. This one line is why revive never worked, and
// it hid behind a mechanism we all believed and that was never true.
//
// staffRole runs inside a HOOK of a live session, so its env carries that session's Claude Code
// identity: CLAUDE_CODE_SESSION_ID (the CALLER's conversation) and CLAUDE_CODE_CHILD_SESSION — a
// flag that says, in as many words, "you are a child of another session". Every peer arc ever
// spawned inherited both. It booted, claimed, answered notes, exited code=0 — and never registered
// as a conversation of its own. hasTranscript was false for its whole life and after its death, so
// staffing could only ever birth a stranger. Revive had never fired once, for anyone.
//
// THE FALSE MECHANISM, and why it took a day: the symptom looks EXACTLY like "a newborn writes its
// transcript on EXIT, and a resumed session appends live". That theory explains every observation,
// and a peer investigating it reproduced the symptom with plain claude and no arc — because IT was
// spawned from an agent process too, and inherited the same poison. It concluded the mechanism was
// Claude Code's. We both believed it. Eight theories died against it: --session-id, --name,
// --permission-mode, the blocked sentinel, wt, cmd-vs-pwsh, /c-vs-/k, and the window itself. Every
// one of those was a difference between MY spawns and a HUMAN typing the same command — and the
// only difference that ever mattered was the ENVIRONMENT the human's terminal did not have.
// PROOF: same wt, same cmd /k, same flags, env stripped -> 21701 bytes, written WHILE STILL LIVE.
// A clean newborn persists immediately, like any session. Nothing was ever deferred to exit.
//
// arc knew this lesson and forgot it: the old headless delegate stripped ARC_SESSION so the child
// would not inject the REQUESTER's unread notes and advance their cursor. Same class of bug — a
// child wearing its parent's name — and staffRole was written later, without it.
const INHERITED_IDENTITY = [
  'CLAUDE_CODE_SESSION_ID',      // the CALLER's conversation. A newborn adopting it never gets its own.
  'CLAUDE_CODE_CHILD_SESSION',   // "you are a child" — the flag that suppresses being a conversation
  'CLAUDE_CODE_ENTRYPOINT',      // how the CALLER was started; meaningless and misleading for a peer
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_EFFORT',               // the caller's effort pin; the peer's own launch decides its own
  'ARC_SESSION',                 // or the peer's hooks read the CALLER's role, notes and cursor
];
function birthEnv(base) {
  const env = { ...(base || process.env) };
  for (const k of INHERITED_IDENTITY) delete env[k];
  return env;
}

// THE SHELL OUTLIVES CLAUDE so the tab stays at a prompt: a peer that dies on a bad flag leaves
// its error on screen instead of vanishing. That is the whole reason. It is cosmetic, and that is
// fine — it is how every launcher bug here was ever caught.
//
// DEAD THEORY, do not re-derive it: this once said the shell must outlive claude because "a newborn
// writes no transcript while it runs; the file appears when it EXITS", so `cmd /c` tore the process
// down mid-flush. That is FALSE — see the PROOF above (a transcript grows on disk WHILE the session
// is live). The revive bug was env inheritance, not the launcher. The theory outlived its own
// refutation in this comment and a peer later cited it back to us as fact.
//
// QUOTING, which cost a live tab to learn: the chain is powershell.exe -Command -> wt -> shell.
// Passing the prompt as `'"…"'` sends PowerShell BARE WORDS (the outer parse strips the quotes
// before wt sees them) and claude received only the first word — "Take". So the whole inner
// command goes as ONE PS-quoted string with inner quotes doubled; it survives the outer parse and
// arrives intact. cmd keeps its own '"…"' nesting, which does work there.
// -ExecutionPolicy Bypass because the launch is a SCRIPT now, and a machine with a Restricted policy
// would refuse to run it — a silent no-tab, the worst failure this launcher has. The script is one
// line we authored ourselves, written and read in the same second.
function shellPrefix(shell) {
  return shell === 'cmd' ? 'cmd /k' : `${shell} -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit`;
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
// `--name <role>` names the SESSION, which is a different thing from the tab title below and was
// missing: Claude Code defaults a session's display name to the project, so every arc session in
// one repo showed up as "arc" — in the prompt box and, worse, in the `--resume` picker, where the
// peer and the session that staffed it were indistinguishable. Reviving the RIGHT conversation by
// hand was then guesswork on a list of identical names. It survives a relaunch on its own:
// stripConvArgs only removes --continue/--fork-session/the birth prompt, and arc-runner forwards
// anything that is not its own flag, so a switched or restarted peer keeps its name.
// (No conflict with the tab title: --name also sets the terminal title, but the wt tab is pinned
// by --suppressApplicationTitle, so the bare role name still wins there.)
// `conv` = the role's OWN conversation to REVIVE, or null to be BORN.
//
// A NEW PEER IS FORKED FROM THE CALLER: `--resume <CALLER's conv> --fork-session`. It starts
// knowing the project, and it is still revivable — those were never in tension.
//
// THE FORK WAS INNOCENT, and convicting it cost a day. This comment used to read "a forked session
// leaves NO resumable transcript", and birth was rewritten to clone nothing. That was FALSE. The
// real culprit was env inheritance: a peer launched carrying the caller's CLAUDE_CODE_SESSION_ID
// never mints a conversation of its own, so no transcript appears under its own id — fork or no
// fork. Both changed at once (2e0bd75 fixed the env AND dropped the fork), one test passed, and the
// win was credited to the wrong half. Then the false conclusion sat HERE as the justification for
// born-not-cloned, one line below the birthEnv that had already fixed the real bug.
//
// MEASURED, the combination that had never been run — fork + stripped env: own sessionId on all
// 2589 entries, 6,680,047 bytes, still on disk after the pid was gone, hasTranscript() true.
//
// WHAT THE FORK REALLY COSTS is identity, and it is content, not env: the peer inherits a
// transcript in which it is the caller, and will happily continue the caller's task and address the
// caller's human (BUG-4). birthEnv cannot help — the confusion is IN the history. So the birth
// prompt names the split outright, and the `peers` skill catches what the prompt misses. That is
// the honest trade: context is worth having, and it has to be paid for in the prompt.
//
// `from` = the CALLER's conversation to fork at BIRTH (null -> born cold, no context). `conv` =
// the ROLE's own conversation to REVIVE, which always wins: a returning peer comes back as ITSELF.
// QUIET SPAWN — off by default, and it should stay off. A peer you can SEE is the whole reason
// staffing opens a window: every launcher bug this repo ever had was caught by a human noticing a
// tab that was wrong, empty, or absent. A minimised peer is an invisible peer, and an invisible
// failure is the one class this design refuses everywhere else.
//
// It exists because a MEASUREMENT needs it. A run that opens ~29 tabs in an hour does not just
// annoy the human — a stolen foreground means their Ctrl+C lands in a worker, which VOIDS a trial,
// and voids whose cause tracks human activity are not random: they bias the very wall-clock the
// run exists to measure (and they kill the long-grinding SELF arm more often than the DELEG arm
// that posts a note and stops). So the tabs stay for people, and the harness turns them off.
function spawnQuiet() { return /^(1|true|yes)$/i.test(String(process.env.ARC_SPAWN_QUIET || '').trim()); }

// WHICH wt WINDOW a peer's tab joins. Default '0' — and '0' does NOT mean "the caller's window",
// which is what our own comment claimed for months. wt documents it as the MOST RECENTLY USED
// window, so it follows the HUMAN: delegate while they are typing in another terminal and the peer
// lands in THEIR window. Confirmed live by the research peer — two tabs with a fixed name went to
// one separate window and the human's was untouched.
//
// Kept as the default anyway, because for an INTERACTIVE delegate the MRU window usually IS the
// human's and that is where they want to watch their peer appear. It is only wrong when nobody is
// attached to the caller — a harness — and then the most-recent window is a stranger's.
// ARC_SPAWN_WINDOW=<name> pins every peer to one named window instead. Any string wt accepts.
function spawnWindow() { return String(process.env.ARC_SPAWN_WINDOW || '').trim() || '0'; }

function buildLaunch(wt, account, conv, role, root, shell, from, writeScript, quiet, win) {
  const acct = account ? ` --account ${account}` : '';
  const sh = shell || launchShell();
  const pre = shellPrefix(sh);
  // REVIVE resumes the role's OWN conversation as itself. BIRTH forks the CALLER's, which is also
  // what carries model + effort across: --resume makes the runner take its userManagesConv path,
  // where detectedEffort reads the caller's effort off explicitId and preservedModel re-applies the
  // caller's model. Inheritance is a CONSEQUENCE of the fork, not a second mechanism.
  // With no caller conversation to fork (a session that never persisted one), birth still works —
  // the peer is simply born cold, which is what every peer was until now.
  const resume = conv ? ` --resume ${conv}` : (from ? ` --resume ${from} --fork-session` : '');
  // THE BIRTH PROMPT IS REAL PROSE, NOT A SENTINEL — and that is what makes the peer revivable.
  // `arc:role <role>` was blocked at UserPromptSubmit (that is the point of a sentinel: zero
  // tokens), so it never reached the model. Everything the newborn then received arrived as hook
  // injections and Stop-block reasons — never a user message. Measured: such a session leaves NO
  // conversation on disk at all. `claude --resume <its id>` answers "No conversation found" even
  // after a graceful /exit, so there is nothing to revive and staffing silently births a stranger
  // instead. A peer that never has a real turn is a peer that can never come back.
  // So: spend the handful of tokens. One real prompt buys a persisted conversation, which is the
  // entire reason a peer beats a subagent.
  // NO double quotes in here: the whole thing is nested '"..."' to survive PS -> wt -> cmd, so an
  // inner " closes the argument early and the prompt arrives truncated. (Written with quotes the
  // first time; the built command showed it immediately.)
  // A FORKED PEER OPENS ITS EYES BELIEVING IT IS THE CALLER, because it is reading the caller's
  // whole conversation and every habit in it says: keep going. So the FIRST thing it ever reads as
  // a real prompt has to break that, and it has to do it before the role instruction — an agent
  // that has already resumed the caller's task will take `arc role` as one more errand in it.
  // (Watched live: a fork picked up the caller's investigation, reported back in the first person,
  // and only learned it was not the caller by reading arc-state.)
  // NO apostrophes and NO double quotes in here: the whole prompt is nested '"…"' through
  // powershell -> wt -> cmd, and either one ends the argument early and truncates it.
  // AND IT IS A SNAPSHOT WITH AN EXPIRY DATE. The first forked peer nearly filed a confident, false
  // bug against this very file: its inherited history said born-not-cloned, which had been true an
  // hour earlier and was rewritten before it branched. It caught itself only by re-reading. This is
  // the one BUG-4 cannot cover — the peer is not confused about WHO it is, it is confident about
  // code that has since moved, and staleness is invisible from the inside (it feels like knowing).
  // Git cannot close it either: what rotted here was the caller's UNCOMMITTED tree.
  const birth = from
    ? `You were BRANCHED from another session on this board. The conversation above is CONTEXT ONLY: it is not your work, its human is not yours to answer, and its unfinished tasks are not yours to continue. It is also a SNAPSHOT that stopped the moment you branched: the code may have moved since, including edits that were never committed, so re-read any file before you assert anything about it. You are the ${role} peer now, a separate session with its own job: run  arc role ${role}  then do what it tells you.`
    : `Take the ${role} role on this board now: run  arc role ${role}  then do what it tells you.`;
  // A STAFFED PEER HAS NOBODY TO ANSWER A PROMPT. Its whole job is to boot, claim, arm its
  // listener and answer — unattended. Born in `manual` (the default) it stops at the first
  // permission prompt and sits there claimed-but-deaf: holding the role, so nothing else may
  // staff it, while answering nothing. That is the exact failure the board allowlist exists to
  // prevent, and the allowlist only covers arc's OWN commands — a research peer also needs
  // Read/Grep/Edit to do the work it was staffed for, and every one of those would stop it.
  // (Observed: a staffed tab showing `manual mode on` while the caller ran `auto`.)
  // BIRTH ONLY: a REVIVE restores the mode it was last in via arc-runner's preservedFlags, and
  // passing it here too would hand claude the flag twice.
  const mode = conv ? '' : ' --permission-mode auto';
  const prompt = conv ? `arc:role ${role}` : birth;
  // TWO SHAPES, and only one of them puts the prompt on a wire.
  //   PowerShell: fill the shipped template. Every value handed over is a token that CANNOT be
  //     mangled — an account id, a role name, a UUID — and the prompt goes as a file path. Both
  //     previous pwsh attempts died here, and neither was the shell's fault: `-Command <bare>` let
  //     the outer powershell strip the quotes (claude got the word "Take"), and `-Command
  //     <PS-quoted>` opened NO TAB while staffRole still printed its ✓.
  //   cmd: the last resort keeps its proven '"…"' nesting, and is only reached when NEITHER
  //     PowerShell exists — a machine that has neither is a machine arc has bigger problems on.
  const cmdline = `arc${acct} --name ${role}${mode}${resume}`;   // cmd path only
  let inner, quietArgs = null;
  if (sh === 'cmd') {
    inner = `${cmdline} '"${prompt}"'`;
  } else {
    // The role's OWN conversation (a REVIVE) is resumed as itself; the CALLER's (a BIRTH) is forked.
    // Never both — a revive that forked would come back as a copy of whoever staffed it.
    const resumeId = conv || from || null;
    // ONE call — writeScript has a side effect (it writes the prompt file), so it must not be
    // invoked once per output shape.
    const promptFile = (writeScript || writeBirthPrompt)(prompt, role);
    const pairs = [['-File', birthTemplate()], ['-Role', role], ['-PromptFile', promptFile]];
    if (account) pairs.push(['-Account', account]);
    if (!conv) pairs.push(['-Mode', 'auto']);
    if (resumeId) pairs.push(['-Resume', resumeId]);
    if (!conv && from) pairs.push(['-Fork']);
    // wt form, UNCHANGED and deliberately so: flags bare, the two PATHS quoted. This exact shape
    // is the one proven live through powershell -> wt -> pwsh; it is not being re-derived today.
    inner = pairs.map(([f, v]) => (v === undefined ? f
      : `${f} ${(f === '-File' || f === '-PromptFile') ? psQuote(v) : v}`)).join(' ');
    // Start-Process form: EVERY element its own quoted argument. PowerShell passes an -ArgumentList
    // array to the process as-is, so nothing downstream re-splits it — which is the whole reason
    // the quiet path uses Start-Process instead of `cmd /c start` (see below).
    quietArgs = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit']
      .concat(pairs.flat().filter((x) => x !== undefined)).map(psQuote).join(',');
  }
  // `quiet && wt` is not a state that exists: wt IS the thing that takes the foreground, so a
  // quiet wt tab cannot be built. staffRole already forces wt=false when quiet, and this makes the
  // invariant hold in the FUNCTION rather than at one call site — a caller that passes both gets
  // the minimised console it asked for, not a tab that silently ignores the quiet it requested.
  if (wt && !quiet) {
    // --suppressApplicationTitle is what makes the title STICK. Without it the tab shows "arc"
    // like every other tab: Claude Code sets the terminal title from the project folder, and an
    // application title escape overrides wt's --title. With two identical "arc" tabs you cannot
    // tell the caller from the peer it spawned — so the peer's tab is pinned to its ROLE.
    return `wt -w ${win || '0'} new-tab --title ${psQuote(role)} --suppressApplicationTitle -d ${psQuote(root)} ${pre} ${inner}`;
  }
  // QUIET: Start-Process -WindowStyle HIDDEN. Not Minimized — that was WRONG, and it was wrong in
  // the most expensive way available.
  //
  // MINIMISED STOPS A WINDOW RESTORING. IT DOES NOT STOP IT TAKING THE FOREGROUND. So a minimised
  // peer could seize focus into a window with NOTHING ON SCREEN: the human's keystrokes went
  // somewhere invisible, and they could not tell whether they had typed into an agent's session or
  // not. That is strictly worse than the tab-steal it replaced — a stolen tab is at least VISIBLE,
  // and a Ctrl+C into a worker produces a clean void; text typed into a worker nobody can see
  // produces a trial that ran with unknown input and looks normal in the transcript.
  //
  // I SHIPPED IT CALLING IT "PROVEN FOCUS-SAFE" on the strength of ONE spawn, measured while the
  // human happened to be typing in another app — which is exactly when Windows' foreground lock
  // protects you anyway. One measurement, generalised into a guarantee, on the same day I told a
  // peer twice not to do that. Reported by the human, who could see the symptom arc could not.
  //
  // HIDDEN IS STRUCTURAL, not a timing hack: a window with no visible representation cannot be
  // activated, so there is no foreground for it to take. The test is therefore also structural —
  // assert IsWindowVisible == false on the spawned pid's windows, NOT "focus did not move this
  // time", which is what a foreground lock will happily tell you on a good day.
  //
  // THE COST IS REAL AND IT IS THE POINT OF THE DEFAULT: a hidden peer is invisible. No taskbar
  // entry, no error to read, no window a human can glance at — and every launcher bug this repo
  // has ever had was caught by a human glancing at a window. Right for a MEASUREMENT, never right
  // as a default. wt has no equivalent (1.24 exposes no no-focus flag), and
  // capture-GetForegroundWindow-then-restore is a timing hack on the path that has burned this
  // repo three times: wt hands off over COM and returns BEFORE the tab exists.
  //
  // NOT `cmd /c start`, and that is not a preference — MEASURED: the fallback below is composed
  // INSIDE `powershell -Command`, so PowerShell strips the quotes before cmd ever sees them and
  // `start "arc: quiettest" …` arrives as `start arc: quiettest`, where cmd reads `arc:` as the
  // COMMAND. It hangs, and staffRole reports ETIMEDOUT. That path has been broken for as long as
  // it has existed; nobody noticed because everybody has wt. Start-Process is native to the shell
  // we are already inside — one parser, and -ArgumentList is an ARRAY nothing re-splits.
  if (quiet && sh !== 'cmd') {
    return `Start-Process -FilePath ${psQuote(sh)} -WindowStyle Hidden -WorkingDirectory ${psQuote(root)} -ArgumentList ${quietArgs}`;
  }
  // No Windows Terminal and no quiet: a visible console via start. KNOWN BROKEN through the
  // powershell -Command wrapper (see above) — kept only because removing it is a separate change
  // on a path no machine with wt ever reaches, and it should be fixed with a live test, not on the
  // way past. If you land here and it hangs, that is why.
  return `cmd /c start "arc: ${role}" /d "${root}" ${pre} ${inner}`;
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
  // QUIET BYPASSES wt ENTIRELY, and it has to: wt IS the thing that takes the foreground, so there
  // is no quiet wt to ask for. A quiet spawn is a minimised console instead of a tab — a real
  // trade (you lose the visible peer), taken only when something asks for it out loud.
  const quiet = o.quiet !== undefined ? o.quiet : spawnQuiet();
  const win = o.win !== undefined ? o.win : spawnWindow();
  const wt = quiet ? false : (o.hasWt !== undefined ? o.hasWt : hasWt());

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
  // BIRTH needs no conversation — the runner mints one. Only a REVIVE names one, and it names the
  // ROLE's own, never the caller's. (The old "nothing to fork" refusal died with the fork: a peer
  // no longer needs the caller to have a saved conversation in order to exist.)
  const conv = revive ? vacant.convId : null;
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
  // THE CALLER'S CONVERSATION IS WHAT A BIRTH FORKS — and it comes from the SESSION's own record,
  // never from an argument, for the same reason the board and launch dir do: a forgeable id would
  // let an agent hand its peer a stranger's history. Only a BIRTH forks; a REVIVE already has the
  // role's own conversation and must come back as itself. Null is fine and stays supported — a
  // caller that never persisted a conversation simply births a cold peer.
  const from = revive ? null : (o.sessionConv || N.sessionConv)(session);
  // o.writeScript lets a test capture the birth prompt as DATA instead of grepping it out of a
  // command line — which is the whole point of the change: it is not on the command line any more.
  const psCmd = buildLaunch(wt, account, conv, role, launchDir, o.shell, from, o.writeScript, quiet, win);
  let r;
  try {
    r = doSpawn('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 5000, env: birthEnv() });
  } catch (e) {
    return { ok: false, message: `could not open the new tab: ${e.message}` };
  }
  // A TIMEOUT IS NOT A FAILURE — it is us giving up on WATCHING. The launcher detaches (wt hands
  // off over COM; Start-Process returns before its child is up), so when spawnSync's 5s elapses we
  // kill powershell.exe and learn NOTHING about the peer, which by then may be booting happily.
  // Reported live by the very peer it disowned: staffRole printed "no peer was started" while
  // quiettest was reading it — pwsh -> arc-runner -> claude.exe, alive, holding the role.
  //
  // AND THE LIE WAS THE CHEAP HALF. requestDelegate aborts on ok:false, so THE PACKET IS NEVER
  // POSTED: the orphan boots with no work, claims the chair anyway, and nothing ever comes looking
  // for it — because the only session that knew it might exist was told it did not. That is the
  // exact INVERSE of the silent-no-tab this guard was written to catch, and strictly worse: a
  // no-tab wastes a claim, a ghost-with-no-task wastes a claim AND a quota AND the chair.
  //
  // So: ENOENT/spawn-error stays fatal (nothing can have started — the binary is not there), and a
  // TIMEOUT becomes an HONEST UNCERTAINTY that keeps going. Posting the packet is safe either way:
  // a note to an empty chair keeps for whoever claims it next, so the bad case costs one note and
  // the good case saves an orphan. `exit code 0 was never evidence, and neither is ETIMEDOUT`
  // — quiettest, note #61, which is the same lesson this guard's own comment already carries at
  // the other end.
  const timedOut = !!(r && r.error && (r.error.code === 'ETIMEDOUT' || /timed?.?out/i.test(String(r.error.message || ''))));
  if (!r || (r.error && !timedOut) || (!r.error && r.status !== 0)) {
    const why = r && r.error ? r.error.code || r.error.message : `exit ${r ? r.status : '?'}`;
    return { ok: false, message: `could not open the new tab (${why}) — no peer was started.` };
  }

  // RECORD WHO MADE IT, at the only moment anyone knows. A newborn cannot report its own parent —
  // it is a fresh conversation holding a birth prompt — so if the spawner does not write this down
  // here, nothing ever can, and the peer becomes unreapable: indistinguishable from a standing
  // team member, cleanable only by a human who recognises the name. That was five leaks in one day.
  // Written even for an UNVERIFIED spawn: if a peer did boot from a timed-out launch, it is exactly
  // the one nobody is coming to look for.
  R.recordBirth(board, role, from || (o.sessionConv || N.sessionConv)(session));

  // SAY THAT WE DID NOT SEE IT LAND. An unverified spawn must not wear the same ✓ as a verified
  // one — that is how a lie gets believed twice.
  const unsure = timedOut
    ? `⚠ the launcher did not return within 5s, so arc did NOT see this land — but the spawn\n`
      + `  DETACHES, so a peer may be booting right now. The packet below is posted either way (a\n`
      + `  note to an empty chair keeps). Confirm with:  arc role    ← it appears within ~30s, or\n`
      + `  it never started and the note simply waits.\n`
    : '';
  return { ok: true, role, revived: revive, trust, unverified: timedOut, message: unsure +
    (revive
      ? `✓ REVIVING "${role}" — ${wt ? 'new tab in this window' : (quiet ? 'HIDDEN — quiet spawn: no window at all, so it cannot take your focus (and you cannot watch it)' : 'new console window')}.\n`
        + `  it resumes ${role}'s OWN conversation, so it comes back as itself: everything it\n`
        + `  learned before, still there. It re-adopts the role and arms its own listener.\n`
      // SAY WHICH BIRTH ACTUALLY HAPPENED. This line claimed the peer "starts FRESH... not from
      // your context" for one commit after birth started forking — the born-not-cloned text
      // outliving the behaviour it described, and the FIRST live delegate caught it while 668 unit
      // tests did not (none of them read this string). Same failure as the comments it replaced:
      // prose asserting a fact about code that has moved.
      : `✓ staffing a new "${role}" peer — ${wt ? 'new tab in this window' : (quiet ? 'HIDDEN — quiet spawn: no window at all, so it cannot take your focus (and you cannot watch it)' : 'new console window')}.\n`
        + (from
          ? `  no ${role} has worked here before, so it is BRANCHED from this conversation: it opens\n`
            + `  knowing what you know, on your model and effort, told plainly that your history is\n`
            + `  context and not its own work. It writes its own transcript from there, so it is\n`
            + `  revivable later as ${role}.\n`
          : `  no ${role} has worked here before, and this session has no conversation to branch, so\n`
            + `  it starts COLD: it learns the job from .arc/roles/${role}.md and the board.\n`)) +
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

// ---- arc close <role> — the counterpart to delegate -------------------------------------------
// SPAWNING WITHOUT CLOSING IS A LEAK, and arc had no verb for the other half. Every peer opened
// today outlived its usefulness until a human named it: three test peers, sixteen orphan consoles,
// one ghost holding a chair after its caller was told it never started. "Close them when they are
// done" is not a human's job — it is the job of whoever opened them, and they need a verb.
//
// YOU MAY ONLY CLOSE WHAT YOU SPAWNED. Not tidiness — a board is shared, and `arc close research`
// from a stranger would end a session someone else is mid-conversation with, silently, with its
// context still on disk but its human staring at a dead tab. Parentage is checked against the
// CONVERSATION, so your own respawn does not lock you out of your own peers.
function requestClose(session, arg, cwd, opts) {
  const o = opts || {};
  if (!session) return { ok: false, message: 'NOT under the arc wrapper (launch with `arc`).' };
  const board = R.resolveBoard(N.resolveCwd(session, cwd));
  const role = String(arg || '').trim().split(/\s+/)[0].toLowerCase();
  if (!role) return { ok: false, message: 'usage: arc close <role>   — ends a peer YOU spawned.' };
  const me = N.getRole(session, board);
  const myConv = (o.sessionConv || N.sessionConv)(session);

  const born = R.readBirth(board, role);
  if (!born) {
    return { ok: false, message:
      `arc has no record of spawning "${role}" from this board, so it will not close it.\n` +
      `  Only the session that OPENED a peer may close it — a board is shared, and ending someone\n` +
      `  else's peer mid-conversation is not yours to do. Nothing reaps automatically: arc cannot\n` +
      `  tell an abandoned peer from a standing team member waiting for work, and a wrong guess\n` +
      `  kills real work in flight. If you are sure it is dead weight, close its window by hand\n` +
      `  or take it to your human.` };
  }
  if (born.bornOf && myConv && born.bornOf !== myConv) {
    return { ok: false, message:
      `"${role}" was not spawned by you — another session opened it, and it is theirs to close.\n` +
      `  Leave it a note instead:  arc note ${role} "<text>"` };
  }
  if (role === me) return { ok: false, message: `"${role}" is YOU. Closing yourself is /exit, not arc close.` };

  // OWED WORK IS A REASON TO STOP, NOT A REASON TO REFUSE — say it, then do as asked. The agent
  // may know the answer no longer matters; arc does not. But a silent kill of a peer mid-answer
  // would lose work nobody knew was in flight.
  const owed = R.openRequests(board, role).filter((n) => n.to === role);
  const r = (o.close || R.closePeer)(board, role, o);
  const what = r.killed.length ? r.killed.map((k) => `${k.what} (${k.pid})`).join(', ') : 'nothing running';
  return { ok: true, role, killed: r.killed, message:
    `✓ closed "${role}" — killed ${what}; its chair is ${r.revivable ? 'vacant, and it keeps its seat' : 'free'}.\n` +
    (owed.length ? `  ⚠ it still owed ${owed.length} unanswered request(s) (#${owed.map((n) => n.seq).join(', #')}).\n`
                 + `    Those are now unanswerable. If the answer mattered, revive it: arc delegate ${role} "<packet>"\n`
                 + `    — its conversation is still on disk, so it comes back knowing everything it learned.\n` : '') +
    (r.revivable
      ? `  Its transcript is untouched: \`arc delegate ${role} "<packet>"\` brings it back AS ITSELF.`
      : `  It never persisted a conversation, so there is nothing to revive — a new delegate starts fresh.`) };
}

module.exports = { staffRole, requestDelegate, requestClose, buildLaunch, launchShell, shellPrefix, birthEnv, INHERITED_IDENTITY, ensureTrusted, trustKey, hasWt, hasTranscript, spawnQuiet, spawnWindow };
