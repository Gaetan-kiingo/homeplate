// tests/unit/bookings.test.js — U3-BOOKINGS implementer tests: atomic capacity (FR-12/TC-12),
// cancellation (FR-14/TC-14), dual-confirmation completion (FR-04/TC-04), transactional
// notifications end to end (FR-13/TC-13, RT-02), the AB-02 pending cap, the scheduled
// pending→in_progress promotion (build-plan §6.4), migration 0004, and the ADR-010
// public-fields-only booking payload.
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const config = require('../../src/config');
const { query, makeUser, makeListing, makeBooking, closeDb } = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const sessions = require('../../src/modules/auth/sessions');
const outbox = require('../../src/outbox/outbox');
const { pollOnce } = require('../../src/outbox/worker');
const { createRegistry } = require('../../src/outbox/dispatch');
const mockTransport = require('../../src/adapters/mockTransport');
const bookingsService = require('../../src/modules/bookings/service');
const bookingsRepo = require('../../src/modules/bookings/repo');
const lifecycle = require('../../src/modules/bookings/lifecycle');
const notifyHandler = require('../../src/outbox/handlers/bookingNotifications');
const promoteHandler = require('../../src/outbox/handlers/bookingPromote');

const COOKIE = config.auth.sessionCookieName;

let app;

beforeAll(() => {
  app = createApp({ logger: createLogger({ level: 'silent' }) });
});

afterAll(async () => {
  await closeDb();
  await closeTestRedis();
});

afterEach(() => {
  jest.restoreAllMocks();
  mockTransport.reset();
});

// ---- fixtures --------------------------------------------------------------------------------

/** An FR-09-eligible guest: verified email + full name + phone ciphertext present. */
async function makeGuest(overrides = {}) {
  return makeUser({ phone_enc: 'enc:v1:unit-test-ciphertext', ...overrides });
}

/** Session cookie header value for a user row. */
async function cookieFor(user) {
  const { token } = await sessions.createSession(user);
  return `${COOKIE}=${token}`;
}

/** A publicly bookable listing: approved + active + future start. */
async function makeApprovedListing(overrides = {}) {
  return makeListing({ moderation_status: 'approved', ...overrides });
}

async function seatsRemaining(listingId) {
  const { rows } = await query('SELECT seats_remaining FROM listings WHERE id = $1', [listingId]);
  return rows[0].seats_remaining;
}

