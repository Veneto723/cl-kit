---
description: Switch this cl session to another configured account (optionally by id)
allowed-tools: Bash(node:*)
argument-hint: "[account-id]"
---

!`node "$HOME/.claude/scripts/cl-signal.js" switch $ARGUMENTS`

Above is the outcome of the switch request (the RESULT line). Relay it to the
user PLAINLY AND EXACTLY — especially when it says NOT SWITCHING: tell them the
switch did NOT happen, why, and what to do about it. Never imply a switch is in
progress unless the RESULT line says SWITCHING. Take no further action.

If instead of a RESULT line you see a PERMISSION / classifier error above (this
happens when the current account is rate-limited — /switch's bash needs the
classifier, which runs on that same exhausted account), tell the user to type
`cl:switch` (or `cl:switch <id>`) as a plain message: that path is a hook, runs
with no model/classifier, and works even when the account is fully rate-limited.
