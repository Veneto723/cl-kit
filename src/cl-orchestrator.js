// cl-orchestrator: durable runtime-neutral identity above Claude/Codex sessions.
// Native transcripts remain owned by their runtimes; this registry stores only
// lineage and non-secret metadata needed to launch, resume, and hand off safely.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;
const CL_HOME = path.resolve(process.env.CL_HOME || path.join(os.homedir(), '.cl'));
const SESSIONS_DIR = path.join(CL_HOME, 'sessions');
const RUNTIMES = new Set(['claude', 'codex']);
const ID_RX = /^[a-z0-9][a-z0-9-]{0,79}$/i;

function now() { return new Date().toISOString(); }
function assertRuntime(runtime) {
  if (!RUNTIMES.has(runtime)) throw new Error(`unsupported runtime "${runtime}"`);
  return runtime;
}
function assertId(id) {
  if (!ID_RX.test(String(id || ''))) throw new Error(`invalid cl session id "${id || ''}"`);
  return String(id);
}
function sessionPath(id) { return path.join(SESSIONS_DIR, `${assertId(id)}.json`); }

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  try { fs.renameSync(tmp, file); }
  catch { try { fs.unlinkSync(file); } catch {} fs.renameSync(tmp, file); }
}

function readSession(id) {
  const file = sessionPath(id);
  if (!fs.existsSync(file)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!s || s.version !== VERSION) throw new Error(`unsupported or missing schema version`);
    return s;
  } catch (e) {
    throw new Error(`cannot read cl session ${file}: ${e.message}`);
  }
}

function listSessions() {
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => {
    try { const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); return s && s.version === VERSION ? s : null; }
    catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function findByNative(runtime, nativeSessionId) {
  assertRuntime(runtime);
  if (!nativeSessionId) return null;
  return listSessions().find((s) => s.bindings && s.bindings[runtime]
    && s.bindings[runtime].nativeSessionId === nativeSessionId) || null;
}

function createSession(opts = {}) {
  const runtime = assertRuntime(opts.runtime || 'claude');
  const id = assertId(opts.id || crypto.randomUUID());
  if (readSession(id)) throw new Error(`cl session "${id}" already exists`);
  const at = now();
  const session = {
    version: VERSION,
    id,
    createdAt: at,
    updatedAt: at,
    cwd: path.resolve(opts.cwd || process.cwd()),
    activeRuntime: runtime,
    bindings: {},
    lineage: [],
  };
  atomicWrite(sessionPath(id), session);
  return session;
}

function bindingMetadata(runtime, data, previous) {
  const out = {
    runtime,
    nativeSessionId: data.nativeSessionId || (previous && previous.nativeSessionId) || null,
    account: data.account || (previous && previous.account) || 'default',
    model: data.model || (previous && previous.model) || null,
    transcriptPath: data.transcriptPath || (previous && previous.transcriptPath) || null,
    state: data.state || (previous && previous.state) || 'active',
    updatedAt: now(),
  };
  if (data.pid) out.pid = data.pid;
  else if (previous && previous.pid) out.pid = previous.pid;
  return out;
}

function bindRuntime(id, runtime, data = {}, opts = {}) {
  assertRuntime(runtime);
  let session = readSession(id);
  if (!session) session = createSession({ id, runtime, cwd: data.cwd });
  const previousRuntime = session.activeRuntime;
  const previous = session.bindings && session.bindings[runtime];
  session.bindings = { ...(session.bindings || {}) };
  session.bindings[runtime] = bindingMetadata(runtime, data, previous);
  if (data.cwd) session.cwd = path.resolve(data.cwd);
  if (opts.activate !== false) session.activeRuntime = runtime;
  session.updatedAt = now();
  if (opts.reason && previousRuntime !== runtime) {
    session.lineage = Array.isArray(session.lineage) ? session.lineage : [];
    session.lineage.push({ from: previousRuntime, to: runtime, reason: opts.reason, at: session.updatedAt });
  }
  atomicWrite(sessionPath(id), session);
  return session;
}

function ensureSession(opts = {}) {
  const runtime = assertRuntime(opts.runtime || 'claude');
  let session = opts.id ? readSession(opts.id) : null;
  if (!session && opts.nativeSessionId) session = findByNative(runtime, opts.nativeSessionId);
  if (!session) session = createSession({ id: opts.id, runtime, cwd: opts.cwd });
  return bindRuntime(session.id, runtime, opts, { activate: opts.activate, reason: opts.reason });
}

function markInactive(id, runtime, state) {
  const session = readSession(id);
  if (!session || !session.bindings || !session.bindings[runtime]) return session;
  return bindRuntime(id, runtime, { ...session.bindings[runtime], state: state || 'inactive' }, { activate: false });
}

module.exports = {
  VERSION, CL_HOME, SESSIONS_DIR, atomicWrite, sessionPath, readSession, listSessions,
  findByNative, createSession, bindRuntime, ensureSession, markInactive,
};
