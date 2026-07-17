#!/usr/bin/env node
// arc-sync: discrete export / import of Claude Code chat sessions between machines.
// Pure file operations (tar over ~/.claude/projects), so they run inside the
// arc:export / arc:import hook — zero model tokens, no session disruption.
//
//   arc:export                → the CURRENT conversation only (fast)
//   arc:export all            → every session in the CURRENT project folder
//   arc:export global         → every session on this machine (bigger/slower; alias *)
//   arc:export <project|id>   → one project's sessions, or one session (id prefix)
//   arc:export --since <days> → sessions touched in the last N days
//   arc:export ... --out <f>  → choose the archive path (default ~/arc-export-<ts>.tgz)
//
//   arc:import <archive>      → extract + merge into ~/.claude/projects
//                              (newer-wins; overwritten local copies are backed
//                               up; a conversation OPEN in a live arc is never
//                               touched; --dry-run / --force / --skip-existing)
//   arc:import <a> <d>        → re-root every project in the bundle under OUTER
//   arc:import <a> --dest <d>   folder <d> (the bare form and the flag are the same
//                              thing), keeping each project's own name:
//                              E:\whalephone → <d>\whalephone. Lets two machines
//                              store projects at different roots (office E:\x,
//                              home E:\whaletech\x) and still resume. Rewrites the
//                              stored cwd so the relocated session is consistent.
//
// Resume note: `claude --resume <id>` is scoped to the cwd's project dir. Without
// --dest the two machines must use the SAME project paths; --dest bridges that.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const PROJECTS = path.join(HOME, '.claude', 'projects');
const CACHE = path.join(HOME, '.claude', 'cache');
const BACKUPS = path.join(HOME, '.claude', 'backups');

// The board (<repo>/.arc) travels WITH its sessions — same archive, different tree. The
// tree problem is solved the way the manifest already solves it: STAGE into PROJECTS,
// list the files, clean up in `finally`. Never a second tar -C: runTar's --force-local
// fallback exists because tar dialects already bite in this file, and one archive root
// is the only shape both GNU tar and bsdtar agree on.
const B = require('./arc-board');
const BOARD_PREFIX = '.arc-board-';   // dot-prefixed: discover() never mistakes a stage for a project
const listDir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

// ---- small helpers ---------------------------------------------------------

function stamp() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function human(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const u = ['KB', 'MB', 'GB']; let i = -1, n = bytes;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// Read up to `n` bytes from the end (or start) of a file.
function readChunk(fp, n, fromEnd) {
  try {
    const size = fs.statSync(fp).size;
    const start = fromEnd ? Math.max(0, size - n) : 0;
    const len = Math.min(n, size - start);
    const fd = fs.openSync(fp, 'r'); const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start); fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}
// The timestamp of the last transcript entry (ISO string, compares chronologically).
function lastTs(fp) {
  const lines = readChunk(fp, 65536, true).split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const e = JSON.parse(lines[i]); if (e && e.timestamp) return e.timestamp; } catch {}
  }
  try { return new Date(fs.statSync(fp).mtimeMs).toISOString(); } catch { return null; }
}
// A short title from the first user message (for readable listings).
function firstMsg(fp) {
  const lines = readChunk(fp, 32768, false).split(/\r?\n/).filter(Boolean);
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      if (e.type !== 'user') continue;
      const c = e.message && e.message.content;
      let t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ') : '';
      t = (t || '').replace(/\s+/g, ' ').trim();
      if (t && !t.startsWith('<')) return t.slice(0, 50);
    } catch {}
  }
  return '';
}

// Every session on disk: { project, id, jsonl, rel, sidecarRel|null, size, mtime, lastTs, title }.
function discover() {
  const out = [];
  let projs = [];
  try { projs = fs.readdirSync(PROJECTS); } catch { return out; }
  for (const proj of projs) {
    if (proj === '.trash' || proj.startsWith('.')) continue;
    const pdir = path.join(PROJECTS, proj);
    let st; try { st = fs.statSync(pdir); } catch { continue; }
    if (!st.isDirectory()) continue;
    let files = []; try { files = fs.readdirSync(pdir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      const jsonl = path.join(pdir, f);
      let fst; try { fst = fs.statSync(jsonl); } catch { continue; }
      const sidecar = path.join(pdir, id);
      const hasSidecar = fs.existsSync(sidecar) && (() => { try { return fs.statSync(sidecar).isDirectory(); } catch { return false; } })();
      out.push({
        project: proj, id, jsonl,
        rel: `${proj}/${f}`,
        sidecarRel: hasSidecar ? `${proj}/${id}` : null,
        size: fst.size, mtime: fst.mtimeMs, lastTs: lastTs(jsonl), title: firstMsg(jsonl),
      });
    }
  }
  return out;
}

// The conversation id THIS arc session is on (protected from import overwrite).
function currentConv(session) {
  for (const p of [`arc-state-${session}.json`, `arc-active-${session}.json`]) {
    try { const j = JSON.parse(fs.readFileSync(path.join(CACHE, p), 'utf8')); if (j.convId) return j.convId; } catch {}
  }
  return null;
}

// The session's LAUNCH cwd (which is what Claude Code names the project dir after —
// not the shell's current cwd, which drifts).
function stateCwd(session) {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE, `arc-state-${session}.json`), 'utf8')).cwd || null; } catch { return null; }
}

// Claude Code names a project dir after the cwd with every non-alphanumeric replaced
// by '-'  (E:\ -> "E--",  E:\arc -> "E--arc"). Only a FALLBACK: the encoding is
// Claude Code's to change, so we prefer to look up the dir that actually holds this
// conversation.
const encodeProject = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');

// GNU tar needs --force-local for Windows drive-letter archive paths. The bsdtar
// shipped by newer Windows releases rejects that option, but already treats those
// paths as local. Try the GNU-safe form first, then retry only for that option error.
function runTar(args, opts = {}) {
  const options = { encoding: 'utf8', windowsHide: true, timeout: 300_000, ...opts };
  let r = spawnSync('tar', ['--force-local', ...args], options);
  const detail = String(r.stderr || '') + '\\n' + String(r.error && r.error.message || '');
  if (r.status !== 0 && /force-local.*(?:not supported|unknown|unrecognized|illegal)/i.test(detail)) {
    r = spawnSync('tar', args, options);
  }
  return r;
}

