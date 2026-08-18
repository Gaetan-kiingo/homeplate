// tests/tc-booking/tc11-listing-caps.test.js — VERIFIER lane "tc-booking", TC-11 (FR-11, ADR-009).
//
// Wave 3 is BUILT: this file now runs the full FR-11 API acceptance (it replaces the wave-2
// "WAVE-3 GAP" probe per build-plan §7):
//  - POST /api/listings by an eligible host → 201, moderation_status='pending' (FR-08 substrate);
//  - one-listing-per-host-per-day: second same-LA-day create → 409 MEHKO_DAILY_LISTING_LIMIT;
//    a cancelled listing does NOT block the re-create path;
//  - seatCapacity > config.mehko.maxMealsPerDay → 422 MEHKO_DAILY_MEAL_LIMIT;
//  - weekly meal cap (config.mehko.maxMealsPerWeek) enforced across the host's week;
//  - ADR-009 timezone pin: day boundaries are America/Los_Angeles, not UTC and not the
//    caller's timezone (two instants on ONE UTC day but different LA days both succeed; two
//    instants on ONE LA day but different UTC days conflict);
//  - PATCH / cancel are owner-only (403); a material edit resets moderation to 'pending';
//  - cancelling a listing with active bookings cancels them and enqueues FR-13 notifications
//    in the same transaction;
//  - DB-level backstop (unique partial index + no cap literal in DDL) retained from wave 2.
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const {
  query,
  getClient,
  makeUser,
  makeHostProfile,
  makeListing,
  makeBooking,
  closeDb,
} = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const config = require('../../src/config');
const sessions = require('../../src/modules/auth/sessions');
const mehko = require('../../src/modules/listings/mehko');

const COOKIE = config.auth.sessionCookieName;

let app;

beforeAll(() => {
  app = createApp();
});

afterAll(async () => {
  await closeDb();
  await closeTestRedis();
});

// ---- fixtures --------------------------------------------------------------------------------

async function cookieFor(user) {
  const { token } = await sessions.createSession(user);
  return `${COOKIE}=${token}`;
}

/** Fully canPublishListing-eligible host (NFR-06: email+name+phone+profile+agreement). */
async function makeEligibleHost() {
  const host = await makeUser({ can_publish_listing: true, phone_enc: 'enc:v1:tc11-fixture' });
  await makeHostProfile({ user_id: host.id });
  return host;
}

let daySeq = 100;
/** A unique future LA calendar day per call (12:00 PT — far from any boundary). */
function uniqueFutureStart() {
  daySeq += 1;
  return new Date(Date.UTC(2029, 2, 1 + daySeq, 20, 0, 0)).toISOString();
}

function listingBody(overrides = {}) {
  return {
    title: 'TC-11 verifier meal',
    description: 'A verifier-lane test listing for the FR-11 acceptance.',
    ingredients: ['rice', 'beans'],
    allergens: ['none'],
    cuisine: 'test',
    scheduledStart: uniqueFutureStart(),
    durationMinutes: 90,
    seatCapacity: 4,
    addressLine1: '123 Verifier Way',
    city: 'San Diego',
    region: 'CA',
    postalCode: '92101',
    ...overrides,
  };
}

function post(cookie, overrides = {}) {
  return request(app).post('/api/listings').set('Cookie', cookie).send(listingBody(overrides));
}

// ----------------------------------------------------------------------------------------------

describe('FR-11 / TC-11 — configuration (ADR-009)', () => {
  test('caps are configuration — 1 listing/day, 30 meals/day, 90 meals/week, America/Los_Angeles', () => {
    expect(config.mehko.listingsPerHostPerDay).toBe(1);
    expect(config.mehko.maxMealsPerDay).toBe(30);
    expect(config.mehko.maxMealsPerWeek).toBe(90); // AB 626 set 60; AB 1325 raised it to 90.
    expect(config.mehko.timezone).toBe('America/Los_Angeles');
    expect(Object.isFrozen(config.mehko)).toBe(true);
  });
});

