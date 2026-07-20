---
name: arc-role
description: "Claim a board role, or see who am I and who else is here (bare)"
argument-hint: "[role]"
disable-model-invocation: true
---

arc's hook handles /arc-role before the model runs. On a FRESH role claim it deliberately lets
this turn through so the model can arm the board listener — in that case an [arc] context block
is injected this turn: FOLLOW IT exactly (arm `arc join $1` via run_in_background: true, adopt
the charter, stand by in one line).

If there is NO [arc] context above, the hook did not run: run `arc role $1` in this session's
shell, follow what it prints, and suggest `arc doctor`. (If `$1` above reads literally —
unsubstituted — bare `arc role` prints the role this session already holds; join as that.)
