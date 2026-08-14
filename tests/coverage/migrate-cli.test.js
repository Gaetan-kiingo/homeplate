// tests/coverage/migrate-cli.test.js — COVERAGE lane, COV-W3-06 residue hardening.
//
// scripts/migrate.js:124 — the `require.main` CLI failure path (.catch → message on stderr,
// exit 1) — showed zero in-process hits: it only executes when the script runs as a main
// module, and child-process execution is invisible to Jest instrumentation (the same
// situation as the src/server.js shutdown test in coverage-lane.test.js §4). This spawn test
// is that path's exercise record: invoked with no DATABASE_URL the CLI must print the
// actionable message from runMigrations() and exit 1 — never hang, never exit 0 with a
// half-migrated database. Traceability: NFR-08 (verified build/tooling substrate).
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

describe('coverage lane — scripts/migrate.js CLI failure path (COV-W3-06)', () => {
  test('with DATABASE_URL unset the CLI prints the actionable error and exits 1', () => {
    const env = { ...process.env };
    // NODE_ENV=test keeps migrate.js from loading .env (which would re-supply DATABASE_URL);
    // with the variable deleted, runMigrations() rejects immediately and the .catch fires.
    env.NODE_ENV = 'test';
    delete env.DATABASE_URL;
    const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate.js')], {
      env,
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('DATABASE_URL is not set');
  });
});
