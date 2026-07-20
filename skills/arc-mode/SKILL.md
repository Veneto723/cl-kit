---
name: arc-mode
description: "Set agent initiative — passive, balanced, or active (bare opens dial)"
argument-hint: "[passive|balanced|active]"
disable-model-invocation: true
---

The arc UserPromptSubmit hook normally intercepts /arc-mode BEFORE the model runs (zero tokens). You are reading this because ONE of: (1) the command carried extra prose it does not take — in that case the prose IS the user's real message: answer IT, do not execute anything; (2) the command spanned multiple lines (the hook matches single-line commands only); (3) the hook is not wired in this session. Do NOT improvise this operation, whichever cause applies. For (2), tell the user to retype `/arc-mode` as ONE clean line; for (3), suggest `arc doctor` to get the hook rewired.
