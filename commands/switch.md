---
description: Switch this cl session to another configured account (optionally by id)
allowed-tools: Bash(node:*)
argument-hint: "[account-id]"
---

!`node "$HOME/.claude/scripts/cl-signal.js" switch $ARGUMENTS`

Above is the outcome of the switch request (the RESULT line). Relay it to the
user PLAINLY AND EXACTLY:
- If it says SWITCHING — the switch is happening; confirm it.
- If it shows a NUMBERED MENU of accounts (3+ accounts, no choice given yet) —
  present that list to the user and tell them to pick with `/switch <number>` or
  `/switch <name>`. NO switch has happened yet.
- If it says NOT SWITCHING — the switch did NOT happen; tell them why and what to
  do. Never imply a switch is in progress unless the RESULT line says SWITCHING.
Take no further action.

If instead of a RESULT line you see a PERMISSION / classifier error above (this
happens when the current account is rate-limited — /switch's bash needs the
classifier, which runs on that same exhausted account), tell the user to type
`cl:switch` (or `cl:switch <id>`) as a plain message: that path is a hook, runs
with no model/classifier, and works even when the account is fully rate-limited.
