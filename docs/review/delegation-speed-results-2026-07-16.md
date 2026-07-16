# Results: does delegating make the work finish FASTER? — 2026-07-16

**Protocol:** [`delegation-speed-protocol-2026-07-16.md`](delegation-speed-protocol-2026-07-16.md) (+ Amendments 1–2). Harness: [`delegation-speed-harness/`](delegation-speed-harness/). Run: round 2, load-controlled, hidden spawn, 15 caller trials, **3 void/censored**. Round 1 was voided for a machine-load confound (Amendment 2); this is the clean pass on an audited clock.

## ⚠ SCOPE — 2026-07-16 (the human's reframe, board #118; verified in source). **This study measured the regime arc mostly does NOT use.**

**Nothing below is wrong; it is about the wrong case.** Every number here — the 1.78×, the skill stall, the backlog tax, the owner wake, the "comprehension" — was measured on agents that **had never seen this codebase**. arc's *primary* path is the one we never ran once.

- **arc's design, verbatim** ([`arc-invite.js:10-13`](../../src/arc-invite.js)): *"REVIVE — the role was held before and its own conversation still exists → resume THAT, with **no `--fork-session`**. It comes back as **ITSELF**: everything it learned, still there… **This is the one that matters** — accumulated context is the entire reason a peer beats a subagent."*
- **what we actually ran:** the warm arm calls `birthOwnerWarm` → `requestDelegate` on a role that had never existed → a **fresh, cold, amnesiac** session per trial. The cold arm spawned fresh too. **`REVIVE` was never exercised — not once.**

So **1.78× is the WORST CASE**: a fresh router handing to a fresh owner. There are **three** states, and we measured one:

| state | context | process | measured? |
|---|---|---|---|
| **FRESH** | knows nothing | cold | ✅ this study (both arms) |
| **LIVE** | hot, listener armed | warm | ❌ ([standing-expert protocol](standing-expert-protocol-2026-07-16.md), blocked) |
| **REVIVED** | **restored from disk** | **cold** | ❌ **arc's real path** |

A revived owner skips all three arc taxes **by construction** — skill already in context, cursor already advanced, code already comprehended — paying only process boot (~7s) + model first turn (~9s).

**The open question, and it cuts both ways:** a revived peer resumes a *large* conversation and therefore pays **prefill over all of it**. Revive trades *comprehension* cost for *context* cost, and **we have measured neither**. If prefill is cheap, revive collapses the hand-off tax and the reuse design wins outright. If prefill scales with history, **a peer gets slower the more it knows** — and "reuse beats spawn" has a ceiling nobody has seen, with the ugly corollary that arc's most experienced peers would be its slowest. (Plausible modifier, **unmeasured, do not assume**: prompt-cache TTL may make revive *bimodal* — cheap within the cache window, full prefill after — which would fit the fat-tail pattern below rather than contradict it.)

**Everything below stands, scoped to: N=1, fresh→fresh delegation, on a task one agent can do with a ~0–9s solve.**

## ⚠ RETRACTION 2026-07-16 (board #99, verified by research #100): warm N=3 is GHOST DATA

