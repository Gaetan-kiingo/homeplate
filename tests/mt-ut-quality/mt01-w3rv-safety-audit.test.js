// tests/mt-ut-quality/mt01-w3rv-safety-audit.test.js — verifier lane "mt-ut-quality",
// re-verification unit W3-RV-OBS-SAFETY.
//
// The FR-07 safety module (src/modules/safety/*, src/outbox/handlers/safetyAlert.js) landed
// AFTER the round-1 mt-ut-quality lane ran (git diff 3136b91..bc27199), so no MT-01 evidence
// exists for it. Raising a safety alert is unambiguously one of NFR-08's "important actions",
// and it is the only wave-3 flow that decrypts a THIRD PARTY's personal data (the emergency
// contact) on the worker path — which makes it the sharpest possible test of the SRS §3.4 PII
// register rule "logs contain user IDs only".
//
// What this file proves, against the REAL app factory + the REAL outbox worker:
//   A. POST /api/bookings/:id/safety-alerts emits ONE structured audit record carrying event,
//      correlation ID, actor user ID, subject entity ID, outcome and an ISO timestamp; the
//      refusal paths (unknown booking, non-participant) are audited as failures with a
//      machine-readable reason and emit no success record.
//   B. The request's correlation ID is stamped on the outbox row written in the SAME
//      transaction, the payload is IDs only (ADR-003), and the SAME ID reappears verbatim on
//      the worker's audit/delivery lines for that job (both sides asserted — NFR-08).
//   C. The emergency-contact address, name and phone — decrypted inside the worker and handed
//      to the transport — appear in NO captured log line and in NO notification_attempts row.
//
// SQL is used only to prepare test-environment state (email verification, moderation approval,
// moderator role) and to READ rows for assertions — never to fake an assertion.
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const { loadHandlers } = require('../../src/outbox/dispatch');
const { pollOnce } = require('../../src/outbox/worker');
const { query, closeDb } = require('../helpers/db');
const { closeRedis } = require('../../src/db/redis');

// ---- recording logger: the exact bytes a log aggregator would receive -------------------------
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
function auditsFor(event, cid) {
  return auditRecords().filter((r) => r.event === event && r.correlationId === cid);
}

const RUN = `${process.pid}${Date.now()}`;

// Distinctive sentinel PII: every value below is unique enough that a substring sweep over the
// captured corpus cannot produce a false negative or a coincidental hit.
const EMERGENCY = {
  name: 'Perpetua Quillfeather-Nextofkin',
  phone: '+14155550977',
  email: `mt01rv.emergency.${RUN}@mt01-safety-lane.homeplate.invalid`,
};
const HOST = {
  email: `mt01rv.host.${RUN}@mt01-safety-lane.homeplate.invalid`,
  password: 'CorrectHorse!42rvh',
  fullName: 'Bartholomew Sandgrouse-Hostperson',
  phone: '+14155550911',
};
const GUEST = {
  email: `mt01rv.guest.${RUN}@mt01-safety-lane.homeplate.invalid`,
  password: 'CorrectHorse!42rvg',
  fullName: 'Clementine Wolverine-Guestperson',
  phone: '+14155550922',
};
const OUTSIDER = {
  email: `mt01rv.outsider.${RUN}@mt01-safety-lane.homeplate.invalid`,
  password: 'CorrectHorse!42rvo',
  fullName: 'Ignatius Basilisk-Outsider',
  phone: '+14155550933',
};
const MODERATOR = {
  email: `mt01rv.mod.${RUN}@mt01-safety-lane.homeplate.invalid`,
  password: 'CorrectHorse!42rvm',
  fullName: 'Rosalind Nightjar-Moderator',
  phone: '+14155550944',
};
const STREET = '2277 Windlass Hollow Byway';

let app;
let hostId;
let guestId;
let hostCookie;
let guestCookie;
let outsiderCookie;
let moderatorCookie;
let listingId;
let bookingId;
let alertId;

const RAISE_CID = `mt01rv-raise-${RUN}`;

async function registerAndLogin(identity) {
  const reg = await request(app).post('/api/auth/register').send(identity);
  expect(reg.status).toBe(201);
  const userId = reg.body.user.id;
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

  // The guest files an emergency contact through the real profile surface, so the ciphertext in
  // users.emergency_contact_*_enc is written by production code, not by the test.
  const patch = await request(app)
    .patch('/api/users/me')
    .set('Cookie', guestCookie)
    .send({ emergencyContact: EMERGENCY });
  expect(patch.status).toBe(200);

  await query(
    `INSERT INTO host_profiles (user_id, bio, host_agreement_accepted_at)
     VALUES ($1, $2, now())`,
    [hostId, 'MT-01 safety re-verification fixture host.']
  );

  const listing = await request(app)
    .post('/api/listings')
    .set('Cookie', hostCookie)
    .send({
      title: 'MT01 Safety Lane Cassoulet',
      description: 'Safety-alert audit-trail probe meal.',
      ingredients: ['beans', 'duck'],
      allergens: [],
      cuisine: 'french',
      scheduledStart: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      durationMinutes: 120,
      seatCapacity: 2,
      addressLine1: STREET,
      city: 'San Diego',
      region: 'CA',
      postalCode: '92101',
      country: 'US',
    });
  expect(listing.status).toBe(201);
  listingId = listing.body.listing.id;
  // FR-08 is wave 4: approve in the database so the FR-07 flow has a bookable listing.
  await query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [listingId]);

  const booking = await request(app)
    .post('/api/bookings')
    .set('Cookie', guestCookie)
    .send({ listingId });
  expect(booking.status).toBe(201);
  bookingId = booking.body.booking.id;
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

