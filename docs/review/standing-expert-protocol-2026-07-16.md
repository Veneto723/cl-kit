# Pre-registered protocol: does an agent's comprehension survive *between* tasks?

**One question:** when a second task arrives at a still-live agent in the same area, does it pay comprehension again (~60–90s) or is it nearly free (~solve only)? That single fact decides whether delegation can *ever* beat self-fix — and nothing measured so far answers it.

**Status:** pre-registered 2026-07-16, **before any trial**. **⚠ BLOCKED — do not run (board #106, arithmetic verified by research #107).** Nothing run, nothing spent. Author: `research`. Prior art: `delegation-speed-results-2026-07-16.md`, `paths-nudge-ab-protocol-2026-07-15.md` (both studies closed; docs retired 2026-07-18, git history has them).

> **WHY BLOCKED — an expert owner cannot pay, alone.** Verified on the median (parse, 133.0s) trial: the owner's **entire** serial contribution is wake 17.0 + re-orient 8.0 + solve 0 = **25.0s**. Grant the hypothesis everything — a *perfect, instant, free* owner — and delegation still costs **108.0s vs self-fix 74.6s: 33.4s worse**. The **worker phase alone** (boot 12.2 + orient 88.5 = **100.7s**) already exceeds a complete self-fix by 26.1s; the owner is pure addition on top. So "expert owner" only pays *via* **blind routing** (deleting the worker's orient), which needs **cheap locate** — unproven and fixture-confounded. **This protocol is downstream of the blind-route lever, not independent of it.**
>
> **AND RETENTION, IF REAL, HELPS SELF-FIX MORE.** The "cheapest cut" here (one agent, task A then B, no delegation machinery) **is a self-fixer**. Self-fix = one standing agent retaining *every* area; delegation = N owners each retaining a *slice*, plus a router that still comprehends. If retention holds, **both arms speed up and the ratio barely moves** — this measures a property of *live agents*, not an advantage of *delegation*. **The test's real value is asymmetric:** a NEGATIVE result kills the idea cheaply; a POSITIVE one only unlocks a second, expensive test.
>
> **GATE — run the locate-ablation first** (spec'd in the retired delegation-speed results; free, a subagent): expensive locate → blind routing dead → expert-owner cannot pay → these 16 sessions never happen. Cheap locate → retention finally has a payoff route.
>
> **FIXTURE BLOCKER — the seeded bugs LABEL THEMSELVES** (`build-fixture.js`, retired harness): `// BUG: the cap is documented but never applied`, `// BUG: returns fractional cents, not rounded`, `// BUG: fields keep surrounding whitespace`. An agent does not comprehend these — it **reads a label**. That is an over-delivery magnet, it makes retention **under-detect** (task 2 needs no retained comprehension when the bug announces itself), and combined with giveaway filenames (retry→`backoff.js`) it means **locate and comprehend are BOTH pre-answered**. Strip the labels and de-giveaway the names before *any* test here, including the ablation.
>
> **OPEN QUESTION THIS RAISES (research #107):** if the bug is labelled *and* the file is named for it, **what is the 62–88s "worker orient" actually spent on?** It cannot be comprehending code that announces its own fix. Candidate: per-agent **orientation ritual** (role claim, board read, task read, verify, author the packet) — a fixed *startup* cost, not codebase comprehension. Testable for free on honest fixtures: if orient stays ~60–90s once labels and giveaway names are gone, it was **never comprehension**, and the whole "comprehension dominates" model needs renaming.
>
> **A REAL-WORLD COST THE FIXTURE NEVER CAPTURED (raised by the human, measured on this board):** every agent claiming a role **ingests the board backlog**. On the live `arc` board that is **17 broadcasts ≈ 4,868 chars** of commit announcements, done-markers and doc broadcasts — none addressed to the newcomer, none about its task. (A `quiz` chair independently reported ~19 such notes.) It **grows without bound**: the post-commit hook auto-broadcasts every commit. The delegation-speed fixtures used **FRESH boards (~1 note)**, so this tax is absent from the 62–88s orient — meaning **the measured 1.78× delegation tax is a FLOOR, not a ceiling**: on a mature board every *newly spawned* peer pays backlog ingestion on top, while a *reused warm* peer has already paid it and its cursor has advanced. One more reason the lever is **reuse**, not spawn.

| | |
|---|---|
| **Hypothesis (H-retention)** | A live agent's 2nd task in an area it already comprehends costs ≈ *solve only*. |
| **Falsified if** | 2nd task ≈ the cost of a fresh agent's 1st task on the same bug. |
| **Arms** | **EXPERT**: live agent does bug A, then bug B. **FRESH**: new agent does bug B as its 1st task. |
| **Primary** | wall-clock, task-sent → oracle-pass, for **the same bug** in both arms. |
| **Decides** | whether standing *expert* owners are the speed lever, or comprehension is re-paid forever. |

## The gap this fills

- **Proven** (delegation-speed study, doc retired): 3 bugs handed to one agent **in one batch** = the price of 1 (73.7s vs 74.6s). Comprehension is a fixed cost **per agent per codebase**, not per task.
- **Unknown:** 3 bugs arriving **separately, minutes apart**, at one live agent — price of 1, or price of 3?

That second case **is** the delegation pattern (tasks trickle in to a standing owner). Every warm owner we measured was **alive but amnesiac** — freshly born, comprehending nothing — which is why they needed the worker's pre-digested packet, and why blind routing died on axis 3. Nobody has measured an owner that *already knows its area*.

## Design

- **Fixture:** both bugs seeded at trial start, both under `src/retry/**`, independent, different files/symptoms, comparable size (e.g. **A** = delay cap not applied in `backoff.js`; **B** = attempt accounting off-by-one in `attempts.js`/`log.js`). Tests per bug are the oracle.
- **EXPERT arm:** one agent, live throughout. Task 1 = bug A (tightly scoped). On oracle-pass, task 2 = bug B, **same live session, no restart, no repo reset**. Measure **T2** = task-2-sent → bug-B oracle-pass.
- **FRESH arm:** a new agent, cold, gets bug B as its **first** task. Measure **T1_fresh**. (Existing self-fix N=1 = 74.6s is a cross-check, but the fresh arm is re-run on the same clock — never compare across days/load.)
- **Counterbalance:** half the trials run **B then A** with the fresh arm on A, so each bug is measured in both positions. Otherwise "task 2 is faster" may only mean "bug B is easier."
- **n:** 5 per order (10 EXPERT trials) + 6 FRESH (3 per bug). The predicted effect is large (≈7–20s vs ≈75s), so this is a **magnitude** comparison on medians with all points reported — not a binary screen.

## Decision rule (predefined)

| observation | read |
|---|---|
| median **T2 ≤ 0.4 × T1_fresh** | **RETENTION HOLDS** — comprehension survives between arrivals |
| median **T2 ≥ 0.8 × T1_fresh** | **NO RETENTION** — comprehension is re-paid per task |
| in between | **AMBIGUOUS** — report as partial; one escalation of +5 EXPERT trials, then stop |

**Mechanism check (secondary, and it can contradict the clock):** did the agent **re-read the source** for task 2, or go straight to the edit? Straight-to-edit = comprehension genuinely persisted. Full re-read that is merely *fast* = something else (cache, familiarity), and the readout must say so.

## Routing (what the answer changes)

- **RETENTION HOLDS** → standing **expert** owners are the speed lever. Delegation can win *if* owners are long-lived and area-expert; arc should favour keeping peers alive over spawning fresh ones; the "delegation is slower" verdict is then true only of **amnesiac** owners, and the N>1 question reopens (behind both locks).
- **NO RETENTION** → every hand-off re-pays comprehension forever. Self-fix wins permanently for anything but huge per-task work; **stop investing in routing/ownership speed levers** — the rule stands unqualified: *delegate when the WORK dwarfs the boot.*

## Controls, voids, locks

- **Identical packet shape** for task 1 and task 2 (both a bare problem statement — never a diagnosis for one and a pointer for the other), or the test measures digestion, not expertise.
- **Agent never restarted** between tasks; **no `reset --hard`** between tasks (it would wipe task 1's fix and confuse the oracle).
- **VOID (predefined, symmetric):** task 1's agent also fixes bug B (over-delivery → nothing left to measure); either oracle fails; harness fault. **Voids are replaced and the over-delivery rate is reported** — it is itself a finding.
- **Lock 1 — REAP ON VOID:** the void path must kill any spawn by claim pid. *(An orphan holding a packet works, indistinguishably from a real worker — it manufactured both warm N=3 points in the last study.)*
- **Lock 2 — CAUSAL ATTRIBUTION:** count an edit only if its author started after that task's `t_start`, and only inside that task's window. *(The oracle is a state check, not a causal one.)*
- Pin account + model; record load per trial; interleave EXPERT and FRESH.

## Honest limits (state these in any readout)

1. **Trivial fixtures** (solve ≈ 7s) — this measures comprehension *retention*, not expensive work; the expensive-solve question is still untested.
2. **"Expert" here = one prior task**, not deep expertise; retention after N tasks or across areas is unmeasured.
3. Single codebase, single model/account, single-shot per bug; context-window growth effects unmeasured.
4. Seeding both bugs at start invites over-delivery (see VOID); tight scoping mitigates but cannot eliminate it.

## Cost

~10 EXPERT + 6 FRESH trials ≈ **16 sessions**, no owner parking needed (the cheapest cut needs **no delegation machinery at all** — one agent, two sequential tasks). Quota is the human's call; nothing runs without it.