**The N=3 warm-delegation numbers below (189.4s median, "2.6× slower", "curves diverge") are INVALID and retracted.** Verified from transcripts: **both N=3 warm workers issued NO delegation at all** (`WORKER_ROUTED=NO`; the N=1 workers all routed at real timestamps). The owner edits scored into those trials were not caused by this worker routing — they are a harness leak. **Mechanism, verified (research #102, correcting the #99 first guess):** ONE **orphaned zombie worker** — session `9fa28d80`, born in aborted trial 4 at 05:01:44 — **survived the trial's VOID** (the harness `process.exit(3)`'d without reaping the late-spawned worker) and then delegated to the *fresh* owners of trials 5 (05:05:12–52) and 6 (05:10:13–16), dying only at 05:12:32. Both N=3 "data points" are that one ghost. The owners were **innocent** — they obeyed their park instruction and edited only when the ghost's note arrived; the fresh trial-5/6 workers routed nothing. The oracle (a **state** check — "tests pass" — not **causal**) is the *second* lock: it let the ghost's work be counted. The self arm is immune (its agent dies with its trial), so only the deleg arm rotted. **What is retracted:** warm N=3 = 189.4s, the ~2.6× at N=3, and "the curves diverge." **Delegation at N>1 is UNMEASURED, not measured-and-slow.** **What SURVIVES (clean):** warm N=1 133.0s vs self N=1 74.6s → **1.78× at N=1 stands**; self-flat (one agent, 3 bugs at N=1 cost, 74.6→73.7) stands on verified edits; the axis-3 / re-profile findings are N=1-based and stand. **Two locks owed before any N=3 re-run, in order:** (1) **REAP ON VOID** — the void path must kill the spawn by claim pid (never leave a spawn you cannot see; a late orphan with a task packet *works*, indistinguishably from a real worker). `arc close` does this as of a9aff30. (2) **CAUSAL ATTRIBUTION** — count only an edit whose author *started after* `t_start` (the same `procStart < claim.at` genuineness test arc already uses for chairs). Lock 1 is first because without it every re-run can be re-ghosted.

## Headline (as originally written — N=3 clauses now retracted, see banner above)

**Delegation does NOT finish faster at N=1** (1.78×, clean). ~~and the gap widens with N~~ — retracted; N>1 unmeasured. The deeper finding — *why* a lone agent is hard to beat — survives via the self arm, not the warm arm.

## Tallies (verified wall-clock, seconds; delegated = worker made 0 edits & an owner did)

| regime | N=1 (retry / money / parse) | N=1 median | N=3 (per rep) | N=3 median |
|---|---|---|---|---|
| **self-fix** | 76.7 / 50.6 / 74.6 | **74.6** | 67.6 / 73.7 / 81.7 | **73.7** |
| **warm delegate** (live ● owner) | 250.2 / 103.9 / 133.0 | **133.0** | 161.6 / 217.2 / (void) | **~190** |
| **cold delegate** (closed ○ owner) | *censored* / 84.5 / *censored* | — | not run | — |

Delegation is **~1.8× slower at N=1** (133 vs 74.6 median). ~~and **~2.6× slower at N=3** (190 vs 73.7); the curves *diverge*~~ — **RETRACTED (ghost data, see banner): warm N=3 measured no worker delegation. N>1 is unmeasured.**

## The real finding: self-fix doesn't scale with N, so there is nothing for parallelism to beat

**Self-fix N=3 (~74s) ≈ self-fix N=1 (~67s).** One worker fixing *three* seeded bugs took about the same wall-clock as fixing *one*. Because these fixes are cheap (~7s of edit each) and **boot+orientation dominates (~57s)**, a single agent amortizes its *one* boot across all N tasks. Delegation, by contrast, pays a wake/hand-off cost **per owner**, so it *grows* with N. ~~[the N=3 measurement of this is ghost data — RETRACTED; the "grows with N" claim is now a prediction, not a result]~~ The crossover the study set out to find **exists only when per-task WORK is large relative to boot/hand-off** — i.e. for *expensive* tasks. For quick fixes it does not exist: a lone agent's single amortized boot always wins.

**Design consequence for arc:** "delegate above N independent tasks" is the wrong rule. The rule is **"delegate when each task's work dwarfs the ~60s boot+hand-off, regardless of N."** Ownership-nudging a caller toward delegation on a batch of small fixes makes the work *slower*.

## Secondary findings

- **Parallelism is real — the single-account bucket did NOT serialize.** Concurrency factor at warm N=3 was **2.81 and 2.69 out of 3** — the three owners ran ~90% in parallel on one API-key account. `research`'s round-1 fear (a shared `whale` bucket serializing owners → crossover ∞) is **disconfirmed**: parallelism worked; it just had no serial cost to beat.
- **Warm delegation is reliable; cold delegation is not.** Warm (owner is a live ● peer, delegate = a free note) delegated **3/3** and completed every time. Cold (owner is a closed ○ chair, delegate = a *spawn*) **never produced a completed hand-off**: one worker self-fixed (money, 84.5s), one ran `arc delegate` to the closed chair and the spawn **hung** (parse, censored), one got stuck reading `arc delegate --help` (retry, censored). So the ●/○ difference is **partly** the agent noticing a warm chair and **partly** that spawning a cold chair is flaky and slow — the two are confounded here, and the honest read is "warm hand-off is cheap and reliable; cold hand-off is neither."

## Controls held (this is why the numbers are defensible)

- **Load was low-moderate and auditable:** CPU mean 6–35% (mostly <27%), recorded per trial. `code` held to going-light; no spike coincided with a slow arm — the 250s warm-retry outlier ran at **13.4% CPU**, so its slowness is genuine variance, not load.
- **No hidden-scheduler penalty detected:** self N=1 baseline (~67s) matched round-1's 63–69s, so the hidden-window spawn did not systematically drag wall-clock. (Reported to `code` per its watch-request.)
- **Randomised arm order** (seed 0x5eed16) put load on arms symmetrically.

## Disclosures / limitations

1. **3 void/censored of 15:** two cold-spawn failures (above) and one warm-N=3 worker that never spawned (`chair never filled`) — a spawn-reliability issue under the hidden spawn, ~1/15 for the worker spawn itself.
2. **The fixture bugs are trivial by design**, which is exactly what precludes a crossover. To *find* N\*, the experiment must be re-run with **expensive** per-task work (fixes that take minutes, not seconds) so self-fix's serial cost grows. That is the natural next study.
3. **Cold N=3 was not run** (essential-tier scope); the cold arm's N=1 unreliability makes an N=3 cold measurement low-value until the spawn flakiness is fixed.
4. Warm N=1 retry (250s) is a high outlier on a small n; medians are reported alongside.

## Phase breakdown — where the ~133s actually goes (from transcript timestamps, [`profile.js`](delegation-speed-harness/profile.js))

Decomposing the warm-delegation wall-clock into phases (N=1, seconds):

| phase | money (104s) | parse (133s) | retry (250s, outlier) |
|---|---|---|---|
| worker cold boot | 16.8 | 12.2 | 17.9 |
| **worker orient + understand + decide to hand off** | **62.3** | **88.5** | 86.7 |
| owner wake (listener fires → owner acts) | 21.7 | 17.0 | **92.9** |
| owner re-orient + re-read task/code | ~0 | 8.0 | 47.8 |
| **owner solve (the actual edit)** | **0** | **0** | **0** |
| report back + verify (to oracle) | 3.1 | 7.3 | 5.0 |

**The solve is ~0s** (one-line fix, a single Edit). The wall-clock is almost entirely **boot + orient + understanding the task** — and delegation pays that comprehension **twice**: the worker must understand the task well enough to *route* it (~60–90s, ≈ what a self-fixer spends), then the owner **wakes** (~20s) and **re-understands** it to *do* it. The hand-off does not save the expensive part (comprehension); it duplicates it and adds a wake — to parallelize the one phase that is currently free. The 250s outlier is explained: its owner-wake was 93s vs the ~20s norm (a slow listener fire), not extra work. (N=3 worker-orient is null in the profiler — the multi-delegate command wasn't matched; N=1 carries the finding.)

**This is the mechanism behind the headline:** the only phase delegation can parallelize is *solve*, and for cheap tasks solve ≈ 0. Make solve expensive (minutes) and it becomes the dominant term done in parallel — which is precisely where the crossover would appear.

## Re-profile: LOCATE vs COMPREHEND within the worker orient phase (2026-07-16, research; script [`reprofile-locate-vs-comprehend.js`](delegation-speed-harness/reprofile-locate-vs-comprehend.js))

Tests `code`'s follow-up hypothesis (board #94): route on cheap *location* (which file) without paying *comprehension*, so comprehension happens once at the owner instead of twice. Splits the fused worker orient phase (firstTool→delegate) into LOCATE (→ owning file first touched) vs the COMPREHEND tail. From the 3 clean N=1 warm-delegated transcripts (N=3 unprofiled — the multi-delegate command form is unmatched, same gap as the base profiler):

| trial | orient | LOCATE (→file) | COMPREHEND tail | greps | packet |
|---|---|---|---|---|---|
| retry | 86.7s | 24.9s (29%) | 61.8s | 0 | comprehended (backoff.js line-ref, 665c) |
| money | 62.3s | 39.9s (64%) | 22.4s | 0 | comprehended (tax.js:2/:4, 379c) |
| parse | 88.5s | 27.0s (31%) | 61.5s | 1 | comprehended (csv.js:4, 453c) |

**Settled:** the double-comprehension is *real* — **every** hand-off was a comprehended diagnosis with line-number root cause; **zero blind routes**. Workers understood the fix before routing. So the owner's cheap 0–8s re-orient (§Phase breakdown) was **bought** by that packet; routing blind moves the 60–90s comprehension to the owner rather than deleting it. The entanglement holds on data, not just argument.

**NOT settled, and it is a fixture confound not a verdict on the idea:** locate looks cheap here (median 31%; 2 of 3 workers reached the file with **0 greps**) **only because the fixture area-names give away the filename** — retry-cap→`backoff.js`, money/tax→`tax.js`, parse/csv→`csv.js` — and each bug is **single-owner**. That is the easy case the hypothesis needs, and the opposite of the paths-nudge fixtures (cross-cutting, "spills into `client.js`"). So 31% is a **lower bound** on locate cost and comprehension is still the majority; on a non-obvious or multi-owner bug, locate grows and severability shrinks. Existing data cannot greenlight the build. The cheap next probe (before any spawn-experiment): a **locate-ablation** — can an agent name the correct owning file from the task *without* reading to comprehend? — answerable by a subagent for pennies, but **not on these fixtures** (their names pre-answer it).

**Two follow-up checks (board #97), both negative-for-the-lever but on thin data:**
- **Amortization (code's marginal 28.2s/task at N=3):** directionally real as a wall-clock (warm N=1 133 → N=3 189.4, n=2) but its *attribution* to worker-side comprehension amortizing is **unverified** — the N=3 warm worker transcript (`bc99ddc4`) shows **no `arc delegate`/note-to-owner command**, only role/notes/join/orient; the 3 owners were pre-parked warm and received tasks by a path the worker transcript does not show. So 189.4 may reflect **3 pre-parked owners running in parallel** (owner-side), not one worker comprehending three tasks. The lever dies more cleanly on **axis 3 at N=1 (proven)** than on this N=3 arithmetic.
- **H2 (owner re-orient ∝ packet digestion):** **underpowered and one point contradicts** — n=3 owner re-orients are 0 / 8 / 47.8s, and the *slow* 47.8s owner received the *most* digested packet (the 665-char `backoff.js` diagnosis). The fast 0/8s re-orients are consistent with digestion helping, but no correlation survives n=3 with a contrary outlier. Logged as not-supported, not as refuted.

## THE ANSWER: where the 1.78× actually lives (2026-07-16, boards #113–#118, independently reproduced)

The gap is **not** comprehension, **not** the peers-skill stall, **not** locate. Decomposing warm money (103.9s) against self money (50.6s) — a 53.3s gap:

| half | cost | what it is |
|---|---|---|
| **router overhead** | **+28.5s** | the worker's phase to the hand-off (79.1s) exceeds the self-fixer's **entire job** (50.6s). The router **surveys** (`Get-ChildItem -Recurse src`) where the fixer **aims** (`Grep withTax`), reads deeper, and **authors a packet** (17s vs a 9s Edit). |
| **hand-off** | **+24.8s** | owner wake 21.7s + report 3.1s — paid only by delegation. |

**The wake splits half-and-half** (delegate→owner turn = arc; turn→first tool = model):

| bug | ARC | MODEL | total |
|---|---|---|---|
| retry | **86.1s** | 6.8s | 92.9s |
| money | 6.7s | 15.1s | 21.7s |
| parse | 8.3s | 8.7s | 17.0s |
| **median** | **8.3s** | **8.7s** | 17.0s |

So ~9s is **irreducible model latency** and ~8s is **arc's, and fixable** — but the 92.9s outlier is **86.1s of arc**, 10× the median.

**What each fix buys (pre-registered by `code` before building; arithmetic verified):**

| fix | median ratio |
|---|---|
| nothing | 2.05× |
| skill stall only | **2.04×** — moves 0.01× |
| arc wake only | **1.92×** |
| both arc fixes | **1.51×** — real, and *not* a collapse |

**The real product of the study — arc's overhead is a FAT TAIL, not a big mean.** Skill stall 0.5→48.3s (**97×**); arc wake 6.7→86.1s (**13×**). Both medians are single-digit-to-low-teens; both tails are catastrophic. That is why delegation *feels* unreliable and why every average hid it. The build is therefore **variance work, not speed work**: a cost you can predict is budgetable; a 97× tail is not.

**The floor.** Even with *perfect* arc (zero stall, zero arc wake), delegation still pays a router that must explore and read enough to route, plus ~9s of irreducible model wake. Median lands **1.51×** and never reaches parity — though the best case (parse) reaches **1.04×**, i.e. parity within noise, so the floor is a *slope*, not a wall. **Scope it honestly:** this holds for **N=1, on a task one agent can do, with a ~0–9s solve**. N>1 is unmeasured (ghost data); expensive-solve is untested. Those are the only unexplored escapes, and both are different claims.

## Verdict for arc

- **Delegation loses for cheap tasks at every N tested.** Do not nudge a caller toward handing off small fixes — the ~60s boot/hand-off tax dominates and self-fix amortizes its own boot.
- **The lever should key on task COST, not task COUNT.** N is not the variable; per-task work-vs-boot ratio is.
- **Warm > cold** decisively: a live standing team makes hand-off a cheap note; spawning a cold owner is slow and, here, unreliable. If arc leans on delegation, it should lean on *warm* peers.
