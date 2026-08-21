// tests/mt-ut-quality/mt01-wave3-booking-audit.test.js — verifier lane "mt-ut-quality".
//
// MT-01 (SRS §4.6) / NFR-08 over the wave-3+ surface, consolidated (2026-08-21) from the three
// round files this lane had accreted: the original wave-3 file, the W3-RV-OBS-SAFETY
// re-verification unit (mt01-w3rv-safety-audit.test.js) and the wave-3 gap round
// (mt01-wave3-audit-gaps.test.js). Registration/login/logout and the request-tracing substrate
// (generated correlation IDs, error records, query-string stripping) live in the sibling
// mt01-log-completeness.test.js.
//
// Of MT-01's four named actions, BOOKING CREATION and BOOKING CANCELLATION land in wave 3
// (U3-BOOKINGS), with LISTING CREATION (U3-LISTINGS) as the fixture path — itself an
// "important action" whose audit record AB-03's acceptance requires ("listing creations are
// logged with host ID and local date"). The MODERATION DECISION action is wave 4
// (U4-MODERATION); its absence is PROBED below so "not implemented" stays a measured fact,
// not an assumption. The FR-07 safety module (src/modules/safety/*,
// src/outbox/handlers/safetyAlert.js) landed AFTER the round-1 lane ran (git diff
// 3136b91..bc27199); raising a safety alert is unambiguously one of NFR-08's "important
// actions", and it is the only flow here that decrypts a THIRD PARTY's personal data (the
// emergency contact) on the worker path — the sharpest possible test of the SRS §3.4 PII
// register rule "logs contain user IDs only".
//
// What this file proves, end to end, against the REAL app factory + REAL outbox worker:
//   1. Booking create/cancel, listing create/update/cancel, FR-04 completion confirmations,
//      FR-02/FR-03 media attach/delete-mark and FR-07 safety alerts each emit ONE structured
//      JSON audit record carrying event, correlation ID, actor user ID, subject entity ID,
//      outcome and timestamp (NFR-08).
//   2. The request's correlation ID propagates onto every outbox row the transaction wrote
//      AND into the worker's log lines for those jobs — same ID on both sides — including on
//      FAILING jobs (moderation.scan has no wave-3 handler; its retry line must still carry
//      the originating request's ID) and on WORKER-INITIATED transitions (booking.promote has
//      no HTTP request behind it; its audit record must name the system actor — MTUT-W3-02).
//   3. AB-03's LOCAL DATE is a YYYY-MM-DD MEHKO calendar day equal to
//      mehko.localDateFor(scheduledStart), not merely "a string" (finding W3-MT-01).
//   4. Refusals are audited too (outcome 'failure' + machine reason) — AB-02's acceptance
//      ("every create/cancel writes an audit record so the pattern is reconstructable").
//   5. Outbox payloads and NOTIFICATION_ATTEMPT rows carry IDs only (ADR-003 / ADR-011),
//      including the FR-07 emergency-contact legs.
//   6. The whole captured log corpus contains user IDs only: no email, password, full name,
//      phone number, street address or postal code (SRS §3.4 PII register; ADR-010-adjacent
//      for the host address).
//   7. The cause chain is reconstructable from audit records alone:
//      booking.cancelled → booking.created → listing.created → user.registered.
//
// Fixture note: email verification, moderation approval and the moderator role are flipped by
// direct SQL — the verification email flow has its own MT-01 coverage
// (mt01-log-completeness.test.js) and the moderation pipeline is wave 4; SQL here is
// test-environment state preparation and assertion READS, never a fake of anything this file
// asserts on.
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { loadHandlers } = require('../../src/outbox/dispatch');
const mehko = require('../../src/modules/listings/mehko');
const mediaUrls = require('../../src/lib/mediaUrls');
const { query, closeDb } = require('../helpers/db');
const { closeRedis } = require('../../src/db/redis');
const { makeRecordingLogger, drainOutboxUntil } = require('./support');

// ---- recording logger (the exact bytes a log aggregator would receive) ----------------------
const { lines, logger: recLogger, records, auditRecords, auditsFor } = makeRecordingLogger();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---- fixture identity (synthetic, PII-shaped on purpose for the leak scan) ------------------
const RUN = `${process.pid}${Date.now()}`;
const HOST = {
  email: `mt01w3.host.${RUN}@mt01-lane.homeplate.invalid`,
  password: 'CorrectHorse!42w3h',
  fullName: 'Beauregard Xolotl-Hostperson',
  phone: '+14155550177',
};
const GUEST = {
  email: `mt01w3.guest.${RUN}@mt01-lane.homeplate.invalid`,
  password: 'CorrectHorse!42w3g',
  fullName: 'Peregrine Zizania-Guestperson',
  phone: '+14155550188',
};
const INTRUDER = {
  email: `mt01w3.intruder.${RUN}@mt01-lane.homeplate.invalid`,
  password: 'CorrectHorse!42w3i',
  fullName: 'Thaddeus Pangolin-Intruder',
  phone: '+14155550333',
};
const OUTSIDER = {
  email: `mt01w3.outsider.${RUN}@mt01-lane.homeplate.invalid`,
  password: 'CorrectHorse!42w3o',
  fullName: 'Ignatius Basilisk-Outsider',
  phone: '+14155550933',
};
const MODERATOR = {
  email: `mt01w3.mod.${RUN}@mt01-lane.homeplate.invalid`,
  password: 'CorrectHorse!42w3m',
  fullName: 'Rosalind Nightjar-Moderator',
  phone: '+14155550944',
};
// FR-07: a THIRD PARTY's personal data, decrypted inside the worker to deliver an alert.
// Every value is distinctive enough that a substring sweep over the captured corpus cannot
// produce a false negative or a coincidental hit.
const EMERGENCY = {
  name: 'Perpetua Quillfeather-Nextofkin',
  phone: '+14155550977',
  email: `mt01w3.emergency.${RUN}@mt01-lane.homeplate.invalid`,
};
// Distinctive street markers: must never appear in any log line (SRS §3.4 / ADR-010).
const STREET = '742 Sagebrush Hollow Lane';
const SAFETY_STREET = '2277 Windlass Hollow Byway';

