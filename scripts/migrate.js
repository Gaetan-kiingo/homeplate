// scripts/migrate.js — migration runner (U1-DB surface, scaffolded by U0-BOOTSTRAP).
// Applies db/migrations/*.sql in filename order inside individual transactions and records
// each in schema_migrations. db/migrations is the source of truth for the SRS §3.4 schema.
// Parameterized SQL everywhere else in the app (NFR-11); migration files are static DDL from
// the repository, never user input.
//
// Usage:  node scripts/migrate.js            (uses DATABASE_URL)
// API:    const { runMigrations, listMigrations } = require('./scripts/migrate');
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// Same env-file policy as src/config: `.env` supplies dev values (dotenv never overrides
// variables already set); under NODE_ENV=test the environment comes from tests/helpers/env.js.
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
// Advisory lock so two concurrent runners (dev + test, CI matrix) never interleave DDL.
const MIGRATION_LOCK_KEY = 727274;

/**
 * List migration files, validating naming, uniqueness and ordering.
 * Format: NNNN_snake_case_name.sql (four-digit version, unique, ascending).
 * Throws on any malformed or duplicate version so a bad file fails the build (check-build.js).
 */
function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const seen = new Map();
  const migrations = files.map((file) => {
    const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
    if (!match) {
      throw new Error(`Malformed migration filename "${file}" — expected NNNN_snake_case_name.sql`);
    }
    const [, version, name] = match;
    if (seen.has(version)) {
      throw new Error(
        `Duplicate migration version ${version}: "${seen.get(version)}" and "${file}"`
      );
    }
    seen.set(version, file);
    return { version, name, file, fullPath: path.join(MIGRATIONS_DIR, file) };
  });
  return migrations;
}

/**
 * Apply all unapplied migrations to `databaseUrl`. Idempotent: applied versions are recorded
 * in schema_migrations and skipped on the next run. Each file runs in its own transaction, so
 * a failing migration rolls back completely and stops the run.
 */
async function runMigrations({ databaseUrl = process.env.DATABASE_URL, log = console } = {}) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set — cannot run migrations (see .env.example)');
  }
  const migrations = listMigrations();
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  const appliedNow = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        name        text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.version));

    // Drift check: a recorded version with no file on disk means the tree and the database
    // disagree — surface it loudly (it usually means a renamed or deleted migration).
    const onDisk = new Set(migrations.map((m) => m.version));
    for (const version of applied) {
      if (!onDisk.has(version)) {
        log.warn(
          `schema_migrations has version ${version} with no matching file in db/migrations — ` +
            'database was migrated from a different tree'
        );
      }
    }

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      const sql = fs.readFileSync(migration.fullPath, 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
          migration.version,
          migration.name,
        ]);
        await client.query('COMMIT');
        appliedNow.push(migration.file);
        log.log(`applied ${migration.file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${migration.file} failed: ${err.message}`);
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } finally {
      await client.end();
    }
  }
  log.log(
    `migrations: ${migrations.length} on disk, ${appliedNow.length} newly applied, ` +
      `${migrations.length - appliedNow.length} already applied`
  );
  return { onDisk: migrations.length, applied: appliedNow };
}

if (require.main === module) {
  // CLI failure path (message on stderr, exit 1). It runs only when this file is the main
  // module, so it reports zero in-process coverage hits (COV-W3-06); its exercise record is
  // the spawn test tests/coverage/migrate-cli.test.js, per the coverage lane's convention
  // for child-process-only paths (NFR-08).
  runMigrations().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { runMigrations, listMigrations, MIGRATIONS_DIR };
