// tests/it-adapters/it04-safety-delivery.test.js — IT-04 / FR-07: safety-alert delivery driven
// end to end through the REAL outbox worker (SRS §4.2) — enqueue (same transaction as the
// alert row) → pollOnce → handler → transport — for the happy path, the no-emergency-contact
// path, an injected provider outage with recovery, and budget exhaustion (dead letter).
//
// Per ADR-011 nothing here calls a live provider: the transport resolves to the deterministic
// mock, every send writes a §3.4 NOTIFICATION_ATTEMPT row, and the assertions are on those
// persisted rows and on safety_alerts.delivery_status — never on SendGrid's behaviour.
//
// Requirement traceability (SRS Appendix B):
//   FR-07 (TC-07, IT-04) — "persist the alert, notify the moderator, and attempt delivery to
//        the user's approved emergency-contact channel …; failed delivery shall be retried and
//        remain visible for review":
//          (a) every moderator gets a 'safety-alert-moderator' attempt row;
//          (b) the raising user's emergency contact gets the 'safety-alert-emergency' send —
//              and the address handed to the adapter is the CONTACT's, not the raiser's own
//              account email (a bug that would email the person in danger instead of help);
//          (c) success → delivery_status 'delivered'; no contact on file → 'no_channel'
//              (recorded, never retried); outage → 'retrying' with the outbox backing off,
//              and after the whole budget → 'failed' + dead-lettered job, STILL listed in
//              GET /api/moderation/alerts.
//   ADR-001/003 — the alert row and its outbox row commit together; nothing is delivered on
//        the request path. Redelivery is idempotent (RT-02): a delivered alert never sends
//        twice, and per-leg idempotency keys reuse their attempt rows.
//   NFR-09 — a provider outage defers the delivery (bounded retries, exponential backoff) and
//        never loses it; recovery completes the same alert.
'use strict';

// Fast resilience knobs for THIS FILE ONLY (Jest module registry is per-file; restored in
// afterAll so nothing leaks into a re-run in the same process).
process.env.ADAPTER_TIMEOUT_MS = '250';
process.env.ADAPTER_RETRY_MAX = '1';
process.env.ADAPTER_BACKOFF_BASE_MS = '10';

const request = require('supertest');

const config = require('../../src/config');
const { createApp } = require('../../src/app');
const { encrypt } = require('../../src/db/fieldCrypto');
const { UpstreamServiceError } = require('../../src/lib/errors');
const mockTransport = require('../../src/adapters/mockTransport');
const sendgrid = require('../../src/adapters/sendgrid');
const { loadHandlers } = require('../../src/outbox/dispatch');
const { pollOnce } = require('../../src/outbox/worker');
const safetyRepo = require('../../src/modules/safety/repo');
const sessions = require('../../src/modules/auth/sessions');
const dbh = require('../helpers/db');
const { withOnlyTheseDue } = require('../helpers/outboxScope');
const { closeTestRedis } = require('../helpers/redis');

const EMERGENCY_TEMPLATE = 'safety-alert-emergency';
const MODERATOR_TEMPLATE = 'safety-alert-moderator';
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const quietLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() {
    return this;
  },
};

let registry;
let app;
let listing;
let host;

beforeAll(async () => {
  expect(config.isTest).toBe(true); // mock adapters only in the suite (ADR-011)
  registry = loadHandlers({ log: quietLog });
  app = createApp();
  host = await dbh.makeUser({ can_publish_listing: true });
  listing = await dbh.makeListing({
    host_id: host.id,
    moderation_status: 'approved',
    seat_capacity: 8,
    seats_remaining: 8,
  });
  await drainDue(); // start from an empty queue: other lanes leave jobs behind
});

beforeEach(() => {
  mockTransport.reset();
  jest.restoreAllMocks();
});

afterAll(async () => {
  delete process.env.ADAPTER_TIMEOUT_MS;
  delete process.env.ADAPTER_RETRY_MAX;
  delete process.env.ADAPTER_BACKOFF_BASE_MS;
  jest.restoreAllMocks();
  mockTransport.reset();
  await dbh.closeDb();
  await closeTestRedis();
});