const LISTING_CID = `mt01w3-listing-${RUN}`;
const BOOKING_CID = `mt01w3-booking-${RUN}`;
const CANCEL_CID = `mt01w3-cancel-${RUN}`;
const REFUSE_CID = `mt01w3-refuse-${RUN}`;
const RECANCEL_CID = `mt01w3-recancel-${RUN}`;
const RAISE_CID = `mt01w3-raise-${RUN}`;

let app;
let hostId;
let guestId;
let hostCookie;
let guestCookie;
let outsiderCookie;
let moderatorCookie;
let listingId;
let bookingId;
let safetyListingId;
let safetyBookingId;
let alertId;

async function registerAndLogin(identity) {
  const reg = await request(app).post('/api/auth/register').send({
    email: identity.email,
    password: identity.password,
    fullName: identity.fullName,
    phone: identity.phone,
  });
  expect(reg.status).toBe(201);
  const userId = reg.body.user.id;
  // Fixture: flip verification directly (the verification email flow is covered by the
  // sibling mt01 file); eligibility (FR-09/NFR-06) requires it before booking/publishing.
  await query('UPDATE users SET email_verified = true WHERE id = $1', [userId]);
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: identity.email, password: identity.password });
  expect(login.status).toBe(200);
  return { userId, cookie: login.headers['set-cookie'].join(';') };
}

function listingBody(scheduledStart, overrides = {}) {
  return {
    title: 'MT01 Wave3 Tamales Night',
    description: 'Audit-trail probe meal.',
    ingredients: ['masa', 'chicken'],
    allergens: ['gluten'],
    cuisine: 'mexican',
    scheduledStart,
    durationMinutes: 90,
    seatCapacity: 2,
    addressLine1: STREET,
    city: 'San Diego',
    region: 'CA',
    postalCode: '92101',
    country: 'US',
    ...overrides,
  };
}

// Every probe listing sits on its own LA calendar day (the 1-listing/host/day cap, TC-11).
const daysOut = (n) => new Date(Date.now() + n * 24 * 3600 * 1000).toISOString();

