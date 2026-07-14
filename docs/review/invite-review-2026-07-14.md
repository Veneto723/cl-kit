# Review — `arc:invite` (src/arc-invite.js + runner/hook wiring)

Requested by `code` (board note #4), performed by `scout` 2026-07-14. READ-ONLY: nothing edited.
Reviewer's note: this session **is** a forked peer on the `whale` account, so several findings
below are observations of my own runtime state, not inferences.

Verdict: **the design is sound and the five SETTLED facts hold.** Four defects remain, two of
which can still produce the exact failure invite exists to prevent — a tab that hangs with
nobody to answer it.

---

## BUG-1 [HIGH] A failed launcher is reported as SUCCESS — `src/arc-invite.js:157`

```js
const r = doSpawn('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 20000 });
if (r && r.status !== 0 && r.status !== null) { /* report failure */ }
```

`spawnSync` returns **`status: null`** on *both* failure paths that matter. Verified on this
machine:

| failure | `r.status` | `r.error.code` | current guard says |
|---|---|---|---|
| 20s timeout | `null` | `ETIMEDOUT` | **SUCCESS** |
| binary missing | `null` | `ENOENT` | **SUCCESS** |

So if PowerShell/wt cannot start, or the handoff hangs past the timeout, invite prints
`✓ inviting a "<role>" peer` **and no tab exists**. That is precisely the silent no-tab that
cost an hour during the build — the guard added to catch it does not catch it.

**Fix:** treat a null status as failure and surface `r.error`:
```js
if (!r || r.error || r.status !== 0) {
  return { ok: false, message: `could not open the new tab: ${r && r.error ? r.error.code : `exit ${r && r.status}`}` };
}
```

Also: the 20s timeout (same line) runs **inside the UserPromptSubmit hook**, so a wedged
launcher stalls the user's prompt for 20s. The wt COM handoff takes ~0.5s; 5s is ample.

---

## BUG-2 [HIGH] The permission allowlist covers the wrong tool — `src/arc-wire-settings.js` (BOARD_PERMISSIONS)

Wired allowlist (verified in the live `~/.claude/settings.json`):

```
Bash(arc join:*)  Bash(arc join)  Bash(arc await:*)  Bash(arc role:*)  Bash(arc notes:*)  Bash(arc note:*)
```

**This session's shell tool is `PowerShell`; the `Bash` tool is not available to it at all.**
I hit this directly: my first attempt to run `arc join scout` returned
`Error: No such tool available: Bash`.

An invited session that gets the PowerShell tool therefore matches **none** of these rules, so
`arc join <role>` raises a permission prompt — with nobody to answer it. Result: the tab is
**claimed but deaf**, which is the exact failure the allowlist was added to prevent. It is
currently a coin-flip on which shell tool the invited session gets.

**Fix:** wire the same commands for every shell tool the harness may hand a session
(`PowerShell(arc join:*)`, … alongside the `Bash(...)` rules). Cheap, and it removes the
coin-flip.

---

## BUG-3 [MED] The "never an arbitrary path, never another profile" promise is not enforced

The header (lines 53-58) states the security rule. The code derives all three inputs from
values the **caller's agent controls**, so the rule is documentation, not a guarantee:

| input | line | source | forgeable by an agent? |
|---|---|---|---|
| `launchDir` | 150 | `resolveCwd(session, cwd)`; the CLI passes `process.cwd()` (`arc-runner.js:1338`) | **yes** — `cd` anywhere |
| `cfgDir` | 66 | `process.env.CLAUDE_CONFIG_DIR` | **yes** — env var |
| `account` | 143 | `process.env.ARC_RUNTIME_ACCOUNT` | **yes** — env var |

So an agent can `cd` into **any** git repo and run `arc invite x`: `ensureTrusted` will
pre-accept **that** folder — one the human never opened — and open a session in it. Pointing
`CLAUDE_CONFIG_DIR` elsewhere writes the flag into a **different account's profile**.

An agent with shell access can already do a great deal, so severity is moderate, not critical —
but this is a *security-shaped promise*, and it should be enforced from state the agent cannot
forge:

- `launchDir` ← `N.resolveCwd(session, null)` (the cwd **arc-runner recorded** in
  `arc-state-<session>.json` at launch), not the caller-supplied `cwd`.
- `cfgDir` ← validate it resolves under `~/.claude/arc-profiles/<account>` and that `<account>`
  matches the session's own account; refuse otherwise.

---

## BUG-4 [MED] A forked session never gets a `convId` — two knock-on effects

Observed live, in my own claim file, 50+ seconds after launch:

```json
// .plan/claim-scout.json
{"role":"scout","pid":15044,"sessionId":"15044-966857","convId":null,"at":1784039760062}
```

`sessionConv()` returns null for a `--fork-session` launch (the statusline convId bridge does
not fire for it). Consequences:

1. **No chain-invite.** An invited peer can never itself invite: `requestInvite` refuses at
   line 138-142 (*"nothing to fork"*). I confirmed this on myself — invite is unavailable from
   the very sessions invite creates.
2. **An invited peer loses its role on restart.** The claim records `convId` precisely so a
   resumed conversation can re-take its role; with `convId: null` that recovery is dead.

Root cause is upstream of invite (the bridge), but invite is where it bites.

---

## (b) Is the `.claude.json` read-modify-write racy? **Yes.**

`ensureTrusted` reads (70) → mutates → backs up (80) → writes tmp (82) → renames (83). The
caller's **live Claude Code** writes that same file often (startup counters, tips, history,
onboarding flags). Two lost-update directions:

