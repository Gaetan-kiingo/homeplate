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

// ----------------------------------------------------------------------------------------------
// FR-11 merged from the wave-3 re-verification files (tcb-w3-reverify /
// tcbv2-independent-reverify): the single-enforcement-point audits, the ratified calendar-week
// residual risk, the local_date wire shape and the capacity-shrink interaction.
// ----------------------------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', '..', 'src');

/** Every .js file under src/ (recursive). */
function srcFiles(dir = SRC, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) srcFiles(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

describe('FR-11 — server-side MEHKO enforcement is single-sourced (ADR-009)', () => {
  test('exactly one module calls the cap checker, and it is the listing service', () => {
    const { stripComments } = require('../helpers/capScan');
    const callers = srcFiles()
      .filter((f) => /assertWithinCaps/.test(stripComments(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(SRC, f).replace(/\\/g, '/'))
      .sort();
    expect(callers).toEqual(['modules/listings/mehko.js', 'modules/listings/service.js']);
  });

  test('the cap NUMBERS appear only in src/config — never inline in a module', () => {
    const { capLiteralHits } = require('../helpers/capScan');
    const offenders = [];
    for (const file of srcFiles()) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      if (rel.startsWith('config/')) continue;
      // capLiteralHits strips comments and skips geographic lines: since AB 1325 the weekly cap
      // is 90, which is also the maximum latitude (src/schemas/common.js, src/lib/geoPrecision.js).
      for (const hit of capLiteralHits(fs.readFileSync(file, 'utf8'), [
        config.mehko.maxMealsPerDay,
        config.mehko.maxMealsPerWeek,
      ])) {
        offenders.push(`${rel}:${hit.line}: ${hit.text.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('TCB-01 (ACCEPTED RESIDUAL RISK, ADR-009 ratified 2026-08-18): the calendar week lets one host serve twice the weekly cap across its boundary', async () => {
    // ADR-009 ratified a Monday–Sunday LA calendar week on 2026-08-18, because California MEHKO
    // weekly limits are calculated on a calendar-week basis rather than a rolling-day one. A
    // calendar week is therefore spreadable across its boundary by construction: filling the
    // trailing days of week N and the leading days of week N+1 places TWICE the weekly cap
    // inside a single 7-day span. A rolling-7-day reading would refuse the crossing listing.
    // This test pins that accepted residual risk so it stays visible and cannot regress
    // silently; it is not a defect report.
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const cap = config.mehko.maxMealsPerDay; // 30
    const create = (start) => post(cookie, { scheduledStart: start, seatCapacity: cap });

    // Week N is Mon 2031-03-03 … Sun 03-09; week N+1 starts Mon 03-10. Fill the trailing
    // `daysToFill` days of week N and the leading `daysToFill` of week N+1 — every one of them
    // legal in its own week — and they all land inside a single 7-day span.
    const daysToFill = Math.floor(config.mehko.maxMealsPerWeek / cap);
    const day = (n) => `2031-03-${String(n).padStart(2, '0')}T20:00:00.000Z`;
    const firstDay = 10 - daysToFill; // trailing days of week N, ending Sun 03-09
    for (let i = 0; i < 2 * daysToFill; i += 1) {
      expect((await create(day(firstDay + i))).status).toBe(201);
    }

    const spanEnd = firstDay + 2 * daysToFill - 1;
    expect(spanEnd - firstDay).toBeLessThan(7); // all of it inside one 7-day span
    const isoDay = (n) => `2031-03-${String(n).padStart(2, '0')}`;
    const { rows } = await query(
      `SELECT COALESCE(sum(seat_capacity), 0)::int AS seats FROM listings
        WHERE host_id = $1 AND status <> 'cancelled'
          AND local_date BETWEEN $2::date AND $3::date`,
      [host.id, isoDay(firstDay), isoDay(spanEnd)]
    );
    expect(rows[0].seats).toBe(2 * config.mehko.maxMealsPerWeek);
    expect(rows[0].seats).toBeGreaterThan(config.mehko.maxMealsPerWeek);
  });
});

describe('ADRC-W3-01 / FR-11 — listings.local_date on the wire', () => {
  test('POST and GET /api/listings/:id return localDate as YYYY-MM-DD, not a timezone-dependent instant', async () => {
    // The hazard: node-postgres hands back a JS Date for a SQL DATE, so a naive String()
    // yields a full locale timestamp ("Mon Mar 15 2030 00:00:00 GMT-0700 (…)") that nothing
    // downstream can read as a MEHKO calendar day. The serializer must render the plain
    // ISO calendar date. (The matching audit-record assertion lives in
    // tests/mt-ut-quality/mt01-wave3-audit-gaps.test.js.)
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const start = new Date(Date.UTC(2030, 6, 9, 20, 0, 0)).toISOString(); // 13:00 PDT 2030-07-09
    const created = await post(cookie, { scheduledStart: start });
    expect(created.status).toBe(201);
    expect(created.body.listing.localDate).toBe('2030-07-09');
    expect(created.body.listing.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The owner's read path too.
    const detail = await request(app)
      .get(`/api/listings/${created.body.listing.id}`)
      .set('Cookie', cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.listing.localDate).toBe('2030-07-09');
  });
});

describe('FR-11/FR-14 — capacity shrink interacts safely with the 0001 seats CHECK', () => {
  test('capacity shrink then cancel does not violate the seats CHECK (atomic restore stays in range)', async () => {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const created = await post(hostCookie, {
      scheduledStart: new Date(Date.UTC(2030, 8, 11, 20, 0, 0)).toISOString(),
    });
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;
    await query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [listingId]);

    const book = async () => {
      const guest = await makeUser({ phone_enc: 'enc:v1:tc11-fixture' });
      const cookie = await cookieFor(guest);
      const res = await request(app)
        .post('/api/bookings')
        .set('Cookie', cookie)
        .send({ listingId });
      expect(res.status).toBe(201);
      return { cookie, bookingId: res.body.booking.id };
    };
    await book();
    const b2 = await book();
    const seatsRemaining = async () =>
      (await query('SELECT seats_remaining FROM listings WHERE id = $1', [listingId])).rows[0]
        .seats_remaining;
    expect(await seatsRemaining()).toBe(2);

    // Shrink to exactly the booked count → seats_remaining 0.
    const shrink = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', hostCookie)
      .send({ seatCapacity: 2 });
    expect(shrink.status).toBe(200);
    expect(await seatsRemaining()).toBe(0);

    // Shrinking BELOW the booked count is refused (would make the restore impossible).
    const tooFar = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', hostCookie)
      .send({ seatCapacity: 1 });
    expect(tooFar.status).toBe(409);
    expect(tooFar.body.error.code).toBe('SEAT_CAPACITY_BELOW_BOOKED');

    // Cancel one → restores to 1, still ≤ seat_capacity (no 23514).
    const cancelled = await request(app)
      .post(`/api/bookings/${b2.bookingId}/cancel`)
      .set('Cookie', b2.cookie)
      .send({});
    expect(cancelled.status).toBe(200);
    expect(await seatsRemaining()).toBe(1);
  });
});
