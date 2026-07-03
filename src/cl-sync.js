#!/usr/bin/env node
// cl-sync: discrete export / import of Claude Code chat sessions between machines.
// Pure file operations (tar over ~/.claude/projects), so they run inside the
// cl:export / cl:import hook — zero model tokens, no session disruption.
//
//   cl:export                → the CURRENT conversation only (fast)
//   cl:export all            → every session (bigger/slower)
//   cl:export <project|id>   → one project's sessions, or one session (id prefix)
//   cl:export --since <days> → sessions touched in the last N days
//   cl:export ... --out <f>  → choose the archive path (default ~/cl-export-<ts>.tgz)
//
//   cl:import <archive>      → extract + merge into ~/.claude/projects
//                              (newer-wins; overwritten local copies are backed
//                               up; a conversation OPEN in a live cl is never
//                               touched; --dry-run / --force / --skip-existing)
//
// Resume note: `claude --resume <id>` is scoped to the cwd's project dir, so the
// two machines must use the SAME project paths (e.g. both work in E:\proj).
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

function parseFlags(argStr) {
  const toks = (argStr || '').trim().split(/\s+/).filter(Boolean);
  const flags = {}; const pos = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      if (['out', 'since'].includes(key) && toks[i + 1] && !toks[i + 1].startsWith('--')) { flags[key] = toks[++i]; }
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
    if (!selected.length) return { ok: false, message: 'no current conversation found — try `cl:export all` or `cl:export <project|id>`.' };
  } else if (sel.toLowerCase() === 'all' || sel === '*') {
    selected = all; what = 'all sessions';
  } else {
    // project dir name, or session id / id-prefix
    selected = all.filter((s) => s.project === sel || s.id === sel || s.id.startsWith(sel));
    what = `"${sel}"`;
    if (!selected.length) return { ok: false, message: `nothing matched "${sel}". Use \`cl:export all\`, a project dir name, or a session id.` };
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
  if (!archive) return { ok: false, message: 'usage: cl:import <archive.tgz> [--dry-run] [--force] [--skip-existing]' };
  if (!fs.existsSync(archive)) return { ok: false, message: `archive not found: ${archive}` };

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
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      const srcJsonl = path.join(pdir, f);
      const srcSide = path.join(pdir, id);
      const dstDir = path.join(PROJECTS, proj);
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

      if (flags['dry-run']) { (action === 'add' ? added : updated).push(`${id.slice(0, 8)} (${proj})`); continue; }

      try {
        fs.mkdirSync(dstDir, { recursive: true });
        if (action === 'update') {
          // back up the local copy before overwriting (recoverable)
          const bproj = path.join(backupDir, proj); fs.mkdirSync(bproj, { recursive: true });
          fs.copyFileSync(dstJsonl, path.join(bproj, f));
          if (fs.existsSync(dstSide)) fs.cpSync(dstSide, path.join(bproj, id), { recursive: true });
          backedUp = true;
        }
        fs.copyFileSync(srcJsonl, dstJsonl);
        if (fs.existsSync(srcSide)) fs.cpSync(srcSide, dstSide, { recursive: true });
        (action === 'add' ? added : updated).push(`${id.slice(0, 8)} (${proj})`);
      } catch (e) {
        skipped.push(`${id.slice(0, 8)} (error: ${e.message})`);
      }
    }
  }
  rm(tmp);

  const dry = flags['dry-run'] ? ' [DRY RUN — nothing changed]' : '';
  const lines = [`cl:import${dry} — added ${added.length}, updated ${updated.length}, skipped ${skipped.length}`];
  if (added.length) lines.push('  added:   ' + added.join(', '));
  if (updated.length) lines.push('  updated: ' + updated.join(', '));
  if (skipped.length) lines.push('  skipped: ' + skipped.join(', '));
  if (backedUp) lines.push(`  replaced local copies backed up to: ${backupDir}`);
  lines.push('  resume from the matching project path, e.g.  cd <project>  then  claude --resume <id>  (or the cl picker).');
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

module.exports = { doExport, doImport, discover, findTranscriptFile, trashSession };