// ---- helpers ---------------------------------------------------------------------------------

/** Drain every currently-due job (retried jobs back off into the future and drop out). */
async function drainDue(options = {}) {
  let stats;
  do {
    stats = await pollOnce({ registry, log: quietLog, ...options });
  } while (stats.claimed > 0);
}

async function cookieFor(user) {
  const { token } = await sessions.createSession({ id: user.id, roles: user.roles || ['user'] });
  return `${config.auth.sessionCookieName}=${token}`;
}

/** Raise an alert through the real HTTP surface and return { alertId, job }. */
async function raiseAlert(booking, cookie) {
  const res = await request(app)
    .post(`/api/bookings/${booking.id}/safety-alerts`)
    .set('Cookie', cookie)
    .send({});
  expect(res.status).toBe(201);
  const alertId = res.body.alert.id;
  const { rows } = await dbh.query(
    `SELECT * FROM outbox_jobs WHERE type = 'safety.alert' AND payload->>'alertId' = $1`,
    [alertId]
  );
  expect(rows).toHaveLength(1);
  return { alertId, job: rows[0] };
}

async function alertRow(alertId) {
  const { rows } = await dbh.query('SELECT * FROM safety_alerts WHERE id = $1', [alertId]);
  return rows[0];
}

async function jobRow(id) {
  const { rows } = await dbh.query('SELECT * FROM outbox_jobs WHERE id = $1', [id]);
  return rows[0];
}

async function attemptsFor(alertId) {
  const { rows } = await dbh.query(
    `SELECT recipient_user_id, template, status, attempt_count, idempotency_key, last_error
       FROM notification_attempts
      WHERE params->>'alertId' = $1
      ORDER BY template ASC, created_at ASC`,
    [alertId]
  );
  return rows;
}

async function makeDue(jobId) {
  await dbh.query(`UPDATE outbox_jobs SET available_at = now() WHERE id = $1`, [jobId]);
}

/** A guest with (or without) an approved emergency contact + a booking on the shared listing. */
async function makeWorld({ contactEmail = null } = {}) {
  const guest = await dbh.makeUser(
    contactEmail ? { emergency_contact_email_enc: encrypt(contactEmail) } : {}
  );
  const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
  return { guest, booking, cookie: await cookieFor(guest) };
}

/** Fail only the emergency-contact send at the adapter boundary (a provider outage). */
function injectEmergencyOutage() {
  const real = mockTransport.adapter.deliver.bind(mockTransport.adapter);
  return jest.spyOn(mockTransport.adapter, 'deliver').mockImplementation(async (input) => {
    if (input.template === EMERGENCY_TEMPLATE) {
      throw new UpstreamServiceError('injected SendGrid outage', { upstreamStatus: 503 });
    }
    return real(input);
  });
}

