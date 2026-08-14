// tests/helpers/env.js — canonical test environment (U0-BOOTSTRAP; SRS §4.1 protocol;
// toolchain substrate for NFR-02, NFR-08, NFR-11).
// Loaded both by Jest's globalSetup and as a per-worker setupFile; idempotent.
//
// Invariants:
//  - Tests NEVER touch the development database. DATABASE_URL is always derived from
//    TEST_DATABASE_URL (or the compose default) and its database name MUST end in "_test";
//    anything else throws before a single query runs.
//  - Redis uses a dedicated DB index (…/1) so flushing test state cannot clear dev sessions.
//  - All external adapters run in mock mode: the suite asserts on persisted rows
//    (e.g. NOTIFICATION_ATTEMPT), never on a third party's behaviour (ADR-007, ADR-011).
//  - CONCURRENCY RULE (verification-report F-1): requiring this file hands you the SHARED
//    test-database coordinates — it does NOT serialize you against a concurrently running
//    Jest suite. Jest runs are serialized by the 'homeplate_test_suite' advisory lock
//    (globalSetup takes it, globalTeardown releases it). Any STANDALONE script — `node -e`,
//    a lane's ad-hoc harness, a CLI entry such as tests/rt-lt-resilience/lt01-run.js — that
//    reads or writes this database/Redis/bucket outside Jest MUST do one of:
//      (a) hold the same lock for its whole lifetime:
//            const { acquireSuiteLock } = require('./tests/helpers/env');
//            const lock = await acquireSuiteLock();   // blocks until any suite run finishes
//            try { /* … work … */ } finally { await lock.release(); }
//      (b) point at fully isolated resources instead (no lock needed — advisory-lock space
//          is per-database): TEST_DATABASE_URL=…/homeplate_<lane>_test plus matching
//          TEST_REDIS_URL and OBJECT_STORAGE_BUCKET overrides.
//    Skipping both corrupts in-flight suite state silently — e.g. an un-sabotaged sibling
//    process draining another lane's outbox drill jobs so its retry assertions see nothing.
'use strict';

process.env.NODE_ENV = 'test';

function defaultTo(key, value) {
  if (process.env[key] === undefined || process.env[key] === '') {
    process.env[key] = value;
  }
}

// -- PostgreSQL: forced to the test database, guarded --------------------------------------------
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://homeplate:homeplate@localhost:5432/homeplate_test';
{
  const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against database "${dbName}" — the test database name must end ` +
        'in "_test" (set TEST_DATABASE_URL). This guard keeps the suite off dev data (SRS §4.1).'
    );
  }
}

// -- Redis: isolated DB index --------------------------------------------------------------------
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379/1';

// -- Config requirements (values are test-only, never real secrets) ------------------------------
defaultTo(
  'FIELD_ENCRYPTION_KEY',
  'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
);
defaultTo('OBJECT_STORAGE_ENDPOINT', 'http://localhost:9000');
defaultTo('OBJECT_STORAGE_BUCKET', 'homeplate-media-test');
defaultTo('OBJECT_STORAGE_ACCESS_KEY', 'minioadmin');
defaultTo('OBJECT_STORAGE_SECRET_KEY', 'minioadmin');

// Supertest drives the Express app directly; transport enforcement is exercised by its own
// dedicated tests and fails closed in production (build-plan §2, NFR-03).
defaultTo('ENFORCE_HTTPS', 'false');

// Mock adapters only in the automated suite (ADR-007 mock in CI; ADR-011 mock transport).
defaultTo('NOTIFICATIONS_TRANSPORT', 'mock');
defaultTo('NOTIFICATIONS_PUSH_ENABLED', 'false');
defaultTo('MAPS_MODE', 'mock');
defaultTo('LLM_MODERATION_MODE', 'mock');

// -- Suite advisory lock (single source of truth — see CONCURRENCY RULE above) -------------------
// Everything that serializes on the shared test database keys off this ONE name; Jest's
// globalSetup and standalone scripts both go through acquireSuiteLock() so the key and the
// wait semantics can never drift apart (verification-report F-1).
const SUITE_LOCK_NAME = 'homeplate_test_suite';

/**
 * Take the suite advisory lock on the (guarded *_test) database. Blocks until any concurrent
 * holder — a full Jest run or another standalone script — finishes. The lock is session-scoped:
 * it lives exactly as long as the returned client's connection, so hold the handle for your
 * script's whole lifetime and `await lock.release()` (or let globalTeardown end the client)
 * when done. PostgreSQL frees the lock automatically if the process dies.
 *
 * @param {{databaseUrl?: string, onWait?: () => void}} [options]
 *   onWait fires once if the lock is contended, before blocking.
 * @returns {Promise<{client: import('pg').Client, release: () => Promise<void>}>}
 */
async function acquireSuiteLock({ databaseUrl = process.env.DATABASE_URL, onWait } = {}) {
  // Lazy require: loading env.js itself must stay dependency-light for pure-unit contexts.
  const { Client } = require('pg');
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 4000 });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [
      SUITE_LOCK_NAME,
    ]);
    if (!rows[0].locked) {
      if (onWait) onWait();
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [SUITE_LOCK_NAME]);
    }
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
  let released = false;
  return {
    client,
    async release() {
      if (released) return;
      released = true;
      await client.end(); // ending the session releases the session-scoped advisory lock
    },
  };
}

module.exports = { SUITE_LOCK_NAME, acquireSuiteLock };
