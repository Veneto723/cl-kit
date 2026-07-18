// arc-profile: per-account CLAUDE_CONFIG_DIR profiles — the fix for the
// cross-session credential hijack. Each account gets its own config dir under
// ~/.claude/arc-profiles/<id>; arc points Claude Code at it via CLAUDE_CONFIG_DIR
// when launching. Claude Code relocates BOTH .credentials.json AND .claude.json
// (the constantly-rewritten OAuth binding) into that dir, so concurrent sessions
// on DIFFERENT accounts never share/fight over one credentials file. The shared
// "brain" — conversations, slash commands, skills, session metadata, todos — is
// JUNCTIONED back to the real ~/.claude so it stays common across accounts;
// settings.json's hooks + statusLine + permissions are synced in (arc owns them).
// No credential swapping, ever, so there is nothing to race on.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./arc-config');

const PROFILES_DIR = path.join(C.CLAUDE_DIR, 'arc-profiles');
// The "brain" — junctioned back to ~/.claude so every account shares it. (Windows
// directory junctions need no admin, unlike file symlinks.)
//
// `tasks` is Claude Code's TaskCreate/TaskUpdate list: <config>/tasks/<session-id>/<id>.json
// plus a .lock. It belongs here for the same reason `sessions` and `todos` do — a
// conversation resumed on another account is the SAME conversation and must keep its
// task list. Without it, `/arc-switch` silently showed an EMPTY task list, because the
// new profile had no tasks/<session-id>/ of its own. (Observed: session 6665bfca had 4
// tasks under ~/.claude/tasks and an empty dir under arc-profiles/max/tasks.)
const SHARED_DIRS = ['projects', 'sessions', 'commands', 'todos', 'tasks', 'skills', 'agents', 'plugins'];
// Claude Code's main state file lives at the HOME ROOT (~/.claude.json); under
// CLAUDE_CONFIG_DIR it moves to <dir>/.claude.json. We seed MCP servers + trust
// from the home one so a fresh profile still has the user's servers.
const HOME_CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
// settings.json keys arc OWNS and must propagate into every profile so the zero-
// token /arc- command hooks, the usage statusline, the user's permission allow-list, and the
// /arc-* skill-menu overrides all work inside a profiled session. Everything else
// (theme, model, per-account /config) is left to Claude Code / the user per profile.
// PROVEN GAP this list closes: a root-only skillOverrides never reaches a profiled
// session (CLAUDE_CONFIG_DIR points at the profile dir, which reads its OWN
// settings.json) — observed live: root overrides hid skills at root and every
// profiled session still listed them.
//
// THE POLICY TRAVELS WITH THE KEY (roadmap #7, human-approved 2026-07-18). This used
// to be a bare name list whose loop DEFAULTED to wholesale replace — and that default
// silently ate profile-local values TWICE (the human's own permission grants, then
// nearly skillOverrides), each rescued afterward with a bespoke branch. Now adding a
// key FORCES the merge decision here, at the declaration:
//   replace — arc is the SOLE author (hooks, statusLine): the root copy is the truth
//             and a profile edit to it is drift, not a choice to preserve.
//   union   — permissions: profile-local scalars win, allow/deny/ask lists union, so
//             a /permissions grant made inside a profiled session survives launch.
//   overlay — plain per-key map, profile wins (skillOverrides via the SHARED
//             overlayMaps in arc-wire-settings — one policy, not two copies).
// A key with an unknown policy is SKIPPED at runtime (not-synced beats clobbered) and
// FAILS THE SUITE — a silent wrong default is the exact bug this shape retires.
const ARC_SETTINGS_KEYS = [
  { key: 'hooks',          merge: 'replace' },
  { key: 'statusLine',     merge: 'replace' },
  { key: 'permissions',    merge: 'union'   },
  { key: 'skillOverrides', merge: 'overlay' },
];

function profileDir(accId) { return path.join(PROFILES_DIR, String(accId)); }
function credsPath(accId) { return path.join(profileDir(accId), '.credentials.json'); }

function isLinkTo(p, target) {
  try {
    if (!fs.lstatSync(p).isSymbolicLink()) return false;
    return path.resolve(fs.readlinkSync(p)) === path.resolve(target);
  } catch { return false; }
}

// A REAL directory sitting where a shared junction belongs holds real user data — a
// profile that ran before its dir joined SHARED_DIRS. Move its contents into the shared
// dir, then junction. This USED to be `fs.rmSync(link, {recursive:true, force:true})`,
// which silently ate whatever was there; adding `tasks` to SHARED_DIRS would have
// deleted every profile's task lists on the next launch.
//
// Two structural guarantees, not two promises:
//   * The shared copy ALWAYS wins a name collision; the profile's copy is parked under
//     arc-backup/ rather than overwritten. Nothing is compared, merged, or judged.
//   * The final call is `rmdirSync` (NON-recursive), which fails unless the directory is
//     already empty. So the only way we can remove `link` is if every child was moved out
//     first. A partial move leaves the dir intact and we skip junctioning it.
// Returns true when `link` is clear and safe to replace with a junction.
function adoptIntoShared(link, target, accId, name) {
  let st;
  try { st = fs.lstatSync(link); } catch { return true; }        // nothing there — go
  if (st.isSymbolicLink()) { try { fs.unlinkSync(link); return true; } catch { return false; } }
  if (!st.isDirectory()) return false;                            // a FILE — never touch it

  let entries; try { entries = fs.readdirSync(link); } catch { return false; }
  for (const e of entries) {
    const from = path.join(link, e);
    const to = path.join(target, e);
    try {
      if (!fs.existsSync(to)) { fs.renameSync(from, to); continue; }
      const bak = path.join(C.CLAUDE_DIR, 'cl-backup', 'profile-merge', String(accId), name);
      fs.mkdirSync(bak, { recursive: true });
      fs.renameSync(from, path.join(bak, e));                     // shared wins; keep ours
    } catch { return false; }                                     // stuck — leave it whole
  }
  try { fs.rmdirSync(link); return true; } catch { return false; } // empty-only, by design
}

