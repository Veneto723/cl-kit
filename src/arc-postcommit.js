#!/usr/bin/env node
// arc-postcommit: turn every git commit into a fridge note, so two arc sessions working
// in one repo see each other's work WITHOUT anyone typing arc:note and WITHOUT needing
// the task list. Wired as a repo's .git/hooks/post-commit; runs AFTER the commit, so it
// can never block or fail it.
//
// It attributes the commit to the fridge ROLE of the session that ran `git commit`:
// `git commit` inherits the agent's Bash env, so ARC_SESSION is present, and ARC_SESSION →
// arc-role-<session>.json gives the role. A commit from a NON-arc shell (or a session with
// no role in this room) posts nothing — that keeps manual/tooling commits from spamming
// the fridge. The note is a broadcast, and the committer never sees its own note
// (unreadFor excludes own-role notes), so android sees frontend's commits and vice versa.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const R = require('./arc-room');

const MAX_FILES = 12;
const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

// The fridge role of `session`, but only if it was claimed in THIS room.
function roleFor(session, room) {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `arc-role-${session}.json`), 'utf8'));
    return r.room === room.root ? r.role : null;
  } catch { return null; }
}

function run(cwd) {
  const room = R.resolveRoom(cwd);
  const session = (process.env.ARC_SESSION || '').trim();
  const role = session ? roleFor(session, room) : null;
  if (!role) return { posted: false, why: 'no arc role for this commit' };

  const sha = git(cwd, ['rev-parse', '--short', 'HEAD']);
  if (!sha) return { posted: false, why: 'no HEAD' };
  const subject = git(cwd, ['log', '-1', '--format=%s']) || '(no subject)';
  const files = (git(cwd, ['show', '--name-only', '--format=', 'HEAD']) || '').split('\n').filter(Boolean);

  const refs = { sha, files: files.slice(0, MAX_FILES) };
  if (files.length > MAX_FILES) refs.more = files.length - MAX_FILES;

  R.appendNote(room, { from: role, to: null, priority: 'normal', body: `committed: ${subject}`, refs });
  return { posted: true, role, sha, files: files.length, subject };
}

module.exports = { run, roleFor, git };

// Wired as .git/hooks/post-commit → runs with cwd = repo root. Must NEVER throw.
if (require.main === module) {
  try { run(process.cwd()); } catch { /* a post-commit hook must never disrupt the repo */ }
  process.exit(0);
}
