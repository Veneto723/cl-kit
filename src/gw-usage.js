// gw-usage: fetch + summarize a gateway (api) account's OWN usage endpoint, e.g.
// MATE's GET <baseUrl>/v1/usage. Provider-specific gateways expose usage in their
// own shapes; we pull the common, useful figures and degrade gracefully.
// Used by usage-monitor.js (statusline, does the fetch) and cl-switch-core.js
// (cl:peek, reads the cached result). Windows/Node 18+ (global fetch).
'use strict';

// The usage URL for an api account: explicit `usageUrl`, else <baseUrl>/v1/usage.
// `usageUrl: false` (or '') disables it. Non-api accounts → null.
function usageUrlFor(acc) {
  if (!acc || acc.type !== 'api' || !acc.baseUrl) return null;
  if (acc.usageUrl === false || acc.usageUrl === '') return null;
  return acc.usageUrl || acc.baseUrl.replace(/\/+$/, '') + '/v1/usage';
}

// GET the usage endpoint with the account's key. Returns the parsed JSON, or null
// on any failure (unreachable / non-200 / non-JSON) — never throws.
async function fetchGatewayUsage(acc, key) {
  const url = usageUrlFor(acc);
  if (!url || !key) return null;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j && typeof j === 'object' ? j : null;
  } catch { return null; }
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

// Pull the useful figures out of a gateway usage payload, tolerant of shape.
// Understands MATE's { usage:{today,tpm,rpm}, daily_usage[], subscription:{*_limit_usd,
// *_usage_usd}, model_stats[], remaining, mode, unit, planName }.
function summarizeGatewayUsage(data) {
  if (!data || typeof data !== 'object') return null;
  const today = (data.usage && data.usage.today)
    || (Array.isArray(data.daily_usage) && data.daily_usage[data.daily_usage.length - 1])
    || (data.usage && data.usage.total) || null;
  const sub = data.subscription || {};
  const dLim = num(sub.daily_limit_usd), wLim = num(sub.weekly_limit_usd), mLim = num(sub.monthly_limit_usd);
  const unlimited = data.remaining === -1 || data.mode === 'unrestricted'
    || (dLim === 0 && wLim === 0 && mLim === 0 && (dLim != null));
  const models = (Array.isArray(data.model_stats) ? data.model_stats : [])
    .filter((m) => m && typeof m === 'object')                          // skip null/non-object elements
    .map((m) => ({ model: m.model != null ? String(m.model) : '?', tokens: num(m.total_tokens), cost: num(m.cost != null ? m.cost : m.actual_cost) }))
    .filter((m) => m.tokens != null).sort((a, b) => b.tokens - a.tokens);
  return {
    cost: num(today && (today.cost != null ? today.cost : today.actual_cost)),
    tokens: num(today && today.total_tokens),
    requests: num(today && today.requests),
    unit: data.unit || 'USD',
    unlimited, dailyLimit: dLim, weeklyLimit: wLim, monthlyLimit: mLim,
    dailyUsage: num(sub.daily_usage_usd), weeklyUsage: num(sub.weekly_usage_usd), monthlyUsage: num(sub.monthly_usage_usd),
    tpm: num(data.usage && data.usage.tpm), rpm: num(data.usage && data.usage.rpm),
    plan: data.planName || null, models,
  };
}

function fmtTokens(t) {
  if (t == null) return '?';
  if (t >= 1e9) return (t / 1e9).toFixed(1) + 'B';
  if (t >= 1e6) return (t / 1e6).toFixed(1) + 'M';
  if (t >= 1e3) return Math.round(t / 1e3) + 'k';
  return String(t);
}
function fmtCost(c, unit) {
  if (c == null) return null;
  const n = c < 1000 ? c.toFixed(2) : String(Math.round(c));
  return (unit === 'USD' || unit == null) ? '$' + n : n + ' ' + unit;
}
// The tightest active cap as "used/limit period", or 'unlimited' / 'no cap set'.
function capLabel(s) {
  if (s.unlimited) return 'unlimited';
  for (const [name, lim, used] of [['daily', s.dailyLimit, s.dailyUsage], ['weekly', s.weeklyLimit, s.weeklyUsage], ['monthly', s.monthlyLimit, s.monthlyUsage]]) {
    if (lim) return `${fmtCost(used != null ? used : s.cost, s.unit)}/${fmtCost(lim, s.unit)} ${name}`;
  }
  return 'no cap';
}

// One-line summary: "$103.60 today · 62.9M tok · unlimited".
function gatewayUsageLine(data, opts = {}) {
  const s = summarizeGatewayUsage(data);
  if (!s) return null;
  const parts = [];
  const cost = fmtCost(s.cost, s.unit); if (cost) parts.push(`${cost} today`);
  if (s.tokens != null) parts.push(`${fmtTokens(s.tokens)} tok`);
  if (opts.withReq && s.requests != null) parts.push(`${s.requests} req`);
  parts.push(capLabel(s));
  return parts.filter(Boolean).join(' · ');
}

module.exports = { usageUrlFor, fetchGatewayUsage, summarizeGatewayUsage, gatewayUsageLine, fmtTokens, fmtCost };
