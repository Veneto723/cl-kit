'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { adapters, createAdapterRegistry } = require('../conformance/adapters');
const { assertTrace } = require('../conformance/v1/contract');
const { assertConformantTrace, reduceTrace } = require('../conformance/v1/reducer');

const fixturePath = path.join(__dirname, '..', 'conformance', 'fixtures', 'v1', 'partial-one-kept.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

test('both adapters produce the canonical partial-round trace', () => {
  assert.equal(fixture.provenance.runtimeCertified, false);
  assert.match(fixture.provenance.claudeRaw, /synthetic/);
  assert.match(fixture.provenance.codexRaw, /synthetic/);
  assert.deepEqual(adapters.names(), ['claude', 'codex']);

  const claudeTrace = adapters.get('claude').toTrace(fixture.claudeRaw);
  const codexTrace = adapters.get('codex').toTrace(fixture.codexRaw);
  assert.deepEqual(claudeTrace, fixture.expectedTrace);
  assert.deepEqual(codexTrace, fixture.expectedTrace);
  assert.deepEqual(reduceTrace(claudeTrace), fixture.expectedProjection);
  assert.deepEqual(reduceTrace(codexTrace), fixture.expectedProjection);
});

test('adapter registry fails closed for duplicates and unknown hosts', () => {
  const stub = { toTrace() { return []; } };
  assert.throws(
    () => createAdapterRegistry([['host', stub], ['host', stub]]),
    /duplicate adapter host/,
  );
  const registry = createAdapterRegistry([['host', stub]]);
  assert.throws(() => registry.get('missing'), /unknown adapter missing/);
});

test('trace contract rejects unknown versions and incomplete angle lifecycles', () => {
  const wrongVersion = clone(fixture.expectedTrace);
  wrongVersion[2].contractVersion = 'inquiry.trace/v2';
  assert.throws(() => assertTrace(wrongVersion), /unsupported contractVersion/);

  const stringSignificance = clone(fixture.expectedTrace);
  stringSignificance[3].data.verdict.significance = '0.9';
  assert.throws(() => assertTrace(stringSignificance), /significance must be a finite number/);

  const missingVerification = clone(fixture.expectedTrace);
  missingVerification.splice(3, 1);
  missingVerification.forEach((event, index) => { event.seq = index; });
  assert.throws(() => assertTrace(missingVerification), /no verification terminal/);

  const lateAbort = clone(fixture.expectedTrace.slice(0, -1));
  lateAbort.push({
    contractVersion: 'inquiry.trace/v1',
    roundId: 'fixture-partial-one-kept',
    seq: lateAbort.length,
    type: 'round.aborted',
    data: { reason: 'late-abort' },
  });
  assert.throws(() => assertTrace(lateAbort), /after completed divergence is unsupported/);
});

test('reducer rejects declared summaries that disagree with semantic events', () => {
  const wrongCount = clone(fixture.expectedTrace);
  wrongCount.at(-1).data.judged = 3;
  assert.throws(() => assertConformantTrace(wrongCount), /judged does not match/);

  const malformedSupport = clone(fixture.expectedTrace);
  malformedSupport[2].data.finding.sources = ['not-a-url'];
  assert.throws(() => assertConformantTrace(malformedSupport), /does not match reduced trace/);
});

test('Codex adapter rejects incomplete, duplicate, and unknown outcomes', () => {
  const missingVerification = clone(fixture.codexRaw);
  delete missingVerification.outcomes[0].verification;
  assert.throws(
    () => adapters.get('codex').toTrace(missingVerification),
    /verification outcome missing for angle-1/,
  );

  const duplicate = clone(fixture.codexRaw);
  duplicate.outcomes.push(clone(duplicate.outcomes[0]));
  assert.throws(() => adapters.get('codex').toTrace(duplicate), /duplicate Codex outcome/);

  const unknown = clone(fixture.codexRaw);
  unknown.outcomes.push({
    angleId: 'angle-unknown',
    investigation: { status: 'failed', kind: 'unknown', reason: 'fixture' },
  });
  assert.throws(() => adapters.get('codex').toTrace(unknown), /references unknown angle/);
});

test('validation CLI certifies a serialized Codex round record', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inquiry-conformance-'));
  const recordPath = path.join(tempDir, 'codex-round.json');
  const scriptPath = path.join(__dirname, '..', 'scripts', 'inquiry-conformance.js');
  try {
    fs.writeFileSync(recordPath, `${JSON.stringify(fixture.codexRaw)}\n`);
    const output = JSON.parse(execFileSync(process.execPath, [scriptPath, 'codex', recordPath], {
      encoding: 'utf8',
    }));
    assert.equal(output.contractVersion, 'inquiry.trace/v1');
    assert.equal(output.roundId, 'fixture-partial-one-kept');
    assert.deepEqual(output.projection, fixture.expectedProjection);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
