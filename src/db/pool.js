// src/db/pool.js — U1-DB: the single PostgreSQL connection pool (SRS §2.4 — PostgreSQL is the
// sole source of truth).
//
// Requirement traceability (SRS Appendix B):
//   NFR-01/NFR-02 — pooled connections keep per-request latency flat at 10k-user volume
//   NFR-11        — query(text, params) is the parameterized-SQL entry point; callers pass
//                   values via $n placeholders, NEVER by string interpolation (repo grep lane)
//
// Public interface (build-plan wave-1 contract):
//   query(text, params) — one-shot parameterized query on the pool
//   getClient()         — checked-out client for multi-statement work; caller MUST release()
//                         (src/db/tx.js withTransaction wraps this correctly — prefer it)
//   closePool()         — drain and close (tests, graceful shutdown)
'use strict';

const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
  connectionString: config.db.url,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// A pool emits 'error' for idle clients dropped by the server (e.g. PostgreSQL restart).
// Without a listener that event crashes the process; log it and let the pool replace the client.
pool.on('error', (err) => {
  logError('postgres pool: idle client error (client will be replaced)', err);
});

// Lazy logger lookup: src/lib/logger.js is U1-OBS's wave-1 module. It always exists at runtime
// after wave 1; the fallback keeps this module importable in isolation (e.g. scripts, early CI).
let _logger;
function logError(msg, err) {
  if (_logger === undefined) {
    try {
      _logger = require('../lib/logger');
    } catch {
      _logger = null;
    }
  }
  if (_logger && typeof _logger.error === 'function') {
    _logger.error({ err: err.message }, msg);
  } else {
    console.error(`${msg}: ${err.message}`);
  }
}

/**
 * Run one parameterized query on the pool (NFR-11: values go in `params`, never in `text`).
 * @param {string} text  SQL with $1..$n placeholders
 * @param {Array}  [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
function query(text, params) {
  if (typeof text !== 'string') {
    throw new TypeError('pool.query(text, params): text must be a SQL string');
  }
  return pool.query(text, params);
}

/**
 * Check out a dedicated client (transactions, LISTEN, FOR UPDATE flows).
 * The caller owns release(); prefer withTransaction() from src/db/tx.js.
 * @returns {Promise<import('pg').PoolClient>}
 */
function getClient() {
  return pool.connect();
}

/** Drain and close every connection. Used by tests and graceful shutdown. */
async function closePool() {
  await pool.end();
}

module.exports = { query, getClient, closePool, pool };
