'use strict';

const { assertConformantTrace } = require('../v1/reducer');

function toTrace(rawResult) {
  if (!rawResult || !Array.isArray(rawResult.trace)) {
    throw new Error('inquiry conformance: Claude result does not contain a canonical trace');
  }
  assertConformantTrace(rawResult.trace);
  return rawResult.trace;
}

module.exports = { toTrace };
