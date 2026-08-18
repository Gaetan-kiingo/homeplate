// tests/tc-core/tc01-04-acceptance-gaps.test.js — verifier lane "tc-core", independent
// re-verification round for wave 3. These are the FR-01..FR-04 acceptance clauses that the
// first-round suites (tc01-search / tc02-listing-detail / tc03-host-profile / tc04-completion)
// do NOT yet exercise. Every assertion below is an acceptance-criterion clause from
// docs/_generated/requirements-inventory.json, fired against the live app and the seeded test
// database (SRS §4.1) — nothing here is a code reading.
//
// Clauses covered here:
//   FR-01 (TC-01) — "the resolved COORDINATES … are written to Redis with a TTL" (the
//                   first-round suite asserts the result PAGE cache only), and the paging
//                   contract {page, pageSize, total} the LT-01 harness depends on.
//   FR-02 (TC-02) — localDate is the plain MEHKO calendar day on the wire, not a
//                   timezone-dependent instant (ADR-009/ADRC-W3-01 re-derivation);
//                   "a created review … is absent from GET /api/listings/:id until approved"
//                   (FR-05 acceptance clause enforced on the FR-02 read path), including the
//                   host summary aggregates.
//   FR-03 (TC-03) — deleted media (NFR-12 erasure mark, ADR-004) never resurface on the host
//                   page; a deleted host account is 404.
//   FR-04 (TC-04) — the dual-confirmation transition under CONCURRENT confirmations completes
//                   exactly once; a guest holding a DIFFERENT booking on the same listing is
//                   not a participant of this one (403).
//
// DETERMINISM (finding MTUT-RV-03, NFR-08). Every fixture below is created by this file and
// referenced by its own primary key or by a value carrying the per-run RUN token, so no
// assertion here reads a row, a Redis key or an aggregate that another suite can influence.
// The one exception has been removed: the TC-01 cache test used to begin with
// flushNamespace('cache'), which wiped every OTHER suite's cached pages as a side effect; it
// now diffs the maps-cache keyspace instead (see the comment on that test).
//
// Two mechanisms proposed for MTUT-RV-03 were checked and do NOT apply to this repository, so
// do not reintroduce them as explanations without re-checking the config first:
//   - jest.config.js pins maxWorkers: 1, and @jest/core testSchedulerHelper.shouldRunInBand()
//     returns true whenever maxWorkers <= 1 (and unconditionally under --detectOpenHandles).
//     Jest therefore executes every test FILE sequentially in its own main process; two suites
//     are never live at the same time.
//   - all six `DELETE FROM users WHERE email LIKE '%@dbunit.homeplate.invalid'` statements and
//     the whole-database dbh.reseedBase() in tests/unit/search.test.js sit in afterAll hooks,
//     i.e. they run after their own file's last test and before the next file's first line.
// A fixture row of this file can therefore not vanish mid-file. Failures observed here in a
// contended run (20 concurrent jest processes and a 200-VU k6 load test on the same host) are
// host contention, not shared-fixture interference — re-measure on an idle, isolated lane
// (TEST_DATABASE_URL + TEST_REDIS_URL + OBJECT_STORAGE_BUCKET set together) before filing.
'use strict';

const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const dbh = require('../helpers/db');
const { redis, closeTestRedis } = require('../helpers/redis');
const support = require('./support');

const sink = { write() {} };
let app;

const RUN = `${process.pid}${Date.now() % 1e7}`;
const GAP_CUISINE = `tcgap${RUN}`;
const GAP_LOCATION = `tcgap location ${RUN}`;
const GAP_STREET = `9 Tcgap Secret Lane ${RUN}`;
const GAP_PRECISE = { lat: 32.654321, lng: -117.123456 };

beforeAll(() => {
  app = createApp({ logger: createLogger({ level: 'silent', stream: sink }) });
});

afterAll(async () => {
  await closeTestRedis();
  await dbh.closeDb();
});

