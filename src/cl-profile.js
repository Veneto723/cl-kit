// cl-profile: per-account CLAUDE_CONFIG_DIR profiles — the fix for the
// cross-session credential hijack. Each account gets its own config dir under
// ~/.claude/cl-profiles/<id>; cl points Claude Code at it via CLAUDE_CONFIG_DIR
// when launching. Claude Code relocates BOTH .credentials.json AND .claude.json
// (the constantly-rewritten OAuth binding) into that dir, so concurrent sessions
// on DIFFERENT accounts never share/fight over one credentials file. The shared
// "brain" — conversations, slash commands, skills, session metadata, todos — is
// JUNCTIONED back to the real ~/.claude so it stays common across accounts;
// settings.json's hooks + statusLine + permissions are synced in (cl owns them).
// No credential swapping, ever, so there is nothing to race on.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./cl-config');

const PROFILES_DIR = path.join(C.CLAUDE_DIR, 'cl-profiles');
// The "brain" — junctioned back to ~/.claude so every account shares it. (Windows
// directory junctions need no admin, unlike file symlinks.)
const SHARED_DIRS = ['projects', 'sessions', 'commands', 'todos', 'skills', 'agents', 'plugins'];
// Claude Code's main state file lives at the HOME ROOT (~/.claude.json); under
// CLAUDE_CONFIG_DIR it moves to <dir>/.claude.json. We seed MCP servers + trust
// from the home one so a fresh profile still has the user's servers.
const HOME_CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
// settings.json keys cl OWNS and must propagate into every profile so the zero-
// token cl: hooks, the usage statusline, and the user's permission allow-list all
// work inside a profiled session. Everything else (theme, model, per-account
// /config) is left to Claude Code / the user per profile.
const CL_SETTINGS_KEYS = ['hooks', 'statusLine', 'permissions'];

function profileDir(accId) { return path.join(PROFILES_DIR, String(accId)); }
function credsPath(accId) { return path.join(profileDir(accId), '.credentials.json'); }

function isLinkTo(p, target) {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return false;
    return path.resolve(fs.readlinkSync(p)) === path.resolve(target);
  } catch { return false; }
}

// Sync cl's hooks + statusLine + permissions into the profile's settings.json
// WITHOUT clobbering any per-account settings the user set via /config. Merges
// only the cl-owned keys.
function syncSettings(dir) {
  const src = path.join(C.CLAUDE_DIR, 'settings.json');
  let master; try { master = JSON.parse(fs.readFileSync(src, 'utf8')); } catch { return; }
  const dst = path.join(dir, 'settings.json');
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(dst, 'utf8')); } catch {}
  const next = { ...cur };
  for (const k of CL_SETTINGS_KEYS) if (master[k] !== undefined) next[k] = master[k];
  try {
    if (JSON.stringify(next) !== JSON.stringify(cur)) fs.writeFileSync(dst, JSON.stringify(next, null, 2));
  } catch {}
}

// Seed a fresh profile's .claude.json from ~/.claude.json (MCP servers + project
// trust + onboarding), MINUS the account binding so /login sets it cleanly. Only
// when absent — never overwrite Claude Code's live copy.
function seedClaudeJson(dir) {
  const dst = path.join(dir, '.claude.json');
  if (fs.existsSync(dst)) return;
  let seed = {};
  try {
    seed = JSON.parse(fs.readFileSync(HOME_CLAUDE_JSON, 'utf8'));
    delete seed.oauthAccount;           // account-specific — Claude Code rebinds on /login
  } catch {}
  try { fs.writeFileSync(dst, JSON.stringify(seed)); } catch {}
}

// Create/repair `accId`'s profile dir. Idempotent — cheap to call every launch.
// Returns the dir path (to use as CLAUDE_CONFIG_DIR).
function ensureProfile(accId) {
  const dir = profileDir(accId);
  fs.mkdirSync(dir, { recursive: true });
  for (const d of SHARED_DIRS) {
    const target = path.join(C.CLAUDE_DIR, d);
    const link = path.join(dir, d);
    if (isLinkTo(link, target)) continue;
    try {
      if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
      try { const st = fs.lstatSync(link); if (st.isSymbolicLink()) fs.unlinkSync(link); else fs.rmSync(link, { recursive: true, force: true }); } catch {}
      fs.symlinkSync(target, link, 'junction');
    } catch {}
  }
  seedClaudeJson(dir);
  syncSettings(dir);
  return dir;
}

// Does this account already have a login in its profile? (false → Claude Code
// will prompt /login on launch, which is how a fresh account is established.)
function hasCreds(accId) {
  try { return !!JSON.parse(fs.readFileSync(credsPath(accId), 'utf8')).claudeAiOauth.accessToken; }
  catch { return false; }
}

// Seed an account's profile login from an existing credentials file (an old
// captured file, or the live ~/.claude/.credentials.json). ONLY when the profile
// has no login yet — never overwrites a real per-account login. Returns true if a
// login was seeded. Used by the one-time migration and by `cl capture`.
function seedCreds(accId, srcPath) {
  if (!srcPath || hasCreds(accId)) return false;
  let data;
  try { data = fs.readFileSync(srcPath, 'utf8'); } catch { return false; }
  try { if (!JSON.parse(data).claudeAiOauth.accessToken) return false; } catch { return false; }
  try {
    ensureProfile(accId);
    fs.writeFileSync(credsPath(accId), data);
    return true;
  } catch { return false; }
}

// Move an account's profile dir old → new (preserving its login when the account
// is renamed). The junctions inside point at ABSOLUTE ~/.claude targets, so they
// survive the move. Caller must ensure no live process holds oldDir open (Windows
// won't rename an open dir) — cl-runner renames only after killing claude. Returns
// true if a dir was moved, false if there was nothing to move.
function renameProfile(oldId, newId) {
  const oldDir = profileDir(oldId), newDir = profileDir(newId);
  if (!fs.existsSync(oldDir)) return false;
  // A case-ONLY change (work → Work) is legal even though a case-insensitive
  // filesystem (Windows/macOS) reports newDir as already existing — it's the SAME
  // dir. Rename through a temp name so the on-disk casing actually flips (a direct
  // case-only rename is a no-op on some filesystems).
  const caseOnly = oldId !== newId && String(oldId).toLowerCase() === String(newId).toLowerCase();
  if (!caseOnly && fs.existsSync(newDir)) throw new Error(`profile dir for "${newId}" already exists`);
  if (caseOnly) {
    const tmp = profileDir(`${oldId}.rncase-${process.pid}`);
    fs.renameSync(oldDir, tmp);
    fs.renameSync(tmp, newDir);
  } else {
    fs.renameSync(oldDir, newDir);
  }
  return true;
}

module.exports = { PROFILES_DIR, profileDir, credsPath, ensureProfile, hasCreds, seedCreds, renameProfile, SHARED_DIRS };
