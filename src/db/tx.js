// src/db/tx.js — U1-DB: withTransaction — the ONE way Homeplate runs a PostgreSQL transaction.
//
// Requirement traceability (SRS Appendix B):
//   FR-12 — the atomic booking + capacity decrement commits through this wrapper
//   FR-13 / ADR-001/003 — "no dual writes": a business row and its outbox row are handed the
//          SAME client here, so they commit or roll back together; U2-OUTBOX's enqueue(client,…)
//          must be called with the client this function passes to `fn`
//   NFR-11 — everything inside runs parameterized via the pg client
//
// Public interface (build-plan wave-1 contract):
//   withTransaction(fn) → Promise — BEGIN, await fn(client), COMMIT; any throw → ROLLBACK and
//   the original error is rethrown. The client is always released, never leaked.
'use strict';

const { getClient } = require('./pool');

/**
 * Run `fn` inside a single PostgreSQL transaction.
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn — receives the transaction's
 *   client; EVERY statement belonging to the unit of work (including outbox.enqueue per
 *   ADR-001/003) must run on this client, not on the pool.
 * @returns {Promise<T>} fn's resolved value after COMMIT.
 * @throws the original error from `fn` (or COMMIT) after a best-effort ROLLBACK.
 */
async function withTransaction(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('withTransaction(fn): fn must be a function(client)');
  }
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // Roll back everything fn did; swallow only the rollback's own failure (e.g. the
    // connection died — the server aborts the transaction anyway) so the caller always
    // sees the ORIGINAL error, with the rollback problem attached for observability.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      err.rollbackError = rollbackErr;
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { withTransaction };
