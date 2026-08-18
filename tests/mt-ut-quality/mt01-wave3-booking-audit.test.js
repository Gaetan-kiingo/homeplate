// tests/mt-ut-quality/mt01-wave3-booking-audit.test.js — verifier lane "mt-ut-quality".
//
// MT-01 (SRS §4.6) / NFR-08, wave-3 scope: of MT-01's four named actions, BOOKING CREATION
// and BOOKING CANCELLATION land in this wave (U3-BOOKINGS), with LISTING CREATION
// (U3-LISTINGS) as the fixture path — itself an "important action" whose audit record AB-03's
// acceptance requires ("listing creations are logged with host ID and local date").
// The MODERATION DECISION action remains wave 4 (U4-MODERATION) and is reported
// not_implemented by the lane's structured result — no probe is planted here so the wave-4
// landing does not trip this lane the way the wave-2 gap probes tripped this wave.
//
// What this file proves, end to end, against the REAL app factory + REAL outbox worker:
//   1. Booking create / cancel each emit ONE structured JSON audit record carrying event,
//      correlation ID, actor user ID, subject entity ID, outcome and timestamp (NFR-08).
//   2. The request's correlation ID propagates onto every outbox row the transaction wrote
//      AND into the worker's log lines for those jobs — same ID on both sides — including
//      on FAILING jobs (moderation.scan has no wave-3 handler; its retry line must still
//      carry the originating request's ID).
//   3. Outbox payloads and NOTIFICATION_ATTEMPT rows carry IDs only (ADR-003 / ADR-011).
//   4. Refusals are audited too (outcome 'failure' + machine reason) — AB-02's acceptance
//      ("every create/cancel writes an audit record so the pattern is reconstructable").
//   5. The whole captured log corpus contains user IDs only: no email, password, full name,
//      phone number, or street address (SRS §3.4 PII register; ADR-010-adjacent for the
//      host address).
//   6. The cause chain is reconstructable from audit records alone:
//      booking.cancelled → booking.created → listing.created → user.registered.
//
// Fixture note: email verification and moderation approval are flipped by direct SQL — the
// verification email flow has its own MT-01 coverage (mt01-log-completeness.test.js) and the
// moderation pipeline is wave 4; SQL here is test-environment state preparation, not a
// bypass of anything this file asserts on.
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const { loadHandlers } = require('../../src/outbox/dispatch');
const { pollOnce } = require('../../src/outbox/worker');
const { query, closeDb } = require('../helpers/db');
const { closeRedis } = require('../../src/db/redis');

// ---- recording logger (the exact bytes a log aggregator would receive) ----------------------
const lines = [];
const sink = {
  write(line) {
    lines.push(String(line));
  },
};
const recLogger = createLogger({ level: 'info', stream: sink });

