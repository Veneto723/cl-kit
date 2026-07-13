#!/usr/bin/env node
// arc-bundle: discover, validate, install, and remove self-describing Arc bundles.
//
// A BUNDLE is a directory with an `arc-bundle.json` manifest declaring what it
// PROVIDES. The installer data-drives the same deploy primitives arc's own installer
// hardcodes — so a bundle is a first-party, independently-installable add-on that lives
// OUTSIDE arc core and never couples to it at runtime (arc is only the deploy vehicle;
// it never require()s into a bundle).
//
// Manifest (`arc-bundle.json`) — schema `manifest: 1`:
//   {
//     "manifest": 1, "name": "inquiry", "version": "1.0.0",
//     "requires": { "arc": ">=2.1", "node": ">=22", "host": ["claude"] },
//     "provides": {
//       "skills":     [{ "path": ".", "targets": ["claude", "codex"] }],  // -> ~/.claude/skills, ~/.agents/skills
//       "scripts":    [{ "src": "scripts", "dest": "scripts" }],           // -> ~/.claude/scripts
//       "hooks":      [{ "event": "UserPromptSubmit", "command": "node \"{scripts}/x.js\"" }],
//       "mcp":        [{ "name": "x", "dir": "mcp" }],                      // -> ~/.claude/scripts/x-mcp
//       "statusline": "node \"{scripts}/x.js\" --compact",
//       "home":       "~/.inquiry"                                          // declared writable home (doc only)
//     },
//     "test": "node --test tests/*.test.js"
//   }
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('./arc-wire-settings');

const MANIFEST_SCHEMA = 1;
const MANIFEST_FILE = 'arc-bundle.json';
const COPY_EXCLUDE = new Set([MANIFEST_FILE, '.git', 'node_modules', '.github', 'tests', 'test']);

function arcVersion() {
  try { return require('../package.json').version; } catch { return '0.0.0'; }
}
function defaults(opts = {}) {
  const home = os.homedir();
  const claudeDir = opts.claudeDir || path.join(home, '.claude');
  return {
    claudeDir,
    agentsDir: opts.agentsDir || path.join(home, '.agents'),
    arcHome: opts.arcHome || path.resolve(process.env.ARC_HOME || path.join(home, '.arc')),
    scriptsDir: opts.scriptsDir || path.join(claudeDir, 'scripts'),
    host: opts.host || { arc: arcVersion(), node: process.versions.node, claude: true, codex: !!opts.hasCodex },
    dryRun: !!opts.dryRun,
    registerMcp: opts.registerMcp !== false,
  };
}

// ---- manifest ---------------------------------------------------------------
function readManifest(bundleDir) {
  const p = path.join(bundleDir, MANIFEST_FILE);
  let m;
  try { m = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`cannot read bundle manifest ${p}: ${e.message}`); }
  return m;
}

// Minimal ">=x[.y[.z]]" satisfies (that's all our requires need). Missing range = ok.
function satisfies(version, range) {
  if (!range) return true;
  const m = String(range).match(/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return true; // unknown range form → don't block
  const need = [1, 2, 3].map((i) => parseInt(m[i] || '0', 10));
  const have = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((have[i] || 0) > need[i]) return true; if ((have[i] || 0) < need[i]) return false; }
  return true;
}

