// tests/tc-booking/tc12-tc14-booking-schema.test.js — VERIFIER lane "tc-booking",
// TC-12 (FR-12 atomic seat reservation, AB-02) and TC-14 (FR-14 cancellation restores
// capacity). Wave 3 is BUILT: this file runs the full API acceptance (it replaces the
// wave-2 "WAVE-3 GAP" probes per build-plan §7):
//  - FR-12 race: seats_remaining=1 with 50 concurrent POSTs → exactly 1×201, 49×409,
//    seats 0, sum(non-cancelled bookings) == seats consumed (never overbooked);
//  - a rejected request (409 NO_CAPACITY) leaves capacity UNCHANGED and writes no row;
//  - AB-02: a scripted guest is stopped at config.booking.maxConcurrentPending with
//    409 BOOKING_LIMIT; attempts 4..20 create no rows and leave seats unchanged;
//  - FR-09 at the route: an ineligible guest gets 403 and no row is written;
//  - booking one's own listing → 409; unapproved listing → 404 (FR-08 no oracle);
//  - FR-14: cancel by guest or host strictly before start → status cancelled, seat
//    restored exactly once, notify rows in the same transaction; repeat AND concurrent
//    cancels are idempotent (seats_remaining never exceeds seat_capacity); at/after
//    start → 409; non-participant → 403;
//  - the wave-2 DB CHECK backstops retained (overbooking / double-restore DB-impossible).
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const {
  query,
  makeListing,
  makeBooking,
  makeUser,
  makeHostProfile,
  closeDb,
} = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const { pollOnlyThese } = require('../helpers/outboxScope');
const config = require('../../src/config');
const sessions = require('../../src/modules/auth/sessions');

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

/** FR-09-eligible guest: verified email + full name + phone ciphertext present. */
async function makeGuest(overrides = {}) {
  return makeUser({ phone_enc: 'enc:v1:tc12-fixture', ...overrides });
}

/** Publicly bookable listing: approved + active + future start. */
async function makeApprovedListing(overrides = {}) {
  return makeListing({ moderation_status: 'approved', ...overrides });
}

async function seatsRemaining(listingId) {
  const { rows } = await query('SELECT seats_remaining FROM listings WHERE id = $1', [listingId]);
  return rows[0].seats_remaining;
}

async function bookingCount(listingId, statuses = null) {
  const { rows } = await query(
    `SELECT count(*)::int AS c FROM bookings
      WHERE listing_id = $1 AND ($2::text[] IS NULL OR status::text = ANY($2))`,
    [listingId, statuses]
  );
  return rows[0].c;
}

function book(cookie, listingId) {
  return request(app).post('/api/bookings').set('Cookie', cookie).send({ listingId });
}

function cancel(cookie, bookingId) {
  return request(app).post(`/api/bookings/${bookingId}/cancel`).set('Cookie', cookie).send({});
}

// ----------------------------------------------------------------------------------------------
// TC-12 — FR-12 atomic reservation
// ----------------------------------------------------------------------------------------------

