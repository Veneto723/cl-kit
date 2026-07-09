// cl-fridge: the zero-token `cl:` sentinels for the sticky-note ledger.
//   cl:role <name>        claim a role in this room (research | coding | …)
//   cl:note <to> <text>   leave a note for a role ("all" = broadcast)
//   cl:notes [all]        read your unread notes (marks them read); `all` = whole fridge
//
// The room is derived from the SESSION'S cwd (git repo root) — see cl-room.js.
// Everything here runs inside the UserPromptSubmit hook: local, no model, zero tokens.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('./cl-room');

const CACHE_DIR = path.join(os.homedir(), '.claude', 'cache');
const roleFile = (session) => path.join(CACHE_DIR, `cl-role-${session}.json`);
const stateFile = (session) => path.join(CACHE_DIR, `cl-state-${session}.json`);

// The lease must name a LONG-LIVED process. The hook itself dies immediately, so
// its pid would make the lease instantly vacant. cl-runner's pid lives as long as
// the session does — that's the right liveness proxy.
function sessionPid(session) {
  try { return JSON.parse(fs.readFileSync(stateFile(session), 'utf8')).pid || 0; } catch { return 0; }
}

// Which folder is this session in? The hook payload SHOULD carry `cwd`, but don't
// bet the room on it — cl-runner already records the session's cwd authoritatively.
function resolveCwd(session, cwd) {
  if (cwd) return cwd;
  try { const c = JSON.parse(fs.readFileSync(stateFile(session), 'utf8')).cwd; if (c) return c; } catch {}
  return process.cwd();
}

function getRole(session, room) {
  try {
    const r = JSON.parse(fs.readFileSync(roleFile(session), 'utf8'));
    return r.room === room.root ? r.role : null;   // a role is only valid in its own room
  } catch { return null; }
}
function setRole(session, room, role) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(roleFile(session), JSON.stringify({ room: room.root, role, at: Date.now() }));
}

const VALID_ROLE = /^[a-z][a-z0-9_-]{0,23}$/;
const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
};

function roommates(room, meRole) {
  const live = R.liveRoles(room).map((l) => l.role);
  const others = live.filter((r) => r !== meRole);
  return others.length ? others.join(', ') : '(nobody else here yet)';
}

// ---- cl:role -----------------------------------------------------------------
function requestRole(session, arg, cwd) {
  if (!session) return { ok: false, message: 'NOT under the cl wrapper (launch with `cl`).' };
  const role = String(arg || '').trim().toLowerCase();
  const room = R.resolveRoom(resolveCwd(session, cwd));
  if (!role) {
    const mine = getRole(session, room);
    return { ok: true, plain: true, message:
      `cl fridge — room "${room.name}"  (${room.root})\n` +
      `  your role: ${mine || '(none — set one: cl:role research)'}\n` +
      `  roommates: ${roommates(room, mine)}` };
  }
  if (!VALID_ROLE.test(role)) return { ok: false, message: `invalid role "${role}" — letters/digits/dash/underscore, starting with a letter.` };

  R.ensureRoom(room);
  const pid = sessionPid(session);
  if (!pid) return { ok: false, message: 'cannot find this session\'s cl-runner pid — is it running under `cl`?' };

  const prev = getRole(session, room);
  if (prev && prev !== role) R.releaseRole(room, prev, pid);   // moving rooms/roles: give the old one back

  const claim = R.claimRole(room, role, pid, session);
  if (!claim.ok) {
    return { ok: false, message:
      `role "${role}" is already held by a LIVE session (pid ${claim.holder.pid}) in room "${room.name}".\n` +
      `Two sessions sharing a role would share a cursor and steal each other's notes. Pick another name, or close that session.` };
  }
  setRole(session, room, role);
  const unread = R.unreadFor(room, role);
  return { ok: true, message:
    `✓ you are "${role}" in room "${room.name}"  (${room.root})\n` +
    `  roommates: ${roommates(room, role)}\n` +
    (unread.count ? `  📌 ${unread.count} unread note(s) — read them: cl:notes` : '  fridge is empty for you') };
}