beforeAll(async () => {
  app = createApp({ logger: recLogger });
  ({ userId: hostId, cookie: hostCookie } = await registerAndLogin(HOST));
  ({ userId: guestId, cookie: guestCookie } = await registerAndLogin(GUEST));
  // Host eligibility for PUBLISH_LISTING: complete profile (non-blank bio) + agreement.
  await query(
    `INSERT INTO host_profiles (user_id, bio, host_agreement_accepted_at)
     VALUES ($1, $2, now())`,
    [hostId, 'MT-01 wave-3 fixture host.']
  );
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

// =============================================================================================
// Listing lifecycle (fixture path) — AB-03 / NFR-08 audit records with a real LOCAL DATE
// =============================================================================================
describe('MT-01 / NFR-08 / AB-03 — listing lifecycle is audited and traceable', () => {
  const UPDATE_CID = `mt01w3-listupdate-${RUN}`;
  const LISTCANCEL_CID = `mt01w3-listcancel-${RUN}`;
  let scheduledStart;

  test('POST /api/listings (201) emits one audit record with host ID + YYYY-MM-DD local date, no address', async () => {
    scheduledStart = daysOut(2);
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .set('X-Correlation-Id', LISTING_CID)
      .send(listingBody(scheduledStart));

    expect(res.status).toBe(201);
    listingId = res.body.listing.id;
    expect(listingId).toMatch(/^[0-9a-f-]{36}$/);

    const audits = auditsFor('listing.created', LISTING_CID);
    expect(audits).toHaveLength(1);
    const rec = audits[0];
    expect(rec.outcome).toBe('success');
    expect(rec.actorUserId).toBe(hostId);
    expect(rec.hostId).toBe(hostId);
    expect(rec.entityType).toBe('listing');
    expect(rec.entityId).toBe(listingId);
    // AB-03: the reviewable LOCAL DATE. `typeof rec.localDate === 'string'` once passed here
    // while the value was a stringified JS Date — unusable as a MEHKO calendar day (finding
    // W3-MT-01, since repaired). Pinned to the contract the wire serializer honours
    // (src/modules/listings/serializers.js isoCalendarDate): YYYY-MM-DD, equal to
    // mehko.localDateFor(scheduledStart) — and the response body agrees.
    const expected = mehko.localDateFor(scheduledStart);
    expect(expected).toMatch(ISO_DATE); // sanity: the module under comparison is well-formed
    expect(res.body.listing.localDate).toBe(expected);
    expect(rec.localDate).toMatch(ISO_DATE);
    expect(rec.localDate).toBe(expected);
    expect(Number.isNaN(Date.parse(rec.time))).toBe(false);
    // The audit record itself must not carry the address (user IDs only — SRS §3.4).
    expect(JSON.stringify(rec)).not.toContain(STREET);
  });

  test('moderation.scan + listing.geocode outbox rows are stamped with the SAME correlation ID, IDs-only payloads', async () => {
    const jobs = await query(
      `SELECT type, payload, correlation_id FROM outbox_jobs
       WHERE (type = 'moderation.scan' AND payload->>'contentId' = $1)
          OR (type = 'listing.geocode' AND payload->>'listingId' = $1)
       ORDER BY type`,
      [listingId]
    );
    expect(jobs.rows.map((r) => r.type).sort()).toEqual(['listing.geocode', 'moderation.scan']);
    for (const row of jobs.rows) {
      expect(row.correlation_id).toBe(LISTING_CID); // NFR-08 propagation, request side
      const payloadText = JSON.stringify(row.payload);
      expect(payloadText).not.toContain(STREET); // ADR-003: IDs only, never the address
      expect(payloadText).not.toContain('@');
    }
  });

  test('listing.updated — a reschedule audits the NEW local date in YYYY-MM-DD', async () => {
    // Own probe listing on its own LA days: rescheduling the shared fixture listing could
    // enqueue further moderation/geocode rows for it and disturb the exact-row assertions
    // above and the failing-job assertions below — state those tests own.
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send(listingBody(daysOut(6), { title: 'MT01 Wave3 Reschedule Probe' }));
    expect(created.status).toBe(201);

    const newStart = daysOut(7);
    const res = await request(app)
      .patch(`/api/listings/${created.body.listing.id}`)
      .set('Cookie', hostCookie)
      .set('X-Correlation-Id', UPDATE_CID)
      .send({ scheduledStart: newStart });
    expect(res.status).toBe(200);

    const expected = mehko.localDateFor(newStart);
    expect(res.body.listing.localDate).toBe(expected);

    const [rec] = auditsFor('listing.updated', UPDATE_CID);
    expect(rec).toBeDefined();
    expect(rec.entityId).toBe(created.body.listing.id);
    expect(rec.localDate).toMatch(ISO_DATE);
    expect(rec.localDate).toBe(expected);
  });

  test('listing.cancelled — the audit record also carries a YYYY-MM-DD local date', async () => {
    // A throwaway listing on a DIFFERENT LA day so the 1-listing/host/day cap is untouched.
    const start = daysOut(10);
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send(listingBody(start, { title: 'MT01 Wave3 Cancel Probe' }));
    expect(created.status).toBe(201);

    const res = await request(app)
      .post(`/api/listings/${created.body.listing.id}/cancel`)
      .set('Cookie', hostCookie)
      .set('X-Correlation-Id', LISTCANCEL_CID)
      .send();
    expect(res.status).toBe(200);

    const [rec] = auditsFor('listing.cancelled', LISTCANCEL_CID);
    expect(rec).toBeDefined();
    expect(rec.localDate).toMatch(ISO_DATE);
    expect(rec.localDate).toBe(mehko.localDateFor(start));
  });
});

// =============================================================================================
// MT-01 action 4 — moderation decision (wave 4): measured absence, not assumed
// =============================================================================================
describe('MT-01 action 4 — a moderation decision cannot be performed in this build', () => {
  test('no moderation decision surface is mounted (probed, not assumed)', async () => {
    const probes = [
      ['get', '/api/moderation/queue'],
      ['post', '/api/moderation/decisions'],
      ['post', `/api/moderation/items/${listingId}/approve`],
      ['post', `/api/listings/${listingId}/moderate`],
    ];
    for (const [method, path] of probes) {
      const res = await request(app)[method](path).set('Cookie', hostCookie).send();
      expect([404, 405]).toContain(res.status);
    }
    // No moderation.decision audit event can exist anywhere in the corpus.
    expect(auditRecords().filter((r) => String(r.event).startsWith('moderation.'))).toHaveLength(0);
  });
});

// =============================================================================================
// Booking creation — audited end to end
// =============================================================================================
describe('MT-01 / NFR-08 — booking creation is audited end to end', () => {
  beforeAll(async () => {
    // Fixture: the moderation pipeline is wave 4 — approve directly so the listing is bookable.
    await query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [listingId]);
  });

  test('POST /api/bookings (201) emits one complete structured audit record', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .set('X-Correlation-Id', BOOKING_CID)
      .send({ listingId });

    expect(res.status).toBe(201);
    expect(res.headers['x-correlation-id']).toBe(BOOKING_CID);
    bookingId = res.body.booking.id;
    expect(bookingId).toMatch(/^[0-9a-f-]{36}$/);

    const audits = auditsFor('booking.created', BOOKING_CID);
    expect(audits).toHaveLength(1);
    const rec = audits[0];
    expect(rec.outcome).toBe('success');
    expect(rec.actorUserId).toBe(guestId);
    expect(rec.entityType).toBe('booking');
    expect(rec.entityId).toBe(bookingId);
    expect(rec.listingId).toBe(listingId); // cause reconstruction: booking → listing
    expect(typeof rec.time).toBe('string');
    expect(Number.isNaN(Date.parse(rec.time))).toBe(false);
  });

  test('the BOOKING row exists; notify.booking ×2 + booking.promote carry the SAME correlation ID', async () => {
    const bookings = await query('SELECT id, status, guest_id FROM bookings WHERE id = $1', [
      bookingId,
    ]);
    expect(bookings.rows).toHaveLength(1);
    expect(bookings.rows[0].status).toBe('pending');
    expect(bookings.rows[0].guest_id).toBe(guestId);

    const notify = await query(
      `SELECT payload, correlation_id FROM outbox_jobs
       WHERE type = 'notify.booking' AND payload->>'bookingId' = $1
         AND payload->>'event' = 'created'`,
      [bookingId]
    );
    expect(notify.rows).toHaveLength(2); // guest + host (FR-13)
    const recipients = notify.rows.map((r) => r.payload.recipientUserId).sort();
    expect(recipients).toEqual([guestId, hostId].sort());
    for (const row of notify.rows) {
      expect(row.correlation_id).toBe(BOOKING_CID);
      const payloadText = JSON.stringify(row.payload);
      expect(payloadText).not.toContain('@'); // IDs only (ADR-003)
      expect(payloadText).not.toContain(STREET);
    }

    const promote = await query(
      `SELECT correlation_id FROM outbox_jobs
       WHERE type = 'booking.promote' AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    expect(promote.rows).toHaveLength(1);
    expect(promote.rows[0].correlation_id).toBe(BOOKING_CID);
  });

  test('worker log lines for the notify jobs carry the SAME correlation ID; attempts persisted, IDs only', async () => {
    const registry = loadHandlers({ log: recLogger });
    // Drain until THIS booking's created-notifications are delivered (see ./support.js
    // drainOutboxUntil for the F-01 determinism rationale).
    await drainOutboxUntil({
      registry,
      log: recLogger,
      isDone: async () => {
        const { rows } = await query(
          `SELECT count(*)::int AS n FROM outbox_jobs
           WHERE type = 'notify.booking' AND payload->>'bookingId' = $1
             AND payload->>'event' = 'created' AND status = 'delivered'`,
          [bookingId]
        );
        return rows[0].n === 2;
      },
    });

    const delivered = records().filter(
      (r) =>
        r.event === 'outbox_job_delivered' &&
        r.correlationId === BOOKING_CID &&
        r.jobType === 'notify.booking'
    );
    expect(delivered).toHaveLength(2); // both sides of NFR-08: same ID request → worker

    // ADR-011: the mock transport persisted one attempt per recipient — IDs only.
    const attempts = await query(
      `SELECT recipient_user_id, params FROM notification_attempts
       WHERE (params->>'bookingId') = $1`,
      [bookingId]
    );
    expect(attempts.rows.length).toBeGreaterThanOrEqual(2);
    const attemptRecipients = new Set(attempts.rows.map((r) => r.recipient_user_id));
    expect(attemptRecipients.has(guestId)).toBe(true);
    expect(attemptRecipients.has(hostId)).toBe(true);
    const attemptsText = JSON.stringify(attempts.rows);
    expect(attemptsText).not.toContain('@');
    expect(attemptsText).not.toContain(STREET);
  });

  test('a FAILING job (moderation.scan, handler lands wave 4) still logs with the originating correlation ID', async () => {
    // The drain above claimed the due moderation.scan job at least once; no handler is
    // registered until U4-MODERATION, so its retry/dead-letter line must still be traceable
    // to the listing-creation request (NFR-08 — errors carry the correlation ID).
    const scanLines = records().filter(
      (r) =>
        (r.event === 'outbox_job_retry' || r.event === 'outbox_job_dead_letter') &&
        r.jobType === 'moderation.scan' &&
        r.correlationId === LISTING_CID
    );
    expect(scanLines.length).toBeGreaterThanOrEqual(1);
    expect(scanLines[0].err && typeof scanLines[0].err.message).toBe('string');
    // And the row is still queryable, not lost, still pending-or-dead (FR-08 safe direction).
    const scan = await query(
      `SELECT status FROM outbox_jobs
       WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
      [listingId]
    );
    expect(scan.rows).toHaveLength(1);
    expect(['pending', 'dead']).toContain(scan.rows[0].status);
  });

  test('a REFUSED booking (own listing, 409) is audited with outcome failure + machine reason (AB-02)', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', hostCookie)
      .set('X-Correlation-Id', REFUSE_CID)
      .send({ listingId });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OWN_LISTING');

    const audits = auditsFor('booking.created', REFUSE_CID);
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('failure');
    expect(audits[0].reason).toBe('OWN_LISTING');
    expect(audits[0].actorUserId).toBe(hostId);
  });
});

