# Research brief — <one line>

<!-- Copy this to a run dir (e.g. docs/inquiry/<topic>/GOAL.md), fill it in, then invoke the
     inquiry skill pointed at it. The loop reads THIS to know its job. Only
     `direction` is strictly required; everything else has a sensible default. -->

## Background
<!-- What the loop needs to know: the project, the state of the art, prior work,
     links/files it should read first. The seed quality caps the output quality —
     a vague background produces confident vagueness at scale. -->

## Direction  (required)
<!-- What to research, and what "good" looks like here. Be specific about the
     verification rubric: what makes an answer valuable — evidence, novelty,
     falsifiability, applicability. -->

## Limiter  (optional — but this is what unlocks breakthrough mode)
<!-- The concrete ceiling you keep hitting, stated as an enemy to attack — NOT
     "make it better". e.g. "the agent can't recover from a wrong action without a
     human" or "latency floor is ~N ms and it kills the UX". Named limiter =
     the loop can hunt the assumption behind it. -->

## Temperament
incremental        <!-- incremental (default, rigorous, maps to your approach) | breakthrough (cross-domain, assumption-inverting, higher noise) -->

## Escalation
escalateBar: 0.7   <!-- 0..1 significance a finding must clear to interrupt you (raise = fewer pings) -->
maxEscalationsPerRound: 1
<!-- This limits interruptions within each round; it does not terminate the whole run. -->
<!-- After run 1, tell the loop "that was noise / you should've asked me about X" —
     that feedback IS the tuned bar. Don't theorize it up front. -->

## Budget
maxRounds: 8
stopAfterDryRounds: 2   <!-- consecutive rounds with no new grounded finding -> done -->

## Run dir
docs/inquiry/<topic>/    <!-- FIXED parent: ALL run output stays under docs/inquiry/. You only name the <topic> slug; never relocate the parent (keeps the footprint one .gitignore rule). -->