// =============================================================================================
describe('IT-04 · happy path — moderator notified, emergency contact emailed, alert delivered', () => {
  test('the worker delivers both legs and the alert reaches delivery_status "delivered"', async () => {
    const contact = 'it04-happy-contact@relative.invalid';
    const { guest, booking, cookie } = await makeWorld({ contactEmail: contact });
    const { alertId, job } = await raiseAlert(booking, cookie);
    const moderatorIds = await safetyRepo.listModeratorIds();
    expect(moderatorIds.length).toBeGreaterThan(0); // the seeded base ships a moderator

    // Capture what the adapter is actually asked to deliver to (ADR-011: still the mock).
    const real = mockTransport.adapter.deliver.bind(mockTransport.adapter);
    const seen = [];
    jest.spyOn(mockTransport.adapter, 'deliver').mockImplementation(async (input) => {
      seen.push({ template: input.template, to: input.recipientEmail, userId: input.userId });
      return real(input);
    });

    await drainDue();

    expect((await jobRow(job.id)).status).toBe('delivered');
    const alert = await alertRow(alertId);
    expect(alert.delivery_status).toBe('delivered');
    expect(alert.delivered_at).not.toBeNull();

    // (a) one moderator attempt row per moderator, (b) one emergency row for the raiser.
    const attempts = await attemptsFor(alertId);
    const moderatorRows = attempts.filter((a) => a.template === MODERATOR_TEMPLATE);
    const emergencyRows = attempts.filter((a) => a.template === EMERGENCY_TEMPLATE);
    expect(moderatorRows.map((r) => r.recipient_user_id).sort()).toEqual([...moderatorIds].sort());
    expect(moderatorRows.every((r) => r.status === 'sent')).toBe(true);
    expect(emergencyRows).toHaveLength(1);
    expect(emergencyRows[0]).toMatchObject({
      recipient_user_id: guest.id, // §3.4: rows carry the USER id, never the contact address
      status: 'sent',
      idempotency_key: `safety.alert:${alertId}:emergency`,
    });
    expect(JSON.stringify(attempts)).not.toMatch(EMAIL_SHAPE);

    // The emergency mail went to the CONTACT, not to the person raising the alert.
    const emergency = seen.find((s) => s.template === EMERGENCY_TEMPLATE);
    expect(emergency.to).toBe(contact);
    expect(emergency.to).not.toBe(guest.email);
    expect(emergency.userId).toBe(guest.id);
    // The rendered subject is a real registry entry, not the neutral fallback (ADR-011).
    expect(sendgrid.EMAIL_SUBJECTS[EMERGENCY_TEMPLATE]).toBeTruthy();
    expect(sendgrid.renderEmail(EMERGENCY_TEMPLATE, { alertId }).subject).toMatch(/safety alert/i);
  });

  test('redelivery of a delivered alert sends nothing again (RT-02 idempotence)', async () => {
    const { booking, cookie } = await makeWorld({ contactEmail: 'it04-redeliver@kin.invalid' });
    const { alertId, job } = await raiseAlert(booking, cookie);
    await drainDue();
    const before = await attemptsFor(alertId);
    expect((await alertRow(alertId)).delivery_status).toBe('delivered');

    // Requeue the very same job (operator action / crash-redelivery) and run it again.
    await dbh.query(
      `UPDATE outbox_jobs SET status = 'pending', available_at = now(), delivered_at = NULL
        WHERE id = $1`,
      [job.id]
    );
    mockTransport.reset();
    // F-01 determinism: scoped — a foreign row drained here would deliver through the same
    // mock transport and break the zero-deliveries assertion below.
    await withOnlyTheseDue([job.id], () => drainDue());

    expect((await jobRow(job.id)).status).toBe('delivered');
    expect(mockTransport.deliveries()).toHaveLength(0); // nothing left the process a second time
    expect(await attemptsFor(alertId)).toEqual(before); // and no row moved
  });
});

// =============================================================================================
describe('IT-04 · no approved emergency contact — recorded as no_channel, never retried', () => {
  test('the moderator notice still succeeds and the alert ends "no_channel"', async () => {
    const { guest, booking, cookie } = await makeWorld(); // no emergency contact on file
    const { alertId, job } = await raiseAlert(booking, cookie);

    await drainDue();

    expect((await jobRow(job.id)).status).toBe('delivered'); // finished cleanly, not retried
    expect((await alertRow(alertId)).delivery_status).toBe('no_channel');

    const attempts = await attemptsFor(alertId);
    const emergency = attempts.filter((a) => a.template === EMERGENCY_TEMPLATE);
    expect(emergency).toHaveLength(1);
    expect(emergency[0]).toMatchObject({
      recipient_user_id: guest.id,
      status: 'no_channel',
      attempt_count: 0, // nothing was ever handed to a provider
    });
    expect(emergency[0].last_error).toMatch(/no emergency contact/i);
    // Absorbed from it-w3rv-reverify (IT-F2 re-verification): the moderator notice must be
    // SENT even when the emergency-contact leg has no channel — "not failed" alone would let a
    // silently-skipped moderator notice pass.
    const moderatorRows = attempts.filter((a) => a.template === MODERATOR_TEMPLATE);
    expect(moderatorRows.length).toBeGreaterThan(0);
    expect(moderatorRows.every((r) => r.status === 'sent')).toBe(true);
    expect(attempts.every((a) => a.status !== 'failed')).toBe(true);
  });
});

