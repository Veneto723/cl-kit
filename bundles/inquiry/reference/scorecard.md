# The scorecard — so nobody has to *recall* the numbers

**Read this on request ("how's it doing?") or at run end**, once `feedback.jsonl` has ≥5
events.

```sh
node <skill-root>/workflows/scorecard.js
```

It reports, computed from the human's **in-the-moment** ratings — never estimated:

- **Escalation PRECISION** — of the times it interrupted them, the % they called worth it.
  *Low precision = you are spamming them. Raise the bar.*
- **Escalation RECALL** — of what they *wanted* raised, the % it actually surfaced.
  *Low recall = you are hiding things. Lower the bar.*
- A **tuning hint** derived from both.

Feed the hint back into `escalateBar` and into the YES/NO example sets in
`<inquiry-home>/taste.md` on the next run.

## Why it exists

The escalation bar is model self-judgment, and self-judgment drifts. The scorecard is the
only thing in this tool that measures whether the *core promise* — "it only bothers you
when it matters" — is actually being kept. Everything else is process; this is the
outcome.

Precision and recall trade off against each other. Do not chase both to 100%: a bar tuned
for perfect recall spams; one tuned for perfect precision goes silent. **Ask the human
which error they'd rather have**, and tune toward that.
