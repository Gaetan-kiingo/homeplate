// tests/tc-core/tc07-safety.test.js — TC-07 / FR-07: safety alerts (SRS §3.1; acceptance per
// docs/_generated/requirements-inventory.json). Replaces the wave-3 status probe that lived in
// tc05-07-wave4-status.test.js, exactly as that file's header instructed.
//
// Asserted here, by execution against the seeded test DB (SRS §4.1):
//   - POST /api/bookings/:id/safety-alerts persists a SAFETY_ALERT row (booking_id,
//     raised_by, delivery_status='pending') AND its 'safety.alert' outbox row, and returns
//     201 — with NO adapter loaded and NO notification attempt written during the request
//     (ADR-001/003: delivery is the worker's job, so a SendGrid outage cannot delay an alert);
//   - either participant may raise one (guest and host), in any booking state; a
//     non-participant is 403 and an unknown booking is 404, neither writing a row;
//   - an unauthenticated caller is 401 (AB-08);
//   - the response is the service allowlist: IDs, delivery state and timestamps only — no
//     address, no name, no emergency-contact value (NFR-13);
//   - GET /api/moderation/alerts is the FR-07 moderator queue: 401 unauthenticated, 403 for a
//     non-moderator session, 200 for the Moderator role, listing the alert from the instant it
//     was persisted (review does not wait on delivery), filterable by delivery status and
//     paginated under the shared NFR-02 caps.
//
// The worker-side legs of FR-07 (moderator notice, emergency-contact email, retry/dead-letter
// visibility) are IT-04: tests/it-adapters/it04-safety-delivery.test.js.
'use strict';

const path = require('path');
const request = require('supertest');

const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const { encrypt } = require('../../src/db/fieldCrypto');
const dbh = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const support = require('./support');

const sink = { write() {} };
const UNKNOWN_UUID = '00000000-0000-4000-8000-0000000007ff';

let app;
let host;
let hostCookie;
let guest;
let guestCookie;
let stranger;
let strangerCookie;
let moderator;
let moderatorCookie;
let listing;

/** Adapter modules currently loaded in this file's module registry (ADR-001 probe). */
function loadedAdapters() {
  const marker = `${path.sep}src${path.sep}adapters${path.sep}`;
  return Object.keys(require.cache).filter((p) => p.includes(marker));
}

async function alertRows(bookingId) {
  const { rows } = await dbh.query(
    `SELECT id, booking_id, raised_by, delivery_status, delivered_at
       FROM safety_alerts WHERE booking_id = $1 ORDER BY created_at ASC`,
    [bookingId]
  );
  return rows;
}

async function safetyJobs(alertId) {
  const { rows } = await dbh.query(
    `SELECT type, payload, dedupe_key, status FROM outbox_jobs
      WHERE type = 'safety.alert' AND payload->>'alertId' = $1`,
    [alertId]
  );
  return rows;
}

beforeAll(async () => {
  app = createApp({ logger: createLogger({ level: 'silent', stream: sink }) });
  host = await dbh.makeUser({ can_publish_listing: true });
  guest = await dbh.makeUser({
    emergency_contact_email_enc: encrypt('tc07-contact@relative.invalid'),
  });
  stranger = await dbh.makeUser();
  moderator = await dbh.makeUser({ roles: ['user', 'moderator'] });
  hostCookie = await support.cookieFor(host);
  guestCookie = await support.cookieFor(guest);
  strangerCookie = await support.cookieFor(stranger);
  moderatorCookie = await support.cookieFor(moderator);
  listing = await support.makeApprovedListing({
    host_id: host.id,
    seat_capacity: 8,
    seats_remaining: 4,
  });
});

afterAll(async () => {
  await dbh.closeDb();
  await closeTestRedis();
});