// =============================================================================================
// Booking cancellation — audited end to end
// =============================================================================================
describe('MT-01 / NFR-08 — booking cancellation is audited end to end', () => {
  test('POST /api/bookings/:id/cancel (200) emits one complete audit record; notify rows share its correlation ID', async () => {
    const res = await request(app)
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Cookie', guestCookie)
      .set('X-Correlation-Id', CANCEL_CID)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('cancelled');

    const audits = auditsFor('booking.cancelled', CANCEL_CID);
    expect(audits).toHaveLength(1);
    const rec = audits[0];
    expect(rec.outcome).toBe('success');
    expect(rec.actorUserId).toBe(guestId);
    expect(rec.entityType).toBe('booking');
    expect(rec.entityId).toBe(bookingId);
    expect(rec.role).toBe('guest');
    expect(rec.idempotent).toBe(false);
    expect(Number.isNaN(Date.parse(rec.time))).toBe(false);

    const notify = await query(
      `SELECT payload, correlation_id FROM outbox_jobs
       WHERE type = 'notify.booking' AND payload->>'bookingId' = $1
         AND payload->>'event' = 'cancelled_by_guest'`,
      [bookingId]
    );
    expect(notify.rows).toHaveLength(2);
    for (const row of notify.rows) {
      expect(row.correlation_id).toBe(CANCEL_CID);
    }

    // The seat came back exactly once (FR-14) — the audit trail matches reality.
    const seats = await query('SELECT seats_remaining, seat_capacity FROM listings WHERE id = $1', [
      listingId,
    ]);
    expect(seats.rows[0].seats_remaining).toBe(seats.rows[0].seat_capacity);
  });

  test('an idempotent repeat cancel is audited as such and enqueues nothing new', async () => {
    const res = await request(app)
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Cookie', guestCookie)
      .set('X-Correlation-Id', RECANCEL_CID)
      .send();

    expect(res.status).toBe(200);
    const audits = auditsFor('booking.cancelled', RECANCEL_CID);
    expect(audits).toHaveLength(1);
    expect(audits[0].idempotent).toBe(true);

    const notify = await query(
      `SELECT count(*)::int AS n FROM outbox_jobs WHERE correlation_id = $1`,
      [RECANCEL_CID]
    );
    expect(notify.rows[0].n).toBe(0); // no duplicate notifications (FR-13/FR-14)
  });
});

