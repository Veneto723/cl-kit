'use strict';

const TRACE_VERSION = 'inquiry.trace/v1';
const EVENT_TYPES = new Set([
  'round.started',
  'round.aborted',
  'divergence.completed',
  'divergence.failed',
  'investigation.completed',
  'investigation.failed',
  'verification.completed',
  'verification.failed',
  'round.completed',
]);
const TERMINAL_TYPES = new Set(['round.aborted', 'round.completed']);

function fail(message) {
  throw new Error(`inquiry conformance: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
}

function requireCount(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
}

function assertFinding(finding, label) {
  requireObject(finding, label);
  requireString(finding.claim, `${label}.claim`);
}

function assertVerdict(verdict, label) {
  requireObject(verdict, label);
  if (!['keep', 'kill'].includes(verdict.verdict)) fail(`${label}.verdict must be keep or kill`);
  requireBoolean(verdict.grounded, `${label}.grounded`);
  requireBoolean(verdict.onBrief, `${label}.onBrief`);
  requireBoolean(verdict.redundant, `${label}.redundant`);
  if (typeof verdict.significance !== 'number' || !Number.isFinite(verdict.significance)) {
    fail(`${label}.significance must be a finite number`);
  }
}

function assertSummary(summary, label) {
  requireObject(summary, label);
  for (const key of ['attempted', 'judged', 'failed']) requireCount(summary[key], `${label}.${key}`);
  for (const key of ['clean', 'dry', 'roundFailed']) requireBoolean(summary[key], `${label}.${key}`);
  for (const key of ['kept', 'unverified', 'escalations']) {
    if (!Array.isArray(summary[key]) || summary[key].some((value) => typeof value !== 'string')) {
      fail(`${label}.${key} must be an array of angle IDs`);
    }
  }
}

function assertTrace(trace) {
  if (!Array.isArray(trace) || trace.length < 2) fail('trace must contain at least two events');

  const first = trace[0];
  requireObject(first, 'event 0');
  if (first.type !== 'round.started') fail('trace must start with round.started');
  requireString(first.roundId, 'event 0.roundId');
  const roundId = first.roundId;
  const angleStates = new Map();
  let divergence = null;
  let terminalCount = 0;

  trace.forEach((event, index) => {
    requireObject(event, `event ${index}`);
    if (event.contractVersion !== TRACE_VERSION) {
      fail(`event ${index} uses unsupported contractVersion ${String(event.contractVersion)}`);
    }
    if (event.roundId !== roundId) fail(`event ${index} has a different roundId`);
    if (event.seq !== index) fail(`event ${index}.seq must equal ${index}`);
    if (!EVENT_TYPES.has(event.type)) fail(`event ${index} has unknown type ${String(event.type)}`);
    requireObject(event.data, `event ${index}.data`);

    if (index > 0 && event.type === 'round.started') fail('round.started may appear only once');
    if (TERMINAL_TYPES.has(event.type)) terminalCount += 1;
    if (TERMINAL_TYPES.has(event.type) && index !== trace.length - 1) {
      fail(`${event.type} must be the last event`);
    }

    switch (event.type) {
      case 'round.started': {
        const bar = event.data.escalateBar;
        if (typeof bar !== 'number' || !Number.isFinite(bar) || bar < 0 || bar > 1) {
          fail('round.started.data.escalateBar must be between 0 and 1');
        }
        break;
      }
      case 'divergence.completed': {
        if (divergence) fail('divergence may terminate only once');
        if (!Array.isArray(event.data.angles) || event.data.angles.length === 0) {
          fail('divergence.completed.data.angles must be non-empty');
        }
        for (const [angleIndex, angle] of event.data.angles.entries()) {
          requireObject(angle, `angle ${angleIndex}`);
          requireString(angle.angleId, `angle ${angleIndex}.angleId`);
          requireString(angle.lens, `angle ${angleIndex}.lens`);
          requireString(angle.question, `angle ${angleIndex}.question`);
          if (angleStates.has(angle.angleId)) fail(`duplicate angleId ${angle.angleId}`);
          angleStates.set(angle.angleId, { investigation: null, verification: null });
        }
        divergence = 'completed';
        break;
      }
      case 'divergence.failed':
        if (divergence) fail('divergence may terminate only once');
        requireString(event.data.reason, 'divergence.failed.data.reason');
        divergence = 'failed';
        break;
      case 'investigation.completed':
      case 'investigation.failed': {
        if (divergence !== 'completed') fail(`${event.type} requires completed divergence`);
        requireString(event.angleId, `${event.type}.angleId`);
        const state = angleStates.get(event.angleId);
        if (!state) fail(`${event.type} references unknown angleId ${event.angleId}`);
        if (state.investigation) fail(`angle ${event.angleId} has duplicate investigation terminal`);
        if (event.type === 'investigation.completed') {
          assertFinding(event.data.finding, `${event.type}.data.finding`);
          state.investigation = 'completed';
        } else {
          if (!['threw', 'probeDied', 'unknown'].includes(event.data.kind)) {
            fail('investigation.failed.data.kind must be threw, probeDied, or unknown');
          }
          requireString(event.data.reason, 'investigation.failed.data.reason');
          state.investigation = 'failed';
        }
        break;
      }
      case 'verification.completed':
      case 'verification.failed': {
        if (divergence !== 'completed') fail(`${event.type} requires completed divergence`);
        requireString(event.angleId, `${event.type}.angleId`);
        const state = angleStates.get(event.angleId);
        if (!state) fail(`${event.type} references unknown angleId ${event.angleId}`);
        if (state.investigation !== 'completed') {
          fail(`${event.type} requires a completed investigation for ${event.angleId}`);
        }
        if (state.verification) fail(`angle ${event.angleId} has duplicate verification terminal`);
        if (event.type === 'verification.completed') {
          assertVerdict(event.data.verdict, `${event.type}.data.verdict`);
          state.verification = 'completed';
        } else {
          requireString(event.data.reason, 'verification.failed.data.reason');
          state.verification = 'failed';
        }
        break;
      }
      case 'round.completed':
        if (divergence !== 'completed') fail('round.completed requires completed divergence');
        for (const [angleId, state] of angleStates) {
          if (!state.investigation) fail(`angle ${angleId} has no investigation terminal`);
          if (state.investigation === 'completed' && !state.verification) {
            fail(`angle ${angleId} has no verification terminal`);
          }
        }
        assertSummary(event.data, 'round.completed.data');
        break;
      case 'round.aborted':
        if (divergence === 'completed') {
          fail('round.aborted after completed divergence is unsupported in inquiry.trace/v1');
        }
        requireString(event.data.reason, 'round.aborted.data.reason');
        break;
      default:
        break;
    }
  });

  if (terminalCount !== 1) fail('trace must contain exactly one round terminal');
  return trace;
}

module.exports = {
  EVENT_TYPES,
  TRACE_VERSION,
  assertTrace,
};