describe('FR-12 / TC-12 — POST /api/bookings atomic capacity', () => {
  test('config: per-guest concurrent-pending cap defaults to 3 (AB-02)', () => {
    expect(config.booking.maxConcurrentPending).toBe(3);
  });

  test('happy path: eligible guest books remaining seat → 201, seat decremented, booking pending', async () => {
    const listing = await makeApprovedListing({ seat_capacity: 3, seats_remaining: 3 });
    const guest = await makeGuest();
    const res = await book(await cookieFor(guest), listing.id);
    expect(res.status).toBe(201);
    expect(res.body.booking.status).toBe('pending');
    expect(res.body.booking.guestId).toBe(guest.id);
    expect(await seatsRemaining(listing.id)).toBe(2);
    expect(await bookingCount(listing.id)).toBe(1);
  });

  test('RACE (LT-01 assertion): seats_remaining=1, 50 concurrent POSTs → exactly 1×201, 49×409, never overbooked', async () => {
    const listing = await makeApprovedListing({ seat_capacity: 1, seats_remaining: 1 });
    const guests = await Promise.all(Array.from({ length: 50 }, () => makeGuest()));
    const cookies = await Promise.all(guests.map((g) => cookieFor(g)));

    const responses = await Promise.all(cookies.map((c) => book(c, listing.id)));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(49);
    for (const r of responses) {
      if (r.status === 409) expect(r.body.error.code).toBe('NO_CAPACITY');
    }

    // sum(non-cancelled bookings) == capacity consumed; capacity unchanged by the losers.
    expect(await seatsRemaining(listing.id)).toBe(0);
    const nonCancelled = await bookingCount(listing.id, ['pending', 'in_progress', 'completed']);
    expect(nonCancelled).toBe(1); // == seat_capacity − seats_remaining, never more
  });

  test('rejected request leaves capacity UNCHANGED and writes no row (full listing → 409 NO_CAPACITY)', async () => {
    const listing = await makeApprovedListing({ seat_capacity: 2, seats_remaining: 0 });
    const guest = await makeGuest();
    const res = await book(await cookieFor(guest), listing.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_CAPACITY');
    expect(await seatsRemaining(listing.id)).toBe(0);
    expect(await bookingCount(listing.id)).toBe(0);
  });

  test('AB-02: scripted guest making 20 sequential attempts is stopped at maxConcurrentPending with 409 BOOKING_LIMIT', async () => {
    const guest = await makeGuest();
    const cookie = await cookieFor(guest);
    const limit = config.booking.maxConcurrentPending; // 3

    // Fill the cap over distinct listings (one per host — listings are host-day-unique).
    for (let i = 0; i < limit; i += 1) {
      const listing = await makeApprovedListing({ seat_capacity: 4, seats_remaining: 4 });
      await book(cookie, listing.id).expect(201);
    }

    // Attempts limit+1 .. 20: all refused, no rows, capacity of the target untouched.
    const target = await makeApprovedListing({ seat_capacity: 10, seats_remaining: 10 });
    for (let attempt = limit; attempt < 20; attempt += 1) {
      const res = await book(cookie, target.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BOOKING_LIMIT');
    }
    expect(await seatsRemaining(target.id)).toBe(10);
    expect(await bookingCount(target.id)).toBe(0);
    const { rows } = await query(
      `SELECT count(*)::int AS c FROM bookings WHERE guest_id = $1 AND status = 'pending'`,
      [guest.id]
    );
    expect(rows[0].c).toBe(limit);
  });

  test('FR-09 at the route: ineligible guest (missing phone) → 403 with reason codes, NO row, capacity unchanged', async () => {
    const listing = await makeApprovedListing({ seat_capacity: 2, seats_remaining: 2 });
    const ineligible = await makeUser({ phone_enc: null }); // verified+named, phone missing
    const res = await book(await cookieFor(ineligible), listing.id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_ELIGIBLE');
    expect(res.body.error.details.reasons).toEqual(['PHONE_MISSING']);
    expect(await seatsRemaining(listing.id)).toBe(2);
    expect(await bookingCount(listing.id)).toBe(0);
  });

  test("booking one's own listing → 409, capacity unchanged", async () => {
    const host = await makeGuest({ can_publish_listing: true });
    const listing = await makeApprovedListing({
      host_id: host.id,
      seat_capacity: 2,
      seats_remaining: 2,
    });
    const res = await book(await cookieFor(host), listing.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OWN_LISTING');
    expect(await seatsRemaining(listing.id)).toBe(2);
  });

  test('unapproved (pending) listing is unbookable and indistinguishable from missing → 404 (FR-08)', async () => {
    const listing = await makeListing({ moderation_status: 'pending' });
    const res = await book(await cookieFor(await makeGuest()), listing.id);
    expect(res.status).toBe(404);
    expect(await bookingCount(listing.id)).toBe(0);
  });

  test('unauthenticated → 401 (AB-08); malformed listingId → 422 before any capacity work', async () => {
    const unauth = await request(app).post('/api/bookings').send({ listingId: 'x' });
    expect(unauth.status).toBe(401);
    const malformed = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(await makeGuest()))
      .send({ listingId: 'not-a-uuid' });
    expect(malformed.status).toBe(422);
  });
});

// ----------------------------------------------------------------------------------------------
// TC-14 — FR-14 cancellation restores capacity atomically
// ----------------------------------------------------------------------------------------------

describe('FR-14 / TC-14 — POST /api/bookings/:id/cancel', () => {
  async function bookedFixture({ seat_capacity = 3 } = {}) {
    const listing = await makeApprovedListing({ seat_capacity, seats_remaining: seat_capacity });
    const guest = await makeGuest();
    const guestCookie = await cookieFor(guest);
    const res = await book(guestCookie, listing.id);
    expect(res.status).toBe(201);
    return { listing, guest, guestCookie, bookingId: res.body.booking.id };
  }

  test('guest cancels before start → cancelled, seat restored exactly once, notify rows written transactionally', async () => {
    const { listing, guest, guestCookie, bookingId } = await bookedFixture();
    expect(await seatsRemaining(listing.id)).toBe(2);

    const res = await cancel(guestCookie, bookingId);
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('cancelled');
    expect(await seatsRemaining(listing.id)).toBe(3);

    const { rows } = await query('SELECT status, cancelled_at FROM bookings WHERE id = $1', [
      bookingId,
    ]);
    expect(rows[0].status).toBe('cancelled');
    expect(rows[0].cancelled_at).not.toBeNull();

    // FR-13: cancellation notifications enqueued for both parties, IDs only.
    const { rows: jobs } = await query(
      `SELECT payload FROM outbox_jobs
        WHERE type = 'notify.booking' AND payload->>'bookingId' = $1
          AND payload->>'event' = 'cancelled_by_guest'`,
      [bookingId]
    );
    const recipients = jobs.map((j) => j.payload.recipientUserId).sort();
    expect(recipients).toEqual([guest.id, listing.host_id].sort());
  });

  test('host cancels the booking on their listing before start → 200, seat restored', async () => {
    const { listing, bookingId } = await bookedFixture();
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [listing.host_id]);
    const res = await cancel(await cookieFor(rows[0]), bookingId);
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('cancelled');
    expect(await seatsRemaining(listing.id)).toBe(3);
  });

  test('repeat cancel is idempotent: second cancel → 200, seat NOT restored twice', async () => {
    const { listing, guestCookie, bookingId } = await bookedFixture();
    await cancel(guestCookie, bookingId).expect(200);
    const again = await cancel(guestCookie, bookingId);
    expect(again.status).toBe(200);
    expect(again.body.booking.status).toBe('cancelled');
    expect(await seatsRemaining(listing.id)).toBe(3); // == seat_capacity, not 4
  });

  test('CONCURRENT cancels never double-restore: 10 simultaneous cancels → seats_remaining == seat_capacity exactly', async () => {
    const { listing, guestCookie, bookingId } = await bookedFixture();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => cancel(guestCookie, bookingId))
    );
    for (const r of responses) expect(r.status).toBe(200);
    expect(await seatsRemaining(listing.id)).toBe(listing.seat_capacity);
  });

  test('cancel at/after scheduled start → 409, no state change, no seat restore', async () => {
    const started = await makeListing({
      moderation_status: 'approved',
      scheduled_start: new Date(Date.now() - 3600 * 1000),
      seat_capacity: 4,
      seats_remaining: 3,
    });
    const guest = await makeGuest();
    const booking = await makeBooking({ listing_id: started.id, guest_id: guest.id });

    const res = await cancel(await cookieFor(guest), booking.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANCEL_TOO_LATE');
    const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [booking.id]);
    expect(rows[0].status).toBe('pending');
    expect(await seatsRemaining(started.id)).toBe(3);
  });

  test('non-participant cancel → 403, nothing changes', async () => {
    const { listing, bookingId } = await bookedFixture();
    const stranger = await makeGuest();
    const res = await cancel(await cookieFor(stranger), bookingId);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_PARTICIPANT');
    const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    expect(rows[0].status).toBe('pending');
    expect(await seatsRemaining(listing.id)).toBe(2);
  });
});

