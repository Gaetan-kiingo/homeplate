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