async function bookingRow(id) {
  const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function outboxJobsFor(bookingId, type) {
  const { rows } = await query(
    `SELECT * FROM outbox_jobs WHERE type = $1 AND payload->>'bookingId' = $2 ORDER BY id`,
    [type, bookingId]
  );
  return rows;
}

/** Registry limited to THIS unit's handlers so the tests never depend on sibling files. */
function bookingRegistry() {
  return createRegistry([notifyHandler, promoteHandler]);
}

const silent = createLogger({ level: 'silent' });

// ----------------------------------------------------------------------------------------------
// Migration 0004
// ----------------------------------------------------------------------------------------------
describe('migration 0004 — bookings.completed_at (FR-04)', () => {
  test('column exists as nullable timestamptz on a database migrated from wave 2', async () => {
    const { rows } = await query(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'bookings' AND column_name = 'completed_at'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('timestamp with time zone');
    expect(rows[0].is_nullable).toBe('YES');
  });

  test('migration is append-only: 0001–0003 are recorded unchanged alongside 0004', async () => {
    const { rows } = await query(`SELECT version FROM schema_migrations ORDER BY version`);
    const versions = rows.map((r) => r.version);
    expect(versions).toEqual(expect.arrayContaining(['0001', '0002', '0003', '0004']));
  });
});

// ----------------------------------------------------------------------------------------------
// TC-12 — atomic reservation (FR-12, AB-02, FR-09)
// ----------------------------------------------------------------------------------------------
describe('TC-12 / FR-12 — POST /api/bookings atomic capacity', () => {
  test('race: seats_remaining=1 with 50 concurrent POSTs → exactly 1 commits, 49× 409, never overbooked', async () => {
    const listing = await makeApprovedListing({ seat_capacity: 1, seats_remaining: 1 });
    const guests = await Promise.all(Array.from({ length: 50 }, () => makeGuest()));
    const cookies = await Promise.all(guests.map((g) => cookieFor(g)));

    const responses = await Promise.all(
      cookies.map((cookie) =>
        request(app).post('/api/bookings').set('Cookie', cookie).send({ listingId: listing.id })
      )
    );

    const created = responses.filter((r) => r.status === 201);
    const rejected = responses.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(49);
    for (const r of rejected) expect(r.body.error.code).toBe('NO_CAPACITY');

    expect(await seatsRemaining(listing.id)).toBe(0);
    // sum(non-cancelled bookings) = seat_capacity — never overbooked.
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM bookings WHERE listing_id = $1 AND status <> 'cancelled'`,
      [listing.id]
    );
    expect(rows[0].n).toBe(listing.seat_capacity);
  }, 30000);

  test('AB-02: 4th sequential pending booking → 409 BOOKING_LIMIT with zero rows written', async () => {
    const guest = await makeGuest();
    const cookie = await cookieFor(guest);
    for (let i = 0; i < config.booking.maxConcurrentPending; i += 1) {
      const listing = await makeApprovedListing();
      const res = await request(app)
        .post('/api/bookings')
        .set('Cookie', cookie)
        .send({ listingId: listing.id });
      expect(res.status).toBe(201);
    }
    const fourth = await makeApprovedListing({ seat_capacity: 4, seats_remaining: 4 });
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', cookie)
      .send({ listingId: fourth.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BOOKING_LIMIT');
    // Zero rows written, capacity untouched.
    const { rows } = await query(`SELECT count(*)::int AS n FROM bookings WHERE guest_id = $1`, [
      guest.id,
    ]);
    expect(rows[0].n).toBe(config.booking.maxConcurrentPending);
    expect(await seatsRemaining(fourth.id)).toBe(4);
  });

  test('AB-02 race-free: 5 concurrent creates by one guest → exactly 3 commit (advisory lock)', async () => {
    const guest = await makeGuest();
    const cookie = await cookieFor(guest);
    const listings = await Promise.all(Array.from({ length: 5 }, () => makeApprovedListing()));
    const responses = await Promise.all(
      listings.map((l) =>
        request(app).post('/api/bookings').set('Cookie', cookie).send({ listingId: l.id })
      )
    );
    const created = responses.filter((r) => r.status === 201);
    const limited = responses.filter(
      (r) => r.status === 409 && r.body.error.code === 'BOOKING_LIMIT'
    );
    expect(created).toHaveLength(config.booking.maxConcurrentPending);
    expect(limited).toHaveLength(5 - config.booking.maxConcurrentPending);
  }, 30000);

  test('FR-09: ineligible guest → 403 before any capacity work, zero rows', async () => {
    const ineligible = await makeUser(); // no phone_enc → not eligible to reserve
    const cookie = await cookieFor(ineligible);
    const listing = await makeApprovedListing({ seat_capacity: 2, seats_remaining: 2 });
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', cookie)
      .send({ listingId: listing.id });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_ELIGIBLE');
    expect(await seatsRemaining(listing.id)).toBe(2);
    const { rows } = await query(`SELECT count(*)::int AS n FROM bookings WHERE guest_id = $1`, [
      ineligible.id,
    ]);
    expect(rows[0].n).toBe(0);
  });

  test("booking one's own listing → 409 OWN_LISTING", async () => {
    const host = await makeGuest({ can_publish_listing: true });
    const listing = await makeApprovedListing({ host_id: host.id });
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(host))
      .send({ listingId: listing.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OWN_LISTING');
  });

  test('pending-moderation listing is not bookable → 404 (invisible until approved, FR-08)', async () => {
    const listing = await makeListing(); // moderation_status defaults 'pending'
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(await makeGuest()))
      .send({ listingId: listing.id });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LISTING_NOT_FOUND');
  });

  test('rejected listing is not bookable → 404', async () => {
    const listing = await makeListing({ moderation_status: 'rejected' });
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(await makeGuest()))
      .send({ listingId: listing.id });
    expect(res.status).toBe(404);
  });

  test('cancelled listing → 409; past listing → 409', async () => {
    const cancelled = await makeApprovedListing({ status: 'cancelled' });
    const past = await makeApprovedListing({
      scheduled_start: new Date(Date.now() - 3600 * 1000),
    });
    const cookie = await cookieFor(await makeGuest());
    const r1 = await request(app)
      .post('/api/bookings')
      .set('Cookie', cookie)
      .send({ listingId: cancelled.id });
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('LISTING_NOT_BOOKABLE');
    const r2 = await request(app)
      .post('/api/bookings')
      .set('Cookie', cookie)
      .send({ listingId: past.id });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('LISTING_STARTED');
  });

  test('unauthenticated → 401; malformed body → 422 (NFR-11)', async () => {
    const listing = await makeApprovedListing();
    const anon = await request(app).post('/api/bookings').send({ listingId: listing.id });
    expect(anon.status).toBe(401);
    const bad = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(await makeGuest()))
      .send({ listingId: 'not-a-uuid' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('successful create enqueues notify.booking (guest + host) AND the scheduled promote job', async () => {
    const listing = await makeApprovedListing();
    const guest = await makeGuest();
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId: listing.id });
    expect(res.status).toBe(201);
    expect(res.headers['x-correlation-id']).toBeTruthy(); // NFR-08 (MT-01)
    const bookingId = res.body.booking.id;

    const notifyJobs = await outboxJobsFor(bookingId, 'notify.booking');
    expect(notifyJobs).toHaveLength(2);
    const recipients = notifyJobs.map((j) => j.payload.recipientUserId).sort();
    expect(recipients).toEqual([guest.id, listing.host_id].sort());
    for (const job of notifyJobs) {
      expect(job.payload.event).toBe('created');
      // NFR-08: the originating request's correlation ID is stamped onto the job.
      expect(job.correlation_id).toBe(res.headers['x-correlation-id']);
    }

    const promoteJobs = await outboxJobsFor(bookingId, 'booking.promote');
    expect(promoteJobs).toHaveLength(1);
    // availableAt = the listing's scheduled_start (per-booking scheduled job, §6.4).
    expect(
      Math.abs(
        new Date(promoteJobs[0].available_at).getTime() -
          new Date(listing.scheduled_start).getTime()
      )
    ).toBeLessThan(1000);
  });
});

// ----------------------------------------------------------------------------------------------
// TC-14 — cancellation (FR-14, FR-13)
// ----------------------------------------------------------------------------------------------
describe('TC-14 / FR-14 — POST /api/bookings/:id/cancel', () => {
  async function bookedFixture() {
    const listing = await makeApprovedListing({ seat_capacity: 3, seats_remaining: 3 });
    const guest = await makeGuest();
    const guestCookie = await cookieFor(guest);
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .send({ listingId: listing.id });
    expect(res.status).toBe(201);
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [listing.host_id]);
    return { listing, guest, guestCookie, host: rows[0], bookingId: res.body.booking.id };
  }

  test('guest cancels before start: cancelled + cancelled_at, seat restored, notify rows — one transaction', async () => {
    const { listing, guest, guestCookie, host, bookingId } = await bookedFixture();
    expect(await seatsRemaining(listing.id)).toBe(2);

    const res = await request(app)
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Cookie', guestCookie);
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('cancelled');
    expect(res.body.booking.cancelledAt).toBeTruthy();
    expect(await seatsRemaining(listing.id)).toBe(3);

    const jobs = await outboxJobsFor(bookingId, 'notify.booking');
    const cancelJobs = jobs.filter((j) => j.payload.event === 'cancelled_by_guest');
    expect(cancelJobs).toHaveLength(2);
    expect(cancelJobs.map((j) => j.payload.recipientUserId).sort()).toEqual(
      [guest.id, host.id].sort()
    );
  });

  test('host can cancel too (event cancelled_by_host)', async () => {
    const { listing, host, bookingId } = await bookedFixture();
    const res = await request(app)
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Cookie', await cookieFor(host));
    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('cancelled');
    expect(await seatsRemaining(listing.id)).toBe(3);
    const jobs = await outboxJobsFor(bookingId, 'notify.booking');
    expect(jobs.filter((j) => j.payload.event === 'cancelled_by_host')).toHaveLength(2);
  });

  test('repeat cancel is idempotent: no double restore, no duplicate notifications', async () => {
    const { listing, guestCookie, bookingId } = await bookedFixture();
    const first = await request(app)
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Cookie', guestCookie);
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Cookie', guestCookie);
    expect(second.status).toBe(200);
    expect(second.body.booking.status).toBe('cancelled');
    expect(await seatsRemaining(listing.id)).toBe(3); // restored exactly once
    const jobs = await outboxJobsFor(bookingId, 'notify.booking');
    expect(jobs.filter((j) => j.payload.event.startsWith('cancelled'))).toHaveLength(2);
  });

  test('concurrent cancels (guest + host) restore exactly one seat', async () => {
    const { listing, guestCookie, host, bookingId } = await bookedFixture();
    const hostCookie = await cookieFor(host);
    const [a, b] = await Promise.all([
      request(app).post(`/api/bookings/${bookingId}/cancel`).set('Cookie', guestCookie),
      request(app).post(`/api/bookings/${bookingId}/cancel`).set('Cookie', hostCookie),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await seatsRemaining(listing.id)).toBe(3); // seats_remaining ≤ seat_capacity always
    const jobs = await outboxJobsFor(bookingId, 'notify.booking');
    expect(jobs.filter((j) => j.payload.event.startsWith('cancelled'))).toHaveLength(2);
  });

  test('cancel at/after scheduled start → 409, seat NOT restored', async () => {
    const { listing, guestCookie, bookingId } = await bookedFixture();
    await query(`UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`, [
      listing.id,
    ]);
    const res = await request(app)
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Cookie', guestCookie);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANCEL_TOO_LATE');
    expect(await seatsRemaining(listing.id)).toBe(2);
    expect((await bookingRow(bookingId)).status).toBe('pending');
  });

  test('non-participant → 403; unknown booking → 404', async () => {
    const { bookingId } = await bookedFixture();
    const stranger = await makeGuest();
    const res = await request(app)
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Cookie', await cookieFor(stranger));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_PARTICIPANT');
    const missing = await request(app)
      .post(`/api/bookings/00000000-0000-4000-8000-000000000000/cancel`)
      .set('Cookie', await cookieFor(stranger));
    expect(missing.status).toBe(404);
  });
});

// ----------------------------------------------------------------------------------------------
// TC-04 — completion (FR-04)
// ----------------------------------------------------------------------------------------------
describe('TC-04 / FR-04 — POST /api/bookings/:id/confirm-completion', () => {
  async function inProgressFixture() {
    const guest = await makeGuest();
    const listing = await makeApprovedListing({ seats_remaining: 3 });
    const booking = await makeBooking({
      listing_id: listing.id,
      guest_id: guest.id,
      status: 'in_progress',
    });
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [listing.host_id]);
    return { guest, host: rows[0], listing, booking };
  }

  test('single confirmation stays in_progress and reports awaiting the other party', async () => {
    const { guest, booking } = await inProgressFixture();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/confirm-completion`)
      .set('Cookie', await cookieFor(guest));
    expect(res.status).toBe(200);
    expect(res.body.awaitingOtherParty).toBe(true);
    expect(res.body.booking.status).toBe('in_progress');
    expect(res.body.booking.guestConfirmedCompletion).toBe(true);
    expect(res.body.booking.hostConfirmedCompletion).toBe(false);
    expect(res.body.booking.completedAt).toBeNull();
  });

  test('both confirmations → completed + completed_at set + both parties notified', async () => {
    const { guest, host, booking } = await inProgressFixture();
    await request(app)
      .post(`/api/bookings/${booking.id}/confirm-completion`)
      .set('Cookie', await cookieFor(guest));
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/confirm-completion`)
      .set('Cookie', await cookieFor(host));
    expect(res.status).toBe(200);
    expect(res.body.awaitingOtherParty).toBe(false);
    expect(res.body.booking.status).toBe('completed');
    expect(res.body.booking.completedAt).toBeTruthy();

    const row = await bookingRow(booking.id);
    expect(row.status).toBe('completed');
    expect(row.completed_at).toBeInstanceOf(Date);
    expect(row.guest_confirmed_completion).toBe(true);
    expect(row.host_confirmed_completion).toBe(true);

    const jobs = await outboxJobsFor(booking.id, 'notify.booking');
    const completedJobs = jobs.filter((j) => j.payload.event === 'completed');
    expect(completedJobs).toHaveLength(2);
    expect(completedJobs.map((j) => j.payload.recipientUserId).sort()).toEqual(
      [guest.id, host.id].sort()
    );
  });

  test('repeat confirmation is a 200 no-op (same party pre-completion AND post-completion)', async () => {
    const { guest, host, booking } = await inProgressFixture();
    const guestCookie = await cookieFor(guest);
    await request(app)
      .post(`/api/bookings/${booking.id}/confirm-completion`)
      .set('Cookie', guestCookie);
    const repeatAwaiting = await request(app)
      .post(`/api/bookings/${booking.id}/confirm-completion`)
      .set('Cookie', guestCookie);
    expect(repeatAwaiting.status).toBe(200);
    expect(repeatAwaiting.body.awaitingOtherParty).toBe(true);

    await request(app)
      .post(`/api/bookings/${booking.id}/confirm-completion`)
      .set('Cookie', await cookieFor(host));
    const before = await bookingRow(booking.id);
    const repeatDone = await request(app)
      .post(`/api/bookings/${booking.id}/confirm-completion`)
      .set('Cookie', guestCookie);
    expect(repeatDone.status).toBe(200);
    expect(repeatDone.body.booking.status).toBe('completed');
    const after = await bookingRow(booking.id);
    expect(after.completed_at.getTime()).toBe(before.completed_at.getTime()); // untouched
    // No duplicate 'completed' notifications from the no-op.
    const jobs = await outboxJobsFor(booking.id, 'notify.booking');
    expect(jobs.filter((j) => j.payload.event === 'completed')).toHaveLength(2);
  });

  test('pending booking → 409; cancelled booking → 409', async () => {
    const guest = await makeGuest();
    const pending = await makeBooking({ guest_id: guest.id });
    const cookie = await cookieFor(guest);
    const r1 = await request(app)
      .post(`/api/bookings/${pending.id}/confirm-completion`)
      .set('Cookie', cookie);
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('BOOKING_NOT_IN_PROGRESS');

    const cancelled = await makeBooking({ guest_id: guest.id, status: 'cancelled' });
    const r2 = await request(app)
      .post(`/api/bookings/${cancelled.id}/confirm-completion`)
      .set('Cookie', cookie);
    expect(r2.status).toBe(409);
  });

  test('third party → 403', async () => {
    const { booking } = await inProgressFixture();
    const stranger = await makeGuest();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/confirm-completion`)
      .set('Cookie', await cookieFor(stranger));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_PARTICIPANT');
  });
});

