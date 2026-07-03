# cl-kit — account switcher & session toolkit for Claude Code (Windows 11)

`cl` wraps Claude Code with **native stdio** (zero rendering glitches — claude owns
the TTY) and adds mid-session account switching, session-completion toasts,
safeguard-flag auto-retry, and a usage statusline. Every piece is driven by one
config file, so it fits any account style:

| Style | Example |
|---|---|
| single subscription | one claude.ai MAX/Pro login, just want the session tools |
| two subscriptions | personal + work claude.ai logins, `/switch` between them |
| subscription + gateway | claude.ai login + an Anthropic-compatible API pool/proxy |
| gateway only | API base URL + key, no claude.ai login |
| any mix | N accounts, `/switch <id>` targets any of them |

## Install

```powershell
git clone <this-repo> cl-kit
cd cl-kit
powershell -ExecutionPolicy Bypass -File install.ps1
cl setup     # interactive: pick your style, define accounts
cl doctor    # verify everything resolves
cl           # launch
```

Requires: Windows 11, Node.js, Claude Code (`claude` CLI installed).

## What you get

- **`cl`** — launches claude on the configured default account. Each terminal owns
  ONE conversation (UUID-pinned), so parallel terminals never cross-contaminate.
  - `cl --account <id>` (or `--<id>`) — start on a specific account
  - `cl --effort <level>` — pin the effort for the whole session
  - `cl --resume <uuid>` / bare `cl --resume` (picker) — both restore the
    conversation's remembered model, permission mode, and effort (incl. ultracode)
- **`/switch [id]`** — real slash command; relaunches THIS conversation on the next
  (or named) account, preserving model / permission mode / effort. Manual-only:
  there is no usage-based auto-switching.
- **`/restart`** — reload the wrapper (fresh on-disk code) + relaunch, same account.
- **Statusline** — active account label (your color), oauth usage % + reset times +
  pace ETA, blink warnings near limits, optional pool-DB per-account metrics,
  model + effort (sticky ultracode detection).
- **Toasts** (labeled with the session's `/rename` name, colored state icons):
  - green ✅ turn finished (≥30s; tune `CL_NOTIFY_MIN_MS`, 0 = every turn)
  - amber ⏸ session waiting on a permission prompt
  - red ✖ turn stopped on an error
  - **click a toast → that session's terminal window comes to the foreground**
    (`cl-focus:` protocol, HKCU-registered)
- **Safeguard-flag auto-retry** — when the model's safety layer flags a benign
  message and falls back to another model, cl rephrases the message (via
  `features.rephraseAccount`) and auto-retries it on the original model. One
  retry per message, never rephrases a rephrase. Disable: `features.flagRetry: false`.
- **Pool metrics (optional)** — point `poolDb.neonUrl` at a Postgres DB with
  `pool_accounts` / `account_usage` tables and get: statusline per-account
  utilization, `/pool` table, and a `pool` MCP server (`pool_status`,
  `pool_next_reset`).

## Config (`~/.claude/cl-config.json`)

```jsonc
{
  "version": 1,
  "defaultAccount": "max",
  "accounts": [
    { "id": "max", "label": "MAX", "color": "#D97757", "type": "oauth" },
    {
      "id": "pool", "label": "POOL", "color": "#2DD4BF", "type": "api",
      "baseUrl": "https://my-gateway.example.com",
      "apiKeyEnv": "MY_GATEWAY_KEY",            // or "apiKey": "...", or:
      // "apiKeyFrom": { "file": "~/keys.txt", "regex": "key=(sk-[\\w-]+)" },
      "modelMap": { "opus": "opus", "sonnet": "sonnet", "haiku": "haiku", "fable": "fable" },
      "headers": { "x-title": "claude" }
    }
  ],
  "switchOrder": ["max", "pool"],
  "thresholds": { "warnSessionPct": 85, "warnWeekPct": 90, "switchSessionPct": 92, "switchWeekPct": 95 },
  "features": { "flagRetry": true, "rephraseAccount": "pool" },
  "poolDb": { "neonUrl": "postgresql://..." }   // optional
}
```

### Two subscriptions

Claude Code stores its claude.ai login in one file, so cl swaps captured
credentials on switch (sessions/transcripts stay unified):

```powershell
# log in as subscription A (claude /login), then:
cl capture personal
# /logout, log in as subscription B, then:
cl capture work
```

After that `/switch` alternates logins seamlessly. Captures live in
`~/.claude/cl-credentials/` — treat that directory as secret.

## Notes

- Windows 11 only (toasts, window-focus, taskkill, registry are all Win-specific).
- `cl doctor` prints the resolved config and flags anything broken.
- All caches/state live in `~/.claude/cache/cl-*`; stale files are swept daily.
- The installer merges into `settings.json` (backup written first) and never
  removes your existing hooks.
