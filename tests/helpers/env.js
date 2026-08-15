// tests/helpers/env.js — canonical test environment (U0-BOOTSTRAP; SRS §4.1 protocol;
// toolchain substrate for NFR-02, NFR-08, NFR-11).
// Loaded both by Jest's globalSetup and as a per-worker setupFile; idempotent.
//
// Invariants:
//  - Tests NEVER touch the development database. DATABASE_URL is always derived from
//    TEST_DATABASE_URL (or the compose default) and its database name MUST end in "_test";
//    anything else throws before a single query runs.
//  - Redis uses a dedicated, non-zero DB index so flushing test state cannot clear dev
//    sessions (DB 0 is the developer's own; an index of 0 throws here).
//  - A LANE OWNS ITS RESOURCES AS A SET. The database name is the lane identity, and the Redis
//    DB index and the media bucket are DERIVED from it whenever they are not given explicitly —
//    a lane cannot half-isolate (own database, shared Redis) by forgetting an override.
//  - All external adapters run in mock mode: the suite asserts on persisted rows
//    (e.g. NOTIFICATION_ATTEMPT), never on a third party's behaviour (ADR-005/007/011). The
//    modes are PINNED here (not soft defaults) and src/config/schema.js refuses a non-mock
//    moderation/Maps/transport mode under NODE_ENV=test, so an exported variable cannot flip
//    the suite onto a live provider. Sole opt-in: ALLOW_LIVE_ADAPTERS_IN_TESTS=true, for the
//    wave-7 IT-03 measurement run only (see the adapter block below).
//  - CONCURRENCY RULE (verification-report F-1, RTLT-01, TCB-W3-07): requiring this file hands
//    you the lane's test-database/Redis/bucket coordinates — it does NOT serialize you against
//    a concurrently running Jest suite. Jest runs are serialized by the 'homeplate_test_suite'
//    advisory lock (globalSetup takes it, globalTeardown releases it). Any STANDALONE script —
//    `node -e`, a lane's ad-hoc harness, a CLI entry such as tests/rt-lt-resilience/lt01-run.js
//    — that reads or writes this database/Redis/bucket outside Jest MUST do one of:
//      (a) hold the same lock for its whole lifetime:
//            const { acquireSuiteLock } = require('./tests/helpers/env');
//            const lock = await acquireSuiteLock();   // blocks until any suite run finishes
//            try { /* … work … */ } finally { await lock.release(); }
//      (b) point at fully isolated resources instead: TEST_DATABASE_URL=…/homeplate_<lane>_test
//          (TEST_REDIS_URL and OBJECT_STORAGE_BUCKET are then derived from that name, or may be
//          overridden explicitly).
//    Skipping both corrupts in-flight suite state silently — e.g. an un-sabotaged sibling
//    process draining another lane's outbox drill jobs so its retry assertions see nothing.
//
//    ⚠ THE POSTGRESQL ADVISORY LOCK COVERS THE DATABASE ONLY. Its lock space is per-database,
//    so two lanes with different TEST_DATABASE_URLs never contend on it — and it says NOTHING
//    about Redis or object storage. Sharing a Redis index across lanes is silently destructive:
//    globalSetup FLUSHDBs the index it is given, which deletes the other lane's live
//    hp:session:* keys mid-run and turns every subsequent request into a 401 (observed as a
//    fabricated 99% NFR-01 error rate — verification-report RTLT-01). Redis has no eviction and
//    raises no error, so the damage is invisible. acquireSuiteLock() therefore also CLAIMS the
//    lane's Redis index and bucket (see claimLaneResources below) and aborts with an actionable
//    error instead of flushing a live sibling. Residual gap, by construction: the claim registry
//    lives on the PostgreSQL server, so lanes split across two PostgreSQL servers that share one
//    Redis host are still on their own.
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

const DEFAULT_TEST_DB_NAME = 'homeplate_test';
const DEFAULT_REDIS_DB_INDEX = 1;
const DEFAULT_MEDIA_BUCKET = 'homeplate-media-test';

/** The lane identity: the (guarded) test database name. Every other resource derives from it. */
const TEST_DB_NAME = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(
    `Refusing to run tests against database "${TEST_DB_NAME}" — the test database name must end ` +
      'in "_test" (set TEST_DATABASE_URL). This guard keeps the suite off dev data (SRS §4.1).'
  );
}

