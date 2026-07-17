'use strict';
// FREE pre-flight for the delegation-speed run (protocol: cold-birth spawning control).
// Dry-runs the REAL staffRole from a synthetic, conversation-less session and asserts the built
// launch command contains NO --resume / --fork-session (cold birth) in each regime repo. ZERO
// sessions are started: the spawn is captured by a recorder, trust is stubbed, the prompt is data.
process.env.ARC_RUNTIME_ACCOUNT = 'whale';
process.env.ARC_SPAWN_QUIET = '1';                  // code c10c1f9: minimised spawn — assert the quiet path, still cold, still whale
const path = require('path');
const I = require('E:/arc/src/arc-invite');
const N = require('E:/arc/src/arc-notes');

const SESSION = 'dspeed-preflight';                 // synthetic: no state file, no conversation
const regimes = process.argv.slice(2).length ? process.argv.slice(2) : ['self', 'deleg'];
let failed = 0;

// 1) the synthetic session must have NO conversation to fork
const conv = N.sessionConv(SESSION);
console.log(`sessionConv("${SESSION}") = ${JSON.stringify(conv)}  ${conv ? 'FAIL — would fork!' : 'OK (cold birth guaranteed)'}`);
if (conv) failed++;

// 2) per regime: capture the exact launch command for a worker, assert cold birth
for (const rg of regimes) {
  process.chdir(path.join('E:/arc-ab', rg));
  const rec = [];
  const prompts = [];
  const r = I.staffRole(SESSION, 'worker', {
    spawn: (cmd, args) => { rec.push({ cmd, args }); return { status: 0 }; },
    ensureTrusted: (dir) => ({ ok: true, dir, stubbed: true }),
    hasWt: true,
    writeScript: (text, role) => { prompts.push(text); return `X:/captured-birth-${role}.txt`; },
  });
  const launch = rec.length ? rec[0].args.join(' ') : '(no spawn captured)';
  const resume = /--resume/i.test(launch) || /-Resume\b/i.test(launch) || prompts.some((p) => /--resume/i.test(p));
  const forks = /--fork-session/i.test(launch) || prompts.some((p) => /--fork-session/i.test(p));
  const acct = /-Account['",\s]+whale/i.test(launch);   // arc-birth.ps1 -Account, comma-quoted in the ArgumentList
  const quiet = /-WindowStyle\s+Minimized/i.test(launch);
  const cold = !resume && !r.revived;
  console.log(`\n[${rg}] staffRole ok=${r.ok} revived=${r.revived}${r.ok ? '' : `\n  FAIL message: ${r.message}`}`);
  console.log(`  launch: ${launch.slice(0, 400)}`);
  if (prompts.length) console.log(`  birth prompt (as data, ${prompts[0].length} chars): ${prompts[0].slice(0, 160).replace(/\n/g, ' | ')}`);
  console.log(`  cold(no-resume,no-revive): ${cold}  --fork-session: ${forks}  -Account whale: ${acct}  minimised(quiet): ${quiet}  => ${(cold && !forks && acct && quiet) ? 'COLD QUIET BIRTH ON WHALE OK' : 'FAIL'}`);
  if (!r.ok || !cold || forks || !acct || !quiet) failed++;
}
console.log(`\npre-flight: ${failed ? `FAILED (${failed})` : 'ALL CHECKS PASSED'}`);
process.exit(failed ? 1 : 0);
