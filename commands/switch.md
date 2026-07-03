---
description: "Switch account picker (tip: type cl:switch for zero tokens / when rate-limited; /cl for all commands)"
allowed-tools: Bash(node:*)
argument-hint: "[account-id]"
---

!`node "$HOME/.claude/scripts/cl-signal.js" switch $ARGUMENTS`

Above is the outcome of the switch request (the RESULT line). Respond in ONE
short line, then STOP:
- If it says "opening account picker" — an interactive arrow-key picker is
  opening in the terminal now (cl-runner takes over momentarily). Just say
  something like "Opening the account picker — use ↑/↓ and Enter." Do NOT do
  anything else.
- If it says SWITCHING — the switch is happening; confirm briefly.
- If it says NOT SWITCHING — say the switch did NOT happen and why.
Never imply a switch happened unless it says SWITCHING. Take no further action.

If instead of a RESULT line you see a PERMISSION / classifier error (the account
is rate-limited — /switch's bash needs the classifier, which runs on that
exhausted account), tell the user to type `cl:switch` as a plain message: it's a
hook that runs with no model/classifier and works even when fully rate-limited.
