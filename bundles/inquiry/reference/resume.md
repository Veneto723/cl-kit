# Checkpoint & resume — surviving your own context

**Read this when your context is filling, or before a long run.**

## The failure this prevents

You are the controller of a long, multi-round inquiry. Your context grows every round.
As it fills, a model starts to *feel* the ceiling and **rushes to deliver** — it cuts the
loop short, calls `dry` early, and dashes off a shallow `SUMMARY.md`.

That is the **exact** failure this whole tool exists to prevent — confident, eloquent
noise — arriving through the back door. A rushed conclusion is worse than no conclusion,
because it *looks* finished.

## The rule (non-negotiable)

> **Context pressure is NOT a termination condition.**
> There are exactly three legitimate reasons to stop (§3 of SKILL.md): dry×2 (clean),
> budget, or the human says stop. "I am running out of room" is **not** one of them.
> If you are under context pressure you **checkpoint and hand off**. You never summarize
> early to get it over with.

## Why a handoff is nearly free here

You hold **nothing** that isn't already on disk. That is not an accident — it is the
whole point of the ledger:

| in your head | on disk |
|---|---|
| what we've found | `findings.md` |
| what I decided and why | `decisions.log` |
| threads not yet chased | `open-questions.md` |
| what I asked the human, and their answer | `escalations.md` |
| the brief, the limiter, the budget | `GOAL.md` |
| round count, dry streak, run ID | `state.json` |
| what the human considers worth raising | `<inquiry-home>/taste.md` |

A fresh controller reading those seven things knows everything you know. **So a context
reset costs nothing — provided the ledger is current.** Which leads to the discipline:

## The discipline

1. **Write the ledger every round, before anything else.** Never hold a finding, a
   decision, or an escalation answer only in context. If it matters and it isn't on disk,
   it doesn't exist. Do this *even when you feel fine* — the point is that a reset is
   always safe, not that you remember to prepare for one.
2. **Never compress the ledger to save room.** It is the durable record; you are the
   disposable part. Compress what you *feed forward* (`ledgerSummary`), never what you
   *store*.
3. **When context gets tight, checkpoint and hand off.** Do not start another round.

## The handoff

Write `RESUME.md` next to the ledger (`docs/inquiry/<topic>/RESUME.md`):

```markdown
# RESUME — <topic>, after round N
- Brief: GOAL.md (unchanged | amended: <what/why>)
- Rounds done: N   ·   Dry streak: X/2 (clean rounds only)   ·   Budget left: <rounds/escalations>
- Where I am: <one paragraph — the live thesis, in plain words>
- Next round should: <the specific angle/limiter to push, and why>
- Open escalation: <awaiting the human on X> | none
- Do NOT redo: <what's already exhausted — so the next controller doesn't repeat it>
```

Then tell the human, plainly:

> "I'm at my context limit after round N. The ledger is complete and I've written
> `RESUME.md`. **Do not let me summarize now** — a summary written under context pressure
> is exactly the thing this tool is built to avoid. Start a fresh session and invoke
> `inquiry` on the same `GOAL.md`; it will resume from the ledger and lose nothing."

Then stop. **Do not** write `SUMMARY.md`. `SUMMARY.md` is only ever written at a
legitimate termination (§3). Release the writer lease with status `paused` after the handoff
is durable.

## Resuming (the fresh controller reads this)

On start, if `docs/inquiry/<topic>/` already has a ledger, you are **resuming, not
starting**:

1. Read `GOAL.md`, `state.json`, then `RESUME.md` if present, then the four ledger files.
2. Do **not** re-seed the ledger and do **not** re-run completed rounds.
3. Inspect and acquire the writer lease through `reference/run-state.md`. Stop if another
   unexpired controller owns it.
4. Rebuild `ledgerSummary` from `findings.md` and continue at §1 with counters from
   `state.json`; use `RESUME.md` only for the narrative next step.
5. Delete `RESUME.md` once you've absorbed it — it's a baton, not a record.
