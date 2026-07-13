'use strict';

const { TRACE_VERSION } = require('../v1/contract');
const { assertConformantTrace } = require('../v1/reducer');

function requireRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('inquiry conformance: Codex round record must be an object');
  }
  if (raw.contractVersion !== TRACE_VERSION) {
    throw new Error(`inquiry conformance: unsupported Codex contractVersion ${String(raw.contractVersion)}`);
  }
  if (typeof raw.roundId !== 'string' || !raw.roundId.trim()) {
    throw new Error('inquiry conformance: Codex round record requires roundId');
  }
  if (!Array.isArray(raw.angles) || !Array.isArray(raw.outcomes)) {
    throw new Error('inquiry conformance: Codex round record requires angles and outcomes');
  }
  if (!raw.summary || typeof raw.summary !== 'object') {
    throw new Error('inquiry conformance: Codex round record requires a declared summary');
  }
}

function toTrace(raw) {
  requireRecord(raw);
  const trace = [];
  const emit = (type, data, angleId) => {
    const event = {
      contractVersion: TRACE_VERSION,
      roundId: raw.roundId,
      seq: trace.length,
      type,
      data,
    };
    if (angleId) event.angleId = angleId;
    trace.push(event);
  };

  emit('round.started', { escalateBar: raw.escalateBar });
  emit('divergence.completed', { angles: raw.angles });
  const angleIds = new Set(raw.angles.map((angle) => angle.angleId));
  const outcomes = new Map();
  for (const outcome of raw.outcomes) {
    if (!outcome || typeof outcome.angleId !== 'string' || !outcome.angleId.trim()) {
      throw new Error('inquiry conformance: every Codex outcome requires angleId');
    }
    if (!angleIds.has(outcome.angleId)) {
      throw new Error(`inquiry conformance: Codex outcome references unknown angle ${outcome.angleId}`);
    }
    if (outcomes.has(outcome.angleId)) {
      throw new Error(`inquiry conformance: duplicate Codex outcome for ${outcome.angleId}`);
    }
    outcomes.set(outcome.angleId, outcome);
  }

  for (const angle of raw.angles) {
    const outcome = outcomes.get(angle.angleId);
    if (!outcome || !outcome.investigation) {
      throw new Error(`inquiry conformance: Codex outcome missing for ${angle.angleId}`);
    }
    if (outcome.investigation.status === 'failed') {
      emit('investigation.failed', {
        kind: outcome.investigation.kind || 'unknown',
        reason: outcome.investigation.reason || 'investigator failed',
      }, angle.angleId);
      continue;
    }
    if (outcome.investigation.status !== 'completed') {
      throw new Error(`inquiry conformance: invalid investigation status for ${angle.angleId}`);
    }
    emit('investigation.completed', { finding: outcome.investigation.finding }, angle.angleId);
    if (!outcome.verification) {
      throw new Error(`inquiry conformance: verification outcome missing for ${angle.angleId}`);
    }
    if (outcome.verification.status === 'failed') {
      emit('verification.failed', {
        reason: outcome.verification.reason || 'skeptic failed',
      }, angle.angleId);
      continue;
    }
    if (outcome.verification.status !== 'completed') {
      throw new Error(`inquiry conformance: invalid verification status for ${angle.angleId}`);
    }
    emit('verification.completed', { verdict: outcome.verification.verdict }, angle.angleId);
  }

  emit('round.completed', raw.summary);
  assertConformantTrace(trace);
  return trace;
}

module.exports = { toTrace };
