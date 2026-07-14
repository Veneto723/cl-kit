# arc

**A Claude-first native-stdio wrapper that adds account switching, session tools, and a coordination layer for [Claude Code](https://claude.com/claude-code) sessions working in the same repo.** Windows 11.

`arc` launches Claude Code with `stdio: inherit` (claude owns the TTY, so its own
slash menus and rendering are pixel-perfect — no PTY/ConPTY garble) and layers on
everything the built-in CLI can't do: switch between accounts mid-conversation,
pick an account from an arrow-key menu without spending a token, get a desktop
toast when a session finishes, and see live rate-limit usage in your statusline.
arc hosts ONE runtime — Claude Code. A GPT model arrives as an **account** (an
Anthropic-compatible proxy serving a GPT model, so `/model` swaps provider mid-conversation
without the session moving).

The Claude account config fits any of these setups:

| Style | Example |
|---|---|
| Single subscription | one claude.ai login; you just want the session tools |
| Two subscriptions | personal + work logins, switch between them |
| Subscription + gateway | a claude.ai login + an Anthropic-compatible API pool/proxy |
| Gateway only | API base URL + key, no claude.ai login |
| Any mix | N accounts; switch to any of them by name or number |

---

## Highlights

- **Switch accounts mid-conversation** — same chat continues on the other account, preserving model, permission mode, and effort (including `ultracode`).
- **Zero-token interactive picker** — type `arc:switch` for an ↑/↓ arrow-key account menu that costs **no model tokens**, shows each account's live usage, and works even when the current account is fully rate-limited.
- **Peek at all usage, zero tokens** — `arc:peek` prints every account's usage in one readout: subscription 5h/7d %, and gateway accounts' own cost/tokens.
- **Auto-selects the best account at launch** — every `arc` / `arc --resume` prefers your subscription while it has headroom and falls to the most-available gateway only when it's exhausted. No flag; cost-aware; launch/resume only (never mid-session).
- **Add any account, guided** — bare `arc:add-account` opens a wizard (pick Subscription vs Gateway, then prompts). Subscriptions drive the native browser login; **gateways** verify the endpoint, auto-detect models, and store the key.
- **Keys encrypted at rest** — a gateway key can be **DPAPI-encrypted inside the config** (no plaintext file), bound to your Windows login; `arc set-key <id>` to set/rotate.
- **Gateway usage in the statusline + peek** — if a gateway exposes a usage endpoint, arc shows the account's real cost/tokens (a cached, zero-token metadata call) — e.g. `MATE $103.60 today · 62.9M tok`.
- **Manage accounts conversationally** — an MCP server exposes `account_add` / `remove` / `update` / `config_update` to any session.
- **Desktop toasts** labeled with the session's `/rename` name, with colored state icons; **click a toast to focus that terminal window**.
- **Usage statusline** — subscription 5h/7d %, reset times, pace ETA, blink warnings near the limit; gateway cost/tokens for api accounts.
- **Safety rails** — refuses to open one conversation in two processes (a crash cause), warns before removing an account live sessions are using, logs every launch/exit, and backs up config before every change.
- **Ask a peer, get woken** — when a session is stuck, it can ask another session that owns that area (`arc note research --kind request "<packet>"`) and keep working; arc arms a waker, so the reply re-invokes it with nobody typing a thing.

---

## Demo

`arc:switch` opens the picker — no tokens, driven entirely by arrow keys, with each
account's live usage inline:

```text
  Switch arc account   ↑/↓ move · 1-9 jump · Enter confirm · Esc keep current

   1. max   ·  MAX  [oauth]   5h 31% · 7d 26%              ← current
 ❯ 2. mate  ·  MATE [api]     $118 today · 66.3M tok · unlimited   ← selected

  tip: arc:switch <name> jumps directly · arc:help lists all commands
```

`arc:peek` prints the same usage for every account as a plain, zero-token readout:

```text
arc usage — peek
  MAX  [subscription]   5h 31% · 7d 26%  (resets 8pm)   1m ago
  MATE [gateway]        $118 today · 66.3M tok · 493 req · unlimited   2m ago
      opus-4-8   64.3M tok · $116
      haiku-4-5  1.5M tok · $1.73
```

<!-- Replace the block above with a real recording once captured:
     drop the file at docs/picker.gif and uncomment the next line.
![account picker](docs/picker.gif)
-->

---

## Requirements

- **Windows 11.** arc is Windows-only — DPAPI key encryption, WinRT toasts with
  click-to-focus, and directory junctions for per-account credential isolation all
  lean on Windows. (It used to be cross-platform; that was dropped as untested weight.)
- **Node.js**
- **Claude Code** — the `claude` CLI on your PATH
- **Codex CLI** — not required. arc reaches a GPT model as an *account*, not a second CLI.

## Install

```powershell
git clone https://github.com/<you>/arc.git
cd arc
powershell -ExecutionPolicy Bypass -File install.ps1
# open a NEW terminal (the installer added ~/.local/bin to PATH), then:
arc setup   # define your accounts
arc doctor  # verify
arc         # launch
```

The installer is re-runnable and idempotent: it deploys scripts + commands into
`~/.claude`, adds a `arc` launcher to `~/.local/bin`, installs and registers the MCP
server, generates toast icons, registers the `arc-focus:` click-to-focus protocol, and
**merges** hooks + statusline into `settings.json` (backing it up first — never
removing your existing entries). It also publishes the runtime-neutral
`peers` skill to `~/.agents/skills`; other bundled skills remain
Claude-only.

**Gateway keys:** by default `arc set-key` / the add-account wizard store the key as a
DPAPI-encrypted `apiKeyEnc` blob in the config, bound to this Windows user+machine (a
copied config is useless elsewhere). You can also point an account at an env var
(`apiKeyEnv`) or a file + regex (`apiKeyFrom`) instead.

To update later: `git pull`, re-run the installer, and `arc:restart` any live sessions.

---

## Commands

**In a Claude session** (type into the normal prompt):

| Command | What it does | Tokens |
|---|---|---|
| `arc:switch` | open the interactive account picker (shows each account's usage) | **0** |
| `arc:switch <n\|name>` | switch straight to an account | **0** |
| `arc:peek` (`arc:usage`) | usage readout of **all** accounts (subscription 5h/7d + gateway cost/tokens) | **0** |
| `arc:add-account` | open the add-account **wizard** — pick Subscription or Gateway, then prompts | **0** |
| `arc:add-account <id>` | add a **subscription** via guided browser login | **0** |
| `arc:add-account <id> --api --url <gw>` | add a **gateway/pool** — verifies it, auto-detects models, encrypts the key | **0** |
| `arc:remove-account <id>` (alias `arc:delete-account`) | remove an account (double-confirmed; `<id> confirm` to finish) | **0** |
| `arc:export [sel]` | archive chat sessions to a `.tgz` (bare = current conv) | **0** |
| `arc:import <archive>` | merge sessions from an archive (newer-wins, safe) | **0** |
| `arc:delete` | delete THIS conversation → recoverable trash, start fresh (double-confirmed) | **0** |
| `arc:trash` | list the deleted-conversation trash | **0** |
| `arc:trash restore <id>` (or `arc:restore <id>`) | restore a deleted conversation from trash | **0** |
| `arc:trash empty` | **permanently** purge the trash (double-confirmed) | **0** |
| `arc:restart` | reload the wrapper + relaunch this conversation | **0** |
| `arc:role <name>` | claim a role in this repo's **board** (survives restart + switch) | **0** |
| `arc:role` | who am I, and who else is working in this repo? | **0** |
| `arc:note <role\|all> <text>` | stick a note on the board for a peer | **0** |
| `arc:notes` | read your unread notes (they also arrive automatically) | **0** |
| `arc:notes all` | the whole board, nothing marked read | **0** |
| `arc:anchors` | which doc claims about the code have gone **stale** | **0** |
| `arc:anchors reseal` | after fixing the docs, make the current code the baseline | **0** |
| `arc:help` (`arc:arc`) | print this cheat sheet | **0** |


The `arc:` forms are plain messages caught by a hook **before** the model runs —
that's why they cost nothing and keep working when the account is rate-limited (a
slash command's bash can't get past the safety classifier, because the classifier
runs on the exhausted account). That deadlock is exactly why `arc:switch` /
`arc:restart` / `arc:help` replaced the old `/switch`, `/restart`, and `/cl` slash
commands — arc ships **no slash commands** now; everything is a zero-token
`arc:` sentinel.

### The board — two sessions, one repo

Run a research session and a coding session on the same repo and they can't see each
other's work. The board is a shared sticky-note board for exactly that: a **board** is
the git repo root, so every `arc` session started anywhere inside it are peers.

```
# terminal 1                      # terminal 2
arc:role research                  arc:role coding
arc:note coding P-014 spec changed
                                  ← statusline shows: 📌 1 from research
                                  ← the note is in the agent's context on your next prompt
```

Two things happen without you doing anything. **Notes arrive by themselves** at the
start of your next turn (an agent can't be interrupted mid-turn, so a turn boundary is
the only moment a note can land). And the statusline shows `📌 N from research` while
anything is waiting — counted from the files, so it can't be forgotten or wrong.

**The agents can post too.** An agent can't *type* `arc:note` (the hook eats it before
the model), but it can **run** the CLI form via its Bash tool — `arc note all "<line>"`,
`arc note <role> "<line>"`, `arc role`, `arc notes`. The bundled `peers` skill teaches
the whole protocol: that it *has* a peer, *when* a note is worth leaving (a shared
API/schema change, a decision, a blocker) — and, importantly, when NOT to (routine steps);
the note **kinds** (`request` / `result` / `correction` / `blocker`); and, if the session's
job is answering others, how to watch the board so an incoming request wakes it. So the sessions
leave each other high-signal notes on their own judgment, the way agent-team teammates
message each other. How much they may do *unprompted* is governed by `arc:mode`.

