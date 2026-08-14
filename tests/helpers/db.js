// tests/helpers/db.js — U1-DB: shared PostgreSQL test harness (SRS §4.1 — Jest + Supertest
// against a seeded test database). tests/helpers/env.js (Jest setupFiles) has already forced
// DATABASE_URL onto the guarded *_test database before this module loads.
//
// Requirement traceability: NFR-02/NFR-11 toolchain substrate; the factories below keep every
// lane's fixtures schema-correct (parameterized inserts only) so constraint tests exercise the
// REAL §3.4 invariants rather than hand-rolled SQL.
//
// Public surface for sibling units' tests:
//   query / getClient / withTransaction / closeDb — the app's own db layer, re-exported
//   makeUser / makeHostProfile / makeListing / makeBooking — minimal valid rows (RETURNING *)
//   countRows(table) — identifier-checked COUNT(*)
//   truncateAll() / reseedBase() — full reset back to the seeded base state
//   withRollback(fn) — run fn(client) in a transaction that ALWAYS rolls back (isolation)
'use strict';

const { query, getClient, closePool } = require('../../src/db/pool');
const { withTransaction } = require('../../src/db/tx');
const { seed, localDateFor } = require('../../scripts/seed');

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const quiet = { log: () => {}, warn: () => {} };

let seq = 0;
function nextSeq() {
  seq += 1;
  return seq;
}

function assertIdentifier(name) {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Unsafe SQL identifier: "${name}"`);
  }
  return name;
}

/** Parameterized single-row INSERT ... RETURNING * (NFR-11 — never interpolate values). */
async function insertRow(table, row, client = null) {
  assertIdentifier(table);
  const columns = Object.keys(row).map(assertIdentifier);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const values = columns.map((c) => row[c]);
  const sql = `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')})
               VALUES (${placeholders}) RETURNING *`;
  const result = client ? await client.query(sql, values) : await query(sql, values);
  return result.rows[0];
}

/**
 * Insert a minimal valid user. Defaults: verified email, unique address on the
 * dbunit.homeplate.invalid domain, fixture (non-loginable) password hash.
 */
async function makeUser(overrides = {}, client = null) {
  const n = nextSeq();
  return insertRow(
    'users',
    {
      email: `user${n}.${process.pid}.${Date.now()}@dbunit.homeplate.invalid`,
      email_verified: true,
      password_hash: 'test-helper-hash-not-a-real-password',
      full_name: `DB Test User ${n}`,
      can_reserve_seat: true,
      can_publish_listing: false,
      ...overrides,
    },
    client
  );
}

/** Insert a host profile for a user (creates the user when user_id is omitted). */
async function makeHostProfile(overrides = {}, client = null) {
  let userId = overrides.user_id;
  if (!userId) {
    const host = await makeUser({ can_publish_listing: true }, client);
    userId = host.id;
  }
  return insertRow(
    'host_profiles',
    {
      bio: 'Test helper host profile.',
      host_agreement_accepted_at: new Date(),
      ...overrides,
      user_id: userId,
    },
    client
  );
}

/**
 * Insert a minimal valid listing. Creates a host user when host_id is omitted. Defaults land
 * on a unique future America/Los_Angeles day per call (ADR-009 boundary timezone) so repeated
 * factory calls never trip the FR-11 daily-uniqueness index by accident.
 */
async function makeListing(overrides = {}, client = null) {
  let hostId = overrides.host_id;
  if (!hostId) {
    const host = await makeUser({ can_publish_listing: true }, client);
    hostId = host.id;
  }
  const n = nextSeq();
  // now + n×24h: each factory call lands on a later LA calendar day, so same-host defaults
  // never collide on the FR-11 daily-uniqueness index.
  const scheduledStart = overrides.scheduled_start ?? new Date(Date.now() + n * 24 * 3600 * 1000);
  return insertRow(
    'listings',
    {
      title: `Test Listing ${n}`,
      description: 'Test helper listing.',
      ingredients: ['rice', 'vegetables'],
      allergens: ['none'],
      cuisine: 'test',
      duration_minutes: 90,
      city: 'San Diego',
      region: 'CA',
      country: 'US',
      coarse_lat: 32.75,
      coarse_lng: -117.15,
      area_label: 'San Diego',
      seat_capacity: 4,
      seats_remaining: 4,
      ...overrides,
      host_id: hostId,
      scheduled_start: scheduledStart,
      local_date: overrides.local_date ?? localDateFor(new Date(scheduledStart)),
    },
    client
  );
}

/** Insert a minimal valid booking. Creates listing and guest when omitted. */
async function makeBooking(overrides = {}, client = null) {
  let listingId = overrides.listing_id;
  if (!listingId) {
    const listing = await makeListing({}, client);
    listingId = listing.id;
  }
  let guestId = overrides.guest_id;
  if (!guestId) {
    const guest = await makeUser({}, client);
    guestId = guest.id;
  }
  return insertRow(
    'bookings',
    {
      status: 'pending',
      ...overrides,
      listing_id: listingId,
      guest_id: guestId,
    },
    client
  );
}

/** COUNT(*) with an identifier-checked table name. */
async function countRows(table) {
  assertIdentifier(table);
  const { rows } = await query(`SELECT count(*)::int AS count FROM "${table}"`);
  return rows[0].count;
}

/**
 * TRUNCATE every application table (everything in public except schema_migrations),
 * discovering them dynamically so later waves' tables (e.g. outbox) are covered too.
 */
async function truncateAll() {
  const { rows } = await query(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`
  );
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"${assertIdentifier(r.tablename)}"`).join(', ');
  await query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

/** Reset the test database to the seeded base state (truncate + reseed base fixture). */
async function reseedBase() {
  await truncateAll();
  return seed({ set: 'base', log: quiet });
}

/**
 * Run fn(client) inside a transaction that ALWAYS rolls back — writes are invisible to other
 * tests. fn's resolved value is returned; its error is rethrown after rollback.
 */
async function withRollback(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}

/** Close the shared pool (call from afterAll so Jest can exit cleanly). */
async function closeDb() {
  await closePool();
}

module.exports = {
  query,
  getClient,
  withTransaction,
  insertRow,
  makeUser,
  makeHostProfile,
  makeListing,
  makeBooking,
  countRows,
  truncateAll,
  reseedBase,
  withRollback,
  closeDb,
};
