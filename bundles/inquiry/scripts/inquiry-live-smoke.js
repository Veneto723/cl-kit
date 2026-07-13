#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROTOCOL = 'inquiry.live-smoke/v1';
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_MAX_BUDGET_USD = 0.25;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const CODEX_APPROVAL_POLICY = 'approval_policy="on-request"';
const TOOL_EVENT_TYPES = new Set([
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'web_search',
]);

function usage(stream = process.stderr) {
  stream.write([
    'Usage: inquiry-live-smoke.js <claude|codex> --expect-version <version> [options]',
    '',
    'Options:',
    '  --timeout-ms <milliseconds>     Per-command deadline (default: 180000)',
    '  --max-budget-usd <amount>       Claude budget per turn (default: 0.25)',
    '  --keep                          Keep the temporary workspace (session state is still purged)',
    '  -h, --help                      Show this help',
    '',
    'Live execution also requires INQUIRY_LIVE_SMOKE=1.',
    'The expected version may instead be set with INQUIRY_CLAUDE_VERSION or',
    'INQUIRY_CODEX_VERSION. Binary overrides are INQUIRY_CLAUDE_BIN and',
    'INQUIRY_CODEX_BIN.',
    '',
  ].join('\n'));
}

function parsePositiveNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive number`);
  }
  return parsed;
}

function parseCli(argv, env = process.env) {
  const options = {
    host: null,
    expectedVersion: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxBudgetUsd: DEFAULT_MAX_BUDGET_USD,
    keep: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--keep') {
      options.keep = true;
    } else if (arg === '--expect-version') {
      options.expectedVersion = argv[++index];
      if (!options.expectedVersion) throw new Error('--expect-version requires a value');
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = parsePositiveNumber(argv[++index], '--timeout-ms');
    } else if (arg === '--max-budget-usd') {
      options.maxBudgetUsd = parsePositiveNumber(argv[++index], '--max-budget-usd');
    } else if (!arg.startsWith('-') && !options.host) {
      options.host = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (options.help) return options;
  if (!['claude', 'codex'].includes(options.host)) {
    throw new Error('host must be claude or codex');
  }
  options.expectedVersion = options.expectedVersion
    || env[`INQUIRY_${options.host.toUpperCase()}_VERSION`]
    || null;
  if (!options.expectedVersion) {
    throw new Error('--expect-version is required for a live, reproducible check');
  }
  return options;
}

function executableFor(host, env = process.env) {
  return env[`INQUIRY_${host.toUpperCase()}_BIN`] || host;
}

function resolveWindowsCommand(command, env = process.env) {
  const hasSeparator = command.includes('\\') || command.includes('/');
  const candidates = [];
  const extensions = path.extname(command)
    ? ['']
    : String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((item) => item.toLowerCase());
  const directories = hasSeparator
    ? ['']
    : String(env.PATH || '').split(path.delimiter).filter(Boolean);

  for (const directory of directories) {
    for (const extension of extensions) {
      candidates.push(path.resolve(directory || '.', `${command}${extension}`));
    }
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || command;
}

function resolveLauncher(host, env = process.env) {
  const requested = executableFor(host, env);
  if (process.platform !== 'win32') {
    return { command: requested, prefixArgs: [] };
  }

  const resolved = resolveWindowsCommand(requested, env);
  if (path.extname(resolved).toLowerCase() !== '.cmd') {
    return { command: resolved, prefixArgs: [] };
  }

  const shim = fs.readFileSync(resolved, 'utf8');
  const match = shim.match(/%dp0%\\([^"\r\n]+\.js)/i);
  if (!match) {
    throw new Error(`cannot safely launch non-Node command shim: ${resolved}`);
  }
  const entrypoint = path.resolve(path.dirname(resolved), match[1]);
  if (!fs.existsSync(entrypoint)) {
    throw new Error(`command shim entrypoint does not exist: ${entrypoint}`);
  }
  const localNode = path.join(path.dirname(resolved), 'node.exe');
  return {
    command: fs.existsSync(localNode) ? localNode : process.execPath,
    prefixArgs: [entrypoint],
  };
}

function runHostCommand(context, args, options = {}) {
  return runCommand(
    context.launcher.command,
    [...context.launcher.prefixArgs, ...args],
    { ...options, env: context.env },
  );
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  child.kill('SIGTERM');
}

function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes || MAX_OUTPUT_BYTES;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    let timer;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };

    const append = (target, chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        overflowed = true;
        terminateProcessTree(child);
        return target;
      }
      return target + chunk;
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => finish(null, {
      code,
      signal,
      stdout,
      stderr,
      timedOut,
      overflowed,
    }));

    timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);
  });
}

function commandFailure(label, result) {
  if (result.timedOut) return new Error(`${label} timed out`);
  if (result.overflowed) return new Error(`${label} exceeded the output limit`);
  const detail = (result.stderr || result.stdout || '').trim().slice(-2000);
  return new Error(`${label} exited ${result.code}${detail ? `: ${detail}` : ''}`);
}

function assertSuccess(label, result) {
  if (result.code !== 0 || result.timedOut || result.overflowed) {
    throw commandFailure(label, result);
  }
}

function extractVersion(output) {
  const match = String(output).match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  if (!match) throw new Error(`could not parse CLI version from: ${String(output).trim()}`);
  return match[0];
}

function parseJsonLines(text, label) {
  return String(text).split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is not JSON: ${error.message}`);
    }
  });
}