// ---- --dest re-rooting (import a session so it resumes at a DIFFERENT path) ----
// A project folder is encodeProject(launchCwd), and that launch cwd is stored on the
// transcript's message lines — so we can recover the real source path even though the
// encoding isn't reversible. Find the cwd whose encoding IS this project dir.
function sniffLaunchCwd(jsonlPath, proj) {
  let data; try { data = fs.readFileSync(jsonlPath, 'utf8'); } catch { return null; }
  const seen = new Set();
  for (const line of data.split('\n')) {
    if (!line || line.indexOf('"cwd"') === -1) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (typeof o.cwd === 'string' && !seen.has(o.cwd)) {
      seen.add(o.cwd);
      if (encodeProject(o.cwd) === proj) return o.cwd;
    }
  }
  return null;
}

// Windows path prefix test on a SEPARATOR boundary, case-insensitive — so
// "E:\proj" matches "E:\proj" and "E:\proj\sub" but NOT "E:\project".
function underPath(p, prefix) {
  const a = String(p).replace(/[\\/]+$/, '').toLowerCase();
  const b = String(prefix).replace(/[\\/]+$/, '').toLowerCase();
  return a === b || a.startsWith(b + '\\') || a.startsWith(b + '/');
}

// Re-root one cwd: replace its `fromPath` prefix with `toPath`, keeping the tail
// (E:\proj\sub with from=E:\proj to=E:\whaletech\proj → E:\whaletech\proj\sub).
// A cwd that isn't under fromPath is returned unchanged (a drifted, unrelated path).
function remapCwd(cwd, fromPath, toPath) {
  const from = String(fromPath).replace(/[\\/]+$/, '');
  if (!underPath(cwd, from)) return cwd;
  return String(toPath).replace(/[\\/]+$/, '') + String(cwd).slice(from.length);
}

// Copy a transcript, rewriting every cwd under `fromPath` to `toPath`. Lines with no
// cwd (or a cwd outside fromPath) are preserved byte-for-byte; only changed lines are
// re-serialized. Returns the number of cwd values rewritten.
function copyRemappingCwd(srcJsonl, dstJsonl, fromPath, toPath) {
  const lines = fs.readFileSync(srcJsonl, 'utf8').split('\n');
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i] || lines[i].indexOf('"cwd"') === -1) continue;
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    if (typeof o.cwd === 'string') {
      const nc = remapCwd(o.cwd, fromPath, toPath);
      if (nc !== o.cwd) { o.cwd = nc; lines[i] = JSON.stringify(o); n++; }
    }
  }
  fs.writeFileSync(dstJsonl, lines.join('\n'));
  return n;
}

// Which project folder are we "in"? Exact path: find the dir holding the CURRENT
// conversation. Fallback: encode the launch cwd (then the shell cwd) and accept it only
// if such a project dir really exists. Returns null when it can't be determined.
function currentProject(session, all) {
  const cur = currentConv(session);
  if (cur) {
    const hit = all.find((s) => s.id === cur);
    if (hit) return hit.project;
  }
  for (const cwd of [stateCwd(session), process.cwd()]) {
    if (!cwd) continue;
    const enc = encodeProject(cwd);
    if (all.some((s) => s.project === enc)) return enc;
  }
  return null;
}
// Session ids currently OPEN in a live arc process (never overwrite these).
function liveConvIds() {
  const live = new Set();
  try {
    for (const f of fs.readdirSync(CACHE)) {
      const m = /^arc-convlock-(.+)\.json$/.exec(f);
      if (!m) continue;
      try { const l = JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')); if (pidAlive(l.pid)) live.add(m[1]); } catch {}
    }
  } catch {}
  return live;
}

// Split respecting quotes, so a path with spaces survives as ONE token and the
// surrounding quotes are stripped:  --dest "E:\my folder"  →  ['--dest','E:\my folder'].
function tokenize(argStr) {
  const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(argStr || '')) !== null) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}
function parseFlags(argStr) {
  const toks = tokenize(argStr);
  const flags = {}; const pos = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      if (['out', 'since', 'dest'].includes(key) && toks[i + 1] !== undefined && !toks[i + 1].startsWith('--')) { flags[key] = toks[++i]; }
      else flags[key] = true;
    } else pos.push(t);
  }
  return { flags, pos };
}

// ---- the board: what travels, what is stripped, what stays home ---------------
// The audit-signed binning (#227/#232):
//   peer/notes.jsonl     CARRY  — the content; import owns the merge (mergeLedgers below)
//   roles/*.md           CARRY  — the whole .arc is machine state (operator ruling 2026-07-17);
//                                 export/import is its ONLY transport now
//   peer/claim-*.json    TOMBSTONE {role, sessionId, convId, at} — the pid is stripped AT EXPORT,
//                                 so the archive at rest can never squat a chair even hand-extracted
//                                 (isHolder reads a pid-less claim VACANT); import strips AGAIN,
//                                 because archives made by older exports or by hand won't be clean
//   peer/cursor-/seen-*  CARRY  — import gates each on its session actually being present there
//   origin.json          NEVER  — one origin, one writer; carrying it is the silent ord break
//   anchor-state.json    NEVER  — a git position, stale on arrival by construction
//   born-/lease-/.lock-/*.tmp-/spill-*  NEVER — transient, or re-derived: a spill file is
//                                 re-written FROM the ledger on every delivery (arc-notes
//                                 directBody); it is a delivery cache, not content

// Merge an archive ledger into a local one. Append-only union with ONE hard rule.
//   * id-bearing notes union by id: local lines keep their order, archive-only notes are
//     appended in archive order. That preserves every origin's RELATIVE order — which is
//     what `ord` and the per-origin cursors need — because any exported ledger holds a
//     per-origin PREFIX of that origin's true sequence (a single writer appends in order,
//     and a full-file copy cannot reorder it), so archive-only notes of an origin always
//     EXTEND past the local prefix; appending keeps them in sequence.
//   * id-LESS lines are the frozen prefix. arc-board.js:433 mints their ids from POSITION
//     at read time and never writes them back — so two boards agree on those ids ONLY if
//     they agree on those lines, byte for byte, in order. The shorter prefix must be a
//     byte-prefix of the longer. Anything else means the same ~:000042 names two DIFFERENT
//     notes: a union would silently drop one side or re-parent a thread — the failure
//     arc-board.js:24-31 proved with two real clones. There is no sound recovery (re-iding
//     un-freezes what the design froze; keeping both prefixes doubles history), so we
//     REFUSE, naming the first diverging line. A false refuse costs a retry; a false
//     accept costs a silently corrupted reference graph.
function mergeLedgers(localText, archiveText) {
  const split = (t) => String(t || '').split('\n').filter((l) => l.trim());
  const idOf = (l) => { try { return JSON.parse(l).id || null; } catch { return null; } };
  const L = split(localText), A = split(archiveText);
  const pfxLen = (arr) => { let n = 0; while (n < arr.length && !idOf(arr[n])) n++; return n; };
  const lp = pfxLen(L), ap = pfxLen(A);
  for (let i = 0; i < Math.min(lp, ap); i++) {
    if (L[i] !== A[i]) {
      return { ok: false, line: i + 1, local: L[i], archive: A[i],
        reason: `the id-less prefixes diverge at line ${i + 1} — the two boards minted DIFFERENT notes at the same position, so merging would silently re-point references` };
    }
  }
  // The longer id-less prefix wins whole: its extra lines carry the same synthetic ids on
  // both machines (the Nth id-less line is ~:N on each), so references to them stay stable.
  const head = ap > lp ? A.slice(0, ap) : L.slice(0, lp);
  const lTail = L.slice(lp), aTail = A.slice(ap);
  const have = new Set(lTail.map(idOf));
  const merged = [...head, ...lTail];
  let added = Math.max(0, ap - lp);
  for (const line of aTail) {
    const id = idOf(line);                       // a torn archive tail line (id null) is never imported
    if (id && !have.has(id)) { merged.push(line); have.add(id); added++; }
  }
  return { ok: true, text: merged.join('\n') + '\n', added };
}

