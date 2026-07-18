# arc — roadmap

Parked work: worth doing, not urgent. Picked up when there is slack, not scheduled.

**Convention:** one heading per item. State the gap, the evidence (a committed doc, not prose), what is still undecided, and **who owns the next move**. An item with no owner and no open question does not belong here — it belongs in a commit.

---

## 1. `/exit` breaks listener stability — fixed for `arc --resume`; the incident's relaunch form is unanswered

**Root cause:** `/exit` deletes session state; on `arc --resume <uuid>` the conversation id survived only in `explicitId`, and `refreshRole` was handed the null `convId` — nothing adopted, session roleless, no nag, no listener, notes rot. **Fix (audit #259, fork-guard attacked and held):** `refreshRole(..., convId || (isFork ? null : explicitId))` — a fork never adopts its caller's chair; a live holder can never be stolen.

**The open sliver (why this item survives):** which relaunch form the human used on 2026-07-17 is unknown. `--resume` → this fix closes it. Bare `arc` → mints a *new* conversation, and the role staying behind is **by design** (role follows the conversation) — a different, design-level conversation. **Owner of the next move:** the human, to say which they used.

---

## 2. Operator visibility — the board is invisible to the human · **BIG** · parked

**Classified by the human (2026-07-17) as a BIG update:** substantial work, not a quick fix — parked until there is slack, then handled properly. arc tells an operator nothing about what its agents are doing.

**Why it is big rather than small:** the raw material is complete, but there is no *view* layer at all — every reader arc has is keyed to a chair (below). This is a new surface with its own design question (which of three tools), not a patch to an existing one.

**Status:** investigated, **not designed, not built.**
**Evidence:** [`docs/review/operator-blindness-2026-07-17.md`](review/operator-blindness-2026-07-17.md) (`a227302`) — measurements, method, and what is explicitly *not* claimed.

**The gap, structurally:** every board reader resolves **a role** and answers *"what is unread for me?"* — `injection()` (turn-start), `badge()` (statusline), `requestNotes()` (`arc notes`). **A human operator holds no role**, so no view serves them. Reachable today: `/arc-role` (presence and duty — never *activity*) and `arc notes all` (an unranked ~308 KB dump).

**Measured, on this board:** of 167 notes / 308 KB, **34 (20%) never had any path to the human** at the busiest tab (`audit↔code`, `code→probe*` traffic). The other 80% reached them **only as an agent's prose summary** — in a session that produced six retracted numbers, the operator's whole picture was authored by the party they would most want to check.

**The asymmetry that names it:** `b29c93c` briefs a **revived agent** on the world that moved while it slept. **The human — away more often and for longer — has no equivalent.** The operator is the only participant with no catch-up.

**Corroborated the same day, two tabs, independently:** this human — *"we need a way to tell human operator what agents are doing"*; `audit`'s human (board #169) — *"spent the last ~2 hours unable to see this board except through my narration, and asked 'what is going on' more than once."*

**THE OPEN DECISION — the human's, and it gates the work.** Three different tools; the raw material for all three already exists (the ledger is append-only and complete on disk). What is missing is **a view not keyed to a chair**:

1. **LIVE** — who is working, on what, right now.
2. **CATCH-UP** — what happened while I was away. *(Closest analogue already shipped: the revive freshness brief, `b29c93c`.)*
3. **UNFILTERED** — a trail not narrated by an agent.

**Next move:** the human picks 1/2/3 (or rejects the framing). Then `code` builds — `research` is read-only on `src/`. Nothing starts before the pick: the same day this was found, `audit` (#162) stopped us for *"polishing a tool for a job nobody has called."*

**Not claimed:** that any view would have changed a decision — unmeasured. And 20% is likely a **floor**: this board was `research`-heavy because that chair was busiest; a human at a quieter tab would be blinder, and that is not measured either.

---

## 3. Asymmetric note permission — initiating asks, replying does not · **RAW** · recorded, not analysed

**The human's idea, verbatim (2026-07-17):** *"Session initiate a note need permission in balanced mode, but replying a note doesn't require user permission."*

**Status: RECORDED ONLY.** The human asked for this to be parked without analysis, so none has been done — no gap statement, no evidence, no design. It is written down here so it is not lost, and deliberately nothing more. Do not mistake this entry for a considered proposal; it is a raw idea awaiting its turn.

**Owner of the next move:** the human, to say when it is worth thinking about.

---

## 4. delegate can read a dead chair as LIVE — the fail-open window's sharpest edge · **SMALL** · scheduled by audit (#259)

**Found while fixing the delegate closed-chair check (2026-07-18), fixture-proven, has NOT fired in production.** `isHolder`'s deliberate fail-open windows (the warm ≤30s `PIDSTART_CACHE` serving a dead predecessor's start; the probe-unavailable path) can make `requestDelegate` treat a closed chair as live: it skips the revive, posts the packet to a dead chair, and tells the delegator *"«role» is live: its listener will wake it within seconds."*

**Why scheduled rather than fixed inline:** fail-open is the designed anti-duplicate-session tradeoff (`a0c93bb`, audit #152 — fail-safe, ≤30s, self-heals), and audit ratified the deferral. **Audit's sharpness note (#259):** the delegate path is where a false-live reading costs the most — *a request nobody answers, reported as handled* — worse than the revive-refusal the same race causes elsewhere.

**The fix shape, when picked up:** in the impostor path, re-probe an isAlive-but-cache-fresh pid (the reopen trigger the code itself names), and when `procStarts` returns null have `requestDelegate` say "could not verify «role» is live" instead of asserting liveness. Touches `isHolder` semantics — needs its own review against the duplicate-session risk fail-open was built to avoid.

**Owner of the next move:** `code`, when there is slack.

---

## 5. The listener-supersede test can lose to environment pollution · **SMALL** · scheduled by audit (#259)

**Audit's finding (2026-07-18):** running the suite on a machine with a dozen live `arc join` listeners, the listener-supersede test failed 1-in-2 runs, then passed clean. The failing title was the since-replaced kill-based test, and the tree was changing mid-audit — so *churn, not flake* is the leading hypothesis — but it cannot be proven from here, and the principle stands regardless: **a green light that flickers will someday wave off a real arc-await regression as "just the flake."**

**The fix shape:** make the supersede test hermetic against live-listener pollution — its sessions and markers are already synthetic; audit the remaining shared state (the cache dir sweep, pid liveness probes against real machine pids) and pin whatever leaks.

**Owner of the next move:** `code`, when there is slack.

---

## Parked elsewhere — pointers, not entries

These are live threads owned by other chairs or blocked on a call. They are **not** roadmap items; recorded here only so this file is not mistaken for the whole picture.

- **Board export/import (portability across machines).** The one live piece of the dissolved movable-todo idea: boards/claims are machine-local by design, so nothing board-derived survives a machine change until the board itself travels. `code`-sized as an extension (~220 lines, board #230); earns an item only when the human asks for it.
- **MAF adoption (C1 — compaction blindness).** `audit` and `code` are negotiating it; research is duty-free on it as of 2026-07-17. Evidence: [`review/maf-scan-2026-07-17.md`](review/maf-scan-2026-07-17.md) (`bc7789a`), verified by `audit` (board #181). Verdict so far: **observe, not build** — arc cannot compact a conversation it does not own.
- **Paired prefill rerun.** Protocol + subject-freeze handshake settled on the board (research authors, `audit` freezes and verdicts). **Unfunded** — nothing runs until the human calls the quota. Spec: [`review/prefill-curve-2026-07-16/AUDIT.md`](review/prefill-curve-2026-07-16/AUDIT.md).
- **Revive determinism (N-revive against a frozen conversation).** Rides the paired rerun's subject-freeze for free. Open at n=1: `--resume` took the chronological tip once; that rules out "obviously random", not "deterministic".
- **Standing-expert protocol.** **BLOCKED** and gated on the above: [`review/standing-expert-protocol-2026-07-16.md`](review/standing-expert-protocol-2026-07-16.md).
