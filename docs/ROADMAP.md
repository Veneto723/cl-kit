# arc — roadmap

Parked work: worth doing, not urgent. Picked up when there is slack, not scheduled.

**Convention:** one heading per item. State the gap, the evidence (a committed doc, not prose), what is still undecided, and **who owns the next move**. An item with no owner and no open question does not belong here — it belongs in a commit.

---

## 1. Operator visibility — the board is invisible to the human · **BIG** · picked up 2026-07-18 (LIVE view · Tauri 2 widget)

**Classified by the human (2026-07-17) as a BIG update:** substantial work, not a quick fix. **Un-deferred 2026-07-18** — the human chose to build it after seeing CodexBar; the view/form/framework are now decided (see DECISION below). arc tells an operator nothing about what its agents are doing.

**Why it is big rather than small:** the raw material is complete, but there is no *view* layer at all — every reader arc has is keyed to a chair (below). This is a new surface with its own design question (which of three tools), not a patch to an existing one.

**Status:** investigated, **not designed, not built.**
**Evidence:** [`docs/review/operator-blindness-2026-07-17.md`](review/operator-blindness-2026-07-17.md) (`a227302`) — measurements, method, and what is explicitly *not* claimed.

**The gap, structurally:** every board reader resolves **a role** and answers *"what is unread for me?"* — `injection()` (turn-start), `badge()` (statusline), `requestNotes()` (`arc notes`). **A human operator holds no role**, so no view serves them. Reachable today: `/arc-role` (presence and duty — never *activity*) and `arc notes all` (an unranked ~308 KB dump).

**Measured, on this board:** of 167 notes / 308 KB, **34 (20%) never had any path to the human** at the busiest tab (`audit↔code`, `code→probe*` traffic). The other 80% reached them **only as an agent's prose summary** — in a session that produced six retracted numbers, the operator's whole picture was authored by the party they would most want to check.

**The asymmetry that names it:** `b29c93c` briefs a **revived agent** on the world that moved while it slept. **The human — away more often and for longer — has no equivalent.** The operator is the only participant with no catch-up.

**Corroborated the same day, two tabs, independently:** this human — *"we need a way to tell human operator what agents are doing"*; `audit`'s human (board #169) — *"spent the last ~2 hours unable to see this board except through my narration, and asked 'what is going on' more than once."*

**The three candidate views** (raw material for all three already on disk): **1. LIVE** — who is working, on what, right now · **2. CATCH-UP** — what happened while I was away (`b29c93c` is the closest analogue) · **3. UNFILTERED** — a trail not narrated by an agent.

### DECISION (2026-07-18) — the human picked it up

- **View: LIVE** (option 1). A **cross-repo** operator dashboard — per repo: how many sessions are working, what is on the board, the cooperation (reply) graph, and **who is waiting for whose response**. CATCH-UP / UNFILTERED not chosen; the same ledger feeds them later.
- **Form: a docked desktop widget** — always-on-top, ambient, glanceable (the human's "desktop-pet *vibe*": docked and chill, **not** a literal mascot, and explicitly **not** a browser page).
- **Framework: Tauri 2** to try (Tauri 1 is legacy — do not use). **WPF/PowerShell** is the doctrine-clean fallback if the standalone-app cost is unwanted.

**FEASIBILITY — verified 2026-07-18 by a research workflow** (4 investigators → synthesis → adversarial verify; all load-bearing claims held):
- **Derivable, solidly:** sessions-per-repo (scan `~/.claude/cache` for live `arc-state`/`arc-convlock` pid+cwd → repo root); board contents (`allNotes` off disk); and the strongest — **the waiting graph** (`openRequests` + `requestStatus` per-recipient seen/replied + the `arc-await` idle marker; i.e. the `⧗ N unanswered` signal arc already computes, `arc-board.js:357-410`).
- **Honest limits:** cross-repo **cooperation between sessions is NOT in the data** (no session/board link is stored) — cooperation is honest only *per board*. "All repos" needs **new code** (a filesystem walk for `.arc/peer/notes.jsonl` under configured roots; imported/cold boards are otherwise invisible). Liveness must **replicate `isHolder`** (start-time check), not bare pid, or it shows recycled-pid ghosts.
- **Effort: low-medium.** The built-ins-only 127.0.0.1 server lifecycle lifts near-verbatim from `arc-claudex-proxy.js`/`arc-claudex.js`; the readers (`allNotes`/`liveRoles`/`openRequests`/`requestStatus`) already exist.

**THE DOCTRINE CALL, made consciously:** a docked native widget (Tauri **or** WPF) is a standalone GUI app — the "no standalone third-party apps" the self-contained doctrine forbids (`CLAUDE.md`). So **Tauri 2 is an opt-in companion / a deliberate author-choice, NOT shipped in core `src/`.** The split that keeps arc clean: **arc builds the status FEED** (pure Node built-ins, in `src/`, doctrine-clean); **the Tauri 2 widget is the opt-in FACE** that reads it. The feed is renderer-agnostic — committing to Tauri locks in nothing on arc's side, and the same feed later drives a browser view or a WPF widget if wanted.

**Not claimed:** that any view *changes* a decision — unmeasured; this is a legibility/ergonomics win judged on its own terms. The 20%-invisible figure is a likely **floor**.

**Next move:** `code` — build the doctrine-clean status **feed** (arc's half) in `src/`; the Tauri 2 **widget** is the human's to prototype as the opt-in face. `research` is read-only on `src/`. (Heed `audit` #162's standing caution — *"polishing a tool for a job nobody called"* — is now answered: the human called it.)

---

## 2. Asymmetric note permission — initiating asks, replying does not · **RAW** · recorded, not analysed

**The human's idea, verbatim (2026-07-17):** *"Session initiate a note need permission in balanced mode, but replying a note doesn't require user permission."*

**Status: RECORDED ONLY.** The human asked for this to be parked without analysis, so none has been done — no gap statement, no evidence, no design. It is written down here so it is not lost, and deliberately nothing more. Do not mistake this entry for a considered proposal; it is a raw idea awaiting its turn.

**Owner of the next move:** the human, to say when it is worth thinking about.

---

## Parked elsewhere — pointers, not entries

These are live threads owned by other chairs or blocked on a call. They are **not** roadmap items; recorded here only so this file is not mistaken for the whole picture.

- **Board export/import (portability across machines).** The one live piece of the dissolved movable-todo idea: boards/claims are machine-local by design, so nothing board-derived survives a machine change until the board itself travels. `code`-sized as an extension (~220 lines, board #230); earns an item only when the human asks for it.
- **MAF adoption (C1 — compaction blindness).** `audit` and `code` are negotiating it; research is duty-free on it as of 2026-07-17. Evidence: [`review/maf-scan-2026-07-17.md`](review/maf-scan-2026-07-17.md) (`bc7789a`), verified by `audit` (board #181). Verdict so far: **observe, not build** — arc cannot compact a conversation it does not own.
- **Paired prefill rerun.** Protocol + subject-freeze handshake settled on the board (research authors, `audit` freezes and verdicts). **Unfunded** — nothing runs until the human calls the quota. Spec: [`review/prefill-curve-2026-07-16/AUDIT.md`](review/prefill-curve-2026-07-16/AUDIT.md).
- **Revive determinism (N-revive against a frozen conversation).** Rides the paired rerun's subject-freeze for free. Open at n=1: `--resume` took the chronological tip once; that rules out "obviously random", not "deterministic".
- **Standing-expert protocol.** **BLOCKED** and gated on the above: [`review/standing-expert-protocol-2026-07-16.md`](review/standing-expert-protocol-2026-07-16.md).
