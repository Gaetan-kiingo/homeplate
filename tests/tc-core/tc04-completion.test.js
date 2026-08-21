// tests/tc-core/tc04-completion.test.js — TC-04 / FR-04: dual-confirmation meal completion
// (SRS §3.1; acceptance per docs/_generated/requirements-inventory.json).
//
// Asserted here, by execution against the seeded test DB (SRS §4.1):
//   - POST /api/bookings/:id/confirm-completion sets the caller's flag;
//   - after exactly ONE confirmation the booking is still 'in_progress' and the response
//     reports awaiting the other party — a single confirmation NEVER completes (also proven
//     in the database, not just the response);
//   - after BOTH confirmations status='completed' and completed_at is set;
//   - guest and host confirming SIMULTANEOUSLY complete the booking exactly once (the
//     transition is observed by exactly one of the two concurrent responses);
//   - repeating a confirmation is an idempotent 200 no-op (before and after completion);
//   - a user who is neither the guest nor the listing's host gets 403;
//   - confirming a 'pending' or 'cancelled' booking returns 409.
'use strict';

const request = require('supertest');

const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const dbh = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const support = require('./support');

const sink = { write() {} };
let app;

let host;
let hostCookie;
let guest;
let guestCookie;
let listing;

function confirm(bookingId, cookie) {
  return support.post(app, `/api/bookings/${bookingId}/confirm-completion`, cookie);
}

async function bookingRow(id) {
  const { rows } = await dbh.query(
    `SELECT status, guest_confirmed_completion, host_confirmed_completion, completed_at
       FROM bookings WHERE id = $1`,
    [id]
  );
  return rows[0];
}

async function makeInProgressBooking() {
  return dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id, status: 'in_progress' });
}

beforeAll(async () => {
  app = createApp({ logger: createLogger({ level: 'silent', stream: sink }) });
  host = await dbh.makeUser({ can_publish_listing: true });
  guest = await dbh.makeUser();
  hostCookie = await support.cookieFor(host);
  guestCookie = await support.cookieFor(guest);
  listing = await support.makeApprovedListing({
    host_id: host.id,
    seat_capacity: 8,
    seats_remaining: 2,
  });
});

afterAll(async () => {
  await closeTestRedis();
  await dbh.closeDb();
});

