# Claude Code Runtime

Use this adapter only when Claude Code exposes native `Workflow`, `/loop`,
`ScheduleWakeup`, `AskUserQuestion`, and notification capabilities.

When the human explicitly requests a credentialed CLI compatibility check, use
`reference/live-smoke.md`. The diagnostic does not replace a native Workflow round test.

## Round

Resolve `<SKILL_ROOT>` to the directory containing this canonical `SKILL.md`. Run the
engine with its existing arguments after acquiring the writer lease in
`reference/run-state.md`:

```
Workflow({ scriptPath: '<SKILL_ROOT>/workflows/round.js',
           args: { brief, direction, limiter, ledgerSummary, temperament, angles, escalateBar,
                   roundId: '<state.runId>:<next-attempt>' } })
```

Verify that the diverge agent received the complete brief. Treat the engine response as the
normalized result in `SKILL.md` §1; do not replace its separate skeptic phase with the
controller's own judgment. The response includes an additive canonical `trace`. When process
launch is available, serialize the response under the run directory, validate it with
`node <SKILL_ROOT>/scripts/inquiry-conformance.js claude path/to/result.json`, then remove that scratch
file. A validation failure is a controller error and must not touch the ledger or count as dry.
Record the validated result through the `reference/run-state.md` procedure before continuation
or termination.

## Continuation and escalation

- A round normally takes 3-6 minutes. Tell the human to use `/workflows` for live status.
- Schedule the next round with `ScheduleWakeup` after roughly 120-270 seconds when nothing
  else is pending; use a longer delay when idle.
- On an escalation, write the ledger, then use `AskUserQuestion` and a notification.
- If the human is detached, re-check after a wakeup. Take a safe default only for a reversible
  fork; wait on an irreversible one.
- On a legitimate stop, call `ScheduleWakeup stop:true` after writing `SUMMARY.md`.
