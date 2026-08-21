// tests/helpers/outboxScope.js — worker passes scoped to the caller's own outbox rows, in
// one place.
//
// THE SUBTLETY (finding TCBV2-01): pollOnce() claims from the WHOLE shared outbox_jobs table,
// `ORDER BY available_at, id LIMIT config.outbox.batchSize` (10). Every suite in the run
// shares that table and it is reset only in globalSetup, so foreign PENDING rows left by
// whichever files Jest happened to schedule earlier sit AHEAD of a test's own job (their
// available_at is older) and win the claim slots. Measured on this tree: with 0 foreign due
// rows a job needed 1 pass; 50 needed 6; 250 exhausted a fixed 20-pass loop leaving the
// booking 'pending'; and a seeded 3000-row queue failed tc13's 'redelivery is exactly-once'
// with `Expected: 2 / Received: 0`. Draining first is not enough either: a drained foreign
// job that FAILS is rescheduled available_at = now() + backoffBaseMs (5 s) and competes again
// within the same file's run.
//
// So every scoped pass PARKS every other pending row an hour out for the duration and
// restores each row's original available_at afterwards: the outcome depends only on rows the
// calling test owns, and sibling suites' queue state is neither stolen nor disturbed
// (tests/helpers/env.js CONCURRENCY RULE, in-run variant).
'use strict';

const { query } = require('./db');
const { pollOnce } = require('../../src/outbox/worker');

/**
 * Run `fn` (typically one or more worker passes) with ONLY `jobIds` due.
 *
 * @param {Array<string|number>} jobIds outbox_jobs.id values the pass must be able to claim
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withOnlyTheseDue(jobIds, fn) {
  const ids = jobIds.map(String);
  const { rows: parked } = await query(
    `SELECT id, available_at FROM outbox_jobs
      WHERE status = 'pending' AND NOT (id = ANY($1::bigint[]))`,
    [ids]
  );
  await query(
    `UPDATE outbox_jobs SET available_at = now() + interval '1 hour'
      WHERE status = 'pending' AND NOT (id = ANY($1::bigint[]))`,
    [ids]
  );
  try {
    return await fn();
  } finally {
    for (const row of parked) {
      await query('UPDATE outbox_jobs SET available_at = $2 WHERE id = $1', [
        row.id,
        row.available_at,
      ]);
    }
  }
}

/**
 * Run up to `cycles` poll cycles that can only ever see `jobIds`.
 *
 * Pass cycles = 1 when the delivered job itself enqueues NEW rows the registry could claim
 * (e.g. a promotion's own 'started' notify rows, which are enqueued DURING the cycle and are
 * not in the parked set): a second cycle would claim them and rewrite their xmin with a retry
 * UPDATE, destroying same-transaction evidence a test may be about to assert.
 *
 * @param {Array<string|number>} jobIds
 * @param {{get: Function}} registry a dispatch registry (createRegistry/loadHandlers result)
 * @param {number} [cycles]
 */
async function pollOnlyThese(jobIds, registry, cycles = 3) {
  return withOnlyTheseDue(jobIds, async () => {
    for (let i = 0; i < cycles; i += 1) {
      const stats = await pollOnce({ registry });
      if (stats.claimed === 0) break;
    }
  });
}

module.exports = { withOnlyTheseDue, pollOnlyThese };