describe('FR-11 / TC-11 — server-side enforcement over POST /api/listings', () => {
  test('eligible host create → 201, born moderation_status=pending, LA local_date persisted', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const start = uniqueFutureStart();

    const res = await post(cookie, { scheduledStart: start });
    expect(res.status).toBe(201);
    expect(res.body.listing.moderationStatus).toBe('pending');

    const { rows } = await query(
      'SELECT moderation_status, local_date::text AS local_date, seat_capacity, seats_remaining FROM listings WHERE id = $1',
      [res.body.listing.id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].moderation_status).toBe('pending');
    expect(rows[0].local_date).toBe(mehko.localDateFor(start));
    expect(rows[0].seats_remaining).toBe(rows[0].seat_capacity);

    // FR-08 substrate: the moderation scan and the geocode job were enqueued WITH the
    // creating transaction (both committed together — no dual write, ADR-001/003).
    const { rows: jobs } = await query(
      `SELECT type FROM outbox_jobs
        WHERE (payload->>'contentId' = $1 OR payload->>'listingId' = $1)`,
      [res.body.listing.id]
    );
    const types = jobs.map((j) => j.type).sort();
    expect(types).toEqual(['listing.geocode', 'moderation.scan']);
  });

  test('one listing per host per LA day: second same-day create → 409 MEHKO_DAILY_LISTING_LIMIT, no row', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const start = uniqueFutureStart();

    await post(cookie, { scheduledStart: start }).expect(201);
    const dup = await post(cookie, { scheduledStart: start });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('MEHKO_DAILY_LISTING_LIMIT');

    const { rows } = await query(
      `SELECT count(*)::int AS c FROM listings WHERE host_id = $1 AND status <> 'cancelled'`,
      [host.id]
    );
    expect(rows[0].c).toBe(1);
  });

  test('re-create path: a CANCELLED listing does not block a new listing on the same day', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const start = uniqueFutureStart();

    const first = await post(cookie, { scheduledStart: start }).expect(201);
    await request(app)
      .post(`/api/listings/${first.body.listing.id}/cancel`)
      .set('Cookie', cookie)
      .expect(200);

    const second = await post(cookie, { scheduledStart: start });
    expect(second.status).toBe(201);
  });

  test('seatCapacity above config.mehko.maxMealsPerDay → 422 MEHKO_DAILY_MEAL_LIMIT, no row', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);

    const res = await post(cookie, { seatCapacity: config.mehko.maxMealsPerDay + 1 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MEHKO_DAILY_MEAL_LIMIT');

    const { rows } = await query('SELECT count(*)::int AS c FROM listings WHERE host_id = $1', [
      host.id,
    ]);
    expect(rows[0].c).toBe(0);
  });

  test('weekly meal cap: full-cap days fill the week; one more seat that week → 422 MEHKO_WEEKLY_MEAL_LIMIT', async () => {
    // Mon 2028-03-13 … Sun 2028-03-19 is ONE Monday-anchored LA week (ADR-009, ratified
    // 2026-08-18). How many max-day listings it takes to fill that week is DERIVED from config,
    // never hardcoded, so a future amendment to either cap cannot silently void this test —
    // which is exactly what the AB 1325 change from 60 to 90 did to its previous form.
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const perDay = config.mehko.maxMealsPerDay;
    const daysToFill = Math.floor(config.mehko.maxMealsPerWeek / perDay);
    // One listing per host per day, so each filling listing needs its own day, and the
    // overflow listing needs one more — all inside the same 7-day week.
    expect(daysToFill).toBeLessThan(7);

    for (let i = 0; i < daysToFill; i += 1) {
      const day = `2028-03-${String(13 + i).padStart(2, '0')}T20:00:00.000Z`;
      await post(cookie, { scheduledStart: day, seatCapacity: perDay }).expect(201);
    }

    const overflow = `2028-03-${String(13 + daysToFill).padStart(2, '0')}T20:00:00.000Z`;
    const over = await post(cookie, { scheduledStart: overflow, seatCapacity: 1 });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('MEHKO_WEEKLY_MEAL_LIMIT');
  });

  test('TCB-01 (round 2): weekly cap is the Monday-anchored LA calendar week, NOT a rolling 7-day window', async () => {
    // The FR-11 acceptance (requirements-inventory, corrected this round) pins the weekly cap
    // to the Monday-anchored America/Los_Angeles calendar week per ADR-009 + build-plan §3;
    // the SRS is silent on any weekly anchor (its AB 626 wording is daily-only).
    //
    // Discriminator: fill the week that ENDS Sunday 2028-03-12 using its TRAILING days, so the
    // rolling window immediately before Monday is as full as the rules allow. Then post on
    // Monday 2028-03-13:
    //   - rolling 7-day reading  → the trailing window still holds a full cap → would reject;
    //   - Monday-anchored reading → a NEW week with 0 seats → must succeed (201).
    // (DST starts 2028-03-12 02:00 PT; all instants below are mid-day, far from boundaries.)
    const sun = '2028-03-12T20:00:00.000Z'; // 13:00 PDT Sun — last day of the old week
    const mon = '2028-03-13T20:00:00.000Z'; // 13:00 PDT Mon — first day of the new week
    const perDay = config.mehko.maxMealsPerDay;
    const daysToFill = Math.floor(config.mehko.maxMealsPerWeek / perDay);
    expect(daysToFill).toBeLessThan(7);

    // The unit boundary math itself: Sunday and Monday land in DIFFERENT weeks.
    expect(mehko.weekRangeFor(sun)).toEqual({ weekStart: '2028-03-06', weekEnd: '2028-03-12' });
    expect(mehko.weekRangeFor(mon)).toEqual({ weekStart: '2028-03-13', weekEnd: '2028-03-19' });

    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    // Old week, filled on its last `daysToFill` days (… Sat 3-11, Sun 3-12).
    for (let i = 0; i < daysToFill; i += 1) {
      const dayNum = 12 - (daysToFill - 1 - i);
      const day = `2028-03-${String(dayNum).padStart(2, '0')}T20:00:00.000Z`;
      await post(cookie, { scheduledStart: day, seatCapacity: perDay }).expect(201);
    }

    // The old week is full; Monday belongs to the NEXT Monday-anchored week, so it is allowed.
    const monday = await post(cookie, { scheduledStart: mon, seatCapacity: perDay });
    expect(monday.status).toBe(201);

    // And the new week's ledger really started fresh: fill the rest of it, then +1 seat trips.
    for (let i = 1; i < daysToFill; i += 1) {
      const day = `2028-03-${String(13 + i).padStart(2, '0')}T20:00:00.000Z`;
      await post(cookie, { scheduledStart: day, seatCapacity: perDay }).expect(201);
    }
    const overflow = `2028-03-${String(13 + daysToFill).padStart(2, '0')}T20:00:00.000Z`;
    const over = await post(cookie, { scheduledStart: overflow, seatCapacity: 1 });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('MEHKO_WEEKLY_MEAL_LIMIT');
  });

  test('ADR-009 timezone pin: 23:30 PT and 00:30 PT next day (same UTC day) are DIFFERENT days; one LA day across two UTC days is ONE day', async () => {
    // Same UTC day (2028-07-05Z), different LA days → both must succeed.
    const hostA = await makeEligibleHost();
    const cookieA = await cookieFor(hostA);
    const lateNight = '2028-07-05T06:30:00.000Z'; // 2028-07-04 23:30 PDT
    const earlyMorning = '2028-07-05T07:30:00.000Z'; // 2028-07-05 00:30 PDT
    expect(mehko.localDateFor(lateNight)).not.toBe(mehko.localDateFor(earlyMorning));
    await post(cookieA, { scheduledStart: lateNight }).expect(201);
    await post(cookieA, { scheduledStart: earlyMorning }).expect(201);

    // Different UTC days (Jul 12Z vs Jul 13Z), same LA day → second must 409.
    const hostB = await makeEligibleHost();
    const cookieB = await cookieFor(hostB);
    const afternoon = '2028-07-12T20:00:00.000Z'; // 2028-07-12 13:00 PDT
    const evening = '2028-07-13T02:00:00.000Z'; // 2028-07-12 19:00 PDT
    expect(mehko.localDateFor(afternoon)).toBe(mehko.localDateFor(evening));
    await post(cookieB, { scheduledStart: afternoon }).expect(201);
    const clash = await post(cookieB, { scheduledStart: evening });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('MEHKO_DAILY_LISTING_LIMIT');
  });

  test('ineligible host (no host profile) → 403 with FR-09 reason codes, no row (AB-01)', async () => {
    const user = await makeUser({ phone_enc: 'enc:v1:tc11-fixture' }); // reserve-eligible only
    const cookie = await cookieFor(user);
    const res = await post(cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_ELIGIBLE');
    expect(res.body.error.details.reasons).toEqual(
      expect.arrayContaining(['HOST_PROFILE_INCOMPLETE'])
    );
    const { rows } = await query('SELECT count(*)::int AS c FROM listings WHERE host_id = $1', [
      user.id,
    ]);
    expect(rows[0].c).toBe(0);
  });
});

