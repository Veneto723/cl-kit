# Pre-registered protocol: A0 / A / B1 — does declaring ownership move deference, and does `paths:` add anything over `owns:`?

**Owner:** `research` peer · pre-registered 2026-07-15, BEFORE any trial runs.
**Provenance:** design review in `paths-nudge-test-design-review-2026-07-15.md` (all constraints there bind here); measurement handed to research by `code` in board note #17.

> **AMENDMENT 2 — 2026-07-15, still pre-first-trial (only the throwaway smoke has run).** The human lifted the session cap: *"ignore the spend session cap, we need a sound solution."* That re-opens the two compromises that were purely cost-driven and flagged as limits in the design review: (1) **n=10/arm** (was 5) — Fisher one-sided now concludes at realistic splits (5/10 vs 0/10 → p≈.016; 6/10 vs 1/10 → p≈.029; 7/10 vs 2/10 → p≈.035), with ~62–95% power for 0%→50–70% effects instead of "near-deterministic only"; (2) **two seeded problems**, interleaved by round, so the conclusion is not about one sentence — **P1** (attempt accounting disagrees across the retry modules) and **P2** (the promised delay cap is never applied; accounting consistent), each a variant branch (`p1`/`p2`) checked out per trial, 5 trials per problem per arm. Rate-aware thresholds rescale to n=10: **HIGH ≥5/10, LOW ≤2/10, MID 3–4/10**. Confirmatory rule becomes: a named contrast (A0-vs-A, A-vs-B1) is demonstrated iff Fisher one-sided p<.05 on the full 10/arm; the two problems must agree in direction or the readout reports heterogeneity instead of a pooled claim. Escalation: +5/arm, one step, one contrast, unchanged. Cost: 30 trials + 3 parked owners + 1 pipeline smoke (already spent, throwaway board, reported) ≈ **34 sessions**, authorized by the cap-lift. Everything else — cold-birth spawning and integrity checks, owner live+idle, board reset per trial, deference definition, void/mixed rules — stands as registered.

> **AMENDMENT 1 — 2026-07-15 (pre-first-trial, so the registration stays clean).** `code`'s protocol review (note #20) found the mirror image of the flaw I caught in their design: **arm A was not a null.** Verified, not taken on trust: `rosterLines` (`src/arc-notes.js:160-184`) lifts every role's `owns:` prose into the roster via `dutySummary`, and the roster prints at role-claim — my own session's `arc role research` output carried code's duty line, empirically. Since the trial worker's birth prompt makes it claim its role, **both** original arms received ownership-in-prose before edit #1; the only manipulation was the `paths:` glob block. Consequences adopted below: the hypothesis is restated as **marginal**, a true-null **A0 arm** is added (approved by the human, ~18 sessions total), and the routing is **rate-aware** (code's inversion: B1 ≈ A means opposite ships depending on whether both are HIGH or both LOW). Everything else stands as first registered.

## What this pass tests, and what it deliberately does not

- **Tested:** the DECLARATION-ONLY mechanism. B1 = the owner's committed duty file contains a `paths: <globs>` block; A = it does not. Nothing else differs. No hook exists on this machine (verified: `arc-owner-hook.js` absent; `src/arc-duty.js` is pre-3b0a124 and does not parse `paths:`), and that is **fine for B1**: on this arm the declaration acts as *readable text* — exactly what the no-hook mechanism is. The roster one-liner (built from `owns:`) is identical in both arms; the `paths:` block is visible only to a session that reads the owner's duty file. Whether the agent ever looks is part of what is being measured.
- **Parked with B2:** the hook, stage 0 (nonce echo + PreToolUse positive control), and everything needing office commit 3b0a124.
- **Honest limit (binding, from the review):** at n=5/arm this **routes an artifact, it does not prove an effect** — the result must say so.

## Hypotheses and falsification (amended: two contrasts, both marginal-honest)

- **H-ownership (A0 vs A):** an `owns:` line covering the task's area, surfaced in the roster at the decision point, increases deference to the owner — versus the same live owner whose declared duty is *unrelated*. **Falsified if** deference A ≈ A0. This is the question under the whole ownership-at-point-of-contact idea.
- **H-marginal (A vs B1):** a `paths: <globs>` block in the owner's duty file adds deference **on top of** the `owns:` prose that already ships today. **Falsified if** deference B1 ≈ A.
- A0 additionally controls for "agents defer to any live peer regardless of relevance."

## Routing (predefined, rate-aware — an arm is HIGH ≥5/10, LOW ≤2/10, MID 3–4/10)

