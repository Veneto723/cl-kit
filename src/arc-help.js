#!/usr/bin/env node
// arc-help: builds the arc command cheat sheet. Rendered by the `arc:help` (alias
// `arc:arc`) sentinel via arc-switch-hook — caught before any model turn, so it's
// ZERO tokens. Exported as renderHelp(); also runnable directly for debugging.
'use strict';

const C = require('./arc-config');

function renderCodexHelp() {
  return `arc — Codex commands
===================
Inside this Codex session (caught by a hook before the model runs):
  arc:help                this cheat sheet — ZERO tokens
  arc:role <name>         claim a role in this repo's shared fridge
  arc:role                show your role and active roommates
  arc:note <role> <text>  leave a note · arc:note all <text> broadcasts
  arc:notes               read your unread notes now — ZERO tokens
  arc:notes all           show the whole fridge without marking it read

In a terminal:
  arc codex [args]                    launch Codex (native args pass through)
  arc codex --account <id> [args]     launch with an isolated CODEX_HOME
  arc codex accounts                  show aliases, native login status, and homes
  arc codex add-account <id>          create an isolated home and run codex login
  arc codex login [id]                refresh a native Codex login
  arc codex remove-account <id>       remove only the alias; its home stays intact
  arc sessions                        list logical sessions and native bindings

Runtime handoff:
  Claude → Codex is available from an arc-managed Claude prompt with
  arc:handoff codex [--account <id>] [--keep-last N].
  Codex → Claude and arc:delegate are not implemented yet.
`;
}

