# The dig: 206 commits, 14 days — where arc's performance actually is

**Asked:** dig this repo from its first commit and find gold that enhances arc's performance.
**Answer, in one line:** there is **no runtime gold left — arc's own code is 6ms against node's 45ms floor, and I measured it**; the recurring cost is not execution, it is **building a second way to do one thing** (6 times, ~2,478 lines deleted) and **re-learning lessons arc already wrote down** — both of which are *delivery* failures arc has already measured the fix for and never applied to itself.

Author: `research` · Sources: `git log` (206 commits, 8b1a843 2026-07-03 → a0c93bb 2026-07-17), live measurement on this box, and the delegation-speed + paths-nudge studies in this folder.

---

## 1. Runtime performance is CLOSED. Stop looking.

I went in expecting to find a per-turn spawn tax. arc wires 7 hooks; a minimal turn fires **4 node spawns** (2 × UserPromptSubmit + 2 × Stop) plus **1 per shell tool call** (PreToolUse). The repo itself flags the stakes at `arc-wire-settings.js:50`: *"A MATCHER is not decoration on PreToolUse — it is what stops the hook from spawning node."*

Measured, this box, 5 runs each:

| | median |
|---|---|
| `arc-pretool-hook.js` full spawn | **51 ms** |
| bare `node -e "0"` | **45 ms** |
| **arc's own share** | **6 ms** |

The matcher is already correctly gated (`Bash|PowerShell`). **arc runs at ~88% of the theoretical floor for a node-based hook.** A minimal turn's arc-attributable cost is ~24ms. My hypothesis was wrong, and it was wrong in the way this repo keeps teaching: *a mechanism's existence is not its weight.*

**Every runtime lever proposed this week is now dead, each to a measurement:**

| lever | verdict |
|---|---|
| the 17KB `peers` skill stall | deleting it moves the median ratio 2.05× → **2.04×** |
| the "86s owner wake" | never existed — 0.2–0.8s; it was a `tool_use` vs `tool_result` error |
| `arc delegate` being slow | **2ms** in-process; cold 497ms vs `arc note`'s 524ms — *faster* |
| blind routing (locate-not-comprehend) | locate is **+12s, not 60s** |
| expert owners | downstream of blind routing; a *perfect free* owner still loses by 33.4s |
| the hook architecture (this dig) | **6ms** |

**The only surviving runtime lever is not in arc's code:** *fewer commands*. Each command is a process spawn (45ms floor, ~11× worse on a loaded box). That is exactly what the delegation study concluded from the other end — *delegation is slower because it runs more commands* — and no amount of arc optimisation touches it.

> **The gold here is negative and it is worth more than a fix:** arc's execution is already optimal to within 6ms. Any further performance work on arc's code is spending days to win milliseconds. **The search is over — that is the result.**

## 2. The real cost centre: a second way to do one thing

Six features were built and deleted. Measured lifetimes and discarded code:

| feature | built → deleted | lifetime | code binned |
|---|---|---|---|
| slash commands | 745e0d4 → 132578f | 115.9 h | 33 lines |
| cross-platform port (Tier-1/2/3 + CI matrix) | 3f185b5 → f661262 | 47.9 h | **368 lines** |
| Codex peer-host | f880ec7 → 51f180f | 18.9 h | **1,309 lines** |
| `arc:delegate` (headless) | 9cc80e9 → 5484263 | 8.3 h | **591 lines** |
| birth-not-fork | e22752f → 03e16b0 | 5.9 h | 60 lines |
| ledger travels | 5cc4313 → 075fbe7 | **0.1 h** | 117 lines |
| | | | **~2,478 total** |

**All six deleted a *second way to do one thing*.** That is 6/6, not a pattern I hunted for — the commit subjects say it themselves, in six different phrasings, by the same author:

- `132578f` "…cl-kit now ships **ZERO** slash commands"
- `e0f313c` "**One name per account** — the id you type IS the display name"
- `51f180f` "remove the Codex peer-host: **one harness, not two**"
- `5484263` "remove arc:delegate — **a subagent or a peer, nothing in between**"
- `b99e4b3` "delegate and invite were **two names for one intent** — merge them"
- `9e058ce` "arc join: **one verb** for 'be on this board and reachable'"

