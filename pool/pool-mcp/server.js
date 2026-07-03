#!/usr/bin/env node
// pool-mcp: an MCP (stdio) server that exposes Claude Code POOL account status from
// Neon — utilization AND when each account's 5-hour / 7-day window resets — so any
// Claude Code session can ask "show pool accounts" and get live details. Scales as
// accounts are added (it just reads whatever rows exist). Read-only: SELECT only.
//
// Credential: the DB URL comes from cl-config.json poolDb.neonUrl (legacy
// pool-config.json fallback) — never hardcoded, never emitted. Registered via
// `claude mcp add --scope user pool node .../pool-mcp/server.js`.
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
const { Client } = require('pg'); // pg is CommonJS

const resolveNeonUrl = require('../pool-neon-url.js');
function neonUrl() {
  const url = resolveNeonUrl();
  if (!url) throw new Error('no pool DB configured (cl-config poolDb.neonUrl)');
  return url;
}

// Run one read-only query and return rows; always closes the connection.
async function query(sql, params = []) {
  const c = new Client(neonUrl());
  c.on('error', () => {});
  await c.connect();
  try {
    const r = await c.query(sql, params);
    return r.rows;
  } finally {
    await c.end().catch(() => {});
  }
}

// ---- formatting helpers ---------------------------------------------------

function fmtReset(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const ms = d.getTime() - Date.now();
  let rel;
  if (ms <= 0) rel = 'now';
  else if (ms < 3_600_000) rel = `in ${Math.round(ms / 60_000)}m`;
  else {
    const totalMin = Math.round(ms / 60_000); // round first, then split — avoids "2h60m"
    rel = `in ${Math.floor(totalMin / 60)}h${totalMin % 60}m`;
  }
  const local = d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return { at: d.toISOString(), local, in: rel };
}

const pct = (v) => (v == null ? null : Math.round(v));

// Shape a joined pool_accounts + account_usage row into a clean status object.
function shape(r) {
  const name = r.label || r.email || (r.id ? r.id.slice(0, 8) : 'account');
  return {
    account: name,
    email: r.email || null,
    status: r.status,                       // active | cooldown | disabled ...
    reason_code: r.reason_code || null,
    plan_type: r.plan_type || null,
    five_hour: {
      utilization_pct: pct(r.fh),
      resets_at: fmtReset(r.fh_reset),
    },
    seven_day: {
      utilization_pct: pct(r.sd),
      resets_at: fmtReset(r.sd_reset),
    },
    cooldown_until: fmtReset(r.cooldown_until),
    last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    usage_fetched_at: r.fetched_at ? new Date(r.fetched_at).toISOString() : null,
    usage_stale: r.fetched_at ? (Date.now() - new Date(r.fetched_at).getTime() > 15 * 60_000) : true,
    last_error: r.usage_error || r.acct_error || null,
    per_model: r.per_model || null,
  };
}

const BASE_SELECT = `
  SELECT p.id, p.email, p.label, p.status, p.reason_code,
         p.cooldown_until, p.last_used_at, p.last_error AS acct_error,
         au.five_hour_utilization  AS fh, au.five_hour_resets_at  AS fh_reset,
         au.seven_day_utilization  AS sd, au.seven_day_resets_at  AS sd_reset,
         au.plan_type, au.per_model, au.fetched_at, au.last_error AS usage_error
  FROM pool_accounts p
  LEFT JOIN account_usage au ON au.account_id = p.id
  WHERE p.type = 'claude_code'
`;

// ---- tools ----------------------------------------------------------------

const TOOLS = [
  {
    name: 'pool_status',
    description:
      'List all Claude Code pool accounts with live utilization and reset times: ' +
      '5-hour and 7-day utilization %, when each window resets (absolute + relative), ' +
      'status, cooldown, plan type, and staleness of the usage data. Use this to see ' +
      'which pool accounts are available and when a throttled one will reset.',
    inputSchema: {
      type: 'object',
      properties: {
        include_per_model: {
          type: 'boolean',
          description: 'Include the per-model utilization breakdown (verbose). Default false.',
        },
        only_available: {
          type: 'boolean',
          description: 'Only return accounts that are active and not in cooldown. Default false.',
        },
      },
    },
  },
  {
    name: 'pool_next_reset',
    description:
      'Return the pool account whose 5-hour window resets soonest (among accounts ' +
      'currently at/over a utilization threshold), so you know when capacity frees up. ' +
      'Also returns the soonest reset across ALL accounts.',
    inputSchema: {
      type: 'object',
      properties: {
        min_utilization_pct: {
          type: 'number',
          description: 'Only consider accounts whose 5h utilization is >= this. Default 90.',
        },
      },
    },
  },
];

async function handlePoolStatus(args = {}) {
  const rows = await query(BASE_SELECT + ' ORDER BY p.status, p.label, p.email');
  let out = rows.map(shape);
  if (!args.include_per_model) out = out.map(({ per_model, ...rest }) => rest);
  if (args.only_available) {
    out = out.filter((a) => a.status === 'active' && !a.cooldown_until);
  }
  const summary = {
    total: rows.length,
    available: rows.filter((r) => r.status === 'active' && !r.cooldown_until).length,
    with_usage: rows.filter((r) => r.fetched_at).length,
  };
  return { summary, accounts: out };
}

async function handleNextReset(args = {}) {
  const min = args.min_utilization_pct != null ? args.min_utilization_pct : 90;
  const rows = await query(BASE_SELECT);
  const withReset = rows
    .filter((r) => r.fh_reset)
    .map((r) => ({ ...shape(r), _resetMs: new Date(r.fh_reset).getTime(), _fh: r.fh }));
  const soonestAll = [...withReset].sort((a, b) => a._resetMs - b._resetMs)[0] || null;
  const throttled = withReset
    .filter((r) => r._fh != null && r._fh >= min)
    .sort((a, b) => a._resetMs - b._resetMs);
  const strip = (x) => { if (!x) return null; const { _resetMs, _fh, per_model, ...rest } = x; return rest; };
  return {
    threshold_pct: min,
    soonest_reset_over_threshold: strip(throttled[0]),
    soonest_reset_any: strip(soonestAll),
  };
}

// ---- server wiring --------------------------------------------------------

const server = new Server(
  { name: 'pool-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    if (name === 'pool_status') result = await handlePoolStatus(args);
    else if (name === 'pool_next_reset') result = await handleNextReset(args);
    else throw new Error(`Unknown tool: ${name}`);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    // Never leak the connection string in an error.
    const msg = String(e && e.message ? e.message : e).replace(/postgres(ql)?:\/\/[^\s]+/gi, '<neon-url>');
    return { content: [{ type: 'text', text: `pool-mcp error: ${msg}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
