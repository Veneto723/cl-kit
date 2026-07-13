// arc-codex-account: aliases and isolated CODEX_HOME directories.
// Authentication stays entirely inside each native Codex home.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const O = require('./arc-orchestrator');

const REGISTRY_PATH = path.join(O.ARC_HOME, 'accounts.json');
const ID_RX = /^[a-z][a-z0-9_-]{0,31}$/i;

function defaultHome() { return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex')); }
function fallbackRegistry() {
  return { version: 1, codex: { defaultAccount: 'default', accounts: [
    { id: 'default', label: 'default', home: defaultHome() },
  ] } };
}

function normalize(raw) {
  const base = fallbackRegistry();
  const root = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  const src = raw && raw.codex;
  if (!src || !Array.isArray(src.accounts)) return { ...root, version: root.version || 1, codex: base.codex };
  const seen = new Set();
  const accounts = src.accounts.filter((a) => a && ID_RX.test(String(a.id || '')) && a.home)
    .map((a) => ({ id: String(a.id), label: String(a.label || a.id), home: path.resolve(String(a.home)) }))
    .filter((a) => { const key = a.id.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  if (!accounts.length) return { ...root, version: root.version || 1, codex: base.codex };
  const defaultAccount = accounts.some((a) => a.id === src.defaultAccount) ? src.defaultAccount : accounts[0].id;
  return { ...root, version: root.version || 1, codex: { ...src, defaultAccount, accounts } };
}

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) return fallbackRegistry();
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('registry root must be a JSON object');
    return normalize(raw);
  }
  catch (e) { throw new Error(`cannot read Codex account registry ${REGISTRY_PATH}: ${e.message}`); }
}
function saveRegistry(registry) {
  const normalized = normalize(registry);
  O.atomicWrite(REGISTRY_PATH, normalized);
  return normalized;
}
function accounts() { return loadRegistry().codex.accounts; }
function findAccount(id) {
  const c = loadRegistry().codex;
  const wanted = id || c.defaultAccount;
  return c.accounts.find((a) => a.id === wanted) || null;
}
function addAccount(id, opts = {}) {
  if (!ID_RX.test(String(id || ''))) throw new Error('account id must start with a letter and use only letters, digits, dash, or underscore');
  const registry = loadRegistry();
  if (registry.codex.accounts.some((a) => a.id.toLowerCase() === id.toLowerCase())) throw new Error(`Codex account "${id}" already exists`);
  const home = path.resolve(opts.home || path.join(O.ARC_HOME, 'accounts', 'codex', id));
  fs.mkdirSync(home, { recursive: true });
  registry.codex.accounts.push({ id, label: opts.label || id, home });
  if (opts.makeDefault) registry.codex.defaultAccount = id;
  saveRegistry(registry);
  return findAccount(id);
}
function removeAccount(id) {
  if (id === 'default') throw new Error('the implicit default Codex account cannot be removed');
  const registry = loadRegistry();
  const before = registry.codex.accounts.length;
  registry.codex.accounts = registry.codex.accounts.filter((a) => a.id !== id);
  if (registry.codex.accounts.length === before) return false;
  if (registry.codex.defaultAccount === id) registry.codex.defaultAccount = registry.codex.accounts[0].id;
  saveRegistry(registry);
  return true;
}
function buildEnv(account, sessionId, logicalSessionId) {
  return {
    ...process.env,
    CODEX_HOME: account.home,
    ARC_SESSION: sessionId,
    ARC_LOGICAL_SESSION: logicalSessionId,
    ARC_RUNTIME: 'codex',
    ARC_RUNTIME_ACCOUNT: account.id,
  };
}

module.exports = { REGISTRY_PATH, loadRegistry, saveRegistry, accounts, findAccount, addAccount, removeAccount, buildEnv };
