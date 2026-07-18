# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`arc` (Agent Runtime Coordinator) is a **Windows-only, dependency-free** Node.js wrapper around Claude Code: it launches `claude` with `stdio: inherit` and layers on account switching, session tooling, and a multi-session coordination layer ("the board"). Entry point: `src/arc-runner.js`.

Two constraints, both deliberate and each reversed-into once — do not re-litigate:
- **Windows only** (`package.json` pins `os: win32`). Don't re-add cross-platform code.
- **Self-contained** — in-process npm deps are fine; no standalone third-party apps and no global system hooks.

## Commands

- **Test:** `node test/run.js` (or `npm test`). Hermetic (runs against a throwaway `HOME` under temp, never your real `~/.claude`), finishes in seconds. There is **no per-test filter, no lint, and no build step** — pure Node built-ins. `CORE` failures fail the build; the `PROBE` section only reports environment touchpoints and never fails.
- **Deploy:** `install.ps1` (PowerShell) copies `src\*.js` → `~/.claude/scripts` and wires the hooks into `settings.json`.
- **Release (gated):** `arc release <patch|minor|major> --yes` — refuses on a dirty tree, wrong remote, or being behind origin.

## Two things that will bite you (keep these in mind on every task)

1. **`src/` is not what runs.** The live runner and hooks execute from `~/.claude/scripts` (copied there by `install.ps1`). Editing `src/` has no effect on a running session until you re-deploy. When testing hooks or launch behavior end-to-end, you are testing the *deployed* copy — verify the shipping surface, not just the module under `src/`.

2. **The board is machine-local and append-only.** `.arc/peer/notes.jsonl` is gitignored and never travels via git. A note's identity is its stable `<origin>:<random>` id, **never its line position** — reasoning by position silently corrupts references when two clones' ledgers merge. Revive is inherently **same-machine** (a conversation transcript is machine-local). Role charters (`.arc/roles/*.md`) *do* travel in git — charters are a project fact; the board is coordination scratch.

## Command surface — two forms, one verb set

`src/arc-slash.js` is the single source of truth for the verbs. A command reaches a session two ways, both resolving to one dispatch:

- **`/arc-<verb>`** — the prompt form, matched by the UserPromptSubmit hook at **zero model tokens**, with `/`-menu autocomplete (skill stubs). Machines send the same spelling — the revive prompt is `/arc-role <role>`. Deliberately strict (a matched prompt is *erased*).
- **`arc <verb>`** — the terminal form, run in a shell.

The retired `arc:<verb>` colon shape survives only as `LEGACY_RX`, strip-only inside `stripConvArgs` (so old preserved argv cannot replay as prose on respawn); the hook never matches it.

## Deeper reading — load the relevant slice before working in it

Full module map and mechanics are in **[`docs/architecture.md`](docs/architecture.md)**. Read the section for the area you're touching rather than pulling all of it into context:

- **The board** — `arc-board`, `arc-notes`, `arc-invite`, `arc-await`, `arc-sync`, `arc-done`, `arc-postcommit`. The claim/revive lifecycle, the id/ord merge model, the listener wake.
- **The account wrapper** — `arc-runner`, `arc-config`, `arc-profile`, `arc-switch-core`, `usage-monitor`. Launch/respawn, `stripConvArgs`, mid-conversation account switch, DPAPI keys.
- **The hook layer** — `arc-switch-hook`, `arc-stop-hook`, `arc-pretool-hook`, `arc-wire-settings`. How commands and board delivery run before the model.
- **Testing conventions** — the hermetic throwaway-`HOME` pattern and what stays OS-portable.