// ------------------------------------------------------------------------------------------
// FR-01 / TC-01 — geocode-coordinate cache and the paging contract.
// ------------------------------------------------------------------------------------------
describe('TC-01 / FR-01 — resolved coordinates cached with a TTL; paging contract', () => {
  let viewerCookie;

  beforeAll(async () => {
    viewerCookie = await support.cookieFor(await dbh.makeUser());
  });

  /** Every 'hp:cache:maps:*' key currently in this lane's Redis index (SCAN, never KEYS). */
  async function mapsCacheKeys() {
    let cursor = '0';
    const keys = [];
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', 'hp:cache:maps:*', 'COUNT', 500);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  test('a location query writes the RESOLVED COORDINATES to Redis with a TTL, at public precision only', async () => {
    // Determinism (finding MTUT-RV-03): this test used to open with flushNamespace('cache'),
    // which deletes EVERY 'hp:cache:*' key in the lane — every other suite's cached search
    // pages and geocodes, not just this one's. It was the only cross-suite mutation this file
    // performed, and it is unnecessary: GAP_LOCATION carries the per-run RUN token, so no
    // earlier suite (or earlier run) can have cached it and the ADR-005 adapter is guaranteed
    // to be called. Scoping replaces flushing: snapshot the maps-cache keyspace, fire the
    // query, and assert on the keys THIS query added. That is strictly stronger than the old
    // form — after a flush the surviving keys were this test's by construction, so the old
    // sweep proved only "some key exists", while the diff proves this query wrote one.
    const before = new Set(await mapsCacheKeys());

    const res = await support.get(
      app,
      `/api/listings/search?location=${encodeURIComponent(GAP_LOCATION)}&radiusKm=5`,
      viewerCookie
    );
    expect(res.status).toBe(200);

    // The ADR-005 adapter's own geocode cache — separate from the result-page cache.
    const allKeys = await mapsCacheKeys();
    const geoKeys = allKeys.filter((k) => !before.has(k));
    expect(geoKeys.length).toBeGreaterThan(0);

    for (const key of geoKeys) {
      expect(await redis.ttl(key)).toBeGreaterThan(0); // TTL, never a permanent entry
      const value = await redis.get(key);
      expect(value).not.toMatch(/addressLine1|postalCode/);
    }

    // ADR-010 is a safety property of the WHOLE keyspace, not just of the keys this query
    // added: a raw location string (possibly a street address) must never appear in any maps
    // cache key. GAP_LOCATION is unique to this run, so only this file can put it there —
    // scanning every key costs nothing in determinism and catches a leak written anywhere.
    for (const key of allKeys) {
      expect(key).not.toMatch(/tcgap/i);
    }
  });

  test('the response carries the {page, pageSize, total} paging contract and pages do not overlap', async () => {
    const hosts = [];
    const created = [];
    for (let i = 0; i < 3; i += 1) {
      const host = await dbh.makeUser({ can_publish_listing: true });
      hosts.push(host);
      created.push(
        await support.makeApprovedListing({
          host_id: host.id,
          cuisine: GAP_CUISINE,
          scheduled_start: new Date(`203${4 + i}-04-0${i + 1}T18:00:00Z`),
        })
      );
    }

    const page1 = await support.get(
      app,
      `/api/listings/search?cuisine=${GAP_CUISINE}&page=1&pageSize=2`,
      viewerCookie
    );
    expect(page1.status).toBe(200);
    expect(page1.body.page).toBe(1);
    expect(page1.body.pageSize).toBe(2);
    expect(page1.body.total).toBe(3);
    expect(page1.body.results).toHaveLength(2);

    const page2 = await support.get(
      app,
      `/api/listings/search?cuisine=${GAP_CUISINE}&page=2&pageSize=2`,
      viewerCookie
    );
    expect(page2.status).toBe(200);
    expect(page2.body.total).toBe(3);
    expect(page2.body.results).toHaveLength(1);

    const seen = [...page1.body.results, ...page2.body.results].map((r) => r.id);
    expect(new Set(seen).size).toBe(3);
    expect(seen.sort()).toEqual(created.map((l) => l.id).sort());
  });
});