function renderHelp(runtime = process.env.ARC_RUNTIME || 'claude') {
  if (String(runtime).toLowerCase() === 'codex') return renderCodexHelp();
  let accounts = [];
  try { accounts = C.loadConfig().accounts.map((a) => a.id); } catch {}
  const example = accounts[1] || accounts[0] || 'pool';

  return `arc — commands
=============
  arc:help   this cheat sheet — ZERO tokens   (alias: arc:arc)

Switch account (keeps your conversation, preserves model/effort/mode):
  arc:switch              open the interactive picker — ZERO tokens
  arc:switch ${example.padEnd(12)} switch straight to an account (by name or number)

Add / manage accounts:
  arc:add-account                   open the WIZARD — pick Subscription or Gateway, then guided prompts
  arc:add-account <id>              add a SUBSCRIPTION via guided browser login (in-session);
                                   the login is saved to the account's OWN private profile
                                   (~/.claude/arc-profiles/<id>) — accounts never share a login
  arc:add-account <id> --api --url <gateway> [--label L --color #hex --default]
                                   add a GATEWAY/POOL (like mate): verifies it, auto-detects
                                   models, DPAPI-encrypts the key (from clipboard, or --file/--key)
                                   advanced: --header Key:Value (repeat) · --model opus=<name> (pin,
                                   repeat) · --no-verify (skip /v1/models probe for odd gateways)
  arc:rename [<old>] <new>          rename an account (its login + chats are kept);
                                   one arg renames THIS session's account (relaunches)
  arc:remove-account <id>           remove an account (alias arc:delete-account) — asks, then 'confirm'
  arc set-key <id>                  re-encrypt an api account's key (clipboard/--file/--stdin), DPAPI

Move chats between PCs (discrete export/import — no realtime sync):
  arc:export              archive the CURRENT conversation → ~/arc-export-<ts>.tgz
  arc:export all          archive every session in THIS project folder
  arc:export global       archive every session on this machine (everything)
  arc:export <project|id> archive one project's sessions, or one conversation
  arc:import <archive>    merge sessions in (newer-wins; live chats protected)
  arc:import <archive> <dest>   re-root them under <dest> so they resume at a LOCAL path
                         (e.g. home's E:\whaletech\proj → E:\proj.  --dest <d> is the same)

The fridge — sticky notes between sessions working in the same folder:
  arc:role <name>         claim a role in this room (research | coding | …) — survives
                         restart + switch, like your model and effort
  arc:role                who am I, who else is here?
  arc:note <role> <text>  leave a note for a roommate  ·  arc:note all <text> broadcasts
  arc:notes               read YOUR unread notes now (they also arrive AUTOMATICALLY
                         at the start of your next turn) — ZERO tokens
  arc:notes all           the whole fridge, nothing marked read
                         (a room = the git repo root you started in. The statusline
                          shows "📌 N from research" when notes are waiting.)

  arc:anchors             which doc claims about the code have gone STALE — ZERO tokens
  arc:anchors reseal      after fixing the docs: the current code becomes the baseline
                         (put <!-- arc:anchor src/auth.ts#handleLogin --> next to a claim
                          in a doc. When a commit rewrites that symbol, a [!] note lands
                          on the fridge and the other session sees it on its next turn.)

  Completing a task POSTS ITSELF. When an agent marks a task done, arc diffs the repo
  against the HEAD sha it recorded when the task was created, and sticks a note on the
  fridge carrying the commit sha and the changed files. Nobody has to remember to say
  "P-014 is done" — the tick IS the message, and it comes with evidence.
    features.doneGate in arc-config.json (or ARC_DONE_GATE):
      note    default — always posts; an uncommitted "done" is posted, flagged UNVERIFIED
      strict  REFUSES to mark a task done when no commit backs it (the agent is told why)
      off     no notes, no gate

See usage:
  arc:peek                usage of ALL accounts + where a launch would land — ZERO tokens

Session:
  arc:restart             reload the wrapper + relaunch this conversation — ZERO tokens
  arc:delete              delete THIS conversation → trash, start fresh (asks; then 'confirm')

Trash (deleted conversations stay recoverable until you empty it):
  arc:trash               list what's in the trash — ZERO tokens
  arc:trash restore <id>  put one back (then resume it: arc --resume <id>)
  arc:restore <id>        same, shorthand
  arc:trash empty         PERMANENTLY purge the trash (asks; then 'confirm')

Why the arc: forms?
  arc:...  are plain messages caught by a hook BEFORE the model runs — they cost
          NO tokens and work even when the account is rate-limited (a slash command
          can't, because its bash needs a safety classifier that runs on the same
          exhausted account). That's why everything here is an arc: sentinel — there
          are no arc slash commands anymore.

Take this conversation into Codex (same terminal, same logical arc session):
  arc:handoff codex               transpile THIS Claude conversation, then continue
                                  it in Codex using Codex's native resume path
  arc:handoff codex --account <id> choose an isolated Codex account / CODEX_HOME
  arc:handoff codex --keep-last N cap a huge session to its last N messages

In your terminal (not inside a session):
  arc                     launch
  arc --account <id>      launch on a specific account
  arc add-account <id>    guided browser login to add a subscription (own profile)
  arc capture <id>        adopt the current active login into <id>'s profile
  arc trash [restore <id>|empty]   manage the deleted-conversation trash
  arc codex [args]        launch Codex; native Codex arguments pass through
  arc codex accounts      show Codex aliases, login status, and isolated homes
  arc codex add-account <id> [--home <dir>]   add an alias + run native login
  arc sessions            list logical arc sessions and their runtime bindings
  arc doctor              health check    ·    arc setup    reconfigure

Fridge from a terminal (also how an AGENT posts — it can RUN these, though it can't
TYPE the arc: form, which the hook eats before the model):
  arc role                who's in this repo's room, and what's my role?
  arc note all "<text>"   broadcast a note to every roommate
  arc note <role> "<text>" leave a note for one roommate
  arc notes               read your unread notes
  arc watch [role]        (long-running) print a line per incoming delegation, so a
                         BACKGROUND task / Monitor can WAKE an idle delegate session
  (skills: share-with-roommate = WHEN to broadcast · fridge-responder = how a
   research session stays responsive to delegations)

Configured accounts: ${accounts.join(', ') || '(none — run `arc setup`)'}
`;
}

module.exports = renderHelp;
// Direct run (debugging): print to stdout.
if (require.main === module) process.stdout.write(renderHelp());