// The boards behind a set of selected sessions: launch cwd -> repo root -> .arc, deduped
// by root (many project dirs, one board). A root whose tree is gone, or whose board has
// no ledger, contributes nothing.
function sessionBoards(selected) {
  const out = new Map();
  for (const s of selected) {
    const launch = sniffLaunchCwd(s.jsonl, s.project);
    if (!launch || !fs.existsSync(launch)) continue;
    let board; try { board = B.resolveBoard(launch); } catch { continue; }
    if (out.has(board.root)) continue;
    if (!fs.existsSync(path.join(board.planDir, 'notes.jsonl'))) continue;
    out.set(board.root, board);
  }
  return [...out.values()];
}

// Stage one board under PROJECTS for the tar. Returns { stage, rels, notes, claims, roleMds }.
function stageBoard(board, usedNames) {
  let name = BOARD_PREFIX + encodeProject(board.root);
  while (usedNames && usedNames.has(name)) name += '-2';   // encodeProject can collide; roots cannot
  if (usedNames) usedNames.add(name);
  const stage = path.join(PROJECTS, name);
  rm(stage);
  try { return stageBoardInto(board, stage, name); }
  catch (e) { rm(stage); throw e; }   // a half-written stage must not outlive the throw
}
function stageBoardInto(board, stage, name) {
  const rels = [];
  const put = (rel, data) => {
    const fp = path.join(stage, rel);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, data);
    rels.push(`${name}/${rel}`);
  };
  // the ledger travels BYTE-EXACT — the merge on the other side compares bytes
  const ledger = fs.readFileSync(path.join(board.planDir, 'notes.jsonl'));
  put('peer/notes.jsonl', ledger);
  let claims = 0;
  for (const f of listDir(board.planDir)) {
    const cm = /^claim-(.+)\.json$/.exec(f);
    if (cm) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(board.planDir, f), 'utf8'));
        put(`peer/${f}`, JSON.stringify({ role: c.role || cm[1], sessionId: c.sessionId || null, convId: c.convId || null, at: c.at || 0 }));
        claims++;
      } catch {}
    } else if (/^(cursor|seen)-.+\.json$/.test(f)) {
      try { put(`peer/${f}`, fs.readFileSync(path.join(board.planDir, f))); } catch {}
    }
  }
  let roleMds = 0;
  const rolesDir = path.join(board.root, '.arc', 'roles');
  for (const f of listDir(rolesDir)) {
    if (f.endsWith('.md')) { try { put(`roles/${f}`, fs.readFileSync(path.join(rolesDir, f))); roleMds++; } catch {} }
  }
  // the source repo root is recorded HERE, where the tree exists — repoRoot() fabricates
  // rather than errors on a missing path, so import could never recover it after the fact
  put('board.json', JSON.stringify({ tool: 'arc-sync', board: 1, root: board.root, name: board.name, at: new Date().toISOString() }, null, 2));
  const notes = String(ledger).split('\n').filter((l) => l.trim()).length;
  return { stage, rels, notes, claims, roleMds };
}

// ---- export ----------------------------------------------------------------

