#!/usr/bin/env node
// cl-sync: discrete export / import of Claude Code chat sessions between machines.
// Pure file operations (tar over ~/.claude/projects), so they run inside the
// cl:export / cl:import hook — zero model tokens, no session disruption.
//
//   cl:export                → the CURRENT conversation only (fast)
//   cl:export all            → every session in the CURRENT project folder
//   cl:export global         → every session on this machine (bigger/slower; alias *)
//   cl:export <project|id>   → one project's sessions, or one session (id prefix)
//   cl:export --since <days> → sessions touched in the last N days
//   cl:export ... --out <f>  → choose the archive path (default ~/cl-export-<ts>.tgz)
//
//   cl:import <archive>      → extract + merge into ~/.claude/projects
//                              (newer-wins; overwritten local copies are backed
//                               up; a conversation OPEN in a live cl is never
//                               touched; --dry-run / --force / --skip-existing)
//   cl:import <a> --dest <d> → re-root every project in the bundle under OUTER
//                              folder <d>, keeping each project's own name:
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

// The conversation id THIS cl session is on (protected from import overwrite).
function currentConv(session) {
  for (const p of [path.join(CACHE, `cl-state-${session}.json`), path.join(CACHE, `cl-active-${session}.json`)]) {
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); if (j.convId) return j.convId; } catch {}
  }
  return null;
}

// The session's LAUNCH cwd (which is what Claude Code names the project dir after —
// not the shell's current cwd, which drifts).
function stateCwd(session) {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE, `cl-state-${session}.json`), 'utf8')).cwd || null; } catch { return null; }
}

