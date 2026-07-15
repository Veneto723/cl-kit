# Results: A0/A/B1 ownership-deference experiment — 2026-07-15

**Protocol:** `paths-nudge-ab-protocol-2026-07-15.md` (registered + 8 amendments, all pre-data-they-govern). Design review: `paths-nudge-test-design-review-2026-07-15.md`. Run: 24 valid trials (8 rounds × 3 arms), 2 problems interleaved (P1 accounting, P2 delay-cap), 1 void (replaced), truncated at round 8 of 10 by the human (Amendment 8, non-blind, margin-ruled).

## Tallies (primary: deference to `edge` before declaring done)

| arm | manipulation | P1 (rounds 1,3,5,7) | P2 (rounds 2,4,6,8) | total |
|---|---|---|---|---|
| **A0** | owner live, duty irrelevant (docs) | 0/4 | 0/4 | **0/8** |
| **A** | owner live, `owns:` covers retry (prose) | 4/4 | 4/4 | **8/8** |
| **B1** | A + `paths: src/retry/**` block | 4/4 | 3/4 | **7/8** |

Integrity: 24/24 valid trials cold-birth-verified at the first user turn; all trees asserted or verified pristine at launch; both launcher generations disclosed (round 1 old-path, rounds 2–8 new-path; constant within every round).

## Named contrasts (registered rules applied)

- **H-ownership (A0-vs-A): DEMONSTRATED.** 0/8 vs 8/8, Fisher one-sided **p = 1/12870 ≈ 7.8×10⁻⁵**. Margin rule: p < .001 → **the non-blind truncation is immaterial**; the claim stands at achieved n. Problems agree perfectly (0/4-vs-4/4 in each). Routing table row 3 fires (A0 LOW, A HIGH; rows 1–2 do not match).
- **H-marginal (A-vs-B1): UNTESTABLE (CEILING).** A = 8/8 = 100% ≥ the 90% ceiling threshold → **NO HEADROOM**, per the pre-registered ceiling rule: this is a *positive structural finding about A*, not a failed test of B1. For the record B1 = 7/8, difference non-significant (p=.50); per Amendment 6 this must never be read as "paths: adds nothing" — it was unmeasurable here.

## Routing decision (ordered table, row 3)

**Ownership declarations WORK, and `owns:` — the plain-prose line arc already ships — is the mechanism.** A live peer whose declared duty covers the task area flipped auto-mode workers from self-fixing (0/8 deference when the owner was irrelevant) to full handoff (8/8), across two different seeded problems, with zero mixed behaviour (every deferring worker made 0 owned-file edits and handed over a full diagnosis).

**For 3b0a124 (the `paths:` parser + PreToolUse hook): RESET, DO NOT PUSH.**
- `owns:` saturates deference in this design; any hook or parser must beat a saturated baseline to justify a permanent per-Edit/Write cost.
- The doc-confirmed timing hole stands independently: an advice-only PreToolUse nudge cannot influence edit #1.
- If `paths:` is ever to be tested on its merits, it needs a **headroom design**: a harder task, a weaker `owns:`, or graded deference — not this one re-run.

## Secondary observations (right-censored at the round cap; indicative only)

- Deference was **roster-driven, not file-driven**: A deferred 8/8 while reading the owner's duty file in only 5/8 trials; B1 read it in 4/8 and quoted the `paths:` glob in its handoff note whenever it did (3 notes cite `src/retry/**` verbatim). The 100-char `owns:` roster line was sufficient in every observed case.
- B1's single non-deference (round 8) came from a worker that never read the duty file — consistent with the glob being invisible unless fetched, and with prose-on-the-roster being the active ingredient.
- Deferring workers consistently wrote a diagnosis document and delegated with evidence ("SETTLED (do not re-derive): backoff.js:6 …") — handoffs were high-quality, not task-dumping.

## Disclosures

1. **One void, replaced** (round 3, a0): harness reset restored the work tree but not the branch pointer; a prior worker's commit left the task pre-solved. Caught from the worker's own reply, voided loudly (#41), fixed (pinned fixture SHAs, later asserted at every launch). Per the #44-corrected error model, an *uncaught* instance of this class **inflates** the headline contrast — the void mattered because it biased toward the finding.
2. **Truncation at round 8 of 10**: human-directed after seeing the round-6 tally (Amendment 8, labeled non-blind); margin rule (registered with round 8 unseen) renders it immaterial at p<.001. Rounds 7–8 were included and did carry information (the B1 miss).
3. **Launcher changed mid-run** (9edaf38): constant within every round; both paths cold-birth verified; cannot confound between-arm contrasts.
4. **External validity limits**: one fixture repo, one task domain, single-shot binary outcome, auto permission mode, one model/account, owners parked silent. "Deference" here = handing off before finishing; long-horizon behaviour untested.
5. Dispatch is harness scaffolding (synthetic session anchored to a keeper process); the worker side — birth, roster, notes — is the real shipping surface throughout.
6. Statistical readouts use Fisher exact, one-sided, per the registered rules; thresholds mapped proportionally to achieved n (HIGH ≥50%, ceiling ≥90%) as the amendment intended.

## Provenance

Full contract-negotiation and error-correction record: board notes #10–#50 (design attack → false-null control caught → timing hole doc-confirmed → routing contract D1–D3 → interim killed as unsatisfiable → ceiling rule → STRICT resolution → truncation + margin rule). Raw rows: `E:\arc-ab\harness\results.jsonl`; transcripts under the Claude projects dirs per row.
