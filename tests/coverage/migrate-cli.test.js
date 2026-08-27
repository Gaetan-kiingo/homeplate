// tests/coverage/migrate-cli.test.js — COVERAGE lane, COV-W3-06 residue hardening
// (extended by COV-W6-10 with the scripts/seed.js CLI twins).
//
// scripts/migrate.js:124 — the `require.main` CLI failure path (.catch → message on stderr,
// exit 1) — showed zero in-process hits: it only executes when the script runs as a main
// module, and child-process execution is invisible to Jest instrumentation (the same
// situation as the src/server.js shutdown test in coverage-lane.test.js §4). This spawn test
// is that path's exercise record: invoked with no DATABASE_URL the CLI must print the
// actionable message from runMigrations() and exit 1 — never hang, never exit 0 with a
// half-migrated database. Traceability: NFR-08 (verified build/tooling substrate).
//
// COV-W6-10: scripts/seed.js has the same child-process-only block (lines 381-394) and its
// two failure branches likewise showed zero hits — the `--set`-without-a-value usage error
// and the seed().catch exit-1 path. Both get spawn exercise records here, in this file,
// because this is the coverage lane's canonical CLI-path suite. Note the deliberate
// asymmetry: `--set <unknown-name>` is NOT a failure by design (seed() reports "nothing to
// do" and resolves), so the failing inputs below are a valueless --set flag and a missing
// DATABASE_URL respectively.
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

/** Spawn a script from scripts/ with NODE_ENV=test and DATABASE_URL removed. */
function spawnCli(script, args = []) {
  const env = { ...process.env };
  // NODE_ENV=test keeps the script from loading .env (which would re-supply DATABASE_URL);
  // with the variable deleted, no spawn in this file can ever reach a real database.
  env.NODE_ENV = 'test';
  delete env.DATABASE_URL;
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    env,
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10000,
  });
}

describe('coverage lane — scripts/migrate.js CLI failure path (COV-W3-06)', () => {
  test('with DATABASE_URL unset the CLI prints the actionable error and exits 1', () => {
    const res = spawnCli('migrate.js');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('DATABASE_URL is not set');
  });
});

describe('coverage lane — scripts/seed.js CLI failure paths (COV-W6-10)', () => {
  test('`--set` with no value prints the usage line and exits 1', () => {
    const res = spawnCli('seed.js', ['--set']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('Usage: node scripts/seed.js [--set <name> | --volume]');
  });

  test('with DATABASE_URL unset the seed().catch path prints the actionable error and exits 1', () => {
    const res = spawnCli('seed.js');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('DATABASE_URL is not set');
  });
});
