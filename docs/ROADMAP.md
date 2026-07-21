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

## 2. Board notes grow unbounded — a hard cap is the wrong tool; bound the *newborn's* catch-up · **SMALL** · research-analysed, not built

**The human's question (2026-07-18):** do we need a hard cap on board-note count so the ledger stops growing forever, since old/legacy notes are meaningless? **Answer: don't cap — the problem is narrower than "every role," and a count-cap is unsafe.**

**Measured (research, 2026-07-18):** the board (`.arc/peer/notes.jsonl`) is **334 notes / 760 KB**, append-only. `allNotes` (`arc-board.js:430`) parses the WHOLE file on every read and `injection` runs it every turn — so growth is a real but tiny per-turn parse cost (a slow leak, not a fire; 760 KB is a few ms).

**The finding — it's a NEWBORN problem, not an existing-role one:**
- **Existing roles are immune.** The cursor sits at the tip; `unreadFor` (`arc-board.js:550`) delivers only notes past it, and `markRead` advances it each turn. Old notes are **never re-read**.
- **A newborn inherits the whole inbox.** A fresh claim has no cursor, so `unreadFor` matches every broadcast + every note ever addressed to its role from note #1 (`arc-notes.js:494-495`, verbatim: *"a fresh session inherits the whole inbox"*). It is paced — `injection` batches the catch-up by seq-prefix (`arc-notes.js:938/981`) — but a fresh role still burns early turns on history it may not need.

**Why a hard cap (keep last N) is the wrong tool — three measured hazards:**
1. **Breaks references.** **197 of 334** notes carry `replyTo`/`supersedes`/`refs` pointing at other notes by stable id; dropping by position dangles them and corrupts threads / `supersededMap`.
2. **Drops unread notes.** An away role's cursor is old; its unread notes sit *below* the cap line — a count-cap silently deletes what it never saw, violating the board's core guarantee (`arc-board.js:493`: *"a missed one is the bug this design exists to prevent"*).
3. **Fights the append-only / id-merge model** the board is built on.

**The targeted fix (research's recommendation):** **seed a fresh claim's cursor to a recent window** (tip, or last-N / last-24h) so a newborn starts on *current* work instead of catching up from note #1. One line, touches no note, breaks no reference — it makes history stop mattering for a fresh role, which is exactly what the human asked for. **Only if the file ever genuinely bloats:** *cursor-safe GC* (drop a note only when every live role's cursor is past it **and** no surviving note references it by id) or *archive-rotate* to a side file `arc notes all` can still read — **never a blind count cap.**

**Not claimed:** that 760 KB is a problem today — it is not. This is a slow leak plus a newborn-ergonomics cost, not urgent.

**Owner of the next move:** `code`, if the human wants the newborn-cursor seed built. `research` is read-only on `src/`.

---

## 3. Listener re-arm fires a false-positive "task complete" · **SMALL** · diagnosed, not built · owner: `code`

**The gap (operator-observed, 2026-07-21):** a re-armed `arc join <role>` that DECLINES (a genuine listener is already alive — `arc-await.js:164-171`) exits 0, and the harness reports that as `Background command … completed (exit code 0)` — indistinguishable from a real note-wake. `arc join` returns 0 on FIVE outcomes (note landed, already-armed decline, superseded, orphaned, board-moved) and only the first delivered anything, so a bare "completed exit 0" over-signals "the listening task is done" when nothing was delivered.

**Root cause:** a redundant re-arm gets LAUNCHED at all. The Stop-hook nudge (`arc-stop-hook.js:117` / `:309`, `isWaitingAs …{genuine}`) and `arc join`'s own decline (`arc-await.js:164`, `waitingFor …{genuine}`) each run a FRESH procStart liveness probe in a different process at a different instant, and they can momentarily disagree — so the hook says "no listener, arm one" while a listener is in fact live, the model complies, and the second `arc join` immediately declines. Observed live this session (hook nagged; `arc join` found pid 3512/19492 already alive).

**Two levers:**
1. **Fix at the source** — make the hook's re-arm nudge and `arc join`'s decline share ONE consistent liveness verdict, so the redundant arm is never launched. Touches the listener / stop-hook layer (a data-integrity path → needs an `audit` pass).
2. **Behavioral** — the model simply stops re-arming when a listener is already live (arm-once; the nag is the signal, not a command). Already the documented discipline; under-followed.

**Undecided / for discussion when `audit` returns:** whether lever 1 is worth the risk on the listener layer, or lever 2 (discipline) is enough. Recommendation on record: do NOT touch `arc-await.js` / `arc-stop-hook.js` while the #274 full-tree audit is in flight on a frozen tree — that is the exact "tree moved mid-audit" failure audit already flagged (#271/#273). Fold lever 1 into the batch AFTER #274 clears.

**Owner of the next move:** `code`, once #274 is verdicted and the human weighs lever 1 vs lever 2.

---

## Parked elsewhere — pointers, not entries

These are live threads owned by other chairs or blocked on a call. They are **not** roadmap items; recorded here only so this file is not mistaken for the whole picture.

- **Board export/import (portability across machines).** The one live piece of the dissolved movable-todo idea: boards/claims are machine-local by design, so nothing board-derived survives a machine change until the board itself travels. `code`-sized as an extension (~220 lines, board #230); earns an item only when the human asks for it.
- **MAF adoption (C1 — compaction blindness).** `audit` and `code` are negotiating it; research is duty-free on it as of 2026-07-17. Evidence: [`review/maf-scan-2026-07-17.md`](review/maf-scan-2026-07-17.md) (`bc7789a`), verified by `audit` (board #181). Verdict so far: **observe, not build** — arc cannot compact a conversation it does not own.
- **Paired prefill rerun.** Protocol + subject-freeze handshake settled on the board (research authors, `audit` freezes and verdicts). **Unfunded** — nothing runs until the human calls the quota. Spec: [`review/prefill-curve-2026-07-16/AUDIT.md`](review/prefill-curve-2026-07-16/AUDIT.md).
- **Revive determinism (N-revive against a frozen conversation).** Rides the paired rerun's subject-freeze for free. Open at n=1: `--resume` took the chronological tip once; that rules out "obviously random", not "deterministic".
- **Standing-expert protocol.** **BLOCKED** and gated on the above: [`review/standing-expert-protocol-2026-07-16.md`](review/standing-expert-protocol-2026-07-16.md).