// ----------------------------------------------------------------------------------------------
// Lifecycle plumbing the cancel/complete flows depend on (build-plan §6.4)
// ----------------------------------------------------------------------------------------------

describe('FR-12/FR-04 — scheduled promotion job (pending → in_progress at scheduled_start)', () => {
  test('promote job enqueued at creation with availableAt = scheduled_start; due job promotes; redelivery is a no-op', async () => {
    const { createRegistry } = require('../../src/outbox/dispatch');
    const promoteHandler = require('../../src/outbox/handlers/bookingPromote');

    const listing = await makeApprovedListing({ seat_capacity: 2, seats_remaining: 2 });
    const guest = await makeGuest();
    const res = await book(await cookieFor(guest), listing.id);
    expect(res.status).toBe(201);
    const bookingId = res.body.booking.id;

    const { rows: jobs } = await query(
      `SELECT * FROM outbox_jobs WHERE type = 'booking.promote' AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    expect(jobs).toHaveLength(1);
    expect(new Date(jobs[0].available_at).getTime()).toBe(
      new Date(listing.scheduled_start).getTime()
    );

    // Simulate the start instant arriving: start moved to the past + job due now.
    await query(`UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`, [
      listing.id,
    ]);
    await query(`UPDATE outbox_jobs SET available_at = now() WHERE id = $1`, [jobs[0].id]);
    const registry = createRegistry([promoteHandler]);

    // Deliver through the real worker claim path, scoped to rows this test created — see
    // tests/helpers/outboxScope.js for the TCBV2-01 finding (foreign pending rows win the
    // 10 claim slots) that the helper's parking exists to handle.
    const deliverScoped = (jobId) => pollOnlyThese([jobId], registry, 5);

    await deliverScoped(jobs[0].id);

    const { rows: promoted } = await query('SELECT status FROM bookings WHERE id = $1', [
      bookingId,
    ]);
    expect(promoted[0].status).toBe('in_progress');

    // Crash-redelivery stand-in: re-running the job leaves the state untouched (idempotent).
    await query(`UPDATE outbox_jobs SET status = 'pending', available_at = now() WHERE id = $1`, [
      jobs[0].id,
    ]);
    await deliverScoped(jobs[0].id);
    const { rows: again } = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    expect(again[0].status).toBe('in_progress');
  });
});

// ----------------------------------------------------------------------------------------------
// Wave-2 DB backstops retained (the CHECKs that make service regressions non-catastrophic)
// ----------------------------------------------------------------------------------------------

describe('FR-12/FR-14 — DB CHECK backstops (overbooking / double-restore are DB-impossible)', () => {
  test('seats_remaining can never go below 0', async () => {
    const listing = await makeListing({ seat_capacity: 1, seats_remaining: 1 });
    const dec = await query(
      `UPDATE listings SET seats_remaining = seats_remaining - 1
        WHERE id = $1 AND seats_remaining > 0 RETURNING seats_remaining`,
      [listing.id]
    );
    expect(dec.rows).toHaveLength(1);
    const again = await query(
      `UPDATE listings SET seats_remaining = seats_remaining - 1
        WHERE id = $1 AND seats_remaining > 0 RETURNING seats_remaining`,
      [listing.id]
    );
    expect(again.rows).toHaveLength(0);
    await expect(
      query('UPDATE listings SET seats_remaining = seats_remaining - 1 WHERE id = $1', [listing.id])
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('seats_remaining can never exceed seat_capacity', async () => {
    const listing = await makeListing({ seat_capacity: 2, seats_remaining: 2 });
    await expect(
      query('UPDATE listings SET seats_remaining = seats_remaining + 1 WHERE id = $1', [listing.id])
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ----------------------------------------------------------------------------------------------
// FR-12 under genuine CONCURRENCY — merged from the wave-3 re-verification files
// (tcb-w3-reverify / tcbv2-independent-reverify), which re-derived these probes independently
// of the sequential acceptance tests above.
// ----------------------------------------------------------------------------------------------

describe('FR-12 — concurrent seat requests never overbook; refusals leave capacity untouched', () => {
  test('seats_remaining=3, 40 concurrent distinct guests → exactly 3×201, 37×409 NO_CAPACITY, seats 0', async () => {
    const listing = await makeApprovedListing({ seat_capacity: 3, seats_remaining: 3 });
    const cookies = await Promise.all(
      (await Promise.all(Array.from({ length: 40 }, () => makeGuest()))).map(cookieFor)
    );
    const startedAt = Date.now();
    const responses = await Promise.all(cookies.map((c) => book(c, listing.id)));
    const elapsedMs = Date.now() - startedAt;
    const created = responses.filter((r) => r.status === 201);
    const refused = responses.filter((r) => r.status === 409);
    // DIAGNOSTIC, not a relaxation: this assertion has been reported as intermittently failing
    // in full-suite runs with an opaque "Expected length: 3, Received length: N". 40 concurrent
    // requests contend for a pool of src/db/pool.js `max: 10` connections with
    // `connectionTimeoutMillis: 5_000`, so on a loaded host a request can fail to ACQUIRE a
    // connection and return 500 — which is neither 201 nor 409 and silently shrinks both
    // buckets. Surface the real status distribution before the counts are asserted so the next
    // failure names its cause instead of looking like an overbooking bug. The 3/37 assertions
    // below are unchanged.
    const unexpected = responses.filter((r) => r.status !== 201 && r.status !== 409);
    if (unexpected.length > 0) {
      const distribution = responses.reduce((acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      }, {});
      throw new Error(
        `FR-12: ${unexpected.length}/40 concurrent booking responses were neither 201 nor 409 ` +
          `after ${elapsedMs} ms. distribution=${JSON.stringify(distribution)} ` +
          `firstBody=${JSON.stringify(unexpected[0].body)}`
      );
    }
    expect(created).toHaveLength(3);
    expect(refused).toHaveLength(37);
    for (const r of refused) expect(r.body.error.code).toBe('NO_CAPACITY');
    expect(await seatsRemaining(listing.id)).toBe(0);

    const { rows } = await query(
      `SELECT count(*)::int AS c FROM bookings WHERE listing_id = $1 AND status <> 'cancelled'`,
      [listing.id]
    );
    expect(rows[0].c).toBe(3); // == seat_capacity − seats_remaining. Never more.
  }, 30000);

  test('AB-02 under CONCURRENCY: one guest firing maxConcurrentPending+5 simultaneous bookings gets exactly the cap', async () => {
    // The sequential AB-02 acceptance above cannot catch a check-then-insert race on the
    // per-guest pending count (finding TCB-01: the cap must hold under genuine concurrency,
    // not just for a polite scripted guest).
    const limit = config.booking.maxConcurrentPending;
    expect(typeof limit).toBe('number');
    const guest = await makeGuest();
    const cookie = await cookieFor(guest);
    const listings = await Promise.all(
      Array.from({ length: limit + 5 }, () =>
        makeApprovedListing({ seat_capacity: 5, seats_remaining: 5 })
      )
    );
    const responses = await Promise.all(listings.map((l) => book(cookie, l.id)));
    const unexpected = responses.filter((r) => r.status !== 201 && r.status !== 409);
    expect(unexpected.map((r) => [r.status, r.body])).toEqual([]);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(limit);
    const capped = responses.filter((r) => r.status === 409);
    expect(capped).toHaveLength(5);
    for (const r of capped) expect(r.body.error.code).toBe('BOOKING_LIMIT');

    const { rows } = await query(
      `SELECT count(*)::int AS c FROM bookings WHERE guest_id = $1 AND status = 'pending'`,
      [guest.id]
    );
    expect(rows[0].c).toBe(limit);
    // The five refusals consumed no capacity anywhere.
    const seats = await Promise.all(listings.map((l) => seatsRemaining(l.id)));
    expect(seats.filter((s) => s === 4)).toHaveLength(limit);
    expect(seats.filter((s) => s === 5)).toHaveLength(5);
  }, 30000);

  test('a listing already started is refused 409 LISTING_STARTED and the refusal moves no seats', async () => {
    // The refusal CODE itself is pinned by tests/unit/bookings.test.js ("cancelled listing →
    // 409; past listing → 409"); what no other file asserted is that this refusal path — like
    // every other one in this file — leaves capacity and the bookings table untouched.
    const started = await makeApprovedListing({
      seat_capacity: 2,
      seats_remaining: 2,
      scheduled_start: new Date(Date.now() - 3600 * 1000),
    });
    const res = await book(await cookieFor(await makeGuest()), started.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LISTING_STARTED');
    expect(await seatsRemaining(started.id)).toBe(2);
    expect(await bookingCount(started.id)).toBe(0);
  });
});

// ----------------------------------------------------------------------------------------------
// FR-14 under CONCURRENCY — merged from the wave-3 re-verification files
// ----------------------------------------------------------------------------------------------

describe('FR-14 — guest and host cancelling the same booking simultaneously', () => {
  test('restores exactly one seat and enqueues exactly one cancellation notification pair', async () => {
    const listing = await makeApprovedListing({ seat_capacity: 4, seats_remaining: 4 });
    const guest = await makeGuest();
    const guestCookie = await cookieFor(guest);
    const created = await book(guestCookie, listing.id);
    expect(created.status).toBe(201);
    expect(await seatsRemaining(listing.id)).toBe(3);

    const { rows: hostRows } = await query('SELECT * FROM users WHERE id = $1', [listing.host_id]);
    const hostCookie = await cookieFor(hostRows[0]);

    const responses = await Promise.all([
      cancel(guestCookie, created.body.booking.id),
      cancel(hostCookie, created.body.booking.id),
      cancel(guestCookie, created.body.booking.id),
      cancel(hostCookie, created.body.booking.id),
    ]);
    for (const r of responses) expect(r.status).toBe(200);
    expect(await seatsRemaining(listing.id)).toBe(4); // == seat_capacity, never 5+

    // Exactly one cancellation notification pair (no duplicate enqueues per event/recipient),
    // whichever party's cancel won the race.
    const { rows: jobs } = await query(
      `SELECT payload FROM outbox_jobs
        WHERE type = 'notify.booking' AND payload->>'bookingId' = $1
          AND payload->>'event' LIKE 'cancelled_by_%'`,
      [created.body.booking.id]
    );
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.payload.recipientUserId).sort()).toEqual(
      [guest.id, listing.host_id].sort()
    );
  }, 30000);
});

// ----------------------------------------------------------------------------------------------
// The promote job must survive early delivery and listing reschedules — merged from the wave-3
// re-verification files (IT3-F1 and finding TCB-W3-02).
// ----------------------------------------------------------------------------------------------

describe('FR-12/FR-04 — early booking.promote delivery and rescheduled starts never lose the promotion', () => {
  const { createRegistry } = require('../../src/outbox/dispatch');
  const promoteHandler = require('../../src/outbox/handlers/bookingPromote');

  /** FR-09-eligible host (guest attributes + complete host profile + agreement). */
  async function makeEligibleHost() {
    const host = await makeGuest({ can_publish_listing: true });
    await makeHostProfile({ user_id: host.id });
    return host;
  }

  test('IT3-F1: scheduled_start UNCHANGED and still in the future — the delivered row is replaced by a LIVE pending promote row', async () => {
    const start = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    const listing = await makeApprovedListing({
      seat_capacity: 2,
      seats_remaining: 2,
      scheduled_start: start,
    });
    const guest = await makeGuest();
    const res = await book(await cookieFor(guest), listing.id);
    expect(res.status).toBe(201);
    const bookingId = res.body.booking.id;

    const { rows: before } = await query(
      `SELECT * FROM outbox_jobs WHERE type = 'booking.promote' AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    expect(before).toHaveLength(1);
    const originalId = before[0].id;

    // Early delivery: the row comes due while listings.scheduled_start is still in the future
    // (DB clock ahead of the Node clock, or an operator requeue). scheduled_start UNTOUCHED —
    // this is exactly the state in which a naive re-enqueue reproduces the delivered row's own
    // dedupe key and ON CONFLICT DO NOTHING collapses onto it (finding IT3-F1: the promotion
    // was silently lost).
    await query('UPDATE outbox_jobs SET available_at = now() WHERE id = $1', [originalId]);
    await pollOnlyThese([originalId], createRegistry([promoteHandler]));

    const { rows: after } = await query(
      `SELECT id, status, available_at FROM outbox_jobs
        WHERE type = 'booking.promote' AND payload->>'bookingId' = $1 ORDER BY id`,
      [bookingId]
    );
    const live = after.filter((j) => j.status === 'pending');
    // THE assertion: whatever happened to the delivered row, a pending promote row for this
    // booking must still exist, scheduled at the listing's start.
    expect(live.length).toBeGreaterThanOrEqual(1);
    expect(new Date(live[0].available_at).getTime()).toBe(start.getTime());
    // Regression detector: the surviving row must be a DIFFERENT row from the one delivered.
    // A naive re-enqueue reproduces the delivered row's own dedupe key, collapses onto it and
    // leaves zero live rows — this inequality is what distinguishes fixed from broken.
    expect(after.find((j) => String(j.id) === String(originalId)).status).toBe('delivered');
    expect(live.map((j) => String(j.id))).not.toContain(String(originalId));

    // …and the booking was NOT promoted early.
    const { rows: b } = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    expect(b[0].status).toBe('pending');

    // Recovery: the start arrives, the surviving row promotes the booking.
    await query(`UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`, [
      listing.id,
    ]);
    const liveIds = live.map((j) => j.id);
    await query(`UPDATE outbox_jobs SET available_at = now() WHERE id = ANY($1::bigint[])`, [
      liveIds,
    ]);
    await pollOnlyThese(liveIds, createRegistry([promoteHandler]));
    const { rows: promoted } = await query('SELECT status FROM bookings WHERE id = $1', [
      bookingId,
    ]);
    expect(promoted[0].status).toBe('in_progress');
  });

  test('TCB-W3-02 (fixed): moving scheduled_start EARLIER re-enqueues the promote job at the NEW instant and the booking reaches in_progress in time', async () => {
    // lifecycle.js is self-repairing only for starts that move LATER (the old job comes due,
    // sees a future start and re-schedules). A start moved EARLIER has no such repair — the
    // stale row is not due until after the meal — so listings/service.updateListing now
    // enqueues a FRESH promotion at the new instant for every still-pending booking, on the
    // listing update's own transaction (TCB-W3-02, ADR-001/003). This test was written to pin
    // the defect; it is inverted here to pin the fix, and it FAILS if the re-enqueue is lost.
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const farStart = new Date(Date.UTC(2031, 4, 20, 20, 0, 0)); // 2031-05-20 13:00 PDT
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send({
        title: 'Reschedule probe meal',
        description: 'A verifier-lane probe for the promote-job reschedule gap on earlier starts.',
        ingredients: ['rice'],
        allergens: ['none'],
        cuisine: 'test',
        scheduledStart: farStart.toISOString(),
        durationMinutes: 90,
        seatCapacity: 4,
        addressLine1: '9 Probe Street',
        city: 'San Diego',
        region: 'CA',
        postalCode: '92101',
      });
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;
    await query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [listingId]);

    const guest = await makeGuest();
    const guestCookie = await cookieFor(guest);
    const booked = await book(guestCookie, listingId);
    expect(booked.status).toBe(201);
    const bookingId = booked.body.booking.id;

    // Host pulls the meal forward by a month.
    const nearStart = new Date(Date.UTC(2031, 3, 20, 20, 0, 0)); // 2031-04-20 13:00 PDT
    const moved = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', hostCookie)
      .send({ scheduledStart: nearStart.toISOString() });
    expect(moved.status).toBe(200);

    const { rows: promoteJobs } = await query(
      `SELECT id, status, available_at FROM outbox_jobs
        WHERE type = 'booking.promote' AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    // THE assertion (inverted from the reproduction): a LIVE promote row now exists at the
    // NEW instant. The stale row at the old instant may survive — it is harmless (it finds
    // the booking no longer pending, or a start already past, and no-ops).
    const atNew = promoteJobs.filter(
      (j) => j.status === 'pending' && new Date(j.available_at).getTime() === nearStart.getTime()
    );
    expect(atNew).toHaveLength(1);
    expect(
      promoteJobs.every((j) => new Date(j.available_at).getTime() !== farStart.getTime())
    ).toBe(false); // the stale row is still there, and that is fine

    // Functional consequence: when the (new) start arrives the fresh row promotes the booking,
    // so FR-04 dual confirmation is accepted instead of 409 BOOKING_NOT_IN_PROGRESS.
    await query(
      `UPDATE listings SET scheduled_start = now() - interval '5 minutes' WHERE id = $1`,
      [listingId]
    );
    const newIds = atNew.map((j) => j.id);
    await query(`UPDATE outbox_jobs SET available_at = now() WHERE id = ANY($1::bigint[])`, [
      newIds,
    ]);
    await pollOnlyThese(newIds, createRegistry([promoteHandler]));
    const { rows: state } = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    expect(state[0].status).toBe('in_progress');
    const confirm = await request(app)
      .post(`/api/bookings/${bookingId}/confirm-completion`)
      .set('Cookie', guestCookie)
      .send({});
    expect(confirm.status).toBe(200);
  });
});
