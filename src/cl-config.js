// cl-config: shared loader for the cl account-switcher configuration.
// One config file (~/.claude/cl-config.json) defines N accounts; every cl
// component (runner, statusline, hooks, pool tools) resolves accounts from it.
//
// Account types:
//   oauth  — a claude.ai subscription login. Optional `credentials` = path to a
//            captured .credentials.json; cl swaps it in on switch, which is how
//            TWO subscriptions coexist (sessions/transcripts stay unified in one
//            ~/.claude). Absent → whatever login is currently active.
//   api    — any Anthropic-compatible gateway: baseUrl + key (+ optional header
//            and model-alias mapping). The key can be inline (`apiKey`), read
//            from an env var (`apiKeyEnv`), extracted from a file with a regex
//            (`apiKeyFrom: {file, regex}` — first capture group), or stored
//            DPAPI-encrypted in the config itself (`apiKeyEnc` — no plaintext on
//            disk, bound to this Windows user+machine; set via `cl set-key <id>`).
//            Optional `usageUrl` (default `<baseUrl>/v1/usage`, set false to
//            disable): the gateway's own usage endpoint — cl fetches it and shows
//            the account's cost/tokens in the statusline + cl:peek (see gw-usage.js).
//
// Minimal example (single subscription):
//   { "version": 1, "accounts": [ { "id": "main", "label": "MAX", "type": "oauth" } ] }
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CONFIG_PATH = path.join(CLAUDE_DIR, 'cl-config.json');
const CACHE_DIR = path.join(CLAUDE_DIR, 'cache');
const CRED_PATH = path.join(CLAUDE_DIR, '.credentials.json');
const SCRIPTS_DIR = path.join(CLAUDE_DIR, 'scripts');
const LEGACY_POOL_CONFIG = path.join(SCRIPTS_DIR, 'pool-config.json');

const DEFAULT_THRESHOLDS = { warnSessionPct: 85, warnWeekPct: 90, switchSessionPct: 92, switchWeekPct: 95 };

// Map legacy account ids (pre-universal cl state files) onto configured ids so
// an in-flight session survives a migration mid-conversation.
const LEGACY_IDS = { apihub: 'pool' };

function expandHome(p) {
  if (!p) return p;
  return p.replace(/^~(?=$|[\\/])/, os.homedir());
}

function loadRaw() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return null; }
}

// Fall back to the classic personal layout (pool-config.json + MAX) so a
// pre-migration install keeps working before cl-config.json exists.
function legacyConfig() {
  let pc = null;
  try { pc = JSON.parse(fs.readFileSync(LEGACY_POOL_CONFIG, 'utf8')); } catch {}
  const accounts = [{ id: 'max', label: 'MAX', color: '#D97757', type: 'oauth' }];
  if (pc && pc.apihubBaseUrl) {
    accounts.push({
      id: 'pool', label: 'POOL', color: '#2DD4BF', type: 'api',
      baseUrl: `https://${pc.apihubBaseUrl}`,
      apiKeyFrom: { file: 'E:\\setup-claude-apihub.ps1', regex: 'apiKey\\s*=\\s*[“"](sk-whale-[^”"]+)[”"]' },
      headers: { 'x-title': 'claude' },
      modelMap: { haiku: 'haiku', sonnet: 'sonnet', opus: 'opus', fable: 'fable' },
      disableConnectors: true,
    });
  }
  return {
    version: 1,
    defaultAccount: 'max',
    accounts,
    thresholds: (pc && pc.thresholds) || {},
    features: {},
    poolDb: pc && pc.neonUrl ? { neonUrl: pc.neonUrl } : null,
    _legacy: true,
  };
}

function normalize(cfg) {
  const out = { ...cfg };
  out.accounts = (Array.isArray(cfg.accounts) ? cfg.accounts : [])
    .filter((a) => a && a.id && (a.type === 'oauth' || a.type === 'api'))
    .map((a) => ({
      color: a.type === 'api' ? '#2DD4BF' : '#D97757',
      label: String(a.id).toUpperCase(),
      disableConnectors: a.type === 'api',
      ...a,
      credentials: a.credentials ? expandHome(a.credentials) : null,
    }));
  if (!out.accounts.length) throw new Error('cl-config: no valid accounts configured — run `cl setup`');
  const ids = new Set(out.accounts.map((a) => a.id));
  out.defaultAccount = ids.has(cfg.defaultAccount) ? cfg.defaultAccount : out.accounts[0].id;
  out.thresholds = { ...DEFAULT_THRESHOLDS, ...(cfg.thresholds || {}) };
  out.features = { ...(cfg.features || {}) };
  out.poolDb = cfg.poolDb && cfg.poolDb.neonUrl ? cfg.poolDb : null;
  out.switchOrder = (Array.isArray(cfg.switchOrder) ? cfg.switchOrder : out.accounts.map((a) => a.id))
    .filter((id) => ids.has(id));
  if (!out.switchOrder.length) out.switchOrder = out.accounts.map((a) => a.id);
  return out;
}

