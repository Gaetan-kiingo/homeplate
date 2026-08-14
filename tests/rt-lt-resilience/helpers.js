// tests/rt-lt-resilience/helpers.js — shared utilities for the rt-lt-resilience verifier lane
// (RT-01, RT-02, LT-01, LT-02). Lane-owned file; no application source is modified.
'use strict';

/** A pino-shaped silent logger: child() returns itself, every level is a no-op. */
function quietLogger() {
  const log = {};
  for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace']) {
    log[level] = () => {};
  }
  log.child = () => log;
  return log;
}

/** A pino-shaped recording logger capturing (level, bindings, obj, msg); child merges bindings. */
function recordingLogger() {
  const lines = [];
  function makeLog(bindings) {
    const log = {};
    for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace']) {
      log[level] = (obj, msg) => {
        if (typeof obj === 'string') {
          lines.push({ level, bindings, obj: {}, msg: obj });
        } else {
          lines.push({ level, bindings, obj: obj || {}, msg });
        }
      };
    }
    log.child = (childBindings) => makeLog({ ...bindings, ...(childBindings || {}) });
    return log;
  }
  return { log: makeLog({}), lines };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** p-quantile (0..1) of an array of numbers (nearest-rank). */
function quantile(values, q) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

module.exports = { quietLogger, recordingLogger, sleep, quantile };