// =============================================================================================
// POST /api/bookings/:id/safety-alerts — persist first, deliver later
// =============================================================================================
describe('TC-07 · POST /api/bookings/:id/safety-alerts (FR-07 persist + defer)', () => {
  test('the guest raises an alert: 201, row pending, outbox row committed with it, nothing sent inline', async () => {
    const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const attemptsBefore = await dbh.countRows('notification_attempts');
    const adaptersBefore = loadedAdapters();

    const res = await support.post(app, `/api/bookings/${booking.id}/safety-alerts`, guestCookie);
    expect(res.status).toBe(201);

    // FR-07 "the system shall persist the alert" — in the database, not just the response.
    const rows = await alertRows(booking.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      booking_id: booking.id,
      raised_by: guest.id,
      delivery_status: 'pending',
      delivered_at: null,
    });
    expect(res.body.alert).toEqual({
      id: rows[0].id,
      bookingId: booking.id,
      raisedByUserId: guest.id,
      deliveryStatus: 'pending',
      deliveredAt: null,
      createdAt: expect.any(String),
    });

    // ADR-001/003: the deferred-work row committed in the SAME transaction, IDs only.
    const jobs = await safetyJobs(rows[0].id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].payload).toEqual({ alertId: rows[0].id, bookingId: booking.id });
    expect(jobs[0].dedupe_key).toBe(`safety.alert:${rows[0].id}`);

    // …and NOTHING was delivered on the request path: no adapter loaded, no attempt row.
    expect(loadedAdapters().filter((a) => !adaptersBefore.includes(a))).toEqual([]);
    expect(await dbh.countRows('notification_attempts')).toBe(attemptsBefore);
  });

  test('the host may raise one too, and a completed booking is still alertable', async () => {
    const booking = await support.makeCompletedBooking(listing.id, guest.id);
    const res = await support.post(app, `/api/bookings/${booking.id}/safety-alerts`, hostCookie);
    expect(res.status).toBe(201);
    expect(res.body.alert.raisedByUserId).toBe(host.id);
    const rows = await alertRows(booking.id);
    expect(rows.map((r) => r.raised_by)).toEqual([host.id]);
  });

  test('the response body carries no personal data (NFR-13 allowlist)', async () => {
    const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const res = await support.post(app, `/api/bookings/${booking.id}/safety-alerts`, guestCookie);
    expect(res.status).toBe(201);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(support.EMAIL_SHAPE);
    expect(body).not.toMatch(/address|street|phone|emergency|fullName/i);
  });

  test('a non-participant is 403 and an unknown booking is 404 — neither writes a row', async () => {
    const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const before = await dbh.countRows('safety_alerts');

    const forbidden = await support.post(
      app,
      `/api/bookings/${booking.id}/safety-alerts`,
      strangerCookie
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('NOT_PARTICIPANT');

    const missing = await support.post(
      app,
      `/api/bookings/${UNKNOWN_UUID}/safety-alerts`,
      guestCookie
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('BOOKING_NOT_FOUND');

    expect(await dbh.countRows('safety_alerts')).toBe(before);
  });

  test('unauthenticated is 401 and malformed ids are 422 — never a 500 (AB-06/AB-08)', async () => {
    const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const anon = await request(app).post(`/api/bookings/${booking.id}/safety-alerts`).send({});
    expect(anon.status).toBe(401);

    // A SQLi-shaped id arrives as inert data and fails the uuid shape check (422), never 500.
    const before = await dbh.countRows('safety_alerts');
    const hostile = await support.post(
      app,
      `/api/bookings/${encodeURIComponent("1' OR '1'='1")}/safety-alerts`,
      guestCookie
    );
    expect(hostile.status).toBe(422);
    expect(await dbh.countRows('safety_alerts')).toBe(before); // tables intact, nothing written
  });
});

// =============================================================================================
// GET /api/moderation/alerts — the FR-07 moderator queue
// =============================================================================================
describe('TC-07 · GET /api/moderation/alerts (FR-07 moderator queue)', () => {
  test('an alert is listed for the Moderator role from the moment it is persisted', async () => {
    const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const created = await support.post(
      app,
      `/api/bookings/${booking.id}/safety-alerts`,
      guestCookie
    );
    expect(created.status).toBe(201);

    // No worker run in between: review must not wait on delivery.
    const res = await support.get(app, '/api/moderation/alerts?pageSize=100', moderatorCookie);
    expect(res.status).toBe(200);
    const entry = res.body.alerts.find((a) => a.id === created.body.alert.id);
    expect(entry).toMatchObject({
      bookingId: booking.id,
      listingId: listing.id,
      hostId: host.id,
      raisedByUserId: guest.id,
      deliveryStatus: 'pending',
    });
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(res.body)).not.toMatch(support.EMAIL_SHAPE);
  });

  test('the queue is Moderator-only: 401 unauthenticated, 403 for an ordinary session', async () => {
    const anon = await request(app).get('/api/moderation/alerts');
    expect(anon.status).toBe(401);

    const ordinary = await support.get(app, '/api/moderation/alerts', guestCookie);
    expect(ordinary.status).toBe(403);
    expect(ordinary.body.error.code).toBe('NOT_MODERATOR');
    expect(ordinary.body).not.toHaveProperty('alerts');
  });

  test('status filter and pagination caps are enforced by the shared schema (NFR-02/NFR-11)', async () => {
    const filtered = await support.get(
      app,
      '/api/moderation/alerts?status=delivered',
      moderatorCookie
    );
    expect(filtered.status).toBe(200);
    for (const a of filtered.body.alerts) expect(a.deliveryStatus).toBe('delivered');

    const bogus = await support.get(app, '/api/moderation/alerts?status=nope', moderatorCookie);
    expect(bogus.status).toBe(422);

    const oversized = await support.get(
      app,
      '/api/moderation/alerts?pageSize=500',
      moderatorCookie
    );
    expect(oversized.status).toBe(422);

    const paged = await support.get(app, '/api/moderation/alerts?pageSize=1', moderatorCookie);
    expect(paged.status).toBe(200);
    expect(paged.body.alerts).toHaveLength(1);
    expect(paged.body.pageSize).toBe(1);
  });
});

