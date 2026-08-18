// tests/tc-booking/tcb-w3-reverify.test.js — VERIFIER lane "tc-booking", INDEPENDENT wave-3
// re-verification pass (2026-08-14). The wave-3 build run's own re-verify phase never ran, so
// this file re-derives the lane's non-negotiable assertions from scratch instead of trusting
// the existing tc08..tc14 files, and adds the probes the accumulated-finding list names:
//
//   IT3-F1   booking.promote re-enqueue must NOT dedupe onto the row being delivered when
//            scheduled_start is unchanged (promotion silently lost).
//   TCB-01   FR-12 per-guest pending cap under genuine CONCURRENCY (not just sequentially).
//   FR-14    guest and host cancelling simultaneously must restore exactly one seat.
//   FR-13    the *status transition* (completion) notification, and an ID-only audit over
//            every persisted outbox payload of every type.
//   FR-11    exactly one server-side enforcement point; caps live only in src/config.
//   FR-09    one policy module; no re-implementation anywhere in src/.
//   FR-08    wave-4 gap asserted as absent, and the FR-08-safe failure direction proved:
//            an unhandled/dead-lettered moderation.scan leaves public content invisible.
//   ADRC-W3-01  listings.local_date must reach the wire as 'YYYY-MM-DD', never a
//            timezone-dependent instant.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../../src/app');
const {
  query,
  makeUser,
  makeHostProfile,
  makeListing,
  makeBooking,
  closeDb,
} = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const config = require('../../src/config');
const sessions = require('../../src/modules/auth/sessions');
const { pollOnce } = require('../../src/outbox/worker');
const { createRegistry, loadHandlers } = require('../../src/outbox/dispatch');
const promoteHandler = require('../../src/outbox/handlers/bookingPromote');
const notifyHandler = require('../../src/outbox/handlers/bookingNotifications');
const mockTransport = require('../../src/adapters/mockTransport');
const sendgrid = require('../../src/adapters/sendgrid');
const { EVENT_VALUES: LIFECYCLE_EVENT_VALUES } = require('../../src/modules/bookings/lifecycle');

const COOKIE = config.auth.sessionCookieName;
const SRC = path.join(__dirname, '..', '..', 'src');

let app;

beforeAll(() => {
  app = createApp();
});

afterAll(async () => {
  mockTransport.reset();
  await closeDb();
  await closeTestRedis();
});

// ---- fixtures --------------------------------------------------------------------------------

async function cookieFor(user) {
  const { token } = await sessions.createSession(user);
  return `${COOKIE}=${token}`;
}

/** FR-09-eligible guest (verified email + name + phone ciphertext). */
async function makeGuest(overrides = {}) {
  return makeUser({ phone_enc: 'enc:v1:tcb-reverify', ...overrides });
}

async function makeEligibleHost() {
  const host = await makeUser({ can_publish_listing: true, phone_enc: 'enc:v1:tcb-reverify' });
  await makeHostProfile({ user_id: host.id });
  return host;
}

async function makeApprovedListing(overrides = {}) {
  return makeListing({ moderation_status: 'approved', ...overrides });
}

function book(cookie, listingId) {
  return request(app).post('/api/bookings').set('Cookie', cookie).send({ listingId });
}

function cancel(cookie, bookingId) {
  return request(app).post(`/api/bookings/${bookingId}/cancel`).set('Cookie', cookie).send({});
}

async function seatsRemaining(listingId) {
  const { rows } = await query('SELECT seats_remaining FROM listings WHERE id = $1', [listingId]);
  return rows[0].seats_remaining;
}

/**
 * Run poll cycles that can only ever see `jobIds`: every OTHER pending row is parked an hour
 * out for the duration and restored afterwards, so this probe neither steals nor is polluted
 * by sibling suites' queue state (tests/helpers/env.js CONCURRENCY RULE, in-run variant).
 */
async function pollOnlyThese(jobIds, registry, cycles = 3) {
  const { rows: parked } = await query(
    `SELECT id, available_at FROM outbox_jobs
      WHERE status = 'pending' AND NOT (id = ANY($1::bigint[]))`,
    [jobIds]
  );
  await query(
    `UPDATE outbox_jobs SET available_at = now() + interval '1 hour'
      WHERE status = 'pending' AND NOT (id = ANY($1::bigint[]))`,
    [jobIds]
  );
  try {
    for (let i = 0; i < cycles; i += 1) {
      const stats = await pollOnce({ registry });
      if (stats.claimed === 0) break;
    }
  } finally {
    for (const row of parked) {
      await query('UPDATE outbox_jobs SET available_at = $2 WHERE id = $1', [
        row.id,
        row.available_at,
      ]);
    }
  }
}