// ------------------------------------------------------------------------------------------
// FR-02 / TC-02 — MEHKO calendar day on the wire + unapproved reviews stay invisible.
// ------------------------------------------------------------------------------------------
describe('TC-02 / FR-02 — localDate is the plain MEHKO calendar day (ADR-009)', () => {
  test('localDate equals the stored America/Los_Angeles calendar day as YYYY-MM-DD, not an instant', async () => {
    const host = await dbh.makeUser({ can_publish_listing: true });
    await dbh.makeHostProfile({ user_id: host.id, bio: 'Gap probe host.' });
    // 04:00 UTC on 2033-06-15 is 21:00 PDT on 2033-06-14 — the UTC day and the LA day differ,
    // so a timezone-dependent serialization is visible as an off-by-one here.
    const listing = await support.makeApprovedListing({
      host_id: host.id,
      scheduled_start: new Date('2033-06-15T04:00:00Z'),
    });
    const { rows } = await dbh.query(
      `SELECT to_char(local_date, 'YYYY-MM-DD') AS d FROM listings WHERE id = $1`,
      [listing.id]
    );
    expect(rows[0].d).toBe('2033-06-14');

    const viewerCookie = await support.cookieFor(await dbh.makeUser());
    const res = await support.get(app, `/api/listings/${listing.id}`, viewerCookie);
    expect(res.status).toBe(200);
    expect(res.body.listing.localDate).toBe('2033-06-14');
    expect(res.body.listing.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.listing.localDate).not.toContain('T');
  });
});

describe('TC-02 / FR-02 — only APPROVED host reviews reach the detail payload (FR-05/FR-08)', () => {
  let host;
  let listing;
  let viewerCookie;

  beforeAll(async () => {
    host = await dbh.makeUser({ can_publish_listing: true, full_name: `Gap Host ${RUN}` });
    await dbh.makeHostProfile({ user_id: host.id, bio: `Gap bio ${RUN}` });
    listing = await support.makeApprovedListing({ host_id: host.id });
    viewerCookie = await support.cookieFor(await dbh.makeUser());

    // One approved (5), one pending (1), one rejected (1) review about this host.
    for (const [rating, status, body] of [
      [5, 'approved', 'GAP-APPROVED'],
      [1, 'pending', 'GAP-PENDING-INVISIBLE'],
      [1, 'rejected', 'GAP-REJECTED-INVISIBLE'],
    ]) {
      const guest = await dbh.makeUser();
      const past = await support.makeApprovedListing({ host_id: host.id });
      const booking = await support.makeCompletedBooking(past.id, guest.id);
      await dbh.insertRow('reviews', {
        booking_id: booking.id,
        author_id: guest.id,
        target_user_id: host.id,
        rating,
        body,
        moderation_status: status,
      });
    }
  });

  test('pending and rejected reviews are absent from GET /api/listings/:id and excluded from the aggregates', async () => {
    const res = await support.get(app, `/api/listings/${listing.id}`, viewerCookie);
    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    expect(raw).toContain('GAP-APPROVED');
    expect(raw).not.toContain('GAP-PENDING-INVISIBLE');
    expect(raw).not.toContain('GAP-REJECTED-INVISIBLE');

    expect(res.body.listing.host).toMatchObject({
      displayName: `Gap Host ${RUN}`,
      bio: `Gap bio ${RUN}`,
      averageRating: 5, // the approved review only — pending/rejected 1s would drag it to 2.33
      reviewCount: 1,
    });
    expect(res.body.listing.reviews.map((r) => r.body)).toEqual(['GAP-APPROVED']);
  });
});

