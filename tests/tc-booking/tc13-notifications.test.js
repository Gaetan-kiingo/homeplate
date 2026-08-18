// tests/tc-booking/tc13-notifications.test.js — VERIFIER lane "tc-booking", TC-13 (FR-13,
// ADR-001/003/011).
//
// The bookings module (wave 3) is NOT built, so "booking created -> outbox row" is not yet
// testable. The MECHANISM FR-13 mandates IS built (registration -> 'email.verification'
// outbox row -> worker -> transport -> NOTIFICATION_ATTEMPT) and is verified here:
//  - business row + outbox row commit together; a provider failure neither rolls back nor
//    delays the committed request (201 well under 500 ms with failures queued);
//  - the worker records a NOTIFICATION_ATTEMPT per try, retries with backoff, and a
//    duplicate idempotency key never double-sends;
//  - outbox payloads carry IDs only (no email/phone/name shapes) — audited over ALL rows;
//  - ADR-011: push is gated OFF by default; a push send is refused AND recorded;
//  - no module route/service file imports src/adapters/* at module scope.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { query, withTransaction, closeDb, makeUser } = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const config = require('../../src/config');
const outboxModule = require('../../src/outbox/outbox');
const { pollOnce } = require('../../src/outbox/worker');
const { loadHandlers } = require('../../src/outbox/dispatch');
const transport = require('../../src/modules/notifications/transport');
const mockTransport = require('../../src/adapters/mockTransport');

let app;
let registry;
const PASSWORD = 'Tc13-strong-pw!42';
let emailSeq = 0;
function uniqueEmail() {
  emailSeq += 1;
  return `tc13-u${emailSeq}-${process.pid}-${Date.now()}@tcbooking.homeplate.invalid`;
}

async function drainOutbox() {
  // Deliver every currently-due pending job so later assertions see only OUR job.
  //
  // DETERMINISM (finding TCBV2-01): pollOnce() claims at most config.outbox.batchSize (10)
  // rows per pass from the WHOLE shared outbox table, which every suite in the run writes to
  // and which is reset only in globalSetup. A fixed 20-pass bound therefore drains at most
  // ~200 rows, so once earlier files have left more pending rows than that — which depends on
  // Jest's file ordering, not on this test — the drain silently returns with the queue still
  // full and "later assertions see only OUR job" stops being true. The loop is now bounded by
  // PROGRESS (it stops the moment a pass claims nothing) with a wall-clock ceiling, so it
  // cannot spin forever and cannot terminate early with work outstanding.
  const deadline = Date.now() + 20000;
  for (let i = 0; i < 2000; i += 1) {
    const stats = await pollOnce({ registry });
    if (stats.claimed === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `drainOutbox: still claiming jobs after 20 s (${i + 1} passes) — the shared outbox queue ` +
          'is not draining; assertions that assume an empty queue would be meaningless.'
      );
    }
  }
}

