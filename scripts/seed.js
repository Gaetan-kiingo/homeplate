// scripts/seed.js — seed runner (U1-DB).
//
// Two modes:
//   fixture — loads tests/fixtures/seed/<set>.json (or every .json inside
//             tests/fixtures/seed/<set>/) and inserts rows table-by-table, in declared order,
//             with parameterized SQL (NFR-11). Inserts use ON CONFLICT DO NOTHING with
//             deterministic fixture IDs, so reseeding is idempotent — the reproducible-seed
//             property the SRS §4.1 test protocol depends on. `npm run seed` loads "base".
//   volume  — `npm run seed:volume` (or `node scripts/seed.js --volume`) GENERATES the NFR-02
//             scale dataset instead of reading a fixture file: >= 10,000 users, >= 1,000
//             host profiles, >= 1,000 approved listings all on ONE America/Los_Angeles
//             calendar day, and >= 1,000 pending bookings for that day (LT-02 substrate).
//             Deterministic IDs make it idempotent too.
//
// Requirement traceability (SRS Appendix B): NFR-02 (volume targets), NFR-11 (parameterized
// SQL only), FR-11/AB-07 (volume listings honour one-listing-per-host-per-day: 1,000 listings
// come from 1,000 distinct hosts), ADR-009 (local_date derives from the configured
// America/Los_Angeles boundary timezone via src/config/locale — never hardcoded here),
// ADR-010 (volume listings carry coarse public-precision coordinates alongside precise ones).
//
// Fixture format (JSON object; key order = insert order):
//   { "users": [ { "id": "...", "email": "..." } ], "listings": [ ... ] }
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
// Pure frozen policy module (no env validation) — the ONE home of the boundary timezone (ADR-009).
const locale = require('../src/config/locale');

// Same env-file policy as src/config: `.env` supplies dev values (dotenv never overrides
// variables already set); under NODE_ENV=test the environment comes from tests/helpers/env.js.
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const SEED_DIR = path.join(__dirname, '..', 'tests', 'fixtures', 'seed');
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

// NFR-02 acceptance floor: ">= 10,000 registered users and 1,000 active dinner
// listings/bookings per day".
const VOLUME_TARGETS = Object.freeze({
  users: 10000,
  hostProfiles: 1000,
  listings: 1000,
  bookings: 1000,
});

// The single LA calendar day every volume listing/booking lands on (deterministic for LT-02).
const VOLUME_DAY_BASE = new Date('2026-09-15T17:00:00-07:00');

/**
 * Calendar date (YYYY-MM-DD) of an instant in the configured operating timezone (ADR-009 —
 * America/Los_Angeles, never UTC, never the caller's timezone).
 * @param {Date} date
 * @param {string} [timeZone]
 * @returns {string}
 */
function localDateFor(date, timeZone = locale.timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function quoteIdent(name) {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Unsafe SQL identifier in fixture: "${name}"`);
  }
  return `"${name}"`;
}

/** Resolve the .json files that make up a seed set; [] when the set does not exist yet. */
function listFixtureFiles(set) {
  const single = path.join(SEED_DIR, `${set}.json`);
  const dir = path.join(SEED_DIR, set);
  if (fs.existsSync(single)) return [single];
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join(dir, f));
  }
  return [];
}

async function insertRows(client, table, rows) {
  let inserted = 0;
  for (const row of rows) {
    const columns = Object.keys(row);
    if (columns.length === 0) continue;
    const columnSql = columns.map(quoteIdent).join(', ');
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const values = columns.map((c) => {
      const v = row[c];
      // JS arrays pass through: node-postgres serializes them as PostgreSQL arrays (text[]
      // columns like users.roles / listings.ingredients). Plain objects become JSON text for
      // jsonb columns (e.g. notification_attempts.params).
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(v);
      return v;
    });
    const result = await client.query(
      `INSERT INTO ${quoteIdent(table)} (${columnSql}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      values
    );
    inserted += result.rowCount;
  }
  return inserted;
}

// ---- volume generation (NFR-02) --------------------------------------------------------------

