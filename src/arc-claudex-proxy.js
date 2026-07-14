#!/usr/bin/env node
// arc-claudex-proxy — the "claudex" translator: lets Claude Code (which speaks ONLY the
// Anthropic Messages API, POST /v1/messages) drive a GPT model that a gateway serves on the
// OpenAI Chat Completions API (POST /v1/chat/completions). arc auto-spawns ONE of these on
// 127.0.0.1 per codex account (see arc-claudex.js) and points that account's Claude Code at it.
//
// Why this exists: the gateway routes BY ENDPOINT — /v1/messages -> Claude, /v1/responses or
// /v1/chat/completions -> GPT — and refuses a GPT model on /v1/messages (403). Claude Code can
// only call /v1/messages. So something local has to translate. This is that something.
//
//   CLAUDEX_KEY=<sk-…> CLAUDEX_UPSTREAM=https://host CLAUDEX_MODEL=gpt-5.6-sol \
//     node arc-claudex-proxy.js [port]
//
// The key is read from the environment and NEVER logged, and the server binds 127.0.0.1 only,
// so the gateway credential is never exposed off-box.
'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ---- pure translation (exported for tests) -----------------------------------------
// EVERY message `content` MUST come out a STRING. The gateway internally re-maps Chat
// Completions -> Responses (whose items are stricter), and a non-string content there yields
// "Invalid type for 'input': expected a string, but got an object". So coerce relentlessly.
function asText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => (x && x.type === 'text' ? x.text : x && x.type === 'image' ? '[image omitted]' : typeof x === 'string' ? x : asText(x))).join('\n');
  if (typeof v === 'object') return v.text != null ? String(v.text) : JSON.stringify(v);
  return String(v);
}

function toOpenAI(a, fallbackModel) {
  const messages = [];
  if (a.system) { const s = asText(a.system); if (s) messages.push({ role: 'system', content: s }); }
  for (const m of a.messages || []) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    const texts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const blk of m.content || []) {
      if (!blk || typeof blk !== 'object') { texts.push(asText(blk)); continue; }
      if (blk.type === 'text') texts.push(asText(blk.text));
      else if (blk.type === 'tool_use') toolCalls.push({ id: blk.id, type: 'function', function: { name: blk.name, arguments: JSON.stringify(blk.input || {}) } });
      else if (blk.type === 'tool_result') toolResults.push({ role: 'tool', tool_call_id: blk.tool_use_id, content: asText(blk.content) || '(no output)' });
      else if (blk.type === 'image') texts.push('[image omitted]');
      else texts.push(asText(blk));
    }
    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: texts.join('\n') };   // always a string, even if ''
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
    } else {
      if (texts.length) messages.push({ role: 'user', content: texts.join('\n') });
      for (const tr of toolResults) messages.push(tr);
    }
  }
  const o = { model: /^gpt/i.test(a.model || '') ? a.model : (fallbackModel || 'gpt-5.6-sol'), messages, stream: !!a.stream };
  if (a.max_tokens) o.max_tokens = a.max_tokens;
  if (typeof a.temperature === 'number') o.temperature = a.temperature;
  if (a.tools && a.tools.length) o.tools = a.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
  if (a.tool_choice) { const tc = a.tool_choice; o.tool_choice = tc.type === 'any' ? 'required' : tc.type === 'tool' ? { type: 'function', function: { name: tc.name } } : 'auto'; }
  return o;
}

// ---- server factory (exported so a test can drive it without a real upstream) ------
const RETRYABLE = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|network|timeout/i;

