#!/usr/bin/env node
// arc-mcp: the arc MCP (stdio) server. Lets any Claude Code session manage
// the arc account-switcher configuration conversationally — list/add/remove/
// update accounts, tune defaults/order/features.
//
// Safety: every mutation backs up arc-config.json first (timestamped, kept),
// writes atomically, and validates the result by re-loading it — a write that
// produces an unloadable config is rolled back. Secrets (api keys, DB URLs)
// are never echoed back in responses or errors.
//
// Register: claude mcp add --scope user arc node ~/.claude/scripts/arc-mcp/server.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const require = createRequire(import.meta.url);

// arc-config.js lives at ../src/ in the kit repo and ../ when deployed to
// ~/.claude/scripts/arc-mcp/ — try both.
const C = (() => {
  for (const p of ['../src/arc-config.js', '../arc-config.js']) {
    try { return require(p); } catch {}
  }
  throw new Error('arc-config.js not found next to arc-mcp');
})();
// arc-profile lives alongside arc-config (../src in the repo, ../ when deployed).
const P = (() => {
  for (const p of ['../src/arc-profile.js', '../arc-profile.js']) {
    try { return require(p); } catch {}
  }
  return null; // optional: account_remove degrades to config-only if unavailable
})();

// ---- config file I/O ---------------------------------------------------------

// The RAW config file (user's own JSON, not the normalized view). If it doesn't
// exist yet (legacy install), materialize it from the normalized legacy fallback
// — that IS the migration, and callers are told it happened.
function readRaw() {
  try { return { raw: JSON.parse(fs.readFileSync(C.CONFIG_PATH, 'utf8')), migrated: false }; }
  catch {
    const legacy = C.loadConfig(); // throws only if truly nothing is configured
    const { _legacy, ...raw } = legacy;
    return { raw, migrated: true };
  }
}

// Backup -> atomic write -> validate (loadConfig) -> rollback on failure.
function writeRaw(raw) {
  let backup = null;
  if (fs.existsSync(C.CONFIG_PATH)) {
    backup = `${C.CONFIG_PATH}.bak-${Date.now()}`;
    fs.copyFileSync(C.CONFIG_PATH, backup);
  }
  const tmp = `${C.CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, C.CONFIG_PATH);
  try {
    C.loadConfig(); // must still be loadable
  } catch (e) {
    if (backup) fs.copyFileSync(backup, C.CONFIG_PATH); // roll back
    throw new Error(`config rejected (${e.message}) — previous config restored`);
  }
  return backup;
}

// ---- shaping / scrubbing -------------------------------------------------------

const ID_RX = /^[a-z][a-z0-9_-]*$/i;

function scrub(s) {
  return String(s)
    .replace(/postgres(ql)?:\/\/[^\s"']+/gi, '<db-url>')
    .replace(/sk-[\w-]{8,}/g, '<api-key>');
}

// Public, secret-free view of one account (+ live health).
function shapeAccount(a, cfg) {
  const out = {
    id: a.id, type: a.type, label: a.label, color: a.color,
    isDefault: cfg.defaultAccount === a.id,
  };
  if (a.type === 'api') {
    out.baseUrl = a.baseUrl;
    out.keySource = a.apiKey ? 'inline (hidden)'
      : a.apiKeyEnv ? `env: ${a.apiKeyEnv}`
      : a.apiKeyFrom ? `file: ${a.apiKeyFrom.file}`
      : 'MISSING';
    try { C.resolveApiKey(a); out.keyResolves = true; }
    catch (e) { out.keyResolves = false; out.keyError = scrub(e.message); }
    if (a.modelMap) out.modelMap = a.modelMap;
    if (a.headers) out.headers = Object.keys(a.headers);
  } else {
    out.login = a.credentials
      ? (fs.existsSync(a.credentials) ? `captured (${a.credentials})` : `NOT captured yet — run \`arc capture ${a.id}\``)
      : 'uses the active claude.ai login';
  }
  return out;
}

// Running arc sessions keep their launch-time config for env building, but
// /arc-switch RE-READS the config, so new/edited accounts are switchable at once.
const LIVE_NOTE = 'Effective immediately for /arc-switch and the statusline; sessions already running on an EDITED account pick up env changes on their next /arc-switch or /arc-restart.';

