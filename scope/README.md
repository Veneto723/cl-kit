# arc · scope

A docked, always-on-top desktop monitor for your arc board — live roles, session/note counts, the
**who-waits-on-whom** graph (unseen asks in red, with a left severity stripe), and recent replies.
It polls arc's feed (`http://127.0.0.1:8791/status`) every ~1.5s and renders the operator view as a
compact instrument panel. Drag it by the header; `–` minimizes to the taskbar, `✕` closes.

This is arc's opt-in **companion**. It lives in the arc repo under `scope/`, deliberately kept out of
the pure-Node `src/` — a first-party GUI in its own subtree, the way `mcp/` is. **arc ships the feed;
this is one face for it.**

## Why this exists / what makes it different

It is a **native WPF app on .NET Framework 4.x**, which is built into every Windows 10/11. So:

- **Nothing to install to run it.** No Rust, no .NET SDK, no WebView2, no PowerShell. Any Windows
  machine can run `arc-scope.exe` as-is.
- **Built with the compiler already in Windows.** `build.ps1` calls `csc.exe` from
  `C:\Windows\Microsoft.NET\Framework64\v4.0.30319` — no toolchain to set up.
- **Tiny and well-behaved.** ~47 KB single `.exe`, a normal OS process (single-instance) — none of
  the windowless-launch flakiness a PowerShell-hosted window can have.

## Run

The feed comes up automatically with any arc session (or `arc feed`). Then just run the app:

```
arc-scope.exe                 # double-click, or from a shell
arc-scope.exe --port 8791     # if you run the feed on a non-default port
```

If the feed is down, the panel shows `feed offline — start it: arc feed`. Pin it to the taskbar or
drop a shortcut in `shell:startup` to have it there every login.

## Build

Requires only what Windows already has (the .NET Framework C# compiler + WPF assemblies):

```
powershell -ExecutionPolicy Bypass -File build.ps1
```

That emits `arc-scope.exe` next to the source. There is no SDK, project file, or package restore.

## How it's put together

- **`arc-scope.cs`** — the whole app in one file. The UI is created from a XAML *string* via
  `XamlReader.Parse` (no XAML compile step), so the design is plain markup you can edit inline. A
  ~60-line dependency-free JSON reader parses `/status`; a background thread does the HTTP so the UI
  never blocks; a `DispatcherTimer` re-polls. Single-instance via a named `Mutex`.
- **`build.ps1`** — the in-box `csc.exe` invocation, referencing the WPF runtime assemblies directly
  (no reference-assemblies pack needed).

## Customize the look

Everything visual lives in `arc-scope.cs`: the window shell is the `XAML` constant near the bottom;
each repo card is assembled in `Card()`. Colors are a committed dark palette — accent azure `#5AA3FF`
for arc's identity + the "from" node, and semantic state (green `#46C168` live / amber `#E0A13A`
waiting / red `#F2564C` unseen) kept separate from the accent. Edit, re-run `build.ps1`.
