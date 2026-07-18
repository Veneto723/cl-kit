# arc — architecture

On-demand depth for [`CLAUDE.md`](../CLAUDE.md). Read the section for the area you're touching; the always-loaded essentials and the two big gotchas live in CLAUDE.md and are not repeated here.

Everything is `src/*.js` — one focused module per file, no bundler, no TypeScript. `arc-runner.js` is the entry point (`arc.cmd` / `arc.sh` → `node arc-runner.js`).

---

## The account/session wrapper

- **`arc-runner.js`** — the launcher. Resolves which account to use (auto-selects the subscription while it has headroom, falls to the least-busy gateway only when it's exhausted; launch/resume only, never mid-session), builds the `claude` invocation, and handles **respawn** — a `switch`/`restart` relaunches the *same* conversation. `stripConvArgs` is load-bearing: on respawn it removes `--fork-session` (or the peer re-forks itself and abandons its history), `--continue`, and the birth prompt (or the peer re-submits its own claim forever). It strips the live `/arc-<verb>` spelling and retired `arc:<verb>` leftovers via arc-slash's own regexes (`SLASH_RX`, plus the strip-only `LEGACY_RX`).
- **`arc-config.js`** — config at `~/.claude/arc-config.json`; accounts, thresholds, features. A gateway key can be DPAPI-encrypted in-config, bound to the Windows login (`arc set-key <id>` to set/rotate). Config is backed up before every change.
- **`arc-profile.js`** — per-account profile isolation (each account gets its own `~/.claude` profile so logins/chats don't collide). Profile settings sync per-key from a shared merge policy; root-only writes are ineffective in profiled sessions.
- **`arc-switch-core.js`** — the mid-conversation account-swap engine: the same chat continues on the other account, preserving model, permission mode, and effort.
- **`usage-monitor.js` / `gw-usage.js`** — the statusline: subscription 5h/7d %, reset times, pace ETA; gateway accounts' real cost/tokens via a cached, zero-token metadata call.
- **`arc-update.js`** — the self-updater. A cached, fail-safe, bounded launch-time check against the repo's latest GitHub Release; `arc update` forces it; `arc release` is the gated dev-side publish. Everything on the launch path is fail-safe: any network/parse/FS error resolves to "no update" and launches normally.

## The coordination board

Independent `claude` sessions in one repo are **peers**; the append-only ledger is their only channel.

- **`arc-board.js`** — the data model. The ledger is `.arc/peer/notes.jsonl` (append-only, machine-local, gitignored). A note's identity is a stable `<origin>:<random>` id; its delivery order is a **per-origin `ord`** counted at read time. Because `ord` is scoped to one writer and git `merge=union` concatenates each side's lines without reordering, every machine counts the same ordinal for the same note — so a merged board delivers each note once with no skips or dupes. `origin.json` is the machine's identity and must **never** be committed or carried (two machines sharing an origin collide their ord streams). A **claim** (`claim-<role>.json`) is the pointer from a role to its conversation (`convId`) — the revive pointer. `isHolder` decides genuineness: a live pid whose process started *before* the claim's timestamp (Windows recycles pids, so a live-but-older-than-the-claim stranger would otherwise squat a chair). A **pid-less claim is a tombstone** — reads VACANT (`isHolder` requires a pid) but still carries the `convId`, so the chair stays revivable. Read the claim RAW (not through the genuineness filter) when you need the tombstone.
- **`arc-notes.js`** — the command handlers (`role`/`note`/`notes`), turn-start note **injection**, and the read cursor. Cursors and `seen-*` are per-role and machine-local; a note over ~7k chars spills to a `spill-<seq>.txt` delivery cache (regenerated from the ledger, so it never travels).
- **`arc-invite.js`** — spawning and reviving peers. **Birth** forks the caller (the newborn inherits the caller's transcript and must be told it is not the caller — the hook injects that identity correction on a fresh forked claim). **Revive** resumes the peer's own conversation via `--resume` (comes back as itself). A birth must not inherit `CLAUDE_CODE_*` / `ARC_SESSION`, or it never becomes its own session.
- **`arc-await.js`** — the listener. `arc join <role>` blocks in the background until a note lands, then exits — and *that exit is the wake* that re-invokes the idle session. `isWaiting` is a live-pid check on the await marker.
- **`arc-sync.js`** — export/import of sessions and the board across machines. Content (`notes.jsonl` + spills) travels; machine identity (`origin`, `claim` pids, cursors) does not — claims are tombstoned (pid stripped) at export, and a claim/cursor is only carried if its conversation actually landed at the destination root (checked through the same path canonicalization the board root uses, so short-name/junction spellings don't split one root into two).
- **`arc-done.js`** — derives task completion from **git evidence** (the commit), not the agent's word; hooked to `TaskCreated`/`TaskCompleted`.
- **`arc-postcommit.js`** — the commit broadcaster: wired as a repo's `.git/hooks/post-commit`, it turns every commit made from an arc session into a board note (attributed to the committer's role via `ARC_SESSION`; a no-op for non-arc commits, and it runs after the commit so it can never block or fail it).

### Roles and the board vocabulary

The nouns are **BOARD** (a repo's shared ledger), **PEER** (another session on it), **ROLE** (a named seat with a committed charter in `.arc/roles/<role>.md`), and **CLAIM** (a session holding a role). Charters travel in git and outlive the session that wrote them; the board (`.arc/peer/`) is machine-local scratch and never commits.

## The hook layer

Three Claude Code hooks (wired into `settings.json` by **`arc-wire-settings.js`**) make the board and the zero-token command surface work *before the model runs*:

- **`arc-switch-hook.js`** (UserPromptSubmit) — matches command prompts (`/arc-<verb>` via `SLASH_RX` + an arg-policy gate — the ONLY prompt spelling; the retired `arc:<verb>` form is never matched here, its `LEGACY_RX` survives strip-only in `stripConvArgs`) and dispatches them in-hook at zero tokens; delivers waiting board notes at turn start; and stamps the HEAD the peer has seen (a turn-*start* lower bound for the next revive's catch-up brief). A successful *new* role claim is the one command that deliberately passes the prompt through and spends a turn — only the model's own background command can arm the listener, so a blocked claim would go idle deaf.
- **`arc-stop-hook.js`** (Stop) — feeds a peer's reply back at turn end (no keystroke), nags an idle role-holder to arm its listener, and computes the DEAF badge (role-holder + unread + no live listener, persisted past a threshold to avoid flashing during the normal arming window).
- **`arc-pretool-hook.js`** (PreToolUse) — gates `arc delegate` under passive mode (a PreToolUse hook sees a tool call and can't tell the human's order from the agent's initiative, which is exactly why delegate has no prompt-command form — its spelling is matched only to refuse and redirect).
- **`arc-slash.js`** — the single source of truth for the verb set shared by `SLASH_RX` and the strip-only `LEGACY_RX`, plus the `/`-menu skill stubs; `node src/arc-slash.js` regenerates the stubs, and a drift test asserts they stay byte-exact.

## Testing conventions

`test/run.js` runs every test against a throwaway `HOME` (`mkdtemp` under the temp dir), set **before** any `src` module loads (config computes `~/.claude` at load time). No interactive `claude`, no network (a `*_NO_REFRESH` env var stubs usage fetches). CI runs `windows-latest`. Section 7 exercises the real Windows key path (a DPAPI round-trip via `powershell.exe`) and the junction path; keep everything else OS-portable so the suite at least loads on any box. `CORE` failures fail the build; `PROBE` is informational.