// ---- account tools --------------------------------------------------------------

function toolAccountList() {
  const cfg = C.loadConfig();
  return {
    configPath: C.CONFIG_PATH,
    legacyFallback: !!cfg._legacy,
    defaultAccount: cfg.defaultAccount,
    switchOrder: cfg.switchOrder,
    features: cfg.features,
    accounts: cfg.accounts.map((a) => shapeAccount(a, cfg)),
  };
}

function toolAccountAdd(args) {
  if (!args.id || !ID_RX.test(args.id)) throw new Error('id required: alphanumeric, may contain - _');
  if (args.type !== 'oauth' && args.type !== 'api') throw new Error('type must be "oauth" or "api"');
  const { raw, migrated } = readRaw();
  raw.accounts = raw.accounts || [];
  if (raw.accounts.some((a) => a.id === args.id)) throw new Error(`account "${args.id}" already exists`);

  const acc = { id: args.id, type: args.type };
  if (args.label) acc.label = args.label;
  if (args.color) acc.color = args.color;
  if (args.type === 'api') {
    if (!/^https?:\/\//.test(args.baseUrl || '')) throw new Error('api accounts need a baseUrl (https://...)');
    acc.baseUrl = args.baseUrl;
    if (args.apiKey) acc.apiKey = args.apiKey;
    else if (args.apiKeyEnv) acc.apiKeyEnv = args.apiKeyEnv;
    else if (args.apiKeyFrom && args.apiKeyFrom.file && args.apiKeyFrom.regex) acc.apiKeyFrom = args.apiKeyFrom;
    else throw new Error('api accounts need a key source: apiKey, apiKeyEnv, or apiKeyFrom{file,regex}');
    if (args.modelMap) acc.modelMap = args.modelMap;
    if (args.headers) acc.headers = args.headers;
    if (args.disableConnectors != null) acc.disableConnectors = !!args.disableConnectors;
  } else if (args.credentials) {
    acc.credentials = args.credentials;
  }

  raw.accounts.push(acc);
  if (Array.isArray(raw.switchOrder) && !raw.switchOrder.includes(acc.id)) raw.switchOrder.push(acc.id);
  if (args.makeDefault) raw.defaultAccount = acc.id;
  const backup = writeRaw(raw);

  const cfg = C.loadConfig();
  return {
    added: shapeAccount(cfg.accounts.find((a) => a.id === acc.id), cfg),
    switchOrder: cfg.switchOrder,
    defaultAccount: cfg.defaultAccount,
    migratedLegacyConfig: migrated,
    backup,
    note: (args.type === 'oauth'
      ? `If this is a separate claude.ai subscription, capture its login: the guided way is to run \`arc add-account ${acc.id}\` in a terminal (drives the browser login + auto-captures) — that's easier than adding it here first. Or \`arc capture ${acc.id}\` while already logged in as it. `
      : '') + LIVE_NOTE,
  };
}

function toolAccountRemove(args) {
  const { raw, migrated } = readRaw();
  const accounts = raw.accounts || [];
  const idx = accounts.findIndex((a) => a.id === args.id);
  if (idx === -1) throw new Error(`account "${args.id}" not found`);
  if (accounts.length === 1) throw new Error('refusing to remove the last account — arc needs at least one');

  const removed = accounts[idx];
  accounts.splice(idx, 1);
  const fixes = [];
  if (Array.isArray(raw.switchOrder)) {
    raw.switchOrder = raw.switchOrder.filter((id) => id !== args.id);
    fixes.push('removed from switchOrder');
  }
  if (raw.defaultAccount === args.id) {
    raw.defaultAccount = accounts[0].id;
    fixes.push(`defaultAccount reassigned to "${raw.defaultAccount}"`);
  }
  const backup = writeRaw(raw);

  // Quarantine the per-account profile dir to recoverable trash — same as the
  // /arc-remove-account hook — so a removal never leaves an orphan in arc-profiles.
  let profileTrash = null, profileInUse = false;
  if (P) { try { profileTrash = P.removeProfile(args.id); } catch (e) { profileInUse = true; } }

  const out = {
    removed: args.id,
    fixes,
    remaining: (raw.accounts || []).map((a) => a.id),
    migratedLegacyConfig: migrated,
    backup,
    note: LIVE_NOTE + ' Sessions currently RUNNING on the removed account keep working until they exit or /arc-switch.',
  };
  if (profileTrash) { out.profileTrash = profileTrash; out.note += ` Its profile (login + local data) was MOVED to recoverable trash (${profileTrash}) — move it back to restore.`; }
  if (profileInUse) out.note += ' Its profile dir was left in place (a live session is using it) — remove it after that session exits.';
  if (removed.type === 'oauth' && removed.credentials && fs.existsSync(removed.credentials)) {
    out.credentialsFile = removed.credentials;
    out.note += ` A legacy login file was NOT deleted (${removed.credentials}) — remove it yourself if unwanted.`;
  }
  return out;
}

const UPDATABLE = ['label', 'color', 'baseUrl', 'apiKey', 'apiKeyEnv', 'apiKeyFrom',
  'modelMap', 'headers', 'credentials', 'disableConnectors'];

function toolAccountUpdate(args) {
  const { raw, migrated } = readRaw();
  const acc = (raw.accounts || []).find((a) => a.id === args.id);
  if (!acc) throw new Error(`account "${args.id}" not found`);
  const changed = [];
  for (const k of UPDATABLE) {
    if (!(k in args)) continue;
    if (args[k] === null) { delete acc[k]; changed.push(`${k} cleared`); }
    else { acc[k] = args[k]; changed.push(k); }
  }
  if (!changed.length) throw new Error(`nothing to change — updatable fields: ${UPDATABLE.join(', ')}`);
  if (acc.type === 'api' && !acc.apiKey && !acc.apiKeyEnv && !acc.apiKeyFrom) {
    throw new Error('update would leave this api account with NO key source — set apiKey, apiKeyEnv, or apiKeyFrom');
  }
  const backup = writeRaw(raw);
  const cfg = C.loadConfig();
  return {
    updated: shapeAccount(cfg.accounts.find((a) => a.id === args.id), cfg),
    changed,
    migratedLegacyConfig: migrated,
    backup,
    note: LIVE_NOTE,
  };
}

function toolConfigUpdate(args) {
  const { raw, migrated } = readRaw();
  const changed = [];
  const ids = new Set((raw.accounts || []).map((a) => a.id));
  if (args.defaultAccount != null) {
    if (!ids.has(args.defaultAccount)) throw new Error(`defaultAccount "${args.defaultAccount}" is not a configured account`);
    raw.defaultAccount = args.defaultAccount; changed.push('defaultAccount');
  }
  if (args.switchOrder != null) {
    if (!Array.isArray(args.switchOrder) || !args.switchOrder.length) throw new Error('switchOrder must be a non-empty array of account ids');
    for (const id of args.switchOrder) if (!ids.has(id)) throw new Error(`switchOrder contains unknown account "${id}"`);
    raw.switchOrder = args.switchOrder; changed.push('switchOrder');
  }
  if (args.thresholds != null) { raw.thresholds = { ...(raw.thresholds || {}), ...args.thresholds }; changed.push('thresholds'); }
  if (args.features != null) {
    raw.features = { ...(raw.features || {}), ...args.features }; changed.push('features');
  }
  if (!changed.length) throw new Error('nothing to change — pass defaultAccount, switchOrder, thresholds, and/or features');
  const backup = writeRaw(raw);
  const cfg = C.loadConfig();
  return {
    changed,
    defaultAccount: cfg.defaultAccount,
    switchOrder: cfg.switchOrder,
    thresholds: cfg.thresholds,
    features: cfg.features,
    migratedLegacyConfig: migrated,
    backup,
    note: LIVE_NOTE,
  };
}


// ---- tool registry ---------------------------------------------------------------

const TOOLS = [
  {
    name: 'account_list',
    description: 'List the arc switcher\'s configured accounts (oauth subscriptions and API gateways) with health checks: key resolution, captured logins, default account, switch order, and features. Start here before adding/removing/updating.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'account_add',
    description: 'Add an account to the arc switcher. type "oauth" = a claude.ai subscription login (capture it later with `arc capture <id>` if it is a second subscription). type "api" = an Anthropic-compatible gateway (needs baseUrl + one key source: apiKey inline, apiKeyEnv env-var name, or apiKeyFrom {file, regex with one capture group}). The new account is appended to switchOrder and immediately switchable with /arc-switch.',
    inputSchema: {
      type: 'object',
      required: ['id', 'type'],
      properties: {
        id: { type: 'string', description: 'short id used in /arc-switch <id> (alphanumeric, - _)' },
        type: { type: 'string', enum: ['oauth', 'api'] },
        label: { type: 'string', description: 'statusline label (default: ID uppercased)' },
        color: { type: 'string', description: 'statusline hex color, e.g. #2DD4BF' },
        baseUrl: { type: 'string', description: 'api only: gateway base URL (https://...)' },
        apiKey: { type: 'string', description: 'api only: inline key (stored in arc-config.json)' },
        apiKeyEnv: { type: 'string', description: 'api only: env var holding the key' },
        apiKeyFrom: {
          type: 'object', description: 'api only: extract the key from a file',
          properties: { file: { type: 'string' }, regex: { type: 'string', description: 'ONE capture group = the key' } },
        },
        modelMap: { type: 'object', description: 'api only: alias->model map, e.g. {"opus":"opus","sonnet":"sonnet"}' },
        headers: { type: 'object', description: 'api only: extra request headers' },
        disableConnectors: { type: 'boolean', description: 'api only: silence the claude.ai-connectors warning (default true)' },
        credentials: { type: 'string', description: 'oauth only: path to a captured .credentials.json (normally set by `arc capture`)' },
        makeDefault: { type: 'boolean', description: 'also make this the default launch account' },
      },
    },
  },
  {
    name: 'account_remove',
    description: 'Remove an account from the arc switcher. Refuses to remove the last account. Automatically fixes references (switchOrder, defaultAccount). Never deletes captured credential files. A timestamped config backup is written first.',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: { id: { type: 'string', description: 'account id to remove' } },
    },
  },
  {
    name: 'account_update',
    description: 'Update fields of an existing cl account: label, color, baseUrl, key source (apiKey / apiKeyEnv / apiKeyFrom), modelMap, headers, credentials, disableConnectors. Pass a field as null to clear it. Refuses changes that would leave an api account with no key source.',
    inputSchema: {
      type: 'object', required: ['id'],
      properties: {
        id: { type: 'string' },
        label: { type: ['string', 'null'] }, color: { type: ['string', 'null'] },
        baseUrl: { type: ['string', 'null'] },
        apiKey: { type: ['string', 'null'] }, apiKeyEnv: { type: ['string', 'null'] },
        apiKeyFrom: { type: ['object', 'null'] },
        modelMap: { type: ['object', 'null'] }, headers: { type: ['object', 'null'] },
        credentials: { type: ['string', 'null'] },
        disableConnectors: { type: ['boolean', 'null'] },
      },
    },
  },
  {
    name: 'config_update',
    description: 'Update arc switcher globals: defaultAccount (launch account), switchOrder (the /arc-switch cycle), thresholds (warnSessionPct/warnWeekPct/switchSessionPct/switchWeekPct), features (autoBest on/off).',
    inputSchema: {
      type: 'object',
      properties: {
        defaultAccount: { type: 'string' },
        switchOrder: { type: 'array', items: { type: 'string' } },
        thresholds: { type: 'object' },
        features: { type: 'object' },
      },
    },
  },
];

const HANDLERS = {
  account_list: toolAccountList,
  account_add: toolAccountAdd,
  account_remove: toolAccountRemove,
  account_update: toolAccountUpdate,
  config_update: toolConfigUpdate,
};

// ---- server wiring ---------------------------------------------------------------

const server = new Server(
  { name: 'arc-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const h = HANDLERS[name];
    if (!h) throw new Error(`Unknown tool: ${name}`);
    const result = await h(args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `arc-mcp error: ${scrub(e && e.message ? e.message : e)}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
