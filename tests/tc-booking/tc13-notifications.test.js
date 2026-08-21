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
const sendgrid = require('../../src/adapters/sendgrid');
const { withOnlyTheseDue } = require('../helpers/outboxScope');
const { runJobs } = require('../helpers/outboxDirect');

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

// withOnlyTheseDue (imported above) scopes each worker pass to rows this file created — see
// tests/helpers/outboxScope.js for the TCBV2-01 finding (foreign pending rows win the claim
// slots, and a drained-then-failed foreign job becomes due again within this file's own run)
// that its parking exists to handle.

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
  test('ADR-011: push channel is gated off by default and email rides the mock transport in this suite', () => {
    expect(config.notifications.push.enabled).toBe(false);
    expect(config.notifications.transport).toBe('mock'); // dev/test transport (ADR-011)
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

// ----------------------------------------------------------------------------------------------
// FR-13 merged from the wave-3 re-verification files (tcb-w3-reverify /
// tcbv2-independent-reverify): the status-TRANSITION notifications, the transaction evidence,
// the ADR-003 payload audit and the ADR-011 template-vocabulary audit.
// ----------------------------------------------------------------------------------------------

/** FR-09-eligible host: guest attributes + complete host profile + host agreement. */
async function makeEligibleHost() {
  const { makeHostProfile } = require('../helpers/db');
  const host = await makeUser({ can_publish_listing: true, phone_enc: 'enc:v1:tc13-fixture' });
  await makeHostProfile({ user_id: host.id });
  return host;
}

async function promoteJobsFor(bookingId) {
  const { rows } = await query(
    `SELECT * FROM outbox_jobs WHERE type = 'booking.promote' AND payload->>'bookingId' = $1
      ORDER BY id`,
    [bookingId]
  );
  return rows;
}

describe('FR-13 — status transitions notify, transactionally, and the request path never touches the transport', () => {
  afterEach(() => {
    mockTransport.reset();
  });

  test("TCB-W3-03 (fixed): promotion writes 'started' notify.booking rows for guest AND host, in ONE transaction", async () => {
    // FR-13 says "created, cancelled, OR CHANGES STATUS". §3.4 gives the lifecycle
    // pending → in_progress → completed. This test used to PIN the gap (the automatic
    // promotion had no event and enqueued nothing); TCB-W3-03 closed it, so it now asserts
    // the requirement: promotion writes EVENTS.STARTED for the guest AND the host, in the
    // SAME transaction as the status change (ADR-001/003 — no dual write). The promote
    // handler runs DIRECTLY (tests/helpers/outboxDirect.js) so the worker's claim UPDATE
    // cannot rewrite the started rows' xmin and destroy the same-transaction evidence.
    const host = await makeEligibleHost();
    const listing = await makeApprovedListing({
      host_id: host.id,
      seat_capacity: 3,
      seats_remaining: 3,
    });
    const guest = await makeGuest();
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId: listing.id });
    expect(res.status).toBe(201);
    const bookingId = res.body.booking.id;

    const promotes = await promoteJobsFor(bookingId);
    expect(promotes).toHaveLength(1);
    await query(`UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`, [
      listing.id,
    ]);
    await runJobs(promotes);

    const { rows: booking } = await query('SELECT status, xmin FROM bookings WHERE id = $1', [
      bookingId,
    ]);
    expect(booking[0].status).toBe('in_progress');

    const notify = await notifyJobsFor(bookingId);
    const events = [...new Set(notify.map((j) => j.payload.event))].sort();
    expect(events).toEqual(['created', 'started']);

    // One row per AFFECTED USER — the guest and the listing's host, exactly once each.
    const startedRows = notify.filter((j) => j.payload.event === 'started');
    const recipients = startedRows.map((j) => j.payload.recipientUserId).sort();
    expect(recipients).toEqual([guest.id, host.id].sort());

    // ADR-001/003: the status change and its notification rows share ONE transaction.
    const { rows: xmins } = await query(
      `SELECT DISTINCT xmin::text AS x FROM outbox_jobs WHERE id = ANY($1::bigint[])`,
      [startedRows.map((r) => r.id)]
    );
    expect(xmins).toHaveLength(1);
    expect(xmins[0].x).toBe(String(booking[0].xmin));
  });

  test('every FR-13 status change notifies: created, started and completed, each to both participants', async () => {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const listing = await makeApprovedListing({
      host_id: host.id,
      seat_capacity: 4,
      seats_remaining: 4,
    });
    const guest = await makeGuest();
    const guestCookie = await cookieFor(guest);
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .send({ listingId: listing.id });
    expect(res.status).toBe(201);
    const bookingId = res.body.booking.id;

    // pending -> in_progress
    await query(`UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`, [
      listing.id,
    ]);
    await runJobs(await promoteJobsFor(bookingId));

    // in_progress -> completed (dual confirmation, FR-04)
    const first = await request(app)
      .post(`/api/bookings/${bookingId}/confirm-completion`)
      .set('Cookie', guestCookie)
      .send({});
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/bookings/${bookingId}/confirm-completion`)
      .set('Cookie', hostCookie)
      .send({});
    expect(second.status).toBe(200);

    const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    expect(rows[0].status).toBe('completed');

    const notify = await notifyJobsFor(bookingId);
    const events = [...new Set(notify.map((j) => j.payload.event))].sort();
    expect(events).toEqual(['completed', 'created', 'started']);
    for (const event of events) {
      const recipients = notify
        .filter((j) => j.payload.event === event)
        .map((j) => j.payload.recipientUserId)
        .sort();
      expect(recipients).toEqual([guest.id, host.id].sort());
    }
  });

  test('a booking row and its outbox rows commit in ONE transaction (ADR-001/003, positive xmin evidence)', async () => {
    // The rollback test above proves no dual write on the FAILURE path; this is the direct
    // evidence for the success path: every outbox row of the booking carries the booking
    // row's own transaction id.
    const host = await makeEligibleHost();
    const listing = await makeApprovedListing({
      host_id: host.id,
      seat_capacity: 4,
      seats_remaining: 4,
    });
    const guest = await makeGuest();
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId: listing.id });
    expect(res.status).toBe(201);
    const bookingId = res.body.booking.id;

    const { rows: b } = await query('SELECT xmin::text AS x FROM bookings WHERE id = $1', [
      bookingId,
    ]);
    const { rows: jobs } = await query(
      `SELECT DISTINCT xmin::text AS x FROM outbox_jobs WHERE payload->>'bookingId' = $1`,
      [bookingId]
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].x).toBe(b[0].x);
  });

  test('the request path never touches the transport, even with the adapter hard-DOWN and hard-HUNG', async () => {
    // The <500 ms bound elsewhere in this file catches an inline adapter that FAILS fast; a
    // HUNG adapter is the sneakier regression (an inline await would block the request for the
    // full per-attempt timeout). Both are injected together, and the direct evidence is added:
    // zero deliveries during the request.
    const host = await makeEligibleHost();
    const listing = await makeApprovedListing({
      host_id: host.id,
      seat_capacity: 4,
      seats_remaining: 4,
    });
    const guest = await makeGuest();
    const cookie = await cookieFor(guest);

    mockTransport.injectFailures(20);
    mockTransport.injectHangs(1);

    const started = Date.now();
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', cookie)
      .send({ listingId: listing.id });
    const elapsedMs = Date.now() - started;

    expect(res.status).toBe(201);
    // The adapter's per-attempt timeout is config.adapters.timeoutMs; if the request path
    // had called the transport inline, this would take at least that long.
    expect(elapsedMs).toBeLessThan(config.adapters.timeoutMs);
    // Nothing was delivered during the request.
    expect(mockTransport.deliveries()).toHaveLength(0);

    const bookingId = res.body.booking.id;
    const notify = await notifyJobsFor(bookingId);
    expect(notify).toHaveLength(2);
    expect(notify.map((j) => j.payload.recipientUserId).sort()).toEqual([guest.id, host.id].sort());
    // ADR-003: IDs only.
    for (const j of notify) {
      for (const value of Object.values(j.payload)) {
        expect(String(value)).not.toMatch(/@/);
      }
    }
  });

  test('ADR-003: EVERY persisted outbox payload of EVERY type carries IDs only (key-name audit)', async () => {
    // Beyond the email-shape scan above: fullName/emailAddress-style KEYS are the ADR-003
    // smell even when their values do not look like an address. Guarantee at least one row of
    // each wave-3 type exists regardless of suite order, so the audit can never pass
    // vacuously on an empty queue.
    const listing = await makeApprovedListing({ seat_capacity: 2, seats_remaining: 2 });
    const seedRes = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(await makeGuest()))
      .send({ listingId: listing.id });
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
        // *Id keys and opaque SHA-256 digests are not personal data.
        if (typeof value === 'string' && sha256Hex.test(value)) continue;
        if (piiKey.test(key) && !/id$/i.test(key)) offenders.push(`${row.type}: key "${key}"`);
      }
    }
    expect(offenders).toEqual([]);
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
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId: listing.id });
    expect(res.status).toBe(201);
    await runJobs(await notifyJobsFor(res.body.booking.id));

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
    expect([...sendgrid.BOOKING_EVENTS].sort()).toEqual([...lifecycle.EVENT_VALUES].sort());
  });

  test('ADR-001/003: no file under bookings/listings/hosts imports an adapter; search imports ONLY the ADR-005 maps read adapter', () => {
    const SRC = path.join(__dirname, '..', '..', 'src');
    const srcFiles = (dir = SRC, acc = []) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) srcFiles(full, acc);
        else if (entry.name.endsWith('.js')) acc.push(full);
      }
      return acc;
    };
    // Broader than the module-scope scan above: EVERY file in these modules, at ANY scope
    // (a lazy require inside a request handler is still a request-path adapter call).
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
});