function doExport(session, argStr) {
  const { flags, pos } = parseFlags(argStr);
  const all = discover();
  if (!all.length) return { ok: false, message: 'no sessions found to export.' };

  let selected, what;
  const sel = pos[0];
  if (flags.since) {
    const days = parseInt(flags.since, 10) || 7;
    const cutoff = Date.now() - days * 86400_000;
    selected = all.filter((s) => s.mtime >= cutoff); what = `last ${days} day(s)`;
  } else if (!sel || sel.toLowerCase() === 'current' || sel === '.') {
    const cur = currentConv(session);
    selected = all.filter((s) => s.id === cur); what = 'current conversation';
    if (!selected.length) return { ok: false, message: 'no current conversation found — try `arc:export all` (this project) or `arc:export global`.' };
  } else if (sel.toLowerCase() === 'all') {
    // `all` = every session in THIS project folder (the common case). Everything on the
    // machine is `global` — an explicit word, because that archive can be huge.
    const proj = currentProject(session, all);
    if (!proj) {
      return { ok: false, message: 'could not tell which project folder you are in — run `arc:export global`, or name a project dir (see ~/.claude/projects).' };
    }
    selected = all.filter((s) => s.project === proj);
    what = `all sessions in project "${proj}"`;
    if (!selected.length) return { ok: false, message: `no sessions found in project "${proj}".` };
  } else if (sel.toLowerCase() === 'global' || sel === '*') {
    selected = all; what = 'ALL sessions (every project on this machine)';
  } else {
    // project dir name, or session id / id-prefix
    selected = all.filter((s) => s.project === sel || s.id === sel || s.id.startsWith(sel));
    what = `"${sel}"`;
    if (!selected.length) return { ok: false, message: `nothing matched "${sel}". Use \`arc:export all\` (this project), \`arc:export global\` (everything), a project dir name, or a session id.` };
  }

  const totalBytes = selected.reduce((a, s) => a + s.size, 0);
  const rels = [];
  for (const s of selected) { rels.push(s.rel); if (s.sidecarRel) rels.push(s.sidecarRel); }

  // manifest at the archive root (readable inventory; skipped on import)
  const manifest = {
    tool: 'arc-sync', version: 1, machine: os.hostname(), at: new Date().toISOString(),
    sessions: selected.map((s) => ({ project: s.project, id: s.id, size: s.size, lastTs: s.lastTs, title: s.title })),
    boards: [],
  };
  const manPath = path.join(PROJECTS, '.arc-manifest.json');
  const listPath = path.join(CACHE, `arc-export-list-${process.pid}.txt`);
  const out = flags.out ? path.resolve(flags.out) : path.join(HOME, `arc-export-${stamp()}.tgz`);
  const staged = [];
  try {
    fs.mkdirSync(CACHE, { recursive: true });
    // the sessions' boards ride along — staged under PROJECTS, gone again in the finally
    const usedNames = new Set();
    for (const board of sessionBoards(selected)) {
      try {
        const st = stageBoard(board, usedNames);
        staged.push({ ...st, boardName: board.name });
        rels.push(...st.rels);
        manifest.boards.push({ root: board.root, name: board.name, notes: st.notes });
      } catch { /* a board that cannot stage never blocks the sessions */ }
    }
    fs.writeFileSync(manPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(listPath, ['.arc-manifest.json', ...rels].join('\n'));
    // --force-local: GNU tar otherwise reads a Windows `C:\...` archive path as a
    // remote host `C` ("Cannot connect to C"). This makes colons mean drive letters.
    const r = runTar(['-czf', out, '-C', PROJECTS, '-T', listPath]);
    if (r.status !== 0) return { ok: false, message: `export FAILED — tar: ${(r.stderr || r.error && r.error.message || 'unknown').toString().slice(0, 200)}` };
  } catch (e) {
    return { ok: false, message: `export FAILED — ${e.message}` };
  } finally {
    try { fs.unlinkSync(manPath); } catch {}
    try { fs.unlinkSync(listPath); } catch {}
    for (const st of staged) rm(st.stage);
  }
  let archiveSize = 0; try { archiveSize = fs.statSync(out).size; } catch {}
  const boardLine = staged.length
    ? staged.map((st) => `  + board "${st.boardName}" rides along (${st.notes} notes, ${st.roleMds} charter(s), ${st.claims} claim tombstone(s) — pids stripped)\n`).join('')
    : '';
  return {
    ok: true,
    message:
      `✓ exported ${selected.length} session(s) — ${what} (${human(totalBytes)} → ${human(archiveSize)} archive)\n` +
      boardLine +
      `  ${out}\n` +
      `  copy that file to the other PC, then run:  arc:import "${out.split(path.sep).pop()}"  (from wherever you put it)`,
  };
}

// ---- import ----------------------------------------------------------------

function doImport(session, argStr) {
  const { flags, pos } = parseFlags(argStr);
  const archive = pos[0] ? path.resolve(pos[0]) : null;
  if (!archive) return { ok: false, message: 'usage: arc:import <archive.tgz> [<dest> | --dest "E:\\outer\\folder"] [--dry-run] [--force] [--skip-existing]' };
  if (!fs.existsSync(archive)) return { ok: false, message: `archive not found: ${archive}` };

  // --dest re-roots each imported project under an OUTER folder, KEEPING its own name:
  // --dest "E:\whaletech" puts project E:\whalephone → E:\whaletech\whalephone (and every
  // other project in the bundle → E:\whaletech\<its name>), so they resume at the local
  // path. Requires an absolute path. Sessions whose source path can't be recovered are
  // skipped and reported rather than guessed.
  //
  // A BARE second positional means the same thing: `arc:import <archive> E:` == `--dest E:`.
  // The flagless form is what people actually type, and it used to be SILENTLY IGNORED —
  // the import ran with no re-rooting and landed in the archive's original project dir,
  // looking like --dest was broken. Nothing else ever read pos[1], so adopting it costs
  // no compatibility. The explicit flag still wins if both are given.
  const destArg = flags.dest !== undefined ? flags.dest : pos[1];
  const destRoot = destArg ? String(destArg).replace(/[\\/]+$/, '') : null;
  if (destRoot !== null && !path.win32.isAbsolute(destRoot + '\\')) {
    return { ok: false, message: `the destination must be an ABSOLUTE folder path (got "${destArg}") — e.g. \`arc:import <archive> "E:\\whaletech"\` or \`--dest "E:\\whaletech"\`.` };
  }
  const remaps = []; // {name, from, to} for the report
  const destSeen = new Map(); // destProjName -> source proj (collision guard)

  const tmp = path.join(CACHE, `arc-import-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(tmp, { recursive: true });
    // Extract via spawn cwd, NOT `-C tmp`: some tar builds reject `--force-local -C`
    // with a drive-letter path ("Cannot open: No such file"), though they accept the
    // same colon path via the process working directory.
    const r = runTar(['-xzf', archive], { cwd: tmp });
    if (r.status !== 0) { rm(tmp); return { ok: false, message: `import FAILED — tar: ${(r.stderr || 'unknown').toString().slice(0, 200)}` }; }
  } catch (e) { rm(tmp); return { ok: false, message: `import FAILED — ${e.message}` }; }

  const protectedIds = liveConvIds();
  const cur = currentConv(session); if (cur) protectedIds.add(cur);
  const backupDir = path.join(BACKUPS, `arc-import-${stamp()}`);
  const added = [], updated = [], skipped = [];
  let backedUp = false;
  const boardStages = [];        // staged boards found at the archive root — processed after sessions
  const landed = new Set();      // "<dest-project-dir>|<convId>" present after import — the claim gate's truth

  // walk extracted <proj>/<id>.jsonl
  let projs = []; try { projs = fs.readdirSync(tmp); } catch {}
  for (const proj of projs) {
    const pdir = path.join(tmp, proj);
    let st; try { st = fs.statSync(pdir); } catch { continue; }
    if (!st.isDirectory()) continue; // skips .arc-manifest.json
    // A staged BOARD is not a project. Without this branch the walk files its notes.jsonl
    // into ~/.claude/projects as a phantom conversation named "notes" (no dot-skip below,
    // unlike discover()) — or, under --dest, skips it as "source path could not be
    // recovered", since a note record carries no cwd. Both silently wrong.
    if (proj.startsWith(BOARD_PREFIX)) { boardStages.push(pdir); continue; }
    if (proj.startsWith('.')) continue;   // mirror discover(): a dot-dir is never a project
    let files = []; try { files = fs.readdirSync(pdir); } catch {}

    // Where do this project's sessions land? Default: its original folder. With --dest:
    // <destRoot>\<basename(sourceLaunchCwd)>, recovering the launch cwd from a transcript.
    // Can't recover it → skip the whole project and say why (never guess).
    let destProjName = proj, remapFrom = null, remapTo = null;
    if (destRoot !== null) {
      let launch = null;
      for (const f of files) { if (f.endsWith('.jsonl')) { launch = sniffLaunchCwd(path.join(pdir, f), proj); if (launch) break; } }
      const base = launch ? path.win32.basename(launch) : null;
      if (!base) {
        const reason = launch ? 'source path is a drive root — no folder name to re-root' : 'source path could not be recovered from the transcript';
        for (const f of files) if (f.endsWith('.jsonl')) skipped.push(`${f.slice(0, -6).slice(0, 8)} (${proj}: ${reason})`);
        continue;
      }
      remapFrom = launch;
      remapTo = path.win32.join(destRoot, base);
      destProjName = encodeProject(remapTo);
      const clash = destSeen.get(destProjName);
      remaps.push({ from: launch, to: remapTo, clash: clash && clash !== proj ? clash : null });
      destSeen.set(destProjName, proj);
    }

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      const srcJsonl = path.join(pdir, f);
      const srcSide = path.join(pdir, id);
      const dstDir = path.join(PROJECTS, destProjName);
      const dstJsonl = path.join(dstDir, f);
      const dstSide = path.join(dstDir, id);

      // LANDED = "present at THIS destination project dir once the import finishes" — the
      // fact the board's claim gate needs. "In the archive" and "on this disk somewhere"
      // are different facts (audit #236 measured the gap live: three live-protected
      // transcripts skipped under --dest, their claims landed at the new root anyway —
      // ghost pointers a revive could not honour). Every skip path below records the
      // truth: a skip-because-it-exists still lands; a skip-that-leaves-nothing does not.
      // Key on the REAL dir name (no lowercasing): canRevive sniffs it back through
      // sniffLaunchCwd, which matches encodeProject(cwd) exactly and would miss a mangled key.
      const landKey = `${destProjName}|${id}`;

      if (protectedIds.has(id)) {
        if (fs.existsSync(dstJsonl)) landed.add(landKey);   // protected AND already here — reachable
        skipped.push(`${id.slice(0, 8)} (open in a live session — protected)`); continue;
      }

      const exists = fs.existsSync(dstJsonl);
      if (exists) landed.add(landKey);                       // whatever branch runs, a copy remains
      let action = 'add';
      if (exists) {
        if (flags['skip-existing']) { skipped.push(`${id.slice(0, 8)} (exists)`); continue; }
        const sameSize = (() => { try { return fs.statSync(dstJsonl).size === fs.statSync(srcJsonl).size; } catch { return false; } })();
        if (sameSize) { skipped.push(`${id.slice(0, 8)} (identical)`); continue; }
        const tTs = lastTs(srcJsonl), lTs = lastTs(dstJsonl);
        if (!flags.force && lTs && tTs && lTs > tTs) { skipped.push(`${id.slice(0, 8)} (local is newer — kept; --force to override)`); continue; }
        action = 'update';
      }

      if (flags['dry-run']) { landed.add(landKey); (action === 'add' ? added : updated).push(`${id.slice(0, 8)} (${destProjName})`); continue; }

      try {
        fs.mkdirSync(dstDir, { recursive: true });
        if (action === 'update') {
          // back up the local copy before overwriting (recoverable)
          const bproj = path.join(backupDir, destProjName); fs.mkdirSync(bproj, { recursive: true });
          fs.copyFileSync(dstJsonl, path.join(bproj, f));
          if (fs.existsSync(dstSide)) fs.cpSync(dstSide, path.join(bproj, id), { recursive: true });
          backedUp = true;
        }
        // With --dest, rewrite the stored cwd as we copy so the relocated session is
        // consistent (not just physically moved); otherwise a plain copy.
        if (remapFrom) copyRemappingCwd(srcJsonl, dstJsonl, remapFrom, remapTo);
        else fs.copyFileSync(srcJsonl, dstJsonl);
        if (fs.existsSync(srcSide)) fs.cpSync(srcSide, dstSide, { recursive: true });
        landed.add(landKey);
        (action === 'add' ? added : updated).push(`${id.slice(0, 8)} (${destProjName})`);
      } catch (e) {
        skipped.push(`${id.slice(0, 8)} (error: ${e.message})`);
      }
    }
  }

  // boards ride AFTER the sessions, and their gate asks the REVIVE's question: "is this
  // conversation reachable from THIS board's root?" — i.e. landed (or already present) at
  // the project dir a `claude --resume` from that root would search. Not "in the archive",
  // not "anywhere on disk" (audit #236: both of those mint ghost pointers under --dest).
  const boardLines = [];
  for (const stage of boardStages) {
    try {
      importBoard(stage, { destRoot, dryRun: !!flags['dry-run'], landed, backupDir, lines: boardLines, markBackedUp: () => { backedUp = true; } });
    } catch (e) { boardLines.push(`  board: FAILED — ${e.message} (local board untouched)`); }
  }
  rm(tmp);

  const dry = flags['dry-run'] ? ' [DRY RUN — nothing changed]' : '';
  const lines = [`arc:import${dry} — added ${added.length}, updated ${updated.length}, skipped ${skipped.length}`];
  lines.push(...boardLines);
  if (remaps.length) {
    lines.push(`  re-rooted under ${destRoot}:`);
    for (const r of remaps) lines.push(`    ${r.from}  →  ${r.to}${r.clash ? '   ⚠ same name as another project — MERGED into one folder' : ''}`);
  }
  if (added.length) lines.push('  added:   ' + added.join(', '));
  if (updated.length) lines.push('  updated: ' + updated.join(', '));
  if (skipped.length) lines.push('  skipped: ' + skipped.join(', '));
  if (backedUp) lines.push(`  replaced local copies backed up to: ${backupDir}`);
  lines.push(destRoot
    ? `  resume from the re-rooted path, e.g.  cd "${remaps[0] ? remaps[0].to : destRoot}"  then  claude --resume <id>  (or the arc picker).`
    : '  resume from the matching project path, e.g.  cd <project>  then  claude --resume <id>  (or the arc picker).');
  return { ok: true, message: lines.join('\n') };
}

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

// ---- board import ------------------------------------------------------------
// Lands one staged board into its repo. The rules that are NOT obvious from the code:
//   * a claim whose conversation is not REACHABLE FROM THIS BOARD'S ROOT is DROPPED —
//     importing it would promise a revive arc cannot perform (the "scout" orphan, found
//     live on ALYCE: a chair pointing at a transcript that existed on NEITHER machine).
//     Reachable means: at the project dir a `claude --resume` launched from this root
//     would search — the landed set, plus whatever that dir already held. NOT "in the
//     archive" and NOT "anywhere on disk": audit #236 measured both minting ghosts under
//     --dest (live-protected transcripts skipped the copy; their claims landed at the new
//     root pointing at conversations no revive from there could see). The gate is
//     reachability ONLY: charterlessness is a roster concern, and gating on it would
//     also destroy WORKING pointers of undeclared roles (audit #232).
//   * a claim whose chair is HELD here is never touched. Writing the archive's tombstone
//     over a live claim flips isHolder to VACANT — a second session gets staffed into an
//     occupied chair, and the live peer's convId is replaced by a stale one. Same lock
//     as claimRole, so import serializes against a genuine claim in flight (audit #232;
//     d63e4c8's bug at import scope, fixed the same way ca89a24 fixed it at close scope).
//   * a cursor/seen whose session did NOT travel is dropped: a fresh session inheriting a
//     read cursor would see zero unread and start BLIND — worse than any re-read (#227).
function importBoard(stageDir, ctx) {
  const { destRoot, dryRun, landed, backupDir, lines, markBackedUp } = ctx;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(stageDir, 'board.json'), 'utf8')); }
  catch { lines.push('  board: SKIPPED — stage carries no readable board.json'); return; }

  let root = meta.root;
  if (destRoot !== null && destRoot !== undefined) {
    const base = path.win32.basename(String(meta.root).replace(/[\\/]+$/, ''));
    if (!base) { lines.push(`  board "${meta.name}": SKIPPED — source root is a drive root, nothing to re-root under --dest`); return; }
    root = path.win32.join(destRoot, base);
  }
  if (!fs.existsSync(root)) {
    lines.push(`  board "${meta.name}": SKIPPED — destination ${root} does not exist${destRoot ? '' : ' (clone/create the repo first, or re-root with --dest)'}`);
    return;
  }
  const board = B.resolveBoard(root);          // honours a legacy planDir if the destination still has one
  if (!dryRun) B.ensureBoard(board);           // migrates + creates; mutates board.planDir — must precede any path use
  const peerSrc = path.join(stageDir, 'peer');
  // THE REVIVE'S OWN QUESTION: a `claude --resume <id>` from this board's root succeeds
  // iff a transcript for <id> lives in a project dir that BELONGS to this repo. Deciding
  // that by DIR NAME is the trap audit #238 caught: a project dir is named for the LITERAL
  // cwd Claude recorded (C--Users-ADMINI-1-…), while board.root is realpath-canonical
  // (…-administrator-…, lowercased) — the SAME repo, two encodings, and comparing names
  // drops every legitimate claim on a short-named / junctioned / case-variant path. So:
  // fast-path on the encoded names (the common no-gap case, no file read), then fall back
  // to GROUND TRUTH — the cwd stored inside the transcript, canonicalised the same way
  // board.root was. Two resolutions that used to disagree now reduce to one.
  const rootCanon = board.root;                                            // resolveBoard already canonicalised it
  const rootNames = new Set([encodeProject(root), encodeProject(rootCanon)].map((s) => s.toLowerCase()));
  const canRevive = (id) => {
    if (!id) return false;
    const projs = new Set();
    for (const key of landed) { const c = key.indexOf('|'); if (key.slice(c + 1) === id) projs.add(key.slice(0, c)); }
    for (const proj of listDir(PROJECTS)) { if (fs.existsSync(path.join(PROJECTS, proj, `${id}.jsonl`))) projs.add(proj); }
    for (const proj of projs) if (rootNames.has(proj.toLowerCase())) return true;   // name matches — done, no read
    for (const proj of projs) {                                            // names differ (realpath gap): resolve the cwd
      const cwd = sniffLaunchCwd(path.join(PROJECTS, proj, `${id}.jsonl`), proj);
      try { if (cwd && B.canonical(cwd) === rootCanon) return true; } catch {}
    }
    return false;
  };
  const boardBackup = () => {
    const d = path.join(backupDir, 'board-' + encodeProject(board.root));
    fs.mkdirSync(d, { recursive: true });
    markBackedUp();
    return d;
  };

  // 1. the ledger — merge, refuse, or land fresh
  let archText = ''; try { archText = fs.readFileSync(path.join(peerSrc, 'notes.jsonl'), 'utf8'); } catch {}
  const localNotes = path.join(board.planDir, 'notes.jsonl');
  const localText = fs.existsSync(localNotes) ? fs.readFileSync(localNotes, 'utf8') : '';
  const m = mergeLedgers(localText, archText);
  if (!m.ok) {
    lines.push(`  board "${meta.name}": merge REFUSED — ${m.reason}`);
    lines.push(`    local   line ${m.line}: ${String(m.local).slice(0, 160)}`);
    lines.push(`    archive line ${m.line}: ${String(m.archive).slice(0, 160)}`);
    lines.push('    the local board is untouched. These two boards are not copies of one history; merging would corrupt both.');
    return;
  }
  if (dryRun) {
    lines.push(`  board "${meta.name}" -> ${root}: would merge ${m.added} new note(s)${localText ? '' : ' (fresh board here)'}`);
  } else {
    if (m.added > 0) {
      if (localText) fs.copyFileSync(localNotes, path.join(boardBackup(), 'notes.jsonl'));
      const tmpF = `${localNotes}.tmp-${process.pid}`;
      fs.writeFileSync(tmpF, m.text);
      fs.renameSync(tmpF, localNotes);
    }
    lines.push(`  board "${meta.name}" -> ${root}: ${m.added} new note(s) merged${localText ? '' : ' (fresh board here)'}`);
  }

  // 2. claims — tombstone in, gated; never over a live holder
  const archClaims = new Map();   // role -> tombstone (the cursor gate below needs the convIds)
  for (const f of listDir(peerSrc)) {
    const cm = /^claim-(.+)\.json$/.exec(f); if (!cm) continue;
    const role = cm[1];
    let c; try { c = JSON.parse(fs.readFileSync(path.join(peerSrc, f), 'utf8')); } catch { continue; }
    const tomb = { role: c.role || role, sessionId: c.sessionId || null, convId: c.convId || null, at: c.at || 0 };
    archClaims.set(role, tomb);
    if (!tomb.convId || !canRevive(tomb.convId)) {
      lines.push(`    claim ${role}: dropped — its conversation is not reachable from this board's root (a revive pointer arc could not honour)`);
      continue;
    }
    // ONE decision function for both modes: --dry-run used to answer BEFORE the HELD guard
    // ran, promising "would carry" for chairs the real run then kept — the preview
    // contradicted the one protection an operator dry-runs to check (audit #236). The dry
    // run now evaluates the same guards read-only; only the write is withheld (and the lock
    // — a preview must not contend with a live claim in flight).
    //
    // The tiebreak reads the claim RAW: roleClaim is genuineness-filtered, so a local
    // TOMBSTONE reads as null through it and would be clobbered unconditionally — a week of
    // work on this machine losing its revive pointer to a stale archive (audit #234, proved
    // with a maximally-newer tombstone). And the local side passes the SAME reachability
    // gate as the archive side: a newer pointer at a conversation this machine cannot
    // revive loses to an older one it can.
    const decide = () => {
      if (B.roleClaim(board, role)) return `chair is HELD by a live session here — kept (never tombstone a live peer)`;
      const raw = B.readClaimFile(board, role);
      const localOk = raw && raw.convId && canRevive(raw.convId);
      if (localOk && (raw.at || 0) >= (tomb.at || 0)) return `local revive pointer is newer — kept`;
      return null;   // null = the tombstone lands
    };
    if (dryRun) {
      const kept = decide();
      lines.push(`    claim ${role}: ${kept ? `would keep — ${kept}` : `would carry the revive pointer -> ${tomb.convId.slice(0, 8)}`}`);
      continue;
    }
    try {
      B.withLock(board, `role-${role}`, () => {
        const kept = decide();
        if (kept) { lines.push(`    claim ${role}: ${kept}`); return; }
        B.atomicWriteJson(path.join(board.planDir, f), tomb);
        lines.push(`    claim ${role}: revivable here as ${tomb.convId.slice(0, 8)}`);
      });
    } catch (e) { lines.push(`    claim ${role}: skipped (${e.message})`); }
  }

  // 3. cursors + seen — carry IFF that role's session travelled (or already lives here).
  //    cursor-notes (the CLI reader) has no claim, so no convId — it stays home, correctly:
  //    it is the OTHER machine's human's read position, not this one's.
  for (const f of listDir(peerSrc)) {
    const km = /^(cursor|seen)-(.+)\.json$/.exec(f); if (!km) continue;
    const kind = km[1], who = km[2];
    const tomb = archClaims.get(who);
    if (!tomb || !tomb.convId || !canRevive(tomb.convId)) {
      lines.push(`    ${kind} ${who}: dropped — its session is not reachable here (a fresh session must re-read, not inherit blindness)`);
      continue;
    }
    let arch; try { arch = JSON.parse(fs.readFileSync(path.join(peerSrc, f), 'utf8')); } catch { continue; }
    const dst = path.join(board.planDir, f);
    let localNewer = false;
    try { localNewer = ((JSON.parse(fs.readFileSync(dst, 'utf8')).at || 0) >= (arch.at || 0)); } catch {}
    if (localNewer) { lines.push(`    ${kind} ${who}: local is newer — kept`); continue; }
    if (!dryRun) B.atomicWriteJson(dst, arch);
    lines.push(`    ${kind} ${who}: carried (its session travelled with it)`);
  }

  // 4. charters — hand-written files: newer mtime wins (tar preserves mtimes), loser backed up
  const rolesSrc = path.join(stageDir, 'roles');
  const rolesDst = path.join(board.root, '.arc', 'roles');
  for (const f of listDir(rolesSrc)) {
    if (!f.endsWith('.md')) continue;
    const src = path.join(rolesSrc, f), dst = path.join(rolesDst, f);
    let action = 'added';
    if (fs.existsSync(dst)) {
      if (fs.readFileSync(dst, 'utf8') === fs.readFileSync(src, 'utf8')) continue;
      if (fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) { lines.push(`    charter ${f}: local is newer — kept`); continue; }
      if (!dryRun) {
        const bdir = path.join(boardBackup(), 'roles'); fs.mkdirSync(bdir, { recursive: true });
        fs.copyFileSync(dst, path.join(bdir, f));
      }
      action = 'updated';
    }
    if (!dryRun) { fs.mkdirSync(rolesDst, { recursive: true }); fs.copyFileSync(src, dst); }
    lines.push(`    charter ${f}: ${action}`);
  }
}

