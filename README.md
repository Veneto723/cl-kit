# cl-kit

**A native-stdio wrapper for [Claude Code](https://claude.com/claude-code) that adds instant, zero-token account switching, an interactive account picker, session toasts, and a usage statusline — all driven by one config file.** Windows 11.

`cl` launches Claude Code with `stdio: inherit` (claude owns the TTY, so its own
slash menus and rendering are pixel-perfect — no PTY/ConPTY garble) and layers on
everything the built-in CLI can't do: switch between accounts mid-conversation,
pick an account from an arrow-key menu without spending a token, get a desktop
toast when a session finishes, and see live rate-limit usage in your statusline.

One config file fits any setup:

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
- **Zero-token interactive picker** — type `cl:switch` for an ↑/↓ arrow-key account menu that costs **no model tokens**, shows each account's live usage, and works even when the current account is fully rate-limited.
- **Peek at all usage, zero tokens** — `cl:peek` prints every account's usage in one readout: subscription 5h/7d %, and gateway accounts' own cost/tokens.
- **Auto-selects the best account at launch** — every `cl` / `cl --resume` prefers your subscription while it has headroom and falls to the most-available gateway only when it's exhausted. No flag; cost-aware; launch/resume only (never mid-session).
- **Add any account, guided** — bare `cl:add-account` opens a wizard (pick Subscription vs Gateway, then prompts). Subscriptions drive the native browser login; **gateways** verify the endpoint, auto-detect models, and store the key.
- **Keys encrypted at rest** — a gateway key can be **DPAPI-encrypted inside the config** (no plaintext file), bound to your Windows login; `cl set-key <id>` to set/rotate.
- **Gateway usage in the statusline + peek** — if a gateway exposes a usage endpoint, cl shows the account's real cost/tokens (a cached, zero-token metadata call) — e.g. `MATE $103.60 today · 62.9M tok`.
- **Manage accounts conversationally** — an MCP server exposes `account_add` / `remove` / `update` / `config_update` to any session.
- **Desktop toasts** labeled with the session's `/rename` name, with colored state icons; **click a toast to focus that terminal window**.
- **Usage statusline** — subscription 5h/7d %, reset times, pace ETA, blink warnings near the limit; gateway cost/tokens for api accounts.
- **Safety rails** — refuses to open one conversation in two processes (a crash cause), warns before removing an account live sessions are using, logs every launch/exit, and backs up config before every change.

---

## Demo

`cl:switch` opens the picker — no tokens, driven entirely by arrow keys, with each
account's live usage inline:

```text
  Switch cl account   ↑/↓ move · 1-9 jump · Enter confirm · Esc keep current

   1. max   ·  MAX  [oauth]   5h 31% · 7d 26%              ← current
 ❯ 2. mate  ·  MATE [api]     $118 today · 66.3M tok · unlimited   ← selected

  tip: cl:switch <name> jumps directly · /cl lists all commands
```

`cl:peek` prints the same usage for every account as a plain, zero-token readout:

```text
cl usage — peek
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

- **Windows 11, macOS, or Linux.** The core — account switching, per-account
  credential isolation, usage statusline, trash, the zero-token `cl:` commands — is
  cross-platform (verified in CI on Windows/Ubuntu/macOS). Desktop toasts work
  everywhere too (WinRT on Windows, `osascript` on macOS, `notify-send` on Linux).
  Only two extras stay Windows-only: click-to-focus (raising the terminal from a
  toast) and DPAPI key encryption (see the note under Install).
- **Node.js**
- **Claude Code** — the `claude` CLI on your PATH

## Install

**Windows:**
```powershell
git clone https://github.com/<you>/cl-kit.git
cd cl-kit
powershell -ExecutionPolicy Bypass -File install.ps1
# open a NEW terminal (the installer added ~/.local/bin to PATH), then:
cl setup   # define your accounts
cl doctor  # verify
cl         # launch
```

**Linux / macOS:**
```sh
git clone https://github.com/<you>/cl-kit.git
cd cl-kit
bash install.sh
# ensure ~/.local/bin is on PATH (the installer prints the exact line if not), then:
cl setup && cl doctor && cl
```

Both installers are re-runnable and idempotent: they deploy scripts + commands into
`~/.claude`, add a `cl` launcher to `~/.local/bin`, install and register the MCP
server, and **merge** hooks + statusline into `settings.json` (backing it up first —
never removing your existing entries). `install.ps1` additionally generates toast
icons and registers the `cl-focus:` protocol; `install.sh` skips those Windows-only
extras.

**Gateway keys off Windows:** the DPAPI-encrypted `apiKeyEnc` is Windows-only. On
Linux/macOS, `cl set-key` / the add-account wizard store the key in the **OS keychain**
(macOS Keychain / Linux libsecret, referenced by `apiKeyKeychain`) when a secret
service is available — verified by a store-and-read-back round-trip. If none is
available (headless box, locked keychain), it falls back to a `0600` file under
`~/.claude/cl-keys/` (via `apiKeyFrom`). You can also always use `apiKeyEnv` (an env
var) or `apiKeyFrom` (file + regex) directly.

To update later: `git pull`, re-run the installer, and `/restart` any live sessions.

---

## Commands

**In a session** (type into the normal prompt):

| Command | What it does | Tokens |
|---|---|---|
| `cl:switch` | open the interactive account picker (shows each account's usage) | **0** |
| `cl:switch <n\|name>` | switch straight to an account | **0** |
| `cl:peek` (`cl:usage`) | usage readout of **all** accounts (subscription 5h/7d + gateway cost/tokens) | **0** |
| `cl:add-account` | open the add-account **wizard** — pick Subscription or Gateway, then prompts | **0** |
| `cl:add-account <id>` | add a **subscription** via guided browser login | **0** |
| `cl:add-account <id> --api --url <gw>` | add a **gateway/pool** — verifies it, auto-detects models, encrypts the key | **0** |
| `cl:remove-account <id>` (alias `cl:delete-account`) | remove an account (double-confirmed; `<id> confirm` to finish) | **0** |
| `cl:export [sel]` | archive chat sessions to a `.tgz` (bare = current conv) | **0** |
| `cl:import <archive>` | merge sessions from an archive (newer-wins, safe) | **0** |
| `cl:delete` | delete THIS conversation → recoverable trash, start fresh (double-confirmed) | **0** |
| `cl:trash` | list the deleted-conversation trash | **0** |
| `cl:trash restore <id>` (or `cl:restore <id>`) | restore a deleted conversation from trash | **0** |
| `cl:trash empty` | **permanently** purge the trash (double-confirmed) | **0** |
| `cl:restart` | reload the wrapper + relaunch this conversation | **0** |
| `/switch [n\|name]` | same picker / direct switch, from the `/` menu | small |
| `/restart` | reload + relaunch | small |
| `/cl` | print this cheat sheet | small |

The `cl:` forms are plain messages caught by a hook **before** the model runs —
that's why they cost nothing and keep working when the account is rate-limited
(when `/switch`'s bash can't get past the safety classifier, because the
classifier runs on the exhausted account). The `/` forms are discoverable in the
native `/` menu but cost one small model turn. `/cl` documents both.

**In your terminal** (not inside a session):

| Command | What it does |
|---|---|
| `cl` | launch on the default account |
| `cl --account <id>` (or `--<id>`) | launch on a specific account |
| `cl --effort <level>` | pin the effort for the whole session |
| `cl --resume <uuid>` / `cl --resume` | resume, restoring model / mode / effort (incl. ultracode) |
| `cl add-account <id>` | add a subscription (browser login) |
| `cl add-account <id> --api --url <gw>` | add a gateway/pool account (same as the `cl:` form) |
| `cl set-key <id>` | set/rotate an api account's key, DPAPI-encrypted (from clipboard / `--file` / `--stdin`) |
| `cl peek` | usage readout of all accounts (same as `cl:peek`) |
| `cl capture <id>` | adopt the currently-active login into an account's profile |
| `cl setup` | (re)configure accounts |
| `cl doctor` | print resolved config + health checks |

---

## Configuration

Everything lives in `~/.claude/cl-config.json` (created by `cl setup`):

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
      // "apiKeyEnc": "AQAAAN…"                 // DPAPI-encrypted; set via `cl set-key pool`
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
  private profile** (`~/.claude/cl-profiles/<id>/`, pointed at via `CLAUDE_CONFIG_DIR`),
  so two subscriptions **never share one `.credentials.json`** — concurrent sessions
  on different accounts can't hijack each other's login. Conversations, skills, and
  commands are junctioned back to `~/.claude`, so switching account keeps your chat.
  Use `cl add-account` (guided; logs in straight into the new profile) or, to adopt
  the currently-active login into an account, `cl capture <id>`.
- **`api`** — any gateway. Needs `baseUrl` + one key source: `apiKey` inline,
  `apiKeyEnv` env var, `apiKeyFrom` file+regex, or **`apiKeyEnc`** (DPAPI-encrypted
  in the config — no plaintext on disk; set with `cl set-key <id>`). `modelMap`
  maps the opus/sonnet/haiku/fable aliases to the gateway's model names. Optional
  `usageUrl` surfaces the gateway's own usage in the statusline + `cl:peek`.

**The add-account wizard — bare `cl:add-account`** (no args): opens a `cl:switch`-style
screen to pick **Subscription** vs **Gateway/pool**, then walks you through the details
(id, and for a gateway: URL, label, and reading the key from your clipboard). It delegates
to the two flows below, so you never need to remember the flags.

**Adding a subscription — `cl add-account <id>`** (terminal) **or `cl:add-account <id>`**
(in-session): runs `claude auth login` (browser OAuth) with `CLAUDE_CONFIG_DIR`
pointed at the new account's **own profile**, so the login is written privately
there and **no other account is read, written, or disturbed**, then registers the
account. Flags:
`--label`, `--email` (prefill), `--color`, `--console` (API billing), `--default`.
The `cl:` form runs it right inside a session (the wrapper takes over the terminal
for the login, then relaunches your conversation).

**Adding a gateway/pool — `cl:add-account <id> --api --url <gateway>`** (or `cl add-account …`):
no browser. cl calls the gateway's `/v1/models` to **verify the key works and it's a
Claude gateway**, **auto-detects the model names** to build the `modelMap` (e.g.
opus→`claude-opus-4-8`), **DPAPI-encrypts the key** into `apiKeyEnc` (no plaintext on
disk), and registers the account — backing up + validating first, no-op on failure. The
key is read from your **clipboard** by default (never typed into the prompt), or from
`--file <path>` / `--key <sk-…>`. Flags: `--label`, `--color`, `--default`. Runs inline
(zero tokens, no session disruption). Re-encrypt/rotate later with `cl set-key <id>`.

For less standard gateways, extra knobs: **`--header Key:Value`** (repeatable — custom
headers, merged over the default `x-title`), **`--model opus=<name>`** (repeatable —
pin/override a family's model, wins over auto-detect; alias ∈ opus/sonnet/haiku/fable),
and **`--no-verify`** (skip the `/v1/models` probe entirely — for gateways that don't
expose it or name models differently; combine with `--model` to set the map yourself).
Unmapped families fall back to Claude Code's own default model ids. The probe sends
`anthropic-version` so a dual Claude+GPT gateway (one universal key) returns its Claude
models, not GPT ones.

**Removing an account — `cl:remove-account <id>`** (alias **`cl:delete-account`**,
double-confirmed): step 1 shows exactly what will happen and arms a 2-minute
confirmation; step 2 (`… <id> confirm`) actually removes it. It backs up
`cl-config.json` first, auto-fixes references (switch order / default),
and **never deletes the captured login file** — so removal is recoverable by
restoring the backup. Refuses to remove the last account. If **live sessions are
using the account**, step 1 warns you (in red) — removal never kills a session, but
those sessions drop to the default on their next switch/restart.

**Deleting a conversation & the trash — `cl:delete` / `cl:trash`:** `cl:delete`
(double-confirmed) never hard-deletes — it MOVES the current conversation to
`~/.claude/backups/cl-deleted-<ts>/` and starts a fresh session. `cl:trash` lists
what's in the trash (id, size, deletion time, project); `cl:trash restore <id>`
(or the `cl:restore <id>` shorthand) moves one back so `cl --resume <id>` works
again from its project folder; `cl:trash empty` (double-confirmed, red warning)
**permanently** purges the trash — the only hard-delete in the kit, and it only
ever touches `cl-deleted-*` folders (config and account backups are never trash).
All of it also works from the terminal: `cl trash [restore <id>|empty]`.

**Auto-select the best account at launch (`features.autoBest`, default on):**
every fresh `cl` and `cl --resume` picks the account with the most headroom so you
never start on an exhausted one — *without* a flag. The policy is cost-aware: it
**prefers a subscription** (any `oauth` account) while it still has 5h/7d headroom,
and only falls to the most-available `api`/pool account when the subscription is
exhausted (over `switchSessionPct` / `switchWeekPct`); if everything is exhausted
it stays on the subscription (least-bad). It reads the statusline's usage cache —
no extra network call — and does nothing if there's no cache yet. This is
**launch/resume only**; there is no mid-session auto-switch. `cl --account <id>`
overrides it for one launch; `"autoBest": false` disables it. `cl doctor` prints
the account it *would* pick right now.

**Gateway usage in the statusline + `cl:peek` (`usageUrl`):** if a gateway exposes its
own usage endpoint, cl shows the account's real cost/tokens. By default it tries
`<baseUrl>/v1/usage` (what MATE-style gateways serve — `{ usage:{today}, subscription:{limits},
model_stats, mode, unit }`); set `"usageUrl": "<url>"` to override or `false` to disable.
cl fetches it (cached ~5 min, zero model tokens — a metadata call) and renders e.g.
`MATE $103.60 today · 62.9M tok · unlimited`, with a per-model breakdown in `cl:peek`.
Token counts/cost are the gateway's own numbers; there's no 5h/7d window unless the
gateway reports one (that's an Anthropic-subscription concept). See `src/gw-usage.js`.

**Optional pool metrics (`poolDb.neonUrl`):** point it at a Postgres DB with
`pool_accounts` / `account_usage` tables to get per-account utilization in the
statusline and the `pool_status` / `pool_next_reset` MCP tools.

**Manage accounts conversationally (MCP):** the `cl` MCP server exposes
`account_list` / `account_add` / `account_remove` / `account_update` /
`config_update` — e.g. *"add my work gateway at https://… with the key in env
WORK_KEY"*. Every write backs up `cl-config.json`, validates before committing,
and never echoes secrets. Changes are `/switch`-able immediately, no restart.

---

## How it works

- **Native stdio, not a PTY.** cl runs `claude` with `stdio: inherit`, so claude
  owns the real terminal — its slash menus and differential renderer work exactly
  as designed. cl coordinates out-of-band via trigger files, never by intercepting
  keystrokes.
- **Switching is manual, via triggers.** `/switch`'s bash (or the `cl:switch`
  hook) drops a per-session trigger file; the wrapper polls for it, kills claude,
  and relaunches the *same conversation* (`--resume <uuid>`) on the other account,
  re-applying model / permission-mode / effort. There is **no** usage-based
  auto-switching.
- **Zero-token path via hooks.** `cl:switch` / `cl:restart` are caught by a
  `UserPromptSubmit` hook that blocks the prompt before any model turn — so they
  cost nothing and are immune to the rate-limit deadlock that stops `/switch`.
- **The interactive picker** is rendered by the wrapper itself (not the model):
  it kills claude to free the TTY, draws an arrow-key menu with raw-mode stdin +
  ANSI, and relaunches on your choice. This is the closest a custom tool can get
  to a native `/effort`-style picker without patching Claude Code's binary.
- **Per-conversation safety.** Each terminal owns one UUID-pinned conversation, so
  parallel sessions never cross-contaminate. A lock file **refuses to open one
  conversation in two live processes** (a confirmed crash cause). Every launch and
  exit is logged to `~/.claude/cache/cl-runner.log`.
- **Effort/ultracode preservation.** `ultracode` reports as `xhigh` everywhere and
  is rejected by the `--effort` flag, so cl detects it from the transcript and
  re-applies it via the documented `{"ultracode": true}` settings key on switch.

---

## Moving chat sessions between machines

Claude Code has no cloud sync — sessions are local `.jsonl` transcripts. cl-kit
ships a discrete **export / import** so you can carry chats between PCs (no
realtime sync daemon, no concurrency risk):

```
cl:export                 # archive the CURRENT conversation → ~/cl-export-<ts>.tgz
cl:export all             # every session   ·   cl:export <project|id>   ·   --since <days>
cl:export ... --out <f>   # choose the archive path
cl:import <archive.tgz>   # merge into ~/.claude/projects  ( --dry-run / --force / --skip-existing )
```

Export bundles each session's transcript **plus** its sidecar (subagents, tool
results) and a manifest. Import is **safe**: it's *newer-wins* (compares the last
transcript entry's timestamp), backs up any local copy it overwrites (to
`~/.claude/backups/cl-import-<ts>/`), and **never touches a conversation that's
open in a live cl session**. Also available as terminal `cl export` / `cl import`.

**Resume caveat:** `claude --resume <id>` is scoped to the cwd's project dir, so
both machines must use the **same project paths** (e.g. work in `E:\proj` on
both) for the imported chat to resume cleanly.

## Setting up a second machine

The repo has all the *code* but deliberately **not** your accounts or secrets
(`cl-config.json` and `cl-credentials/` are never committed). Two options:

- **Fresh:** run the installer, then `cl setup` (+ `cl add-account` per
  subscription). For an `api` account, provide its key via `apiKeyEnv`/inline
  since machine-specific `apiKeyFrom` files won't be present.
- **Mirror:** run the installer, then copy `~/.claude/cl-config.json` and the
  `~/.claude/cl-credentials/` folder from the old machine, and `cl doctor` to
  confirm. If an account uses `apiKeyFrom: { file }`, copy that file too or switch
  it to `apiKeyEnv`.

---

## Troubleshooting

- **`cl:switch` didn't open the picker / was treated as a normal message** — the
  running wrapper predates the code change. `/restart` the session (it re-execs
  the wrapper from disk). Any time cl-runner.js changes, live sessions need one
  `/restart`; hooks and the statusline reload on their own.
- **`/switch` errors with "cannot determine the safety of Bash"** — the account is
  rate-limited, so the classifier `/switch`'s bash needs is unavailable. Use
  `cl:switch` instead (it never touches the classifier).
- **No toast appeared** — toasts only fire for turns ≥ 30s (tune with
  `CL_NOTIFY_MIN_MS`, `0` = every turn). Check `~/.claude/cache/cl-notify.log` for
  the decision (`toast` / `skip` / `wait` / `fail`).
- **"REFUSING TO LAUNCH — conversation already open"** — that conversation is live
  in another cl window. Use that window, start a fresh `cl`, or override with
  `cl --force-duplicate` (not recommended).
- **`cl doctor`** is your first stop — it prints the resolved config and flags any
  broken account, missing key, or unwired hook.

---

## Repo layout

```
src/            wrapper + hooks (cl-runner, cl-config, cl-platform, cl-profile,
                cl-signal, cl-switch-*, cl-notify, cl-help, cl-focus.*,
                cl-wire-settings, usage-monitor, gw-usage, cl-sync, cl-setup)
mcp/            cl MCP server (account management + pool metrics tools)
pool/           optional pool-DB metrics tooling (pool-query, pool-neon-url)
commands/       slash commands (/switch, /restart, /cl)
test/           portable cross-platform test suite (run.js; `npm test`)
install.ps1     Windows installer · install.sh  Linux/macOS installer (idempotent)
```

## Notes & limitations

- **Cross-platform core; Windows-only extras.** Windows, macOS, and Linux all run
  the switcher, credential isolation, usage, and trash (CI-verified). Desktop toasts
  work on all three (WinRT / `osascript` / `notify-send`, silently no-op if no
  notifier). Only **click-to-focus** (raising the terminal from a toast) and **DPAPI**
  key encryption stay Windows-only; keys elsewhere use the OS keychain, a `0600`
  file, or `apiKeyEnv`/`apiKeyFrom`.
- All caches/state live under `~/.claude/cache/cl-*`; stale files are swept
  automatically (state daily, effort memories after 7 days, conversation locks by
  process liveness).
- `cl:switch` is the token-free interactive path; `/switch` is a slash command so
  it always costs a small model turn (Claude Code has no way to make a *custom*
  command instant — that path is reserved for built-ins).
- **`apiKeyEnc` is per user+machine** — a DPAPI blob only decrypts on the Windows
  account and machine that created it. Moving `cl-config.json` to another PC won't
  decrypt it; run `cl set-key <id>` there to re-encrypt. It's not defense against
  code already running as you (that could read the key when cl uses it) — it stops
  offline theft of a copied config/file.
- **Gateway usage (`usageUrl`) is provider-specific** — cl reads the common fields
  (cost, tokens, per-model, limits) from a MATE-style `/v1/usage` shape and degrades
  gracefully on anything else; a gateway with no usage endpoint just shows no usage.

## License

[MIT](LICENSE) © 2026 Veneto723
