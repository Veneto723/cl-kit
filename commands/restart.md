---
description: Reload the cl wrapper and restart claude on the same account
allowed-tools: Bash(node:*)
---

!`node "$HOME/.claude/scripts/cl-signal.js" restart`

Above is the outcome of the restart request (the RESULT line). Relay it to the
user plainly and exactly. If it says the session is not under the cl wrapper,
tell them that — do not imply a restart is happening. Take no further action.