describe('FR-11 / TC-11 — update and cancel are owner-only; material edits reset moderation', () => {
  test('PATCH by a non-owner → 403 and the listing is untouched', async () => {
    const owner = await makeEligibleHost();
    const created = await post(await cookieFor(owner)).expect(201);
    const listingId = created.body.listing.id;

    const stranger = await makeEligibleHost();
    const res = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', await cookieFor(stranger))
      .send({ title: 'Hijacked title!' });
    expect(res.status).toBe(403);

    const { rows } = await query('SELECT title FROM listings WHERE id = $1', [listingId]);
    expect(rows[0].title).not.toBe('Hijacked title!');
  });

  test('material edit resets moderation_status to pending and enqueues a fresh moderation.scan (FR-08)', async () => {
    const owner = await makeEligibleHost();
    const cookie = await cookieFor(owner);
    const created = await post(cookie).expect(201);
    const listingId = created.body.listing.id;
    await query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [listingId]);

    const before = await query(
      `SELECT count(*)::int AS c FROM outbox_jobs
        WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
      [listingId]
    );

    const res = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', cookie)
      .send({ description: 'A materially different description of the meal.' });
    expect(res.status).toBe(200);

    const { rows } = await query('SELECT moderation_status FROM listings WHERE id = $1', [
      listingId,
    ]);
    expect(rows[0].moderation_status).toBe('pending');

    const after = await query(
      `SELECT count(*)::int AS c FROM outbox_jobs
        WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
      [listingId]
    );
    expect(after.rows[0].c).toBeGreaterThan(before.rows[0].c);
  });

  test('cancel by a non-owner → 403; cancel by the owner cascades to active bookings + FR-13 notify rows', async () => {
    const owner = await makeEligibleHost();
    const cookie = await cookieFor(owner);
    const created = await post(cookie).expect(201);
    const listingId = created.body.listing.id;
    await query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [listingId]);

    const guest = await makeUser({ phone_enc: 'enc:v1:tc11-fixture' });
    const booking = await makeBooking({ listing_id: listingId, guest_id: guest.id });

    const stranger = await makeEligibleHost();
    const forbidden = await request(app)
      .post(`/api/listings/${listingId}/cancel`)
      .set('Cookie', await cookieFor(stranger));
    expect(forbidden.status).toBe(403);

    const res = await request(app).post(`/api/listings/${listingId}/cancel`).set('Cookie', cookie);
    expect(res.status).toBe(200);

    const { rows: l } = await query('SELECT status FROM listings WHERE id = $1', [listingId]);
    expect(l[0].status).toBe('cancelled');
    const { rows: b } = await query('SELECT status FROM bookings WHERE id = $1', [booking.id]);
    expect(b[0].status).toBe('cancelled');
    const { rows: jobs } = await query(
      `SELECT payload FROM outbox_jobs
        WHERE type = 'notify.booking' AND payload->>'bookingId' = $1`,
      [booking.id]
    );
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs[0].payload.event).toBe('listing_cancelled');
    expect(jobs[0].payload.recipientUserId).toBe(guest.id);
  });
});

