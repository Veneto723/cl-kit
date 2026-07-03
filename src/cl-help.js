#!/usr/bin/env node
// cl-help: prints the cl command cheat sheet. Invoked by the /cl slash command
// so the zero-token `cl:` sentinels (which can't appear in the native / menu)
// are still discoverable — /cl IS in the menu and documents everything.
'use strict';

const C = require('./cl-config');

let accounts = [];
try { accounts = C.loadConfig().accounts.map((a) => a.id); } catch {}
const example = accounts[1] || accounts[0] || 'pool';

process.stdout.write(`cl — commands
=============

Switch account (keeps your conversation, preserves model/effort/mode):
  cl:switch              open the interactive picker — ZERO tokens
  cl:switch ${example.padEnd(12)} switch straight to an account (by name or number)
  /switch                same picker, from the / menu (costs a small model turn)
  /switch ${example.padEnd(13)} switch directly, from the / menu

Add / manage accounts:
  cl:add-account <id>    guided browser login to add a subscription (in-session)
  cl add-account <id>    same, run from a terminal
  cl:remove-account <id> remove an account (asks; then repeat with 'confirm')

Move chats between PCs (discrete export/import — no realtime sync):
  cl:export              archive the CURRENT conversation → ~/cl-export-<ts>.tgz
  cl:export all          archive every session   ·   cl:export <project|id>
  cl:import <archive>    merge sessions in (newer-wins; live chats protected)

Session:
  cl:restart   /restart  reload the wrapper + relaunch this conversation
  cl:delete              delete THIS conversation → trash, start fresh (asks; then 'confirm')
  /pool                  pool account usage % + reset times

Why two forms?
  cl:...  are plain messages caught by a hook BEFORE the model runs — they cost
          NO tokens and work even when the account is rate-limited (when /switch
          can't, because its bash needs a classifier on the exhausted account).
  /...    are discoverable in the / menu but cost one small model turn.
  Tip: prefer the cl: forms; use / when you want to browse the menu.

In your terminal (not inside a session):
  cl                     launch
  cl --account <id>      launch on a specific account
  cl add-account <id>    guided browser login to add a subscription
  cl doctor              health check    ·    cl setup    reconfigure

Configured accounts: ${accounts.join(', ') || '(none — run `cl setup`)'}
`);
