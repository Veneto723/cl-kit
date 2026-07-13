---
name: share-with-roommate
description: You may be sharing this repo with ANOTHER cl session — a "roommate". Common pairs are an `android` session while you are `frontend`, a `backend` session while you are `android`, or a read-only `research` session while you write code. They cannot see your work and you cannot see theirs; the only channel is a shared "fridge" of sticky notes. When you finish something that CHANGES THEIR WORLD — a shared API/contract/schema change, a decision that affects their side, a blocker they'll hit, or a feature they depend on that just shipped — leave ONE concise note so they learn it at their next turn. Broadcast with `cl note all "<one line>"`, or target a role with `cl note <role> "<one line>"`. Run `cl role` first to see who is actually in the room. Do NOT narrate routine steps — only what a teammate would need to ACT on. If `cl role` shows no roommate, do nothing.
---

# Share with your roommate

Two `cl` sessions in one repo are **roommates**: independent Claude Code or Codex
sessions that can't see each other's context. The **fridge** is how they leave each
other notes — and you, the agent, put a note there by **running a terminal command**
(do not submit `cl:note` as a prompt; the runtime hook consumes that form before it
reaches the model).

## When to leave a note (high signal only)

Leave a note when you've done something the **other** session needs to know to do its job:

- a **shared contract changed** — an API shape, a JSON schema, a DB column, an event name
- a **decision** that constrains their side ("switched auth to httpOnly cookies")
- a **blocker** they will hit ("the staging DB is down; don't trust integration tests")
- a **feature shipped** that they build on ("payment-overlay fix landed on `main`")

Do **not** note routine progress ("read three files", "renamed a var", "tests pass"). If
it wouldn't change what your roommate does next, it's noise — skip it. A good note is one
line, in plain words, that a teammate could act on without reading your diff.

## How

```sh
cl role                         # who's in the room? what's my role?
cl note all "P-014: /login now returns 202, not 200 — update the client"
cl note backend "schema: added `retries` (int, default 0) to task_log"
cl notes                        # read what your roommate left you (also arrives at your turn start)
```

`cl note all` broadcasts to everyone in the room (simplest — you don't need to know their
role name). Target a specific role only when it's for one of them. Your own notes never
come back to you; the roommate receives them through cl at the start of their next turn.
Claude sessions also show a waiting-note mark in their statusline.

## Notes

- Commits already post themselves (a `post-commit` hook notes the sha + files), and
  completing a task posts a `done` note. So you don't need to announce *"I committed"* —
  use these notes for the **why / the heads-up**, the things a raw diff doesn't say.
- If `cl role` reports no roommate ("(nobody else here yet)"), you're solo — don't post.
