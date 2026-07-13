const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { adapters } = require('../conformance/adapters');
const { assertConformantTrace } = require('../conformance/v1/reducer');

const root = path.resolve(__dirname, '..');
const workflowSource = fs.readFileSync(path.join(root, 'workflows', 'round.js'), 'utf8')
  .replace(/^export const meta/m, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runRound(findingFactory, verdictFactory, args = {}) {
  const angles = [
    { lens: 'one', question: 'q1' },
    { lens: 'two', question: 'q2' },
    { lens: 'three', question: 'q3' },
  ];

  const agent = async (_prompt, options) => {
    if (options.label === 'diverge') return { angles };
    if (options.label.startsWith('investigate:')) return findingFactory(options.label);
    if (options.label.startsWith('skeptic:')) return verdictFactory(options.label);
    throw new Error(`unexpected agent label: ${options.label}`);
  };
  const pipeline = async (items, investigate, verify) => Promise.all(
    items.map(async (item) => verify(await investigate(item), item)),
  );
  const execute = new AsyncFunction('args', 'agent', 'pipeline', 'phase', 'log', workflowSource);
  return execute({
    brief: 'Test brief',
    direction: 'Test direction',
    limiter: 'Test limiter',
    ...args,
  }, agent, pipeline, () => {}, () => {});
}

const keepVerdict = () => ({
  grounded: true,
  onBrief: true,
  novel: false,
  redundant: false,
  significance: 2,
  verdict: 'keep',
  note: 'supported',
});

test('collector rejects empty and malformed citations despite a keep verdict', async () => {
  const result = await runRound(() => ({
    claim: 'Unsupported claim',
    evidence: ['A model says this is evidence'],
    sources: ['not-a-url'],
    limitations: ['Unknown'],
    incremental: true,
  }), keepVerdict);

  assert.equal(result.clean, true);
  assert.equal(result.dry, true);
  assert.equal(result.roundFindings.length, 0);
  assert.equal(result.judged, 3);
  assert.deepEqual(assertConformantTrace(result.trace), {
    attempted: 3,
    judged: 3,
    failed: 0,
    clean: true,
    dry: true,
    roundFailed: false,
    kept: [],
    unverified: [],
    escalations: [],
  });
});

test('collector preserves auditable fields and clamps significance', async () => {
  const result = await runRound(() => ({
    claim: 'Supported claim',
    evidence: ['The official documentation states the behavior'],
    sources: [' https://example.com/docs ', 'https://example.com/docs'],
    limitations: ['Applies only to the documented version'],
    incremental: true,
  }), keepVerdict, { escalateBar: 9 });

  assert.equal(result.dry, false);
  assert.equal(result.roundFindings.length, 3);
  assert.equal(result.roundFindings[0].significance, 1);
  assert.deepEqual(result.roundFindings[0].sources, ['https://example.com/docs']);
  assert.deepEqual(result.roundFindings[0].evidence, ['The official documentation states the behavior']);
  assert.deepEqual(result.roundFindings[0].limitations, ['Applies only to the documented version']);
  assert.match(result.roundFindings[0].verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(result.roundFindings[0].evidenceAudit.status, 'missing');
  assert.equal(result.escalate.length, 3);
  assert.equal(adapters.get('claude').toTrace(result), result.trace);
  assert.deepEqual(assertConformantTrace(result.trace).escalations, ['angle-1', 'angle-2', 'angle-3']);
});

test('workflow trace preserves partial investigator and skeptic failures', async () => {
  const finding = (label) => label.endsWith('three') ? null : ({
    claim: `Supported claim from ${label}`,
    evidence: ['The source supports the claim'],
    sources: ['https://example.com/docs'],
    limitations: ['Fixture only'],
    incremental: true,
  });
  const verdict = (label) => label.endsWith('two') ? null : keepVerdict();
  const result = await runRound(finding, verdict, { roundId: 'partial-round' });

  assert.equal(result.clean, false);
  assert.equal(result.roundFailed, false);
  assert.equal(result.roundFindings.length, 1);
  assert.equal(result.unverified.length, 1);
  assert.deepEqual(assertConformantTrace(result.trace), {
    attempted: 3,
    judged: 1,
    failed: 2,
    clean: false,
    dry: false,
    roundFailed: false,
    kept: ['angle-1'],
    unverified: ['angle-2'],
    escalations: ['angle-1'],
  });
});

test('workflow trace distinguishes abort and total worker failure from dry rounds', async () => {
  const aborted = await runRound(() => null, () => null, { brief: '', roundId: 'no-brief' });
  assert.equal(aborted.error, 'no-brief');
  assert.deepEqual(assertConformantTrace(aborted.trace), {
    attempted: 0,
    judged: 0,
    failed: 1,
    clean: false,
    dry: false,
    roundFailed: true,
    kept: [],
    unverified: [],
    escalations: [],
  });

  const failed = await runRound(() => null, () => null, { roundId: 'all-workers-failed' });
  const projection = assertConformantTrace(failed.trace);
  assert.equal(failed.roundFailed, true);
  assert.equal(failed.dry, false);
  assert.equal(projection.roundFailed, true);
  assert.equal(projection.dry, false);
  assert.equal(projection.failed, 3);
});

test('claim-level evidence runs in audit mode without breaking legacy admission', async () => {
  const finding = () => ({
    claim: 'A material claim with localized support',
    evidence: ['The official source supports the material claim'],
    sources: ['https://example.com/primary'],
    limitations: ['Audit fixture only'],
    incremental: true,
    claimEvidence: [{
      claimId: 'c1',
      claim: 'The material claim is true.',
      citations: [{
        sourceUrl: 'https://example.com/primary',
        passage: 'A short exact passage supporting the material claim.',
        fetchedAt: '2026-07-13T00:00:00Z',
      }],
    }],
  });
  const entailed = () => ({
    ...keepVerdict(),
    claimChecks: [{ claimId: 'c1', relation: 'entailment', rationale: 'The passage supports c1.' }],
  });
  const passed = await runRound(finding, entailed);
  assert.equal(passed.roundFindings.length, 3);
  assert.deepEqual(passed.roundFindings[0].evidenceAudit, {
    mode: 'audit',
    status: 'pass',
    claims: 1,
    entailment: 1,
    neutral: 0,
    contradiction: 0,
    unchecked: 0,
    reasons: [],
  });
  assert.equal(passed.roundFindings[0].claimEvidence[0].citations[0].passage,
    'A short exact passage supporting the material claim.');

  const neutral = () => ({
    ...keepVerdict(),
    claimChecks: [{ claimId: 'c1', relation: 'neutral', rationale: 'The passage is related but insufficient.' }],
  });
  const review = await runRound(finding, neutral);
  assert.equal(review.roundFindings.length, 3);
  assert.equal(review.roundFindings[0].evidenceAudit.status, 'review');
  assert.equal(review.roundFindings[0].evidenceAudit.neutral, 1);
  assert.deepEqual(review.roundFindings[0].evidenceAudit.reasons, ['c1:neutral']);
});
