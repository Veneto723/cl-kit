'use strict';
// build-fixture.js — scaffold the delegation-speed experiment fixture (docs/review/delegation-speed-protocol-2026-07-16.md).
// Two regime repos under E:/arc-ab/{self,deleg}, IDENTICAL seeded code, differing ONLY in the three
// owner duty files: deleg = owners' `owns:` covers their area (induces delegation); self = owners' duty
// is irrelevant (induces self-fix). Three INDEPENDENT bug areas, no shared files, each with a failing
// oracle. Prints the pinned fixture SHA per regime (the harness resets to these each trial).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = 'E:/arc-ab';
const git = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();

// ---- seeded code, identical in both regimes (3 independent single-file bugs) ----------------------
const SRC = {
  'src/retry/backoff.js':
`'use strict';
// Exponential backoff for the retry path. delayFor(attempt) must never exceed \`cap\`.
function delayFor(attempt, base = 100, cap = 2000) {
  return base * Math.pow(2, attempt);   // BUG: the cap is documented but never applied
}
module.exports = { delayFor };
`,
  'src/money/tax.js':
`'use strict';
// Money is integer cents everywhere. withTax must return integer cents.
function withTax(cents, ratePct) {
  return cents + (cents * ratePct) / 100;   // BUG: returns fractional cents, not rounded to an integer
}
module.exports = { withTax };
`,
  'src/parse/csv.js':
`'use strict';
// Parse one CSV line into trimmed fields.
function parseLine(line) {
  return String(line).split(',');   // BUG: fields keep surrounding whitespace; callers expect trimmed
}
module.exports = { parseLine };
`,
};

// ---- oracles: exit 0 on pass, 1 on fail. Fail on the seeded fixture; pass once the bug is fixed. ----
const TEST = {
  'test/retry.test.js':
`'use strict';
const assert = require('assert');
const { delayFor } = require('../src/retry/backoff');
try {
  assert.strictEqual(delayFor(0), 100, 'attempt 0 should be base=100');
  assert.ok(delayFor(10) <= 2000, 'delay must be capped at 2000, got ' + delayFor(10));
  assert.ok(delayFor(20) <= 2000, 'delay must stay capped for large attempts, got ' + delayFor(20));
  console.log('RETRY OK'); process.exit(0);
} catch (e) { console.error('RETRY FAIL: ' + e.message); process.exit(1); }
`,
  'test/money.test.js':
`'use strict';
const assert = require('assert');
const { withTax } = require('../src/money/tax');
try {
  const r = withTax(100, 8.25);
  assert.ok(Number.isInteger(r), 'withTax must return integer cents, got ' + r);
  assert.strictEqual(r, 108, '100c + 8.25% tax should round to 108c, got ' + r);
  console.log('MONEY OK'); process.exit(0);
} catch (e) { console.error('MONEY FAIL: ' + e.message); process.exit(1); }
`,
  'test/parse.test.js':
`'use strict';
const assert = require('assert');
const { parseLine } = require('../src/parse/csv');
try {
  assert.deepStrictEqual(parseLine('a, b ,c'), ['a', 'b', 'c'], 'fields must be trimmed');
  assert.deepStrictEqual(parseLine(' x '), ['x'], 'a single field must be trimmed');
  console.log('PARSE OK'); process.exit(0);
} catch (e) { console.error('PARSE FAIL: ' + e.message); process.exit(1); }
`,
};

const MISC = {
  'package.json': JSON.stringify({ name: 'arc-ab-fixture', version: '1.0.0', private: true,
    description: 'seeded-bug fixture for the delegation-speed experiment' }, null, 2) + '\n',
  '.gitignore': '.arc/peer/\nnode_modules/\n',
  'docs/README.md': '# Fixture docs\n\nUser-facing documentation for the fixture project.\n',
  'worker.md':  // -> .arc/roles/worker.md (identical both regimes) — NEUTRAL: must not claim the bug
`# worker
owns: seeing dispatch's task through to done on this repo
send me: a task from dispatch naming a problem to resolve
not me: work outside what dispatch handed you
`,
};

// Owner duty files: the ONLY thing that differs between regimes. deleg=relevant, self=irrelevant.
const OWNERS = {
  'owner-retry': {
    deleg: 'owns: the retry/backoff logic in src/retry/ — delays, caps, and attempt accounting',
    self:  'owns: the project README and user-facing documentation',
  },
  'owner-money': {
    deleg: 'owns: money handling in src/money/ — cents, tax, and rounding',
    self:  'owns: the CI pipeline and release tooling',
  },
  'owner-parse': {
    deleg: 'owns: CSV and line parsing in src/parse/',
    self:  'owns: the changelog and version history',
  },
};
const ownerDuty = (role, ownsLine) =>
`# ${role}
${ownsLine}
send me: a bug in your area with a repro
not me: work outside your declared area
`;

function writeFile(repo, rel, content) {
  const p = path.join(repo, rel.replace(/\//g, path.sep));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function buildRegime(regime) {
  const repo = path.join(ROOT, regime);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  for (const [rel, c] of Object.entries(SRC)) writeFile(repo, rel, c);
  for (const [rel, c] of Object.entries(TEST)) writeFile(repo, rel, c);
  for (const [rel, c] of Object.entries(MISC)) {
    if (rel === 'worker.md') writeFile(repo, '.arc/roles/worker.md', c);
    else writeFile(repo, rel, c);
  }
  for (const [role, duties] of Object.entries(OWNERS)) {
    writeFile(repo, `.arc/roles/${role}.md`, ownerDuty(role, duties[regime]));
  }
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'harness@arc.local');
  git(repo, 'config', 'user.name', 'arc-harness');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', `fixture: seeded retry/money/parse bugs (${regime} regime)`);
  const sha = git(repo, 'rev-parse', 'HEAD').slice(0, 10);
  return { regime, repo, sha };
}

const results = ['self', 'deleg'].map(buildRegime);
// Verify all three oracles FAIL on the freshly-seeded fixture (else the experiment measures nothing).
for (const { regime, repo } of results) {
  for (const t of ['retry', 'money', 'parse']) {
    let code = 0;
    try { execFileSync('node', [path.join(repo, 'test', `${t}.test.js`)], { encoding: 'utf8' }); }
    catch (e) { code = e.status; }
    process.stdout.write(`[${regime}] oracle ${t}: exit ${code} ${code === 1 ? '(FAILS as seeded — good)' : '!! EXPECTED 1'}\n`);
  }
}
process.stdout.write('\nFIXTURE SHAs (pin these in the harness):\n');
for (const { regime, sha, repo } of results) process.stdout.write(`  ${regime}: ${sha}  (${repo})\n`);
