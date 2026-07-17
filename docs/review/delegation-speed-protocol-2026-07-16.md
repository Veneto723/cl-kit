# Pre-registered protocol: does delegating make the work finish FASTER, and at what N does it start to?

**Owner:** `research` peer · pre-registered 2026-07-16, BEFORE any trial runs.
**Provenance:** measurement handed to research by `code` in board note #47; human authorized the run (design + execute) this session. Prior finding this builds on: `paths-nudge-results-2026-07-15.md` — `owns:`-relevance flips auto-mode workers from self-fix (A0 0/8) to full delegation (A 8/8), p≈7.8e-5. That proved the DECISION. This measures the OUTCOME.

> **AMENDMENT 1 — 2026-07-16, post-`code`-review (note #52), pre-first-trial (registration stays clean).** `code` attacked the design; the human confirmed ("code is correct, move on"). Locked changes, none touching the primary outcome definition:
> - **My serialization prediction is RETIRED on a config fact I could not see:** the default account `whale` is `type:api` (its own RPM/TPM bucket), not an OAuth subscription with a session window; and last night's own run had 3 workers overlap for minutes on whale with no serialization. So "crossover is ∞ on one subscription" is dead. **What replaces it, and is now the registered soft hypothesis: THROTTLE, not serialize** — 3 workers sharing one API bucket deplete it ~3× faster, slowing per-token throughput, *eroding* (not erasing) the parallel gain. Detected by the **concurrency factor**, no extra sessions.
> - **Account fork RESOLVED → single-account on `whale`, pinned across ALL arms.** whale is the realistic default (the shipping surface), so this is not a compromise. The multi-account option is retired as confounded (the only alternatives are OAuth subs → mixes api+oauth: latency + model-routing + bucket semantics change at once). **Escalation to a per-owner-account run is pre-registered as CONDITIONAL: it fires only if the concurrency factor in the single-account crux shows serialization (owner work-windows do not overlap); `code` backs that spend then.** No accounts procured up front.
> - **PAIRED design adopted (`code`'s strongest add):** each seeded bug is run through BOTH regimes and is its own control; the test is the within-pair wall-clock difference, killing the between-bug variance r=3 could not see through. Same session count.
> - (1) verified-oracle primary and (2) induction-as-manipulation both survived review unchanged.
> Human go recorded for the single-account run at the ~29-session cost.

> **AMENDMENT 2 — 2026-07-16, after ROUND 1 was VOIDED (code #76), before the re-run.** The first 9-trial run is void — NOT for keystroke contamination (the workers were forensically clean: birth-prompt-only, one legitimate skill-load in the two that delegated) but for a **machine-LOAD confound**. `code` was hammering the shared box through the entire window (a 286s subagent, repeated `install.ps1`, the 700-test suite, window-enumeration probes), and because arms ran **SEQUENTIALLY self-first every round**, load landed asymmetrically on whichever arm was running. The 3× "delegation slower at N=1" was likely that load, not a delegation cost — and `code` refused to let its own prior be confirmed by its own CPU. **Wall-clock on a shared box is not a measurement without load control.** Adopted (code's a+b):
> - **(a) RANDOMISED arm order per round** — seeded, pre-registered `SEED=0x5eed16` in [`run-essential.js`](delegation-speed-harness/run-essential.js) — so load hits arms symmetrically, not always self-first.
> - **(b) LOAD PROXY per trial**, sampled at t_start + every poll + score. **CPU% (`Win32_Processor.LoadPercentage`) is the PRIMARY metric** — raw claude/node process counts are confounded by the trial's OWN owners (warm N=3 spawns 3), so they are secondary/diagnostic only. Recorded in every row as `load`; an outlier-CPU trial is flagged and re-run.
> - **Owner convIds recorded** (the #75 gap) so owner-side is checkable too.
> - **Timezone: all trial timestamps are UTC** (box is UTC+8; round 1's "local" labels were UTC — corrected).
> The re-run waits on BOTH `code`'s focus-safe spawn (Hidden, or WMI visible-unfocused per #73) AND a relatively **quiet box** — (c)-as-hard-precondition is unenforceable while `code` works, so (a)+(b) are the real defence. Scope: ~30 sessions (essential tier).

## The question, and why last night did not answer it

Last night's owners were **parked and sworn to silence** — deference was scored at the note, and in every deferral *the bug was never fixed by anyone*. That measures whether an agent hands off, not whether handing off is worth anything. The human's actual reason for peers is **parallelism** ("run tasks in parallel to accelerate overall speed"). So the outcome that matters is **wall-clock from task-given to all-tasks-actually-fixed (verified)**, with owners **live and working**, their wake latency (idle → `arc join` exit → turn → first edit) counted as part of the real system, not excluded.

## Recorded predictions (on the record BEFORE the first trial)

- **`code`'s prior (note #47):** delegation LOSES at N=1 — one task + relevant `owns:` makes the caller hand it away then idle; handoff + peer-wake + peer-work are all SERIAL with the caller waiting, strictly slower than doing it. Evidence cited: 5/8 of last night's delegators never replied after dispatch — they had nothing left to do.
- **`research`'s prediction (mine, adversarial to both):** `code` is right at N=1. But the crossover N* is **governed by a variable neither of us has controlled yet: whether the N owners actually run concurrently.** T_self(N) ≈ N·t_fix (one agent, serial). T_deleg(N) ≈ C_boot + t_fix_parallel + C_handback ONLY IF owners run in true parallel. Crossover N* ≈ 1 + (C_boot+C_handback)/t_fix. **My sharp claim: under a single pinned account (as last night pinned `whale`), Anthropic-side rate limiting may SERIALIZE the owners, so T_deleg(N) ≈ C_boot + N·t_fix and the crossover is effectively ∞ — delegation never wins on one subscription.** If that holds, the headline is not "delegation is slow" but "parallelism is an account-concurrency illusion" — a design constraint far more useful than a crossover number. I want this killed with data if wrong.

## The model being tested

| regime | how it is INDUCED (the validated lever, not a forced choice) | expected time |
|---|---|---|
| **SELF** | every area's owner declares an IRRELEVANT `owns:` (docs) → caller self-fixes all N, serially, in one session | T_self(N) ≈ N · t_fix |
| **DELEG** | every area's owner declares a RELEVANT `owns:` → caller delegates each task to its owner; owners work | T_deleg(N) ≈ C_boot + (parallel? t_fix : N·t_fix) + C_handback |

The manipulation is the same one already proven to move behaviour, so the regimes arise **ecologically** — we are not scripting "now delegate." Whether the lever actually induces the intended behaviour each trial is itself measured (induction rate; a misfire is a disclosed, replaced void, not a silent datapoint).

## Design

- **Factor N (independent tasks/areas, NO shared files):** N ∈ {1, 3}. `code`'s N≥3 minimum. Independence is load-bearing: shared files would re-introduce collisions and serialize DELEG for a different reason than we are testing.
- **Two phases:**
  - **Phase 1 — primitives (cheap, and they let us COMPUTE the crossover, not just bracket it):**
    - `t_fix`: r=4 cold callers each self-fix ONE seeded bug (verified). → median t_fix + variance.
    - `T_deleg(1)`: r=4 trials, caller delegates 1 task to 1 live owner who fixes it (verified). Split **2 revive / 2 birth** to price C_boot both ways (they differ a lot — `code`'s flag). Yields C_boot, owner t_fix, C_handback, and the N=1 delegation total → directly tests `code`'s N=1 prediction.
  - **Phase 2 — parallelism at N=3 (the crux):**
    - SELF N=3: r=3 callers each self-fix 3 independent bugs (verified all 3) → T_self(3), and a check that it is ≈ serial 3·t_fix.
    - DELEG N=3: r=3 callers each delegate 3 independent tasks to 3 owners (verified all 3) → T_deleg(3) **and the concurrency factor** (do the 3 owners' active windows overlap in wall-clock, or serialize?).

## Outcomes (predefined)

- **PRIMARY (continuous):** verified wall-clock from task-delivery to the moment ALL N oracles pass. **Verified by running each seeded problem's failing test — never self-report.** The harness polls the oracles and timestamps the last pass. Owner wake latency is included.
- **SECONDARY (the mechanism — this is where the answer actually lives):**
  - **Concurrency factor** at N=3 DELEG: overlap of owners' active windows (first-edit → last-edit per owner), from transcript timestamps. ~1 = serialized (no parallel win possible); ~N = ideal parallel.
  - **C_boot** birth vs revive; **C_handback**; **caller idle-vs-working while waiting** (does the caller do anything useful, or just block? — `code`'s "measure that, it is the mechanism").
  - **Induction rate:** fraction of trials where the lever produced the intended regime.
- **VOID (symmetric, predefined):** no regime reaches all-oracles-pass within the per-trial cap; harness fault; cold-birth contamination (integrity check); **lever misfire** (a DELEG trial whose caller self-fixed, or a SELF trial whose caller delegated) — replaced, and the misfire count reported as the induction-rate secondary, never scored into the timing contrast.

## Held constant / rigor (same discipline as last night)

- **Pin model + effort + permission-mode `auto`** across every session (a slow owner is a confound, not a finding). Record per trial.
- **Account policy is NOT boilerplate here — it defines what is measured (see the human fork below).** Whatever is chosen is pinned and recorded per session.
- **Cold-birth** trial sessions (`from=null` → no `--resume`, no fork), pre-flight asserted, per-trial integrity check on the opening transcript entry.
- **Board + work-tree hygiene per trial:** ledger/cursors/claims wiped, each area git-reset to its pinned fixture SHA (the round-3 pre-solved-tree fault is why the pointer is pinned, not just the work-tree).
- Pre-registered before the first trial; truncation (if the human time-boxes) disclosed and read at achieved n; ordered analysis; `code` gets an adversarial review window before any trial (this doc is the object of it).

## Analysis plan

- Per cell: **all raw wall-clock values + median** (r is small and wall-clock is noisy — no cell mean is reported without its raw points).
- **Crossover N\*** estimated TWO ways and reported together: (1) from the primitives, N\* ≈ 1 + (C_boot+C_handback)/t_fix; (2) bracketed by the observed N=1 vs N=3 contrast in each regime. If the two disagree, the disagreement is the finding (it means parallelism did not scale as the primitive model assumes — read the concurrency factor).
- **Honest limit, binding:** with r=3–4 and noisy wall-clock this **estimates the crossover's direction and rough magnitude and identifies its mechanism; it does not pin N\* to ±0.5.** The readout says so.
- **Decision value:** if delegation never beats self-fix at any tested N → the peer system does not pay for itself for single-task work and arc should not nudge toward delegation unless the caller has N+ independent tasks AND the accounts to parallelize them. If it wins above some N\* → N\* is a design constant: the ownership nudge should fire only when both conditions hold.

## Cost (single-account design, the cheaper fork)

Phase 1: 4 (t_fix) + 4 callers + 4 owners (T_deleg(1)) = 12. Phase 2: 3 (SELF N=3) + 3 callers + 9 owners (DELEG N=3) = 15. Plus ~2 preflight/smoke (throwaway, disclosed). **≈ 29 sessions.** The multi-account fork costs the same in sessions but needs 3 distinct pool accounts live at once for the DELEG N=3 cell.

## Open design fork — the human's call (it changes the ANSWER, not just the price)

DELEG's entire benefit is parallelism, which is real only if the owners run concurrently. Two legitimate experiments:
- **(a) Single account (`whale`):** measures delegation under the human's ACTUAL daily setup — one subscription, subject to its concurrency/rate limits. Cheapest. Likely verdict: delegation throttled, crossover large or ∞. Answers "does delegation pay off on ONE subscription."
- **(b) One account per owner:** measures TRUE parallelism (delegation's best case). Needs N distinct pool accounts running at once. Answers "does delegation pay off IF you have the accounts to parallelize."
- **(a+b on the crux cell only):** run DELEG N=3 both ways; the CONTRAST isolates account-throttling as the mechanism. +6 sessions.

My recommendation: **(a+b on the crux cell**), because the single-vs-multi contrast at N=3 is the cleanest possible test of my sharp prediction and turns a possibly-null result ("delegation didn't win") into a mechanistic one ("it didn't win *because* one account serializes owners — give it three and here is what changes").
