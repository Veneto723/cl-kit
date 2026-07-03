---
description: Switch this cl session to another configured account (optionally by id)
allowed-tools: Bash(node:*)
argument-hint: "[account-id]"
---

!`node "$HOME/.claude/scripts/cl-signal.js" switch $ARGUMENTS`

The account switch has been signaled to the cl wrapper. It will confirm and
relaunch this session on the target account shortly, continuing the conversation.
Do not take any further action.