/** Every .js file under src/ (recursive). */
function srcFiles(dir = SRC, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) srcFiles(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

// ==============================================================================================
// IT3-F1 — booking.promote re-enqueue must survive its own delivery
// ==============================================================================================

describe('IT3-F1 / FR-12+FR-04 — early booking.promote delivery must not lose the promotion', () => {
  test('scheduled_start UNCHANGED and still in the future: the delivered row is replaced by a LIVE pending promote row', async () => {
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
    // dedupe key and ON CONFLICT DO NOTHING collapses onto it.
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

  test('normal case: a promote job delivered AT/AFTER scheduled_start promotes once and redelivery is a no-op (RT-02)', async () => {
    const listing = await makeApprovedListing({ seat_capacity: 2, seats_remaining: 2 });
    const guest = await makeGuest();
    const res = await book(await cookieFor(guest), listing.id);
    expect(res.status).toBe(201);
    const bookingId = res.body.booking.id;

    const { rows: jobs } = await query(
      `SELECT id FROM outbox_jobs WHERE type = 'booking.promote' AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    await query(`UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`, [
      listing.id,
    ]);
    await query('UPDATE outbox_jobs SET available_at = now() WHERE id = $1', [jobs[0].id]);
    await pollOnlyThese([jobs[0].id], createRegistry([promoteHandler]));

    let { rows } = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    expect(rows[0].status).toBe('in_progress');

    await query(`UPDATE outbox_jobs SET status = 'pending', available_at = now() WHERE id = $1`, [
      jobs[0].id,
    ]);
    await pollOnlyThese([jobs[0].id], createRegistry([promoteHandler]));
    ({ rows } = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]));
    expect(rows[0].status).toBe('in_progress'); // idempotent
  });
});

// ==============================================================================================
// FR-12 — atomicity under concurrency (independent re-derivation)
// ==============================================================================================

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
  });

  test('AB-02 under CONCURRENCY: one guest firing maxConcurrentPending+5 simultaneous bookings gets exactly the cap', async () => {
    const limit = config.booking.maxConcurrentPending;
    const guest = await makeGuest();
    const cookie = await cookieFor(guest);
    const listings = await Promise.all(
      Array.from({ length: limit + 5 }, () =>
        makeApprovedListing({ seat_capacity: 5, seats_remaining: 5 })
      )
    );
    const responses = await Promise.all(listings.map((l) => book(cookie, l.id)));
    const ok = responses.filter((r) => r.status === 201);
    const capped = responses.filter((r) => r.status === 409);
    expect(ok).toHaveLength(limit);
    expect(capped).toHaveLength(5);
    for (const r of capped) expect(r.body.error.code).toBe('BOOKING_LIMIT');

    const { rows } = await query(
      `SELECT count(*)::int AS c FROM bookings WHERE guest_id = $1 AND status = 'pending'`,
      [guest.id]
    );
    expect(rows[0].c).toBe(limit);

    // Refused attempts consumed no capacity anywhere.
    for (const l of listings) {
      const seats = await seatsRemaining(l.id);
      expect(seats).toBeGreaterThanOrEqual(4);
    }
  });

  test('refusal path writes NOTHING: full listing, own listing, unapproved listing, ineligible guest', async () => {
    // (a) full listing
    const full = await makeApprovedListing({ seat_capacity: 2, seats_remaining: 0 });
    const guest = await makeGuest();
    const gCookie = await cookieFor(guest);
    expect((await book(gCookie, full.id)).status).toBe(409);
    expect(await seatsRemaining(full.id)).toBe(0);

    // (b) own listing
    const host = await makeGuest({ can_publish_listing: true });
    const own = await makeApprovedListing({
      host_id: host.id,
      seat_capacity: 2,
      seats_remaining: 2,
    });
    const ownRes = await book(await cookieFor(host), own.id);
    expect(ownRes.status).toBe(409);
    expect(ownRes.body.error.code).toBe('OWN_LISTING');
    expect(await seatsRemaining(own.id)).toBe(2);

    // (c) unapproved (FR-08: no moderation-state oracle → 404)
    const pending = await makeListing({ moderation_status: 'pending' });
    expect((await book(gCookie, pending.id)).status).toBe(404);
    expect(await seatsRemaining(pending.id)).toBe(4);

    // (d) ineligible guest (FR-09)
    const ineligible = await makeUser({ phone_enc: null });
    const bookable = await makeApprovedListing({ seat_capacity: 2, seats_remaining: 2 });
    const denied = await book(await cookieFor(ineligible), bookable.id);
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.reasons).toEqual(['PHONE_MISSING']);
    expect(await seatsRemaining(bookable.id)).toBe(2);

    const { rows } = await query(
      `SELECT count(*)::int AS c FROM bookings
        WHERE listing_id = ANY($1::uuid[])`,
      [[full.id, own.id, pending.id, bookable.id]]
    );
    expect(rows[0].c).toBe(0);
  });
});

// ==============================================================================================
// FR-14 — cancellation restores capacity atomically, exactly once
// ==============================================================================================

describe('FR-14 — cancel before start restores exactly one seat, under concurrency too', () => {
  test('guest AND host cancelling the same booking simultaneously restores exactly one seat', async () => {
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

    // Exactly one cancellation notification pair (no duplicate enqueues per event/recipient).
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
  });

  test('cancel at/after scheduled_start → 409 CANCEL_TOO_LATE, no restore; non-participant → 403', async () => {
    const started = await makeApprovedListing({
      scheduled_start: new Date(Date.now() - 3600 * 1000),
      seat_capacity: 4,
      seats_remaining: 3,
    });
    const guest = await makeGuest();
    const booking = await makeBooking({ listing_id: started.id, guest_id: guest.id });
    const late = await cancel(await cookieFor(guest), booking.id);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('CANCEL_TOO_LATE');
    expect(await seatsRemaining(started.id)).toBe(3);

    const future = await makeApprovedListing({ seat_capacity: 3, seats_remaining: 3 });
    const g2 = await makeGuest();
    const b2 = await book(await cookieFor(g2), future.id);
    const stranger = await makeGuest();
    const forbidden = await cancel(await cookieFor(stranger), b2.body.booking.id);
    expect(forbidden.status).toBe(403);
    expect(await seatsRemaining(future.id)).toBe(2);
  });
});

// ==============================================================================================
// FR-13 — every state change enqueues transactionally; adapter failure changes nothing
// ==============================================================================================

describe('FR-13 — status transitions notify, IDs only, adapter failure is invisible to the caller', () => {
  test('the COMPLETION status transition enqueues one notify.booking row per participant', async () => {
    const listing = await makeApprovedListing({ seat_capacity: 2, seats_remaining: 2 });
    const guest = await makeGuest();
    const guestCookie = await cookieFor(guest);
    const created = await book(guestCookie, listing.id);
    expect(created.status).toBe(201);
    const bookingId = created.body.booking.id;
    const { rows: hostRows } = await query('SELECT * FROM users WHERE id = $1', [listing.host_id]);
    const hostCookie = await cookieFor(hostRows[0]);

    // Drive to in_progress the way the lifecycle does (conditional UPDATE), then dual-confirm.
    await query(`UPDATE bookings SET status = 'in_progress' WHERE id = $1`, [bookingId]);
    const first = await request(app)
      .post(`/api/bookings/${bookingId}/confirm-completion`)
      .set('Cookie', guestCookie)
      .send({});
    expect(first.status).toBe(200);
    expect(first.body.awaitingOtherParty).toBe(true);

    const second = await request(app)
      .post(`/api/bookings/${bookingId}/confirm-completion`)
      .set('Cookie', hostCookie)
      .send({});
    expect(second.status).toBe(200);
    expect(second.body.booking.status).toBe('completed');

    const { rows: jobs } = await query(
      `SELECT payload FROM outbox_jobs
        WHERE type = 'notify.booking' AND payload->>'bookingId' = $1
          AND payload->>'event' = 'completed'`,
      [bookingId]
    );
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.payload.recipientUserId).sort()).toEqual(
      [guest.id, listing.host_id].sort()
    );
  });

  test('TCB-W3-03 fixed: the pending → in_progress transition enqueues one notify row per participant', async () => {
    // FR-13 says "created, cancelled, OR CHANGES STATUS". §3.4 gives the lifecycle
    // pending → in_progress → completed. This test used to PIN the gap (the automatic
    // promotion had no event and enqueued nothing); TCB-W3-03 closed it, so it now asserts
    // the requirement: promotion writes EVENTS.STARTED for the guest AND the host, in the
    // SAME transaction as the status change (ADR-001/003 — no dual write).
    const lifecycle = require('../../src/modules/bookings/lifecycle');
    expect(Object.values(lifecycle.EVENTS)).toContain('started');

    const listing = await makeApprovedListing({ seat_capacity: 2, seats_remaining: 2 });
    const guest = await makeGuest();
    const res = await book(await cookieFor(guest), listing.id);
    expect(res.status).toBe(201);
    const bookingId = res.body.booking.id;

    const { rows: jobs } = await query(
      `SELECT id FROM outbox_jobs WHERE type = 'booking.promote' AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    await query(`UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`, [
      listing.id,
    ]);
    await query('UPDATE outbox_jobs SET available_at = now() WHERE id = $1', [jobs[0].id]);
    // Exactly ONE cycle: the promotion's own 'started' rows are enqueued DURING it and are not
    // in the parked set, so a second cycle would claim them under this promote-only registry
    // and rewrite their xmin with a retry UPDATE — destroying the same-transaction evidence
    // asserted at the end of this test.
    await pollOnlyThese([jobs[0].id], createRegistry([promoteHandler]), 1);

    const { rows: promoted } = await query('SELECT status FROM bookings WHERE id = $1', [
      bookingId,
    ]);
    expect(promoted[0].status).toBe('in_progress');

    const { rows: notifications } = await query(
      `SELECT payload->>'event' AS event, payload->>'recipientUserId' AS recipient
         FROM outbox_jobs
        WHERE type = 'notify.booking' AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    const events = [...new Set(notifications.map((n) => n.event))].sort();
    expect(events).toEqual(['created', 'started']);
    // One row per AFFECTED USER — the guest and the listing's host, exactly once each.
    const startedRecipients = notifications
      .filter((n) => n.event === 'started')
      .map((n) => n.recipient)
      .sort();
    expect(startedRecipients).toEqual([guest.id, listing.host_id].sort());

    // ADR-001/003: the status change and its notification rows committed TOGETHER — the
    // promoted booking row and both 'started' outbox rows carry the same transaction id.
    const { rows: sameTx } = await query(
      `SELECT (SELECT b.xmin::text FROM bookings b WHERE b.id = $1::uuid) AS booking_xmin,
              array_agg(DISTINCT j.xmin::text) AS job_xmins
         FROM outbox_jobs j
        WHERE j.type = 'notify.booking'
          AND j.payload->>'bookingId' = $1::text
          AND j.payload->>'event' = 'started'`,
      [bookingId]
    );
    expect(sameTx[0].job_xmins).toEqual([sameTx[0].booking_xmin]);
  });

  test('capacity shrink then cancel does not violate the 0001 seats CHECK (atomic restore stays in range)', async () => {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send({
        title: 'Shrink probe meal',
        description: 'A verifier-lane probe for the capacity-shrink / cancel-restore interaction.',
        ingredients: ['rice'],
        allergens: ['none'],
        cuisine: 'test',
        scheduledStart: new Date(Date.UTC(2030, 8, 11, 20, 0, 0)).toISOString(),
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

    const g1 = await makeGuest();
    const g2 = await makeGuest();
    const b1 = await book(await cookieFor(g1), listingId);
    const b2Cookie = await cookieFor(g2);
    const b2 = await book(b2Cookie, listingId);
    expect(b1.status).toBe(201);
    expect(b2.status).toBe(201);
    expect(await seatsRemaining(listingId)).toBe(2);

    // Shrink to exactly the booked count → seats_remaining 0.
    const shrink = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', hostCookie)
      .send({ seatCapacity: 2 });
    expect(shrink.status).toBe(200);
    expect(await seatsRemaining(listingId)).toBe(0);

    // Shrinking BELOW the booked count is refused (would make the restore impossible).
    const tooFar = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', hostCookie)
      .send({ seatCapacity: 1 });
    expect(tooFar.status).toBe(409);
    expect(tooFar.body.error.code).toBe('SEAT_CAPACITY_BELOW_BOOKED');

    // Cancel one → restores to 1, still ≤ seat_capacity (no 23514).
    const cancelled = await cancel(b2Cookie, b2.body.booking.id);
    expect(cancelled.status).toBe(200);
    expect(await seatsRemaining(listingId)).toBe(1);
  });

  test('ADR-003: EVERY persisted outbox payload of EVERY type carries IDs only', async () => {
    // Guarantee at least one row of each wave-3 type exists regardless of suite order, so the
    // audit below can never pass vacuously on an empty queue.
    const listing = await makeApprovedListing({ seat_capacity: 2, seats_remaining: 2 });
    const seedRes = await book(await cookieFor(await makeGuest()), listing.id);
    expect(seedRes.status).toBe(201);

    const { rows } = await query('SELECT type, payload FROM outbox_jobs');
    expect(rows.length).toBeGreaterThan(0);
    expect([...new Set(rows.map((r) => r.type))].sort()).toEqual(
      expect.arrayContaining(['booking.promote', 'notify.booking'])
    );
    const emailShape = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
    const piiKey = /(name|email|phone|address|password)/i;
    const sha256Hex = /^[0-9a-f]{64}$/i;
    const offenders = [];
    for (const row of rows) {
      const json = JSON.stringify(row.payload);
      if (emailShape.test(json)) offenders.push(`${row.type}: email shape in ${json}`);
      for (const [key, value] of Object.entries(row.payload || {})) {
        // fullName/emailAddress-style keys are the ADR-003 smell; *Id keys and opaque
        // SHA-256 digests are not personal data.
        if (typeof value === 'string' && sha256Hex.test(value)) continue;
        if (piiKey.test(key) && !/id$/i.test(key)) offenders.push(`${row.type}: key "${key}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('FR-10 BLOCKER: the only token the delivery pipeline carries is the DIGEST — it cannot verify an email', async () => {
    // src/modules/auth/service.js register() mints { raw, hash }; the outbox payload gets
    // ONLY tokenHash, and the route deliberately drops verification.rawToken. The worker
    // handler forwards params { userId, tokenHash } to the transport, and
    // src/adapters/sendgrid.js renderEmail() prints those params verbatim. So the strongest
    // token a real recipient can ever hold is the digest — and submitting it fails.
    const email = `tcb-fr10-${process.pid}-${Date.now()}@tcbooking.homeplate.invalid`;
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'Tcb-strong-pw!42', fullName: 'Probe Ten' });
    expect(registered.status).toBe(201);

    const { rows: userRows } = await query(
      'SELECT id, email_verified FROM users WHERE email = $1',
      [email]
    );
    expect(userRows[0].email_verified).toBe(false);

    const { rows: jobs } = await query(
      `SELECT payload FROM outbox_jobs
        WHERE type = 'email.verification' AND payload->>'userId' = $1`,
      [userRows[0].id]
    );
    expect(jobs).toHaveLength(1);
    // The payload has NO raw token — only the digest.
    expect(Object.keys(jobs[0].payload).sort()).toEqual(['tokenHash', 'userId']);
    const emailedToken = jobs[0].payload.tokenHash;

    // What a recipient of that email would submit:
    const attempt = await request(app).post('/api/auth/verify-email').send({ token: emailedToken });
    expect(attempt.status).toBe(400);
    const { rows: after } = await query('SELECT email_verified FROM users WHERE id = $1', [
      userRows[0].id,
    ]);
    expect(after[0].email_verified).toBe(false); // FR-10 loop cannot be closed by the email

    // TCB-W3-04 (FIXED — was: the handler's template id did not match any SendGrid subject
    // registry key, so even the subject line fell back to the neutral text). The id the
    // handler puts on the wire must now resolve to the real FR-10 subject.
    const handlerSrc = fs.readFileSync(
      path.join(SRC, 'outbox', 'handlers', 'emailVerification.js'),
      'utf8'
    );
    expect(handlerSrc).toMatch(/const TYPE = 'email\.verification'/);
    expect(sendgrid.hasSubject('email.verification')).toBe(true);
    expect(sendgrid.hasSubject('email-verification')).toBe(true);
    const verificationSubject = sendgrid.renderEmail(
      'email.verification',
      {},
      { verificationUrl: 'https://homeplate.test/verify-email?token=x' }
    ).subject;
    expect(verificationSubject).toBe('Verify your Homeplate email address');
    expect(verificationSubject).not.toMatch(/Homeplate notification \(/);
  });

  test('ADR-011: EVERY template id emitted by a handler has a real SendGrid subject (TCB-W3-04)', async () => {
    // Was the TCB-W3-04 defect: the handlers emit dotted ids ('email.verification',
    // `booking.${event}`) while sendgrid.js registered only hyphenated ones
    // ('email-verification', 'booking-created', …). The vocabularies were disjoint for the
    // FR-13/FR-14 booking family, so a guest's confirmation shipped titled "Homeplate
    // notification (booking.created)". Re-derived from the PERSISTED attempt rows: every
    // template id that actually reaches the transport must render a registered subject.
    const listing = await makeApprovedListing({ seat_capacity: 2, seats_remaining: 2 });
    const guest = await makeGuest();
    const res = await book(await cookieFor(guest), listing.id);
    expect(res.status).toBe(201);
    const { rows: jobIds } = await query(
      `SELECT id FROM outbox_jobs WHERE type = 'notify.booking' AND payload->>'bookingId' = $1`,
      [res.body.booking.id]
    );
    await pollOnlyThese(
      jobIds.map((j) => j.id),
      createRegistry([notifyHandler]),
      1
    );
    const { rows: attempts } = await query(
      `SELECT DISTINCT template FROM notification_attempts WHERE params->>'bookingId' = $1`,
      [res.body.booking.id]
    );
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.map((a) => a.template)).toContain('booking.created');

    for (const { template } of attempts) {
      expect(sendgrid.hasSubject(template)).toBe(true);
      expect(sendgrid.renderEmail(template, { bookingId: 'b-1' }).subject).not.toMatch(
        /^Homeplate notification \(/
      );
    }

    // …and the whole emitted vocabulary, not just the ids this one booking happened to
    // produce: every id the v1.0 flows can put on the wire resolves to a real subject.
    const emitted = [
      ...Object.values(sendgrid.TEMPLATE_IDS),
      ...sendgrid.BOOKING_EVENTS.map(sendgrid.templateForBookingEvent),
    ];
    expect(emitted).toEqual(expect.arrayContaining(['email.verification', 'booking.completed']));
    expect(emitted.filter((id) => !sendgrid.hasSubject(id))).toEqual([]);

    // The registry derives the booking family from its own event list; it must stay identical
    // to the lifecycle vocabulary the handler builds `booking.${event}` from, or a NEW event
    // would reintroduce TCB-W3-04 for exactly one flow.
    expect([...sendgrid.BOOKING_EVENTS].sort()).toEqual([...LIFECYCLE_EVENT_VALUES].sort());
  });

  test('transports forced to fail: POST /api/bookings still 201 well under 500 ms and the booking is committed', async () => {
    mockTransport.injectFailures(50, 'tcb-reverify: provider down');
    try {
      const listing = await makeApprovedListing({ seat_capacity: 2, seats_remaining: 2 });
      const guest = await makeGuest();
      const cookie = await cookieFor(guest);
      const t0 = Date.now();
      const res = await book(cookie, listing.id);
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(201);
      expect(elapsed).toBeLessThan(500);
      const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [
        res.body.booking.id,
      ]);
      expect(rows[0].status).toBe('pending');
      expect(await seatsRemaining(listing.id)).toBe(1);

      // The worker (not the request) is where the failure lands: jobs retry, never lost.
      const { rows: jobIds } = await query(
        `SELECT id FROM outbox_jobs WHERE type = 'notify.booking' AND payload->>'bookingId' = $1`,
        [res.body.booking.id]
      );
      await pollOnlyThese(
        jobIds.map((j) => j.id),
        createRegistry([notifyHandler]),
        1
      );
      const { rows: after } = await query(
        `SELECT status, attempt_count, last_error FROM outbox_jobs WHERE id = ANY($1::bigint[])`,
        [jobIds.map((j) => j.id)]
      );
      for (const job of after) {
        expect(job.status).toBe('pending'); // retrying with backoff
        expect(job.attempt_count).toBe(1);
        expect(job.last_error).toBeTruthy();
      }
    } finally {
      mockTransport.reset();
    }
  });

  test('ADR-001/003: no file under bookings/listings/hosts imports an adapter; search imports ONLY the ADR-005 maps read adapter', () => {
    const offenders = [];
    const searchImports = [];
    for (const file of srcFiles()) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      if (!/^modules\/(bookings|listings|hosts|search)\//.test(rel)) continue;
      const src = fs.readFileSync(file, 'utf8');
      const matches = [...src.matchAll(/require\(['"]([^'"]*adapters\/[^'"]+)['"]\)/g)].map(
        (m) => m[1]
      );
      if (matches.length === 0) continue;
      if (rel.startsWith('modules/search/')) searchImports.push(...matches);
      else offenders.push(`${rel}: ${matches.join(', ')}`);
    }
    expect(offenders).toEqual([]);
    // ADR-005 carve-out: the Maps read adapter is the ONE request-path adapter allowed.
    for (const imported of searchImports) expect(imported).toMatch(/adapters\/maps$/);
  });

  test('ADR-011: email is the configured channel and push is gated OFF by default', () => {
    expect(config.notifications.push.enabled).toBe(false);
    expect(config.notifications.transport).toBe('mock'); // dev/test transport (ADR-011)
  });
});

// ==============================================================================================
// FR-11 — one enforcement point, caps only in config
// ==============================================================================================

describe('FR-11 — server-side MEHKO enforcement is single-sourced (ADR-009)', () => {
  test('exactly one module calls the cap checker, and it is the listing service', () => {
    const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const callers = srcFiles()
      .filter((f) => /assertWithinCaps/.test(stripComments(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(SRC, f).replace(/\\/g, '/'))
      .sort();
    expect(callers).toEqual(['modules/listings/mehko.js', 'modules/listings/service.js']);
  });

  test('the cap NUMBERS appear only in src/config — never inline in a module', () => {
    const offenders = [];
    for (const file of srcFiles()) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      if (rel.startsWith('config/')) continue;
      const src = fs.readFileSync(file, 'utf8');
      // Strip comments before looking for cap-shaped literals.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const [name, value] of Object.entries({
        maxMealsPerDay: config.mehko.maxMealsPerDay,
        maxMealsPerWeek: config.mehko.maxMealsPerWeek,
      })) {
        const re = new RegExp(`(?<![\\w.])${value}(?![\\w])`);
        if (re.test(code)) offenders.push(`${rel}: literal ${value} (${name})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the DB unique index backing one-listing-per-host-per-day exists and is partial on non-cancelled', async () => {
    const { rows } = await query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'listings' AND indexname = 'listings_host_local_date_key'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/host_id/);
    expect(rows[0].indexdef).toMatch(/local_date/);
    expect(rows[0].indexdef).toMatch(/WHERE .*cancelled/i);
  });

  test('TCB-01 (SPEC AMBIGUITY, reproduced): the Monday-anchored week lets one host serve 120 meals in 4 consecutive days', async () => {
    // ADR-009 fixes "60 meals per host per week" but never names the window shape; the SRS is
    // silent. mehko.weekRangeFor implements a Monday-anchored LA calendar week, so a host can
    // fill Sat+Sun of week N and Mon+Tue of week N+1 — 120 meals across FOUR consecutive days,
    // twice the stated weekly cap over any 7-day span. Under a rolling-7-day reading the third
    // listing would be refused. This test records the OBSERVED behaviour so the team can ratify
    // or amend the anchor; it does not assert which reading is correct.
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const cap = config.mehko.maxMealsPerDay; // 30
    const body = (start) => ({
      title: 'Weekly anchor probe',
      description: 'A verifier-lane probe recording the FR-11 weekly-window ambiguity.',
      ingredients: ['rice'],
      allergens: ['none'],
      cuisine: 'test',
      scheduledStart: start,
      durationMinutes: 90,
      seatCapacity: cap,
      addressLine1: '9 Probe Street',
      city: 'San Diego',
      region: 'CA',
      postalCode: '92101',
    });
    const create = (start) =>
      request(app).post('/api/listings').set('Cookie', cookie).send(body(start));

    // 2031-03-08 Sat, 03-09 Sun (week Mon 03-03..Sun 03-09); 03-10 Mon, 03-11 Tue (next week).
    expect((await create('2031-03-08T20:00:00.000Z')).status).toBe(201);
    expect((await create('2031-03-09T20:00:00.000Z')).status).toBe(201);
    expect((await create('2031-03-10T20:00:00.000Z')).status).toBe(201);
    expect((await create('2031-03-11T20:00:00.000Z')).status).toBe(201);

    const { rows } = await query(
      `SELECT COALESCE(sum(seat_capacity), 0)::int AS seats FROM listings
        WHERE host_id = $1 AND status <> 'cancelled'
          AND local_date BETWEEN DATE '2031-03-08' AND DATE '2031-03-14'`,
      [host.id]
    );
    expect(rows[0].seats).toBe(4 * cap); // 120 meals in a 7-day window vs a 60/week cap
    expect(rows[0].seats).toBeGreaterThan(config.mehko.maxMealsPerWeek);
  });

  test('caps are configuration and frozen (1 listing/day, 30 meals/day, 60 meals/week, LA time)', () => {
    expect(config.mehko).toMatchObject({
      listingsPerHostPerDay: 1,
      maxMealsPerDay: 30,
      maxMealsPerWeek: 60,
      timezone: 'America/Los_Angeles',
    });
    expect(Object.isFrozen(config.mehko)).toBe(true);
  });
});

// ==============================================================================================
// FR-09 — one policy interface
// ==============================================================================================

describe('FR-09 — canReserveSeat / canPublishListing exist exactly once in src/', () => {
  test('no module outside src/modules/eligibility defines either predicate', () => {
    const offenders = [];
    for (const file of srcFiles()) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      if (rel.startsWith('modules/eligibility/')) continue;
      const code = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/function\s+can(ReserveSeat|PublishListing)\b/.test(code)) offenders.push(rel);
      if (/can(ReserveSeat|PublishListing)\s*[:=]\s*(\(|function|async)/.test(code)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('state-driven: the SAME request is 403 while an attribute is missing and 201 once it is set', async () => {
    const listing = await makeApprovedListing({ seat_capacity: 3, seats_remaining: 3 });
    const user = await makeUser({
      phone_enc: null,
      email_verified: true,
      full_name: 'Probe Guest',
    });
    const cookie = await cookieFor(user);

    const restricted = await book(cookie, listing.id);
    expect(restricted.status).toBe(403);
    expect(restricted.body.error.details.reasons).toEqual(['PHONE_MISSING']);

    await query(
      `UPDATE users SET phone_enc = 'enc:v1:probe', can_reserve_seat = true WHERE id = $1`,
      [user.id]
    );
    const permitted = await book(cookie, listing.id);
    expect(permitted.status).toBe(201);
  });
});

// ==============================================================================================
// FR-08 — wave-4 gap, and the FR-08-safe failure direction
// ==============================================================================================

describe('FR-08 — moderation pipeline is NOT implemented; the safe direction holds anyway', () => {
  test('no moderation module, routes, or decision writer exists (wave-4 gap, reported not_implemented)', () => {
    expect(fs.existsSync(path.join(SRC, 'modules', 'moderation'))).toBe(false);
    const registry = loadHandlers();
    expect(registry.types()).not.toContain('moderation.scan');
    expect(registry.get('moderation.scan')).toBeFalsy();
  });

  test('a moderation.scan job has no handler: it retries then DEAD-LETTERS, and the listing stays pending and invisible', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send({
        title: 'Reverify probe meal',
        description: 'A verifier-lane probe listing for the FR-08 safe-direction assertion.',
        ingredients: ['rice'],
        allergens: ['none'],
        cuisine: 'test',
        scheduledStart: new Date(Date.UTC(2030, 5, 17, 20, 0, 0)).toISOString(),
        durationMinutes: 90,
        seatCapacity: 4,
        addressLine1: '9 Probe Street',
        city: 'San Diego',
        region: 'CA',
        postalCode: '92101',
      });
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;
    expect(created.body.listing.moderationStatus).toBe('pending');

    const { rows: scan } = await query(
      `SELECT id FROM outbox_jobs WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
      [listingId]
    );
    expect(scan).toHaveLength(1);

    // Burn the retry budget with the REAL registry (no moderation handler is registered).
    const registry = loadHandlers();
    for (let i = 0; i < config.outbox.maxAttempts + 1; i += 1) {
      await query('UPDATE outbox_jobs SET available_at = now() WHERE id = $1', [scan[0].id]);
      await pollOnlyThese([scan[0].id], registry, 1);
    }
    const { rows: dead } = await query('SELECT status, last_error FROM outbox_jobs WHERE id = $1', [
      scan[0].id,
    ]);
    expect(dead[0].status).toBe('dead');
    expect(dead[0].last_error).toMatch(/no outbox handler registered/i);

    // FR-08's required failure direction: the content NEVER publishes itself.
    const { rows: still } = await query('SELECT moderation_status FROM listings WHERE id = $1', [
      listingId,
    ]);
    expect(still[0].moderation_status).toBe('pending');

    // …and it is invisible to every read path a non-owner can reach. (AB-08: both read
    // routes require a session — anonymous callers get 401, which is also invisibility.)
    expect((await request(app).get(`/api/listings/${listingId}`)).status).toBe(401);
    expect((await request(app).get('/api/listings/search').query({ q: 'Reverify' })).status).toBe(
      401
    );

    const browser = await makeGuest();
    const browserCookie = await cookieFor(browser);
    const detail = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Cookie', browserCookie);
    expect(detail.status).toBe(404); // pending content is indistinguishable from missing

    const search = await request(app)
      .get('/api/listings/search')
      .set('Cookie', browserCookie)
      .query({ city: 'San Diego', pageSize: 50 });
    expect(search.status).toBe(200);
    expect(JSON.stringify(search.body)).not.toContain(listingId);

    // The owner still sees their own pending listing (not a publication).
    const ownerView = await request(app).get(`/api/listings/${listingId}`).set('Cookie', cookie);
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.listing.moderationStatus).toBe('pending');
  });
});

// ==============================================================================================
// ADRC-W3-01 — local_date must reach the wire as a plain calendar date
// ==============================================================================================

describe('ADRC-W3-01 / FR-11 — listings.local_date on the wire', () => {
  test('GET /api/listings/:id returns localDate as YYYY-MM-DD, not a timezone-dependent instant', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const start = new Date(Date.UTC(2030, 6, 9, 20, 0, 0)).toISOString(); // 13:00 PDT 2030-07-09
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send({
        title: 'Local date probe',
        description: 'A verifier-lane probe listing for the ADR-009 local_date wire shape.',
        ingredients: ['rice'],
        allergens: ['none'],
        cuisine: 'test',
        scheduledStart: start,
        durationMinutes: 90,
        seatCapacity: 4,
        addressLine1: '9 Probe Street',
        city: 'San Diego',
        region: 'CA',
        postalCode: '92101',
      });
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

  test('TCB-W3-06 (fixed): the FR-11 audit path no longer stamps String(row.local_date)', async () => {
    // The hazard is real and unchanged: node-postgres hands back a JS Date for a SQL DATE, so
    // String() yields a full locale timestamp that AB-03 traceability cannot read as a MEHKO
    // calendar day. This half of the test pins the hazard.
    const listing = await makeListing({});
    const { rows } = await query('SELECT local_date FROM listings WHERE id = $1', [listing.id]);
    const naive = String(rows[0].local_date);
    expect(naive).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(naive).toMatch(/GMT|UTC/); // e.g. "Mon Mar 15 2030 00:00:00 GMT-0700 (…)"

    // …and the listing service no longer feeds that value into its audit records: it audits
    // auditLocalDate(row) → serializers.publicListing(row).localDate, the same 'YYYY-MM-DD'
    // rendering the wire uses. (The end-to-end assertion over the emitted audit records lives
    // in tests/mt-ut-quality/mt01-wave3-audit-gaps.test.js.)
    const service = fs.readFileSync(path.join(SRC, 'modules', 'listings', 'service.js'), 'utf8');
    expect(service).not.toMatch(/localDate:\s*String\(/);
    expect(service.match(/localDate:\s*auditLocalDate\(/g)).toHaveLength(3);
  });
});
