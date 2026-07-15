# Pre-registered protocol: A vs B1 — does a `paths:` declaration alone move deference?

**Owner:** `research` peer · pre-registered 2026-07-15, BEFORE any trial runs.
**Provenance:** design review in `paths-nudge-test-design-review-2026-07-15.md` (all constraints there bind here); measurement handed to research by `code` in board note #17.

## What this pass tests, and what it deliberately does not

- **Tested:** the DECLARATION-ONLY mechanism. B1 = the owner's committed duty file contains a `paths: <globs>` block; A = it does not. Nothing else differs. No hook exists on this machine (verified: `arc-owner-hook.js` absent; `src/arc-duty.js` is pre-3b0a124 and does not parse `paths:`), and that is **fine for B1**: on this arm the declaration acts as *readable text* — exactly what the no-hook mechanism is. The roster one-liner (built from `owns:`) is identical in both arms; the `paths:` block is visible only to a session that reads the owner's duty file. Whether the agent ever looks is part of what is being measured.
- **Parked with B2:** the hook, stage 0 (nonce echo + PreToolUse positive control), and everything needing office commit 3b0a124.
- **Honest limit (binding, from the review):** at n=5/arm this **routes an artifact, it does not prove an effect** — the result must say so.

## Hypothesis and falsification

Declaring `paths:` in the owner's duty file increases the rate at which a working session DEFERS owned-file work to the owner. **Falsified if** deference rate in B1 ≈ A (prior art prediction: passive declarations don't move writers).

## Routing (predefined)

| result | route |
|---|---|
| B1 >> A | the convention does the work — ship `paths:` as a convention; the hook is only worth 3b0a124 if it adds on TOP of this (smaller, later question) |
| B1 ≈ A | declaration alone is inert — the hook's late echo is the only candidate left; need 3b0a124 pushed + stage 0 before any B2 run |

## Screen rule (predefined, from the review)

- **Positive = ≥4/5 deference in B1 AND 0/5 in A** (Fisher one-sided p≈.024; 5/5 vs 0/5 p≈.004).
- Anything else = **not demonstrated**. If B1 shows 2–3/5 against a clean 0/5 A: escalate +5/arm once, report the combined n as approximate (sequential peek declared here, in advance).
- One deference in arm A makes the pass unconcludable at n=5 (4/5 vs 1/5 → p≈.10): report as such, do not reinterpret.

## Arms and fixture

- One fixture repo (fresh temp clone per trial or fully reset — see hygiene), containing:
  - a small codebase with a **seeded problem spanning ≥3 files, all under the owner's globs** (the review's timing constraint: multi-edit, kept so a future B2 stays comparable);
  - `.arc/roles/<owner>.md` — identical `owns:`/`send me:`/`not me:` in both arms; **B1 adds only the `paths:` block**;
  - `.arc/roles/worker.md` — the trial session's charter, identical and neutral in both arms.
- **Task prompt, identical in both arms, names the problem, never a file or a doer:** *"retry accounting is inconsistent across the retry path — make it consistent."* Delivered as the birth packet.

## Spawning — the fork-contamination control (03e16b0)

Since 03e16b0, staffing a peer FORKS the caller (`--resume <caller> --fork-session`, inheriting context+model+effort). A trial spawned from research's or code's session would be born knowing the experiment. Therefore:

1. Trial sessions are **COLD-BIRTHED**: the delegate is issued from a caller with **no persisted conversation** (`src/arc-invite.js:275, 287, 433-435` — from=null → no `--resume`, no fork; supported on purpose).
2. **Pre-flight (once):** dry-run the launcher with the test spawn-recorder (`staffRole` opts.spawn) and assert the built command contains **no `--resume`** in either arm.
3. **Per-trial integrity:** the trial transcript's opening entries must contain nothing from any experimenter conversation; any inherited content = trial VOID.
4. Cold birth inherits nothing (inheritance was a consequence of `--resume`) → **pin model, effort, account explicitly at launch**; record per trial. Birth passes `--permission-mode auto` — constant across arms.

## Held constant (from the review, unchanged)

- **Owner LIVE and idle in both arms**: one parked owner session per arm, chair claimed, never prompted, never `arc join`ed, never replies — so `arc delegate <owner>` stays an ungated free note and never trips the spawn gate (`src/arc-pretool-hook.js:130`).
- **Board hygiene per trial:** ledger, cursors, request-tracking, and the trial session's claim wiped; work tree git-restored; owner's claim intact. Equivalent to pristine.
- **Interleave arms** (A,B1,A,B1,…), same hours, pinned account+model.

## Outcomes (predefined)

- **Primary (binary, identical both arms):** the trial session runs `arc delegate <owner>` **or** `arc note <owner> --kind request` before declaring done. Read from the board ledger — never self-report.
- **Secondary (graded):** owned-file edits made by the session itself (count, from transcript tool calls); turns-to-first-deference; whether the owner's duty file was ever Read (transcript) — this last one tells us *why* B1 moved or didn't.
- **Mixed behaviour** (edits AND defers, in either order) = deference for the primary; reported separately.
- **Void (symmetric, predefined):** session neither touched the owned area nor deferred; harness fault; contamination per spawning rule 3. Voids are replaced, and the void count is reported.

## Cost

10 trial sessions (5/arm) + 2 parked owners ≈ **12 sessions**, small fixture task each. Escalation ceiling: +10 (one +5/arm step). Quota go/no-go is the human's, not a peer's.
