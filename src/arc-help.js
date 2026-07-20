#!/usr/bin/env node
// arc-help: builds the arc command cheat sheet. Rendered by `/arc-help` (via
// arc-switch-hook — caught before
// any model turn, so it's ZERO tokens. Exported as renderHelp(); also runnable
// directly for debugging.
'use strict';

const C = require('./arc-config');

function renderHelp() {
  let accounts = [];
  try { accounts = C.loadConfig().accounts.map((a) => a.id); } catch {}
  const example = accounts[1] || accounts[0] || 'mate';

  return `arc — commands
=============
  /arc-help  this cheat sheet — ZERO tokens

Switch account (keeps your conversation, preserves model/effort/mode):
  /arc-switch             open the interactive picker — ZERO tokens
  /arc-switch ${example.padEnd(12)}switch straight to an account (by name or number)

Add / manage accounts:
  /arc-add-account                  open the WIZARD — it asks WHICH PROVIDER first:
                                     Claude (Anthropic)  → Subscription, or Gateway
                                     Codex / GPT         → run a GPT model INSIDE Claude Code. You give
                                                           a gateway that serves GPT on the OpenAI API;
                                                           arc runs a LOCAL translator for you (auto-
                                                           started on switch) so Claude Code's own
                                                           harness drives the GPT model. /arc-switch to it.
  /arc-add-account <id>             add a SUBSCRIPTION via guided browser login (in-session);
                                   the login is saved to the account's OWN private profile
                                   (~/.claude/arc-profiles/<id>) — accounts never share a login
  /arc-add-account <id> --api --url <gateway> [--label L --color #hex --default]
                                   add a GATEWAY (like mate): verifies it, auto-detects
                                   models, DPAPI-encrypts the key (from clipboard, or --file/--key)
                                   advanced: --header Key:Value (repeat) · --model opus=<name> (pin,
                                   repeat) · --env KEY=VALUE (repeat; harness tweaks this gateway
                                   needs) · --no-verify (skip /v1/models probe — REQUIRED for a proxy
                                   serving a non-Claude model, since the probe would reject it)
  /arc-rename [<old>] <new>         rename an account (its login + chats are kept);
                                   one arg renames THIS session's account (relaunches)
  /arc-remove-account <id>          remove an account — asks, then 'confirm'
  arc set-key <id>                  re-encrypt an api account's key (clipboard/--file/--stdin), DPAPI

Move chats between PCs (discrete export/import — no realtime sync):
  /arc-export             archive the CURRENT conversation → ~/arc-export-<ts>.tgz
  /arc-export all         archive every session in THIS project folder
  /arc-export global      archive every session on this machine (everything)
  /arc-export <project|id> archive one project's sessions, or one conversation
  /arc-import <archive>   merge sessions in (newer-wins; live chats protected)
  /arc-import <archive> <dest>  re-root them under <dest> so they resume at a LOCAL path
                         (e.g. home's E:\\whaletech\\proj → E:\\proj.  --dest <d> is the same)

The board — sticky notes between sessions working in the same folder:
  /arc-role <name>        claim a role in this board (research | coding | …) — survives
                         restart + switch, like your model and effort. The ONE command
                         that costs a turn: a fresh claim hands the agent ONE small turn
                         to run "arc join <name>", so /arc-role research alone makes a
                         live responder. (query/refusal/re-claim still cost zero.)
  /arc-role               who am I, who else is here?
  /arc-note <role> <text> leave a note for a peer  ·  /arc-note all <text> broadcasts
  /arc-note <role> --kind request <text>     ASK — tracked until answered (⧗ shown to you)
  /arc-note <role> --reply-to #N <text>      ANSWER #N (threads it; kind: result)
  /arc-note <role> --supersedes #N <text>    RETRACT #N — every future reader of #N is warned
                         kinds: info · request · result · correction · blocker · decision
                         (blocker + correction are auto-HIGH; plain notes need no flags)
                         (to get a PEER on something, just ask in prose — "get research
                          on this". The agent runs arc delegate, which notes them if
                          they're live, REVIVES them as themselves if they're closed, or
                          opens a new tab if the chair was never filled. You don't pick.)
  /arc-notes              read YOUR unread notes now (they also arrive AUTOMATICALLY
                         at the start of your next turn) — ZERO tokens
  /arc-notes all          the whole board, nothing marked read
                         (a board = the git repo root you started in. The statusline
                          shows "📌 N from research" when notes are waiting.)

  Completing a task POSTS ITSELF. When an agent marks a task done, arc diffs the repo
  against the HEAD sha it recorded when the task was created, and sticks a note on the
  board carrying the commit sha and the changed files. Nobody has to remember to say
  "P-014 is done" — the tick IS the message, and it comes with evidence.
  A commit-backed tick is a <result> and ranks above routine news; an uncommitted one is plain
  <info> and sinks — still delivered (non-code work is real work), just not dressed as proof.
    features.doneGate in arc-config.json (or ARC_DONE_GATE):
      note    default — always posts; an uncommitted "done" posts as info, "(no commit —
              not code-backed)", so it never outranks a tick that proves itself
      strict  REFUSES to mark a task done when no commit backs it (the agent is told why)
      off     no notes, no gate

Agent initiative — how proactive your agent is with arc's tools (note / ask a peer):
  /arc-mode               open the ← / → dial:  passive · balanced · active — ZERO tokens
  /arc-mode balanced      (DEFAULT) note peers on real changes; won't ask/watch unasked
  /arc-mode active        also ASK a peer when stuck, instead of grinding alone
  /arc-mode passive       silent — act only on your order, no self-initiated notes at all
                         (LISTENING is never gated: every stance stays reachable on the board)
                         (shows in the statusline: ○ passive · ◐ balanced · ● active)
                         Only a DEVIATION costs tokens: balanced injects nothing.

See usage:
  /arc-peek               usage of ALL accounts + where a launch would land — ZERO tokens

Session:
  /arc-restart            reload the wrapper + relaunch this conversation — ZERO tokens
  /arc-delete             delete THIS conversation → trash, start fresh (asks; then 'confirm')

Trash (deleted conversations stay recoverable until you empty it):
  /arc-trash              list what's in the trash — ZERO tokens
  /arc-trash restore <id> put one back (then resume it: arc --resume <id>)
  /arc-trash empty        PERMANENTLY purge the trash (asks; then 'confirm')

Why the /arc- commands cost nothing?
  /arc-<verb>  (e.g. /arc-peek, /arc-switch veneto) is eaten RAW by a hook BEFORE
          any model or classifier runs — it costs NO tokens and works even when the
          account is rate-limited. Type /arc in the prompt for the autocomplete menu.

Handing work off — there are exactly two ways, and arc only owns one:
  a SUBAGENT      one-shot, no context needed (research a question, sweep some files).
                  Just ask your agent for one — Claude Code runs it natively, in-session,
                  on your own quota, and it can target another model (even Fable).
                  NOT an arc feature. arc has nothing to add here.
  a PEER          stateful, context worth keeping (an ongoing frontend / android / research
                  thread). A second arc session on the same board:
                    /arc-role                    who's here?
                    /arc-note <role> --kind request <packet>   ask them; keep working
                  They keep their context across turns, so the 3rd ask costs what the 1st
                  did — and arc WAKES you when they reply (it arms "arc await" for you).
  (the old delegate command was removed: it fired a headless one-shot that re-read the repo
   and then died — worse than a subagent, worse than a peer. To run a task on GPT, /arc-switch
   to your codex account. Old muscle memory still gets a pointer, at zero tokens.)

In your terminal (not inside a session):
  arc                     launch
  arc --account <id>      launch on a specific account
  arc add-account <id>    guided browser login to add a subscription (own profile)
  arc capture <id>        adopt the current active login into <id>'s profile
  arc trash [restore <id>|empty]   manage the deleted-conversation trash
  arc update              pull + install the latest release (arc also offers at launch)
  arc doctor              health check    ·    arc setup    reconfigure

Board from a terminal (also how an AGENT posts — the /arc- commands live in the
human's input box; anything else runs these shell forms):
  arc role                who's in this repo's board, and what's my role?
  arc note all "<text>"   broadcast a note to every peer
  arc note <role> "<text>" leave a note for one peer
  arc notes               read your unread notes
  arc note <role> --kind request "<packet>"   ASK a peer — tracked until they answer
  arc delegate <role> "<packet>"   THE one verb: get <role> on a job. arc notes them
                         if live, REVIVES them as themselves if closed, or staffs the
                         chair from your context if nobody ever held it. You pick WHO;
                         arc works out HOW. (Staffing opens a tab — gated by /arc-mode.)
  arc join [role]         claim the role (if not yours) AND LISTEN: blocks until a note
                         lands, then EXITS. Run as a BACKGROUND task: that EXIT re-invokes
                         you with the note — an idle session is otherwise unreachable.
                         Never times out. arc asks you to run this at every idle if you
                         hold a role, so being on a board MEANS being reachable.
                         (role or /arc-role DECLARES a role · join LISTENS as it)
  arc claudex [stop]      show (or stop) the auto-managed GPT-in-Claude translator sidecars
  (skill: peers = the whole protocol — WHEN a note is worth leaving, how to ask when
   you're stuck, the note kinds, and what to do when a peer's note wakes you)

Configured accounts: ${accounts.join(', ') || '(none — run \`arc setup\`)'}
`;
}

module.exports = renderHelp;
// Direct run (debugging): print to stdout.
if (require.main === module) process.stdout.write(renderHelp());
