// Async half of the claudex tests, run as a SUBPROCESS by test/run.js (which is synchronous
// CommonJS and can't host top-level await). Prints one `ok\t<name>` / `notok\t<name>` line per
// assertion; run.js parses these back into its own ok() tally.
'use strict';
const path = require('path');
const http = require('http');
const { Readable } = require('stream');
const SRC = path.join(__dirname, '..', 'src');
const P = require(path.join(SRC, 'arc-claudex-proxy.js'));
const CX = require(path.join(SRC, 'arc-claudex.js'));

const results = [];
const ok = (name, cond) => results.push(`${cond ? 'ok' : 'notok'}\t${name}`);

(async () => {
  // ---- streaming translation through an INJECTED fake upstream (no network) ----------
  const fakeUpstream = () => {
    const r = new Readable({ read() {} });
    r.statusCode = 200;
    process.nextTick(() => {
      r.push('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
      r.push('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
      r.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc1","function":{"name":"get_x","arguments":"{\\"q\\":1}"}}]}}]}\n\n');
      r.push('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      r.push('data: [DONE]\n\n'); r.push(null);
    });
    return Promise.resolve(r);
  };
  const c = P.createServer({ key: 'x', model: 'gpt-5.6-sol', request: fakeUpstream, log: () => {} });
  const evs = await new Promise((resolve) => {
    c.server.listen(0, '127.0.0.1', () => {
      const port = c.server.address().port;
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        let b = ''; res.on('data', (x) => (b += x)); res.on('end', () => { c.server.close(); resolve(b); });
      });
      req.end(JSON.stringify({ model: 'gpt-5.6-sol', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    });
  });
  ok('streaming: OpenAI text deltas surface as an Anthropic text block',
    /event: content_block_start[\s\S]*"type":"text"/.test(evs) && /"text_delta","text":"Hel"/.test(evs) && /"text":"lo"/.test(evs));
  ok('streaming: an OpenAI tool_call surfaces as an Anthropic tool_use block + input_json_delta',
    /"type":"tool_use","id":"tc1","name":"get_x"/.test(evs) && /input_json_delta/.test(evs) && /partial_json/.test(evs));
  ok('streaming: finish_reason tool_calls -> stop_reason tool_use, then message_stop',
    /"stop_reason":"tool_use"/.test(evs) && /event: message_stop/.test(evs));

  // ---- sidecar lifecycle with injected fakes (no real spawn / no network) ------------
  const cxAcc = { id: 'gpt', type: 'api', baseUrl: 'https://gw.example.com', model: 'gpt-5.6-sol', proxy: { port: 8791 } };
  let spawned = 0;
  const reuse = await CX.ensureProxy(cxAcc, () => 'sk-x', { health: async () => ({ ok: true }), spawn: () => { spawned++; return { pid: 1, unref() {} }; } });
  ok('ensureProxy REUSES a healthy translator (no double-spawn)', reuse.reused === true && spawned === 0);

  let calls = 0;
  const fresh = await CX.ensureProxy(cxAcc, () => 'sk-x', { health: async () => (++calls >= 2 ? { ok: true } : null), portInUse: async () => false, spawn: () => { spawned++; return { pid: 4242, unref() {} }; }, waitMs: 3000 });
  ok('ensureProxy SPAWNS when none is up, waits for health, returns its pid',
    fresh.reused === false && fresh.pid === 4242 && spawned === 1);

  let capturedEnv = null, capturedArgs = null, hc = 0;
  await CX.ensureProxy({ ...cxAcc, proxy: { port: 8799 } }, () => 'sk-secret', { health: async () => (hc++ >= 1 ? { ok: true } : null), portInUse: async () => false, spawn: (bin, args, o) => { capturedArgs = args; capturedEnv = o.env; return { pid: 9, unref() {} }; }, waitMs: 3000 }).catch(() => {});
  ok('ensureProxy passes the key via ENV (CLAUDEX_KEY), never in argv',
    !!capturedEnv && capturedEnv.CLAUDEX_KEY === 'sk-secret' && !JSON.stringify(capturedArgs || []).includes('sk-secret'));

  // a foreign process holding the port (portInUse true, no stale PID record we can kill) -> clear error, no crash.
  let threw = null;
  await CX.ensureProxy({ ...cxAcc, proxy: { port: 8798 } }, () => 'sk-x', { health: async () => null, portInUse: async () => true, spawn: () => { spawned++; return { pid: 1, unref() {} }; }, waitMs: 500 }).catch((e) => { threw = e.message; });
  ok('ensureProxy fails CLEARLY when the port is held by a foreign process (never spawns onto it)',
    !!threw && /held by another process/.test(threw));

  process.stdout.write(results.join('\n') + '\n');
  process.exit(0);
})().catch((e) => { process.stdout.write(results.join('\n') + `\nnotok\tclaudex-async threw: ${e.message}\n`); process.exit(0); });