Notes are never consumed. Reading one only advances *your* cursor; every other peer
still sees it. The board lives in `.plan/`, which ignores itself, so it never enters the
repo's history.

### "Done" comes from git, not from the agent

Telling an agent to "tick the item off when you're finished" doesn't work — bookkeeping
is the first thing dropped when context runs short. (Anthropic's own agent-teams docs
admit it: *"teammates sometimes fail to mark tasks as completed."*) So arc doesn't ask.

When an agent marks a task complete, arc diffs the repo against the `HEAD` it recorded
when the task was created and **posts the note itself**, carrying the commit sha and the
changed files:

```
#3  from coding  ✓ done: Document the board + done-gate in README
    refs: {"task":"3","sha":"a1b2c3d","files":["README.md"]}
```

Ticking the task *is* the handoff, and it arrives with evidence. Set the policy with
`features.doneGate` in `~/.claude/arc-config.json` (or `ARC_DONE_GATE`):

| mode | behaviour |
|---|---|
| `note` *(default)* | always posts; a completion with no commit is posted and flagged `UNVERIFIED` |
| `strict` | **refuses** to mark a task done when no commit backs it, and tells the agent why |
| `off` | no notes, no gate |

`note` is the default on purpose: "investigate the flaky test" is a real task that
produces no commit, and a gate that blocked it would be correct and unusable.

