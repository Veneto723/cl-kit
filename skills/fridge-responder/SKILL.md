---
name: fridge-responder
description: Use this when you are a DELEGATE session that should ACT ON work your roommate hands you via the fridge without a human nudging you each time — e.g. a `research` session that investigates problems an `android` or `frontend` session delegates. The fridge only delivers notes when you take a turn, so an idle session never notices a delegation. To be responsive you WATCH the fridge in the background (`arc watch <your-role>`) as a background task or Monitor; each delegation then wakes you, you read it with `arc notes`, do the work, and post the answer back with `arc note <their-role> "<findings>"`. Invoke this skill at the START of a delegate/responder session to set up the watch, or whenever you're asked to "be the responder / handle delegations / watch the fridge".
---

# Be a fridge responder

An **idle** arc session can't be pushed to: the fridge delivers notes only when you take a
turn, and a turn only starts on a human prompt. So if a roommate delegates something
while you sit idle, you won't notice until a human nudges you. This skill removes that
nudge — you **watch the fridge in the background**, and an incoming delegation *wakes you*.

> **Stance gate.** Auto-acting on delegations without a human is *proactive* behaviour,
> governed by the arc **stance** (`arc:mode`). Only arm this watch when the user asks you to
> be the responder, or when you're in an **active** stance (you'll see `[arc stance: ACTIVE]`
> injected at turn start). Under **passive** (the default), don't self-arm — wait to be told.

## Set it up (once, at the start of the session)

Arm a background watch on your own role. Two ways — pick whichever your harness has:

- **Monitor** (preferred, event-stream): start a persistent monitor whose command is
  `arc watch <your-role>` (e.g. `arc watch research`). Every delegation becomes an event.
- **Background task**: run `arc watch <your-role>` as a background shell task. Same effect
  — each new delegation prints a line that re-invokes you.

`arc watch` only *observes* — it never marks notes read. It fires immediately for any
delegation already waiting, then for each new one.

## When a delegation wakes you

1. **Read it:** run `arc notes` (this delivers the delegation AND marks it read).
2. **Do the work.** If you are a `research` session, stay **READ-ONLY on code** — you
   investigate and report; you do not edit or commit. That ownership split is the point:
   the coding session keeps the code, you bring back findings.
3. **Answer back:** `arc note <their-role> "<concise findings + a pointer, e.g. file:line>"`.
   They'll see it at their next turn (they're actively working, so no watch needed on
   their side).
4. **Keep watching.** If you used a one-shot background task, re-arm `arc watch`. A
   Monitor keeps running on its own.

## Honest limits

- Your session must stay **alive** (terminal open). A background waker pulls back an
  *idle* session; nothing can wake a *closed* one.
- A wake is not a human turn, so the fridge's automatic turn-start injection does NOT
  fire on it — that's why you must run `arc notes` yourself when woken.
