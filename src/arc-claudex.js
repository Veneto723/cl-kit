#!/usr/bin/env node
// arc-claudex — lifecycle manager for the claudex translator sidecar (arc-claudex-proxy.js).
//
// A "codex" account in arc is a GPT model served to Claude Code's harness through a gateway.
// Claude Code speaks ONLY Anthropic /v1/messages; the gateway serves GPT only on the OpenAI
// side, so a LOCAL translator must sit between them. This module owns that translator's life:
// it starts ONE per account (on 127.0.0.1:<account port>), reuses a healthy one, tracks its
// PID, and sweeps orphans — so the user never runs or babysits a separate process. They just
// `arc:switch <codex-account>` and it works.
//
// SECURITY: the gateway key is DPAPI-decrypted only in memory and handed to the child via the
// ENVIRONMENT (never argv, never disk). The sidecar binds 127.0.0.1 only.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const PROXY = path.join(__dirname, 'arc-claudex-proxy.js');
const STATE_DIR = path.join(os.homedir(), '.claude', 'cache');
const DEFAULT_PORT = 8790;

// A codex account is any api account carrying a `proxy` block. baseUrl is the GATEWAY
// (upstream); proxy.port is the LOCAL translator Claude Code actually talks to.
function isClaudex(acc) { return !!(acc && acc.proxy && acc.proxy.port); }
function portFor(acc) { return (acc.proxy && acc.proxy.port) || DEFAULT_PORT; }
function localBaseUrl(acc) { return `http://127.0.0.1:${portFor(acc)}`; }
function pidFile(port) { return path.join(STATE_DIR, `arc-claudex-${port}.json`); }

// GET /healthz — is a translator already up on this port? Resolves the health JSON or null.
function health(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(b) : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function readPid(port) { try { return JSON.parse(fs.readFileSync(pidFile(port), 'utf8')); } catch { return null; } }
function writePid(port, rec) { try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(pidFile(port), JSON.stringify(rec)); } catch {} }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

// Is ANYTHING bound to this port? (health() returns null for BOTH "free" and "bound but not a
// healthy translator" — so before spawning, we need to tell those apart, else we spawn onto a
// busy port and the child dies with EADDRINUSE.)
function portInUse(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ensure a healthy translator for `acc` is listening, spawning one if needed. Returns
// { port, baseUrl, pid, reused }. `resolveKey` is injected (arc-config.resolveApiKey) so the
// key path is testable and so this module never imports config directly.
async function ensureProxy(acc, resolveKey, opts) {
  const o = opts || {};
  const spawnFn = o.spawn || spawn;
  const healthFn = o.health || health;
  const port = portFor(acc);
  const baseUrl = localBaseUrl(acc);

  // 1. already healthy? reuse — never double-spawn / clash on the port.
  const h = await healthFn(port);
  if (h) return { port, baseUrl, pid: (readPid(port) || {}).pid || null, reused: true };

  // 1b. port occupied but NOT our healthy translator (a hung/stale one, or a foreign process)?
  // Reclaim it, or fail with guidance — otherwise the spawn below dies with EADDRINUSE.
  const inUse = o.portInUse || portInUse;
  if (await inUse(port)) {
    const stale = readPid(port);
    if (stale && stale.pid && alive(stale.pid)) {               // a stale translator WE started
      try { process.kill(stale.pid); } catch {}
      try { fs.unlinkSync(pidFile(port)); } catch {}
      for (let i = 0; i < 20 && (await inUse(port)); i++) await sleep(150);
    }
    if (await inUse(port)) throw new Error(`port ${port} is held by another process — run \`arc claudex stop\` or free it, then retry`);
  }

  // 2. spawn detached, key via ENV only.
  const key = resolveKey(acc);                       // throws if unresolvable — surfaced to caller
  const env = { ...process.env, CLAUDEX_KEY: key, CLAUDEX_UPSTREAM: acc.baseUrl, CLAUDEX_MODEL: acc.model || 'gpt-5.6-sol', CLAUDEX_PORT: String(port) };
  const child = spawnFn(process.execPath, [PROXY, String(port)], { detached: true, stdio: 'ignore', env, windowsHide: true });
  child.unref();
  writePid(port, { pid: child.pid, port, account: acc.id, upstream: acc.baseUrl, model: acc.model, started: Date.now() });

  // 3. wait until it answers (or give up so we fail loudly rather than launch into a dead port).
  const waitMs = o.waitMs || 8000;
  const start = Date.now();
  while (Date.now() - start < waitMs) { if (await healthFn(port)) return { port, baseUrl, pid: child.pid, reused: false }; await sleep(250); }
  throw new Error(`claudex translator did not come up on 127.0.0.1:${port} within ${waitMs}ms`);
}

function stopProxy(port) {
  const rec = readPid(port);
  if (rec && rec.pid && alive(rec.pid)) { try { process.kill(rec.pid); } catch {} }
  try { fs.unlinkSync(pidFile(port)); } catch {}
  return !!rec;
}

// Remove PID records whose process is gone (called on launch to keep state honest).
function sweepOrphans() {
  let names = []; try { names = fs.readdirSync(STATE_DIR); } catch { return 0; }
  let swept = 0;
  for (const n of names) {
    const m = n.match(/^arc-claudex-(\d+)\.json$/); if (!m) continue;
    const rec = readPid(parseInt(m[1], 10));
    if (rec && rec.pid && !alive(rec.pid)) { try { fs.unlinkSync(pidFile(rec.port)); swept++; } catch {} }
  }
  return swept;
}

function listProxies() {
  let names = []; try { names = fs.readdirSync(STATE_DIR); } catch { return []; }
  return names.map((n) => n.match(/^arc-claudex-(\d+)\.json$/)).filter(Boolean)
    .map((m) => readPid(parseInt(m[1], 10))).filter(Boolean)
    .map((r) => ({ ...r, alive: alive(r.pid) }));
}

module.exports = { isClaudex, portFor, localBaseUrl, ensureProxy, stopProxy, sweepOrphans, listProxies, health, DEFAULT_PORT };