// =============================================================================================
describe('IT-04 · provider outage — retried, visible throughout, completed on recovery (NFR-09)', () => {
  test('an injected outage leaves the alert "retrying", the job backed off, and the queue listing intact', async () => {
    const { booking, cookie } = await makeWorld({ contactEmail: 'it04-outage@kin.invalid' });
    const { alertId, job } = await raiseAlert(booking, cookie);
    const moderator = await dbh.makeUser({ roles: ['user', 'moderator'] });
    const moderatorCookie = await cookieFor(moderator);

    const spy = injectEmergencyOutage();
    // F-01 determinism: scope the pass so THIS job is claimed in a single poll regardless of
    // what sibling suites left pending ahead of it in the shared table.
    await withOnlyTheseDue([job.id], () => pollOnce({ registry, log: quietLog }));

    const retried = await jobRow(job.id);
    expect(retried.status).toBe('pending'); // deferred, never dropped
    expect(retried.attempt_count).toBe(1);
    expect(retried.last_error).toMatch(/emergency-contact delivery failed/i);
    expect(new Date(retried.available_at).getTime()).toBeGreaterThan(Date.now() - 50); // backed off

    expect((await alertRow(alertId)).delivery_status).toBe('retrying');
    const failedAttempt = (await attemptsFor(alertId)).find(
      (a) => a.template === EMERGENCY_TEMPLATE
    );
    expect(failedAttempt.status).toBe('failed');
    expect(failedAttempt.attempt_count).toBe(Number(process.env.ADAPTER_RETRY_MAX) + 1);

    // FR-07 "remain visible for review" — still in the moderator queue while it retries.
    const queue = await request(app)
      .get('/api/moderation/alerts?status=retrying&pageSize=100')
      .set('Cookie', moderatorCookie);
    expect(queue.status).toBe(200);
    expect(queue.body.alerts.map((a) => a.id)).toContain(alertId);

    // Recovery: the SAME alert completes, reusing its attempt row (no duplicate send).
    spy.mockRestore();
    await makeDue(job.id);
    await drainDue();

    expect((await jobRow(job.id)).status).toBe('delivered');
    expect((await alertRow(alertId)).delivery_status).toBe('delivered');
    const emergency = (await attemptsFor(alertId)).filter((a) => a.template === EMERGENCY_TEMPLATE);
    expect(emergency).toHaveLength(1); // same row resumed, never a second one
    expect(emergency[0].status).toBe('sent');
  });

  test('a permanent outage exhausts the budget: job dead-lettered, alert "failed", still listed', async () => {
    const { booking, cookie } = await makeWorld({ contactEmail: 'it04-dead@kin.invalid' });
    const { alertId, job } = await raiseAlert(booking, cookie);
    const moderator = await dbh.makeUser({ roles: ['user', 'moderator'] });
    const moderatorCookie = await cookieFor(moderator);

    injectEmergencyOutage();
    // F-01 determinism: scoped — makeDue() re-dates OUR row to now(), the NEWEST of the due
    // rows, so unscoped passes would hand the claim slots to older foreign rows first.
    await withOnlyTheseDue([job.id], async () => {
      for (let i = 0; i < config.outbox.maxAttempts; i += 1) {
        await makeDue(job.id);
        await pollOnce({ registry, log: quietLog });
      }
    });

    const dead = await jobRow(job.id);
    expect(dead.status).toBe('dead');
    expect(dead.attempt_count).toBe(config.outbox.maxAttempts);
    expect(dead.last_error).toMatch(/emergency-contact delivery failed/i);

    // The alert is terminal-failed but NOT hidden: a human must still see it (FR-07).
    expect((await alertRow(alertId)).delivery_status).toBe('failed');
    const queue = await request(app)
      .get('/api/moderation/alerts?pageSize=100')
      .set('Cookie', moderatorCookie);
    expect(queue.status).toBe(200);
    const entry = queue.body.alerts.find((a) => a.id === alertId);
    expect(entry).toBeDefined();
    expect(entry.deliveryStatus).toBe('failed');
  });
});
