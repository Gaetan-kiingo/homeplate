// tests/unit/db.test.js — U1-DB acceptance tests.
//
// Requirement traceability (SRS Appendix B):
//   NFR-02 — volume seed loads >= 10,000 users / 1,000 listings (one LA day) / 1,000 bookings
//   NFR-13 — users carries exactly the §3.4 column set; phone/emergency-contact ciphertext
//            round-trips AES-256-GCM and is never the plaintext
//   NFR-11 — schema access goes through parameterized helpers (this suite uses them throughout)
//   NFR-01 — cache.wrap populates on miss, serves on hit, honours TTL; required search indexes
//   NFR-12 — data lifecycle tables exist; anonymizable (nullable) author references
//   FR-11 / AB-07 — unique users.email; unique (host_id, local_date) on non-cancelled listings
//   FR-12 — CHECK (seats_remaining >= 0 AND seats_remaining <= seat_capacity)
//   FR-04 / FR-05 / FR-08 — completed-booking flag CHECK, rating CHECK 1..5,
//            listings/reviews moderation_status defaulting 'pending'
//   NFR-09 — cache degrades to the loader when Redis fails; it never breaks the read;
//            the shared client swallows-and-logs 'error' events and reconnects with a
//            bounded backoff (src/db/redis.js retryStrategy) instead of crashing
'use strict';

const { Client } = require('pg');
const { runMigrations, listMigrations } = require('../../scripts/migrate');
const { seed, localDateFor, VOLUME_TARGETS } = require('../../scripts/seed');
const dbh = require('../helpers/db');
const redish = require('../helpers/redis');
const { LANE, laneVolumeDatabaseUrl } = require('../helpers/env');
const { retryStrategy } = require('../../src/db/redis');
const { logger } = require('../../src/lib/logger');
const { withTransaction } = require('../../src/db/tx');
const { encrypt, decrypt, isEncrypted } = require('../../src/db/fieldCrypto');
const cache = require('../../src/lib/cache');

jest.setTimeout(120_000);