/**
 * FNV-1a (32-bit). Deterministic across processes and Node versions — the derivations below run
 * independently in globalSetup and in every Jest worker and MUST agree; a random or
 * PID-dependent choice would put the worker and the bootstrap on different Redis DBs.
 * @param {string} str
 * @returns {number} unsigned 32-bit hash
 */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Redis DB index for a lane. Derived — never a silent fallback to the shared default — so a lane
 * that overrides TEST_DATABASE_URL but forgets TEST_REDIS_URL still lands somewhere of its own
 * (RTLT-01). Range 2..15: index 0 is the developer's own DB and index 1 belongs to the default
 * lane, so a derived lane can collide with neither. Two derived lanes CAN still hash-collide —
 * 14 slots is a small space — which is why the collision is also checked at run time by
 * claimLaneResources() rather than assumed away.
 * @param {string} dbName
 * @returns {number}
 */
function laneRedisDbIndex(dbName) {
  if (dbName === DEFAULT_TEST_DB_NAME) return DEFAULT_REDIS_DB_INDEX;
  return 2 + (hash32(dbName) % 14);
}

/**
 * Media bucket for a lane, sanitised to S3/MinIO naming rules (lowercase alphanumerics and
 * hyphens, 3..63 chars) since database names legitimately contain underscores.
 * @param {string} dbName
 * @returns {string}
 */
function laneMediaBucket(dbName) {
  if (dbName === DEFAULT_TEST_DB_NAME) return DEFAULT_MEDIA_BUCKET;
  const slug = dbName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const name = `homeplate-media-${slug}`;
  return name.length <= 63 ? name : `${name.slice(0, 54)}-${hash32(dbName).toString(16)}`;
}

/**
 * @param {string} redisUrl
 * @returns {number} the DB index the URL selects (0 when it names none)
 */
