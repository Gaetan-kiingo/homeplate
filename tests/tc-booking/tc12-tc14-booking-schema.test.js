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
const { query, makeListing, makeBooking, makeUser, closeDb } = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
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
    const { pollOnce } = require('../../src/outbox/worker');
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
    // Other due jobs (this suite's undelivered notify rows) share the queue: poll until OUR
    // job leaves 'pending' (each pass claims a batch; unhandled types back off out of the way).
    for (let i = 0; i < 20; i += 1) {
      const { rows } = await query('SELECT status FROM outbox_jobs WHERE id = $1', [jobs[0].id]);
      if (rows[0].status !== 'pending') break;
      await pollOnce({ registry });
    }

    const { rows: promoted } = await query('SELECT status FROM bookings WHERE id = $1', [
      bookingId,
    ]);
    expect(promoted[0].status).toBe('in_progress');

    // Crash-redelivery stand-in: re-running the job leaves the state untouched (idempotent).
    await query(`UPDATE outbox_jobs SET status = 'pending', available_at = now() WHERE id = $1`, [
      jobs[0].id,
    ]);
    for (let i = 0; i < 20; i += 1) {
      const { rows } = await query('SELECT status FROM outbox_jobs WHERE id = $1', [jobs[0].id]);
      if (rows[0].status !== 'pending') break;
      await pollOnce({ registry });
    }
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