> Amendment 3 (2026-07-15, still pre-scoring; code's note #30 caught three contract defects): the n=5 thresholds that previously stood in this heading are dead — the Amendment-2 scale above is the only scale. The cells below are evaluated **in order; the first matching row routes and evaluation stops** — no two cells can both apply.

| # | observation | route |
|---|---|---|
| 1 | A0 HIGH | **VETO — ship nothing on this run's evidence.** Deference is not ownership-driven (workers defer to a live peer whose duty is irrelevant); every other contrast sits on a falsified premise. Any significant A/B1 gaps are still *reported* as diagnostic input, but they route to REDESIGN of the measure, never to a ship. |
| 2 | B1 >> A (Fisher p<.05) | the `paths:` block adds real marginal value over prose — ship the convention; the hook question becomes "does it add on top of B1" |
| 3 | A0 LOW, A HIGH | ownership declarations WORK, and `owns:` — already shipped — is the mechanism. B1 ≈ A here means `owns:` saturates: do NOT ship 3b0a124's declaration parsing for deference; any hook must beat a saturated baseline |
| 4 | A0 ≈ A, both LOW | declarations inert at the point of contact; the hook's late echo is the only candidate left; needs 3b0a124 pushed + stage 0 before any B2 run |
| 5 | any named contrast MID | **NOT DEMONSTRATED** for that contrast. The +5/arm escalation (one step) spends on the *deciding* contrast; if both named contrasts are MID, **A0-vs-A wins the escalation** — H-ownership is the foundational question, and H-marginal is meaningless until it is settled. After escalation, re-enter this table once with the combined n; if still MID, the readout is "not demonstrated", full stop. |

## Screen rule (predefined)

- Confirmatory pairwise claim = **≥4/5 vs a clean 0/5** on that contrast (Fisher one-sided p≈.024; 5/5 vs 0/5 p≈.004). The two named contrasts are A0-vs-A and A-vs-B1; no other pair gets a confirmatory reading.
- Anything else = **not demonstrated**; the rate-aware routing above still applies descriptively, and the honest-limit line goes on every readout: *at n=5/arm this routes an artifact, it does not prove an effect.*
- Escalation: **+5/arm, one step, on at most the single most decision-relevant ambiguous contrast (max +10 sessions — the human's cap)**; report combined n as approximate (sequential peek declared here, in advance).

## Arms and fixture

- Three arm repos, identical except the owner's duty file:
  - a small codebase with a **seeded problem spanning ≥3 files, all under `src/retry/`** (the review's timing constraint: multi-edit, kept so a future B2 stays comparable);
  - **A0:** `.arc/roles/<owner>.md` `owns:` an *unrelated* surface (docs), no mention of retry, no `paths:`;
  - **A:** `owns:` covers the retry path in prose; no `paths:`;
  - **B1:** identical to A **plus only the `paths: src/retry/**` block**;
  - `.arc/roles/worker.md` — the trial session's charter, identical and neutral in all arms.
- **Task prompt, identical in all arms, names the problem, never a file or a doer:** *"retry accounting is inconsistent across the retry path — make it consistent."* Delivered as the birth packet.

## Spawning — the fork-contamination control (03e16b0)

Since 03e16b0, staffing a peer FORKS the caller (`--resume <caller> --fork-session`, inheriting context+model+effort). A trial spawned from research's or code's session would be born knowing the experiment. Therefore:

1. Trial sessions are **COLD-BIRTHED**: the delegate is issued from a caller with **no persisted conversation** (`src/arc-invite.js:275, 287, 433-435` — from=null → no `--resume`, no fork; supported on purpose).
2. **Pre-flight (once):** dry-run the launcher with the test spawn-recorder (`staffRole` opts.spawn) and assert the built command contains **no `--resume`** in either arm.
3. **Per-trial integrity:** the trial transcript's opening entries must contain nothing from any experimenter conversation; any inherited content = trial VOID.
4. Cold birth inherits nothing (inheritance was a consequence of `--resume`) → **pin model, effort, account explicitly at launch**; record per trial. Birth passes `--permission-mode auto` — constant across arms.

## Held constant (from the review, unchanged)

- **Owner LIVE and idle in all three arms**: one parked owner session per arm repo, chair claimed, never prompted, never `arc join`ed, never replies — so `arc delegate <owner>` stays an ungated free note and never trips the spawn gate (`src/arc-pretool-hook.js:130`). A0's owner is just as live and rostered — only its declared duty differs.
- **Board hygiene per trial:** ledger, cursors, request-tracking, and the trial session's claim wiped; work tree git-restored; owner's claim intact. Equivalent to pristine.
- **Interleave arms** (A,B1,A,B1,…), same hours, pinned account+model.

## Outcomes (predefined)

- **Primary (binary, identical both arms):** the trial session runs `arc delegate <owner>` **or** `arc note <owner> --kind request` before declaring done. Read from the board ledger — never self-report.
- **Secondary (graded):** owned-file edits made by the session itself (count, from transcript tool calls); turns-to-first-deference; whether the owner's duty file was ever Read (transcript) — this last one tells us *why* B1 moved or didn't.
- **Mixed behaviour** (edits AND defers, in either order) = deference for the primary; reported separately.
- **Void (symmetric, predefined):** session neither touched the owned area nor deferred; harness fault; contamination per spawning rule 3. Voids are replaced, and the void count is reported.

## Cost (amended)

15 trial sessions (5/arm × 3) + 3 parked owners = **18 sessions**, small fixture task each — approved by the human as the "~17" 3-arm option (the +1 is the third parked owner, stated here rather than absorbed). Escalation ceiling: +10 total, one step, one contrast. Quota go/no-go was the human's and they gave it.

## What "tested" means for B1 here (unchanged)

This machine does not parse `paths:` (`src/arc-duty.js` is pre-3b0a124), so in B1 the block acts as readable text in the owner's duty file — exactly the no-hook mechanism. The roster one-liner (built from `owns:`) is identical in A and B1 by construction; the block is visible only to a session that Reads the duty file, and whether it ever looks is measured (duty-file-Read secondary).