// =============================================================================================
// FR-04 meal completion — audit records for an "important action" (NFR-08)
// =============================================================================================
describe('MT-01 / FR-04 — completion confirmations are audited with correlation IDs', () => {
  const GUEST_CONFIRM_CID = `mt01w3-cg-${RUN}`;
  const HOST_CONFIRM_CID = `mt01w3-ch-${RUN}`;
  let completionBookingId;

  beforeAll(async () => {
    // Own fixture on its own LA day: the shared listing's booking is cancelled by the block
    // above, and FR-04 needs a live one.
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send(listingBody(daysOut(15), { title: 'MT01 Wave3 Completion Probe' }));
    expect(created.status).toBe(201);
    const completionListingId = created.body.listing.id;
    await query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [
      completionListingId,
    ]);
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .send({ listingId: completionListingId });
    expect(res.status).toBe(201);
    completionBookingId = res.body.booking.id;
    // Move the meal into the past and the booking into in_progress — the state the FR-04
    // dual-confirmation flow requires (the promote worker does this on the real clock).
    await query(`UPDATE listings SET scheduled_start = now() - interval '3 hours' WHERE id = $1`, [
      completionListingId,
    ]);
    await query(`UPDATE bookings SET status = 'in_progress' WHERE id = $1`, [completionBookingId]);
  });

  test('the guest confirmation audits booking.completion_confirmed (awaiting the other party)', async () => {
    const res = await request(app)
      .post(`/api/bookings/${completionBookingId}/confirm-completion`)
      .set('Cookie', guestCookie)
      .set('X-Correlation-Id', GUEST_CONFIRM_CID)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.awaitingOtherParty).toBe(true);

    const [rec] = auditsFor('booking.completion_confirmed', GUEST_CONFIRM_CID);
    expect(rec).toBeDefined();
    expect(rec.outcome).toBe('success');
    expect(rec.actorUserId).toBe(guestId);
    expect(rec.entityType).toBe('booking');
    expect(rec.entityId).toBe(completionBookingId);
    expect(rec.role).toBe('guest');
    expect(Number.isNaN(Date.parse(rec.time))).toBe(false);
  });

  test('the host confirmation audits booking.completed and the row really is completed', async () => {
    const res = await request(app)
      .post(`/api/bookings/${completionBookingId}/confirm-completion`)
      .set('Cookie', hostCookie)
      .set('X-Correlation-Id', HOST_CONFIRM_CID)
      .send();
    expect(res.status).toBe(200);

    const [rec] = auditsFor('booking.completed', HOST_CONFIRM_CID);
    expect(rec).toBeDefined();
    expect(rec.actorUserId).toBe(hostId);
    expect(rec.entityId).toBe(completionBookingId);

    const { rows } = await query('SELECT status, completed_at FROM bookings WHERE id = $1', [
      completionBookingId,
    ]);
    expect(rows[0].status).toBe('completed');
    expect(rows[0].completed_at).not.toBeNull();
  });

  test('a non-participant confirmation is refused 403 and leaves no success record', async () => {
    const cid = `mt01w3-intruder-${RUN}`;
    const intruder = await registerAndLogin(INTRUDER);
    const res = await request(app)
      .post(`/api/bookings/${completionBookingId}/confirm-completion`)
      .set('Cookie', intruder.cookie)
      .set('X-Correlation-Id', cid)
      .send();
    expect(res.status).toBe(403);
    expect(
      auditRecords().filter((r) => r.correlationId === cid && r.outcome === 'success')
    ).toEqual([]);
    // The refusal is still traceable: the error line carries the correlation ID and status.
    const errs = records().filter((r) => r.event === 'request_error' && r.correlationId === cid);
    expect(errs).toHaveLength(1);
    expect(errs[0].status).toBe(403);
  });
});

