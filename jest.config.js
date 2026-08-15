// Jest configuration — SRS §4.1 test protocol (Jest + Supertest against a seeded test database).
// U0-BOOTSTRAP toolchain substrate for NFR-02, NFR-08, NFR-11: every lane that verifies those
// requirements runs under this configuration. NOTE: `passWithNoTests` is intentionally NOT set —
// an empty suite must FAIL rather than pass vacuously (build-plan wave 0).
'use strict';

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  // tests/load holds k6 scripts that run under the k6 runtime, not Jest/Node.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/load/'],
  // Per-worker env defaults (test DB guard, mock adapter modes).
  setupFiles: ['<rootDir>/tests/helpers/env.js'],
  // Reproducible seed/teardown: globalSetup resets + migrates + seeds the *_test database,
  // flushes the test Redis DB and ensures the MinIO test bucket before every run.
  globalSetup: '<rootDir>/tests/helpers/globalSetup.js',
  globalTeardown: '<rootDir>/tests/helpers/globalTeardown.js',
  // One worker: every lane shares the single seeded test database, so parallel workers would
  // race on truncation/seed state. Determinism beats speed at this project scale (SRS §4.1).
  // maxWorkers only serializes WITHIN a run; simultaneously-launched runs are serialized by the
  // 'homeplate_test_suite' advisory lock that globalSetup takes before the schema reset and
  // globalTeardown releases (COV-W3-05 / verification-report F-1) — so a second `npm test`
  // queues instead of racing this one's outbox/worker state.
  // To run lanes in parallel instead, give each its own TEST_DATABASE_URL: the Redis DB index and
  // the media bucket are DERIVED from that database name (tests/helpers/env.js), because the
  // advisory lock is per-database and covers neither — two lanes on one Redis index flush each
  // other's live sessions (verification-report RTLT-01 / TCB-W3-07). TEST_REDIS_URL and
  // OBJECT_STORAGE_BUCKET may still be set explicitly; either way globalSetup claims both and
  // refuses to start when another lane already holds them.
  maxWorkers: 1,
  testTimeout: 15000,
  collectCoverageFrom: ['src/**/*.js', 'scripts/**/*.js', '!scripts/dev.js'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'json-summary'],
};