// Claude Code names a project dir after the cwd with every non-alphanumeric replaced
// by '-'  (E:\ -> "E--",  E:\cl-kit -> "E--cl-kit"). Only a FALLBACK: the encoding is
// Claude Code's to change, so we prefer to look up the dir that actually holds this
// conversation.
const encodeProject = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');

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
// Session ids currently OPEN in a live cl process (never overwrite these).
function liveConvIds() {
  const live = new Set();
  try {
    for (const f of fs.readdirSync(CACHE)) {
      const m = /^cl-convlock-(.+)\.json$/.exec(f);
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
    if (!selected.length) return { ok: false, message: 'no current conversation found — try `cl:export all` (this project) or `cl:export global`.' };
  } else if (sel.toLowerCase() === 'all') {
    // `all` = every session in THIS project folder (the common case). Everything on the
    // machine is `global` — an explicit word, because that archive can be huge.
    const proj = currentProject(session, all);
    if (!proj) {
      return { ok: false, message: 'could not tell which project folder you are in — run `cl:export global`, or name a project dir (see ~/.claude/projects).' };
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
    if (!selected.length) return { ok: false, message: `nothing matched "${sel}". Use \`cl:export all\` (this project), \`cl:export global\` (everything), a project dir name, or a session id.` };
  }

  const totalBytes = selected.reduce((a, s) => a + s.size, 0);
  const rels = [];
  for (const s of selected) { rels.push(s.rel); if (s.sidecarRel) rels.push(s.sidecarRel); }

  // manifest at the archive root (readable inventory; skipped on import)
  const manifest = {
    tool: 'cl-sync', version: 1, machine: os.hostname(), at: new Date().toISOString(),
    sessions: selected.map((s) => ({ project: s.project, id: s.id, size: s.size, lastTs: s.lastTs, title: s.title })),
  };
  const manPath = path.join(PROJECTS, '.cl-manifest.json');
  const listPath = path.join(CACHE, `cl-export-list-${process.pid}.txt`);
  const out = flags.out ? path.resolve(flags.out) : path.join(HOME, `cl-export-${stamp()}.tgz`);
  try {
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(manPath, JSON.stringify(manifest, null, 2));
    fs.writeFileSync(listPath, ['.cl-manifest.json', ...rels].join('\n'));
    // --force-local: GNU tar otherwise reads a Windows `C:\...` archive path as a
    // remote host `C` ("Cannot connect to C"). This makes colons mean drive letters.
    const r = spawnSync('tar', ['--force-local', '-czf', out, '-C', PROJECTS, '-T', listPath], { encoding: 'utf8', windowsHide: true, timeout: 300_000 });
    if (r.status !== 0) return { ok: false, message: `export FAILED — tar: ${(r.stderr || r.error && r.error.message || 'unknown').toString().slice(0, 200)}` };
  } catch (e) {
    return { ok: false, message: `export FAILED — ${e.message}` };
  } finally {
    try { fs.unlinkSync(manPath); } catch {}
    try { fs.unlinkSync(listPath); } catch {}
  }
  let archiveSize = 0; try { archiveSize = fs.statSync(out).size; } catch {}
  return {
    ok: true,
    message:
      `✓ exported ${selected.length} session(s) — ${what} (${human(totalBytes)} → ${human(archiveSize)} archive)\n` +
      `  ${out}\n` +
      `  copy that file to the other PC, then run:  cl:import "${out.split(path.sep).pop()}"  (from wherever you put it)`,
  };
}

// ---- import ----------------------------------------------------------------

function doImport(session, argStr) {
  const { flags, pos } = parseFlags(argStr);
  const archive = pos[0] ? path.resolve(pos[0]) : null;
  if (!archive) return { ok: false, message: 'usage: cl:import <archive.tgz> [--dest "E:\\outer\\folder"] [--dry-run] [--force] [--skip-existing]' };
  if (!fs.existsSync(archive)) return { ok: false, message: `archive not found: ${archive}` };

  // --dest re-roots each imported project under an OUTER folder, KEEPING its own name:
  // --dest "E:\whaletech" puts project E:\whalephone → E:\whaletech\whalephone (and every
  // other project in the bundle → E:\whaletech\<its name>), so they resume at the local
  // path. Requires an absolute path. Sessions whose source path can't be recovered are
  // skipped and reported rather than guessed.
  const destRoot = flags.dest ? String(flags.dest).replace(/[\\/]+$/, '') : null;
  if (destRoot !== null && !path.win32.isAbsolute(destRoot + '\\')) {
    return { ok: false, message: `--dest must be an absolute folder path (got "${flags.dest}"), e.g. --dest "E:\\whaletech".` };
  }
  const remaps = []; // {name, from, to} for the report
  const destSeen = new Map(); // destProjName -> source proj (collision guard)

  const tmp = path.join(CACHE, `cl-import-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(tmp, { recursive: true });
    const r = spawnSync('tar', ['--force-local', '-xzf', archive, '-C', tmp], { encoding: 'utf8', windowsHide: true, timeout: 300_000 });
    if (r.status !== 0) { rm(tmp); return { ok: false, message: `import FAILED — tar: ${(r.stderr || 'unknown').toString().slice(0, 200)}` }; }
  } catch (e) { rm(tmp); return { ok: false, message: `import FAILED — ${e.message}` }; }

  const protectedIds = liveConvIds();
  const cur = currentConv(session); if (cur) protectedIds.add(cur);
  const backupDir = path.join(BACKUPS, `cl-import-${stamp()}`);
  const added = [], updated = [], skipped = [];
  let backedUp = false;

  // walk extracted <proj>/<id>.jsonl
  let projs = []; try { projs = fs.readdirSync(tmp); } catch {}
  for (const proj of projs) {
    const pdir = path.join(tmp, proj);
    let st; try { st = fs.statSync(pdir); } catch { continue; }
    if (!st.isDirectory()) continue; // skips .cl-manifest.json
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

      if (protectedIds.has(id)) { skipped.push(`${id.slice(0, 8)} (open in a live session — protected)`); continue; }

      const exists = fs.existsSync(dstJsonl);
      let action = 'add';
      if (exists) {
        if (flags['skip-existing']) { skipped.push(`${id.slice(0, 8)} (exists)`); continue; }
        const sameSize = (() => { try { return fs.statSync(dstJsonl).size === fs.statSync(srcJsonl).size; } catch { return false; } })();
        if (sameSize) { skipped.push(`${id.slice(0, 8)} (identical)`); continue; }
        const tTs = lastTs(srcJsonl), lTs = lastTs(dstJsonl);
        if (!flags.force && lTs && tTs && lTs > tTs) { skipped.push(`${id.slice(0, 8)} (local is newer — kept; --force to override)`); continue; }
        action = 'update';
      }

      if (flags['dry-run']) { (action === 'add' ? added : updated).push(`${id.slice(0, 8)} (${destProjName})`); continue; }

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
        (action === 'add' ? added : updated).push(`${id.slice(0, 8)} (${destProjName})`);
      } catch (e) {
        skipped.push(`${id.slice(0, 8)} (error: ${e.message})`);
      }
    }
  }
  rm(tmp);

  const dry = flags['dry-run'] ? ' [DRY RUN — nothing changed]' : '';
  const lines = [`cl:import${dry} — added ${added.length}, updated ${updated.length}, skipped ${skipped.length}`];
  if (remaps.length) {
    lines.push(`  re-rooted under ${destRoot}:`);
    for (const r of remaps) lines.push(`    ${r.from}  →  ${r.to}${r.clash ? '   ⚠ same name as another project — MERGED into one folder' : ''}`);
  }
  if (added.length) lines.push('  added:   ' + added.join(', '));
  if (updated.length) lines.push('  updated: ' + updated.join(', '));
  if (skipped.length) lines.push('  skipped: ' + skipped.join(', '));
  if (backedUp) lines.push(`  replaced local copies backed up to: ${backupDir}`);
  lines.push(destRoot
    ? `  resume from the re-rooted path, e.g.  cd "${remaps[0] ? remaps[0].to : destRoot}"  then  claude --resume <id>  (or the cl picker).`
    : '  resume from the matching project path, e.g.  cd <project>  then  claude --resume <id>  (or the cl picker).');
  return { ok: true, message: lines.join('\n') };
}

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }

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
// ~/.claude/backups/cl-deleted-<ts>/. Returns { trashDir, moved:[...] }.
function trashSession(convId) {
  const fp = findTranscriptFile(convId);
  if (!fp) return { trashDir: null, moved: [] };
  const proj = path.basename(path.dirname(fp));
  const trashDir = path.join(BACKUPS, `cl-deleted-${stamp()}`);
  const destProj = path.join(trashDir, proj);
  fs.mkdirSync(destProj, { recursive: true });
  const moved = [];
  if (moveWithRetry(fp, path.join(destProj, convId + '.jsonl'))) moved.push('transcript');
  const side = path.join(path.dirname(fp), convId);
  try { if (fs.existsSync(side) && fs.statSync(side).isDirectory()) { if (moveWithRetry(side, path.join(destProj, convId))) moved.push('sidecar'); } } catch {}
  return { trashDir, moved };
}

// ---- trash management (cl:trash) -------------------------------------------
// The trash is the cl-deleted-* dirs trashSession writes. Pure file ops, so
// list / restore / empty all run inside the cl:trash hook — zero tokens. Only
// cl-deleted-* is ever touched; other ~/.claude/backups content is not trash.

// "cl-deleted-YYYYMMDD-HHMMSS" → "YYYY-MM-DD HH:MM" for display.
function trashDirDate(name) {
  const m = name.match(/^cl-deleted-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}$/);
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
  let dirs = []; try { dirs = fs.readdirSync(BACKUPS).filter((d) => /^cl-deleted-/.test(d)); } catch {}
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
  if (pre.length < 4) return { ok: false, message: 'give at least 4 chars of the conversation id — cl:trash lists them.' };
  const hits = listTrash().filter((e) => e.convId.toLowerCase().startsWith(pre));
  if (!hits.length) return { ok: false, message: `nothing in trash matches "${pre}" — cl:trash lists what's there.` };
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
    message: `✓ restored ${e.convId.slice(0, 8)} (${moved.join('+')}, ${human(e.bytes)})\n  resume it from its project folder: cl --resume ${e.convId}`,
  };
}

// PERMANENTLY delete the whole conversation trash (all cl-deleted-* dirs,
// including empty leftovers). Returns { ok, count, bytes, failed }.
function emptyTrash() {
  const entries = listTrash();
  const bytes = entries.reduce((s, e) => s + e.bytes, 0);
  let dirs = []; try { dirs = fs.readdirSync(BACKUPS).filter((d) => /^cl-deleted-/.test(d)); } catch {}
  let failed = 0;
  for (const d of dirs) {
    try { fs.rmSync(path.join(BACKUPS, d), { recursive: true, force: true }); } catch { failed++; }
  }
  return { ok: failed === 0, count: entries.length, bytes, failed };
}

module.exports = { doExport, doImport, discover, findTranscriptFile, trashSession, listTrash, restoreSession, emptyTrash, transcriptMeta, human, currentProject, encodeProject, sniffLaunchCwd, remapCwd, underPath, copyRemappingCwd, tokenize };