function records() {
  return lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
function auditRecords() {
  return records().filter((r) => r.audit === true);
}

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
// Distinctive street marker: must never appear in any log line (SRS §3.4 / ADR-010).
const STREET = '742 Sagebrush Hollow Lane';

const LISTING_CID = `mt01w3-listing-${RUN}`;
const BOOKING_CID = `mt01w3-booking-${RUN}`;
const CANCEL_CID = `mt01w3-cancel-${RUN}`;
const REFUSE_CID = `mt01w3-refuse-${RUN}`;
const RECANCEL_CID = `mt01w3-recancel-${RUN}`;

let app;
let hostId;
let guestId;
let hostCookie;
let guestCookie;
let listingId;
let bookingId;

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

describe('MT-01 / NFR-08 / AB-03 — listing creation (fixture path) is audited and traceable', () => {
  test('POST /api/listings (201) emits one audit record with host ID + local date, no address', async () => {
    const scheduledStart = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .set('X-Correlation-Id', LISTING_CID)
      .send({
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
      });

    expect(res.status).toBe(201);
    listingId = res.body.listing.id;
    expect(listingId).toMatch(/^[0-9a-f-]{36}$/);

    const audits = auditRecords().filter(
      (r) => r.event === 'listing.created' && r.correlationId === LISTING_CID
    );
    expect(audits).toHaveLength(1);
    const rec = audits[0];
    expect(rec.outcome).toBe('success');
    expect(rec.actorUserId).toBe(hostId);
    expect(rec.entityType).toBe('listing');
    expect(rec.entityId).toBe(listingId);
    expect(typeof rec.localDate).toBe('string'); // AB-03: host ID + local date reviewable
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
});

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

    const audits = auditRecords().filter(
      (r) => r.event === 'booking.created' && r.correlationId === BOOKING_CID
    );
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
    // Drain until this booking's created-notifications are delivered (bounded; sibling
    // suites may have left their own due jobs in the shared test outbox).
    // DETERMINISM (verification-report F-01): a RUNAWAY GUARD, not a budget. pollOnce claims from the
    // whole outbox table oldest-first, ten rows a pass, so the passes this job needs depend
    // on how many rows sibling suites left behind — state this test does not own. The loop
    // is ended by the `stats.claimed === 0` break below (jobs that back off take a future
    // available_at and drop out of the claim), never by this number.
    for (let i = 0; i < 5000; i += 1) {
      const stats = await pollOnce({ registry, log: recLogger });
      const { rows } = await query(
        `SELECT count(*)::int AS n FROM outbox_jobs
         WHERE type = 'notify.booking' AND payload->>'bookingId' = $1
           AND payload->>'event' = 'created' AND status = 'delivered'`,
        [bookingId]
      );
      if (rows[0].n === 2) break;
      if (stats.claimed === 0) break;
    }

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

    const audits = auditRecords().filter(
      (r) => r.event === 'booking.created' && r.correlationId === REFUSE_CID
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('failure');
    expect(audits[0].reason).toBe('OWN_LISTING');
    expect(audits[0].actorUserId).toBe(hostId);
  });
});

describe('MT-01 / NFR-08 — booking cancellation is audited end to end', () => {
  test('POST /api/bookings/:id/cancel (200) emits one complete audit record; notify rows share its correlation ID', async () => {
    const res = await request(app)
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Cookie', guestCookie)
      .set('X-Correlation-Id', CANCEL_CID)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe('cancelled');

    const audits = auditRecords().filter(
      (r) => r.event === 'booking.cancelled' && r.correlationId === CANCEL_CID
    );
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
    const audits = auditRecords().filter(
      (r) => r.event === 'booking.cancelled' && r.correlationId === RECANCEL_CID
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].idempotent).toBe(true);

    const notify = await query(
      `SELECT count(*)::int AS n FROM outbox_jobs WHERE correlation_id = $1`,
      [RECANCEL_CID]
    );
    expect(notify.rows[0].n).toBe(0); // no duplicate notifications (FR-13/FR-14)
  });
});

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

  test('captured log output holds user IDs only — no email, password, name, phone, or street address', () => {
    const blob = lines.join('\n');
    expect(lines.length).toBeGreaterThan(20); // the scan runs over a real corpus
    for (const identity of [HOST, GUEST]) {
      expect(blob).not.toContain(identity.email);
      expect(blob).not.toContain(identity.password);
      expect(blob).not.toContain(identity.fullName);
      expect(blob).not.toContain(identity.phone);
    }
    expect(blob).not.toContain('Xolotl'); // name fragments too
    expect(blob).not.toContain('Zizania');
    expect(blob).not.toContain(STREET);
    expect(blob).not.toContain('Sagebrush');
    expect(blob).not.toContain('mt01-lane.homeplate.invalid');
    const emailShaped = blob.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
    expect(emailShaped).toEqual([]);
    // The IDs logs SHOULD carry are all present.
    for (const id of [hostId, guestId, listingId, bookingId]) {
      expect(blob).toContain(id);
    }
  });
});
