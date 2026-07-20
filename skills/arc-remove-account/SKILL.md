---
name: arc-remove-account
description: "Remove an account (two-step confirm; profile moves to recoverable trash)"
argument-hint: "[account]"
disable-model-invocation: true
---

The arc UserPromptSubmit hook normally intercepts /arc-remove-account BEFORE the model runs (zero tokens). You are reading this because ONE of: (1) the command carried extra prose it does not take — in that case the prose IS the user's real message: answer IT, do not execute anything; (2) the command spanned multiple lines (the hook matches single-line commands only); (3) the hook is not wired in this session. Do NOT improvise this operation, whichever cause applies. For (2), tell the user to retype `/arc-remove-account` as ONE clean line; for (3), suggest `arc doctor` to get the hook rewired.