const quiet = { log: () => {}, warn: () => {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterAll(async () => {
  // TEARDOWN MUST RELEASE ITS HANDLES ON EVERY PATH (finding TCC-RV-04, NFR-02 toolchain).
  // jest.config.js runs with maxWorkers=1, and Jest then executes every test file IN ITS MAIN
  // PROCESS (shouldRunInBand: maxWorkers <= 1). So the pool connections and the shared ioredis
  // client this file opens are ref'd sockets in Jest's OWN event loop — leave one open and the
  // run prints its summary and then never exits ("Jest did not exit one second after the test
  // run has completed"), which hangs CI even though every test passed.
  // The cleanup DELETE is the fragile step: it legitimately fails when this lane's backends were
  // terminated (e.g. a stray WITH (FORCE) drop — IT2-F1). Sequencing it with `await` ahead of the
  // closes meant that one failure skipped BOTH of them and leaked both sockets, so it runs in a
  // try/finally and each close is guaranteed even if the previous step throws. Nothing is
  // swallowed: the original failure still fails the suite.
  try {
    // Remove this suite's rows (helper emails are namespaced); FK rules cascade the rest.
    await dbh.query(`DELETE FROM users WHERE email LIKE '%@dbunit.homeplate.invalid'`);
  } finally {
    try {
      await dbh.closeDb();
    } finally {
      await redish.closeTestRedis();
    }
  }
});

// ---------------------------------------------------------------------------------------------
describe('schema — §3.4 tables all exist', () => {
  test('the 14 §3.4 tables and schema_migrations are present', async () => {
    const { rows } = await dbh.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    const tables = rows.map((r) => r.tablename);
    const expected = [
      'users',
      'host_profiles',
      'email_verification_tokens',
      'listings',
      'bookings',
      'reviews',
      'messages',
      'safety_alerts',
      'moderation_decisions',
      'moderation_queue',
      'notification_attempts',
      'media_objects',
      'data_requests',
      'access_log',
    ];
    expect(tables).toEqual(expect.arrayContaining([...expected, 'schema_migrations']));
  });

  test('users columns are exactly the §3.4 set — data minimization (NFR-13)', async () => {
    const { rows } = await dbh.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users'`
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual(
      [
        'anonymized_at',
        'can_publish_listing',
        'can_reserve_seat',
        'created_at',
        'deleted_at',
        'email',
        'email_verified',
        'emergency_contact_email_enc',
        'emergency_contact_name_enc',
        'emergency_contact_phone_enc',
        'full_name',
        'id',
        'last_active_at',
        'password_hash',
        'phone_enc',
        'roles',
        'updated_at',
      ].sort()
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('schema invariants (FR-11, FR-12, FR-04, FR-05, FR-08, AB-07)', () => {
  test('users.email is unique — duplicate registration cannot create a row (AB-07)', async () => {
    const user = await dbh.makeUser();
    await expect(dbh.makeUser({ email: user.email })).rejects.toMatchObject({ code: '23505' });
    // Case-variant duplicates are blocked too (users_email_lower_key).
    await expect(dbh.makeUser({ email: user.email.toUpperCase() })).rejects.toMatchObject({
      code: '23505',
    });
  });

  test('one non-cancelled listing per (host_id, local_date); cancelled frees the slot (FR-11)', async () => {
    const host = await dbh.makeUser({ can_publish_listing: true });
    const day = {
      scheduled_start: new Date('2030-06-01T18:00:00-07:00'),
      local_date: '2030-06-01',
    };
    await dbh.makeListing({ host_id: host.id, ...day });
    // Second ACTIVE listing, same host, same LA day → the unique index refuses.
    await expect(dbh.makeListing({ host_id: host.id, ...day })).rejects.toMatchObject({
      code: '23505',
    });
    // A CANCELLED listing on the same day is allowed (partial index excludes it).
    const cancelled = await dbh.makeListing({ host_id: host.id, ...day, status: 'cancelled' });
    expect(cancelled.status).toBe('cancelled');
  });

  test('seats_remaining is bounded 0..seat_capacity — overbooking is impossible (FR-12)', async () => {
    await expect(dbh.makeListing({ seat_capacity: 4, seats_remaining: -1 })).rejects.toMatchObject({
      code: '23514',
    });
    await expect(dbh.makeListing({ seat_capacity: 4, seats_remaining: 5 })).rejects.toMatchObject({
      code: '23514',
    });
    const ok = await dbh.makeListing({ seat_capacity: 4, seats_remaining: 0 });
    expect(ok.seats_remaining).toBe(0);
  });

  test('review rating is constrained to 1..5 (FR-05)', async () => {
    const booking = await dbh.makeBooking();
    for (const bad of [0, 6]) {
      await expect(
        dbh.insertRow('reviews', { booking_id: booking.id, rating: bad })
      ).rejects.toMatchObject({ code: '23514' });
    }
    const review = await dbh.insertRow('reviews', { booking_id: booking.id, rating: 1 });
    expect(review.rating).toBe(1);
  });

  test('listings and reviews default to moderation_status pending (FR-08 — never public unreviewed)', async () => {
    const listing = await dbh.makeListing();
    expect(listing.moderation_status).toBe('pending');
    const booking = await dbh.makeBooking();
    const review = await dbh.insertRow('reviews', { booking_id: booking.id, rating: 4 });
    expect(review.moderation_status).toBe('pending');
  });

  test('a booking cannot be completed without BOTH confirmation flags (FR-04)', async () => {
    const listing = await dbh.makeListing();
    const guest = await dbh.makeUser();
    await expect(
      dbh.makeBooking({
        listing_id: listing.id,
        guest_id: guest.id,
        status: 'completed',
        host_confirmed_completion: true,
        guest_confirmed_completion: false,
      })
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('required indexes exist: scheduled_start, (host_id, local_date), moderation_status (NFR-02)', async () => {
    const { rows } = await dbh.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'listings'`
    );
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    expect(byName.listings_scheduled_start_idx).toContain('(scheduled_start)');
    expect(byName.listings_moderation_status_idx).toContain('(moderation_status)');
    expect(byName.listings_host_local_date_key).toContain('UNIQUE');
    expect(byName.listings_host_local_date_key).toContain('(host_id, local_date)');
    expect(byName.listings_host_local_date_key).toMatch(/WHERE \(status <> 'cancelled'/);
    // FR-01/NFR-02 filter columns.
    expect(byName.listings_cuisine_idx).toBeDefined();
    expect(byName.listings_coarse_geo_idx).toContain('(coarse_lat, coarse_lng)');
  });

  test('ADR-009 boundary: local_date derives from America/Los_Angeles, not UTC', () => {
    // 06:59Z is 23:59 the previous day in LA (PDT); 07:01Z is 00:01 the next LA day.
    expect(localDateFor(new Date('2026-09-16T06:59:00Z'))).toBe('2026-09-15');
    expect(localDateFor(new Date('2026-09-16T07:01:00Z'))).toBe('2026-09-16');
  });
});

// ---------------------------------------------------------------------------------------------
describe('withTransaction (ADR-001 — one transaction, no dual writes)', () => {
  test('commits atomically and returns fn result', async () => {
    const email = `txcommit.${Date.now()}@dbunit.homeplate.invalid`;
    const returned = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
        [email, 'test-helper-hash-not-a-real-password']
      );
      return rows[0].id;
    });
    const { rows } = await dbh.query(`SELECT id FROM users WHERE email = $1`, [email]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(returned);
  });

  test('rolls back everything on a forced error and rethrows it', async () => {
    const email = `txrollback.${Date.now()}@dbunit.homeplate.invalid`;
    await expect(
      withTransaction(async (client) => {
        await client.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2)`, [
          email,
          'test-helper-hash-not-a-real-password',
        ]);
        throw new Error('forced failure after write');
      })
    ).rejects.toThrow('forced failure after write');
    const { rows } = await dbh.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('fieldCrypto — AES-256-GCM at rest (NFR-13)', () => {
  const plaintext = '+1-619-555-0100';

  test('encrypt/decrypt round-trips and ciphertext is not the plaintext', () => {
    const ciphertext = encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext).not.toContain(plaintext);
    expect(ciphertext.startsWith('enc:v1:')).toBe(true);
    expect(isEncrypted(ciphertext)).toBe(true);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  test('fresh IV per call: same plaintext, different ciphertexts', () => {
    expect(encrypt(plaintext)).not.toBe(encrypt(plaintext));
  });

  test('tampered ciphertext is detected, never returned as garbage', () => {
    const ciphertext = encrypt(plaintext);
    const body = ciphertext.slice('enc:v1:'.length);
    const flipped = 'enc:v1:' + body.slice(0, 20) + (body[20] === 'A' ? 'B' : 'A') + body.slice(21);
    expect(() => decrypt(flipped)).toThrow();
  });

  test('rejects non-ciphertext and truncated input; null passes through', () => {
    expect(() => decrypt('not-encrypted')).toThrow(TypeError);
    expect(() => decrypt('enc:v1:AAAA')).toThrow(RangeError);
    expect(() => encrypt(12345)).toThrow(TypeError);
    expect(encrypt(null)).toBeNull();
    expect(decrypt(null)).toBeNull();
    expect(decrypt(encrypt(''))).toBe('');
  });

  test('phone + emergency contact are stored as ciphertext in users (NFR-13)', async () => {
    const phone = '+1-619-555-0142';
    const contactName = 'Synthetic Contact';
    const user = await dbh.makeUser({
      phone_enc: encrypt(phone),
      emergency_contact_name_enc: encrypt(contactName),
    });
    const { rows } = await dbh.query(
      `SELECT phone_enc, emergency_contact_name_enc FROM users WHERE id = $1`,
      [user.id]
    );
    expect(isEncrypted(rows[0].phone_enc)).toBe(true);
    expect(rows[0].phone_enc).not.toContain(phone);
    expect(decrypt(rows[0].phone_enc)).toBe(phone);
    expect(decrypt(rows[0].emergency_contact_name_enc)).toBe(contactName);
  });
});

// ---------------------------------------------------------------------------------------------
describe('redis key() namespacing', () => {
  test('builds hp:<ns>:<parts> keys and rejects malformed input', () => {
    expect(redish.key('session', 'abc123')).toBe('hp:session:abc123');
    expect(redish.key('cache', 'geo', 42)).toBe('hp:cache:geo:42');
    expect(() => redish.key('', 'x')).toThrow(TypeError);
    expect(() => redish.key('cache')).toThrow(TypeError);
    expect(() => redish.key('cache', undefined)).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------------------------
describe('redis client resilience — an outage degrades, it never crashes (NFR-09)', () => {
  test("an 'error' event on the shared client is logged and swallowed, not rethrown", () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      // src/db/redis.js attaches this handler at load: an unhandled ioredis 'error' event
      // is fatal to the process, so the FIRST dropped connection would crash the app
      // without it. Emitting synthetically proves the handler logs and swallows.
      expect(redish.redis.listenerCount('error')).toBeGreaterThan(0);
      expect(() =>
        redish.redis.emit('error', new Error('synthetic ECONNREFUSED (db.test.js)'))
      ).not.toThrow();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'synthetic ECONNREFUSED (db.test.js)' }),
        expect.stringContaining('redis')
      );
    } finally {
      warn.mockRestore();
    }
  });

  test('reconnect backoff is bounded and never gives up', () => {
    // Ramps with the attempt count…
    expect(retryStrategy(1)).toBe(200);
    expect(retryStrategy(5)).toBe(1000);
    // …and caps, so a long outage never produces unbounded waits.
    expect(retryStrategy(25)).toBe(5000);
    expect(retryStrategy(10_000)).toBe(5000);
    // Always a positive number: returning undefined/null tells ioredis to STOP
    // reconnecting, which would turn a transient outage into a permanent one.
    for (const attempt of [1, 2, 3, 50, 1_000_000]) {
      const delay = retryStrategy(attempt);
      expect(typeof delay).toBe('number');
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(5000);
    }
    // The shared client is configured with this exact policy — not an implicit default.
    expect(redish.redis.options.retryStrategy).toBe(retryStrategy);
  });
});

// ---------------------------------------------------------------------------------------------
describe('cache — read-through with TTL, degraded on Redis failure (NFR-01, NFR-09)', () => {
  const uniq = `${process.pid}.${Date.now()}`;

  afterAll(async () => {
    await redish.flushNamespace('cache');
  });

  test('wrap populates on miss (loader called once) and serves on hit (loader not called)', async () => {
    const cacheKey = redish.key('cache', 'dbunit', uniq, 'wrap');
    const loader = jest.fn().mockResolvedValue({ answer: 42 });
    expect(await cache.wrap(cacheKey, 60, loader)).toEqual({ answer: 42 });
    expect(loader).toHaveBeenCalledTimes(1);
    // TTL was applied on the populate.
    const ttl = await redish.redis.ttl(cacheKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    // Hit: value served from Redis, loader untouched.
    expect(await cache.wrap(cacheKey, 60, loader)).toEqual({ answer: 42 });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('honours TTL: the entry expires and the loader runs again', async () => {
    const cacheKey = redish.key('cache', 'dbunit', uniq, 'ttl');
    const loader = jest.fn().mockResolvedValue('v1');
    await cache.wrap(cacheKey, 1, loader);
    await sleep(1200);
    expect(await cache.get(cacheKey)).toBeUndefined();
    await cache.wrap(cacheKey, 1, loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  test('set/get/del round-trip; cached null is a hit, undefined is refused', async () => {
    const cacheKey = redish.key('cache', 'dbunit', uniq, 'roundtrip');
    await cache.set(cacheKey, { a: [1, 2, 3] }, 60);
    expect(await cache.get(cacheKey)).toEqual({ a: [1, 2, 3] });
    await cache.del(cacheKey);
    expect(await cache.get(cacheKey)).toBeUndefined();

    const nullKey = redish.key('cache', 'dbunit', uniq, 'null');
    const nullLoader = jest.fn().mockResolvedValue(null);
    expect(await cache.wrap(nullKey, 60, nullLoader)).toBeNull();
    expect(await cache.wrap(nullKey, 60, nullLoader)).toBeNull(); // negative-cache hit
    expect(nullLoader).toHaveBeenCalledTimes(1);

    await expect(cache.set(cacheKey, undefined, 60)).rejects.toThrow(TypeError);
    await expect(cache.wrap(cacheKey, 0, nullLoader)).rejects.toThrow(TypeError);
  });

  test('degrades on Redis failure: the loader still answers, nothing throws (NFR-09)', async () => {
    const cacheKey = redish.key('cache', 'dbunit', uniq, 'degraded');
    const loader = jest.fn().mockResolvedValue('from-source-of-truth');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Monkeypatch the shared client's own properties; deleting them restores the prototype.
    redish.redis.get = async () => {
      throw new Error('redis down');
    };
    redish.redis.set = async () => {
      throw new Error('redis down');
    };
    try {
      expect(await cache.wrap(cacheKey, 60, loader)).toBe('from-source-of-truth');
      expect(loader).toHaveBeenCalledTimes(1);
      expect(await cache.get(cacheKey)).toBeUndefined();
      expect(await cache.set(cacheKey, 'x', 60)).toBe(false);
    } finally {
      delete redish.redis.get;
      delete redish.redis.set;
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('seed — base fixture (SRS §4.1 reproducible seed)', () => {
  test('base fixture rows are present and reseeding is idempotent', async () => {
    // globalSetup already seeded; a fresh run restores anything missing…
    await seed({ set: 'base', log: quiet });
    const { rows } = await dbh.query(`SELECT email, can_publish_listing FROM users WHERE id = $1`, [
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(rows[0]).toEqual({
      email: 'host.one@seed.homeplate.invalid',
      can_publish_listing: true,
    });
    // …and the run after that inserts NOTHING (deterministic IDs + ON CONFLICT DO NOTHING).
    const again = await seed({ set: 'base', log: quiet });
    expect(again.rows).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('migrations + volume seed on a pristine database (NFR-02)', () => {
  // The database name is DERIVED from the lane identity (tests/helpers/env.js), never hardcoded.
  // This block drops its database WITH (FORCE), which terminates every other backend connected to
  // it; a fixed name would be identical in every lane regardless of TEST_DATABASE_URL and would
  // escape the lane-claim registry entirely, so two concurrent lanes killed each other mid-seed
  // ("Connection terminated unexpectedly" / "terminating connection due to administrator command"
  // — verification finding IT2-F1). Two runs of the SAME lane are serialized by the suite advisory
  // lock, so this database has exactly one writer at a time.
  const VOLUME_DB = LANE.volumeDatabase;
  const volumeUrl = laneVolumeDatabaseUrl();
  // Quoted identifier: the name comes from the lane's URL, which may legitimately contain
  // characters PostgreSQL would otherwise need folded (globalSetup quotes CREATE DATABASE too).
  const volumeIdent = `"${VOLUME_DB.replace(/"/g, '""')}"`;
  const adminUrl = (() => {
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = '/postgres';
    return url.toString();
  })();
  let admin;

  beforeAll(async () => {
    admin = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${volumeIdent} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${volumeIdent}`);
  });

  afterAll(async () => {
    if (!admin) return;
    // The drop is best-effort — it fails if anything reconnected to the database between the
    // FORCE and the drop — but `admin` is a bare pg Client on the maintenance database, i.e. a
    // ref'd socket in Jest's main process (maxWorkers=1 ⇒ tests run in band). Ending it inside a
    // finally is what stops a failed drop from turning into "Jest did not exit …" (TCC-RV-04).
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${volumeIdent} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  test('npm run migrate semantics: applies all, records versions, second run is a no-op', async () => {
    const first = await runMigrations({ databaseUrl: volumeUrl, log: quiet });
    expect(first.applied.length).toBe(listMigrations().length);
    const second = await runMigrations({ databaseUrl: volumeUrl, log: quiet });
    expect(second.applied).toHaveLength(0);

    const client = new Client({ connectionString: volumeUrl, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      const { rows } = await client.query(`SELECT version FROM schema_migrations ORDER BY version`);
      expect(rows.map((r) => r.version)).toEqual(listMigrations().map((m) => m.version));
    } finally {
      await client.end();
    }
  });

  // A LOST CONNECTION IS NOT AN NFR-02 FAILURE (findings TCC-RV-05 / COV-13). Observed on a busy
  // shared host: the bulk load lost its socket mid-transaction and this test failed with
  // 'Connection terminated unexpectedly' raised from scripts/seed.js:333's ROLLBACK — the
  // rollback itself failing on the already-dead client, which also MASKS the original error.
  // Nothing about the schema, the data or the volume targets was wrong; the machine hiccuped, and
  // "the suite is green" stopped being a property of the code.
  // So the load is retried once on a connection-loss error — the volume seed is one transaction
  // and idempotent (deterministic IDs + ON CONFLICT DO NOTHING), so a retry is safe whether the
  // lost attempt rolled back or had already committed — and the AUTHORITATIVE NFR-02 evidence is
  // the row census taken against the database below, not the seed's own insert count, which a
  // retry legitimately reports as 0 when the lost attempt had already committed. Anything that is
  // NOT a connection loss still fails immediately and unretried.
  const CONNECTION_LOST =
    /Connection terminated|terminating connection|connection is closed|Client has encountered a connection error|ECONNRESET|socket hang up/i;

  /**
   * @param {number} [attempts]
   * @returns {Promise<{result: object, attempt: number, transient: string[]}>}
   */
  async function seedVolumeResilient(attempts = 2) {
    const transient = [];
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await seed({ databaseUrl: volumeUrl, set: 'volume', log: quiet });
        return { result, attempt, transient };
      } catch (err) {
        if (attempt >= attempts || !CONNECTION_LOST.test(err.message)) throw err;
        transient.push(err.message);
        console.warn(
          `db.test.js: volume seed attempt ${attempt} lost its PostgreSQL connection ` +
            `(${err.message}) — retrying once. This is host contention, not an NFR-02 defect; ` +
            'the volume targets are asserted from a census of the database below.'
        );
      }
    }
  }

  test('seed --volume loads >= 10,000 users / 1,000 listings on ONE LA day / 1,000 bookings', async () => {
    const { result, attempt } = await seedVolumeResilient();
    // The seed's own insert census is checked when the load ran clean — the normal case. After a
    // retry it is not the acceptance signal (see above); the census below always is.
    if (attempt === 1) {
      expect(result.counts.users).toBeGreaterThanOrEqual(VOLUME_TARGETS.users);
      expect(result.counts.listings).toBeGreaterThanOrEqual(VOLUME_TARGETS.listings);
      expect(result.counts.bookings).toBeGreaterThanOrEqual(VOLUME_TARGETS.bookings);
    }

    const client = new Client({ connectionString: volumeUrl, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      const counts = await client.query(
        `SELECT
           (SELECT count(*) FROM users)    AS users,
           (SELECT count(*) FROM listings) AS listings,
           (SELECT count(*) FROM bookings) AS bookings,
           (SELECT count(DISTINCT local_date) FROM listings WHERE id::text LIKE 'f1000000-%')
             AS listing_days`
      );
      const row = counts.rows[0];
      expect(Number(row.users)).toBeGreaterThanOrEqual(10000);
      expect(Number(row.listings)).toBeGreaterThanOrEqual(1000);
      expect(Number(row.bookings)).toBeGreaterThanOrEqual(1000);
      // NFR-02: the 1,000 listings/bookings all belong to a single (LA) day.
      expect(Number(row.listing_days)).toBe(1);
    } finally {
      await client.end();
    }

    // Deterministic IDs make the volume seed idempotent as well.
    const { result: again } = await seedVolumeResilient();
    expect(again.rows).toBe(0);
  });
});
