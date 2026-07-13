# The taste layer — learning WHEN to interrupt, and WHAT to rank first

**Read this when capturing feedback or distilling the profile.** The three
non-negotiable rules are in SKILL.md and apply every round — you don't need this file to
obey them.

Persistent per user, survives skill redeploys. Resolve the user inquiry home in this order:
`INQUIRY_HOME`, an existing `~/.inquiry`, an existing `~/.claude/inquiry`, then `~/.inquiry`.

- profile: `<inquiry-home>/taste.md` (seed from `templates/taste.md` if absent)
- feedback: `<inquiry-home>/feedback.jsonl`

## Applying it (each round)

1. **Load** `taste.md`. Apply its **hard constraints** as a *post-skeptic* filter — a
   grounded, on-brief finding that violates a hard gate (e.g. "not on-device feasible")
   drops out of the human-facing list. Log it in `decisions.log`; **don't delete it.**
2. **Rank** the kept findings by significance, then **nudge** with the quality rubric. A
   working repo, an assumption-inversion, a cross-domain transplant may reorder *ties* —
   they may never *invent* significance.
3. **Escalate by EXAMPLE, not by the bare number.** For each candidate the engine flagged
   (`significance ≥ bar`), judge it against `taste.md`'s labelled YES/NO sets: *"is this
   more like the YES examples, or the NO examples?"* Surface only the YES-consistent ones,
   still within the budget. **This is how "when to bother me" becomes personal.**

## Capturing the rating — IN THE MOMENT, never by recall

**Every escalation IS a rating.** Surface it via `AskUserQuestion` whose options double as
label *and* steer:

> **[Act on it]** · **[Note it, keep going]** · **[Not worth interrupting me]**

The pick *is* the feedback — write `escalate-worthy` (Act/Note) or `escalate-noise` (the
last). One interaction, both purposes, zero extra bother.

**Recall check at the digest (optional, one tap).** At run end, list the top 3–5
kept-but-NOT-escalated findings and ask which — if any — they'd have wanted raised
(→ `missed-escalation`) or will act on (→ `acted`). That is how RECALL gets measured
without rating every finding.

Append one line per rating to `feedback.jsonl`:

```json
{"run":"<id>","finding":"<one-line>","reaction":"escalate-worthy|escalate-noise|missed-escalation|acted|ignored|limiter-picked|limiter-rejected","note":"<opt>","ts":"<iso>"}
```

Keep total asks **≤3 per run**. Revealed preference (what they act on, what they call
noise) beats a stated manifesto every time.

## Distilling (every ~5 runs, or on request)

Turn repeated `feedback.jsonl` reactions into rules, and refresh the YES/NO example sets
in `taste.md`. **Dedup** and **decay**: drop labels that are old or contradicted by newer
ones. **Curate — never let the profile grow append-only.** Log the distillation in
`taste.md`'s changelog.

If the profile and fresh feedback conflict, **trust the fresh feedback.** Taste drifts.