// Sync arc's hooks + statusLine + permissions into the profile's settings.json
// WITHOUT clobbering any per-account settings the user set via /config. Merges
// only the arc-owned keys.
//
// `permissions` is UNION-MERGED, never replaced: /permissions inside a PROFILED session
// writes to the profile's own settings.json, so a wholesale `next[k] = master[k]` would
// silently delete every rule the human added there on the next launch — ensureProfile
// runs every launch, so "next launch" is always soon. Root stays the master for arc's
// own allowlist (new BOARD_COMMANDS verbs propagate); the human's per-profile grants
// survive alongside. Deny/ask lists get the same union for the same reason.
function syncSettings(dir) {
  const src = path.join(C.CLAUDE_DIR, 'settings.json');
  let master; try { master = JSON.parse(fs.readFileSync(src, 'utf8')); } catch { return; }
  const dst = path.join(dir, 'settings.json');
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(dst, 'utf8')); } catch {}
  const next = { ...cur };
  for (const { key: k, merge } of ARC_SETTINGS_KEYS) {
    if (master[k] === undefined) continue;
    if (merge === 'replace') {
      // arc is the sole author of these — the root copy IS the truth.
      next[k] = master[k];
    } else if (merge === 'overlay') {
      // Plain per-key map, profile wins (shared overlayMaps — one policy, one
      // sanitizer, never two hand-rolled copies). ACCEPTED TRADEOFF (same as the
      // union scalars): once a profile holds a key, a root change to that SAME key
      // never reaches it — retune existing values in the profile, not at root.
      next[k] = require('./arc-wire-settings').overlayMaps(master[k], cur[k]);
    } else if (merge === 'union') {
      // Object merge where profile-local scalars (defaultMode) win, plus a set-union
      // of the rule lists — a /permissions grant made inside a profiled session must
      // survive the next launch (ensureProfile runs every launch, so "next" is soon).
      const mp = master[k] || {}, cp = (cur[k] && typeof cur[k] === 'object') ? cur[k] : {};
      const merged = { ...mp, ...cp };
      for (const list of ['allow', 'deny', 'ask']) {
        const a = Array.isArray(mp[list]) ? mp[list] : [];
        const b = Array.isArray(cp[list]) ? cp[list] : [];
        if (a.length || b.length) merged[list] = [...new Set([...a, ...b])];
      }
      next[k] = merged;
    }
    // Unknown policy: SKIP — not-synced beats clobbered. The suite fails on any
    // declared key whose policy this dispatch does not know, so an unknown value
    // cannot ship silently; this branch exists only so a live mismatch degrades
    // to "that key stops syncing" instead of "that key eats the profile's value".
  }
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
      if (!adoptIntoShared(link, target, accId, d)) continue;   // couldn't clear it safely
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
// login was seeded. Used by the one-time migration and by `arc capture`.
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
// won't rename an open dir) — arc-runner renames only after killing claude. Returns
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

// Quarantine an account's profile dir (its login + local data) when the account is
// removed. MOVE it to PROFILES_DIR/.trash/<id>-<ts> rather than leaving it behind —
// an abandoned dir is an orphan that clutters the profile list and can still carry
// stale per-profile state (e.g. an MCP registration) — or hard-deleting it (removal
// stays recoverable: move the dir back to restore). The `.` prefix keeps the trash
// out of the profile namespace (account ids can't start with a dot). Returns the
// trash path, or null if there was no dir. THROWS if the dir can't be moved because
// a live session on that account still holds it open (EPERM/EBUSY) — the caller
// leaves it in place and tells the user to remove it once that session exits.
function removeProfile(accId) {
  const dir = profileDir(accId);
  if (!fs.existsSync(dir)) return null;
  const trashRoot = path.join(PROFILES_DIR, '.trash');
  fs.mkdirSync(trashRoot, { recursive: true });
  const dest = path.join(trashRoot, `${accId}-${Date.now()}`);
  fs.renameSync(dir, dest); // atomic within the volume; throws if a live session holds it
  return dest;
}

module.exports = { PROFILES_DIR, ARC_SETTINGS_KEYS, syncSettings, profileDir, credsPath, ensureProfile, hasCreds, seedCreds, renameProfile, removeProfile, SHARED_DIRS, adoptIntoShared };