function redisDbIndexOf(redisUrl) {
  const path = new URL(redisUrl).pathname.replace(/^\//, '');
  return path === '' ? 0 : Number(path);
}

// -- Redis: a DB index this lane owns ------------------------------------------------------------
// Explicit TEST_REDIS_URL wins (the operator may know which indexes are free); otherwise the index
// is derived from the lane's database name. Either way it is validated: DB 0 holds the developer's
// own sessions and globalSetup FLUSHDBs whatever index it is handed, so an index of 0 — or a URL
// with no index at all, which Redis resolves to 0 — must fail loudly before any flush happens.
process.env.REDIS_URL =
  process.env.TEST_REDIS_URL || `redis://localhost:6379/${laneRedisDbIndex(TEST_DB_NAME)}`;
const TEST_REDIS_DB_INDEX = redisDbIndexOf(process.env.REDIS_URL);
if (!Number.isInteger(TEST_REDIS_DB_INDEX) || TEST_REDIS_DB_INDEX < 1) {
  throw new Error(
    `Refusing to run tests against Redis DB index ${TEST_REDIS_DB_INDEX} ("${process.env.REDIS_URL}") — ` +
      'the suite FLUSHDBs its index on every run, and DB 0 is the development database. ' +
      'Give TEST_REDIS_URL an explicit non-zero index, e.g. redis://localhost:6379/2.'
  );
}

// -- Config requirements (values are test-only, never real secrets) ------------------------------
defaultTo(
  'FIELD_ENCRYPTION_KEY',
  'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
);
defaultTo('OBJECT_STORAGE_ENDPOINT', 'http://localhost:9000');
// Derived from the lane, not a fixed shared default: two lanes writing media into one bucket
// delete each other's objects through the ADR-004 per-object-deletion paths (NFR-12 tests).
defaultTo('OBJECT_STORAGE_BUCKET', laneMediaBucket(TEST_DB_NAME));
defaultTo('OBJECT_STORAGE_ACCESS_KEY', 'minioadmin');
defaultTo('OBJECT_STORAGE_SECRET_KEY', 'minioadmin');

// Supertest drives the Express app directly; transport enforcement is exercised by its own
// dedicated tests and fails closed in production (build-plan §2, NFR-03).
defaultTo('ENFORCE_HTTPS', 'false');

// -- Mock adapters only in the automated suite (ADR-005, ADR-007, ADR-011) -----------------------
// These are HARD assignments, not defaultTo(): a soft default is overridden by anything already
// exported in the shell, so a leftover `LLM_MODERATION_MODE=live` (or `MAPS_MODE=live`) from a
// wave-7 IT-03 measurement session would have sent the WHOLE suite — and CI, which sets no
// adapter variables at all — at the third-party providers. ADR-007: "CI and the automated suite
// use a deterministic MOCK adapter; only the IT-03 measurement run may call the live API."
//
// The single documented opt-in is ALLOW_LIVE_ADAPTERS_IN_TESTS=true (IT-03 only), which also
// unlocks the matching guard in src/config/schema.js; the spelling must be exactly 'true' there,
// so the same comparison is used here rather than a looser truthiness test. The ADR-011 mock
// transport has no opt-in — the suite asserts on persisted NOTIFICATION_ATTEMPT rows, never on a
// third party's behaviour — so it is pinned unconditionally.
const ALLOW_LIVE_ADAPTERS = process.env.ALLOW_LIVE_ADAPTERS_IN_TESTS === 'true';

process.env.NOTIFICATIONS_TRANSPORT = 'mock';
defaultTo('NOTIFICATIONS_PUSH_ENABLED', 'false');
if (ALLOW_LIVE_ADAPTERS) {
  // IT-03 measurement run: the operator supplies the modes and provider variables explicitly
  // (and records MODERATION_MODEL with the result — ADR-007). Still mock unless they do.
  defaultTo('MAPS_MODE', 'mock');
  defaultTo('LLM_MODERATION_MODE', 'mock');
} else {
  process.env.MAPS_MODE = 'mock';
  process.env.LLM_MODERATION_MODE = 'mock';
}

// -- Lane descriptor: the full set of resources this process will touch --------------------------
const LANE = Object.freeze({
  database: TEST_DB_NAME,
  redisUrl: process.env.REDIS_URL,
  redisDbIndex: TEST_REDIS_DB_INDEX,
  bucket: process.env.OBJECT_STORAGE_BUCKET,
});

/** One-line, log-friendly rendering of the lane's coordinates (printed by globalSetup). */
function describeLane() {
  return `lane "${LANE.database}" (redis db ${LANE.redisDbIndex}, bucket ${LANE.bucket})`;
}

// -- Suite advisory lock (single source of truth — see CONCURRENCY RULE above) -------------------
// Everything that serializes on the shared test database keys off this ONE name; Jest's
// globalSetup and standalone scripts both go through acquireSuiteLock() so the key and the
// wait semantics can never drift apart (verification-report F-1).
const SUITE_LOCK_NAME = 'homeplate_test_suite';

// -- Lane resource registry (Redis index + media bucket) -----------------------------------------
// The suite lock above is scoped to ONE database, which is exactly what makes it useless for
// Redis and object storage: two lanes with different TEST_DATABASE_URLs take it without
// contending, then both FLUSHDB the same Redis index (RTLT-01 / TCB-W3-07). The registry closes
// that hole by claiming the non-database resources on a lock space every lane shares — the
// server's 'postgres' maintenance database, which globalSetup already connects to in order to
// create the lane database, so the claim needs no new infrastructure and no new credentials.
//
// Session-scoped advisory locks were chosen over a Redis marker key deliberately:
//   - liveness is exact. The claim dies with the process, so a crashed lane never leaves a stale
//     lease that blocks the next run (a TTL key would, and refreshing one needs a connection held
//     open in Jest's main process, which stalls Jest's exit).
//   - the test Redis keyspace stays pristine. tests/adr-conformance/* assert that EVERY key in
//     the index matches /^hp:(session|ratelimit|cache):/ — a marker key would either break those
//     assertions or hide in a namespace that tests/helpers/redis.js flushNamespace() wipes
//     mid-run, which would silently un-claim the lane.
const LANE_REGISTRY_DATABASE = 'postgres';
// Distinct advisory-lock classes so a Redis-index claim can never be mistaken for a bucket claim
// (pg_advisory_lock's two-int form partitions the space; no hashing needed for the index itself).
const LANE_LOCK_CLASS_REDIS = 748301;
const LANE_LOCK_CLASS_BUCKET = 748302;

/**
 * Claim this lane's Redis DB index and media bucket for the lifetime of the returned client.
 *
 * Both claims are `pg_try_advisory_lock` — non-blocking on purpose. Waiting would be wrong: the
 * caller is about to destroy the resource (FLUSHDB / schema reset), so the only safe answers are
 * "it is mine" or "stop, pick another index". A failed claim throws BEFORE any flush.
 *
 * If the registry itself is unreachable the run continues with a loud warning rather than
 * failing: the check is a safety net around a shared host, not a requirement of the test protocol.
 *
 * @param {{databaseUrl?: string, log?: {warn: (msg: string) => void}}} [options]
 * @returns {Promise<import('pg').Client|null>} the holding client (null when unavailable)
 */
async function claimLaneResources({ databaseUrl = process.env.DATABASE_URL, log = console } = {}) {
  const { Client } = require('pg');
  const registryUrl = new URL(databaseUrl);
  registryUrl.pathname = `/${LANE_REGISTRY_DATABASE}`;
  const client = new Client({
    connectionString: registryUrl.toString(),
    connectionTimeoutMillis: 4000,
  });
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => {});
    log.warn(
      `env.js: could not reach the lane registry database "${LANE_REGISTRY_DATABASE}" ` +
        `(${err.message}) — continuing WITHOUT the Redis/bucket collision check. Make sure no ` +
        `other test run uses ${describeLane()}.`
    );
    return null;
  }
  try {
    const redisClaim = await client.query(
      'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
      [LANE_LOCK_CLASS_REDIS, LANE.redisDbIndex]
    );
    if (!redisClaim.rows[0].locked) {
      throw new Error(
        `Redis DB index ${LANE.redisDbIndex} is already claimed by another Homeplate test run on ` +
          `this host. Starting ${describeLane()} would FLUSHDB it and delete that run's live ` +
          "sessions mid-flight (verification-report RTLT-01: a sibling lane's flush produced a " +
          'fabricated 99% NFR-01 error rate). The "homeplate_test_suite" PostgreSQL advisory lock ' +
          'is per-database and does NOT cover Redis or object storage. Fix: point this lane at a ' +
          'free index, e.g. TEST_REDIS_URL=redis://localhost:6379/<n> with n in 2..15 (check with ' +
          '`redis-cli info keyspace`), or wait for the other run to finish.'
      );
    }
    const bucketClaim = await client.query(
      'SELECT pg_try_advisory_lock($1::int, hashtext($2::text)) AS locked',
      [LANE_LOCK_CLASS_BUCKET, LANE.bucket]
    );
    if (!bucketClaim.rows[0].locked) {
      throw new Error(
        `Object-storage bucket "${LANE.bucket}" is already claimed by another Homeplate test run ` +
          `on this host. Two lanes sharing one bucket delete each other's media objects through ` +
          'the ADR-004 deletion paths (NFR-12). Fix: give this lane its own bucket, e.g. ' +
          'OBJECT_STORAGE_BUCKET=homeplate-media-<lane>, or wait for the other run to finish.'
      );
    }
  } catch (err) {
    await client.end().catch(() => {}); // ending the session releases whatever was claimed
    throw err;
  }
  return client;
}

