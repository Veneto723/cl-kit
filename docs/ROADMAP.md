# arc — roadmap

Parked work: worth doing, not urgent. Picked up when there is slack, not scheduled.

**Convention:** one heading per item. State the gap, the evidence (a committed doc, not prose), what is still undecided, and **who owns the next move**. An item with no owner and no open question does not belong here — it belongs in a commit.

---

## 1. `arc delegate` does not check whether the target is closed · **RAW** · recorded, not analysed

**The human's report, verbatim (2026-07-17):** *"research delegate an issue to code, while code is actually closed. it doesnt check code status before delegating."*

**Status: RECORDED ONLY, and promoted to #1 by the human.** They asked for this to be recorded without analysis, so none has been done — the report above has not been verified against the code, no mechanism has been traced, and no fix is proposed. Written down so it is not lost, and deliberately nothing more.

**Owner of the next move:** the human, to say when it is worth thinking about.

---

## 2. `/exit` appears to break listener stability · **RAW** · recorded, not analysed

**The human's report, verbatim (2026-07-17):** *"seems like /exit a session will break it listener stability. Its no longer auto connect and keep it alive."*

**Status: RECORDED ONLY, placed at #2 by the human.** They asked for this to be recorded without analysis, so none has been done — the report above has not been reproduced or verified against the code, no mechanism has been traced, and no fix is proposed. Their own hedge (*"seems like"*) is preserved deliberately: it is an observation, not yet a finding.

**Owner of the next move:** the human, to say when it is worth thinking about.

---

## 3. Operator visibility — the board is invisible to the human · **BIG** · parked

**Classified by the human (2026-07-17) as a BIG update:** substantial work, not a quick fix — parked until there is slack, then handled properly. arc tells an operator nothing about what its agents are doing.

**Why it is big rather than small:** the raw material is complete, but there is no *view* layer at all — every reader arc has is keyed to a chair (below). This is a new surface with its own design question (which of three tools), not a patch to an existing one.

**Status:** investigated, **not designed, not built.**
**Evidence:** [`docs/review/operator-blindness-2026-07-17.md`](review/operator-blindness-2026-07-17.md) (`a227302`) — measurements, method, and what is explicitly *not* claimed.

**The gap, structurally:** every board reader resolves **a role** and answers *"what is unread for me?"* — `injection()` (turn-start), `badge()` (statusline), `requestNotes()` (`arc notes`). **A human operator holds no role**, so no view serves them. Reachable today: `arc:role` (presence and duty — never *activity*) and `arc notes all` (an unranked ~308 KB dump).

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

## 4. A movable per-session todo — **DEFERRED**, and the deferral is itself a test

**The human's idea (2026-07-17):** each session on the board carries its own todo/roadmap note, so that an incoming peer note or human message cannot make it lose what it was working on — **and so it survives a context compact.** Deferred deliberately, with a second purpose: **it is a live test — will `research` still surface this after a compaction?** (See "the test", below.)

**Status:** researched, **not designed, not built.** Findings below are measured on this machine unless marked otherwise.

### What is already true (measured — do not rebuild these)

- **Claude Code already has a file-backed, per-conversation task store:** `~/.claude/tasks/<conversation-id>/`, with `.lock` and `.highwatermark`. Nine conversations here have one; high-water marks reach **353**. It is **not in the context**, so **compaction cannot touch it — by construction, not by luck.**
- **Empirically survives compaction:** `7aa3a853` accumulated **353 tasks / 1,026 task-tool calls across 53 compactions**, with the agent resuming task activity within 30 min of a boundary at **16 of 53**. *(The other 37 are ambiguous — an idle session and a lost thread look identical in tool-call counts. Not evidence of loss.)*
- **arc already hooks its lifecycle:** `TaskCreated`/`TaskCompleted` → `arc-done.js`, which **derives "done" from git evidence, not the agent's word** (`ac86120`, `arc-done.js:2`).
- **arc already has a second, self-maintaining todo:** the board's request tracking — `⧗ N of YOUR requests still unanswered`.

### The real gap: **portability, not compaction**

**Measured on `research` itself:** 5 tasks created this session; `TaskList` now returns **"No tasks found"**, and this conversation has **no task dir on this machine** — the tasks are stranded on the machine where they were made (ALYCE), while the conversation moved to WHALE. **The conversation travelled; the task list did not.**

**This is the same gap as the board being machine-local** — roles and charters travel in git; boards, claims, and task lists do not. **One gap in a third costume, not a third feature.** Any build should treat it as such. ⚠ And note the trap: **arc's own derived todo (the board) has the identical disease**, so "just use the board" does not solve it either.

### The design constraint arc has already established

**Who updates it?** If the answer is *"the agent"*, the evidence says it will not. **Case study — this session:** 12 of 15 task calls happened in one early burst during a structured experiment; then **~40 hours and 10 peer interruptions with none**, despite the harness nagging *"the task tools haven't been used recently"* on nearly every turn. Meanwhile the **derived** todo (request tracking) was used 10× without a thought.

**arc already decided this question in `ac86120`: derive state from evidence, do not ask the agent to report it.** A todo the agent must remember to update contradicts arc's own principle and this session's evidence. A todo arc **derives** — from notes, requests, commits — fits both.

**Not claimed:** that interruption *caused* the abandonment. The burst was a checklist-shaped experiment; the rest was conversation, which has no discrete steps. *"The work changed shape"* fits the data equally well. Separating them needs an agent caught **mid-checklist when a note lands** — a real experiment nobody has run.

### Prior art (the pattern is named and the problem is known)

