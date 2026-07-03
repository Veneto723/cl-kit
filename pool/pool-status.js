#!/usr/bin/env node
// pool-status: print a formatted table of Claude Code POOL account status
// (5h + 7d utilization and reset times). Used by the /pool slash command.
//
// FAST PATH: the statusline (usage-monitor.js) already refreshes this exact data
// into usage-monitor-cache.json every ~5 min, so we read that first (instant, no
// network). Only if the cache is missing/too old do we fall back to a direct Neon
// query (~2-3s, SSL handshake to the pooler). Read-only. neonUrl from config.
process.env.NODE_NO_WARNINGS = '1';
process.removeAllListeners('warning');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CACHE_PATH = path.join(os.homedir(), '.claude', 'cache', 'usage-monitor-cache.json');
const CACHE_MAX_AGE_MS = 6 * 60_000; // accept the statusline cache up to 6 min old

const neonUrl = require('./pool-neon-url')();
if (!neonUrl) { console.log('POOL: no pool DB configured (cl-config poolDb.neonUrl).'); process.exit(0); }

// --- fast path: reuse the statusline's cached pool rows -----------------------
function fromCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!c.pool || !Array.isArray(c.pool.rows) || !c.pool.rows.length) return null;
    if (typeof c.pool.fetchedAt !== 'number' || Date.now() - c.pool.fetchedAt > CACHE_MAX_AGE_MS) return null;
    return c.pool.rows; // rows carry email,label,status,fh,fh_reset,sd,sd_reset,fetched_at
  } catch { return null; }
}

const cached = fromCache();
if (cached) { render(cached); process.exit(0); }

// --- slow path: query Neon directly ------------------------------------------
let Client;
try { ({ Client } = require(path.join(os.homedir(), '.claude', 'scripts', 'pool-mcp', 'node_modules', 'pg'))); }
catch { try { ({ Client } = require('pg')); } catch (e) { console.log('POOL: pg module not found'); process.exit(0); } }

function relReset(ts) {
  if (!ts) return '—';
  const ms = new Date(ts).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return min + 'm';
  return Math.floor(min / 60) + 'h' + (min % 60) + 'm';
}
function clockReset(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}
// function declarations (hoisted) so the fast cache path can call render() early
function p(v) { return v == null ? '?' : Math.round(v) + '%'; }
function bar(v) {
  if (v == null) return '····';
  const n = Math.max(0, Math.min(4, Math.round((v / 100) * 4)));
  return '█'.repeat(n) + '·'.repeat(4 - n);
}

const SQL = `
  SELECT p.email, p.label, p.status, p.cooldown_until,
         au.five_hour_utilization AS fh, au.five_hour_resets_at AS fh_reset,
         au.seven_day_utilization AS sd, au.seven_day_resets_at AS sd_reset,
         au.fetched_at
  FROM pool_accounts p
  LEFT JOIN account_usage au ON au.account_id = p.id
  WHERE p.type = 'claude_code'
  ORDER BY au.five_hour_utilization DESC NULLS LAST, p.label`;

const c = new Client(neonUrl);
c.on('error', () => {});
c.connect()
  .then(() => c.query(SQL))
  .then((r) => {
    c.end().catch(() => {});
    render(r.rows);
  })
  .catch((e) => {
    const msg = String(e && e.message ? e.message : e).replace(/postgres(ql)?:\/\/[^\s]+/gi, '<neon-url>');
    console.log('POOL: query failed — ' + msg);
  });

// --- shared renderer (used by both cache and DB paths) -----------------------
function render(rows) {
  if (!rows || !rows.length) { console.log('POOL: no claude_code accounts found.'); return; }
  // sort by 5h utilization desc (busiest first), nulls last
  rows = rows.slice().sort((a, b) => (b.fh == null ? -1 : b.fh) - (a.fh == null ? -1 : a.fh));
  const lines = [];
  lines.push('POOL STATUS  (' + rows.length + ' account' + (rows.length > 1 ? 's' : '') + ')');
  lines.push('');
  lines.push(pad('ACCOUNT', 18) + pad('5H', 6) + pad('', 6) + pad('RESETS', 16) + pad('7D', 6));
  for (const x of rows) {
    const name = (x.label || x.email || '?').split('@')[0].slice(0, 16);
    const cooldown = x.cooldown_until && new Date(x.cooldown_until) > new Date();
    const flag = x.status && x.status !== 'active' ? ` [${x.status}]`
      : cooldown ? ' [cooldown ' + relReset(x.cooldown_until) + ']' : '';
    const resets = x.fh_reset ? `${clockReset(x.fh_reset)} (${relReset(x.fh_reset)})` : '—';
    lines.push(pad(name, 18) + pad(p(x.fh), 6) + pad(bar(x.fh), 6) + pad(resets, 16) + pad(p(x.sd), 6) + flag);
  }
  const newest = rows.map((x) => x.fetched_at).filter(Boolean).map((t) => new Date(t).getTime()).sort((a, b) => b - a)[0];
  if (newest) {
    const age = Math.round((Date.now() - newest) / 60_000);
    lines.push('');
    lines.push('usage data ' + (age <= 1 ? 'just now' : age + 'm old') + (age > 15 ? ' (stale)' : ''));
  }
  console.log(lines.join('\n'));
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
