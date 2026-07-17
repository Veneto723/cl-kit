'use strict';
// profile.js — decompose a warm-delegated trial's wall-clock into PHASES, from transcript timestamps
// (no re-run needed). Phases: worker BOOT (cold start) + ORIENT->delegate; owner WAKE + UNDERSTAND +
// SOLVE + REPORT/verify. Anchored to t_start (delegate issued) and t_done (oracle pass).
const fs = require('fs');
const os = require('os');
const path = require('path');

function findTr(conv) {
  if (!conv) return null;
  const pr = path.join(os.homedir(), '.claude', 'arc-profiles');
  const bases = [path.join(os.homedir(), '.claude', 'projects')];
  try { for (const p of fs.readdirSync(pr)) bases.push(path.join(pr, p, 'projects')); } catch {}
  for (const b of bases) { let ds = []; try { ds = fs.readdirSync(b); } catch { continue; } for (const d of ds) { const f = path.join(b, d, conv + '.jsonl'); if (fs.existsSync(f)) return f; } }
  return null;
}
// Milestone timestamps (ms) within a transcript, ignoring tool calls before `since` (owner warm-up).
function milestones(fp, since) {
  const M = { t0: null, firstTool: null, srcRead: null, editFirst: null, editLast: null, delegate: null, report: null, last: null };
  if (!fp) return M;
  const sinceMs = since ? (typeof since === 'number' ? since : Date.parse(since)) : 0;
  for (const l of fs.readFileSync(fp, 'utf8').split('\n')) {
    if (!l.trim()) continue; let j; try { j = JSON.parse(l); } catch { continue; }
    const ts = j.timestamp ? Date.parse(j.timestamp) : null;
    if (ts) { if (!M.t0) M.t0 = ts; M.last = ts; }
    for (const x of (Array.isArray(j.message && j.message.content) ? j.message.content : [])) {
      if (!x || x.type !== 'tool_use' || !ts || (sinceMs && ts < sinceMs)) continue;
      if (!M.firstTool) M.firstTool = ts;
      const cmd = (x.input && x.input.command) || '';
      const f = (x.input && (x.input.file_path || x.input.path)) || '';
      if ((x.name === 'Read' && /src[\\/]|test[\\/]/i.test(f)) || /\bnode\b.*test|src[\\/]/i.test(cmd)) { if (!M.srcRead) M.srcRead = ts; }
      if (/Edit|Write/.test(x.name) && /src[\\/]/i.test(f)) { if (!M.editFirst) M.editFirst = ts; M.editLast = ts; }
      if (/\barc(?:\.cmd)?\s+delegate/i.test(cmd) && !M.delegate) M.delegate = ts;
      if (/\barc(?:\.cmd)?\s+notes?\b/i.test(cmd) && M.editLast && ts >= M.editLast && !M.report) M.report = ts;
    }
  }
  return M;
}
const s = (a, b) => (a != null && b != null) ? +((b - a) / 1000).toFixed(1) : null;

const rows = fs.readFileSync(path.join(__dirname, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const warm = rows.filter((r) => r.mode === 'warm' && r.delegated && r.t_done);

console.log('PHASE BREAKDOWN of warm delegated trials (seconds). ow = the owner that made a fix.\n');
const agg = {};
for (const r of warm) {
  const t_start = Date.parse(r.t_start), t_done = Date.parse(r.t_done);
  const wM = milestones(findTr(r.worker_conv));                       // worker: cold-birthed at t_start
  const del = wM.delegate;                                            // when the worker issued arc delegate
  // owner that produced an edit (for N=3, profile each; here pick the ones with ownedEdits>0)
  const owners = (r.owner_windows || []).filter((o) => o.ownedEdits > 0);
  console.log(`--- ${r.mode} N=${r.N} [${r.areas.join(',')}] wall=${r.wall_clock_s}s ---`);
  const wBoot = s(t_start, wM.firstTool), wOrient = s(wM.firstTool, del);
  console.log(`  WORKER  boot(cold-start): ${wBoot}s   orient->delegate: ${wOrient}s   (delegate issued at +${s(t_start, del)}s)`);
  const push = (k, v) => { if (v != null) (agg[k] = agg[k] || []).push(v); };
  push('worker_boot', wBoot); push('worker_orient', wOrient);
  for (const o of owners) {
    const oM = milestones(findTr(o.conv), del || r.t_start);          // anchor at the DELEGATE (excludes owner warm-up + pre-wake)
    const wake = s(del, oM.firstTool), understand = s(oM.firstTool, oM.editFirst), solve = s(oM.editFirst, oM.editLast || oM.editFirst), reportVerify = s(oM.editLast, t_done);
    console.log(`  ow ${o.role.padEnd(11)} wake: ${wake}s   understand: ${understand}s   solve: ${solve}s   report+verify(to oracle): ${reportVerify}s`);
    push('owner_wake', wake); push('owner_understand', understand); push('owner_solve', solve); push('owner_report', reportVerify);
  }
  console.log();
}
const med = (a) => { if (!a || !a.length) return '-'; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
console.log('MEDIAN phase (across warm trials/owners):');
for (const k of ['worker_boot', 'worker_orient', 'owner_wake', 'owner_understand', 'owner_solve', 'owner_report']) {
  console.log(`  ${k.padEnd(18)} ${med(agg[k])}s   (n=${(agg[k] || []).length})`);
}