/**
 * Run `fn` (a worker pass) with ONLY `jobIds` due: every other pending row in the shared table
 * is parked an hour out for the duration and its original available_at restored afterwards.
 *
 * DETERMINISM (finding TCBV2-01, second half): draining the queue first is not by itself enough
 * to make "the next pass claims OUR job" true. A drained foreign job that FAILS is rescheduled
 * available_at = now() + backoffBaseMs (5 s), so it becomes due again inside this file's own
 * run and competes for the 10 claim slots of the very next pass — and the claim is ordered by
 * available_at, so those older rows win. Measured on this tree with foreign pending rows seeded
 * ahead of the file: 600 rows still passed, 3000 rows failed at the 'redelivery is exactly-once'
 * assertion with `Expected: 2 / Received: 0` because the booking's two notify.booking rows were
 * never claimed. Parking makes each pass depend only on rows the test itself created, so the
 * assertions below hold at any queue depth. The pass semantics are unchanged: exactly one
 * pollOnce per call site, claiming exactly the jobs named here.
 *
 * @param {Array<string|number>} jobIds outbox_jobs.id values this pass must be able to claim
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withOnlyTheseDue(jobIds, fn) {
  const ids = jobIds.map(String);
  const { rows: parked } = await query(
    `SELECT id, available_at FROM outbox_jobs
      WHERE status = 'pending' AND NOT (id = ANY($1::bigint[]))`,
    [ids]
  );
  await query(
    `UPDATE outbox_jobs SET available_at = now() + interval '1 hour'
      WHERE status = 'pending' AND NOT (id = ANY($1::bigint[]))`,
    [ids]
  );
  try {
    return await fn();
  } finally {
    for (const row of parked) {
      await query('UPDATE outbox_jobs SET available_at = $2 WHERE id = $1', [
        row.id,
        row.available_at,
      ]);
    }
  }
}

beforeAll(() => {
  app = createApp();
  registry = loadHandlers();
});

afterAll(async () => {
  mockTransport.reset();
  await closeDb();
  await closeTestRedis();
});

describe('FR-13 / TC-13 — deferred notification mechanism (wave-2 substrate)', () => {
  test('ADR-011: push channel is gated off by default (notifications.push.enabled === false)', () => {
    expect(config.notifications.push.enabled).toBe(false);
  });

  test('provider failure never rolls back or delays the committed business transaction', async () => {
    await drainOutbox();
    mockTransport.injectFailures(5, 'tc13: provider down');
    const email = uniqueEmail();

    const t0 = Date.now();
    const res = await request(app).post('/api/auth/register').send({ email, password: PASSWORD });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(201);
    expect(elapsed).toBeLessThan(500); // acceptance bound for the booking analog

    // Business row committed, outbox row pending — nothing rolled back.
    const { rows: users } = await query('SELECT id FROM users WHERE email = $1', [email]);
    expect(users).toHaveLength(1);
    const userId = users[0].id;
    const { rows: jobs } = await query(
      `SELECT * FROM outbox_jobs WHERE type = 'email.verification' AND payload->>'userId' = $1`,
      [userId]
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
    const jobId = jobs[0].id;

    // Worker hits the injected failure: job retried with backoff, attempt row recorded,
    // and the user row is UNTOUCHED. Scoped to OUR row (TCBV2-01) so a foreign job can neither
    // take this pass's claim slots nor eat one of the injected failures.
    await withOnlyTheseDue([jobId], () => pollOnce({ registry }));
    const { rows: afterFail } = await query('SELECT * FROM outbox_jobs WHERE id = $1', [jobId]);
    expect(afterFail[0].status).toBe('pending'); // retrying, not lost, not dead
    expect(afterFail[0].attempt_count).toBe(1);
    expect(new Date(afterFail[0].available_at).getTime()).toBeGreaterThan(Date.now() - 1000);
    expect(afterFail[0].last_error).toBeTruthy();

    const { rows: attempts } = await query(
      `SELECT * FROM notification_attempts WHERE recipient_user_id = $1 ORDER BY id`,
      [userId]
    );
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(['failed', 'retrying']).toContain(attempts[attempts.length - 1].status);

    const { rows: stillThere } = await query('SELECT id FROM users WHERE id = $1', [userId]);
    expect(stillThere).toHaveLength(1);

    // Recovery: clear failures, make the job due again, deliver exactly once.
    mockTransport.reset();
    await query('UPDATE outbox_jobs SET available_at = now() WHERE id = $1', [jobId]);
    await withOnlyTheseDue([jobId], () => pollOnce({ registry }));
    const { rows: delivered } = await query('SELECT * FROM outbox_jobs WHERE id = $1', [jobId]);
    expect(delivered[0].status).toBe('delivered');

    const { rows: finalAttempts } = await query(
      `SELECT * FROM notification_attempts WHERE recipient_user_id = $1 AND status = 'sent'`,
      [userId]
    );
    expect(finalAttempts).toHaveLength(1);
    expect(mockTransport.deliveries().length).toBeGreaterThanOrEqual(1);
  });

  test('duplicate idempotency key: re-enqueue is a no-op, delivery is exactly-once (RT-02)', async () => {
    const email = uniqueEmail();
    await request(app).post('/api/auth/register').send({ email, password: PASSWORD }).expect(201);
    const { rows: jobs } = await query(
      `SELECT o.* FROM outbox_jobs o JOIN users u ON o.payload->>'userId' = u.id::text
        WHERE u.email = $1`,
      [email]
    );
    expect(jobs).toHaveLength(1);
    const { dedupe_key: dedupeKey, type, payload } = jobs[0];

    const second = await withTransaction((client) =>
      outboxModule.enqueue(client, { type, payload, dedupeKey })
    );
    expect(second.deduped).toBe(true);
    const { rows: count } = await query(
      'SELECT count(*)::int AS c FROM outbox_jobs WHERE dedupe_key = $1',
      [dedupeKey]
    );
    expect(count[0].c).toBe(1);
  });

  test('ADR-003: enqueue rejects PII payloads, and NO persisted payload contains an email/phone shape', async () => {
    await expect(
      withTransaction((client) =>
        outboxModule.enqueue(client, {
          type: 'email.verification',
          payload: { userId: 'x', email: 'leak@example.com' },
        })
      )
    ).rejects.toMatchObject({ code: 'OUTBOX_PAYLOAD_PII' });

    const { rows } = await query('SELECT payload FROM outbox_jobs');
    const emailShape = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
    for (const row of rows) {
      expect(JSON.stringify(row.payload)).not.toMatch(emailShape);
    }
  });

  test('ADR-011: a push send under the default-false gate is refused and recorded as a failed attempt row', async () => {
    const user = await makeUser();
    const idempotencyKey = `tc13-push-${user.id}`;
    const result = await transport.send({
      userId: user.id,
      channel: 'push',
      template: 'booking.confirmed',
      params: { bookingId: '2b6a2f6e-0000-4000-8000-000000000001' },
      idempotencyKey,
    });
    expect(result.status).not.toBe('sent');
    const { rows } = await query('SELECT * FROM notification_attempts WHERE idempotency_key = $1', [
      idempotencyKey,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('push');
    expect(['failed', 'no_channel']).toContain(rows[0].status);
  });

  test('ADR-001/003: no src/modules/**/routes.js or service.js requires src/adapters/* at module scope', () => {
    const modulesDir = path.join(__dirname, '..', '..', 'src', 'modules');
    const offenders = [];
    for (const mod of fs.readdirSync(modulesDir)) {
      for (const name of ['routes.js', 'service.js']) {
        const file = path.join(modulesDir, mod, name);
        if (!fs.existsSync(file)) continue;
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        for (const line of lines) {
          // Module scope = top-level const/let/var declarations (column 0).
          if (/^(const|let|var)\b.*require\(['"][^'"]*adapters\//.test(line)) {
            offenders.push(`${mod}/${name}: ${line.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ----------------------------------------------------------------------------------------------
// FR-13 over the REAL booking flow (wave 3 built — replaces the wave-2 status probe)
// ----------------------------------------------------------------------------------------------

const sessions = require('../../src/modules/auth/sessions');
const lifecycle = require('../../src/modules/bookings/lifecycle');
const { createRegistry } = require('../../src/outbox/dispatch');
const notifyHandler = require('../../src/outbox/handlers/bookingNotifications');

const COOKIE = config.auth.sessionCookieName;

async function cookieFor(user) {
  const { token } = await sessions.createSession(user);
  return `${COOKIE}=${token}`;
}

async function makeGuest() {
  return makeUser({ phone_enc: 'enc:v1:tc13-fixture' });
}

async function makeApprovedListing(overrides = {}) {
  const { makeListing } = require('../helpers/db');
  return makeListing({ moderation_status: 'approved', ...overrides });
}

async function notifyJobsFor(bookingId) {
  const { rows } = await query(
    `SELECT * FROM outbox_jobs WHERE type = 'notify.booking' AND payload->>'bookingId' = $1
      ORDER BY id`,
    [bookingId]
  );
  return rows;
}

describe('FR-13 / TC-13 — booking notifications end to end (wave-3 acceptance)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockTransport.reset();
  });

  test('booking create writes exactly one notify.booking row per recipient (guest + host) in the SAME transaction, IDs only', async () => {
    const listing = await makeApprovedListing({ seat_capacity: 3, seats_remaining: 3 });
    const guest = await makeGuest();
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId: listing.id });
    expect(res.status).toBe(201);
    const bookingId = res.body.booking.id;

    const jobs = await notifyJobsFor(bookingId);
    const created = jobs.filter((j) => j.payload.event === 'created');
    expect(created).toHaveLength(2); // exactly one per affected recipient
    const recipients = created.map((j) => j.payload.recipientUserId).sort();
    expect(recipients).toEqual([guest.id, listing.host_id].sort());
    for (const job of created) {
      // IDs only — never an email/phone/name shape (ADR-003).
      expect(Object.keys(job.payload).sort()).toEqual(['bookingId', 'event', 'recipientUserId']);
      expect(JSON.stringify(job.payload)).not.toMatch(
        /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
      );
    }

    // The scheduled promotion job is enqueued alongside (build-plan §6.4).
    const { rows: promote } = await query(
      `SELECT * FROM outbox_jobs WHERE type = 'booking.promote' AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    expect(promote).toHaveLength(1);
    expect(new Date(promote[0].available_at).getTime()).toBe(
      new Date(listing.scheduled_start).getTime()
    );
  });

  test('ATOMICITY: a post-insert error rolls back BOTH the booking and its outbox rows (no dual write)', async () => {
    const listing = await makeApprovedListing({ seat_capacity: 3, seats_remaining: 3 });
    const guest = await makeGuest();
    // enqueuePromotion runs AFTER the booking insert and the notify enqueues, on the same
    // transaction client — forcing it to fail must erase every row of the transaction.
    jest
      .spyOn(lifecycle, 'enqueuePromotion')
      .mockRejectedValue(new Error('tc13: injected post-insert failure'));

    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId: listing.id });
    expect(res.status).toBeGreaterThanOrEqual(500);

    const { rows: bookings } = await query(
      'SELECT count(*)::int AS c FROM bookings WHERE listing_id = $1',
      [listing.id]
    );
    expect(bookings[0].c).toBe(0); // no booking committed…
    const { rows: jobs } = await query(
      `SELECT count(*)::int AS c FROM outbox_jobs
        WHERE type = 'notify.booking' AND payload->>'recipientUserId' = $1`,
      [guest.id]
    );
    expect(jobs[0].c).toBe(0); // …and no orphaned outbox row either
    const { rows: seats } = await query('SELECT seats_remaining FROM listings WHERE id = $1', [
      listing.id,
    ]);
    expect(seats[0].seats_remaining).toBe(3); // capacity rolled back with it
  });

  test('transport forced to fail: POST /api/bookings still 201 in under 500 ms; worker retries then delivers NOTIFICATION_ATTEMPT per recipient', async () => {
    await drainOutbox();
    const listing = await makeApprovedListing({ seat_capacity: 3, seats_remaining: 3 });
    const guest = await makeGuest();
    // Enough queued failures to exhaust the transport's own bounded retries for BOTH jobs.
    mockTransport.injectFailures(50, 'tc13: notification provider down');

    const t0 = Date.now();
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId: listing.id });
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(201);
    expect(elapsed).toBeLessThan(500); // provider failure neither rolls back nor delays
    const bookingId = res.body.booking.id;

    // The booking is committed regardless of the provider.
    const { rows: committed } = await query('SELECT status FROM bookings WHERE id = $1', [
      bookingId,
    ]);
    expect(committed[0].status).toBe('pending');

    // Worker pass 1: both notify jobs hit the injected failures → retrying, attempt rows.
    // Scoped to THIS booking's rows (TCBV2-01): one pass has 10 claim slots, and foreign rows
    // are older, so an unscoped pass claims them instead once the shared queue is deep.
    const registry = createRegistry([notifyHandler]);
    let jobs = await notifyJobsFor(bookingId);
    const notifyIds = jobs.map((j) => j.id);
    expect(notifyIds).toHaveLength(2);
    await withOnlyTheseDue(notifyIds, () => pollOnce({ registry }));
    jobs = await notifyJobsFor(bookingId);
    for (const job of jobs) {
      expect(job.status).toBe('pending'); // retried with backoff, not lost, not dead
      expect(job.attempt_count).toBe(1);
      expect(job.last_error).toBeTruthy();
    }
    const { rows: failedAttempts } = await query(
      `SELECT * FROM notification_attempts
        WHERE recipient_user_id IN ($1, $2) AND status IN ('failed', 'retrying')`,
      [guest.id, listing.host_id]
    );
    expect(failedAttempts.length).toBeGreaterThanOrEqual(2);

    // Recovery: clear failures, force due, deliver — exactly one 'sent' per recipient (RT-02).
    mockTransport.reset();
    await query(
      `UPDATE outbox_jobs SET available_at = now()
        WHERE type = 'notify.booking' AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    await withOnlyTheseDue(notifyIds, () => pollOnce({ registry }));
    jobs = await notifyJobsFor(bookingId);
    for (const job of jobs) expect(job.status).toBe('delivered');
    const { rows: sent } = await query(
      `SELECT recipient_user_id FROM notification_attempts
        WHERE recipient_user_id IN ($1, $2) AND status = 'sent'
          AND params->>'bookingId' = $3`,
      [guest.id, listing.host_id, bookingId]
    );
    const sentTo = sent.map((r) => r.recipient_user_id).sort();
    expect(sentTo).toEqual([guest.id, listing.host_id].sort());
  });

  test('redelivery is exactly-once: re-running the worker over delivered jobs sends nothing new (RT-02)', async () => {
    const listing = await makeApprovedListing({ seat_capacity: 2, seats_remaining: 2 });
    const guest = await makeGuest();
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId: listing.id });
    expect(res.status).toBe(201);
    const bookingId = res.body.booking.id;

    const registry = createRegistry([notifyHandler]);
    // Scoped to THIS booking's two notify rows (TCBV2-01): with a deep shared queue an
    // unscoped pass spends its 10 claim slots on older foreign rows and delivers nothing here,
    // which is exactly how this assertion failed under a seeded 3000-row queue.
    const notifyIds = (await notifyJobsFor(bookingId)).map((j) => j.id);
    expect(notifyIds).toHaveLength(2);
    await withOnlyTheseDue(notifyIds, () => pollOnce({ registry }));
    const countSent = async () => {
      const { rows } = await query(
        `SELECT count(*)::int AS c FROM notification_attempts
          WHERE status = 'sent' AND params->>'bookingId' = $1`,
        [bookingId]
      );
      return rows[0].c;
    };
    const afterFirst = await countSent();
    expect(afterFirst).toBe(2);

    // Force the delivered jobs due again as a crash-redelivery stand-in: the transport
    // idempotency key (== dedupe key) must make a second delivery a no-op.
    await query(
      `UPDATE outbox_jobs SET status = 'pending', available_at = now()
        WHERE type = 'notify.booking' AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    await withOnlyTheseDue(notifyIds, () => pollOnce({ registry }));
    expect(await countSent()).toBe(afterFirst); // no double-send
  });
});
