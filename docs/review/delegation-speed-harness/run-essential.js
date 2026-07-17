'use strict';
// Driver for the ESSENTIAL delegation-speed run (docs/review/delegation-speed-protocol-2026-07-16.md,
// human-scoped ~30 sessions). Sequences 15 caller trials across 3 modes, manages the dispatch keepers,
// polls each trial's oracle to a per-N cap, scores + kills between trials, logs progress. Runs in the
// background; watch run-essential.log. Trials are SEQUENTIAL (one worker/owner-set live at a time) —
// the parallelism under test is WITHIN a warm N=3 trial (3 owners), never across trials.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const HARN = 'E:/arc/docs/review/delegation-speed-harness';
const HJS = path.join(HARN, 'harness.js');
const LOG = path.join(HARN, 'run-essential.log');
const sleep = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} };
const log = (m) => { const s = `[${new Date().toISOString().slice(11, 19)}] ${m}`; process.stdout.write(s + '\n'); try { fs.appendFileSync(LOG, s + '\n'); } catch {} };
const run = (...a) => { try { return execFileSync('node', [HJS, ...a], { encoding: 'utf8' }); } catch (e) { return (e.stdout || '') + (e.stderr || '') + (e.status === 3 ? '\nVOID(exit3)' : ''); } };

function keeper(rg) {
  const k = spawn('node', ['-e', 'setInterval(()=>{},1e9)'], { detached: true, stdio: 'ignore' });
  k.unref();
  run('setup', rg, String(k.pid));
  log(`keeper ${rg} = pid ${k.pid}`);
  return k.pid;
}

// The plan, with RANDOMISED arm order per round (code #76(a)) so machine load hits arms symmetrically
// instead of always landing self-first. Pre-registered seed => reproducible order.
// Phase A = N=1 x {retry,money,parse} x {self,warm,cold} (the warm-vs-cold ●/○ contrast).
// Phase B = N=3 x {self,warm} x 3 reps (the parallelism crux).
const SEED = 0x5eed16;   // PRE-REGISTERED 2026-07-16
function mulberry32(s) { return function () { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rnd = mulberry32(SEED);
const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const PLAN = [];
let _t = 0;
for (const bug of ['retry', 'money', 'parse']) { _t++; for (const mode of shuffle(['self', 'warm', 'cold'])) PLAN.push({ mode, a: bug, t: _t }); }
for (let rep = 0; rep < 3; rep++) { _t++; for (const mode of shuffle(['self', 'warm'])) PLAN.push({ mode, a: 'retry,money,parse', t: _t }); }
const CAP = (n) => (n >= 3 ? 15 : 6) * 60 * 1000;

log(`=== ESSENTIAL RUN START — ${PLAN.length} caller trials ===`);
const kp = { self: keeper('self'), deleg: keeper('deleg') };
let voids = 0;

for (const tr of PLAN) {
  const rg = tr.mode === 'self' ? 'self' : 'deleg';
  const N = tr.a.split(',').length;
  log(`--- ${tr.mode.toUpperCase()} N=${N} [${tr.a}] trial ${tr.t} ---`);
  const startOut = tr.mode === 'warm' ? run('warm', rg, tr.a, String(tr.t)) : run('start', rg, tr.a, String(tr.t));
  if (/VOID|NEVER FILLED/.test(startOut)) {
    voids++; log(`  VOID at spawn: ${startOut.split('\n').filter((l) => /VOID|FILLED/.test(l)).join(' ').slice(0, 160)}`);
    run('kill', rg); sleep(3000); continue;
  }
  const end = Date.now() + CAP(N);
  let done = false;
  while (Date.now() < end) {
    sleep(15000);
    const p = run('poll', rg);
    const last = p.trim().split('\n').pop();
    if (/ALL PASS/.test(p)) { done = true; log(`  ${last}`); break; }
  }
  if (!done) { voids++; log(`  CAP HIT (${CAP(N) / 60000}min) — no all-pass; scoring as censored`); }
  const sc = run('score', rg, String(tr.t));
  const m = sc.match(/"wall_clock_s":\s*([\d.]+|null)[\s\S]*?"delegated":\s*(true|false)[\s\S]*?"owner_edits":\s*(\d+)/);
  const lm = sc.match(/"claude":\s*\{[^}]*?"max":\s*(\d+)[\s\S]*?"cpu":\s*\{[^}]*?"mean":\s*([\d.]+|null)/);
  if (m) log(`  SCORED wall=${m[1]}s delegated=${m[2]} owner_edits=${m[3]}${lm ? ` load[claude_max=${lm[1]} cpu_mean=${lm[2]}]` : ''}`);
  run('kill', rg);
  sleep(4000);
}

try { process.kill(kp.self); } catch {}
try { process.kill(kp.deleg); } catch {}
log(`=== RUN COMPLETE — ${PLAN.length} trials, ${voids} void/censored ===`);
