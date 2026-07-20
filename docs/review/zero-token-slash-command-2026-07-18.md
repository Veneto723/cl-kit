# Zero-token `/slash` commands via skill + UserPromptSubmit hook

**2026-07-18 · research · verified live on Windows/arc (Claude Code 2.1.212)**

How to give arc a `/command` that shows in the `/` autocomplete menu **and costs zero model
tokens** when run. Verified end-to-end with a working `/arc-peek`. This is the same mechanism
arc's `arc:` sentinels already use — a UserPromptSubmit hook that *blocks* — now reachable from
the slash menu.

---

## The core fact (why a plain skill can't be free)

A slash command / skill invocation **reaches the model** — it costs a turn. Official docs
([skills](https://code.claude.com/docs/en/skills)):

> "Once a skill loads, its content stays in context across turns, so **every line is a recurring token cost**."
> "When you run `/fix-issue 123`, **Claude receives** 'Fix GitHub issue 123…'"

Even a `` !`cmd` `` body is sent to the model (measured: a `!`arc role`` skill cost **~2.1k tokens / 28s**).

A **UserPromptSubmit hook** is the only thing that can stop the model from running. Official docs
([hooks](https://code.claude.com/docs/en/hooks)), exit-code-2 table:

> `UserPromptSubmit` — "**Blocks prompt processing and erases the prompt**" → the prompt is prevented from reaching Claude entirely.

So: **skill = the menu entry; hook = the free execution.**

---

## The pattern (3 files)

**1. Skill file — autocomplete only.** `~/.claude/skills/<name>/SKILL.md`

```
---
name: arc-peek
description: <shown in the / menu>
disable-model-invocation: true      # only the human triggers it; never auto-loaded
---

(this body is never reached — the hook intercepts /arc-peek first)
```

The body is a placeholder. It is never read, because the hook blocks before it matters.

**2. Intercept hook — does the work, blocks the turn.** `~/.claude/hooks/<name>-intercept.js`

```js
const prompt = String(JSON.parse(require('fs').readFileSync(0,'utf8')).prompt || '');
if (!/(^|\n)\s*\/?arc-peek\b/i.test(prompt)) process.exit(0);   // not ours → pass through
const r = require('child_process').spawnSync(process.execPath,
  [require('path').join(require('os').homedir(),'.claude','scripts','arc-runner.js'),'peek'],
  {encoding:'utf8', timeout:8000});
process.stderr.write((r.stdout||'') + '\n');
process.exit(2);   // exit 2 → "Blocks prompt processing and erases the prompt"; stderr shown to user
```

Fail-safe rule: **default `exit 0`** (pass through) for anything it doesn't confidently match, and
never throw — this runs on *every* prompt in the repo, so a bug would wedge normal turns.

**3. Wire it — local, gitignored.** `<repo>/.claude/settings.local.json`

```json
{ "hooks": { "UserPromptSubmit": [ { "matcher": "",
  "hooks": [ { "type": "command",
    "command": "node \"C:/Users/<you>/.claude/hooks/arc-peek-intercept.js\"" } ] } ] } }
```

Merges with arc's existing UserPromptSubmit hooks (both run); `.claude/settings.local.json` is
gitignored, so the repo tree stays clean.

---

## The load-bearing finding (measured, and it corrected a wrong inference)

**UserPromptSubmit receives the RAW `/arc-peek`, not the expanded skill body.** Proven by Claude
Code's own block label on the live run:

```
● UserPromptSubmit operation blocked by hook: … arc usage — peek …
  [arc peek via /arc-peek — blocked before the model, 0 tokens]
  Original prompt: /arc-peek          ← the hook saw the raw command
```

This matters because:

- Matching the **raw `/arc-peek`** is enough — the hook never has to parse the expanded body.
- The `Base directory for this skill:` **preamble is irrelevant.** That preamble (prepended to every
  skill/command *body*) is what broke an earlier attempt that tried to match a sentinel *inside* the
  body — the preamble pushed it off arc's `^`-anchored `TRIGGER_RX` (`arc-switch-hook.js:41`). Matching
  the raw command sidesteps the body entirely.

⚠ **This overturned a doc-based guess.** The hooks doc's lifecycle ("UserPromptExpansion expands, then
UserPromptSubmit sees the expanded text") led to an inference that the hook would receive the expanded
body. The live run showed the raw command instead. **Empirics beat the doc-reading; the "official
example" assumption was right.**

---

## Cost, verified

| invocation | model turn? | cost |
|---|---|---|
| `arc:peek` sentinel (typed) | blocked in-hook | **0** |
| `/arc-peek` (skill + intercept hook) | **blocked in-hook** | **0** ✓ live |
| `/arc-peek` with a `` !`cmd` `` body instead | model runs | ~2.1k / 28s |
| a plain skill body reaching the model | model runs | body tokens + turn |

---

## Gotchas

- **The hook loads at session start**, not on `/reload-skills`. A new/edited `settings.local.json`
  needs a **session restart** (or a fresh tab in the repo) before the hook is active. The skill
  autocomplete does reload with `/reload-skills`. The first test "failed" only because the hook
  hadn't loaded yet.
- **Match at line-start**, exact command. A prompt that merely *contains* `/arc-peek` mid-text must
  NOT be blocked (verified: a message containing `/arc-peek` in a pasted block passed through). Prefer
  an exact `^\s*/arc-peek\b` match; matching the bare word anywhere risks false blocks.
- **jq is not installed here** — the "official example" uses `jq -r '.prompt'`; on this machine use
  `node` to read stdin JSON.
- **Windows dir names can't contain `:`** — so `/arc:peek` (colon) is impossible as a skill dir; the
  command name is the *directory* name. Colon namespacing is plugin-only. Use a hyphen: `/arc-peek`.
- **Remove any probe/debug logging** before shipping — the test hook logged every prompt to a file.

---

## Verdict for arc

Works, and it's the only path to a **zero-token** slash command with a menu entry. But it is a
**second door** to what `arc:peek` already does for free — its sole added value is `/` autocomplete
and discoverability. Worth it only where menu discoverability is the goal; the sentinel remains the
primary, no-extra-code path. `code`'s call whether any `arc:` sentinel earns a `/` twin.
