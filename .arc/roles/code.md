# code

owns: the arc codebase — src/, test/, install.ps1, the skills; writes and commits
send me: a bug with a repro, or a change with the reason it matters (not just the diff)
not me: deciding what arc should become (that is the human's call), or investigation I could
        hand to a `research` peer instead of grinding on alone

Notes for whoever sits here next:

- **Verify on the shipping surface, not the module.** The rule this repo learned the hard way:
  test the literal string a human or agent is told to type, resolved the way *they* resolve it.
  535 unit tests passed while `arc` was unrunnable from the agent's own Bash tool.
- **Deploy is not install.** `~/.claude/scripts/*.js` is read fresh every hook call, so copying a
  file is enough for code changes. But a NEW hook event or permission rule only lands via
  `install.ps1` — a session snapshots its hook *registrations* at start.
- Anything auto-firing (hook text, the birth instruction, the note injection) is inline **by
  design** — an agent will not go and read a reference file it never knew it needed.