/**
 * Take the suite advisory lock on the (guarded *_test) database, then claim the lane's Redis DB
 * index and media bucket. Blocks until any concurrent holder of the DATABASE — a full Jest run or
 * another standalone script — finishes; then fails fast if a DIFFERENT lane is already using this
 * lane's Redis index or bucket. Both locks are session-scoped: they live exactly as long as the
 * returned clients' connections, so hold the handle for your script's whole lifetime and
 * `await lock.release()` (or let globalTeardown end it) when done. PostgreSQL frees both
 * automatically if the process dies.
 *
 * Order matters: the database lock is taken FIRST, so two runs of the SAME lane queue up as
 * before instead of aborting each other on the Redis claim.
 *
 * @param {{databaseUrl?: string, onWait?: () => void, claimResources?: boolean,
 *          log?: {warn: (msg: string) => void}}} [options]
 *   onWait fires once if the lock is contended, before blocking.
 *   claimResources (default true) may be disabled only for a process that touches the database
 *   alone — never for one that flushes Redis or writes media.
 * @returns {Promise<{client: import('pg').Client, registryClient: import('pg').Client|null,
 *                    lane: typeof LANE, release: () => Promise<void>}>}
 */
async function acquireSuiteLock({
  databaseUrl = process.env.DATABASE_URL,
  onWait,
  claimResources = true,
  log = console,
} = {}) {
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
  let registryClient = null;
  if (claimResources) {
    try {
      registryClient = await claimLaneResources({ databaseUrl, log });
    } catch (err) {
      await client.end().catch(() => {}); // never hold the database lock after refusing to start
      throw err;
    }
  }
  let released = false;
  return {
    client,
    registryClient,
    lane: LANE,
    async release() {
      if (released) return;
      released = true;
      // Ending a session releases every session-scoped advisory lock it holds.
      if (registryClient) await registryClient.end().catch(() => {});
      await client.end();
    },
  };
}

module.exports = { SUITE_LOCK_NAME, LANE, describeLane, acquireSuiteLock, claimLaneResources };
