---
description: Reload the cl wrapper and restart claude on the same account
allowed-tools: Bash(node:*)
---

!`node "$HOME/.claude/scripts/cl-signal.js" restart`

The restart has been signaled to the cl wrapper. It will reload itself and
relaunch this session on the same account, continuing the conversation.
Do not take any further action.