// =============================================================================================
// FR-02 / FR-03 media attachment audit records
// =============================================================================================
describe('MT-01 — media attach / delete-mark are audited with IDs only', () => {
  let mediaId;
  const ATTACH_CID = `mt01w3-media-${RUN}`;
  const MEDIADEL_CID = `mt01w3-mediadel-${RUN}`;

  test('POST /api/media audits media.attached with the request correlation ID', async () => {
    const target = await request(app)
      .post('/api/media/uploads')
      .set('Cookie', hostCookie)
      .send({ kind: 'listing', contentType: 'image/jpeg', sizeBytes: 4096 });
    expect(target.status).toBe(200);
    expect(target.body.storageKey).toMatch(mediaUrls.KEY_PATTERN);

    const res = await request(app)
      .post('/api/media')
      .set('Cookie', hostCookie)
      .set('X-Correlation-Id', ATTACH_CID)
      .send({
        storageKey: target.body.storageKey,
        kind: 'listing',
        entityId: listingId,
        contentType: 'image/jpeg',
        sizeBytes: 4096,
      });
    expect(res.status).toBe(201);
    mediaId = res.body.media.id;

    const [rec] = auditsFor('media.attached', ATTACH_CID);
    expect(rec).toBeDefined();
    expect(rec.outcome).toBe('success');
    expect(rec.actorUserId).toBe(hostId);
    expect(rec.entityType).toBe('media');
    expect(rec.entityId).toBe(mediaId);
    expect(rec.attachedTo).toBe(listingId);
  });

  test('DELETE /api/media/:id audits media.delete_marked', async () => {
    const res = await request(app)
      .delete(`/api/media/${mediaId}`)
      .set('Cookie', hostCookie)
      .set('X-Correlation-Id', MEDIADEL_CID)
      .send();
    expect(res.status).toBe(204);

    const [rec] = auditsFor('media.delete_marked', MEDIADEL_CID);
    expect(rec).toBeDefined();
    expect(rec.entityId).toBe(mediaId);
    expect(rec.actorUserId).toBe(hostId);
  });
});

// =============================================================================================
// Worker-initiated audit records (no HTTP request behind them)
// =============================================================================================
describe('MT-01 — worker-initiated transitions stay traceable', () => {
  test('booking.promote runs and its audit/log lines carry the originating correlation ID', async () => {
    const cid = `mt01w3-promote-${RUN}`;
    // A fresh listing on its own LA day, approved, booked, then made due.
    const listing = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send(listingBody(daysOut(20), { title: 'MT01 Wave3 Promote Probe' }));
    expect(listing.status).toBe(201);
    const promoteListingId = listing.body.listing.id;
    await query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [
      promoteListingId,
    ]);

    const booking = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .set('X-Correlation-Id', cid)
      .send({ listingId: promoteListingId });
    expect(booking.status).toBe(201);
    const promoteBookingId = booking.body.booking.id;

    // Make the promotion due: the meal starts now, the job is available now.
    await query(`UPDATE listings SET scheduled_start = now() WHERE id = $1`, [promoteListingId]);
    await query(
      `UPDATE outbox_jobs SET available_at = now() - interval '1 minute'
       WHERE type = 'booking.promote' AND payload->>'bookingId' = $1`,
      [promoteBookingId]
    );

    const registry = loadHandlers({ log: recLogger });
    // Drain until THIS booking has left 'pending' (see ./support.js for the F-01 rationale).
    await drainOutboxUntil({
      registry,
      log: recLogger,
      isDone: async () => {
        const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [
          promoteBookingId,
        ]);
        return rows[0].status !== 'pending';
      },
    });

    const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [promoteBookingId]);
    expect(rows[0].status).toBe('in_progress');

    const promoted = auditRecords().filter(
      (r) => r.event === 'booking.promoted' && r.entityId === promoteBookingId
    );
    expect(promoted).toHaveLength(1);
    // NFR-08: the worker line is traceable back to the request that created the booking.
    expect(promoted[0].correlationId).toBe(cid);
    // MTUT-W3-02 (re-verification 2026-08-17): MT-01's acceptance names an ACTOR on every audit
    // record. Round-1 measurement of this record's key set found no `actorUserId` at all:
    //   ["level","time","service","correlationId","jobId","jobType","attempt","audit",
    //    "event","outcome","entityType","entityId","msg"]
    // The repair makes the system actor explicit rather than absent. Asserted here so the
    // resolution is proven by a test, not by a fixer's report: the key must be PRESENT (pino
    // drops `undefined` but emits `null`), and `actor` must name the worker.
    expect(Object.keys(promoted[0])).toContain('actorUserId');
    expect(promoted[0].actorUserId).toBeNull();
    expect(promoted[0].actor).toBe('system:outbox');
    expect(promoted[0].jobType).toBe('booking.promote');
  });
});

