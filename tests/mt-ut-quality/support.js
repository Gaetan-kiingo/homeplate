// tests/mt-ut-quality/support.js — shared plumbing for the mt-ut-quality (MT-01 / NFR-08) lane.
// Not a test file: jest testMatch collects *.test.js only. This lane owns tests/mt-ut-quality
// exclusively; no application source is touched.
'use strict';

const { createLogger } = require('../../src/lib/logger');
const { pollOnce } = require('../../src/outbox/worker');

// ---- recording logger -----------------------------------------------------------------------
// Every line the app/worker would write goes into `lines`, so a suite can assert on the EXACT
// BYTES that would reach a log aggregator — the SRS §3.4 PII register is a claim about those
// bytes, not about parsed objects.
function makeRecordingLogger({ level = 'info' } = {}) {
  const lines = [];
  const sink = {
    write(line) {
      lines.push(String(line));
    },
  };
  const logger = createLogger({ level, stream: sink });
  const records = () =>
    lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  const auditRecords = () => records().filter((r) => r.audit === true);
  const auditsFor = (event, cid) =>
    auditRecords().filter((r) => r.event === event && r.correlationId === cid);
  return { lines, logger, records, auditRecords, auditsFor };
}

// ---- outbox drain ---------------------------------------------------------------------------
// DETERMINISM (verification-report F-01): drain until the caller's own job is done, or until
// nothing anywhere is claimable — never on a fixed pass budget. pollOnce claims from the WHOLE
// outbox table (`ORDER BY available_at, id LIMIT config.outbox.batchSize`, ten rows a pass), so
// the number of passes a given job needs is a function of how many pending rows SIBLING SUITES
// happened to leave behind earlier in the run — global state the calling test does not own. An
// earlier 8-pass budget covered at most 80 foreign rows and failed the moment a run left more,
// which is exactly the intermittent observed on 2026-08-17 (full-suite run A: delivered; run B,
// same lane, same code: still 'pending'). Jobs that back off take a future available_at and
// drop out of the claim, so the loop always ends: either `isDone()` reports the target reached,
// or a pass claims nothing (queue drained without reaching the target — the caller's next
// assertion then fails with the real story). MAX_PASSES is a RUNAWAY GUARD, not a budget, and
// is never the reason the loop stops on a healthy worker.
const MAX_PASSES = 5000;

async function drainOutboxUntil({ registry, log, isDone }) {
  let claimed = 0;
  for (let passes = 0; ; passes += 1) {
    if (passes >= MAX_PASSES) {
      throw new Error(
        `outbox drain did not reach its target in ${MAX_PASSES} passes — the worker is not ` +
          'making progress (this is a real defect, not a budget to raise)'
      );
    }
    const stats = await pollOnce({ registry, log });
    claimed += stats.claimed;
    if (await isDone()) break;
    if (stats.claimed === 0) break;
  }
  return { claimed };
}

module.exports = { makeRecordingLogger, drainOutboxUntil };