// ---- cl:note -----------------------------------------------------------------
function requestNote(session, arg, cwd) {
  if (!session) return { ok: false, message: 'NOT under the cl wrapper (launch with `cl`).' };
  const room = R.resolveRoom(resolveCwd(session, cwd));
  const me = getRole(session, room);
  if (!me) return { ok: false, message: `no role in room "${room.name}" — claim one first:  cl:role research` };

  const s = String(arg || '').trim();
  const m = s.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) return { ok: false, message: 'usage: cl:note <role|all> <text>   e.g.  cl:note coding "P-014 spec changed"' };
  const to = m[1].toLowerCase() === 'all' ? null : m[1].toLowerCase();
  let body = m[2].trim().replace(/^["']|["']$/g, '');
  if (!body) return { ok: false, message: 'the note is empty.' };

  if (to && to === me) return { ok: false, message: `you are "${me}" — a note to yourself would never be read (you never see your own notes).` };
  const note = R.appendNote(room, { from: me, to, body });
  const seq = R.noteCount(room);
  return { ok: true, message:
    `✓ note #${seq} stuck on the fridge for ${to || 'everyone'} (from "${me}", room "${room.name}")\n` +
    `  "${body.slice(0, 80)}${body.length > 80 ? '…' : ''}"\n` +
    `  they'll see it when they next take a turn.` };
}

// ---- cl:notes ----------------------------------------------------------------
function requestNotes(session, arg, cwd) {
  if (!session) return { ok: false, message: 'NOT under the cl wrapper (launch with `cl`).' };
  const room = R.resolveRoom(resolveCwd(session, cwd));
  const me = getRole(session, room);
  const wantAll = String(arg || '').trim().toLowerCase() === 'all';

  const head = `cl fridge — room "${room.name}"   (${room.root})`;
  if (wantAll) {   // landlord view: the whole fridge, cursor untouched
    const all = R.allNotes(room);
    if (!all.length) return { ok: true, plain: true, message: `${head}\n  (the fridge is empty)` };
    const rows = all.map((n) =>
      `  #${String(n.seq).padStart(3)}  ${ago(n.ts).padStart(4)} ago  ${n.from} → ${n.to || 'all'}${n.priority === 'high' ? '  [!]' : ''}\n` +
      `        ${n.body.replace(/\n/g, '\n        ')}` +
      (n.refs ? `\n        refs: ${JSON.stringify(n.refs)}` : ''));
    return { ok: true, plain: true, message: `${head}   — ALL ${all.length} note(s), nothing marked read\n${rows.join('\n')}` };
  }

  if (!me) return { ok: false, message: `no role in room "${room.name}" — claim one first:  cl:role research\n(or read everything anyway:  cl:notes all)` };
  const u = R.unreadFor(room, me);
  if (!u.count) {
    return { ok: true, plain: true, message:
      `${head}\n  you are "${me}" · roommates: ${roommates(room, me)}\n  nothing new on the fridge (${u.latest} note(s) total)` };
  }
  const rows = u.notes.map((n) =>
    `  #${String(n.seq).padStart(3)}  ${ago(n.ts).padStart(4)} ago  from ${n.from}${n.to ? '' : '  (broadcast)'}${n.priority === 'high' ? '  [!]' : ''}\n` +
    `        ${n.body.replace(/\n/g, '\n        ')}` +
    (n.refs ? `\n        refs: ${JSON.stringify(n.refs)}` : ''));
  R.markRead(room, me);   // rd()-only: the note stays, only YOUR cursor advances
  return { ok: true, plain: true, message:
    `${head}\n  you are "${me}" · ${u.count} new from ${u.senders.join(', ')}\n${rows.join('\n')}\n` +
    `  (marked read — the notes stay on the fridge for everyone else)` };
}

// Re-assert this session's role lease under a NEW pid. Called by cl-runner on every
// (re)launch, because `cl:restart` re-execs the wrapper: CL_SESSION survives, but the
// pid changes, so the old lease would look DEAD and another session could steal the
// role. The role itself lives in cl-role-<session>.json, which survives restart and
// switch — exactly like the session's model and effort.
// Returns null if this session has no role here; {ok:false, holder} if a live OTHER
// session took it while we were down.
function refreshRole(session, pid, cwd) {
  if (!session || !pid) return null;
  try {
    const room = R.resolveRoom(resolveCwd(session, cwd));
    const role = getRole(session, room);
    if (!role) return null;
    const c = R.claimRole(room, role, pid, session);
    return { room: room.name, role, ok: c.ok, holder: c.holder || null };
  } catch { return null; }
}

// The AMBIENT surface: what the statusline paints. Unread is arithmetic over two
// files (ledger length − this role's cursor), so it cannot lie and nobody has to
// remember to tell you. Returns null when there is nothing to show.
// Runs on EVERY statusline repaint, so the first check is the cheapest possible one.
function badge(session, cwd) {
  try {
    if (!session || !fs.existsSync(roleFile(session))) return null; // no role → nothing, one stat
    const room = R.resolveRoom(resolveCwd(session, cwd));
    const role = getRole(session, room);
    if (!role) return null;
    const u = R.unreadFor(room, role);
    return u.count ? { count: u.count, senders: u.senders, role, room: room.name } : null;
  } catch { return null; }
}

module.exports = { requestRole, requestNote, requestNotes, refreshRole, badge, getRole, sessionPid, roleFile };
