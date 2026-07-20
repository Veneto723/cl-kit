# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`arc` (Agent Runtime Coordinator) is a **Windows-only** Node.js wrapper around Claude Code: it launches `claude` with `stdio: inherit` and layers on account switching, session tooling, and a multi-session coordination layer ("the board"). Entry point: `src/arc-runner.js`. Two account kinds exist — **subscription** (`oauth`, a claude.ai login) and **gateway** (`api`, any Anthropic-compatible baseUrl+key); there is no third, and no pool/APIHub anything (removed at v1.0.0 — do not resurrect the word).

Two constraints, both deliberate and each reversed-into once — do not re-litigate:
- **Windows only** (`package.json` pins `os: win32`). Don't re-add cross-platform code.
- **Self-contained** — `src/` is pure Node built-ins (no npm deps at all); the `mcp/` server may carry in-process npm deps (it has its own `package.json`); the `scope/` companion (`arc-scope`, the desktop GUI) is a **first-party** WPF app in C#, built by the in-box Windows compiler with zero third-party runtime; no standalone **third-party** apps and no global system hooks.

## Commands

- **Test:** `node test/run.js` (or `npm test`). Hermetic (runs against a throwaway `HOME` under temp, never your real `~/.claude`), finishes in seconds. There is **no per-test filter, no lint, and no build step** — pure Node built-ins. `CORE` failures fail the build; the `PROBE` section only reports environment touchpoints and never fails.
- **Regenerate the `/`-menu stubs:** `node src/arc-slash.js` — required after touching `MENU`/verbs in `arc-slash.js`; a drift test asserts the `skills/arc-*` stubs stay byte-exact.
- **Deploy:** `install.ps1` (PowerShell). Copies `src\*.js` **and the `.ps1` launch templates** to `~/.claude/scripts`, publishes the skill stubs and bundles, registers the MCP server, and **merges** hooks + statusline into `settings.json`. Deploy is how a change goes live; see the first bite below.
- **Release (gated):** `arc release <patch|minor|major> --yes` — refuses on a dirty tree, wrong remote, or being behind origin. Releases are GitHub Releases; `arc update` on any machine pulls the latest.

## Working rules

- **The commit gate.** An audit verdict (or a green suite, or "it works live") is **not** commit authorization. Every `git commit` and every `git push` waits for the human's explicit command — individually, not as a standing grant. Build → test → verdict → **stop and report ready**.
- **Deploy ≠ commit.** To *see* a change in a live session, deploy it; committing only records it. Neither implies the other, and both are the human's call.

## Three things that will bite you (keep these in mind on every task)

1. **`src/` is not what runs.** The live runner and hooks execute from `~/.claude/scripts` (copied there by `install.ps1`). Editing `src/` has no effect on a running session until you re-deploy — and even then, **hooks and the statusline reload per prompt tick, but a running `arc-runner` process does not**: a live session needs `/arc-restart` to pick up runner changes. When testing launch behavior end-to-end you are testing the *deployed* copy — verify the shipping surface, not just the module under `src/`.

2. **The board is machine-local and append-only.** `.arc/peer/notes.jsonl` is gitignored and never travels via git. A note's identity is its stable `<origin>:<random>` id, **never its line position** — reasoning by position silently corrupts references when two clones' ledgers merge. Revive is inherently **same-machine** (a conversation transcript is machine-local). Role charters (`.arc/roles/*.md`) *do* travel in git — charters are a project fact; the board is coordination scratch.

3. **Spawned peers inherit the invoker's environment.** `wt` hands a new pane the spawning process's env — which, from inside a session, is Claude Code's tool subshell (`NO_COLOR=1` and identity vars included). Anything a peer must not inherit goes in `arc-invite.js`'s `INHERITED_IDENTITY` strip; anything a spawn must always have goes in `arc-config.json` (read fresh from disk), never in an env var a caller has to remember.

## Command surface — two forms, one verb set

`src/arc-slash.js` is the single source of truth for the verbs. A command reaches a session two ways, both resolving to one dispatch:

- **`/arc-<verb>`** — the prompt form, matched by the UserPromptSubmit hook at **zero model tokens**, with `/`-menu autocomplete (skill stubs). Machines send the same spelling — the revive prompt is `/arc-role <role>`. Deliberately strict (a matched prompt is *erased*).
- **`arc <verb>`** — the terminal form, run in a shell.

The retired `arc:<verb>` colon shape survives only as `LEGACY_RX`, strip-only inside `stripConvArgs` (so old preserved argv cannot replay as prose on respawn); the hook never matches it.

## Deeper reading — load the relevant slice before working in it

Full module map and mechanics are in **[`docs/architecture.md`](docs/architecture.md)**. Read the section for the area you're touching rather than pulling all of it into context:

- **The board** — `arc-board`, `arc-notes`, `arc-invite`, `arc-await`, `arc-sync`, `arc-done`, `arc-postcommit`. The claim/revive lifecycle, the id/ord merge model, the listener wake, the DEAF heartbeat.
- **The account wrapper** — `arc-runner`, `arc-config`, `arc-profile`, `arc-switch-core`, `usage-monitor`. Launch/respawn, `stripConvArgs`, mid-conversation account switch, settings merge policies, DPAPI keys.
- **The hook layer** — `arc-switch-hook`, `arc-stop-hook`, `arc-pretool-hook`, `arc-wire-settings`. How commands and board delivery run before the model.
- **Supporting modules** — one-liners for everything else (`arc-bundle`, `arc-stance`, `arc-duty`, …).
- **Testing conventions** — the hermetic throwaway-`HOME` pattern and what stays OS-portable.

Parked and open work lives in **[`docs/ROADMAP.md`](docs/ROADMAP.md)** — finished items are deleted, not struck; the file holds only what still has an owner and an open question.