function loadConfig() {
  const raw = loadRaw();
  return normalize(raw || legacyConfig());
}

// Resolve a configured account id, tolerating legacy ids from old state files.
function findAccount(cfg, id) {
  if (!id) return null;
  return cfg.accounts.find((a) => a.id === id)
    || cfg.accounts.find((a) => a.id === LEGACY_IDS[id])
    || null;
}

// The account /switch moves to: an explicit valid target, else the next id in
// switchOrder after `currentId` (cyclic).
function nextAccount(cfg, currentId, targetId) {
  const target = findAccount(cfg, targetId);
  if (target && target.id !== currentId) return target;
  const order = cfg.switchOrder;
  const cur = findAccount(cfg, currentId);
  const i = order.indexOf(cur ? cur.id : order[0]);
  const next = order[(i + 1) % order.length];
  return next === (cur && cur.id) ? null : findAccount(cfg, next); // null = nowhere to go
}

// DPAPI (Windows Data Protection API, CurrentUser scope) via PowerShell: encrypt
// / decrypt a secret at rest, bound to this Windows user+machine. Lets the API
// key live encrypted INSIDE cl-config.json (`apiKeyEnc`) — no plaintext key file,
// and a copied config is useless on any other machine/user. Secret is passed via
// env (not argv) so it never appears in a command line. Windows-only (cl is).
function runPowerShell(script, extraEnv) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...extraEnv }, encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
}
function dpapiEncrypt(plaintext) {
  const out = runPowerShell(
    "Add-Type -AssemblyName System.Security;" +
    "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect(" +
    "[Text.Encoding]::UTF8.GetBytes($env:CL_PT),$null,'CurrentUser'))",
    { CL_PT: plaintext });
  return out.trim();
}
function dpapiDecrypt(b64) {
  const out = runPowerShell(
    "Add-Type -AssemblyName System.Security;" +
    "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect(" +
    "[Convert]::FromBase64String($env:CL_ENC),$null,'CurrentUser'))",
    { CL_ENC: b64 });
  return out.replace(/\r?\n$/, ''); // strip only PowerShell's trailing newline
}

// The API key for an `api` account. Order: inline > env var > DPAPI blob > file.
// Throws with a clear message if unresolvable — callers surface it.
function resolveApiKey(acc) {
  if (acc.apiKey) return acc.apiKey;
  if (acc.apiKeyEnv && process.env[acc.apiKeyEnv]) return process.env[acc.apiKeyEnv];
  if (acc.apiKeyEnc) {
    let k; try { k = dpapiDecrypt(acc.apiKeyEnc); } catch (e) {
      throw new Error(`account "${acc.id}": apiKeyEnc DPAPI decrypt failed — the blob is bound to the Windows user+machine that created it. Re-run \`cl set-key ${acc.id}\` on THIS machine. (${String(e.message).split('\n')[0]})`);
    }
    if (k) return k;
    throw new Error(`account "${acc.id}": apiKeyEnc decrypted to empty — re-run \`cl set-key ${acc.id}\`.`);
  }
  if (acc.apiKeyFrom && acc.apiKeyFrom.file) {
    const file = expandHome(acc.apiKeyFrom.file);
    const text = fs.readFileSync(file, 'utf8'); // throws if missing
    const m = text.match(new RegExp(acc.apiKeyFrom.regex));
    if (m && m[1]) return m[1];
    throw new Error(`apiKeyFrom regex matched nothing in ${file}`);
  }
  throw new Error(`account "${acc.id}": no apiKey / apiKeyEnv / apiKeyFrom configured`);
}

// The claude executable. Config override > ~/.local/bin/claude.exe > PATH.
function claudeBin(cfg) {
  if (cfg && cfg.claudeBin) return expandHome(cfg.claudeBin);
  const local = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
  if (fs.existsSync(local)) return local;
  return 'claude'; // rely on PATH
}

// Env for spawning claude under `account`. api → gateway vars; oauth → make
// sure no inherited gateway vars leak in.
const GATEWAY_VARS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
];
function accountEnv(acc, base) {
  const env = { ...(base || process.env) };
  for (const k of GATEWAY_VARS) delete env[k];
  if (acc.type === 'api') {
    const key = resolveApiKey(acc); // throws if unresolvable
    env.ANTHROPIC_BASE_URL = acc.baseUrl;
    env.ANTHROPIC_API_KEY = key;
    env.ANTHROPIC_AUTH_TOKEN = key;
    if (acc.headers && Object.keys(acc.headers).length) {
      env.ANTHROPIC_CUSTOM_HEADERS = Object.entries(acc.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
    }
    for (const [alias, model] of Object.entries(acc.modelMap || {})) {
      env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`] = model;
    }
  }
  return env;
}

module.exports = {
  CLAUDE_DIR, CONFIG_PATH, CACHE_DIR, CRED_PATH, SCRIPTS_DIR,
  loadConfig, findAccount, nextAccount, resolveApiKey, claudeBin, accountEnv, expandHome,
  dpapiEncrypt, dpapiDecrypt,
};
