# Bootstrap — drafting the brief from the project

**Read this ONLY when the human gave you no `GOAL.md`.** If they gave you one, skip this
file entirely.

The session that has *read* the project often knows the ceiling better than the human can
state it cold. So draft a brief — then make them **validate** it before firing.

> **Never auto-fire an auto-drafted brief.** That automates
> confident-garbage-in → confident-garbage-out: a rigorous, well-sourced inquiry into the
> wrong question. The one thing worse than no research is research you trust that was
> aimed at nothing.

## 1. Scan for the ceiling

Read the project's `README`, `docs/**/*.md` (especially prior research), recent `git log`,
TODO/FIXME, and the code layout. Hunt for **recurring pain** — literal phrases like *"the
real bottleneck"*, *"the moat"*, *"can't"*, *"doesn't work when"*, or a problem raised
repeatedly across commits and docs.

## 2. Draft 2–3 CANDIDATE limiters

Not one — **force a choice, not a rubber-stamp.** A single candidate invites a lazy "yes".

Fill each into the `templates/GOAL.md` shape: ceiling · assumption-to-attack ·
what's-been-tried · falsifiable win. Cite the **specific evidence** each is inferred from
(`file:line`, a doc quote, a commit).

## 3. Present for real validation

Use `AskUserQuestion` with the evidence visible, plus **your confidence and what you're
unsure about** — so the human judges your *reasoning*, not your prose. Let them pick,
edit, or reject.

## 4. Fire only on explicit approval

Write the chosen `GOAL.md`, then run §1 of the skill.

If the scan finds **no genuine ceiling** (a thin or empty project), **say so and ask**.
Do not invent one to look useful.