### Every commit as a note (post-commit hook)

The `done` note above needs the agent to use the task list. If your sessions just
**commit** (no task list), install a `post-commit` hook and every commit becomes a note
on its own — the other session sees "android committed X, touching these files" at its
next turn, no one typing anything:

```sh
# in the repo the two sessions share:
printf '#!/bin/sh\nnode "$HOME/.claude/scripts/arc-postcommit.js" >/dev/null 2>&1 || true\n' \
  > .git/hooks/post-commit && chmod +x .git/hooks/post-commit
```

It attributes the commit to the board role of whoever ran `git commit` (`ARC_SESSION` →
role), broadcasts a note with the sha + changed files, and is a **no-op** for any commit
made outside a arc session (so manual commits don't spam). It runs after the commit, so
it can never block or fail it. Remove the hook file to disable.

### When a doc's claim about the code goes stale

`done` notes prove work *happened*. The other half of drift is a doc that quietly stops
being true. Put an **anchor** next to the claim:

```markdown
<!-- arc:anchor src/auth.ts#handleLogin -->
P-014: handleLogin validates the nonce before issuing a session.
```

arc seals the anchor the first time it sees it (hashing that symbol's block) and
re-checks on every commit. Rewrite `handleLogin` and a **high-priority** note lands on
the board — which the research session receives at the top of its next turn, ranked
above everything else, plus a desktop toast:

```
#2  from coding  [!]
    STALE: docs/plan.md describes src/auth.ts#handleLogin, but the code it points at CHANGED.
    refs: {"doc":"docs/plan.md","anchor":"src/auth.ts#handleLogin","why":"changed"}
```

`arc:anchors` lists them; `arc:anchors reseal` re-baselines after you've fixed the docs.

Honest limits. This is a **fingerprint, not a parse** — arc has zero dependencies, so
tree-sitter (which is the *right* answer, see
[fiberplane/drift](https://github.com/fiberplane/drift), and would need native prebuilds)
is out. It finds the first line
that defines the symbol and hashes the block down to the next line indented no deeper.
So: a **rename** reports "gone", not "renamed"; a **reformat** reports "changed" even
when the meaning didn't. It over-reports rather than under-reports, which is the right
bias for an alarm — a false STALE costs you a glance, a missed one costs a wrong
decision. An anchor that never resolved (a doc *example*, or a typo) is reported as
`unresolved` and never nags.

> Trade-off: `arc:` sentinels are plain text, so they don't get the `/` menu's
> autocomplete (Claude Code's completion is hardcoded to `/` and `@`, with no
> extension point for a custom prefix). Zero-token + rate-limit-immune is the
> deliberate choice over typeahead.

**In your terminal** (not inside a session):

| Command | What it does |
|---|---|
| `arc` | launch on the default account |
| `arc --account <id>` (or `--<id>`) | launch on a specific account |
| `arc --effort <level>` | pin the effort for the whole session |
| `arc --resume <uuid>` / `arc --resume` | resume, restoring model / mode / effort (incl. ultracode) |
| `arc add-account <id>` | add a subscription (browser login) |
| `arc add-account <id> --api --url <gw>` | add a gateway/pool account (same as the `arc:` form) |
| `arc set-key <id>` | set/rotate an api account's key, DPAPI-encrypted (from clipboard / `--file` / `--stdin`) |
| `arc peek` | usage readout of all accounts (same as `arc:peek`) |
| `arc capture <id>` | adopt the currently-active login into an account's profile |
| `arc setup` | (re)configure accounts |
| `arc doctor` | print resolved config + health checks |

---

## Configuration

Everything lives in `~/.claude/arc-config.json` (created by `arc setup`):

```jsonc
{
  "version": 1,
  "defaultAccount": "max",
  "accounts": [
    // oauth = a claude.ai subscription login
    { "id": "max", "label": "MAX", "color": "#D97757", "type": "oauth" },

    // api = any Anthropic-compatible gateway
    {
      "id": "pool", "label": "POOL", "color": "#2DD4BF", "type": "api",
      "baseUrl": "https://my-gateway.example.com",
      "apiKeyEnv": "MY_GATEWAY_KEY",            // key: env var, or "apiKey" inline, or
      // "apiKeyFrom": { "file": "~/keys.txt", "regex": "key=(sk-[\\w-]+)" }, or
      // "apiKeyEnc": "AQAAAN…"                 // DPAPI-encrypted; set via `arc set-key pool`
      "modelMap": { "opus": "opus", "sonnet": "sonnet", "haiku": "haiku", "fable": "fable" },
      "headers": { "x-title": "claude" }
      // "usageUrl": "<baseUrl>/v1/usage" by default (false to disable) — the gateway's own usage endpoint
    }
  ],
  "switchOrder": ["max", "pool"],
  "thresholds": { "warnSessionPct": 85, "warnWeekPct": 90, "switchSessionPct": 92, "switchWeekPct": 95 },
  "features": { "autoBest": true },
  "poolDb": { "neonUrl": "postgresql://..." }   // optional — enables pool metrics
}
```

**Account types:**
- **`oauth`** — a claude.ai subscription. Each account keeps its login in its **own
  private profile** (`~/.claude/arc-profiles/<id>/`, pointed at via `CLAUDE_CONFIG_DIR`),
  so two subscriptions **never share one `.credentials.json`** — concurrent sessions
  on different accounts can't hijack each other's login. Conversations, skills, and
  commands are junctioned back to `~/.claude`, so switching account keeps your chat.
  Use `arc add-account` (guided; logs in straight into the new profile) or, to adopt
  the currently-active login into an account, `arc capture <id>`.
- **`api`** — any gateway. Needs `baseUrl` + one key source: `apiKey` inline,
  `apiKeyEnv` env var, `apiKeyFrom` file+regex, or **`apiKeyEnc`** (DPAPI-encrypted
  in the config — no plaintext on disk; set with `arc set-key <id>`). `modelMap`
  maps the opus/sonnet/haiku/fable aliases to the gateway's model names. Optional
  `usageUrl` surfaces the gateway's own usage in the statusline + `arc:peek`.

**The add-account wizard — bare `arc:add-account`** (no args): opens a `arc:switch`-style
screen to pick **Subscription** vs **Gateway/pool**, then walks you through the details
(id, and for a gateway: URL, label, and reading the key from your clipboard). It delegates
to the two flows below, so you never need to remember the flags.

**Adding a subscription — `arc add-account <id>`** (terminal) **or `arc:add-account <id>`**
(in-session): runs `claude auth login` (browser OAuth) with `CLAUDE_CONFIG_DIR`
pointed at the new account's **own profile**, so the login is written privately
there and **no other account is read, written, or disturbed**, then registers the
account. Flags:
`--label`, `--email` (prefill), `--color`, `--console` (API billing), `--default`.
The `arc:` form runs it right inside a session (the wrapper takes over the terminal
for the login, then relaunches your conversation).

**Adding a gateway/pool — `arc:add-account <id> --api --url <gateway>`** (or `arc add-account …`):
no browser. arc calls the gateway's `/v1/models` to **verify the key works and it's a
Claude gateway**, **auto-detects the model names** to build the `modelMap` (e.g.
opus→`claude-opus-4-8`), **DPAPI-encrypts the key** into `apiKeyEnc` (no plaintext on
disk), and registers the account — backing up + validating first, no-op on failure. The
key is read from your **clipboard** by default (never typed into the prompt), or from
`--file <path>` / `--key <sk-…>`. Flags: `--label`, `--color`, `--default`. Runs inline
(zero tokens, no session disruption). Re-encrypt/rotate later with `arc set-key <id>`.

For less standard gateways, extra knobs: **`--header Key:Value`** (repeatable — custom
headers, merged over the default `x-title`), **`--model opus=<name>`** (repeatable —
pin/override a family's model, wins over auto-detect; alias ∈ opus/sonnet/haiku/fable),
and **`--no-verify`** (skip the `/v1/models` probe entirely — for gateways that don't
expose it or name models differently; combine with `--model` to set the map yourself).
Unmapped families fall back to Claude Code's own default model ids. The probe sends
`anthropic-version` so a dual Claude+GPT gateway (one universal key) returns its Claude
models, not GPT ones.

**Removing an account — `arc:remove-account <id>`** (alias **`arc:delete-account`**,
double-confirmed): step 1 shows exactly what will happen and arms a 2-minute
confirmation; step 2 (`… <id> confirm`) actually removes it. It backs up
`arc-config.json` first, auto-fixes references (switch order / default),
and **never deletes the captured login file** — so removal is recoverable by
restoring the backup. Refuses to remove the last account. If **live sessions are
using the account**, step 1 warns you (in red) — removal never kills a session, but
those sessions drop to the default on their next switch/restart.

**Deleting a conversation & the trash — `arc:delete` / `arc:trash`:** `arc:delete`
(double-confirmed) never hard-deletes — it MOVES the current conversation to
`~/.claude/backups/arc-deleted-<ts>/` and starts a fresh session. `arc:trash` lists
what's in the trash (id, size, deletion time, project); `arc:trash restore <id>`
(or the `arc:restore <id>` shorthand) moves one back so `arc --resume <id>` works
again from its project folder; `arc:trash empty` (double-confirmed, red warning)
**permanently** purges the trash — the only hard-delete in the kit, and it only
ever touches `arc-deleted-*` folders (config and account backups are never trash).
All of it also works from the terminal: `arc trash [restore <id>|empty]`.

**Auto-select the best account at launch (`features.autoBest`, default on):**
every fresh `arc` and `arc --resume` picks the account with the most headroom so you
never start on an exhausted one — *without* a flag. The policy is cost-aware: it
**prefers a subscription** (any `oauth` account) while it still has 5h/7d headroom,
and only falls to the most-available `api`/pool account when the subscription is
exhausted (over `switchSessionPct` / `switchWeekPct`); if everything is exhausted
it stays on the subscription (least-bad). It reads the statusline's usage cache —
no extra network call — and does nothing if there's no cache yet. This is
**launch/resume only**; there is no mid-session auto-switch. `arc --account <id>`
overrides it for one launch; `"autoBest": false` disables it. `arc doctor` prints
the account it *would* pick right now.

**Gateway usage in the statusline + `arc:peek` (`usageUrl`):** if a gateway exposes its
own usage endpoint, arc shows the account's real cost/tokens. By default it tries
`<baseUrl>/v1/usage` (what MATE-style gateways serve — `{ usage:{today}, subscription:{limits},
model_stats, mode, unit }`); set `"usageUrl": "<url>"` to override or `false` to disable.
arc fetches it (cached ~5 min, zero model tokens — a metadata call) and renders e.g.
`MATE $103.60 today · 62.9M tok · unlimited`, with a per-model breakdown in `arc:peek`.
Token counts/cost are the gateway's own numbers; there's no 5h/7d window unless the
gateway reports one (that's an Anthropic-subscription concept). See `src/gw-usage.js`.

**Optional pool metrics (`poolDb.neonUrl`):** point it at a Postgres DB with
`pool_accounts` / `account_usage` tables to get per-account utilization in the
statusline and the `pool_status` / `pool_next_reset` MCP tools.

**Manage accounts conversationally (MCP):** the `arc` MCP server exposes
`account_list` / `account_add` / `account_remove` / `account_update` /
`config_update` — e.g. *"add my work gateway at https://… with the key in env
WORK_KEY"*. Every write backs up `arc-config.json`, validates before committing,
and never echoes secrets. Changes are `arc:switch`-able immediately, no restart.

---

## How it works

- **Native stdio, not a PTY.** arc runs `claude` with `stdio: inherit`, so claude
  owns the real terminal — its slash menus and differential renderer work exactly
  as designed. arc coordinates out-of-band via trigger files, never by intercepting
  keystrokes.
- **One harness, not two.** arc hosts Claude Code only. Hosting a second agent meant a
  second implementation of everything — the board needed a Codex-side hook, hooks needed a
  reverse-engineered TOML block, the statusline needed a second config format. A second
  *model* costs none of that: it arrives as an account (a proxy). The runtime adapters, the
  transcript transpiler and the cross-runtime session registry were deleted; they are
  recoverable from git history if that changes.
- **Switching is manual, via triggers.** The `arc:switch` hook drops a per-session
  trigger file; the wrapper polls for it, kills claude, and relaunches the *same
  conversation* (`--resume <uuid>`) on the other account, re-applying model /
  permission-mode / effort. There is **no** usage-based auto-switching.
- **Zero-token path via hooks.** `arc:switch` / `arc:restart` are caught by a
  `UserPromptSubmit` hook that blocks the prompt before any model turn — so they
  cost nothing and are immune to the rate-limit deadlock that stopped the old
  `/switch` slash command (whose bash needed a classifier on the dead account).
- **The interactive picker** is rendered by the wrapper itself (not the model):
  it kills claude to free the TTY, draws an arrow-key menu with raw-mode stdin +
  ANSI, and relaunches on your choice. This is the closest a custom tool can get
  to a native `/effort`-style picker without patching Claude Code's binary.
- **Per-conversation safety.** Each terminal owns one UUID-pinned conversation, so
  parallel sessions never cross-contaminate. A lock file **refuses to open one
  conversation in two live processes** (a confirmed crash cause). Every launch and
  exit is logged to `~/.claude/cache/arc-runner.log`.
- **Effort/ultracode preservation.** `ultracode` reports as `xhigh` everywhere and
  is rejected by the `--effort` flag, so arc detects it from the transcript and
  re-applies it via the documented `{"ultracode": true}` settings key on switch.

---

## Moving chat sessions between machines

Claude Code has no cloud sync — sessions are local `.jsonl` transcripts. arc
ships a discrete **export / import** so you can carry chats between PCs (no
realtime sync daemon, no concurrency risk):

```
arc:export                 # archive the CURRENT conversation → ~/arc-export-<ts>.tgz
arc:export all             # every session in THIS project folder
arc:export global          # every session on this machine (everything)
arc:export <project|id>    # one project's sessions, or one conversation   ·   --since <days>
arc:export ... --out <f>   # choose the archive path
arc:import <archive.tgz>   # merge into ~/.claude/projects  ( --dry-run / --force / --skip-existing )
arc:import <archive> E:    # re-root every project in the bundle under E:\ so it resumes at a
                          # LOCAL path (home's E:\whaletech\proj → E:\proj). `--dest E:` is identical.
```

Export bundles each session's transcript **plus** its sidecar (subagents, tool
results) and a manifest. Import is **safe**: it's *newer-wins* (compares the last
transcript entry's timestamp), backs up any local copy it overwrites (to
`~/.claude/backups/arc-import-<ts>/`), and **never touches a conversation that's
open in a live arc session**. Also available as terminal `arc export` / `arc import`.

**Resume caveat:** `claude --resume <id>` is scoped to the cwd's project dir, so
both machines must use the **same project paths** (e.g. work in `E:\proj` on
both) for the imported chat to resume cleanly.

## Reaching a GPT model

arc no longer hosts the Codex TUI as a second runtime, and there is no longer a `codex exec`
delegate either. A GPT model arrives **as an account** — which costs no second implementation
of arc's features, because to arc it is just another account to switch to.

**As an account — a GPT model in Claude Code's own harness ("claudex").**

Give arc a gateway that serves a GPT model on the OpenAI API (`/v1/chat/completions`), and arc
runs Claude Code's harness on it: same session, same board, same hooks, same tools — only the
model and the quota change. `arc:add-account` asks which provider first; pick **Codex / GPT**,
give the gateway URL and key, and arc **discovers the GPT models the gateway serves** and maps
them onto Claude Code's tiers, so `/model opus|sonnet|haiku` switches between them in-session
(e.g. Sol / Terra / Luna). `arc:switch <id>` moves you onto the account.

How it works: Claude Code speaks only the Anthropic Messages API; a GPT gateway speaks OpenAI.
So arc **auto-spawns a tiny local translator** (`arc-claudex-proxy`, 127.0.0.1 only) that
converts between them, and points the account at it — you run and babysit nothing. If instead
your gateway already serves GPT on `/v1/messages` (some do), arc detects that at add-account
time and skips the translator, pointing Claude Code straight at the gateway. Manage the
sidecars with `arc claudex` / `arc claudex stop`. The gateway key is DPAPI-encrypted and only
ever reaches the translator (never Claude Code); the usage statusline reads Anthropic's
endpoint, so it's meaningless on such an account.

**You must already have such a proxy.** arc points Claude Code at one; it does not install or
run one. And note that routing subscription credentials through a third-party proxy may breach
the provider's terms of service — that is a deliberate choice for you to make, not arc's.

**Honest limits.** arc's usage statusline reads Anthropic's OAuth usage endpoint, so its
numbers are meaningless on such an account.

## Setting up a second machine

The repo has all the *code* but deliberately **not** your accounts or secrets
(`arc-config.json` and the per-account profiles are never committed). Two options:

- **Fresh:** run the installer, then `arc setup` (+ `arc add-account` per
  subscription). For an `api` account, provide its key via `apiKeyEnv`/inline
  since machine-specific `apiKeyFrom` files won't be present.
- **Mirror:** run the installer, then copy `~/.claude/arc-config.json` and each
  account's profile folder (`~/.claude/arc-profiles/<id>/` — the login lives in its
  `.credentials.json`) from the old machine, and `arc doctor` to confirm. An `api`
  account's DPAPI-encrypted key does NOT survive the move (DPAPI is machine-bound):
  re-run `arc set-key <id>` on the new machine, or copy the `apiKeyFrom` file.

---

## Troubleshooting

- **`arc:switch` didn't open the picker / was treated as a normal message** — the
  running wrapper predates the code change. `arc:restart` the session (it re-execs
  the wrapper from disk). Any time arc-runner.js changes, live sessions need one
  `arc:restart`; hooks and the statusline reload on their own.
- **Switching while rate-limited** — `arc:switch` / `arc:restart` are caught by a
  hook before the model runs, so they work even when the account is exhausted.
  (The removed `/switch` slash command couldn't: its bash needed a safety
  classifier that runs on the same dead account — the deadlock these forms fix.)
- **No toast appeared** — toasts only fire for turns ≥ 30s (tune with
  `ARC_NOTIFY_MIN_MS`, `0` = every turn). Check `~/.claude/cache/arc-notify.log` for
  the decision (`toast` / `skip` / `wait` / `fail`).
- **"REFUSING TO LAUNCH — conversation already open"** — that conversation is live
  in another arc window. Use that window, start a fresh `arc`, or override with
  `arc --force-duplicate` (not recommended).
- **`arc doctor`** is your first stop — it prints the resolved config and flags any
  broken account, missing key, or unwired hook.

---

## Repo layout

```
src/            wrapper + hooks, account switching, the board (boards/notes/roles),
                bundles, status/usage tools
mcp/            arc MCP server (account management + pool metrics tools)
pool/           optional pool-DB metrics tooling (pool-query, pool-neon-url)
test/           test suite (run.js; `npm test`) — Windows, incl. a real DPAPI round-trip
install.ps1     Windows 11 installer (idempotent)
```

## Notes & limitations

- **Windows 11 only.** DPAPI key encryption, WinRT toasts with click-to-focus, and
  the directory junctions behind per-account credential isolation all lean on Windows.
  (It was tri-platform once; that support was untested weight and got removed.) Keys
  are a DPAPI `apiKeyEnc` blob by default, or `apiKeyEnv` / `apiKeyFrom`.
- Claude wrapper caches live under `~/.claude/cache/arc-*`; stale files are swept
  automatically (state daily, effort memories after 7 days, conversation locks by
  process liveness). Runtime-neutral aliases and logical sessions live under
  `~/.arc`.
- `arc:switch` is the token-free interactive path. Slash commands can't match it:
  a *custom* slash command always costs a small model turn (Claude Code reserves
  the instant path for built-ins), which is why the old `/switch`, `/restart`, and
  `/cl` were all removed in favor of zero-token `arc:` sentinels. The one thing the
  `/` menu offers that `arc:` can't is **autocomplete** — Claude Code's in-input
  completion is hardcoded to `/` and `@` with no extension point for a custom
  prefix, so that typeahead is the price of the zero-token/rate-limit-immune path.
- **`apiKeyEnc` is per user+machine** — a DPAPI blob only decrypts on the Windows
  account and machine that created it. Moving `arc-config.json` to another PC won't
  decrypt it; run `arc set-key <id>` there to re-encrypt. It's not defense against
  code already running as you (that could read the key when arc uses it) — it stops
  offline theft of a copied config/file.
- **Gateway usage (`usageUrl`) is provider-specific** — arc reads the common fields
  (cost, tokens, per-model, limits) from a MATE-style `/v1/usage` shape and degrades
  gracefully on anything else; a gateway with no usage endpoint just shows no usage.

## License

[MIT](LICENSE) © 2026 Veneto723