describe('TC-04 / FR-04 — dual confirmation completes; single confirmation never does', () => {
  test('guest confirms → still in_progress + awaitingOtherParty; host confirms → completed with completed_at', async () => {
    const booking = await makeInProgressBooking();

    // ONE confirmation (guest): must NOT complete.
    const first = await confirm(booking.id, guestCookie);
    expect(first.status).toBe(200);
    expect(first.body.awaitingOtherParty).toBe(true);
    expect(first.body.booking.status).toBe('in_progress');
    expect(first.body.booking.guestConfirmedCompletion).toBe(true);
    expect(first.body.booking.hostConfirmedCompletion).toBe(false);

    let row = await bookingRow(booking.id);
    expect(row.status).toBe('in_progress'); // the DATABASE says not completed either
    expect(row.completed_at).toBeNull();

    // SECOND party (host): now completed, completed_at set.
    const second = await confirm(booking.id, hostCookie);
    expect(second.status).toBe(200);
    expect(second.body.awaitingOtherParty).toBe(false);
    expect(second.body.booking.status).toBe('completed');
    expect(second.body.booking.completedAt).toBeTruthy();

    row = await bookingRow(booking.id);
    expect(row.status).toBe('completed');
    expect(row.guest_confirmed_completion).toBe(true);
    expect(row.host_confirmed_completion).toBe(true);
    expect(row.completed_at).not.toBeNull();
  });

  test('host-first ordering behaves symmetrically', async () => {
    const booking = await makeInProgressBooking();

    const first = await confirm(booking.id, hostCookie);
    expect(first.status).toBe(200);
    expect(first.body.awaitingOtherParty).toBe(true);
    expect((await bookingRow(booking.id)).status).toBe('in_progress');

    const second = await confirm(booking.id, guestCookie);
    expect(second.status).toBe(200);
    expect(second.body.booking.status).toBe('completed');
  });

  test('guest and host confirming SIMULTANEOUSLY complete the booking exactly once', async () => {
    const booking = await makeInProgressBooking();

    const [a, b] = await Promise.all([
      confirm(booking.id, guestCookie),
      confirm(booking.id, hostCookie),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);

    const row = await bookingRow(booking.id);
    expect(row.status).toBe('completed');
    expect(row.guest_confirmed_completion).toBe(true);
    expect(row.host_confirmed_completion).toBe(true);
    expect(row.completed_at).not.toBeNull();

    // Exactly one of the two responses observed the transition (the other is the first flag).
    const completedResponses = [a, b].filter((r) => r.body.booking.status === 'completed');
    expect(completedResponses).toHaveLength(1);
  });

  test('repeating a confirmation is an idempotent 200 no-op (same party, still awaiting)', async () => {
    const booking = await makeInProgressBooking();

    await confirm(booking.id, guestCookie);
    const repeat = await confirm(booking.id, guestCookie);
    expect(repeat.status).toBe(200);
    expect(repeat.body.awaitingOtherParty).toBe(true);
    expect(repeat.body.booking.status).toBe('in_progress');

    const row = await bookingRow(booking.id);
    expect(row.status).toBe('in_progress');
    expect(row.host_confirmed_completion).toBe(false); // unchanged — no state mutation
  });

  test('confirming an already-completed booking is an idempotent 200 no-op', async () => {
    const booking = await makeInProgressBooking();
    await confirm(booking.id, guestCookie);
    await confirm(booking.id, hostCookie);

    const repeat = await confirm(booking.id, hostCookie);
    expect(repeat.status).toBe(200);
    expect(repeat.body.booking.status).toBe('completed');
    expect(repeat.body.awaitingOtherParty).toBe(false);
    expect((await bookingRow(booking.id)).status).toBe('completed');
  });
});

describe('TC-04 / FR-04 — refusals', () => {
  test('a third party (neither guest nor host) gets 403 and no flag is set', async () => {
    const booking = await makeInProgressBooking();
    const stranger = await dbh.makeUser();
    const res = await confirm(booking.id, await support.cookieFor(stranger));
    expect(res.status).toBe(403);

    const row = await bookingRow(booking.id);
    expect(row.guest_confirmed_completion).toBe(false);
    expect(row.host_confirmed_completion).toBe(false);
  });

  test('a guest holding a DIFFERENT booking on the same listing is not a participant of this one (403)', async () => {
    // Participation is per-BOOKING, not per-listing: sharing a listing must not grant a
    // guest the other party's completion switch.
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

    const res = await confirm(bookingA.id, await support.cookieFor(guestB));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_PARTICIPANT');

    const row = await bookingRow(bookingA.id);
    expect(row.guest_confirmed_completion).toBe(false);
    expect(row.host_confirmed_completion).toBe(false);
  });

  test('confirming a PENDING booking (meal not started) returns 409', async () => {
    const booking = await dbh.makeBooking({
      listing_id: listing.id,
      guest_id: guest.id,
      status: 'pending',
    });
    const res = await confirm(booking.id, guestCookie);
    expect(res.status).toBe(409);
    expect((await bookingRow(booking.id)).status).toBe('pending');
  });

  test('confirming a CANCELLED booking returns 409', async () => {
    const booking = await dbh.makeBooking({
      listing_id: listing.id,
      guest_id: guest.id,
      status: 'cancelled',
    });
    const res = await confirm(booking.id, guestCookie);
    expect(res.status).toBe(409);
    expect((await bookingRow(booking.id)).status).toBe('cancelled');
  });

  test('unauthenticated confirmation is refused with 401 (AB-08)', async () => {
    const booking = await makeInProgressBooking();
    const res = await request(app).post(`/api/bookings/${booking.id}/confirm-completion`).send({});
    expect(res.status).toBe(401);
  });

  test('an unknown booking id is a structured 404', async () => {
    const res = await confirm('00000000-0000-4000-8000-000000000000', guestCookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('BOOKING_NOT_FOUND');
  });
});