function createServer(opts) {
  const o = opts || {};
  const KEY = o.key || process.env.CLAUDEX_KEY || '';
  const UP = new URL(o.upstream || process.env.CLAUDEX_UPSTREAM || 'https://9cd9473d.es26harvard.com');
  const MODEL = o.model || process.env.CLAUDEX_MODEL || 'gpt-5.6-sol';
  const TRIES = o.tries || 3;
  const request = o.request || ((body) => openUpstream(UP, KEY, body));   // injectable for tests
  const log = o.log || ((...a) => process.stderr.write('[claudex] ' + a.join(' ') + '\n'));

  const sse = (res, ev, obj) => res.write(`event: ${ev}\ndata: ${JSON.stringify(obj)}\n\n`);
  const genId = (p) => p + Math.random().toString(36).slice(2, 14);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // retry only BEFORE any bytes stream back (connect error / 5xx). Once a 200 body flows we commit.
  async function upstreamRetry(body) {
    let last;
    for (let i = 0; i < TRIES; i++) {
      try {
        const res = await request(body);
        if (res.statusCode >= 500 && i < TRIES - 1) { res.resume && res.resume(); await sleep(400 * (i + 1)); continue; }
        return res;
      } catch (e) {
        last = e;
        if (RETRYABLE.test(String(e && e.message)) && i < TRIES - 1) { log(`retry ${i + 1}: ${e.message}`); await sleep(400 * (i + 1)); continue; }
        throw e;
      }
    }
    throw last || new Error('upstream failed');
  }

  async function streamOut(areq, res, up) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    sse(res, 'message_start', { type: 'message_start', message: { id: genId('msg_'), type: 'message', role: 'assistant', model: areq.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    let idx = -1, openText = false, mode = null, stop = 'end_turn', buf = '';
    const toolAt = {};
    const closeBlock = () => { if (idx >= 0 && (openText || mode === 'tool')) { sse(res, 'content_block_stop', { type: 'content_block_stop', index: idx }); openText = false; mode = null; } };
    const openTextBlock = () => { if (!openText) { if (mode === 'tool') closeBlock(); idx++; sse(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } }); openText = true; mode = 'text'; } };
    const onData = (chunk) => {
      buf += chunk; const parts = buf.split('\n\n'); buf = parts.pop();
      for (const p of parts) {
        const line = p.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let j; try { j = JSON.parse(payload); } catch { continue; }
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        const fin = j.choices && j.choices[0] && j.choices[0].finish_reason;
        if (d && typeof d.content === 'string' && d.content.length) { openTextBlock(); sse(res, 'content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: d.content } }); }
        if (d && Array.isArray(d.tool_calls)) for (const tc of d.tool_calls) {
          const oi = tc.index != null ? tc.index : 0;
          if (!(oi in toolAt)) { if (openText) closeBlock(); idx++; toolAt[oi] = idx; mode = 'tool'; sse(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tc.id || genId('toolu_'), name: (tc.function && tc.function.name) || 'tool', input: {} } }); }
          const args = tc.function && tc.function.arguments;
          if (args) sse(res, 'content_block_delta', { type: 'content_block_delta', index: toolAt[oi], delta: { type: 'input_json_delta', partial_json: args } });
        }
        if (fin) stop = fin === 'tool_calls' ? 'tool_use' : fin === 'length' ? 'max_tokens' : 'end_turn';
      }
    };
    await new Promise((resolve) => { up.on('data', onData); up.on('end', resolve); up.on('error', () => resolve()); });
    closeBlock();
    sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 0 } });
    sse(res, 'message_stop', { type: 'message_stop' });
    res.end();
  }

  async function jsonOut(areq, res, up) {
    let raw = ''; await new Promise((r) => { up.on('data', (c) => (raw += c)); up.on('end', r); });
    let j; try { j = JSON.parse(raw); } catch { res.writeHead(502); return res.end('{"error":"bad upstream"}'); }
    const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
    const content = [];
    if (m.content) content.push({ type: 'text', text: m.content });
    for (const tc of m.tool_calls || []) { let input = {}; try { input = JSON.parse(tc.function.arguments); } catch {} content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input }); }
    const fin = j.choices && j.choices[0] && j.choices[0].finish_reason;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: genId('msg_'), type: 'message', role: 'assistant', model: areq.model, content: content.length ? content : [{ type: 'text', text: '' }], stop_reason: fin === 'tool_calls' ? 'tool_use' : fin === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null, usage: { input_tokens: (j.usage && j.usage.prompt_tokens) || 0, output_tokens: (j.usage && j.usage.completion_tokens) || 0 } }));
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: MODEL, type: 'model', display_name: MODEL }] })); }
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/healthz'))) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, model: MODEL, upstream: UP.host })); }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ input_tokens: Math.ceil(body.length / 4) })); }
      let areq; try { areq = JSON.parse(body || '{}'); } catch { res.writeHead(400); return res.end('{"error":"bad json"}'); }
      try {
        const oreq = toOpenAI(areq, MODEL);
        log(`-> ${oreq.model} msgs=${oreq.messages.length} tools=${(oreq.tools || []).length} stream=${!!oreq.stream}`);
        const up = await upstreamRetry(oreq);
        if (up.statusCode >= 400) { let raw = ''; up.on('data', (c) => (raw += c)); up.on('end', () => { log(`upstream ${up.statusCode}: ${raw.slice(0, 200)}`); res.writeHead(up.statusCode, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: raw.slice(0, 300) } })); }); return; }
        return areq.stream ? streamOut(areq, res, up) : jsonOut(areq, res, up);
      } catch (e) { log('ERR ' + e.message); res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { message: String(e.message) } })); }
    });
  });
  return { server, MODEL, upstreamHost: UP.host, hasKey: !!KEY };
}

// Open a real streaming request to the gateway. Resolves on 'response'; rejects on connect
// error. Honors the upstream URL scheme (https for a real gateway; http lets a local test or
// an on-box gateway work) instead of assuming https.
function openUpstream(UP, KEY, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const mod = UP.protocol === 'http:' ? http : https;
    const port = UP.port || (UP.protocol === 'http:' ? 80 : 443);
    const req = mod.request({ host: UP.hostname, port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), authorization: `Bearer ${KEY}` }, timeout: 120000 }, (res) => resolve(res));
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('socket hang up (timeout)')); });
    req.write(data); req.end();
  });
}

module.exports = { toOpenAI, asText, createServer };

if (require.main === module) {
  const c = createServer({});
  if (!c.hasKey) { process.stderr.write('[claudex] FATAL: no CLAUDEX_KEY\n'); process.exit(1); }
  const port = parseInt(process.argv[2] || process.env.CLAUDEX_PORT || '8790', 10);
  // Never let a bind failure (EADDRINUSE) become an unhandled 'error' throw — exit cleanly so
  // the supervisor (arc-claudex) sees "did not come up" and reclaims the port, not a crash dump.
  c.server.on('error', (e) => { process.stderr.write(`[claudex] listen error on ${port}: ${e.message}\n`); process.exit(1); });
  c.server.listen(port, '127.0.0.1', () => process.stderr.write(`[claudex] listening http://127.0.0.1:${port} -> ${c.upstreamHost} model=${c.MODEL}\n`));
}