// =============================================================================================
// POST /api/moderation/alerts — AB-04 moderator escalation (U4-SAFETY-COMPLETE)
// =============================================================================================
describe('TC-07 · POST /api/moderation/alerts (AB-04 escalation — moderator-gated, audited, deferred)', () => {
  test('a moderator escalates flagged content into a REAL booking-bound alert: 201, pending row, outbox row, nothing inline', async () => {
    const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const attemptsBefore = await dbh.countRows('notification_attempts');
    const adaptersBefore = loadedAdapters();

    const res = await request(app)
      .post('/api/moderation/alerts')
      .set('Cookie', moderatorCookie)
      .send({ bookingId: booking.id });
    expect(res.status).toBe(201);

    // A real alert on the booking, raised BY the moderator (they need not be a participant).
    const rows = await alertRows(booking.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      booking_id: booking.id,
      raised_by: moderator.id,
      delivery_status: 'pending',
      delivered_at: null,
    });
    expect(res.body.alert).toEqual({
      id: rows[0].id,
      bookingId: booking.id,
      raisedByUserId: moderator.id,
      deliveryStatus: 'pending',
      deliveredAt: null,
      createdAt: expect.any(String),
    });

    // The NORMAL delivery path: same job type, IDs-only payload, per-alert dedupe key —
    // committed with the alert row, delivered later by the worker (ADR-001/003).
    const jobs = await safetyJobs(rows[0].id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].payload).toEqual({ alertId: rows[0].id, bookingId: booking.id });
    expect(jobs[0].dedupe_key).toBe(`safety.alert:${rows[0].id}`);

    // …and nothing was sent inline: no adapter loaded, no notification attempt written.
    expect(loadedAdapters().filter((a) => !adaptersBefore.includes(a))).toEqual([]);
    expect(await dbh.countRows('notification_attempts')).toBe(attemptsBefore);

    // The escalated alert joins the FR-07 moderator queue immediately.
    const queue = await support.get(app, '/api/moderation/alerts?pageSize=100', moderatorCookie);
    expect(queue.status).toBe(200);
    const entry = queue.body.alerts.find((a) => a.id === rows[0].id);
    expect(entry).toMatchObject({ bookingId: booking.id, raisedByUserId: moderator.id });

    // NFR-13: the escalation response is the same explicit allowlist as a raised alert.
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(support.EMAIL_SHAPE);
    expect(body).not.toMatch(/address|street|phone|emergency|fullName/i);
  });

  test('the escalation surface is Moderator-only: 401 unauthenticated, 403 ordinary session — no row either way', async () => {
    const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const before = await dbh.countRows('safety_alerts');

    const anon = await request(app).post('/api/moderation/alerts').send({ bookingId: booking.id });
    expect(anon.status).toBe(401);

    // Even a PARTICIPANT without the role is refused here (their surface is the booking route).
    const ordinary = await request(app)
      .post('/api/moderation/alerts')
      .set('Cookie', guestCookie)
      .send({ bookingId: booking.id });
    expect(ordinary.status).toBe(403);
    expect(ordinary.body.error.code).toBe('NOT_MODERATOR');

    expect(await dbh.countRows('safety_alerts')).toBe(before);
  });

  test('an unknown booking is 404 and a malformed body is 422 — never a 500, nothing written (AB-06)', async () => {
    const before = await dbh.countRows('safety_alerts');

    const missing = await request(app)
      .post('/api/moderation/alerts')
      .set('Cookie', moderatorCookie)
      .send({ bookingId: UNKNOWN_UUID });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('BOOKING_NOT_FOUND');

    const noBody = await request(app)
      .post('/api/moderation/alerts')
      .set('Cookie', moderatorCookie)
      .send({});
    expect(noBody.status).toBe(422);

    const hostile = await request(app)
      .post('/api/moderation/alerts')
      .set('Cookie', moderatorCookie)
      .send({ bookingId: "1' OR '1'='1" });
    expect(hostile.status).toBe(422);

    expect(await dbh.countRows('safety_alerts')).toBe(before);
  });
});
