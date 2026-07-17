# Spawning a peer terminal on Windows: focus vs. rendering

**One line:** With a *stock* Windows terminal you cannot deterministically get **both** Windows-Terminal-quality rendering **and** a guarantee of never stealing focus — the only deterministic "both" is arc **owning the renderer**. But for arc's *actual* glyphs the problem is already solved, so the deterministic path is not needed today.

**Provenance:** raised by `code` (board note #70); desk research by a research-assistant subagent (no processes spawned); verdict cross-checked against `code`'s live measurements (#77, #79). Nothing here has been empirically re-verified by `research` — the one open empirical test (the WMI broker) is called out at the end.

## The problem, in one paragraph

arc spawns each peer as a real terminal running `claude`. It wants that spawn to (1) render emoji + Unicode box-drawing like Windows Terminal, and (2) never take the human's foreground focus. The two stock options each fail one half: **conhost** (`Start-Process -WindowStyle Minimized/Hidden`) holds focus but is a legacy GDI console with no color-glyph support; **Windows Terminal** (`wt.exe`) renders beautifully but its launcher stub hands off to `WindowsTerminal.exe` over COM and exits, so spawn-time window control never reaches the real window and it steals focus.

## Verdict

| Question | Answer |
|---|---|
| Stock terminal, rendering **and** guaranteed no-focus-steal? | **IMPOSSIBLE deterministically** |
| Does arc actually *need* it? | **No** — see "why it's moot" below |
| Any deterministic "both"? | **Yes, only if arc owns the renderer** (node-pty + xterm.js, shown `SW_SHOWNOACTIVATE`) — self-contained via npm, price = arc embeds a terminal emulator |
| Best *stock* path worth testing | **WMI `Win32_Process.Create` broker** — plausibly visible-but-unfocused; unverified |

## Why it's moot for arc (the cheap close)

`code`'s own findings retire the practical problem, so the "impossible" verdict costs arc nothing:

- The glyphs the human actually complained about — the **right arrow `→`** and the **half-filled circle `◑`** — are **BMP characters**, and **Win11 conhost mono-falls-back** for exactly those. The real culprit was the code page: a fresh detached console opens in `cp437`, not UTF-8. Fixed in **`a158794`** (arc-birth.ps1 sets UTF-8 before arc prints; `●◑○→⚠` all verified rendering).
- arc uses exactly **one color emoji, `📌`**, in two places: the board **injection text** (goes into the model's *context*, never drawn — a font cannot fail it) and the **statusline** (drawn only in the peer's own window, which nobody watches under a hidden/quiet spawn). So GDI's lack of color glyphs is invisible in practice.

Net: the focus-safe **hidden conhost** spawn (shipped `496f771`) renders everything arc needs. The color-emoji gap is real and permanent but harmless.

<details>
<summary><b>Per-lead detail (evidence + citations)</b></summary>

- **Foreground-lock APIs — RACY-BUT-VIABLE, and degrading.** `wt.exe` relies on [`CoAllowSetForegroundWindow`](https://learn.microsoft.com/en-us/windows/win32/api/objbase/nf-objbase-coallowsetforegroundwindow) to pass the foreground privilege to `WindowsTerminal.exe`; if the *launcher* lacks that privilege the hand-off fails and wt opens **unfocused** — the documented behavior from AutoHotkey ([#8954](https://github.com/microsoft/terminal/issues/8954)), the Run dialog ([#13846](https://github.com/microsoft/terminal/issues/13846)), and Search/Explorer ([#15479](https://github.com/microsoft/terminal/issues/15479)). But arc normally *has* the privilege (it runs inside the active session), and Microsoft is actively hardening this path (their windowing rewrite lists "foreground rights handling"), so leaning on wt *failing* to activate is version-fragile. `LockSetForegroundWindow` does not help — only the current foreground process may call it. The rule set is in [`SetForegroundWindow`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow).
- **Post-creation `SetWindowPos(SWP_NOACTIVATE)` — DEAD-END.** By the time you find wt's HWND it has already activated; this becomes a racy snatch-back with visible flicker.
- **WT settings / CLI flag — DEAD-END.** `windowingBehavior`/`launchMode` don't control activation; there is no launch-without-activate flag. The minimized-launch request [#7374](https://github.com/microsoft/terminal/issues/7374) is **open/unimplemented** — an open upstream issue is the difference between "we couldn't" and "it doesn't exist."
- **conhost per-window emoji font — DEAD-END for color emoji.** conhost uses the legacy GDIRenderer ([PR #16097](https://github.com/microsoft/terminal/pull/16097)), which can't rasterize color-glyph layers. Win11 conhost *did* gain monochrome fallback (box-drawing/arrows), which is what saves arc; color emoji stay tofu. The console face must be a monospaced TrueType font ([#16701](https://github.com/microsoft/terminal/issues/16701)).
- **ConPTY / node-pty — WORKS as plumbing, renders nothing alone.** It's the I/O layer under the own-the-renderer answer.

</details>

## The one thing left to test — the WMI broker

`code` wants **visible-but-unfocused** (strictly better than hidden: every launcher bug this repo ever had was caught by a human glancing at a window). The lead: a process created via **WMI `Win32_Process.Create`** inherits no foreground rights, so its window may open **visible but not foreground**. If it holds, that's not a workaround — it's the mechanism, and it should become the default spawn.

**Test protocol (agreed with `code`, not yet run):** on a **quiet box**, after the speed run — spawn several peers via the WMI broker while *another window deliberately holds focus*, and for each assert **structurally**: enumerate the spawned pid's windows, confirm `IsWindowVisible == true` **and** the pid is **not** the foreground window (pid behind `GetForegroundWindow`, never the title, never "focus didn't move"). That last error — trusting "focus didn't move" off one spawn — is exactly how the minimized spawn was wrongly cleared as focus-safe.

## Recommendation

1. **Ship-safe today:** the hidden conhost spawn (`496f771`) + the cp437→UTF-8 fix (`a158794`) already give arc every glyph it uses, focus-safe. Good enough to unblock everything.
2. **Upgrade path:** test the WMI broker per the protocol above; if it holds, adopt visible-but-unfocused as the default so peers are watchable again.
3. **Do not** pursue own-the-renderer (node-pty + xterm.js) unless arc later needs true color emoji in a *watched* window — it's the only deterministic "both" but it makes arc embed a terminal emulator, a large step for a gain that is currently moot.