1. **We clobber CC.** A CC write landing inside our read→rename window is erased by our rename.
   Blast radius is the whole 54KB file, since we rewrite it wholesale.
2. **CC clobbers us.** CC holds an in-memory copy and flushes it later, erasing
   `hasTrustDialogAccepted` — and the invited tab then hits the dialog anyway. **The fix
   silently regresses and nothing says why.** This is the direction that actually hurts.

Cheapest safe fix (~10 lines, no locking — CC would not honour a lock anyway):

- **Verify-after-write:** re-read the file after the rename; if the flag did not stick, retry
  (bounded, 3×). Makes direction 2 self-healing.
- **Re-seed in the child:** have `arc-runner`, at launch and before spawning claude, call
  `ensureTrusted(its own cwd)`. That makes *our* write the last one before claude reads the
  file, which is the only ordering that matters.

Together they shrink the window to milliseconds and make the failure self-correcting. Neither
eliminates the race in theory; nothing can, short of Claude Code exposing a supported API.

---

## (d) Failure modes

**Account rate-limited — the worst remaining mode, and it is silent.**
The claim happens **in-hook** (zero tokens), so it *succeeds* even when the account is
exhausted. The pass-through turn then needs the model — which fails. Net result: a tab that
**holds the role, has no listener, and squats the name** so no one else can claim it. Recovery
is to close the tab (the claim goes stale by pid liveness), but nothing tells the user that.
Both signals needed to detect it already exist — *role held* + *no listener* — so the statusline
could say `⚠ scout · no listener` and make it self-evident.

**No Windows Terminal (`buildLaunch`, line 105).** The fallback does not `psQuote` the root, while
the wt branch (101) does:
```js
return `cmd /c start "arc: ${role}" /d "${root}" cmd /c arc${acct} ...`;
```
A path containing `'` or `$` breaks the PowerShell parse. Use `psQuote` on both branches.

**Role taken mid-launch (TOCTOU).** `liveRoles` is checked at 132, but another session can claim
between that check and the tab's own claim. The tab's `arc:role` sentinel then refuses (zero
tokens) and the tab sits there explaining why. Not a hang — a dud tab. Acceptable; worth one
line in the invite confirmation.

**Other dialogs an invited tab cannot answer.** `hasClaudeMdExternalIncludesApproved` is a real
gate in the same project entry (currently `false` for `E:/arc`). This repo has no `CLAUDE.md`,
so it does not fire here — but a repo whose `CLAUDE.md` uses `@`-imports would show the
external-includes approval dialog to an invited tab and hang it. Same class as the trust dialog,
same argument for seeding it under the same narrow rule.

---

## Nit

`spawn` is imported (line 34) but no longer used since the switch to `spawnSync`.