/** Deterministic v4-shaped UUID from a block prefix and a counter (idempotent reseeds). */
function volumeUuid(block, n) {
  return `${block}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/**
 * Multi-row parameterized INSERT ... ON CONFLICT DO NOTHING (NFR-11 — values only ever travel
 * as parameters). `rows` is an array of arrays aligned with `columns`.
 * @returns {Promise<number>} rows actually inserted
 */
async function batchInsert(client, table, columns, rows) {
  if (rows.length === 0) return 0;
  const columnSql = columns.map(quoteIdent).join(', ');
  let inserted = 0;
  // ~1000 rows per statement keeps parameter counts (rows × columns) far below pg's 65535 cap.
  const chunkSize = Math.max(1, Math.floor(60000 / columns.length / 100) * 100);
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const values = [];
    const tuples = chunk.map((row, r) => {
      const placeholders = row.map((v, c) => {
        values.push(v);
        return `$${r * columns.length + c + 1}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const result = await client.query(
      `INSERT INTO ${quoteIdent(table)} (${columnSql}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
      values
    );
    inserted += result.rowCount;
  }
  return inserted;
}

/**
 * Generate the NFR-02 volume dataset directly into the connected database:
 *   users[0..999]      → hosts (verified, canPublishListing) with host_profiles
 *   users[1000..1999]  → guests holding the volume-day bookings
 *   users[2000..9999]  → registered browsing population
 * 1,000 approved active listings, one per host, ALL on the same America/Los_Angeles calendar
 * day (VOLUME_DAY_BASE staggered 17:00–20:00 LA) so FR-11's one-listing-per-host-per-day
 * uniqueness holds by construction; 1,000 pending bookings, one per listing, each already
 * reflected in seats_remaining = seat_capacity - 1 (FR-12 consistency).
 * @returns {Promise<{tables: number, rows: number, counts: object}>}
 */
async function seedVolume(client, log = console) {
  const cuisines = [
    'mexican',
    'vietnamese',
    'italian',
    'ethiopian',
    'indian',
    'japanese',
    'american',
    'thai',
  ];

  // users — password_hash is an inert fixture marker, NOT a stored plaintext password (NFR-04);
  // no volume account is loginable.
  const userColumns = [
    'id',
    'email',
    'email_verified',
    'password_hash',
    'full_name',
    'can_reserve_seat',
    'can_publish_listing',
  ];
  const userRows = [];
  for (let i = 0; i < VOLUME_TARGETS.users; i += 1) {
    const isHost = i < VOLUME_TARGETS.hostProfiles;
    userRows.push([
      volumeUuid('e0000000', i),
      `vol.user${i}@seed.homeplate.invalid`,
      true,
      'seed-volume-hash-not-a-real-password',
      `Volume User ${i}`,
      true,
      isHost,
    ]);
  }
  const users = await batchInsert(client, 'users', userColumns, userRows);
  log.log(`seed volume: users +${users}`);

  // host_profiles for the first 1,000 users (NFR-06 completeness for wave-3 eligibility runs).
  const hostProfileRows = [];
  for (let i = 0; i < VOLUME_TARGETS.hostProfiles; i += 1) {
    hostProfileRows.push([
      volumeUuid('e0000000', i),
      `Volume host kitchen ${i} — synthetic LT-02 data.`,
      new Date('2026-08-01T12:00:00Z'),
    ]);
  }
  const hostProfiles = await batchInsert(
    client,
    'host_profiles',
    ['user_id', 'bio', 'host_agreement_accepted_at'],
    hostProfileRows
  );
  log.log(`seed volume: host_profiles +${hostProfiles}`);

  // listings — one per host, one LA day (ADR-009 boundary timezone via src/config/locale).
  const listingColumns = [
    'id',
    'host_id',
    'title',
    'description',
    'ingredients',
    'allergens',
    'cuisine',
    'scheduled_start',
    'duration_minutes',
    'local_date',
    'address_line1',
    'city',
    'region',
    'postal_code',
    'country',
    'lat',
    'lng',
    'coarse_lat',
    'coarse_lng',
    'area_label',
    'seat_capacity',
    'seats_remaining',
    'moderation_status',
    'status',
  ];
  const listingRows = [];
  for (let i = 0; i < VOLUME_TARGETS.listings; i += 1) {
    const scheduledStart = new Date(VOLUME_DAY_BASE.getTime() + (i % 4) * 3600 * 1000);
    // Precise coordinates fan out over a San Diego grid; coarse = 2-decimal public precision
    // (ADR-010 — search and cache only ever touch the coarse pair).
    const lat = 32.6 + (i % 100) * 0.003;
    const lng = -117.25 + Math.floor(i / 100) * 0.012;
    listingRows.push([
      volumeUuid('f1000000', i),
      volumeUuid('e0000000', i),
      `Volume Dinner ${i}`,
      `Synthetic LT-02 listing ${i} — cuisine ${cuisines[i % cuisines.length]}.`,
      '{rice,vegetables,spices}',
      '{none}',
      cuisines[i % cuisines.length],
      scheduledStart,
      120,
      localDateFor(scheduledStart),
      `${100 + i} Volume Test Kitchen`,
      'San Diego',
      'CA',
      '92101',
      'US',
      lat,
      lng,
      Math.round(lat * 100) / 100,
      Math.round(lng * 100) / 100,
      'San Diego',
      4,
      3,
      'approved',
      'active',
    ]);
  }
  const listings = await batchInsert(client, 'listings', listingColumns, listingRows);
  log.log(`seed volume: listings +${listings} (single ${locale.timezone} day)`);

  // bookings — one pending booking per listing, guests are users[1000..1999] (FR-12: each is
  // the one seat already subtracted from seats_remaining above).
  const bookingRows = [];
  for (let i = 0; i < VOLUME_TARGETS.bookings; i += 1) {
    bookingRows.push([
      volumeUuid('f2000000', i),
      volumeUuid('f1000000', i),
      volumeUuid('e0000000', VOLUME_TARGETS.hostProfiles + i),
      'pending',
    ]);
  }
  const bookings = await batchInsert(
    client,
    'bookings',
    ['id', 'listing_id', 'guest_id', 'status'],
    bookingRows
  );
  log.log(`seed volume: bookings +${bookings}`);

  // Fresh planner statistics so LT-02's EXPLAIN reflects the real volume (NFR-02).
  await client.query('ANALYZE');

  return {
    tables: 4,
    rows: users + hostProfiles + listings + bookings,
    counts: { users, hostProfiles, listings, bookings },
  };
}

/**
 * Load a seed set into `databaseUrl`. Returns { files, tables, rows } (volume adds `counts`).
 * set 'volume' generates the NFR-02 dataset; any other set loads fixture files. A missing
 * fixture set is not an error at wave 0-2: the runner reports it honestly and does nothing.
 */
async function seed({ databaseUrl = process.env.DATABASE_URL, set = 'base', log = console } = {}) {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set — cannot seed (see .env.example)');
  }

  if (set === 'volume') {
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      await client.query('BEGIN');
      const result = await seedVolume(client, log);
      await client.query('COMMIT');
      log.log(
        `seed: set "volume" — generated ${result.rows} new row(s) across ${result.tables} table(s)`
      );
      return { files: 0, ...result };
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Volume seeding failed: ${err.message}`);
    } finally {
      await client.end();
    }
  }

  const files = listFixtureFiles(set);
  if (files.length === 0) {
    log.log(`seed: no fixture files for set "${set}" under tests/fixtures/seed/ — nothing to do`);
    return { files: 0, tables: 0, rows: 0 };
  }

  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  let tables = 0;
  let rows = 0;
  try {
    for (const file of files) {
      const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (fixture === null || typeof fixture !== 'object' || Array.isArray(fixture)) {
        throw new Error(`Fixture ${file} must be a JSON object of { table: [rows] }`);
      }
      await client.query('BEGIN');
      try {
        for (const [table, tableRows] of Object.entries(fixture)) {
          if (!Array.isArray(tableRows)) {
            throw new Error(`Fixture ${file}: "${table}" must map to an array of rows`);
          }
          rows += await insertRows(client, table, tableRows);
          tables += 1;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Seeding from ${path.basename(file)} failed: ${err.message}`);
      }
      log.log(`seed: loaded ${path.basename(file)}`);
    }
  } finally {
    await client.end();
  }
  log.log(
    `seed: set "${set}" — ${files.length} file(s), ${tables} table batch(es), ${rows} new row(s)`
  );
  return { files: files.length, tables, rows };
}

if (require.main === module) {
  // `--volume` is shorthand for `--set volume` (NFR-02 acceptance wording: "seed --volume").
  const setIndex = process.argv.indexOf('--set');
  let set = setIndex !== -1 ? process.argv[setIndex + 1] : 'base';
  if (process.argv.includes('--volume')) set = 'volume';
  if (!set) {
    console.error('Usage: node scripts/seed.js [--set <name> | --volume]');
    process.exit(1);
  }
  seed({ set }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { seed, listFixtureFiles, localDateFor, SEED_DIR, VOLUME_TARGETS };
