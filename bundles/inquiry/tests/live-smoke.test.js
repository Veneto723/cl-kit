'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertCodexInitialCommandScope,
  buildClaudeInitialArgs,
  buildClaudeResumeArgs,
  buildCodexInitialArgs,
  buildCodexResumeArgs,
  codexSessionId,
  codexToolEvents,
  extractVersion,
  parseCli,
  parseJsonLines,
  removeTempRoot,
  runCommand,
  schemaForInitial,
  schemaForResume,
  verifyProbe,
} = require('../scripts/inquiry-live-smoke');

function makeControlFiles() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inquiry-live-smoke-test-'));
  const paths = {
    workspace: path.join(root, 'workspace'),
    initialSchema: path.join(root, 'initial.schema.json'),
    resumeSchema: path.join(root, 'resume.schema.json'),
    initialOutput: path.join(root, 'initial.output.json'),
    resumeOutput: path.join(root, 'resume.output.json'),
  };
  fs.mkdirSync(paths.workspace);
  fs.writeFileSync(paths.initialSchema, JSON.stringify(schemaForInitial('nonce')));
  fs.writeFileSync(paths.resumeSchema, JSON.stringify(schemaForResume()));
  return { root, paths };
}

test('live CLI requires an explicit host version pin', () => {
  assert.throws(() => parseCli(['codex'], {}), /expect-version is required/);
  assert.deepEqual(
    parseCli(['codex'], { INQUIRY_CODEX_VERSION: '0.144.1' }),
    {
      host: 'codex',
      expectedVersion: '0.144.1',
      timeoutMs: 180000,
      maxBudgetUsd: 0.25,
      keep: false,
      help: false,
    },
  );
  assert.equal(parseCli(['claude', '--expect-version', '2.1.207']).expectedVersion, '2.1.207');
  assert.throws(() => parseCli(['other', '--expect-version', '1.0.0']), /host must be/);
});

test('live entry point stops at the credential gate', () => {
  const script = path.join(__dirname, '..', 'scripts', 'inquiry-live-smoke.js');
  const result = spawnSync(
    process.execPath,
    [script, 'codex', '--expect-version', '0.144.1'],
    {
      encoding: 'utf8',
      env: { ...process.env, INQUIRY_LIVE_SMOKE: '' },
      windowsHide: true,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /live execution is gated/);
});

test('host argument builders use bounded modes and exact session IDs', () => {
  const { root, paths } = makeControlFiles();
  try {
    const codexInitial = buildCodexInitialArgs(paths, 'initial prompt');
    const codexResume = buildCodexResumeArgs(paths, 'session-1', 'resume prompt');
    const claudeInitial = buildClaudeInitialArgs(paths, 'session-2', 'initial prompt', 0.25);
    const claudeResume = buildClaudeResumeArgs(paths, 'session-2', 'resume prompt', 0.25);
    const allArgs = [codexInitial, codexResume, claudeInitial, claudeResume].flat();

    assert.deepEqual(
      codexInitial.slice(codexInitial.indexOf('--sandbox'), codexInitial.indexOf('--sandbox') + 2),
      ['--sandbox', 'workspace-write'],
    );
    assert.ok(codexResume.includes('session-1'));
    assert.ok(!codexResume.includes('--last'));
    assert.ok(codexInitial.includes('approval_policy="on-request"'));
    assert.ok(codexResume.includes('approval_policy="on-request"'));
    assert.ok(codexInitial.includes('approvals_reviewer="auto_review"'));
    assert.ok(claudeInitial.includes('--safe-mode'));
    assert.ok(claudeInitial.includes('acceptEdits'));
    assert.ok(claudeResume.includes('dontAsk'));
    assert.equal(claudeResume[claudeResume.indexOf('--tools') + 1], '');
    assert.ok(!allArgs.some((arg) => String(arg).includes('dangerously')));
    assert.ok(!allArgs.includes('--yolo'));
    assert.ok(!allArgs.includes('--ephemeral'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex JSONL parser extracts session identity and tool use', () => {
  const events = parseJsonLines([
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'reasoning' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }),
    '',
  ].join('\n'), 'fixture');
  assert.equal(codexSessionId(events), 'thread-1');
  assert.deepEqual(codexToolEvents(events), ['command_execution']);
  assert.deepEqual(
    assertCodexInitialCommandScope([
      {
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: "Set-Content ./probe.txt 'nonce'",
        },
      },
    ], 'nonce'),
    { distinctCommands: 1, fileChanges: 0 },
  );
  assert.throws(
    () => assertCodexInitialCommandScope([
      {
        type: 'item.completed',
        item: { type: 'command_execution', command: 'curl https://example.com/probe.txt?nonce' },
      },
    ], 'nonce'),
    /network access/,
  );
  assert.throws(() => parseJsonLines('{bad}', 'fixture'), /line 1 is not JSON/);
});

test('version and workspace validators fail closed', () => {
  assert.equal(extractVersion('codex-cli 0.144.1'), '0.144.1');
  assert.equal(extractVersion('2.1.207 (Claude Code)'), '2.1.207');
  assert.throws(() => extractVersion('unknown'), /could not parse/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inquiry-probe-test-'));
  const probe = path.join(root, 'probe.txt');
  try {
    fs.writeFileSync(probe, 'expected\n');
    assert.equal(verifyProbe(probe, 'expected').path, 'probe.txt');
    fs.writeFileSync(probe, 'expected\nextra\n');
    assert.throws(() => verifyProbe(probe, 'expected'), /exactly the expected nonce/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('command runner enforces an external deadline', async () => {
  const result = await runCommand(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 10000)'],
    { timeoutMs: 250 },
  );
  assert.equal(result.timedOut, true);
});

test('temporary cleanup refuses paths outside its generated namespace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inquiry-live-smoke-'));
  fs.writeFileSync(path.join(root, 'marker'), 'test');
  removeTempRoot(root);
  assert.equal(fs.existsSync(root), false);
  assert.throws(() => removeTempRoot(path.join(os.tmpdir(), 'unrelated')), /refusing to remove/);
});
