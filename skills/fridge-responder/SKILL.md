---
name: fridge-responder
description: Use this when you are a DELEGATE session that should ACT ON work your roommate hands you via the fridge without a human nudging you each time — e.g. a `research` session that investigates problems an `android` or `frontend` session delegates. The fridge only delivers notes when you take a turn, so an idle session never notices a delegation. To be responsive you WATCH the fridge in the background (`cl watch <your-role>`) as a background task or Monitor; each delegation then wakes you, you read it with `cl notes`, do the work, and post the answer back with `cl note <their-role> "<findings>"`. Invoke this skill at the START of a delegate/responder session to set up the watch, or whenever you're asked to "be the responder / handle delegations / watch the fridge".
---

# Be a fridge responder

An **idle** cl session can't be pushed to: the fridge delivers notes only when you take a
turn, and a turn only starts on a human prompt. So if a roommate delegates something
while you sit idle, you won't notice until a human nudges you. This skill removes that
nudge — you **watch the fridge in the background**, and an incoming delegation *wakes you*.

## Set it up (once, at the start of the session)

Arm a background watch on your own role. Two ways — pick whichever your harness has:

- **Monitor** (preferred, event-stream): start a persistent monitor whose command is
  `cl watch <your-role>` (e.g. `cl watch research`). Every delegation becomes an event.
- **Background task**: run `cl watch <your-role>` as a background shell task. Same effect
  — each new delegation prints a line that re-invokes you.

`cl watch` only *observes* — it never marks notes read. It fires immediately for any
delegation already waiting, then for each new one.

## When a delegation wakes you

1. **Read it:** run `cl notes` (this delivers the delegation AND marks it read).
2. **Do the work.** If you are a `research` session, stay **READ-ONLY on code** — you
   investigate and report; you do not edit or commit. That ownership split is the point:
   the coding session keeps the code, you bring back findings.
3. **Answer back:** `cl note <their-role> "<concise findings + a pointer, e.g. file:line>"`.
   They'll see it at their next turn (they're actively working, so no watch needed on
   their side).
4. **Keep watching.** If you used a one-shot background task, re-arm `cl watch`. A
   Monitor keeps running on its own.

## Honest limits

- Your session must stay **alive** (terminal open). A background waker pulls back an
  *idle* session; nothing can wake a *closed* one.
- A wake is not a human turn, so the fridge's automatic turn-start injection does NOT
  fire on it — that's why you must run `cl notes` yourself when woken.
