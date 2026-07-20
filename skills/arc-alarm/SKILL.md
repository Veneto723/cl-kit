---
name: arc-alarm
description: "Raise a board-wide fire alarm — every peer stops at its next tool call; --clear clears it"
argument-hint: "<msg> | --clear"
disable-model-invocation: true
---

The arc UserPromptSubmit hook normally intercepts /arc-alarm BEFORE the model runs (zero tokens). You are reading this because ONE of: (1) the command carried extra prose it does not take — in that case the prose IS the user's real message: answer IT, do not execute anything; (2) the command spanned multiple lines (the hook matches single-line commands only); (3) the hook is not wired in this session. For (2) and (3): run `arc alarm` (the command WITHOUT any glued-on prose) in this session's shell and relay its output verbatim. If clean one-line commands keep reaching you, the hook is genuinely unwired — suggest `arc doctor`.