// =============================================================================================
// FR-07 safety alerts (re-verification unit W3-RV-OBS-SAFETY) — the only flow that decrypts a
// THIRD PARTY's personal data (the emergency contact) on the worker path
// =============================================================================================
describe('MT-01 / FR-07 — safety alerts are audited', () => {
  beforeAll(async () => {
    ({ cookie: outsiderCookie } = await registerAndLogin(OUTSIDER));
    // The Moderator role must be granted BEFORE the session is minted: src/modules/auth/sessions.js
    // snapshots `roles` into the Redis session record at login, so a role granted afterwards is
    // invisible to req.auth until the next login (ADR-006 session design — not a defect, but it
    // makes the ordering here load-bearing).
    const modReg = await request(app).post('/api/auth/register').send(MODERATOR);
    expect(modReg.status).toBe(201);
    await query(
      `UPDATE users SET email_verified = true, roles = ARRAY['user','moderator'] WHERE id = $1`,
      [modReg.body.user.id]
    );
    const modLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: MODERATOR.email, password: MODERATOR.password });
    expect(modLogin.status).toBe(200);
    moderatorCookie = modLogin.headers['set-cookie'].join(';');

    // The guest files an emergency contact through the real profile surface, so the ciphertext
    // in users.emergency_contact_*_enc is written by production code, not by the test.
    const patch = await request(app)
      .patch('/api/users/me')
      .set('Cookie', guestCookie)
      .send({ emergencyContact: EMERGENCY });
    expect(patch.status).toBe(200);

    const listing = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send(
        listingBody(daysOut(3), {
          title: 'MT01 Safety Lane Cassoulet',
          addressLine1: SAFETY_STREET,
        })
      );
    expect(listing.status).toBe(201);
    safetyListingId = listing.body.listing.id;
    // FR-08 is wave 4: approve in the database so the FR-07 flow has a bookable listing.
    await query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [
      safetyListingId,
    ]);

    const booking = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .send({ listingId: safetyListingId });
    expect(booking.status).toBe(201);
    safetyBookingId = booking.body.booking.id;
  });

  test('POST /api/bookings/:id/safety-alerts (201) emits ONE complete audit record', async () => {
    const res = await request(app)
      .post(`/api/bookings/${safetyBookingId}/safety-alerts`)
      .set('Cookie', guestCookie)
      .set('X-Correlation-Id', RAISE_CID)
      .send({});
    expect(res.status).toBe(201);
    alertId = res.body.alert.id;
    expect(res.headers['x-correlation-id']).toBe(RAISE_CID);

    const recs = auditsFor('safety.alert_raised', RAISE_CID).filter((r) => r.outcome === 'success');
    expect(recs).toHaveLength(1);
    const [rec] = recs;
    expect(rec.actorUserId).toBe(guestId); // actor
    expect(rec.entityType).toBe('safety_alert'); // subject entity type
    expect(rec.entityId).toBe(alertId); // subject entity ID
    expect(rec.bookingId).toBe(safetyBookingId); // cause reconstruction
    expect(rec.listingId).toBe(safetyListingId);
    expect(rec.role).toBe('guest');
    expect(rec.level).toBe('info');
    expect(Number.isNaN(Date.parse(rec.time))).toBe(false); // timestamp

    // The record refers to the persisted row, not to an in-memory value.
    const { rows } = await query(
      'SELECT booking_id, raised_by, delivery_status FROM safety_alerts WHERE id = $1',
      [alertId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].booking_id).toBe(safetyBookingId);
    expect(rows[0].raised_by).toBe(guestId);
  });

  test('a non-participant alert is refused 403 and audited as a failure with a reason', async () => {
    const cid = `mt01w3-alertoutsider-${RUN}`;
    const res = await request(app)
      .post(`/api/bookings/${safetyBookingId}/safety-alerts`)
      .set('Cookie', outsiderCookie)
      .set('X-Correlation-Id', cid)
      .send({});
    expect(res.status).toBe(403);

    const failures = auditsFor('safety.alert_raised', cid);
    expect(failures).toHaveLength(1);
    expect(failures[0].outcome).toBe('failure');
    expect(failures[0].reason).toBe('NOT_PARTICIPANT');
    expect(failures[0].entityType).toBe('booking');
    expect(failures[0].entityId).toBe(safetyBookingId);
    // No success record and no extra alert row was created by the refusal.
    expect(
      auditRecords().filter((r) => r.correlationId === cid && r.outcome === 'success')
    ).toEqual([]);
    const { rows } = await query(
      'SELECT count(*)::int AS n FROM safety_alerts WHERE booking_id = $1',
      [safetyBookingId]
    );
    expect(rows[0].n).toBe(1);
  });

  test('the moderator queue is a Moderator-only surface, and its refusal is traceable', async () => {
    const denyCid = `mt01w3-queuedeny-${RUN}`;
    const denied = await request(app)
      .get('/api/moderation/alerts')
      .set('Cookie', guestCookie)
      .set('X-Correlation-Id', denyCid)
      .send();
    expect(denied.status).toBe(403);
    const errs = records().filter(
      (r) => r.event === 'request_error' && r.correlationId === denyCid
    );
    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs[0].status).toBe(403);

    const allowed = await request(app)
      .get('/api/moderation/alerts')
      .set('Cookie', moderatorCookie)
      .send();
    expect(allowed.status).toBe(200);
    const entry = allowed.body.alerts.find((a) => a.id === alertId);
    expect(entry).toBeDefined();
    // AB-08: the queue serves IDs and delivery state — never the raiser's or the contact's PII.
    const body = JSON.stringify(allowed.body);
    for (const secret of [
      EMERGENCY.email,
      EMERGENCY.name,
      EMERGENCY.phone,
      GUEST.email,
      GUEST.fullName,
      SAFETY_STREET,
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  test('the outbox row is stamped with the raising request correlation ID; payload is IDs only', async () => {
    const { rows } = await query(
      `SELECT id, type, status, correlation_id, payload
         FROM outbox_jobs
        WHERE type = 'safety.alert' AND payload->>'alertId' = $1`,
      [alertId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].correlation_id).toBe(RAISE_CID);
    expect(rows[0].status).toBe('pending');
    // ADR-003: IDs only — no address, no name, no email in the payload.
    expect(Object.keys(rows[0].payload).sort()).toEqual(['alertId', 'bookingId']);
    expect(rows[0].payload.alertId).toBe(alertId);
    expect(rows[0].payload.bookingId).toBe(safetyBookingId);
  });

  test('the worker log lines for that job carry the SAME correlation ID (both sides)', async () => {
    const registry = loadHandlers();
    // Drain until THIS alert has been processed (see ./support.js for the F-01 rationale —
    // that helper exists because THIS test intermitted under the old fixed 8-pass budget).
    await drainOutboxUntil({
      registry,
      log: recLogger,
      isDone: async () => {
        const { rows } = await query('SELECT delivery_status FROM safety_alerts WHERE id = $1', [
          alertId,
        ]);
        return rows[0].delivery_status !== 'pending';
      },
    });

    const { rows } = await query(
      'SELECT delivery_status, delivered_at FROM safety_alerts WHERE id = $1',
      [alertId]
    );
    expect(rows[0].delivery_status).toBe('delivered');
    expect(rows[0].delivered_at).not.toBeNull();

    // The worker's own audit record for the delivery, carrying the ORIGINATING request's ID.
    const delivered = auditsFor('safety.alert_delivered', RAISE_CID).filter(
      (r) => r.entityId === alertId
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].actorUserId).toBe(guestId);
    expect(delivered[0].bookingId).toBe(safetyBookingId);

    // …and the worker's delivery line for that job id. No line bearing this job's id may carry
    // a different correlation ID.
    const { rows: jobRows } = await query(
      `SELECT id, status FROM outbox_jobs WHERE type = 'safety.alert' AND payload->>'alertId' = $1`,
      [alertId]
    );
    expect(jobRows[0].status).toBe('delivered');
    const jobLines = records().filter((r) => r.jobId === jobRows[0].id);
    expect(jobLines.length).toBeGreaterThanOrEqual(1);
    for (const line of jobLines) {
      expect(line.correlationId).toBe(RAISE_CID);
    }
    expect(jobLines.some((r) => r.event === 'outbox_job_delivered')).toBe(true);
  });

  test('the NOTIFICATION_ATTEMPT rows are persisted and hold IDs only (ADR-011)', async () => {
    const { rows } = await query(
      `SELECT recipient_user_id, channel, template, params, status
         FROM notification_attempts
        WHERE params->>'alertId' = $1
        ORDER BY template ASC`,
      [alertId]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const emergency = rows.find((r) => r.template === 'safety-alert-emergency');
    expect(emergency).toBeDefined();
    expect(emergency.channel).toBe('email');
    expect(emergency.status).toBe('sent');
    expect(emergency.recipient_user_id).toBe(guestId);
    for (const row of rows) {
      const params = JSON.stringify(row.params);
      for (const secret of [EMERGENCY.email, EMERGENCY.name, EMERGENCY.phone, GUEST.email]) {
        expect(params).not.toContain(secret);
      }
    }
  });
});

// =============================================================================================
// Cause reconstruction and the SRS §3.4 PII register over this file's whole corpus
// =============================================================================================
describe('MT-01 — cause reconstruction and the SRS §3.4 PII register', () => {
  test('the cause chain is walkable from audit records alone', () => {
    const audits = auditRecords();
    const cancelled = audits.find(
      (r) => r.event === 'booking.cancelled' && r.entityId === bookingId && r.idempotent === false
    );
    expect(cancelled).toBeDefined();
    const created = audits.find(
      (r) => r.event === 'booking.created' && r.outcome === 'success' && r.entityId === bookingId
    );
    expect(created).toBeDefined();
    const listing = audits.find(
      (r) => r.event === 'listing.created' && r.entityId === created.listingId
    );
    expect(listing).toBeDefined();
    const hostReg = audits.find(
      (r) => r.event === 'user.registered' && r.entityId === listing.actorUserId
    );
    const guestReg = audits.find(
      (r) => r.event === 'user.registered' && r.entityId === created.actorUserId
    );
    expect(hostReg).toBeDefined();
    expect(guestReg).toBeDefined();
    // Chronology is consistent (records are sufficient to identify the cause — NFR-08).
    expect(Date.parse(cancelled.time)).toBeGreaterThanOrEqual(Date.parse(created.time));
    expect(Date.parse(created.time)).toBeGreaterThanOrEqual(Date.parse(listing.time));
  });

  test('captured log output holds user IDs only — no email, password, name, phone, address or postal code', () => {
    const blob = lines.join('\n');
    expect(lines.length).toBeGreaterThan(30); // the scan runs over a real corpus
    for (const identity of [HOST, GUEST, INTRUDER, OUTSIDER, MODERATOR]) {
      expect(blob).not.toContain(identity.email);
      expect(blob).not.toContain(identity.password);
      expect(blob).not.toContain(identity.fullName);
      expect(blob).not.toContain(identity.phone);
    }
    // The FR-07 emergency contact — a third party who never consented to appear in logs.
    expect(blob).not.toContain(EMERGENCY.email);
    expect(blob).not.toContain(EMERGENCY.name);
    expect(blob).not.toContain(EMERGENCY.phone);
    expect(blob).not.toContain('Xolotl'); // name fragments too
    expect(blob).not.toContain('Zizania');
    expect(blob).not.toContain('Pangolin');
    expect(blob).not.toContain('Quillfeather');
    expect(blob).not.toContain(STREET);
    expect(blob).not.toContain('Sagebrush');
    expect(blob).not.toContain(SAFETY_STREET);
    expect(blob).not.toContain('Windlass');
    expect(blob).not.toContain('92101'); // postal code is location identity too (ADR-010)
    expect(blob).not.toContain('mt01-lane.homeplate.invalid');
    const emailShaped = blob.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
    expect(emailShaped).toEqual([]);
    // The IDs logs SHOULD carry are all present.
    for (const id of [hostId, guestId, listingId, bookingId, alertId]) {
      expect(blob).toContain(id);
    }
  });
});