// ---- delete (to recoverable trash) -----------------------------------------

// Locate a conversation's transcript across project dirs.
function findTranscriptFile(convId) {
  if (!convId) return null;
  let projs = []; try { projs = fs.readdirSync(PROJECTS); } catch { return null; }
  for (const proj of projs) {
    if (proj === '.trash') continue;
    const fp = path.join(PROJECTS, proj, convId + '.jsonl');
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}

// Move a path, retrying (Windows may briefly hold the handle after a killed
// claude), falling back to copy+delete across volumes.
function moveWithRetry(src, dst) {
  for (let i = 0; i < 5; i++) {
    try { fs.renameSync(src, dst); return true; } catch (e) {
      if (i === 4) {
        try { // last resort: copy then remove
          const st = fs.statSync(src);
          if (st.isDirectory()) fs.cpSync(src, dst, { recursive: true }); else fs.copyFileSync(src, dst);
          fs.rmSync(src, { recursive: true, force: true });
          return true;
        } catch { return false; }
      }
      const until = Date.now() + 150; while (Date.now() < until) { /* brief spin */ }
    }
  }
  return false;
}

// Move a conversation's transcript (+ sidecar dir) to recoverable trash under
// ~/.claude/backups/arc-deleted-<ts>/. Returns { trashDir, moved:[...] }.
function trashSession(convId) {
  const fp = findTranscriptFile(convId);
  if (!fp) return { trashDir: null, moved: [] };
  const proj = path.basename(path.dirname(fp));
  const trashDir = path.join(BACKUPS, `arc-deleted-${stamp()}`);
  const destProj = path.join(trashDir, proj);
  fs.mkdirSync(destProj, { recursive: true });
  const moved = [];
  if (moveWithRetry(fp, path.join(destProj, convId + '.jsonl'))) moved.push('transcript');
  const side = path.join(path.dirname(fp), convId);
  try { if (fs.existsSync(side) && fs.statSync(side).isDirectory()) { if (moveWithRetry(side, path.join(destProj, convId))) moved.push('sidecar'); } } catch {}
  return { trashDir, moved };
}

// ---- trash management (arc:trash) -------------------------------------------
// The trash is the arc-deleted-* dirs trashSession writes. Pure file ops, so
// list / restore / empty all run inside the arc:trash hook — zero tokens. Only
// arc-deleted-* is ever touched; other ~/.claude/backups content is not trash.

// "arc-deleted-YYYYMMDD-HHMMSS" → "YYYY-MM-DD HH:MM" for display.
function trashDirDate(name) {
  const m = name.match(/^arc-deleted-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}$/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : '?';
}

// Strip command wrappers / tags / boilerplate from a user message so it reads as
// a topic snippet (fallback title when a conversation has no custom/ai title).
function cleanSnippet(s) {
  return String(s || '')
    .replace(/<command-[a-z]+>[\s\S]*?<\/command-[a-z]+>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pull identifying metadata from a transcript so the trash list is recognisable:
//   { customTitle, aiTitle, firstPrompt, turns, lastActive (ISO), cwd }
// customTitle = a /rename'd name; aiTitle = Claude Code's auto title. Very large
// transcripts (>30 MB) are read header-only (titles/cwd/first prompt) with the
// file mtime as last-active, so listing never stalls on a giant chat.
function transcriptMeta(fp) {
  const meta = { customTitle: null, aiTitle: null, firstPrompt: null, turns: null, lastActive: null, cwd: null };
  let size = 0; try { size = fs.statSync(fp).size; } catch { return meta; }
  const HEADER_ONLY = size > 30 * 1024 * 1024;

  let text;
  try {
    if (HEADER_ONLY) {
      const fd = fs.openSync(fp, 'r');
      const buf = Buffer.alloc(Math.min(size, 131072));
      fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      text = buf.toString('utf8');
      try { meta.lastActive = fs.statSync(fp).mtime.toISOString(); } catch {}
    } else {
      text = fs.readFileSync(fp, 'utf8');
      meta.turns = 0;
    }
  } catch { return meta; }

  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; } // header-only: trailing partial line just fails to parse
    if (e.type === 'custom-title' && e.customTitle && !meta.customTitle) meta.customTitle = String(e.customTitle).slice(0, 80);
    else if (e.type === 'ai-title' && e.aiTitle && !meta.aiTitle) meta.aiTitle = String(e.aiTitle).slice(0, 80);
    if (!meta.cwd && typeof e.cwd === 'string') meta.cwd = e.cwd;
    if (!HEADER_ONLY && typeof e.timestamp === 'string' && (!meta.lastActive || e.timestamp > meta.lastActive)) meta.lastActive = e.timestamp;
    if ((e.type === 'user' || e.type === 'assistant') && e.message && !e.isMeta) {
      if (!HEADER_ONLY) meta.turns++;
      if (e.type === 'user' && !meta.firstPrompt) {
        let c = e.message.content;
        if (Array.isArray(c)) c = c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ');
        if (typeof c === 'string') {
          const t = cleanSnippet(c);
          if (t && !/^(This session is being continued|Continue from where you left off)/i.test(t)) meta.firstPrompt = t.slice(0, 100);
        }
      }
    }
  }
  return meta;
}

// Every trashed conversation, newest first:
// { convId, proj, dir, file, sidecar, bytes, deletedAt }.
function listTrash() {
  const out = [];
  let dirs = []; try { dirs = fs.readdirSync(BACKUPS).filter((d) => /^arc-deleted-/.test(d)); } catch {}
  for (const d of dirs.sort().reverse()) {
    let projs = []; try { projs = fs.readdirSync(path.join(BACKUPS, d)); } catch { continue; }
    for (const proj of projs) {
      const pd = path.join(BACKUPS, d, proj);
      let files = [];
      try { if (!fs.statSync(pd).isDirectory()) continue; files = fs.readdirSync(pd); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const convId = f.slice(0, -'.jsonl'.length);
        let bytes = 0; try { bytes = fs.statSync(path.join(pd, f)).size; } catch {}
        let sidecar = null;
        try { const s = path.join(pd, convId); if (fs.statSync(s).isDirectory()) sidecar = s; } catch {}
        out.push({ convId, proj, dir: d, file: path.join(pd, f), sidecar, bytes, deletedAt: trashDirDate(d) });
      }
    }
  }
  return out;
}

// Restore ONE trashed conversation (unique id prefix) back into its project dir.
function restoreSession(idPrefix) {
  const pre = String(idPrefix || '').trim().toLowerCase();
  if (pre.length < 4) return { ok: false, message: 'give at least 4 chars of the conversation id — arc:trash lists them.' };
  const hits = listTrash().filter((e) => e.convId.toLowerCase().startsWith(pre));
  if (!hits.length) return { ok: false, message: `nothing in trash matches "${pre}" — arc:trash lists what's there.` };
  if (hits.length > 1) return { ok: false, message: `"${pre}" is ambiguous (${hits.map((h) => h.convId.slice(0, 8)).join(', ')}) — use more characters.` };
  const e = hits[0];
  const destDir = path.join(PROJECTS, e.proj);
  const dest = path.join(destDir, e.convId + '.jsonl');
  if (fs.existsSync(dest)) return { ok: false, message: `NOT restored — ${e.proj}\\${e.convId.slice(0, 8)}….jsonl already exists (already restored, or never really gone).` };
  fs.mkdirSync(destDir, { recursive: true });
  if (!moveWithRetry(e.file, dest)) return { ok: false, message: `restore FAILED — could not move the transcript back (it stays safe in ${e.dir}).` };
  const moved = ['transcript'];
  if (e.sidecar && moveWithRetry(e.sidecar, path.join(destDir, e.convId))) moved.push('sidecar');
  // Drop the trash dir if this emptied it (rmdir refuses non-empty — safe).
  try { fs.rmdirSync(path.dirname(e.file)); } catch {}
  try { fs.rmdirSync(path.join(BACKUPS, e.dir)); } catch {}
  return {
    ok: true, convId: e.convId, proj: e.proj, moved,
    message: `✓ restored ${e.convId.slice(0, 8)} (${moved.join('+')}, ${human(e.bytes)})\n  resume it from its project folder: arc --resume ${e.convId}`,
  };
}

// PERMANENTLY delete the whole conversation trash (all arc-deleted-* dirs,
// including empty leftovers). Returns { ok, count, bytes, failed }.
function emptyTrash() {
  const entries = listTrash();
  const bytes = entries.reduce((s, e) => s + e.bytes, 0);
  let dirs = []; try { dirs = fs.readdirSync(BACKUPS).filter((d) => /^arc-deleted-/.test(d)); } catch {}
  let failed = 0;
  for (const d of dirs) {
    try { fs.rmSync(path.join(BACKUPS, d), { recursive: true, force: true }); } catch { failed++; }
  }
  return { ok: failed === 0, count: entries.length, bytes, failed };
}

module.exports = { doExport, doImport, discover, findTranscriptFile, trashSession, listTrash, restoreSession, emptyTrash, transcriptMeta, human, currentProject, encodeProject, sniffLaunchCwd, remapCwd, underPath, copyRemappingCwd, tokenize, runTar, mergeLedgers, sessionBoards, stageBoard, importBoard, BOARD_PREFIX };