- **[opencode #18071](https://github.com/anomalyco/opencode/issues/18071)** — an **open** feature request: *"Add persistent todo list to prevent losing progress when context limits are reached."* A mature harness still lacks this.
- **[Compaction Memory](https://gist.github.com/sigalovskinick/e2e329bb37ecc74b9f15d5ba74ee1ee5)** — production-tested method for Claude Code / Codex.
- **[Mastra — anatomy of a harness](https://mastra.ai/blog/anatomy-of-a-coding-agent)**: *"compaction is where coding agents go to die"*; summaries *"drop the exact wording of a requirement… the agent starts to contradict decisions it made before the summary."*
- **[awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering)**, **[Anthropic context-engineering cookbook](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)**. The named pattern: a **live task list** — *"persistent… outside the context window"*; the principle: *"stop treating the chat as the source of truth."*

### The test (why this item is deferred rather than closed)

The human deferred this **as an experiment**: *"we can also test whether u remember it after a compact."*

- **Precondition, and it is why the first test failed:** `research`'s conversation (`61e4c419`) has **never been compacted** — zero `compact_boundary`, peak context **736,971** tokens against the ~1M trigger. The earlier recall test (the operator-visibility deferral, item 3) **could not fail** — nothing was ever at risk. `code`, at **10 compactions**, is the session that could actually answer it.
- **What the test reads out, if `research` is ever compacted:**
  - **Surfaces it unprompted** → context survived; says nothing about the feature.
  - **Only after re-reading this file** → **the file is what saved it — which is the feature's whole argument**, and the strongest available evidence for building it.
  - **Neither** → total loss; strongest evidence of all.
- ⚠ **Recording it here partially blunts the test** — a file I can re-read is exactly the mechanism under test. What remains genuinely testable is whether I remember **that this file exists** and think to look. That is the honest question, and it is the same one behind arc's measured **60% rule**: *a referenced file gets opened ~60% of the time.*

**Next move:** the human's. Nothing starts before a pick — and per item 3's lesson, the design question ("derived or discretionary? and how does it travel?") is answered before any code, not during it.

---

## 5. The DEAF badge cries wolf on busy sessions — a heartbeat, not a flag · **SMALL** · designed, ready to build

**Status:** designed this session (2026-07-17), **not built.** Unlike items 3–4 there is no open design question and no measurement pending — a ~20-line, statusline-only change blocked only on slack. Recorded so it is not lost, not because it needs a decision.

**The gap:** `badge()` computes `deaf = !isWaiting && (offerStale > 90s || oldestUnreadStale > 90s)` (`src/arc-notes.js`, `a9b682c`). That staleness test cannot separate two states that look identical on the board — *no armed listener + unread notes older than 90s*:

- **Genuinely deaf** — the session is **idle** (waiting on the human); the notes rot until the human next types. ✅ should badge.
- **Just busy** — the session is mid-way through a long (>90s) turn; the Stop hook will deliver the notes at turn-end. ❌ should not badge.

So DEAF fires during normal long turns. That is alarm fatigue: it goes off when nothing is wrong → the human learns to ignore it → and then misses the real idle-and-deaf case — the very case `a9b682c` was written to catch.

**The fix:** an active-alive **heartbeat**. The statusline already re-renders ~every 10s while a turn runs (confirmed by `research`, board #208); stamp that as a freshness signal. DEAF then requires *no recent heartbeat* **on top of** stale unread — the session is not merely quiet, it is genuinely doing nothing. Busy sessions stop tripping it.

**The constraint — why not the obvious version:** NOT a flag set on turn-start and cleared on turn-end. An **interrupted** turn never runs the Stop hook, so the flag sticks — the exact interrupt bug behind `a9b682c`. A heartbeat is a freshness **timestamp** (how-long-since-alive), which degrades gracefully instead of wedging.

**Next move:** the human's go-ahead. Designed; nothing blocks it but slack.

---

## 6. Asymmetric note permission — initiating asks, replying does not · **RAW** · recorded, not analysed

**The human's idea, verbatim (2026-07-17):** *"Session initiate a note need permission, but replying a note doesn't require user permission."*

**Status: RECORDED ONLY.** The human asked for this to be parked without analysis, so none has been done — no gap statement, no evidence, no design. It is written down here so it is not lost, and deliberately nothing more. Do not mistake this entry for a considered proposal; it is a raw idea awaiting its turn.

**Owner of the next move:** the human, to say when it is worth thinking about.

---

## Parked elsewhere — pointers, not entries

These are live threads owned by other chairs or blocked on a call. They are **not** roadmap items; recorded here only so this file is not mistaken for the whole picture.

- **MAF adoption (C1 — compaction blindness).** `audit` and `code` are negotiating it; research is duty-free on it as of 2026-07-17. Evidence: [`review/maf-scan-2026-07-17.md`](review/maf-scan-2026-07-17.md) (`bc7789a`), verified by `audit` (board #181). Verdict so far: **observe, not build** — arc cannot compact a conversation it does not own.
- **Paired prefill rerun.** Protocol + subject-freeze handshake settled on the board (research authors, `audit` freezes and verdicts). **Unfunded** — nothing runs until the human calls the quota. Spec: [`review/prefill-curve-2026-07-16/AUDIT.md`](review/prefill-curve-2026-07-16/AUDIT.md).
- **Revive determinism (N-revive against a frozen conversation).** Rides the paired rerun's subject-freeze for free. Open at n=1: `--resume` took the chronological tip once; that rules out "obviously random", not "deterministic".
- **Standing-expert protocol.** **BLOCKED** and gated on the above: [`review/standing-expert-protocol-2026-07-16.md`](review/standing-expert-protocol-2026-07-16.md).
