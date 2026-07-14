# Shipping-surface audit — commands taught vs commands that run

Requested by `code` (board note #1), executed by `research` 2026-07-14. READ-ONLY audit;
nothing was edited. Method: extracted every literal command string from README.md,
skills/peers/SKILL.md, src/arc-help.js, all src/*.js user/agent-facing strings, mcp/server.js,
docs/, bundles/, install.ps1 — and checked each against the two dispatchers
(arc-runner.js main() for terminal commands, arc-switch-hook.js TRIGGER_RX for sentinels)
plus the flag parsers. Shell-hostile syntax was verified empirically in BOTH Git Bash (sh)
and PowerShell 7 on this machine.

Ground truth used:
- Terminal dispatch: src/arc-runner.js:1195-1304 (`bundle setup capture rename add|add-account
  export import peek|usage trash set-key doctor claudex await role note notes` + launch flags)
- Sentinel dispatch: src/arc-switch-hook.js:41 (TRIGGER_RX)
- Note-flag parser: src/arc-notes.js:172-186

---

## A. Commands taught that do not run

### A1 — mcp/server.js:166 teaches `cl add-account <id>` (old binary name)  [HIGH]
The account_update MCP tool's guidance string says: *"the guided way is to run
`cl add-account <id>` in a terminal"*. Fresh installs ship only `arc` + `arc.cmd`
(install.ps1:65-71); nothing named `cl` exists on PATH. Following this instruction →
exit 127 (sh) / CommandNotFound (PowerShell). This is the exact 127 class: unit tests
call the module, never the taught command. Should be `arc add-account`.

### A2 — README.md:139 gives the `arc:help` alias as `arc:cl`  [MEDIUM]
TRIGGER_RX (arc-switch-hook.js:41) accepts `help|arc`; the real alias is `arc:arc`
(arc-help.js:16). A typed `arc:cl` matches nothing, falls through the hook, and is sent
to the model as an ordinary prompt — costs tokens, prints no cheat sheet, silent failure.

### A3 — invalid-but-present config makes `arc setup` and `arc doctor` unrunnable,
### while every error says to run them  [HIGH, verified empirically]
arc-runner.js:41-47 loads config at module top level, BEFORE main() dispatches
subcommands (line 1193). A missing config is fine (legacyConfig fallback,
arc-config.js:49-59). But a config that PARSES with zero valid accounts (e.g.
`{"accounts":[]}`, or entries whose `type` isn't oauth/api after the filter at
arc-config.js:62-64) throws in normalize (arc-config.js:72) → every subcommand exits 1
with *"run `arc setup`"*. Verified with a scratch USERPROFILE:

    $ arc setup     → [arc] arc-config: no valid accounts configured — run `arc setup` (exit 1)
    $ arc doctor    → same (exit 1)

The recovery command the error teaches cannot run; README.md:537 calls `arc doctor`
"your first stop", and it dies on exactly the config states it exists to diagnose.
Fix direction (code peer's call): dispatch `setup`/`doctor` before the top-level
loadConfig, or make their path tolerate a broken config.

---

## B. Terminal note commands taught with shell-hostile syntax (BOTH shells)

### B1 — `--reply-to #N` / `--supersedes #N` in terminal context  [HIGH, verified]
`#` at word start begins a comment in BOTH POSIX sh and PowerShell. Verified:

    sh:   echo before #8 after            → "before"
    pwsh: node … x --reply-to #8 "DONE…"  → argv ["x","--reply-to"]

So `arc note android --reply-to #8 "DONE — …"` run literally in either shell loses
everything from `#8` on. Worse, it SILENTLY SUCCEEDS: requestNote (arc-notes.js:172-186)
gets rest="--reply-to", no flag matches (no digits), body becomes the literal string
`--reply-to`, and a garbage info note is posted — the answer text is gone, the request
stays unanswered, exit 0, "✓ note posted". For `--supersedes` the retraction never
happens — the failure the skill itself calls the one that matters.

Surfaces teaching the `#N` form in TERMINAL (sh-fence / agent-Bash) context:
- skills/peers/SKILL.md:119  ("Answer one the same way: `arc note <them> --reply-to #<seq> …`")
- skills/peers/SKILL.md:132  (`arc note android --reply-to #8 "DONE — …"` in a ```sh fence)
- skills/peers/SKILL.md:135  (`arc note android --supersedes #13 "CORRECTION — …"`)
- skills/peers/SKILL.md:190  (step 3 of "When a note wakes you")
- src/arc-notes.js:213,216,217 (NOTE_USAGE) — surfaced through the terminal `arc note`
  error path with arc:→`arc ` rewriting (arc-runner.js:1295-1296), i.e. the CLI's own
  usage message teaches the trap to the agent that just got the args wrong.

The parser already accepts a bare number (`#?` in the regexes at arc-notes.js:181-182),
so `--reply-to 8` works today. Docs/usage should drop the `#` (or quote `"#8"`) in every
terminal-context example. Sentinel (typed-prompt) context is unaffected — no shell.

### B2 — skills/peers/SKILL.md:59: backticks inside double quotes in a ```sh fence  [MEDIUM, verified]
`arc note backend "schema: added `retries` (int, default 0) to task_log"`
- sh: backticks are command substitution → `retries: command not found` on stderr, the
  word silently vanishes from the posted body ("schema: added  (int, …)").
- PowerShell: `` `r `` is the carriage-return escape → body mangled ("added \retries…").
Single quotes (sh) or escaping would fix the example.

---

## C. Agent-facing strings teaching the form agents cannot use

### C1 — the board injection tells the AGENT to run `arc:notes`  [MEDIUM]
- src/arc-notes.js:398: "…run `arc:notes` to read the next batch."
- src/arc-notes.js:402: "`arc:notes all` shows the whole board."
This text is delivered INTO THE AGENT'S CONTEXT (turn-start additionalContext and the
Stop-hook block) and addresses the agent ("tell the user what you received"). An agent
cannot type sentinels — SKILL.md itself says the hook eats them — and running `arc:notes`
in Bash is exit 127. The runnable form is `arc notes`. Contrast arc-await.js:114, which
gets it right ("Read them properly … with:  arc notes"). Same class as the shim bug:
the instruction works for a human, dies in the agent's only shell.
(Same nit in requestRole/requestNote refusals, arc-notes.js:160,169,248 — but those ARE
rewritten to space-form on the terminal path by arc-runner.js:1295-1296, so they're fine;
the injection/Stop-hook path has no such rewrite.)

---

## D. Stale `cl-*` names in README (rename leftovers; env vars are the "typed and does nothing" class)

| README line | says | code reality |
|---|---|---|
| 199 | `CL_DONE_GATE` | `ARC_DONE_GATE` (src/arc-done.js:134) — documented var does nothing |
| 223 | `CL_SESSION` → role | `ARC_SESSION` (src/arc-postcommit.js:40) |
| 318 | `~/.claude/cl-profiles/<id>/` | `arc-profiles` (src/arc-profile.js:18) |
| 373 | `backups/cl-deleted-<ts>/` | `arc-deleted-` (src/arc-sync.js:500) |
| 441 | `cache/cl-runner.log` | `arc-runner.log` (src/arc-runner.js:109) |
| 455 | `~/cl-export-<ts>.tgz` | `arc-export-` (src/arc-sync.js:300) |
| 468 | `backups/cl-import-<ts>/` | `arc-import-` (src/arc-sync.js:364) |
| 509,515 | copy `~/.claude/cl-credentials/` to mirror a machine | no such dir is ever created; logins live in `arc-profiles/<id>/.credentials.json` — the mirror instruction cannot work as written |
| 532 | `CL_NOTIFY_MIN_MS` | `ARC_NOTIFY_MIN_MS` (src/arc-notify.js:26) — tuning the documented var does nothing |
| 533 | `cache/cl-notify.log` | `arc-notify.log` (src/arc-notify.js:32) |
| 559 | "caches live under `cache/cl-*`" | all cache files are `arc-*` now |
| 562 | "aliases and logical sessions live under `~/.arc`" | only bundles use `~/.arc` (src/arc-bundle.js:44); the registry described was deleted |

---

## E. Removed tools & old vocabulary (question 2 verdict: CLEAN, with comment-level nits)

- `arc watch` / `arc delegate` / `arc:delegate`: every occurrence is an explicit removal
  notice (arc-help.js:128-130,151-152; SKILL.md:96; arc-runner.js:1255-1258,1300-1304;
  the intentional arc:delegate intercept arc-switch-hook.js:158-168). Nothing teaches
  them as live. ✓
- `arc:handoff`: zero occurrences anywhere. ✓
- fridge/room/lease/roommate: survive only in labeled LEGACY compat shims
  (arc-board.js:82-88 lease-*.json, arc-notes.js:75-79 r.room) and install.ps1:97-106's
  intentional stale-skill sweep. bundles/inquiry's "writer lease" is its own unrelated
  concept. ✓
- Comment-only nits (not user-facing): arc-notes.js:230 "landlord view", arc-notes.js:314
  "the ROOM has notes", arc-stance.js:3 lists "arc note / watch / await" as the tool set,
  arc-stop-hook.js:110 references a nonexistent `arc:invite`, arc-switch-hook.js:39-40
  self-contradictory "`arc:` is the current prefix; `arc:` is kept as a deprecated alias"
  (presumably meant `cl:`; the regex accepts only `arc:`).

## F. Minor

- arc-anchor.js:279,284,292 title the readout "arc anchors — board …" but no terminal
  `arc anchors` exists (sentinel only); `arc anchors` typed in a terminal falls through
  to the launch path and passes "anchors" to claude as an argument. Title-only, low.

---

## Verified GOOD (so nobody re-audits these)

- All sentinel names taught in README/help match TRIGGER_RX; all terminal commands in the
  help sheet + README tables exist in the dispatcher.
- Flag surfaces parse as taught: add-account oauth (--label --email --color --console
  --default, arc-runner.js:1031-1040) and gateway (--api --url --file --key --header
  --model --env --no-verify --label --color --default, arc-switch-core.js:506-630);
  set-key (--file/--stdin, arc-runner.js:1138-1161); export/import (--since --out --dest
  --dry-run --force --skip-existing, arc-sync.js:246,411-419); trash restore/empty confirm.
- The wake path teaches only runnable commands: arc-stop-hook.js:92,127 (`arc await <role>`),
  arc-await.js:101,114 (`arc await research`, `arc role research`, `arc notes`).
- README.md:217-220 post-commit snippet (`node "$HOME/.claude/scripts/arc-postcommit.js"` in
  a sh hook) WORKS in Git Bash — MSYS path conversion handles the argument (tested).
- Fresh install with NO config works for every subcommand (legacyConfig fallback) — the
  catch-22 in A3 needs an invalid-but-present config.
- bundles/inquiry and bundles/show-image skills teach no arc commands; docs/README.md and
  install.ps1's next-steps teach only valid ones.
