// tests/helpers/globalSetup.js — reproducible seeded-test-database bootstrap (U0-BOOTSTRAP;
// SRS §4.1). Runs once before the whole Jest run:
//   1. ensure the *_test database exists (created on first run against a fresh volume)
//   2. take the suite lock on that database AND claim this lane's Redis index + media bucket,
//      so steps 3 and 5 can only ever destroy state this run owns
//   3. reset it (DROP SCHEMA public CASCADE) unless TEST_KEEP_DB=1 — every run starts pristine
//   4. apply db/migrations/*.sql, then load the "base" fixture set (scripts/seed.js)
//   5. flush this lane's Redis DB index
//   6. ensure the lane's MinIO bucket exists (ADR-004)
// Infra down => one actionable error, not a wall of per-test failures.
// Escape hatch for offline pure-unit iteration ONLY (never CI): TEST_SKIP_INFRA=1.
'use strict';

const { acquireSuiteLock, describeLane } = require('./env');

const { Client } = require('pg');
const Redis = require('ioredis');
const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
const { runMigrations } = require('../../scripts/migrate');
const { seed } = require('../../scripts/seed');

const quiet = { log: () => {}, warn: (msg) => console.warn(msg) };

function infraError(what, err) {
  return new Error(
    `Test bootstrap could not reach ${what} (${err.message}). ` +
      'Start the local stack first: docker compose up -d --wait'
  );
}

async function ensureDatabase(databaseUrl) {
  const url = new URL(databaseUrl);
  const dbName = url.pathname.replace(/^\//, '');
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = new Client({
    connectionString: adminUrl.toString(),
    connectionTimeoutMillis: 4000,
  });
  try {
    await admin.connect();
  } catch (err) {
    throw infraError('PostgreSQL', err);
  }
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length === 0) {
      // Identifier is derived from the guarded *_test URL, not user input.
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`globalSetup: created database ${dbName}`);
    }
  } catch (err) {
    if (err.code !== '42P04') throw err; // 42P04 = duplicate_database (concurrent creator)
  } finally {
    await admin.end();
  }
}

// Serializes whole Jest runs that share one test database (verification-report F-1): a second
// runner blocks here until the first run's globalTeardown releases the session-scoped lock, so
// its schema reset can never land under another run's live queries. Advisory lock space is
// per-database, so runs isolated via TEST_DATABASE_URL never contend THERE — which is precisely
// why acquireSuiteLock also claims this lane's Redis DB index and media bucket (RTLT-01): those
// are shared per HOST, not per database, and step 5's FLUSHDB is destructive. A different lane
// already holding either claim aborts the run here, before anything is flushed, instead of
// silently deleting that lane's live sessions. Both locks live in tests/helpers/env.js so
// standalone non-Jest scripts claim on the SAME keys — see the CONCURRENCY RULE there.
//
// The connections must stay open for the whole run: the handle stashed on globalThis exposes the
// end() that globalTeardown already calls, and releases the database lock and the resource claims
// together.
async function acquireJestSuiteLock(databaseUrl) {
  const lock = await acquireSuiteLock({
    databaseUrl,
    onWait: () =>
      console.warn(
        'globalSetup: test database is locked by another suite run — waiting for it to finish ' +
          '(give each parallel lane its own TEST_DATABASE_URL; the Redis index and bucket are ' +
          'then derived from it, or set TEST_REDIS_URL/OBJECT_STORAGE_BUCKET explicitly)'
      ),
  });
  globalThis.__HOMEPLATE_SUITE_LOCK_CLIENT__ = { end: () => lock.release() };
}

async function resetSchema(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 4000 });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
}

async function flushTestRedis(redisUrl) {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: 4000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
  } catch (err) {
    throw infraError('Redis', err);
  }
  try {
    // Safe because acquireJestSuiteLock has CLAIMED this index for this lane: no other test run
    // can be holding sessions here. FLUSHDB (rather than deleting only the hp: namespaces) is
    // deliberate — tests/adr-conformance/* assert that the whole keyspace matches
    // /^hp:(session|ratelimit|cache):/, so a partial flush would leave foreign keys that fail
    // those checks instead of the pristine index SRS §4.1 reproducibility asks for.
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

async function ensureTestBucket() {
  const s3 = new S3Client({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
    region: process.env.OBJECT_STORAGE_REGION || 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY,
      secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY,
    },
  });
  try {
    await s3.send(new CreateBucketCommand({ Bucket: process.env.OBJECT_STORAGE_BUCKET }));
    console.log(`globalSetup: created bucket ${process.env.OBJECT_STORAGE_BUCKET}`);
  } catch (err) {
    if (err.name === 'BucketAlreadyOwnedByYou' || err.name === 'BucketAlreadyExists') return;
    throw infraError('MinIO object storage', err);
  } finally {
    s3.destroy();
  }
}

module.exports = async function globalSetup() {
  if (process.env.TEST_SKIP_INFRA === '1') {
    console.warn(
      'globalSetup: TEST_SKIP_INFRA=1 — skipping DB/Redis/MinIO bootstrap. ' +
        'Only pure-unit tests are trustworthy in this mode; never use it in CI.'
    );
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  await ensureDatabase(databaseUrl);
  await acquireJestSuiteLock(databaseUrl);
  // Printed before anything destructive runs, so a mis-set lane is visible in the log of the run
  // that caused the damage rather than only in the victim's failures (TCB-W3-07).
  console.log(`globalSetup: claimed ${describeLane()}`);
  if (process.env.TEST_KEEP_DB !== '1') {
    await resetSchema(databaseUrl);
  }
  const { onDisk, applied } = await runMigrations({ databaseUrl, log: quiet });
  const seeded = await seed({ databaseUrl, set: 'base', log: quiet });
  await flushTestRedis(process.env.REDIS_URL);
  await ensureTestBucket();
  console.log(
    `globalSetup: test database ready (${onDisk} migration(s), ${applied.length} applied this run, ` +
      `${seeded.rows} seed row(s)); ${describeLane()} flushed and ready`
  );
};
