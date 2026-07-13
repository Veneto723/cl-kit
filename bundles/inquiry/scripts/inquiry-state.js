#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = 'state.json';
const LOCK_FILE = 'RUNNING.lock';
const DEFAULT_TTL_SECONDS = 30 * 60;

function fail(message) {
  console.error(`inquiry-state: ${message}`);
  process.exit(1);
}

function nowIso() {
  return new Date().toISOString();
}

function resolveRunDir(raw) {
  if (!raw) fail('a run directory is required');
  return path.resolve(raw);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} is unreadable or invalid JSON at ${file}: ${error.message}`);
  }
}

function atomicWriteJson(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}

function newState() {
  const timestamp = nowIso();
  return {
    version: 1,
    runId: crypto.randomUUID(),
    status: 'ready',
    roundsCompleted: 0,
    roundAttempts: 0,
    cleanDryStreak: 0,
    escalationsTotal: 0,
    activeOwner: null,
    lastRound: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function validateState(state, file) {
  const numeric = ['roundsCompleted', 'roundAttempts', 'cleanDryStreak', 'escalationsTotal'];
  if (!state || state.version !== 1 || typeof state.runId !== 'string') {
    fail(`unsupported state file at ${file}`);
  }
  for (const key of numeric) {
    if (!Number.isInteger(state[key]) || state[key] < 0) {
      fail(`state.${key} must be a non-negative integer at ${file}`);
    }
  }
  return state;
}

function ensureState(runDir) {
  fs.mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, STATE_FILE);
  if (!fs.existsSync(file)) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(newState(), null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return validateState(readJson(file, 'state file'), file);
}

function loadState(runDir) {
  const file = path.join(runDir, STATE_FILE);
  if (!fs.existsSync(file)) fail(`state file does not exist at ${file}; run init first`);
  return validateState(readJson(file, 'state file'), file);
}

function readLock(runDir) {
  const file = path.join(runDir, LOCK_FILE);
  if (!fs.existsSync(file)) return null;
  return readJson(file, 'run lock');
}

function isExpired(lock) {
  const expires = Date.parse(lock.expiresAt);
  return !Number.isFinite(expires) || expires <= Date.now();
}

function writeLockExclusive(file, lock) {
  const handle = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(handle, `${JSON.stringify(lock, null, 2)}\n`);
  } finally {
    fs.closeSync(handle);
  }
}

function lease(owner, ttlSeconds) {
  const acquiredAt = nowIso();
  return {
    version: 1,
    owner,
    acquiredAt,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    ttlSeconds,
  };
}

function acquire(runDir, requestedOwner, requestedTtl) {
  const state = ensureState(runDir);
  const owner = requestedOwner || `controller-${crypto.randomUUID()}`;
  const ttlSeconds = requestedTtl == null ? DEFAULT_TTL_SECONDS : Number(requestedTtl);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 24 * 60 * 60) {
    fail('lease TTL must be an integer between 60 and 86400 seconds');
  }

  const lockFile = path.join(runDir, LOCK_FILE);
  let acquired = false;
  for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
    const existing = readLock(runDir);
    if (existing && existing.owner === owner) {
      const renewed = lease(owner, ttlSeconds);
      renewed.acquiredAt = existing.acquiredAt || renewed.acquiredAt;
      atomicWriteJson(lockFile, renewed);
      acquired = true;
      break;
    }
    if (existing && !isExpired(existing)) {
      fail(`run is already owned by ${existing.owner} until ${existing.expiresAt}`);
    }
    if (existing) {
      const staleFile = `${lockFile}.stale.${crypto.randomUUID()}`;
      try {
        fs.renameSync(lockFile, staleFile);
        fs.rmSync(staleFile, { force: true });
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM') continue;
        throw error;
      }
    }
    try {
      writeLockExclusive(lockFile, lease(owner, ttlSeconds));
      acquired = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  if (!acquired) fail('another controller acquired the run concurrently');

  state.status = 'active';
  state.activeOwner = owner;
  state.updatedAt = nowIso();
  atomicWriteJson(path.join(runDir, STATE_FILE), state);
  return { state, lock: readLock(runDir) };
}

function requireOwner(runDir, owner) {
  if (!owner) fail('the lease owner returned by acquire is required');
  const lock = readLock(runDir);
  if (!lock) fail('the run has no active lease');
  if (lock.owner !== owner) fail(`the run is owned by ${lock.owner}, not ${owner}`);
  if (isExpired(lock)) fail(`the lease for ${owner} expired at ${lock.expiresAt}`);
  return lock;
}

function parseBoolean(value, name) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  fail(`${name} must be true or false`);
}

function parseEscalations(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) fail('escalations must be a non-negative integer');
  return parsed;
}

function record(runDir, owner, cleanValue, dryValue, failedValue, escalationValue) {
  const lock = requireOwner(runDir, owner);
  const clean = parseBoolean(cleanValue, 'clean');
  const dry = parseBoolean(dryValue, 'dry');
  const roundFailed = parseBoolean(failedValue, 'roundFailed');
  const escalations = parseEscalations(escalationValue);
  if (roundFailed && dry) fail('a failed round cannot be dry');

  const stateFile = path.join(runDir, STATE_FILE);
  const state = validateState(readJson(stateFile, 'state file'), stateFile);
  state.roundAttempts += 1;
  state.escalationsTotal += escalations;
  if (!roundFailed) {
    state.roundsCompleted += 1;
    state.cleanDryStreak = clean && dry ? state.cleanDryStreak + 1 : 0;
  }
  state.lastRound = {
    attempt: state.roundAttempts,
    completedRound: roundFailed ? null : state.roundsCompleted,
    clean,
    dry,
    roundFailed,
    escalations,
    recordedAt: nowIso(),
  };
  state.updatedAt = nowIso();
  atomicWriteJson(stateFile, state);

  const renewed = lease(owner, lock.ttlSeconds || DEFAULT_TTL_SECONDS);
  renewed.acquiredAt = lock.acquiredAt || renewed.acquiredAt;
  atomicWriteJson(path.join(runDir, LOCK_FILE), renewed);
  return { state, lock: renewed };
}

function release(runDir, owner, status) {
  requireOwner(runDir, owner);
  const nextStatus = status || 'paused';
  if (!['ready', 'paused', 'complete'].includes(nextStatus)) {
    fail('release status must be ready, paused, or complete');
  }

  const stateFile = path.join(runDir, STATE_FILE);
  const state = validateState(readJson(stateFile, 'state file'), stateFile);
  state.status = nextStatus;
  state.activeOwner = null;
  state.updatedAt = nowIso();
  atomicWriteJson(stateFile, state);
  fs.rmSync(path.join(runDir, LOCK_FILE), { force: true });
  return { state, lock: null };
}

function status(runDir) {
  return { state: loadState(runDir), lock: readLock(runDir) };
}

function usage() {
  console.log([
    'Usage:',
    '  inquiry-state.js init <run-dir>',
    '  inquiry-state.js acquire <run-dir> [owner] [ttl-seconds]',
    '  inquiry-state.js record <run-dir> <owner> <clean> <dry> <roundFailed> <escalations>',
    '  inquiry-state.js release <run-dir> <owner> [ready|paused|complete]',
    '  inquiry-state.js status <run-dir>',
  ].join('\n'));
}

const [command, rawRunDir, ...rest] = process.argv.slice(2);
if (!command || command === '--help' || command === '-h') {
  usage();
  process.exit(command ? 0 : 1);
}

const runDir = resolveRunDir(rawRunDir);
let result;
switch (command) {
  case 'init':
    result = { state: ensureState(runDir), lock: readLock(runDir) };
    break;
  case 'acquire':
    result = acquire(runDir, rest[0], rest[1]);
    break;
  case 'record':
    result = record(runDir, rest[0], rest[1], rest[2], rest[3], rest[4]);
    break;
  case 'release':
    result = release(runDir, rest[0], rest[1]);
    break;
  case 'status':
    result = status(runDir);
    break;
  default:
    fail(`unknown command: ${command}`);
}

console.log(JSON.stringify(result, null, 2));