// Returns { ok, errors:[], warnings:[] }. Node/arc version mismatches are hard errors;
// a host the bundle doesn't list is a warning (a skill still deploys to whatever homes exist).
function validate(manifest, host = defaults().host) {
  const errors = [], warnings = [];
  if (manifest.manifest !== MANIFEST_SCHEMA) errors.push(`unsupported manifest schema ${manifest.manifest} (need ${MANIFEST_SCHEMA})`);
  if (!manifest.name || !/^[a-z][a-z0-9-]*$/.test(manifest.name)) errors.push(`invalid bundle name "${manifest.name}"`);
  if (!manifest.provides || typeof manifest.provides !== 'object') errors.push('manifest.provides is required');
  const req = manifest.requires || {};
  if (req.node && !satisfies(host.node, req.node)) errors.push(`requires node ${req.node} (have ${host.node})`);
  if (req.arc && !satisfies(host.arc, req.arc)) errors.push(`requires arc ${req.arc} (have ${host.arc})`);
  if (Array.isArray(req.host)) {
    const activeHosts = ['claude', host.codex ? 'codex' : null].filter(Boolean);
    if (!req.host.some((h) => activeHosts.includes(h))) warnings.push(`bundle targets ${req.host.join('/')}; this host is ${activeHosts.join('/')}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ---- discovery --------------------------------------------------------------
function discover(bundlesDir) {
  let entries = [];
  try { entries = fs.readdirSync(bundlesDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(bundlesDir, e.name);
    if (!fs.existsSync(path.join(dir, MANIFEST_FILE))) continue;
    try { out.push({ dir, manifest: readManifest(dir) }); } catch { /* skip unreadable */ }
  }
  return out;
}

// ---- file ops ---------------------------------------------------------------
function copyDir(src, dest, { exclude = COPY_EXCLUDE } = {}) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter: (s) => !exclude.has(path.basename(s)) });
}

// ---- lockfile ---------------------------------------------------------------
function lockPath(o) { return path.join(o.arcHome, 'bundles.json'); }
function readLock(o) {
  try { return JSON.parse(fs.readFileSync(lockPath(o), 'utf8')); } catch { return { version: 1, bundles: {} }; }
}
function writeLock(o, lock) {
  fs.mkdirSync(o.arcHome, { recursive: true });
  fs.writeFileSync(lockPath(o), JSON.stringify(lock, null, 2) + '\n');
}

// ---- install ----------------------------------------------------------------
// Deploy every `provides` unit; record deployed paths + hook-commands in the lockfile
// so remove() is a clean inverse. Returns { name, version, deployed, warnings }.
function install(bundleDir, options = {}) {
  const o = defaults(options);
  const manifest = readManifest(bundleDir);
  const v = validate(manifest, o.host);
  if (!v.ok) throw new Error(`bundle "${manifest.name}" cannot install:\n  - ${v.errors.join('\n  - ')}`);

  const name = manifest.name;
  const provides = manifest.provides || {};
  const deployed = { skills: [], scripts: [], mcp: [], hookCommands: [], statusline: false, home: provides.home || null };
  const S = o.scriptsDir.replace(/\\/g, '/');

  // skills → skill homes
  for (const s of provides.skills || []) {
    const srcDir = path.resolve(bundleDir, s.path || '.');
    const targets = s.targets || ['claude'];
    if (targets.includes('claude')) { const d = path.join(o.claudeDir, 'skills', name); if (!o.dryRun) copyDir(srcDir, d); deployed.skills.push(d); }
    if (targets.includes('codex')) { const d = path.join(o.agentsDir, 'skills', name); if (!o.dryRun) copyDir(srcDir, d); deployed.skills.push(d); }
  }
  // scripts → ~/.claude/scripts
  for (const sc of provides.scripts || []) {
    const src = path.resolve(bundleDir, sc.src);
    const destDir = path.join(o.claudeDir, sc.dest || 'scripts');
    if (!o.dryRun) fs.mkdirSync(destDir, { recursive: true });
    const files = fs.statSync(src).isDirectory() ? fs.readdirSync(src).filter((f) => f.endsWith('.js')).map((f) => path.join(src, f)) : [src];
    for (const f of files) { const d = path.join(destDir, path.basename(f)); if (!o.dryRun) fs.copyFileSync(f, d); deployed.scripts.push(d); }
  }
  // mcp → ~/.claude/scripts/<name>-mcp (registration is a documented side effect)
  for (const mc of provides.mcp || []) {
    const srcDir = path.resolve(bundleDir, mc.dir || 'mcp');
    const d = path.join(o.scriptsDir, `${mc.name}-mcp`);
    if (!o.dryRun) copyDir(srcDir, d, { exclude: new Set([MANIFEST_FILE, '.git']) });
    deployed.mcp.push({ name: mc.name, dir: d, entry: path.join(d, mc.entry ? path.basename(mc.entry) : 'server.js') });
  }
  // hooks + statusline → settings.json (via the wire-settings merge substrate)
  const hookEntries = (provides.hooks || []).map((h) => ({ event: h.event, command: h.command.replace(/\{scripts\}/g, S), match: h.match }));
  if (hookEntries.length || provides.statusline) {
    const settingsPath = path.join(o.claudeDir, 'settings.json');
    const { settings, raw } = W.readSettings(settingsPath);
    if (hookEntries.length) { W.mergeHooks(settings, hookEntries); deployed.hookCommands = hookEntries.map((h) => h.command); }
    if (provides.statusline) deployed.statusline = W.setStatusline(settings, provides.statusline.replace(/\{scripts\}/g, S));
    if (!o.dryRun) W.writeSettings(settingsPath, settings, raw);
  }

  if (!o.dryRun) {
    const lock = readLock(o);
    lock.bundles[name] = { version: manifest.version || null, installedAt: options.now || null, from: bundleDir, deployed };
    writeLock(o, lock);
  }
  return { name, version: manifest.version || null, deployed, warnings: v.warnings };
}

// ---- remove -----------------------------------------------------------------
function remove(name, options = {}) {
  const o = defaults(options);
  const lock = readLock(o);
  const rec = lock.bundles[name];
  if (!rec) return { removed: false, why: 'not installed' };
  for (const d of rec.deployed.skills || []) fs.rmSync(d, { recursive: true, force: true });
  for (const f of rec.deployed.scripts || []) { try { fs.unlinkSync(f); } catch {} }
  for (const m of rec.deployed.mcp || []) fs.rmSync(m.dir, { recursive: true, force: true });
  // pull our hook commands back out of settings.json
  if ((rec.deployed.hookCommands || []).length) {
    try {
      const settingsPath = path.join(o.claudeDir, 'settings.json');
      const { settings, raw } = W.readSettings(settingsPath);
      const gone = new Set(rec.deployed.hookCommands);
      for (const ev of Object.keys(settings.hooks || {})) {
        for (const g of settings.hooks[ev]) if (Array.isArray(g.hooks)) g.hooks = g.hooks.filter((h) => !gone.has(h.command));
        settings.hooks[ev] = settings.hooks[ev].filter((g) => Array.isArray(g.hooks) && g.hooks.length);
      }
      W.writeSettings(settingsPath, settings, raw);
    } catch {}
  }
  delete lock.bundles[name];
  writeLock(o, lock);
  return { removed: true };
}

function list(options = {}) { return readLock(defaults(options)).bundles; }

// Install every bundle under a bundles/ dir (used by the installer). Returns results.
function installAll(bundlesDir, options = {}) {
  return discover(bundlesDir).map((b) => {
    try { return { ...install(b.dir, options), ok: true }; }
    catch (e) { return { name: b.manifest && b.manifest.name, ok: false, error: e.message }; }
  });
}

module.exports = { MANIFEST_SCHEMA, MANIFEST_FILE, readManifest, validate, satisfies, discover, install, remove, list, installAll, defaults };

// CLI — used by the installer (`install-all <bundlesDir>`) and the `arc bundle` verb.
if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'install-all') {
      for (const r of installAll(arg)) {
        process.stdout.write(r.ok
          ? `  ✓ bundle ${r.name}@${r.version || '?'}${r.warnings && r.warnings.length ? '  (' + r.warnings.join('; ') + ')' : ''}\n`
          : `  ✗ bundle ${r.name || '?'}: ${r.error}\n`);
      }
    } else if (cmd === 'install') {
      const r = install(path.resolve(arg));
      process.stdout.write(`✓ installed bundle ${r.name}@${r.version || '?'}${r.warnings.length ? '  (' + r.warnings.join('; ') + ')' : ''}\n`);
    } else if (cmd === 'list') {
      const b = list(); const names = Object.keys(b);
      process.stdout.write(names.length ? names.map((n) => `  ${n}@${b[n].version || '?'}  (${(b[n].deployed.skills || []).length} skill target(s))`).join('\n') + '\n' : '(no bundles installed)\n');
    } else if (cmd === 'remove') {
      const r = remove(arg);
      process.stdout.write(r.removed ? `✓ removed bundle ${arg}\n` : `${arg}: ${r.why}\n`);
    } else {
      process.stderr.write('usage: arc-bundle.js  install-all <bundlesDir> | install <bundleDir> | list | remove <name>\n');
      process.exit(2);
    }
  } catch (e) { process.stderr.write(`arc-bundle: ${e.message}\n`); process.exit(1); }
}