// ----------------------------------------------------------------------------------------------
// FR-13 — transactional notifications, worker delivery, RT-02
// ----------------------------------------------------------------------------------------------
describe('FR-13 / TC-13 — transactional outbox notifications', () => {
  test('forcing a post-insert error commits NEITHER the booking NOR any outbox row (no dual writes)', async () => {
    const listing = await makeApprovedListing({ seat_capacity: 2, seats_remaining: 2 });
    const guest = await makeGuest();
    jest.spyOn(outbox, 'enqueue').mockImplementation(async () => {
      throw new Error('injected post-insert failure (FR-13 atomicity probe)');
    });
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId: listing.id });
    expect(res.status).toBe(500);
    jest.restoreAllMocks();

    expect(await seatsRemaining(listing.id)).toBe(2); // decrement rolled back
    const { rows } = await query(`SELECT count(*)::int AS n FROM bookings WHERE listing_id = $1`, [
      listing.id,
    ]);
    expect(rows[0].n).toBe(0);
    const { rows: jobs } = await query(
      `SELECT count(*)::int AS n FROM outbox_jobs WHERE payload->>'bookingId' IN
         (SELECT id::text FROM bookings WHERE listing_id = $1)`,
      [listing.id]
    );
    expect(jobs[0].n).toBe(0);
  });

  test('outbox payloads carry IDs only (ADR-003 — assertIdOnlyPayload holds for every stored row)', async () => {
    const listing = await makeApprovedListing();
    const guest = await makeGuest();
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId: listing.id });
    expect(res.status).toBe(201);
    const jobs = [
      ...(await outboxJobsFor(res.body.booking.id, 'notify.booking')),
      ...(await outboxJobsFor(res.body.booking.id, 'booking.promote')),
    ];
    expect(jobs.length).toBe(3);
    for (const job of jobs) {
      expect(() => outbox.assertIdOnlyPayload(job.payload)).not.toThrow();
      expect(JSON.stringify(job.payload)).not.toMatch(/@/);
      expect(
        Object.keys(job.payload).every((k) => ['bookingId', 'event', 'recipientUserId'].includes(k))
      ).toBe(true);
    }
  });

  test('with the transport forced to fail, POST /api/bookings still returns 201 in < 500 ms', async () => {
    mockTransport.injectFailures(50);
    const listing = await makeApprovedListing();
    const guest = await makeGuest();
    const startedAt = Date.now();
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId: listing.id });
    const elapsedMs = Date.now() - startedAt;
    expect(res.status).toBe(201);
    expect(elapsedMs).toBeLessThan(500);
    // The booking is committed even though every delivery attempt would fail (ADR-001/003).
    expect(await bookingRow(res.body.booking.id)).not.toBeNull();
  });

  test('worker delivers notify.booking end to end: one NOTIFICATION_ATTEMPT row per recipient (sent)', async () => {
    await query(`DELETE FROM outbox_jobs WHERE status = 'pending'`); // isolate this poll
    const listing = await makeApprovedListing();
    const guest = await makeGuest();
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId: listing.id });
    expect(res.status).toBe(201);
    const bookingId = res.body.booking.id;

    const stats = await pollOnce({ registry: bookingRegistry(), batchSize: 50, log: silent });
    expect(stats.delivered).toBe(2); // both notify jobs; promote is not due yet

    const { rows: attempts } = await query(
      `SELECT * FROM notification_attempts WHERE params->>'bookingId' = $1 ORDER BY created_at`,
      [bookingId]
    );
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(attempt.status).toBe('sent');
      expect(attempt.channel).toBe('email');
      expect(attempt.template).toBe('booking.created');
      expect(Object.keys(attempt.params).sort()).toEqual(['bookingId', 'event']);
    }
    expect(attempts.map((a) => a.recipient_user_id).sort()).toEqual(
      [guest.id, listing.host_id].sort()
    );
    // The mock transport actually "delivered" exactly twice (ADR-011 — asserted via rows + mock).
    expect(mockTransport.deliveries().filter((d) => d.params.bookingId === bookingId)).toHaveLength(
      2
    );
  });

  test('provider outage: NOTIFICATION_ATTEMPT recorded per try, job dead-letters at the attempt cap', async () => {
    await query(`DELETE FROM outbox_jobs WHERE status = 'pending'`);
    const listing = await makeApprovedListing();
    const guest = await makeGuest();
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId: listing.id });
    const bookingId = res.body.booking.id;
    mockTransport.injectFailures(100); // outage across every retry

    const opts = {
      registry: bookingRegistry(),
      batchSize: 50,
      maxAttempts: 2,
      backoffBaseMs: 1,
      backoffMaxMs: 2,
      log: silent,
    };
    const first = await pollOnce(opts);
    expect(first.retried).toBe(2);
    await new Promise((r) => setTimeout(r, 25)); // let the 1–2 ms backoff elapse
    const second = await pollOnce(opts);
    expect(second.deadLettered).toBe(2);

    const jobs = await outboxJobsFor(bookingId, 'notify.booking');
    for (const job of jobs) {
      expect(job.status).toBe('dead');
      expect(job.last_error).toBeTruthy();
    }
    const { rows: attempts } = await query(
      `SELECT * FROM notification_attempts WHERE params->>'bookingId' = $1`,
      [bookingId]
    );
    expect(attempts).toHaveLength(2); // one row per recipient, reused across tries (RT-02)
    for (const attempt of attempts) {
      expect(attempt.status).toBe('failed');
      expect(attempt.attempt_count).toBeGreaterThanOrEqual(2); // per-try audit trail
    }
  });

  test('RT-02: redelivery after a failure is exactly-once per recipient (idempotency key reuse)', async () => {
    await query(`DELETE FROM outbox_jobs WHERE status = 'pending'`);
    const listing = await makeApprovedListing();
    const guest = await makeGuest();
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId: listing.id });
    const bookingId = res.body.booking.id;

    // Exactly one send's worth of failures (transport tries 1 + retryMax per send).
    mockTransport.injectFailures(1 + config.adapters.retryMax);
    const opts = {
      registry: bookingRegistry(),
      batchSize: 50,
      backoffBaseMs: 1,
      backoffMaxMs: 2,
      log: silent,
    };
    const first = await pollOnce(opts);
    expect(first.retried).toBe(1);
    expect(first.delivered).toBe(1);
    await new Promise((r) => setTimeout(r, 25));
    const second = await pollOnce(opts);
    expect(second.delivered).toBe(1);

    const { rows: attempts } = await query(
      `SELECT * FROM notification_attempts WHERE params->>'bookingId' = $1`,
      [bookingId]
    );
    expect(attempts).toHaveLength(2); // ONE row per recipient — never a duplicate send
    for (const attempt of attempts) expect(attempt.status).toBe('sent');
    expect(mockTransport.deliveries().filter((d) => d.params.bookingId === bookingId)).toHaveLength(
      2
    ); // each recipient delivered exactly once
  });

  test('handler rejects malformed payloads (caller bug → retries then dead-letter)', async () => {
    await expect(notifyHandler.handle({ bookingId: 'nope' })).rejects.toThrow(TypeError);
    await expect(
      notifyHandler.handle({
        bookingId: '00000000-0000-4000-8000-000000000000',
        event: 'not-an-event',
        recipientUserId: '00000000-0000-4000-8000-000000000000',
      })
    ).rejects.toThrow(TypeError);
  });
});

