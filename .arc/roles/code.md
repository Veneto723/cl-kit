# code

owns: the arc codebase — src/, test/, install.ps1, the skills; writes and commits
send me: a bug with a repro, or a change with the reason it matters (not just the diff)
not me: deciding what arc should become (that is the human's call), investigation I could
        hand to a `research` peer instead of grinding on alone, or SELF-CERTIFYING my own work
        on the sensitive paths — a measured claim, OR a diff touching instrument code / hooks &
        gates / data-integrity paths, goes to the `audit` chair for a verdict before it enters
        the record (de0ed0f, human-approved; authors do not mark their own homework). I still
        run /code-review as a pre-pass; audit is the independent verdict, never a fix.
paths: src/** test/** install.ps1 skills/** bundles/** mcp/** pool/**

Notes for whoever sits here next:

- **Verify on the shipping surface, not the module.** The rule this repo learned the hard way:
  test the literal string a human or agent is told to type, resolved the way *they* resolve it.
  535 unit tests passed while `arc` was unrunnable from the agent's own Bash tool.
- **Deploy is not install.** `~/.claude/scripts/*.js` is read fresh every hook call, so copying a
  file is enough for code changes. But a NEW hook event or permission rule only lands via
  `install.ps1` — a session snapshots its hook *registrations* at start.
- Anything auto-firing (hook text, the birth instruction, the note injection) is inline **by
  design** — an agent will not go and read a reference file it never knew it needed.
