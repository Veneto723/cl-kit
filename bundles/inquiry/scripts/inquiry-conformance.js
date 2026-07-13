#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { adapters } = require('../conformance/adapters');
const { TRACE_VERSION } = require('../conformance/v1/contract');
const { reduceTrace } = require('../conformance/v1/reducer');

function usage() {
  console.error('Usage: inquiry-conformance.js <claude|codex> <round-result.json|->');
}

function fail(message) {
  console.error(`inquiry-conformance: ${message}`);
  process.exit(1);
}

const [host, inputPath] = process.argv.slice(2);
if (host === '--help' || host === '-h') {
  usage();
  process.exit(0);
}
if (!host || !inputPath) {
  usage();
  process.exit(1);
}

try {
  const input = inputPath === '-'
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(path.resolve(inputPath), 'utf8');
  const raw = JSON.parse(input);
  const trace = adapters.get(host).toTrace(raw);
  const projection = reduceTrace(trace);
  console.log(JSON.stringify({
    host,
    contractVersion: TRACE_VERSION,
    roundId: trace[0].roundId,
    projection,
  }, null, 2));
} catch (error) {
  fail(error.message);
}
