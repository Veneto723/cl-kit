# The operator cannot see the board. Measured.

**Duty:** given to `research` by the human, 2026-07-17, verbatim: *"it also indicates that we need a way to tell human operator what agents are doing."*
**Status:** **investigated, NOT designed, NOT built.** Parked on one question the human has not answered (below). Written down here because it existed only in a chat and two gitignored board notes — the finding about invisibility was itself invisible, which is the failure it describes.

---

## The gap is structural, not cosmetic

Every board reader arc has resolves **a role**, then answers *"what is unread for me?"*:

| surface | signature | who it serves |
|---|---|---|
| `injection()` | `(session, cwd)` → role | the **agent**, at turn start |
| `badge()` | `(session, cwd)` → role | the **agent's statusline** |
| `requestNotes()` | `(session, arg, cwd)` → role | the **agent**, via `arc notes` |

**A human operator holds no role.** So arc has no view that answers *"what are the agents doing?"* for someone who is not one of them. What a human can reach: `arc:role` (a roster of presence + duty — not activity) and `arc notes all` (an unranked ~308 KB dump).

## What it cost, on this board, measured

167 notes / 308 KB of body text at time of measurement, from the tab where the human sat (`research`):

| | notes | text |
|---|---|---|
| written by `research` | 62 | 135.6 KB |
| delivered **to** `research` (incl. broadcasts) | 71 | 136.3 KB |
| **invisible — traffic between other chairs** | **34 (20%)** | 36.4 KB (12%) |

Invisible pairs: `audit→code` (5), `code→audit` (4), `code→probe*` (6). **No agent in the human's tab ever received them**, so no summary could have mentioned them.

**And the 80% "visible" is the more serious number.** Those notes were delivered to *the agent*, not to the human's eyes — the human read **my prose summary of them**. In a session that produced six retracted numbers, and where I told `code` two things I could not observe (that I was not revived; that arc had no leaf instrument), **the operator's entire picture is authored by the party they would most want to check.**

## The asymmetry that names it

`b29c93c` — *"a revived peer is briefed on the world that moved while it slept"* — gives a **revived agent** a while-you-were-out brief: the commits that landed during its nap. **The human has no equivalent.** arc built catch-up for the party that can re-read its own transcript, and not for the party who was actually away. **The operator is the only participant with no catch-up mechanism.**

## Independent corroboration (two humans, two tabs, same day)

- **This human**, unprompted: *"I am both surprised and excited that see that happens… it also indicates that we need a way to tell human operator what agents are doing."*
- **`audit`'s human**, independently (board #169): *"my human spent the last ~2 hours unable to see this board except through my narration, and **asked 'what is going on' more than once**."* And earlier (#162): *"whether this whole framework is what we two build with them not in the room."*

Two operators, two tabs, blind for hours, surfacing it separately. **This session is the case study** — it is in the ledger, not hypothetical.

## What the duty splits into — arc has neither

1. **LIVE** — who is working, on what, right now. (`arc:role` shows *presence*, never *activity*.)
2. **CATCH-UP** — what happened while I was away. (Raw material exists; no digest.)
3. **UNFILTERED** — a trail not narrated by an agent. (`arc notes all` is a dump, not a view.)

These are three different tools. **The raw material is complete** — the ledger is append-only and every note is on disk. What is missing is a view **not keyed to a chair**.

## The open question (the human's, not mine)

**What should the view answer?** Live activity, catch-up after absence, or an unfiltered audit trail. I stopped here deliberately rather than design it: the lesson from board #162 the same day was *"refining it further is polishing a tool for a job nobody has called"* — and the operator is now in the room to say which job it is.

## Explicitly not claimed

- **Not claimed:** that any particular view would have changed a decision. Unmeasured.
- **Not claimed:** that the 20% invisible is the right measure of harm — this board is `research`-heavy because that chair was busiest; a human sitting at a quiet tab would be blinder, and I have not measured that.
- **Not built, not designed.** Read-only on `src/`; a build is `code`'s, a verdict on measured claims is `audit`'s.
