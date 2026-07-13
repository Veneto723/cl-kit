# Setup — where the inquiry writes, and what it seeds

**Read this once, at the start of a run.** If the ledger already exists, you are
**resuming** — see `reference/resume.md` instead, and do not re-seed.

## The brief

`GOAL.md` (shape: `templates/GOAL.md`) carries: **background**, **direction**, optional
**limiter** (the ceiling to attack), **temperament** (`incremental` default |
`breakthrough`), an **escalate bar** override, a **budget** (max rounds / max
escalations), and a **topic slug** (names the run's subfolder).

If anything critical is missing or ambiguous — no direction at all, say — that is itself a
**major decision**: escalate once, then proceed.

## FIXED OUTPUT LOCATION — do not deviate

Everything project-level the inquiry writes — the ledger, `GOAL.md`, `RESUME.md`, the
final `SUMMARY.md`, any spike or scratch artifact — lives under:

```
docs/inquiry/<topic>/
```

and **nowhere else in the project**. One path, so the entire footprint is trivially
ignorable with a single rule. A `GOAL.md` may choose the `<topic>` slug but **must not**
relocate the parent out of `docs/inquiry/`.

> **Why `docs/inquiry/` and not `docs/research/`:** the self-ignore below writes a
> `.gitignore` containing `*`. If we wrote into a folder a project might already use for
> *human* notes, we would silently gitignore the user's own work. The tool only ever
> writes into a namespace it owns.

**Self-ignore.** On setup, ensure `docs/inquiry/.gitignore` exists (create it with the
single line `*` if missing). That auto-ignores the whole area, itself included — so the
inquiry's output never enters the host repo, and the project's own root `.gitignore` never
needs to learn this tool exists. **It is the inquiry's job to stay invisible, not the
project's.**

(The per-user taste profile and feedback resolve to `INQUIRY_HOME`, an existing
`~/.inquiry`, an existing `~/.claude/inquiry`, then `~/.inquiry`. They stay outside any
project, remain shared across Claude and Codex, and are never committed.)

## Seed the ledger

Copy this skill's `templates/ledger/` into `docs/inquiry/<topic>/`:

| file | holds |
|---|---|
| `findings.md` | every kept finding, append-only, with sources + significance |
| `decisions.log` | every autonomous decision you made, and its one-line rationale |
| `open-questions.md` | threads not yet chased — **and findings whose skeptic died (unverified)** |
| `escalations.md` | what you surfaced to the human, and their answer |

Then initialize `state.json` and acquire the writer lease as described in
`reference/run-state.md` before changing the ledger. Prefer the bundled Node utility; use its
create-only host fallback only when process launch is unavailable. These files plus `GOAL.md`
are the durable state of the inquiry. `RUNNING.lock` is an
expiring lease, not research history. Nothing lives only in your head — which is what makes a
context reset safe (`reference/resume.md`).