(And in the source, unprompted: `arc-await.js:115` "**One session, one listener**.")

**The rule was discovered six times and generalised zero times.** Each discovery cost between 6 minutes and 5 days.

**The sharpening the data forces — and it saves the rule from being wrong:** two ways for **two contexts** is not the bug. `arc:command` (in-session prompt) vs `arc command` (terminal) is deliberate and correct — one way *per context*. Every one of the six above offered two ways in **one** context. That is the testable form:

> **Two ways in one context is the bug. Two ways for two contexts is a feature.**

**The trend is the good news, and it should not be read as failure:** 115.9h → 47.9h → 18.9h → 8.3h → 5.9h → **0.1h**. Time-to-detect-and-revert improved ~1000×. The last mistake was killed in six minutes. **Reverting is the process working.** What has never once fired is *prevention* — the rule is only ever found *after* the code exists.

## 3. The re-learning loop — and the fix arc already proved

The same lesson recurs across the history in different costumes:

- `eb53c3c` (07-16) *"'no peer was started' — said the launcher, to the peer that was reading it"* → **a timeout is not an absence.**
- `5c4203e` (07-16, same day) *"a void that does not reap is a lie about what exists"* → **the same lesson, a different timer.** `code` said it outright on the board: *"arc already learned this exact lesson in eb53c3c… and I wrote both."*
- Then the delegation study's **zombie worker** — a harness that logged "chair never filled" and `exit(3)`'d without reaping its own late spawn — **fabricated a headline result** (the retracted 2.6×). Same lesson, third costume, and it cost a published finding.
- `arc-invite.js:148`: a **dead theory sat directly beneath its own refutation** for days and was cited back as fact — by me, on this board.

**Why the lessons don't land, in arc's own measurements:**
- **The 60% rule** (measured, 5/8): agents open a *referenced* file only ~60% of the time.
- **The paths-nudge study** (measured, 8/8 vs 0/8, **p=7.8e-5**): deference is **roster-driven**. The 100-char `owns:` line that rides the channel agents *always* see beat the `paths:` glob sitting in a file they open about half the time. Its conclusion, verbatim: ***put it in the roster, or the agent may never look.***

> **The gold:** arc's hardest-won invariants live in **git log and code comments** — the channel nobody re-reads. arc has *already proved, with p=7.8e-5 on its own board*, which channel actually changes behaviour. **arc has never applied its own finding to itself.**

**The cheap, testable consequence:** load-bearing invariants belong where agents already look — the roster / duty / skill surface — not in a commit message. The two candidates the history nominates, because they have each cost real days and real published results:

1. **"A timeout observes the watcher, not the world"** — cost: 3 recurrences, one retracted headline finding.
2. **"Two ways in one context is the bug"** — cost: 6 features, ~2,478 lines, up to 5 days each.

Neither is a code change. Both are one line in a place that gets read.

## 4. What the history says arc *is*

The shape, for the record: **206 commits, 14 days, one author.** Born `8b1a843` (07-03) as *"cl-kit: universal Claude Code account switcher for Windows 11"* — a switcher. ~85 commits of switcher (pickers, usage, profiles, trash, DPAPI keys). Renamed `3dd240f` (07-13) to **arc — Agent Runtime Coordinator**. Then **115 of 206 commits (56%) in the last four days went to the board/peers system.**

Within those, ~20 commits are bug fixes on **one surface: the spawn path** (identity, launcher, quoting, focus, encoding, reaping, birth-vs-revive). **The effort is inverted relative to arc's own doctrine and its own data:** the doctrine says a peer is a *standing duty* revived as itself (`arc-invite.js:13-15` — *"accumulated context is the entire reason a peer beats a subagent"*), and the delegation study measured that a **fresh-born peer is a subagent with extra steps** (1.78×, the anti-pattern). arc invested its heaviest engineering in the path both its design and its measurements call the rare, wrong one.

That is not a criticism of any commit — the spawn path had to work. It is an observation about **where the next day should go**, and both the doctrine and the data point at the same place: **REVIVE**, the path that has *still* never been measured end-to-end (three states — FRESH / LIVE / **REVIVED** — and only FRESH was ever tested).