describe('FR-11 / TC-11 — DB backstop retained from wave 2 (0002 unique index, ADR-009 DDL)', () => {
  test('second non-cancelled listing for the same (host, local_date) violates listings_host_local_date_key', async () => {
    const host = await makeUser({ can_publish_listing: true });
    const first = await makeListing({ host_id: host.id });
    await expect(
      makeListing({
        host_id: host.id,
        scheduled_start: first.scheduled_start,
        local_date: first.local_date,
      })
    ).rejects.toMatchObject({ code: '23505', constraint: 'listings_host_local_date_key' });
  });

  test('concurrent duplicate creations cannot both commit (unique index under two open transactions)', async () => {
    const host = await makeUser({ can_publish_listing: true });
    const template = await makeListing({ host_id: host.id, status: 'cancelled' }); // reserve a day
    const day = template.local_date;
    const start = template.scheduled_start;

    const c1 = await getClient();
    const c2 = await getClient();
    const insertSql = `
      INSERT INTO listings (host_id, title, description, ingredients, allergens, cuisine,
        scheduled_start, local_date, duration_minutes, city, region, country,
        coarse_lat, coarse_lng, area_label, seat_capacity, seats_remaining)
      VALUES ($1, $2, 'race', '{"rice"}', '{"none"}', 'test', $3, $4, 60,
        'San Diego', 'CA', 'US', 32.75, -117.15, 'San Diego', 4, 4)
      RETURNING id`;
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      await c1.query(insertSql, [host.id, 'race-a', start, day]);
      const second = c2.query(insertSql, [host.id, 'race-b', start, day]).then(
        () => null,
        (err) => err
      );
      await new Promise((r) => setTimeout(r, 100));
      await c1.query('COMMIT');
      expect(await second).toMatchObject({ code: '23505' });
      await c2.query('ROLLBACK');
    } finally {
      c1.release();
      c2.release();
    }

    const { rows } = await query(
      `SELECT count(*)::int AS c FROM listings
        WHERE host_id = $1 AND local_date = $2 AND status <> 'cancelled'`,
      [host.id, day]
    );
    expect(rows[0].c).toBe(1);
  });

  test('ADR-009: no cap literal is baked into the DDL — caps stay config-only', async () => {
    const { rows } = await query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'listings'::regclass AND contype = 'c'`
    );
    const defs = rows.map((r) => r.def).join('\n');
    // Scan for the CURRENT cap values, read from config — hardcoding them here would be the
    // very mistake this test exists to catch, and would go stale on the next AB amendment.
    for (const cap of [config.mehko.maxMealsPerDay, config.mehko.maxMealsPerWeek]) {
      expect(defs).not.toMatch(new RegExp(`\\b${cap}\\b`));
    }
  });
});