// =============================================================================================
// A. FR-07 / NFR-08 — raising an alert emits one complete structured audit record
// =============================================================================================
describe('MT-01 / FR-07 — safety alerts are audited', () => {
  test('POST /api/bookings/:id/safety-alerts (201) emits ONE complete audit record', async () => {
    const res = await request(app)
      .post(`/api/bookings/${bookingId}/safety-alerts`)
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
    expect(rec.bookingId).toBe(bookingId); // cause reconstruction
    expect(rec.listingId).toBe(listingId);
    expect(rec.role).toBe('guest');
    expect(rec.level).toBe('info');
    expect(Number.isNaN(Date.parse(rec.time))).toBe(false); // timestamp

    // The record refers to the persisted row, not to an in-memory value.
    const { rows } = await query(
      'SELECT booking_id, raised_by, delivery_status FROM safety_alerts WHERE id = $1',
      [alertId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].booking_id).toBe(bookingId);
    expect(rows[0].raised_by).toBe(guestId);
  });

  test('a non-participant alert is refused 403 and audited as a failure with a reason', async () => {
    const cid = `mt01rv-outsider-${RUN}`;
    const res = await request(app)
      .post(`/api/bookings/${bookingId}/safety-alerts`)
      .set('Cookie', outsiderCookie)
      .set('X-Correlation-Id', cid)
      .send({});
    expect(res.status).toBe(403);

    const failures = auditsFor('safety.alert_raised', cid);
    expect(failures).toHaveLength(1);
    expect(failures[0].outcome).toBe('failure');
    expect(failures[0].reason).toBe('NOT_PARTICIPANT');
    expect(failures[0].entityType).toBe('booking');
    expect(failures[0].entityId).toBe(bookingId);
    // No success record and no extra alert row was created by the refusal.
    expect(
      auditRecords().filter((r) => r.correlationId === cid && r.outcome === 'success')
    ).toEqual([]);
    const { rows } = await query(
      'SELECT count(*)::int AS n FROM safety_alerts WHERE booking_id = $1',
      [bookingId]
    );
    expect(rows[0].n).toBe(1);
  });

  test('the moderator queue is a Moderator-only surface, and its refusal is traceable', async () => {
    const denyCid = `mt01rv-queue-deny-${RUN}`;
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
      STREET,
    ]) {
      expect(body).not.toContain(secret);
    }
  });
});

// =============================================================================================
// B. NFR-08 — correlation ID: request → outbox row (same transaction) → worker log lines
// =============================================================================================
describe('MT-01 / NFR-08 — the FR-07 correlation ID survives the hand-off to the worker', () => {
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
    expect(rows[0].payload.bookingId).toBe(bookingId);
  });

  test('the worker log lines for that job carry the SAME correlation ID (both sides)', async () => {
    const registry = loadHandlers();
    // DETERMINISM (verification-report finding F-01): drain until THIS alert's job has been processed, or
    // until nothing anywhere is claimable — never on a fixed pass budget. pollOnce claims from
    // the WHOLE outbox table (`ORDER BY available_at, id LIMIT config.outbox.batchSize`, ten
    // rows a pass), so the number of passes this alert's job needs is a function of how many
    // pending rows SIBLING SUITES happened to leave behind earlier in the run — global state
    // this test does not own. The previous 8-pass budget covered at most 80 foreign rows and
    // failed the moment a run left more, which is exactly the intermittent observed on
    // 2026-08-17 (full-suite run A: delivered; run B, same lane, same code: still 'pending').
    // Jobs that back off get a future available_at and drop out of the claim, so the loop ends;
    // the cap below is a runaway guard, not a budget, and is never the reason the loop stops.
    const MAX_PASSES = 5000;
    let passes = 0;
    for (;;) {
      const stats = await pollOnce({ registry, log: recLogger });
      const { rows } = await query('SELECT delivery_status FROM safety_alerts WHERE id = $1', [
        alertId,
      ]);
      if (rows[0].delivery_status !== 'pending') break;
      if (stats.claimed === 0) break;
      passes += 1;
      if (passes >= MAX_PASSES) {
        throw new Error(
          `outbox drain did not reach safety alert ${alertId} in ${MAX_PASSES} passes — the ` +
            'worker is not making progress (this is a real defect, not a budget to raise)'
        );
      }
    }

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
    expect(delivered[0].bookingId).toBe(bookingId);

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
// C. SRS §3.4 PII register over the whole FR-07 corpus (the sharpest case: the worker DECRYPTS
//    a third party's address to deliver, so a careless log line would leak it)
// =============================================================================================
describe('MT-01 / SRS §3.4 — the FR-07 corpus holds user IDs only', () => {
  test('no emergency contact, participant email, name, phone or street address in any line', () => {
    const corpus = lines.join('\n');
    expect(lines.length).toBeGreaterThan(20);
    for (const secret of [
      EMERGENCY.email,
      EMERGENCY.name,
      EMERGENCY.phone,
      HOST.email,
      HOST.fullName,
      HOST.phone,
      HOST.password,
      GUEST.email,
      GUEST.fullName,
      GUEST.phone,
      GUEST.password,
      MODERATOR.email,
      STREET,
      '92101',
    ]) {
      expect(corpus).not.toContain(secret);
    }
    // Generic sweep: nothing email-shaped anywhere in the captured bytes.
    expect(corpus.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).toEqual([]);
    // …while the IDs an auditor needs ARE present.
    expect(corpus).toContain(guestId);
    expect(corpus).toContain(alertId);
    expect(corpus).toContain(bookingId);
  });
});
