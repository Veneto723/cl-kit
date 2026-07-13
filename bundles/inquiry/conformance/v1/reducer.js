'use strict';

const { assertTrace } = require('./contract');

function normalizeStrings(values, limit) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))).slice(0, limit);
}

function validSources(values) {
  return normalizeStrings(values, 6).filter((value) => {
    try {
      const parsed = new URL(value);
      return ['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.hostname);
    } catch {
      return false;
    }
  });
}

function isAdmitted(finding, verdict) {
  return verdict.verdict === 'keep' && verdict.grounded && verdict.onBrief !== false &&
    !verdict.redundant && validSources(finding.sources).length > 0 &&
    normalizeStrings(finding.evidence, 8).length > 0;
}

function abortedProjection() {
  return {
    attempted: 0,
    judged: 0,
    failed: 1,
    clean: false,
    dry: false,
    roundFailed: true,
    kept: [],
    unverified: [],
    escalations: [],
  };
}

function reduceTrace(trace) {
  assertTrace(trace);
  const terminal = trace[trace.length - 1];
  if (terminal.type === 'round.aborted') return abortedProjection();

  const started = trace[0];
  const divergence = trace.find((event) => event.type === 'divergence.completed');
  const byAngle = new Map(divergence.data.angles.map((angle) => [angle.angleId, {
    finding: null,
    investigationFailed: false,
    verificationFailed: false,
    verdict: null,
  }]));

  for (const event of trace) {
    if (!event.angleId || !byAngle.has(event.angleId)) continue;
    const state = byAngle.get(event.angleId);
    if (event.type === 'investigation.completed') state.finding = event.data.finding;
    if (event.type === 'investigation.failed') state.investigationFailed = true;
    if (event.type === 'verification.failed') state.verificationFailed = true;
    if (event.type === 'verification.completed') state.verdict = event.data.verdict;
  }

  const kept = [];
  const unverified = [];
  const escalations = [];
  let judged = 0;
  let failed = 0;
  const escalateBar = Number(started.data.escalateBar);

  for (const angle of divergence.data.angles) {
    const state = byAngle.get(angle.angleId);
    if (state.investigationFailed) {
      failed += 1;
      continue;
    }
    if (state.verificationFailed) {
      failed += 1;
      unverified.push(angle.angleId);
      continue;
    }
    judged += 1;
    if (!isAdmitted(state.finding, state.verdict)) continue;
    kept.push(angle.angleId);
    const significance = Math.max(0, Math.min(1, Number(state.verdict.significance) || 0));
    if (significance >= escalateBar) escalations.push(angle.angleId);
  }

  const attempted = divergence.data.angles.length;
  return {
    attempted,
    judged,
    failed,
    clean: failed === 0,
    dry: judged > 0 && kept.length === 0,
    roundFailed: judged === 0 && attempted > 0,
    kept,
    unverified,
    escalations,
  };
}

function assertConformantTrace(trace) {
  const projection = reduceTrace(trace);
  const terminal = trace[trace.length - 1];
  if (terminal.type === 'round.aborted') return projection;

  for (const key of ['attempted', 'judged', 'failed', 'clean', 'dry', 'roundFailed']) {
    if (terminal.data[key] !== projection[key]) {
      throw new Error(`inquiry conformance: round.completed.data.${key} does not match reduced trace`);
    }
  }
  for (const key of ['kept', 'unverified', 'escalations']) {
    if (JSON.stringify(terminal.data[key]) !== JSON.stringify(projection[key])) {
      throw new Error(`inquiry conformance: round.completed.data.${key} does not match reduced trace`);
    }
  }
  return projection;
}

module.exports = {
  assertConformantTrace,
  reduceTrace,
};