function parseJsonDocument(text, label) {
  try {
    return JSON.parse(String(text).trim());
  } catch (error) {
    throw new Error(`${label} is not JSON: ${error.message}`);
  }
}

function schemaForInitial(nonce) {
  return {
    type: 'object',
    properties: {
      phase: { type: 'string', enum: ['initial'] },
      nonce: { type: 'string', enum: [nonce] },
      file: { type: 'string', enum: ['probe.txt'] },
    },
    required: ['phase', 'nonce', 'file'],
    additionalProperties: false,
  };
}

function schemaForResume() {
  return {
    type: 'object',
    properties: {
      phase: { type: 'string', enum: ['resume'] },
      nonce: { type: 'string', minLength: 1 },
    },
    required: ['phase', 'nonce'],
    additionalProperties: false,
  };
}

function assertStructured(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} structured output must be an object`);
  }
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(value).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${label} structured output keys do not match the contract`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) {
      throw new Error(`${label} structured output has unexpected ${key}`);
    }
  }
}

function verifyProbe(probePath, nonce) {
  if (!fs.existsSync(probePath)) throw new Error('initial turn did not create probe.txt');
  const content = fs.readFileSync(probePath, 'utf8').replace(/\r\n/g, '\n');
  if (content !== nonce && content !== `${nonce}\n`) {
    throw new Error('probe.txt does not contain exactly the expected nonce line');
  }
  return {
    path: 'probe.txt',
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

function summarizeEvents(events) {
  const counts = {};
  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : 'unknown';
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function summarizeCodexItems(events) {
  const counts = {};
  for (const event of events) {
    const type = event && event.item && event.item.type;
    if (typeof type === 'string') counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function codexCommandDiagnostics(events) {
  return events.flatMap((event) => {
    const item = event && event.item;
    if (!item || item.type !== 'command_execution') return [];
    return [{
      command: item.command,
      status: item.status,
      exitCode: item.exit_code,
      output: typeof item.aggregated_output === 'string'
        ? item.aggregated_output.slice(-1000)
        : undefined,
    }];
  });
}

function assertCodexInitialCommandScope(events, nonce) {
  const forbiddenTools = codexToolEvents(events).filter((type) => (
    type === 'mcp_tool_call' || type === 'web_search'
  ));
  if (forbiddenTools.length) {
    throw new Error(`Codex initial turn used forbidden tools: ${forbiddenTools.join(', ')}`);
  }

  const commands = [...new Set(events.flatMap((event) => {
    const item = event && event.item;
    return item && item.type === 'command_execution' && typeof item.command === 'string'
      ? [item.command]
      : [];
  }))];
  const fileChanges = events.filter((event) => event.item && event.item.type === 'file_change');
  if (!commands.length && !fileChanges.length) {
    throw new Error('Codex initial turn reported no file-writing tool event');
  }
  if (commands.length > 2) {
    throw new Error('Codex initial turn used more than two distinct commands');
  }
  for (const command of commands) {
    const normalized = command.toLowerCase();
    if (!normalized.includes('probe.txt')) {
      throw new Error('Codex initial command was not scoped to probe.txt');
    }
    if (/https?:\/\/|invoke-webrequest|\bcurl\b|\bwget\b/.test(normalized)) {
      throw new Error('Codex initial command attempted network access');
    }
  }
  if (commands.length && !commands.some((command) => command.includes(nonce))) {
    throw new Error('Codex initial commands did not contain the generated nonce');
  }
  return { distinctCommands: commands.length, fileChanges: fileChanges.length };
}

function codexToolEvents(events) {
  return events.flatMap((event) => {
    const itemType = event && event.item && event.item.type;
    return TOOL_EVENT_TYPES.has(itemType) ? [itemType] : [];
  });
}

function codexSessionId(events) {
  const event = events.find((candidate) => candidate.type === 'thread.started');
  if (!event || typeof event.thread_id !== 'string') {
    throw new Error('Codex output did not include a thread.started session ID');
  }
  return event.thread_id;
}

function buildCodexInitialArgs(paths, prompt) {
  return [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--config', CODEX_APPROVAL_POLICY,
    '--config', 'approvals_reviewer="auto_review"',
    '--sandbox', 'workspace-write',
    '--cd', paths.workspace,
    '--color', 'never',
    '--json',
    '--output-schema', paths.initialSchema,
    '--output-last-message', paths.initialOutput,
    prompt,
  ];
}

function buildCodexResumeArgs(paths, sessionId, prompt) {
  return [
    'exec', 'resume',
    '--ignore-user-config',
    '--ignore-rules',
    '--config', CODEX_APPROVAL_POLICY,
    '--config', 'approvals_reviewer="auto_review"',
    '--json',
    '--output-schema', paths.resumeSchema,
    '--output-last-message', paths.resumeOutput,
    sessionId,
    prompt,
  ];
}

function buildClaudeInitialArgs(paths, sessionId, prompt, maxBudgetUsd) {
  return [
    '--safe-mode',
    '--no-chrome',
    '--print', prompt,
    '--output-format', 'json',
    '--json-schema', fs.readFileSync(paths.initialSchema, 'utf8'),
    '--session-id', sessionId,
    '--permission-mode', 'acceptEdits',
    '--tools', 'Write',
    '--allowedTools', 'Write',
    '--max-turns', '3',
    '--max-budget-usd', String(maxBudgetUsd),
  ];
}

function buildClaudeResumeArgs(paths, sessionId, prompt, maxBudgetUsd) {
  return [
    '--safe-mode',
    '--no-chrome',
    '--print', prompt,
    '--resume', sessionId,
    '--output-format', 'json',
    '--json-schema', fs.readFileSync(paths.resumeSchema, 'utf8'),
    '--permission-mode', 'dontAsk',
    '--tools', '',
    '--max-turns', '1',
    '--max-budget-usd', String(maxBudgetUsd),
  ];
}

function prompts(nonce, host) {
  const writeInstruction = host === 'codex'
    ? 'Use a local shell command to create and verify probe.txt; allow the configured automatic reviewer to assess the bounded write.'
    : 'Use the available Write tool to create probe.txt.';
  return {
    initial: [
      'This is an isolated behavioral CLI smoke test, not a request to describe an action.',
      'Do not use the network.',
      `You must actually create probe.txt in the current workspace with ${nonce} as its first and only line.`,
      writeInstruction,
      'Do not return until the writing tool reports success, then return the structured result.',
    ].join(' '),
    resume: [
      'Do not read files, call tools, or use the network.',
      'Return the nonce from the immediately preceding turn in the requested structured result.',
    ].join(' '),
  };
}

function removeResumeSources(paths) {
  for (const target of [paths.probe, paths.initialSchema, paths.initialOutput]) {
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  }
}

function assertNoCodexFailureEvents(events, label) {
  const failure = events.find((event) => event.type === 'error' || event.type === 'turn.failed');
  if (failure) throw new Error(`${label} emitted ${failure.type}`);
}

async function runCodexTurnSet(context) {
  const initialResult = await runHostCommand(
    context,
    buildCodexInitialArgs(context.paths, context.prompts.initial),
    { cwd: context.paths.workspace, timeoutMs: context.options.timeoutMs },
  );
  const initialEvents = parseJsonLines(initialResult.stdout, 'Codex initial JSONL');
  context.sessionId = codexSessionId(initialEvents);
  assertSuccess('Codex initial turn', initialResult);
  assertNoCodexFailureEvents(initialEvents, 'Codex initial turn');

  const initialStructured = parseJsonDocument(
    fs.readFileSync(context.paths.initialOutput, 'utf8'),
    'Codex initial output',
  );
  assertStructured(initialStructured, {
    phase: 'initial',
    nonce: context.nonce,
    file: 'probe.txt',
  }, 'Codex initial');
  const commandScope = assertCodexInitialCommandScope(initialEvents, context.nonce);
  let file;
  try {
    file = verifyProbe(context.paths.probe, context.nonce);
  } catch (error) {
    const itemCounts = JSON.stringify(summarizeCodexItems(initialEvents));
    const commands = JSON.stringify(codexCommandDiagnostics(initialEvents));
    throw new Error(`${error.message}; Codex item counts: ${itemCounts}; commands: ${commands}`);
  }
  removeResumeSources(context.paths);

  const resumeResult = await runHostCommand(
    context,
    buildCodexResumeArgs(context.paths, context.sessionId, context.prompts.resume),
    { cwd: context.paths.workspace, timeoutMs: context.options.timeoutMs },
  );
  const resumeEvents = parseJsonLines(resumeResult.stdout, 'Codex resume JSONL');
  assertSuccess('Codex resume turn', resumeResult);
  assertNoCodexFailureEvents(resumeEvents, 'Codex resume turn');
  const resumedSessionId = codexSessionId(resumeEvents);
  if (resumedSessionId !== context.sessionId) {
    throw new Error('Codex resume returned a different session ID');
  }
  const resumeTools = codexToolEvents(resumeEvents);
  if (resumeTools.length) {
    throw new Error(`Codex resume used forbidden tools: ${resumeTools.join(', ')}`);
  }
  const resumeStructured = parseJsonDocument(
    fs.readFileSync(context.paths.resumeOutput, 'utf8'),
    'Codex resume output',
  );
  assertStructured(resumeStructured, {
    phase: 'resume',
    nonce: context.nonce,
  }, 'Codex resume');

  return {
    sessionId: context.sessionId,
    initial: {
      structured: initialStructured,
      eventCounts: summarizeEvents(initialEvents),
      itemCounts: summarizeCodexItems(initialEvents),
      commandScope,
      file,
    },
    resume: {
      structured: resumeStructured,
      eventCounts: summarizeEvents(resumeEvents),
      toolEvents: resumeTools,
    },
  };
}

async function runClaudeTurnSet(context) {
  context.sessionId = randomUUID();
  const initialResult = await runHostCommand(
    context,
    buildClaudeInitialArgs(
      context.paths,
      context.sessionId,
      context.prompts.initial,
      context.options.maxBudgetUsd,
    ),
    { cwd: context.paths.workspace, timeoutMs: context.options.timeoutMs },
  );
  assertSuccess('Claude initial turn', initialResult);
  const initialDocument = parseJsonDocument(initialResult.stdout, 'Claude initial output');
  if (initialDocument.is_error === true) throw new Error('Claude initial result reported an error');
  if (initialDocument.session_id !== context.sessionId) {
    throw new Error('Claude initial result returned a different session ID');
  }
  assertStructured(initialDocument.structured_output, {
    phase: 'initial',
    nonce: context.nonce,
    file: 'probe.txt',
  }, 'Claude initial');
  const file = verifyProbe(context.paths.probe, context.nonce);
  removeResumeSources(context.paths);

  const resumeResult = await runHostCommand(
    context,
    buildClaudeResumeArgs(
      context.paths,
      context.sessionId,
      context.prompts.resume,
      context.options.maxBudgetUsd,
    ),
    { cwd: context.paths.workspace, timeoutMs: context.options.timeoutMs },
  );
  assertSuccess('Claude resume turn', resumeResult);
  const resumeDocument = parseJsonDocument(resumeResult.stdout, 'Claude resume output');
  if (resumeDocument.is_error === true) throw new Error('Claude resume result reported an error');
  if (resumeDocument.session_id !== context.sessionId) {
    throw new Error('Claude resume returned a different session ID');
  }
  assertStructured(resumeDocument.structured_output, {
    phase: 'resume',
    nonce: context.nonce,
  }, 'Claude resume');

  return {
    sessionId: context.sessionId,
    initial: {
      structured: initialDocument.structured_output,
      file,
    },
    resume: {
      structured: resumeDocument.structured_output,
      toolsDisabled: true,
    },
  };
}

async function cleanupSession(context) {
  if (!context.sessionId) return { status: 'not-created' };
  let args;
  if (context.options.host === 'codex') {
    args = ['delete', '--force', context.sessionId];
  } else {
    args = ['project', 'purge', context.paths.workspace, '--yes'];
  }
  const result = await runHostCommand(context, args, {
    cwd: context.paths.workspace,
    timeoutMs: Math.min(context.options.timeoutMs, 30000),
  });
  assertSuccess(`${context.options.host} session cleanup`, result);
  return { status: 'purged' };
}

function removeTempRoot(tempRoot) {
  const resolved = path.resolve(tempRoot);
  const tempBase = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!resolved.startsWith(tempBase) || !path.basename(resolved).startsWith('inquiry-live-smoke-')) {
    throw new Error(`refusing to remove unexpected path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function createPaths() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inquiry-live-smoke-'));
  const workspace = path.join(tempRoot, 'workspace');
  const control = path.join(tempRoot, 'control');
  fs.mkdirSync(workspace);
  fs.mkdirSync(control);
  return {
    tempRoot,
    workspace,
    control,
    probe: path.join(workspace, 'probe.txt'),
    initialSchema: path.join(control, 'initial.schema.json'),
    resumeSchema: path.join(control, 'resume.schema.json'),
    initialOutput: path.join(control, 'initial.output.json'),
    resumeOutput: path.join(control, 'resume.output.json'),
  };
}

async function runLiveSmoke(options, env = process.env) {
  if (env.INQUIRY_LIVE_SMOKE !== '1') {
    throw new Error('live execution is gated; set INQUIRY_LIVE_SMOKE=1 explicitly');
  }

  const startedAt = Date.now();
  const launcher = resolveLauncher(options.host, env);
  const versionResult = await runCommand(launcher.command, [...launcher.prefixArgs, '--version'], {
    timeoutMs: Math.min(options.timeoutMs, 15000),
    env,
  });
  assertSuccess(`${options.host} version check`, versionResult);
  const versionText = `${versionResult.stdout}\n${versionResult.stderr}`.trim();
  const cliVersion = extractVersion(versionText);
  if (cliVersion !== options.expectedVersion) {
    throw new Error(
      `${options.host} version drift: expected ${options.expectedVersion}, found ${cliVersion}`,
    );
  }

  const paths = createPaths();
  const nonce = `inquiry-${randomUUID()}`;
  try {
    fs.writeFileSync(paths.initialSchema, `${JSON.stringify(schemaForInitial(nonce), null, 2)}\n`);
    fs.writeFileSync(paths.resumeSchema, `${JSON.stringify(schemaForResume(), null, 2)}\n`);
  } catch (error) {
    removeTempRoot(paths.tempRoot);
    throw error;
  }
  const context = {
    env,
    launcher,
    nonce,
    options,
    paths,
    prompts: prompts(nonce, options.host),
    sessionId: null,
  };
  let turnReport;
  let primaryError = null;
  let sessionCleanup;
  let cleanupError = null;

  try {
    const gitResult = await runCommand('git', ['init', '--quiet'], {
      cwd: paths.workspace,
      timeoutMs: Math.min(options.timeoutMs, 15000),
    });
    assertSuccess('temporary git init', gitResult);
    turnReport = options.host === 'codex'
      ? await runCodexTurnSet(context)
      : await runClaudeTurnSet(context);
  } catch (error) {
    primaryError = error;
  }

  try {
    sessionCleanup = await cleanupSession(context);
  } catch (error) {
    cleanupError = error;
  }

  let workspaceCleanup = options.keep ? 'kept' : 'removed';
  if (!options.keep) {
    try {
      removeTempRoot(paths.tempRoot);
    } catch (error) {
      workspaceCleanup = 'failed';
      cleanupError = cleanupError || error;
    }
  }

  if (primaryError || cleanupError) {
    const messages = [primaryError && primaryError.message, cleanupError && cleanupError.message]
      .filter(Boolean);
    throw new Error(messages.join('; cleanup: '));
  }

  return {
    protocol: PROTOCOL,
    host: options.host,
    cliVersion,
    expectedVersion: options.expectedVersion,
    safety: {
      credentialGate: true,
      dangerousBypass: false,
      isolatedWorkspace: true,
      approvalReviewer: options.host === 'codex' ? 'auto_review' : null,
      sandboxEscalationApproval: options.host === 'codex' ? 'auto_review' : null,
      timeoutMs: options.timeoutMs,
      maxBudgetUsd: options.host === 'claude' ? options.maxBudgetUsd : null,
    },
    ...turnReport,
    cleanup: {
      session: sessionCleanup.status,
      workspace: workspaceCleanup,
      path: options.keep ? paths.tempRoot : null,
    },
    elapsedMs: Date.now() - startedAt,
  };
}

async function main() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
    if (options.help) {
      usage(process.stdout);
      return;
    }
    const report = await runLiveSmoke(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`inquiry-live-smoke: ${error.message}\n`);
    if (!options || !options.host) usage();
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  PROTOCOL,
  assertCodexInitialCommandScope,
  buildClaudeInitialArgs,
  buildClaudeResumeArgs,
  buildCodexInitialArgs,
  buildCodexResumeArgs,
  codexSessionId,
  codexToolEvents,
  extractVersion,
  parseCli,
  parseJsonDocument,
  parseJsonLines,
  removeTempRoot,
  resolveLauncher,
  runCommand,
  schemaForInitial,
  schemaForResume,
  verifyProbe,
};