// ------------------------------------------------------------------------------------------
// FR-03 / TC-03 — erasure marks and deleted accounts.
// ------------------------------------------------------------------------------------------
describe('TC-03 / FR-03 — deleted media and deleted accounts', () => {
  test('media marked deleted_at never resurface on the host page (NFR-12 / ADR-004)', async () => {
    const host = await dbh.makeUser({ can_publish_listing: true });
    await dbh.makeHostProfile({ user_id: host.id, bio: `Erasure probe ${RUN}` });
    const live = await support.attachHostProfileMedia(host.id, `gap-live-${RUN}.jpg`);
    const erased = await dbh.insertRow('media_objects', {
      owner_user_id: host.id,
      entity_type: 'host_profile',
      entity_id: host.id,
      storage_key: `host_profile/${host.id}/gap-erased-${RUN}.jpg`,
      content_type: 'image/jpeg',
      deleted_at: new Date(),
    });

    const dish = await support.makeApprovedListing({ host_id: host.id });
    const dishLive = await support.attachListingMedia(dish, host.id, `gap-dish-live-${RUN}.jpg`);
    const dishErased = await dbh.insertRow('media_objects', {
      owner_user_id: host.id,
      entity_type: 'listing',
      entity_id: dish.id,
      storage_key: `listing/${host.id}/gap-dish-erased-${RUN}.jpg`,
      content_type: 'image/jpeg',
      deleted_at: new Date(),
    });

    const viewerCookie = await support.cookieFor(await dbh.makeUser());
    const res = await support.get(app, `/api/hosts/${host.id}`, viewerCookie);
    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    expect(raw).toContain(live.storage_key);
    expect(raw).not.toContain(erased.storage_key);

    const dishPayload = res.body.host.exampleDishes.find((d) => d.id === dish.id);
    expect(dishPayload).toBeDefined();
    const dishUrls = dishPayload.images.map((i) => i.url).join('\n');
    expect(dishUrls).toContain(dishLive.storage_key);
    expect(dishUrls).not.toContain(dishErased.storage_key);
  });

  test('a deleted host account is a structured 404 on the host page (NFR-12)', async () => {
    const host = await dbh.makeUser({ can_publish_listing: true });
    await dbh.makeHostProfile({ user_id: host.id, bio: `Deleted host ${RUN}` });
    const viewerCookie = await support.cookieFor(await dbh.makeUser());
    expect((await support.get(app, `/api/hosts/${host.id}`, viewerCookie)).status).toBe(200);

    await dbh.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [host.id]);
    const res = await support.get(app, `/api/hosts/${host.id}`, viewerCookie);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ------------------------------------------------------------------------------------------
// FR-04 / TC-04 — concurrency and per-booking participant identity.
// ------------------------------------------------------------------------------------------
describe('TC-04 / FR-04 — concurrent dual confirmation and per-booking identity', () => {
  let host;
  let hostCookie;
  let listing;

  beforeAll(async () => {
    host = await dbh.makeUser({ can_publish_listing: true });
    hostCookie = await support.cookieFor(host);
    listing = await support.makeApprovedListing({
      host_id: host.id,
      address_line1: GAP_STREET,
      lat: GAP_PRECISE.lat,
      lng: GAP_PRECISE.lng,
      seat_capacity: 8,
      seats_remaining: 6,
    });
  });

  test('guest and host confirming SIMULTANEOUSLY complete the booking exactly once', async () => {
    const guest = await dbh.makeUser();
    const guestCookie = await support.cookieFor(guest);
    const booking = await dbh.makeBooking({
      listing_id: listing.id,
      guest_id: guest.id,
      status: 'in_progress',
    });

    const [a, b] = await Promise.all([
      support.post(app, `/api/bookings/${booking.id}/confirm-completion`, guestCookie),
      support.post(app, `/api/bookings/${booking.id}/confirm-completion`, hostCookie),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const { rows } = await dbh.query(
      `SELECT status, guest_confirmed_completion, host_confirmed_completion, completed_at
         FROM bookings WHERE id = $1`,
      [booking.id]
    );
    expect(rows[0].status).toBe('completed');
    expect(rows[0].guest_confirmed_completion).toBe(true);
    expect(rows[0].host_confirmed_completion).toBe(true);
    expect(rows[0].completed_at).not.toBeNull();

    // Exactly one of the two responses observed the transition (the other is the first flag).
    const completedResponses = [a, b].filter((r) => r.body.booking.status === 'completed');
    expect(completedResponses).toHaveLength(1);
  });

  test('a guest holding a DIFFERENT booking on the same listing is not a participant of this one (403)', async () => {
    const guestA = await dbh.makeUser();
    const guestB = await dbh.makeUser();
    const bookingA = await dbh.makeBooking({
      listing_id: listing.id,
      guest_id: guestA.id,
      status: 'in_progress',
    });
    await dbh.makeBooking({
      listing_id: listing.id,
      guest_id: guestB.id,
      status: 'in_progress',
    });

    const res = await support.post(
      app,
      `/api/bookings/${bookingA.id}/confirm-completion`,
      await support.cookieFor(guestB)
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_PARTICIPANT');

    const { rows } = await dbh.query(
      `SELECT guest_confirmed_completion, host_confirmed_completion FROM bookings WHERE id = $1`,
      [bookingA.id]
    );
    expect(rows[0].guest_confirmed_completion).toBe(false);
    expect(rows[0].host_confirmed_completion).toBe(false);
  });
});