// ----------------------------------------------------------------------------------------------
// booking.promote — scheduled pending → in_progress (build-plan §6.4)
// ----------------------------------------------------------------------------------------------
describe('booking.promote — pending → in_progress at scheduled_start', () => {
  test('due job promotes a pending booking to in_progress', async () => {
    const listing = await makeApprovedListing({
      scheduled_start: new Date(Date.now() - 3600 * 1000),
    });
    const booking = await makeBooking({ listing_id: listing.id, guest_id: (await makeGuest()).id });
    const result = await promoteHandler.handle({ bookingId: booking.id }, { log: silent });
    expect(result.outcome).toBe('promoted');
    expect((await bookingRow(booking.id)).status).toBe('in_progress');
  });

  test('redelivered promote job is an idempotent no-op (RT-02)', async () => {
    const listing = await makeApprovedListing({
      scheduled_start: new Date(Date.now() - 3600 * 1000),
    });
    const booking = await makeBooking({ listing_id: listing.id, guest_id: (await makeGuest()).id });
    await promoteHandler.handle({ bookingId: booking.id }, { log: silent });
    const again = await promoteHandler.handle({ bookingId: booking.id }, { log: silent });
    expect(again.outcome).toBe('noop');
    expect((await bookingRow(booking.id)).status).toBe('in_progress');
  });

  test('already-cancelled booking → no-op (stays cancelled)', async () => {
    const booking = await makeBooking({ status: 'cancelled' });
    const result = await promoteHandler.handle({ bookingId: booking.id }, { log: silent });
    expect(result.outcome).toBe('noop');
    expect((await bookingRow(booking.id)).status).toBe('cancelled');
  });

  test('cancelled LISTING with a stray pending booking → no-op (never promote into a cancelled meal)', async () => {
    const listing = await makeApprovedListing({
      status: 'cancelled',
      scheduled_start: new Date(Date.now() - 3600 * 1000),
    });
    const booking = await makeBooking({ listing_id: listing.id });
    const result = await promoteHandler.handle({ bookingId: booking.id }, { log: silent });
    expect(result.outcome).toBe('noop');
    expect((await bookingRow(booking.id)).status).toBe('pending');
  });

  test('listing start moved later → re-enqueues a fresh job for the new instant, booking stays pending', async () => {
    const listing = await makeApprovedListing(); // future start
    const booking = await makeBooking({ listing_id: listing.id });
    const result = await promoteHandler.handle({ bookingId: booking.id }, { log: silent });
    expect(result.outcome).toBe('rescheduled');
    expect((await bookingRow(booking.id)).status).toBe('pending');

    const jobs = await outboxJobsFor(booking.id, 'booking.promote');
    const pendingJobs = jobs.filter((j) => j.status === 'pending');
    expect(pendingJobs).toHaveLength(1);
    expect(
      Math.abs(
        new Date(pendingJobs[0].available_at).getTime() -
          new Date(listing.scheduled_start).getTime()
      )
    ).toBeLessThan(1000);
    expect(pendingJobs[0].dedupe_key).toBe(
      `booking.promote:${booking.id}:${new Date(listing.scheduled_start).getTime()}`
    );
  });

  test('end to end through the worker: due promote job flips the booking', async () => {
    await query(`DELETE FROM outbox_jobs WHERE status = 'pending'`);
    const listing = await makeApprovedListing();
    const guest = await makeGuest();
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId: listing.id });
    const bookingId = res.body.booking.id;
    // The meal's start arrives: make the scheduled job due and the listing started.
    await query(`UPDATE listings SET scheduled_start = now() WHERE id = $1`, [listing.id]);
    await query(
      `UPDATE outbox_jobs SET available_at = now() WHERE type = 'booking.promote' AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    const stats = await pollOnce({ registry: bookingRegistry(), batchSize: 50, log: silent });
    expect(stats.deadLettered).toBe(0);
    expect((await bookingRow(bookingId)).status).toBe('in_progress');
  });

  test('malformed payload throws (dead-letters as a caller bug)', async () => {
    await expect(promoteHandler.handle({ bookingId: 'nope' })).rejects.toThrow(TypeError);
    await expect(promoteHandler.handle(null)).rejects.toThrow(TypeError);
  });
});

// ----------------------------------------------------------------------------------------------
// Reads — participant-only detail, own list, ADR-010 allowlist, wave-4 contract
// ----------------------------------------------------------------------------------------------
describe('GET /api/bookings — participant reads (AB-08, ADR-010)', () => {
  test('detail: guest and host both see it (with role); stranger 403; unknown 404; anon 401', async () => {
    const guest = await makeGuest();
    const listing = await makeApprovedListing();
    const booking = await makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [listing.host_id]);
    const host = rows[0];

    const asGuest = await request(app)
      .get(`/api/bookings/${booking.id}`)
      .set('Cookie', await cookieFor(guest));
    expect(asGuest.status).toBe(200);
    expect(asGuest.body.booking.role).toBe('guest');

    const asHost = await request(app)
      .get(`/api/bookings/${booking.id}`)
      .set('Cookie', await cookieFor(host));
    expect(asHost.status).toBe(200);
    expect(asHost.body.booking.role).toBe('host');

    const stranger = await request(app)
      .get(`/api/bookings/${booking.id}`)
      .set('Cookie', await cookieFor(await makeGuest()));
    expect(stranger.status).toBe(403);

    const missing = await request(app)
      .get('/api/bookings/00000000-0000-4000-8000-000000000000')
      .set('Cookie', await cookieFor(guest));
    expect(missing.status).toBe(404);

    const anon = await request(app).get(`/api/bookings/${booking.id}`);
    expect(anon.status).toBe(401);
  });

  test('ADR-010: the embedded listing carries PUBLIC fields only — never street address or precise coordinates', async () => {
    const guest = await makeGuest();
    const listing = await makeApprovedListing({
      address_line1: '123 Secret Kitchen Lane',
      address_line2: 'Unit 7',
      postal_code: '92101',
      lat: 32.715736,
      lng: -117.161087,
    });
    const booking = await makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const res = await request(app)
      .get(`/api/bookings/${booking.id}`)
      .set('Cookie', await cookieFor(guest));
    expect(res.status).toBe(200);

    const allowedListingKeys = [
      'id',
      'hostId',
      'title',
      'cuisine',
      'scheduledStart',
      'durationMinutes',
      'city',
      'areaLabel',
      'coarseLat',
      'coarseLng',
      'status',
    ].sort();
    expect(Object.keys(res.body.booking.listing).sort()).toEqual(allowedListingKeys);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/Secret Kitchen/);
    expect(raw).not.toMatch(/32\.715736|-117\.161087/); // precise coords never serialized
    expect(raw).not.toMatch(/@/); // no email anywhere in a booking payload (AB-08)
  });

  test('serializer allowlist is closed even against an over-selected row (defence in depth)', () => {
    const bookingRowShape = {
      id: 'b',
      listing_id: 'l',
      guest_id: 'g',
      status: 'pending',
      guest_confirmed_completion: false,
      host_confirmed_completion: false,
      cancelled_at: null,
      completed_at: null,
      created_at: 'x',
      updated_at: 'x',
      secret_extra: 'must not leak',
    };
    const listingRowShape = {
      id: 'l',
      host_id: 'h',
      title: 't',
      cuisine: null,
      scheduled_start: 'x',
      duration_minutes: 60,
      city: 'SD',
      area_label: 'SD',
      coarse_lat: 1,
      coarse_lng: 2,
      status: 'active',
      address_line1: 'leak',
      lat: 3,
      lng: 4,
      moderation_status: 'approved',
    };
    const out = bookingsService.serializeBooking(bookingRowShape, listingRowShape, 'guest');
    expect(out).not.toHaveProperty('secret_extra');
    expect(out.listing).not.toHaveProperty('address_line1');
    expect(out.listing).not.toHaveProperty('lat');
    expect(out.listing).not.toHaveProperty('lng');
    expect(out.listing).not.toHaveProperty('moderation_status');
  });

  test('list: role filter separates "my seats" from "my listings" (paginated)', async () => {
    const guest = await makeGuest();
    const listing = await makeApprovedListing();
    await makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [listing.host_id]);
    const host = rows[0];
    const guestCookie = await cookieFor(guest);
    const hostCookie = await cookieFor(host);

    const asGuest = await request(app).get('/api/bookings?role=guest').set('Cookie', guestCookie);
    expect(asGuest.status).toBe(200);
    expect(asGuest.body.bookings).toHaveLength(1);
    expect(asGuest.body.bookings[0].role).toBe('guest');
    expect(asGuest.body).toMatchObject({ page: 1, pageSize: 20 });

    const asHost = await request(app).get('/api/bookings?role=host').set('Cookie', hostCookie);
    expect(asHost.body.bookings).toHaveLength(1);
    expect(asHost.body.bookings[0].role).toBe('host');

    const guestAsHost = await request(app)
      .get('/api/bookings?role=host')
      .set('Cookie', guestCookie);
    expect(guestAsHost.body.bookings).toHaveLength(0);

    const filtered = await request(app)
      .get('/api/bookings?status=cancelled')
      .set('Cookie', guestCookie);
    expect(filtered.body.bookings).toHaveLength(0);
  });

  test('wave-4 contract: repo.findParticipantBooking resolves {booking, listing, role}', async () => {
    const guest = await makeGuest();
    const listing = await makeApprovedListing();
    const booking = await makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const stranger = await makeGuest();

    const asGuest = await bookingsRepo.findParticipantBooking(booking.id, guest.id);
    expect(asGuest.role).toBe('guest');
    expect(asGuest.booking.id).toBe(booking.id);
    expect(asGuest.listing.id).toBe(listing.id);

    const asHost = await bookingsRepo.findParticipantBooking(booking.id, listing.host_id);
    expect(asHost.role).toBe('host');

    const asStranger = await bookingsRepo.findParticipantBooking(booking.id, stranger.id);
    expect(asStranger.role).toBeNull();

    const missing = await bookingsRepo.findParticipantBooking(
      '00000000-0000-4000-8000-000000000000',
      guest.id
    );
    expect(missing).toBeNull();

    // The internal listing subset never selects the privileged columns at all (ADR-010).
    expect(asGuest.listing).not.toHaveProperty('address_line1');
    expect(asGuest.listing).not.toHaveProperty('lat');
    expect(asGuest.listing).not.toHaveProperty('lng');
  });
});

// ----------------------------------------------------------------------------------------------
// NFR-08 / MT-01 — audit records on every mutation
// ----------------------------------------------------------------------------------------------
describe('NFR-08 / MT-01 — audit records', () => {
  function fakeLog() {
    const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    log.child = () => log;
    return log;
  }

  function auditRecords(log) {
    return log.info.mock.calls.map(([obj]) => obj).filter((o) => o && o.audit === true);
  }

  test('create success and AB-02 refusal both write audit records (actor + entity IDs)', async () => {
    const guest = await makeGuest();
    const listing = await makeApprovedListing();
    const log = fakeLog();
    const booking = await bookingsService.createBooking(guest.id, listing.id, { log });
    expect(auditRecords(log)).toEqual([
      expect.objectContaining({
        event: 'booking.created',
        outcome: 'success',
        actorUserId: guest.id,
        entityType: 'booking',
        entityId: booking.id,
      }),
    ]);

    // Drive the guest to the cap, then audit the refusal.
    for (let i = 1; i < config.booking.maxConcurrentPending; i += 1) {
      await bookingsService.createBooking(guest.id, (await makeApprovedListing()).id, {
        log: silent,
      });
    }
    const refusalLog = fakeLog();
    await expect(
      bookingsService.createBooking(guest.id, (await makeApprovedListing()).id, { log: refusalLog })
    ).rejects.toMatchObject({ code: 'BOOKING_LIMIT' });
    expect(auditRecords(refusalLog)).toEqual([
      expect.objectContaining({
        event: 'booking.created',
        outcome: 'failure',
        actorUserId: guest.id,
        reason: 'BOOKING_LIMIT',
      }),
    ]);
  });

  test('cancel and completion write audit records too', async () => {
    const guest = await makeGuest();
    const listing = await makeApprovedListing();
    const log = fakeLog();
    const created = await bookingsService.createBooking(guest.id, listing.id, { log: silent });
    await bookingsService.cancelBooking(guest.id, created.id, { log });
    expect(auditRecords(log)).toEqual([
      expect.objectContaining({
        event: 'booking.cancelled',
        outcome: 'success',
        actorUserId: guest.id,
        entityId: created.id,
      }),
    ]);

    const inProgress = await makeBooking({
      listing_id: (await makeApprovedListing()).id,
      guest_id: guest.id,
      status: 'in_progress',
    });
    const confirmLog = fakeLog();
    await bookingsService.confirmCompletion(guest.id, inProgress.id, { log: confirmLog });
    expect(auditRecords(confirmLog)).toEqual([
      expect.objectContaining({
        event: 'booking.completion_confirmed',
        outcome: 'success',
        actorUserId: guest.id,
        entityId: inProgress.id,
      }),
    ]);
  });

  // Deliberate cover for the missing-booking branch. It used to be executed only by ACCIDENT:
  // a residue test deleted bookings in its cleanup, orphaning a scheduled promote job that an
  // unscoped drain later delivered. The 2026-08-21 hygiene sweep stopped drains claiming foreign
  // rows, so the branch is asserted here on purpose instead. It matters because the job outlives
  // the row: a booking cancelled and hard-deleted before its start must make the worker no-op,
  // not throw and burn the outbox retry budget.
  test('promoting a booking whose row no longer exists is a logged noop, not an error', async () => {
    const listing = await makeApprovedListing({
      scheduled_start: new Date(Date.now() - 3600 * 1000),
    });
    const booking = await makeBooking({ listing_id: listing.id });
    await query('DELETE FROM bookings WHERE id = $1', [booking.id]);

    const log = fakeLog();
    const outcome = await lifecycle.promoteDueBooking(booking.id, { log });

    expect(outcome).toBe('noop');
    expect(auditRecords(log)).toEqual([]); // a noop is not an audited business event
  });

  test('lifecycle promotion writes a booking.promoted audit record', async () => {
    const listing = await makeApprovedListing({
      scheduled_start: new Date(Date.now() - 3600 * 1000),
    });
    const booking = await makeBooking({ listing_id: listing.id });
    const log = fakeLog();
    const outcome = await lifecycle.promoteDueBooking(booking.id, { log });
    expect(outcome).toBe('promoted');
    expect(auditRecords(log)).toEqual([
      expect.objectContaining({
        event: 'booking.promoted',
        outcome: 'success',
        entityId: booking.id,
      }),
    ]);
  });
});
