// tests/rt-lt-resilience/rt02-outbox.test.js — RT-02 (SRS §4.4; FR-10/FR-13; ADR-001/003/011).
//
// Verifier lane: outbox processing after a worker crash, duplicate-delivery idempotency,
// retry/backoff, and dead-letter handling — executed against the real PostgreSQL outbox,
// the real polling worker, the real handlers and the real notification transport (mock
// adapter per ADR-011, asserting on persisted NOTIFICATION_ATTEMPT rows).
//
// Coverage in this file, in order:
//   1. the generic outbox MECHANISM (crash recovery / SKIP LOCKED, enqueue dedupe,
//      retry/backoff/dead-letter/requeue, two concurrent workers) with synthetic job types;
//   2. the same RT-02 properties on the three handlers wave 3 added — notify.booking,
//      booking.promote (including the IT3-F1 early-delivery residual), listing.geocode;
//   3. the FR-10 TCB-W3-01 re-verification: the DELIVERED email carries a usable token.
'use strict';

const crypto = require('crypto');
const request = require('supertest');

const { createApp } = require('../../src/app');
const maps = require('../../src/adapters/maps');
const mockTransport = require('../../src/adapters/mockTransport');
const { renderEmail } = require('../../src/adapters/sendgrid');
const { NotFoundError, ServiceUnavailableError } = require('../../src/lib/errors');
const notificationsTransport = require('../../src/modules/notifications/transport');
const outbox = require('../../src/outbox/outbox');
const { pollOnce, claimBatch, CLAIM_SQL } = require('../../src/outbox/worker');
const { loadHandlers, createRegistry } = require('../../src/outbox/dispatch');
const { withTransaction } = require('../../src/db/tx');

const dbh = require('../helpers/db');
const rh = require('../helpers/redis');
const { quietLogger, sleep } = require('./helpers');
const w3 = require('./wave3');

const quiet = quietLogger();
let app;
let registry; // the real production handler registry (incl. email.verification)

async function enqueueJob(fields) {
  return withTransaction(async (client) => {
    const { job } = await outbox.enqueue(client, fields);
    return job;
  });
}

async function getJob(id) {
  const { rows } = await dbh.query(`SELECT * FROM outbox_jobs WHERE id = $1`, [id]);
  return rows[0];
}

async function makeDue(id) {
  await dbh.query(
    `UPDATE outbox_jobs SET available_at = now() - interval '1 second' WHERE id = $1`,
    [id]
  );
}

/** All jobs of one type whose payload key equals the given id, in insertion order. */
async function jobsFor(type, payloadKey, id) {
  const { rows } = await dbh.query(
    `SELECT * FROM outbox_jobs WHERE type = $1 AND payload->>($2::text) = $3 ORDER BY id`,
    [type, payloadKey, id]
  );
  return rows;
}

async function reopenJob(id) {
  await dbh.query(
    `UPDATE outbox_jobs SET status = 'pending', delivered_at = NULL, available_at = now()
     WHERE id = $1`,
    [id]
  );
}

/**
 * Mark every pending job of OTHER types delivered, so a subsequent pollOnce's stats describe
 * the rows under test alone (a booking write also enqueues notify jobs that would otherwise
 * ride along in claimed/delivered counters).
 */
async function silencePendingExcept(type) {
  await dbh.query(
    `UPDATE outbox_jobs SET status = 'delivered', delivered_at = now()
      WHERE status = 'pending' AND type <> $1`,
    [type]
  );
}

/** A real booking through the HTTP surface: host + approved listing + eligible guest. */
async function makeBookingViaApi() {
  const host = await w3.makeHost();
  const listing = await w3.makeApprovedListing({ host_id: host.id });
  const guest = await w3.makeGuest();
  const cookie = await w3.cookieFor(guest);
  const res = await request(app)
    .post('/api/bookings')
    .send({ listingId: listing.id })
    .set('Cookie', cookie);
  expect(res.status).toBe(201);
  return { host, listing, guest, cookie, bookingId: res.body.booking.id };
}

beforeAll(async () => {
  app = createApp({ logger: quiet });
  registry = loadHandlers({ log: quiet });
});

beforeEach(async () => {
  // Neutralize pending jobs left behind by earlier tests/files so claim/deliver counters are
  // deterministic, and start every case with a clean mock provider.
  mockTransport.reset();
  await w3.neutralizePendingJobs();
});

afterAll(async () => {
  mockTransport.reset();
  // ADRC2-01: this file's synthetic job types must not outlive it. outbox_jobs is shared by every
  // suite file in the run and is only reset in globalSetup, so the `rt02.*` rows left here —
  // {"entityId":"rt02-crash-1"}, {"entityId":"rt02-retry-1"} and six {"n":0..5} — were still in
  // the table when a later lane audited it, and non-id payloads are exactly what the ADR-003
  // audit reports as violations. Clean up after ourselves, as tests/unit/outbox.test.js already
  // does for its `test.*` rows.
  await dbh.query(`DELETE FROM outbox_jobs WHERE type LIKE 'rt02.%'`);
  await dbh.closeDb();
  await rh.closeTestRedis();
});

describe('RT-02 — crash recovery: a crashed worker releases its claim; the job is re-claimed and delivered exactly once', () => {
  test('claim is FOR UPDATE SKIP LOCKED held in an open transaction', () => {
    expect(CLAIM_SQL).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(CLAIM_SQL).toMatch(/status = 'pending'/);
  });

  test('backend termination mid-processing rolls the claim back; redelivery happens exactly once', async () => {
    let invocations = 0;
    const crashRegistry = createRegistry([
      {
        type: 'rt02.crash',
        handle: async () => {
          invocations += 1;
        },
      },
    ]);
    const job = await enqueueJob({ type: 'rt02.crash', payload: { entityId: 'rt02-crash-1' } });

    // Worker A claims the job and "crashes" while holding the row lock.
    const clientA = await dbh.getClient();
    // The terminated backend emits async 'error' events on this connection — expected in a
    // crash drill; swallow them so Jest does not treat the simulated crash as a test error.
    clientA.on('error', () => {});
    let pid;
    try {
      await clientA.query('BEGIN');
      const claimed = await claimBatch(clientA, { batchSize: 10 });
      expect(claimed.map((j) => j.id)).toContain(job.id);
      ({
        rows: [{ pid }],
      } = await clientA.query('SELECT pg_backend_pid() AS pid'));

      // While A holds the lock, a concurrent worker MUST NOT see the job (SKIP LOCKED).
      const statsWhileLocked = await pollOnce({ registry: crashRegistry, log: quiet });
      expect(statsWhileLocked.claimed).toBe(0);
      expect(invocations).toBe(0);

      // Crash: terminate worker A's backend — its transaction rolls back server-side.
      await dbh.query('SELECT pg_terminate_backend($1)', [pid]);
      await sleep(100);
    } finally {
      try {
        clientA.release(new Error('rt02: simulated crash — discard broken connection'));
      } catch {
        /* connection already destroyed */
      }
    }

    // The claim auto-released: the job is still pending with NO attempt burned.
    const afterCrash = await getJob(job.id);
    expect(afterCrash.status).toBe('pending');
    expect(afterCrash.attempt_count).toBe(0);

    // A healthy worker re-claims and delivers exactly once.
    const stats = await pollOnce({ registry: crashRegistry, log: quiet });
    expect(stats.delivered).toBe(1);
    expect(invocations).toBe(1);
    const delivered = await getJob(job.id);
    expect(delivered.status).toBe('delivered');
    expect(delivered.delivered_at).not.toBeNull();
  }, 20000);
});

describe('RT-02 — duplicate-delivery idempotency (dedupe key end-to-end through the real handler)', () => {
  test('duplicate enqueue is a no-op; redelivery after a lost commit does not double-send', async () => {
    const user = await dbh.makeUser();
    const tokenHash = crypto.createHash('sha256').update(`rt02-idem-${Date.now()}`).digest('hex');
    const dedupeKey = `rt02:email.verification:${tokenHash}`;

    const first = await withTransaction((c) =>
      outbox.enqueue(c, {
        type: 'email.verification',
        payload: { userId: user.id, tokenHash },
        dedupeKey,
      })
    );
    expect(first.deduped).toBe(false);

    // Idempotent enqueue: the same key again is a no-op returning the existing row.
    const second = await withTransaction((c) =>
      outbox.enqueue(c, {
        type: 'email.verification',
        payload: { userId: user.id, tokenHash },
        dedupeKey,
      })
    );
    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    const { rows: keyRows } = await dbh.query(
      `SELECT count(*)::int AS n FROM outbox_jobs WHERE dedupe_key = $1`,
      [dedupeKey]
    );
    expect(keyRows[0].n).toBe(1);

    // First delivery.
    const stats1 = await pollOnce({ registry, log: quiet });
    expect(stats1.delivered).toBe(1);
    expect(mockTransport.deliveries().filter((d) => d.userId === user.id)).toHaveLength(1);
    const { rows: attempts1 } = await dbh.query(
      `SELECT * FROM notification_attempts WHERE recipient_user_id = $1`,
      [user.id]
    );
    expect(attempts1).toHaveLength(1);
    expect(attempts1[0].status).toBe('sent');

    // Redelivery drill: simulate the crash-after-side-effect window (handler ran, but the
    // worker died before committing the 'delivered' status) by re-opening the job.
    await reopenJob(first.job.id);
    const stats2 = await pollOnce({ registry, log: quiet });
    expect(stats2.delivered).toBe(1); // job completes again…

    // …but the idempotency key made the side effect exactly-once:
    expect(mockTransport.deliveries().filter((d) => d.userId === user.id)).toHaveLength(1);
    const { rows: attempts2 } = await dbh.query(
      `SELECT * FROM notification_attempts WHERE recipient_user_id = $1`,
      [user.id]
    );
    expect(attempts2).toHaveLength(1);
    expect(attempts2[0].status).toBe('sent');
    expect(attempts2[0].attempt_count).toBe(attempts1[0].attempt_count); // no extra try burned
  }, 20000);
});

describe('RT-02 — retry with exponential backoff, dead-letter, requeue (NFR-09)', () => {
  test('failing job backs off exponentially, dead-letters at maxAttempts with its reason, and requeues', async () => {
    let fail = true;
    let invocations = 0;
    const retryRegistry = createRegistry([
      {
        type: 'rt02.retry',
        handle: async () => {
          invocations += 1;
          if (fail) throw new Error('rt02 injected provider outage');
        },
      },
    ]);
    const job = await enqueueJob({ type: 'rt02.retry', payload: { entityId: 'rt02-retry-1' } });

    const opts = {
      registry: retryRegistry,
      maxAttempts: 4,
      backoffBaseMs: 200,
      backoffMaxMs: 60000,
      log: quiet,
    };

    const delays = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const stats = await pollOnce(opts);
      expect(stats.retried).toBe(1);
      const row = await getJob(job.id);
      expect(row.status).toBe('pending'); // still queued between retries
      expect(row.attempt_count).toBe(attempt);
      expect(row.last_error).toContain('rt02 injected provider outage');
      // Backoff = available_at − updated_at (both stamped from the same transaction clock).
      const delayMs = new Date(row.available_at).getTime() - new Date(row.updated_at).getTime();
      delays.push(delayMs);
      await makeDue(job.id);
    }
    // Exponential: 200, 400, 800 (±25% tolerance for clock granularity).
    expect(delays[0]).toBeGreaterThanOrEqual(150);
    expect(delays[0]).toBeLessThanOrEqual(250);
    expect(delays[1] / delays[0]).toBeGreaterThanOrEqual(1.5);
    expect(delays[1] / delays[0]).toBeLessThanOrEqual(2.5);
    expect(delays[2] / delays[1]).toBeGreaterThanOrEqual(1.5);
    expect(delays[2] / delays[1]).toBeLessThanOrEqual(2.5);

    // Attempt 4 of 4: dead-letter with the failure reason, queryable.
    const statsDead = await pollOnce(opts);
    expect(statsDead.deadLettered).toBe(1);
    const dead = await getJob(job.id);
    expect(dead.status).toBe('dead');
    expect(dead.attempt_count).toBe(4);
    expect(dead.last_error).toContain('rt02 injected provider outage');
    expect(invocations).toBe(4);

    const deadLetters = await outbox.listDeadLetters({ limit: 100 });
    expect(deadLetters.map((j) => j.id)).toContain(job.id);

    // No further claims while dead.
    const statsAfterDead = await pollOnce(opts);
    expect(statsAfterDead.claimed).toBe(0);

    // Operator requeues after fixing the fault → fresh budget → delivered.
    const requeued = await outbox.requeueDeadLetter(job.id);
    expect(requeued).not.toBeNull();
    expect(requeued.status).toBe('pending');
    expect(requeued.attempt_count).toBe(0);
    fail = false;
    const statsFixed = await pollOnce(opts);
    expect(statsFixed.delivered).toBe(1);
    expect((await getJob(job.id)).status).toBe('delivered');
    expect(invocations).toBe(5);
  }, 30000);
});

describe('RT-02 — two concurrent workers never double-process a job', () => {
  test('6 jobs, 2 workers polling concurrently: every job handled exactly once', async () => {
    const handled = new Map(); // jobId -> count
    const concurrentRegistry = createRegistry([
      {
        type: 'rt02.concurrent',
        handle: async (payload, ctx) => {
          handled.set(ctx.jobId, (handled.get(ctx.jobId) || 0) + 1);
          await sleep(120); // hold the claim long enough for real overlap
        },
      },
    ]);
    const jobs = [];
    for (let i = 0; i < 6; i += 1) {
      jobs.push(await enqueueJob({ type: 'rt02.concurrent', payload: { n: i } }));
    }

    const [a, b] = await Promise.all([
      pollOnce({ registry: concurrentRegistry, batchSize: 3, log: quiet }),
      pollOnce({ registry: concurrentRegistry, batchSize: 3, log: quiet }),
    ]);
    // Drain any remainder (in case one worker raced ahead before the other claimed).
    let drained = a.delivered + b.delivered;
    while (drained < 6) {
      const s = await pollOnce({ registry: concurrentRegistry, batchSize: 3, log: quiet });
      if (s.claimed === 0) break;
      drained += s.delivered;
    }

    expect(handled.size).toBe(6);
    for (const [, count] of handled) expect(count).toBe(1); // never double-processed
    for (const job of jobs) {
      expect((await getJob(job.id)).status).toBe('delivered');
    }
  }, 30000);
});

describe('RT-02 wave-3 — notify.booking duplicate delivery is exactly-once (FR-13)', () => {
  test('a redelivered notify.booking job completes again but the send happens exactly once', async () => {
    const { guest, host, bookingId } = await makeBookingViaApi();

    const notifyJobs = await jobsFor('notify.booking', 'bookingId', bookingId);
    expect(notifyJobs).toHaveLength(2);
    // The enqueue-side dedupe key is the transport idempotency key (RT-02 contract).
    for (const job of notifyJobs) {
      expect(job.dedupe_key).toBe(
        `notify.booking:${bookingId}:created:${job.payload.recipientUserId}`
      );
    }

    const stats1 = await pollOnce({ registry, log: quiet });
    expect(stats1.delivered).toBe(2);
    expect(mockTransport.deliveries().filter((d) => d.userId === guest.id)).toHaveLength(1);
    expect(mockTransport.deliveries().filter((d) => d.userId === host.id)).toHaveLength(1);
    const { rows: attempts1 } = await dbh.query(
      `SELECT recipient_user_id, status, attempt_count FROM notification_attempts
        WHERE recipient_user_id = ANY($1::uuid[]) ORDER BY recipient_user_id`,
      [[guest.id, host.id]]
    );
    expect(attempts1).toHaveLength(2);

    // Crash-after-side-effect window: the handler ran but the 'delivered' commit was lost.
    for (const job of notifyJobs) await reopenJob(job.id);
    const stats2 = await pollOnce({ registry, log: quiet });
    expect(stats2.delivered).toBe(2); // the jobs complete again…

    // …but the side effect did not repeat: same delivery count, same attempt rows.
    expect(mockTransport.deliveries().filter((d) => d.userId === guest.id)).toHaveLength(1);
    expect(mockTransport.deliveries().filter((d) => d.userId === host.id)).toHaveLength(1);
    const { rows: attempts2 } = await dbh.query(
      `SELECT recipient_user_id, status, attempt_count FROM notification_attempts
        WHERE recipient_user_id = ANY($1::uuid[]) ORDER BY recipient_user_id`,
      [[guest.id, host.id]]
    );
    expect(attempts2).toEqual(attempts1);
  }, 30000);

  test('a notify.booking job dead-letters at the attempt cap with its reason, and requeues after the fix', async () => {
    const { bookingId } = await makeBookingViaApi();
    const notifyJobs = await jobsFor('notify.booking', 'bookingId', bookingId);
    expect(notifyJobs).toHaveLength(2);

    mockTransport.injectFailures(100000); // outage that outlives every retry budget
    const opts = { registry, maxAttempts: 3, backoffBaseMs: 50, backoffMaxMs: 1000, log: quiet };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const stats = await pollOnce(opts);
      expect(stats.retried).toBe(2);
      await dbh.query(`UPDATE outbox_jobs SET available_at = now() WHERE id = ANY($1::bigint[])`, [
        notifyJobs.map((j) => j.id),
      ]);
    }
    const statsDead = await pollOnce(opts);
    expect(statsDead.deadLettered).toBe(2);
    const deadRows = await jobsFor('notify.booking', 'bookingId', bookingId);
    for (const row of deadRows) {
      expect(row.status).toBe('dead');
      expect(row.attempt_count).toBe(3);
      expect(row.last_error).toMatch(/delivery failed/);
    }
    const deadLetters = await outbox.listDeadLetters({ limit: 200 });
    for (const row of deadRows) {
      expect(deadLetters.map((j) => j.id)).toContain(row.id);
    }

    // Operator requeues once the provider is fixed → fresh budget → delivered.
    mockTransport.reset();
    for (const row of deadRows) {
      const requeued = await outbox.requeueDeadLetter(row.id);
      expect(requeued.status).toBe('pending');
    }
    const statsFixed = await pollOnce(opts);
    expect(statsFixed.delivered).toBe(2);
  }, 30000);
});

describe('RT-02 wave-3 — booking.promote scheduling, idempotency and self-repair (FR-04/FR-12)', () => {
  test('the promote job is scheduled for scheduled_start, promotes when due, and a duplicate delivery no-ops', async () => {
    const { listing, bookingId } = await makeBookingViaApi();

    const [job] = await jobsFor('booking.promote', 'bookingId', bookingId);
    expect(job).toBeDefined();
    expect(job.status).toBe('pending');
    // Scheduled delivery: availableAt = the listing's scheduled_start (build-plan §6.4).
    expect(new Date(job.available_at).getTime()).toBe(new Date(listing.scheduled_start).getTime());

    // Silence the booking's notify jobs so the promote job's schedule is the only claimable.
    await silencePendingExcept('booking.promote');

    // Not due yet: a worker cycle must not touch it.
    const early = await pollOnce({ registry, log: quiet });
    expect(early.claimed).toBe(0);
    const { rows: still } = await dbh.query(`SELECT status FROM bookings WHERE id = $1`, [
      bookingId,
    ]);
    expect(still[0].status).toBe('pending');

    // The meal starts: move the listing's start into the past and make the job due.
    await dbh.query(
      `UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`,
      [listing.id]
    );
    await reopenJob(job.id);
    const dueStats = await pollOnce({ registry, log: quiet });
    expect(dueStats.delivered).toBe(1);
    const { rows: promoted } = await dbh.query(`SELECT status FROM bookings WHERE id = $1`, [
      bookingId,
    ]);
    expect(promoted[0].status).toBe('in_progress');

    // FR-13 (TCB-W3-03): the transition itself notified both participants, transactionally.
    const { rows: startedRows } = await dbh.query(
      `SELECT payload->>'recipientUserId' AS recipient FROM outbox_jobs
        WHERE type = 'notify.booking' AND payload->>'bookingId' = $1
          AND payload->>'event' = 'started'`,
      [bookingId]
    );
    expect(startedRows).toHaveLength(2);

    // Duplicate delivery after a lost commit: clean no-op, state unchanged. Silence the
    // promotion's own 'started' notify rows first (same reason as above) so the stats
    // describe the redelivered promote row alone.
    await silencePendingExcept('booking.promote');
    await reopenJob(job.id);
    const dupStats = await pollOnce({ registry, log: quiet });
    expect(dupStats.delivered).toBe(1);
    const { rows: after } = await dbh.query(
      `SELECT status, count(*) OVER () AS n FROM bookings WHERE id = $1`,
      [bookingId]
    );
    expect(after[0].status).toBe('in_progress');
  }, 30000);

  test('a cancelled booking is never promoted (no-op), and a start moved later re-enqueues for the new instant', async () => {
    // Case A: cancelled before due → no-op.
    const a = await makeBookingViaApi();
    const cancel = await request(app)
      .post(`/api/bookings/${a.bookingId}/cancel`)
      .send({})
      .set('Cookie', a.cookie);
    expect(cancel.status).toBe(200);
    const [jobA] = await jobsFor('booking.promote', 'bookingId', a.bookingId);
    await dbh.query(
      `UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`,
      [a.listing.id]
    );
    await w3.neutralizePendingJobs(); // silence the cancel's notify jobs for clean stats
    await reopenJob(jobA.id);
    const statsA = await pollOnce({ registry, log: quiet });
    expect(statsA.delivered).toBe(1); // job completes as a no-op, is not retried forever
    const { rows: cancelled } = await dbh.query(`SELECT status FROM bookings WHERE id = $1`, [
      a.bookingId,
    ]);
    expect(cancelled[0].status).toBe('cancelled'); // never promoted (RT-02 idempotency)

    // Case B: start moved LATER → the due job re-enqueues a fresh job for the new instant.
    const b = await makeBookingViaApi();
    const [jobB] = await jobsFor('booking.promote', 'bookingId', b.bookingId);
    const newStart = new Date(Date.now() + 3 * 3600 * 1000);
    await dbh.query(`UPDATE listings SET scheduled_start = $2 WHERE id = $1`, [
      b.listing.id,
      newStart,
    ]);
    await w3.neutralizePendingJobs();
    await reopenJob(jobB.id);
    const statsB = await pollOnce({ registry, log: quiet });
    expect(statsB.delivered).toBe(1);
    const { rows: stillPending } = await dbh.query(`SELECT status FROM bookings WHERE id = $1`, [
      b.bookingId,
    ]);
    expect(stillPending[0].status).toBe('pending'); // NOT promoted early
    const jobsB = await jobsFor('booking.promote', 'bookingId', b.bookingId);
    const fresh = jobsB.filter((j) => j.status === 'pending');
    expect(fresh).toHaveLength(1); // self-repaired schedule
    expect(new Date(fresh[0].available_at).getTime()).toBe(newStart.getTime());
  }, 30000);
});

// RT-02 / IT3-F1 regression: a 'booking.promote' job delivered EARLY while the listing's
// scheduled_start is UNCHANGED must not lose the promotion.
//
// Why this case and not the "start moved later" case covered just above: when the start moves,
// the re-enqueue's dedupe key ('booking.promote:<bookingId>:<startMs>') differs from the
// delivered row's key, so a fresh row is created and nothing is lost. The dangerous case is the
// start being UNCHANGED — the re-enqueue reproduces the delivered row's own key, ON CONFLICT
// (dedupe_key) DO NOTHING collapses onto the row the worker is about to mark 'delivered', and
// the booking would stay 'pending' forever (FR-04 completion then 409s for both parties).
//
// Reachable in production without anything exotic: available_at <= now() is evaluated by
// PostgreSQL while startsAt > Date.now() is evaluated by Node, so DB/app clock skew alone
// delivers the row early; an operator requeue of a dead-lettered promote row does the same.
//
// Requirement traceability: FR-04 (meal completion depends on the booking reaching
// 'in_progress'), FR-12/FR-13 (booking lifecycle deferred work), NFR-09 (deferred work is
// never silently lost), ADR-001/003 (outbox is the only deferred-work mechanism).
describe('RT-02 / IT3-F1 — an early promote delivery with an UNCHANGED start keeps the schedule', () => {
  test('the delivered row does not swallow its own re-enqueue; a live pending row survives and later promotes', async () => {
    const { listing, bookingId } = await makeBookingViaApi();
    const startsAt = new Date(listing.scheduled_start);
    expect(startsAt.getTime()).toBeGreaterThan(Date.now()); // future start, as seeded

    const before = await jobsFor('booking.promote', 'bookingId', bookingId);
    expect(before).toHaveLength(1);
    const originalJob = before[0];
    expect(new Date(originalJob.available_at).getTime()).toBe(startsAt.getTime());

    // Silence the booking's notify jobs so pollOnce stats describe the promote row alone.
    await silencePendingExcept('booking.promote');

    // THE SCENARIO: the row becomes due EARLY (clock skew / operator requeue) while the
    // listing's scheduled_start is left exactly as it was.
    await dbh.query(`UPDATE outbox_jobs SET available_at = now() WHERE id = $1`, [originalJob.id]);
    const { rows: unchanged } = await dbh.query(
      `SELECT scheduled_start FROM listings WHERE id = $1`,
      [listing.id]
    );
    expect(new Date(unchanged[0].scheduled_start).getTime()).toBe(startsAt.getTime());

    const stats = await pollOnce({ registry, log: quiet });
    expect(stats.claimed).toBe(1);
    expect(stats.delivered).toBe(1); // handled cleanly — not retried forever, not dead-lettered

    // The booking must NOT have been promoted early.
    const { rows: afterPoll } = await dbh.query(`SELECT status FROM bookings WHERE id = $1`, [
      bookingId,
    ]);
    expect(afterPoll[0].status).toBe('pending');

    // …and the schedule must have SURVIVED: exactly one live pending promote row, scheduled
    // for the same (unchanged) instant, and it is NOT the row that was just delivered.
    const after = await jobsFor('booking.promote', 'bookingId', bookingId);
    const pending = after.filter((j) => j.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(String(pending[0].id)).not.toBe(String(originalJob.id));
    expect(new Date(pending[0].available_at).getTime()).toBe(startsAt.getTime());

    // The surviving row really does promote when the meal actually starts.
    await dbh.query(
      `UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`,
      [listing.id]
    );
    await dbh.query(`UPDATE outbox_jobs SET available_at = now() WHERE id = $1`, [pending[0].id]);
    const dueStats = await pollOnce({ registry, log: quiet });
    expect(dueStats.delivered).toBe(1);
    const { rows: promoted } = await dbh.query(`SELECT status FROM bookings WHERE id = $1`, [
      bookingId,
    ]);
    expect(promoted[0].status).toBe('in_progress'); // FR-04 completion is now reachable
  }, 30000);

  test('repeated early deliveries never accumulate more than one live pending promote row', async () => {
    const { listing, bookingId } = await makeBookingViaApi();
    const startsAt = new Date(listing.scheduled_start);
    await silencePendingExcept('booking.promote');

    // Three successive early deliveries of whatever row is currently live.
    for (let i = 0; i < 3; i += 1) {
      const live = (await jobsFor('booking.promote', 'bookingId', bookingId)).filter(
        (j) => j.status === 'pending'
      );
      expect(live).toHaveLength(1); // invariant after every cycle
      await dbh.query(`UPDATE outbox_jobs SET available_at = now() WHERE id = $1`, [live[0].id]);
      const stats = await pollOnce({ registry, log: quiet });
      expect(stats.delivered).toBe(1);
      expect(stats.deadLettered).toBe(0);
    }

    const live = (await jobsFor('booking.promote', 'bookingId', bookingId)).filter(
      (j) => j.status === 'pending'
    );
    expect(live).toHaveLength(1);
    expect(new Date(live[0].available_at).getTime()).toBe(startsAt.getTime());
    const { rows: booking } = await dbh.query(`SELECT status FROM bookings WHERE id = $1`, [
      bookingId,
    ]);
    expect(booking[0].status).toBe('pending'); // still not promoted early
  }, 30000);
});

describe('RT-02 wave-3 — listing.geocode retry/backoff under a Maps outage; definitive answers complete (NFR-09)', () => {
  test('a Maps outage defers geocoding with backoff; recovery completes the SAME job and writes both precisions', async () => {
    const host = await w3.makeHost();
    const hostCookie = await w3.cookieFor(host);
    let mode = 'down';
    const restore = w3.patchFn(maps, 'geocode', async (address, opts) => {
      if (mode === 'down') {
        throw new ServiceUnavailableError('geocode outage drill', { code: 'MAPS_UNAVAILABLE' });
      }
      expect(opts).toEqual({ precision: 'exact' }); // worker asks for the exact projection
      return {
        lat: 32.71,
        lng: -117.16,
        areaLabel: 'Gaslamp Quarter, San Diego',
        degraded: false,
        source: 'live',
        precise: { lat: 32.7123456, lng: -117.1612345 },
      };
    });
    try {
      const res = await request(app)
        .post('/api/listings')
        .send({
          title: 'RT02 Geocode Drill Dinner',
          description: 'Listing whose geocode job rides out a Maps outage.',
          ingredients: ['soup'],
          scheduledStart: new Date(Date.now() + 21 * 24 * 3600 * 1000).toISOString(),
          durationMinutes: 90,
          seatCapacity: 4,
          addressLine1: '600 Retry Backoff Blvd',
          city: 'San Diego',
          region: 'CA',
        })
        .set('Cookie', hostCookie);
      expect(res.status).toBe(201); // the outage never blocks creation (ADR-005/NFR-09)
      const listingId = res.body.listing.id;

      const [job] = await jobsFor('listing.geocode', 'listingId', listingId);
      expect(job).toBeDefined();

      // Outage: the job retries with exponential backoff, stays queued, never dead here.
      const opts = {
        registry,
        maxAttempts: 5,
        backoffBaseMs: 200,
        backoffMaxMs: 60000,
        log: quiet,
      };
      const delays = [];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const stats = await pollOnce(opts);
        expect(stats.retried).toBeGreaterThanOrEqual(1); // (moderation.scan may ride along)
        const { rows } = await dbh.query(`SELECT * FROM outbox_jobs WHERE id = $1`, [job.id]);
        expect(rows[0].status).toBe('pending');
        expect(rows[0].attempt_count).toBe(attempt);
        expect(rows[0].last_error).toContain('geocode outage drill');
        delays.push(
          new Date(rows[0].available_at).getTime() - new Date(rows[0].updated_at).getTime()
        );
        await reopenJob(job.id);
      }
      expect(delays[0]).toBeGreaterThanOrEqual(150);
      expect(delays[1] / delays[0]).toBeGreaterThanOrEqual(1.5); // exponential growth
      const { rows: beforeRecovery } = await dbh.query(
        `SELECT lat, lng, coarse_lat, coarse_lng FROM listings WHERE id = $1`,
        [listingId]
      );
      expect(beforeRecovery[0].lat).toBeNull(); // nothing written during the outage

      // Recovery: the same deferred job completes and persists precise + coarse (ADR-010).
      mode = 'ok';
      const statsFixed = await pollOnce(opts);
      expect(statsFixed.delivered).toBeGreaterThanOrEqual(1);
      const { rows: geocoded } = await dbh.query(
        `SELECT lat, lng, coarse_lat, coarse_lng, area_label FROM listings WHERE id = $1`,
        [listingId]
      );
      expect(Number(geocoded[0].lat)).toBeCloseTo(32.7123456, 5);
      expect(Number(geocoded[0].coarse_lat)).toBeCloseTo(32.71, 5);
      expect(geocoded[0].area_label).toBe('Gaslamp Quarter, San Diego');
      const { rows: doneJob } = await dbh.query(`SELECT status FROM outbox_jobs WHERE id = $1`, [
        job.id,
      ]);
      expect(doneJob[0].status).toBe('delivered');
    } finally {
      restore();
    }
  }, 30000);

  test('a definitive no-results answer completes the job without retrying (retry cannot help)', async () => {
    const host = await w3.makeHost();
    const hostCookie = await w3.cookieFor(host);
    const restore = w3.patchFn(maps, 'geocode', async () => {
      throw new NotFoundError('maps.geocode: no results for the given input', {
        code: 'MAPS_NO_RESULTS',
      });
    });
    try {
      const res = await request(app)
        .post('/api/listings')
        .send({
          title: 'RT02 No-Results Dinner',
          description: 'Listing whose address does not geocode.',
          ingredients: ['stew'],
          scheduledStart: new Date(Date.now() + 22 * 24 * 3600 * 1000).toISOString(),
          durationMinutes: 90,
          seatCapacity: 4,
          addressLine1: 'Nowhere That Geocodes 0',
          city: 'San Diego',
          region: 'CA',
        })
        .set('Cookie', hostCookie);
      expect(res.status).toBe(201);
      const listingId = res.body.listing.id;
      const [job] = await jobsFor('listing.geocode', 'listingId', listingId);

      const stats = await pollOnce({ registry, log: quiet });
      expect(stats.deadLettered).toBe(0);
      const { rows } = await dbh.query(
        `SELECT status, attempt_count FROM outbox_jobs WHERE id = $1`,
        [job.id]
      );
      expect(rows[0].status).toBe('delivered'); // completed, not retried, not dead
      expect(rows[0].attempt_count).toBe(1);
      const { rows: listing } = await dbh.query(`SELECT lat, lng FROM listings WHERE id = $1`, [
        listingId,
      ]);
      expect(listing[0].lat).toBeNull(); // keeps a null geocode; detail still renders
    } finally {
      restore();
    }
  }, 30000);
});

// RT-02 re-verification of the TCB-W3-01 blocker: FR-10 email verification, proved through the
// value that is ACTUALLY DELIVERED rather than through an in-process return value (SRS §4.4;
// FR-10; ADR-003, ADR-011).
//
// THE BUG THIS GUARDS. Waves 1–2 reported FR-10 as PASS while the delivered email carried only
// the token's SHA-256 DIGEST: the outbox payload is IDs-only by ADR-003, the raw token is never
// persisted, and the tests read the token from the in-process return value of the register call
// instead of from the delivery. So no real recipient could ever verify — and nobody could become
// eligible to book or publish. The repair mints the deliverable link WORKER-SIDE, in the
// handler's `resolveRenderContext()` callback, which the transport invokes only for an adapter
// that declares `requiresRenderContext` (src/adapters/sendgrid.js does; the ADR-011 mock
// deliberately does not, so dev/test never mint a credential).
//
// WHY THE ADR-011 MOCK CANNOT PROVE THIS ALONE, AND WHAT THESE TESTS DO INSTEAD. Because the
// mock declines the render context, `mockTransport.deliveries()` records `params:{userId,
// tokenHash}` — a digest, still not a usable token. Reading the mock's delivery therefore
// cannot demonstrate FR-10 end to end. These tests instead substitute a RECORDING EMAIL ADAPTER
// that declares `requiresRenderContext: true` exactly as SendGrid does, so the production
// sequence runs unchanged (handler → transport.send(..., {resolveRenderContext}) → adapter
// .deliver({renderContext})), and then compose the message body with the REAL SendGrid
// renderer, `renderEmail()` from src/adapters/sendgrid.js. The token is then scraped out of
// that rendered email text with a regex — the same thing a recipient does by clicking — and
// posted to the public verify endpoint. Nothing here contacts a provider: renderEmail is pure
// and no SDK is loaded (ADR-011).
describe('RT-02 / FR-10 (TCB-W3-01 re-verification) — the DELIVERED email carries a usable token', () => {
  /**
   * Drain every claimable outbox job, capturing the email body each delivery would put on the
   * wire. The recording adapter stands in for SendGrid at the transport's adapter seam and
   * declares the same `requiresRenderContext` contract, so the worker-side link minting runs.
   * @returns {Promise<Array<{template: string, params: object, subject: string, text: string}>>}
   */
  async function drainCapturingEmails() {
    const emails = [];
    const restoreDeliver = w3.patchFn(mockTransport.adapter, 'deliver', async (input) => {
      const { subject, text } = renderEmail(
        input.template,
        input.params,
        input.renderContext || {}
      );
      emails.push({ template: input.template, params: input.params, subject, text });
      return { providerMessageId: `capture-${emails.length}` };
    });
    const hadFlag = Object.prototype.hasOwnProperty.call(
      mockTransport.adapter,
      'requiresRenderContext'
    );
    mockTransport.adapter.requiresRenderContext = true;
    try {
      // Drain to quiescence: a job scheduled with backoff may need more than one pass.
      for (let pass = 0; pass < 10; pass += 1) {
        const stats = await pollOnce({ registry, log: quiet });
        if (stats.claimed === 0) break;
      }
    } finally {
      restoreDeliver();
      if (hadFlag) mockTransport.adapter.requiresRenderContext = false;
      else delete mockTransport.adapter.requiresRenderContext;
    }
    return emails;
  }

  test('register → drain the outbox → take the token out of the delivered email → email_verified = true', async () => {
    // The transport really is the ADR-011 mock; the recording adapter below only borrows its
    // seam, so this test cannot be read as proof about a live provider.
    expect(notificationsTransport.send).toBeInstanceOf(Function);

    const email = `fr10-delivered-${Date.now()}@homeplate.invalid`;
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'Verify-Me-9!aa' });
    expect(registered.status).toBe(201);
    const userId = registered.body.user.id;

    const { rows: before } = await dbh.query('SELECT email_verified FROM users WHERE id = $1', [
      userId,
    ]);
    expect(before[0].email_verified).toBe(false);

    // The outbox row exists and is IDs-only (ADR-003) — it carries a DIGEST, not the token.
    const { rows: jobs } = await dbh.query(
      `SELECT payload FROM outbox_jobs
         WHERE type = 'email.verification' AND status = 'pending' AND payload->>'userId' = $1`,
      [userId]
    );
    expect(jobs).toHaveLength(1);
    expect(Object.keys(jobs[0].payload).sort()).toEqual(['tokenHash', 'userId']);
    expect(jobs[0].payload.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const emails = await drainCapturingEmails();
    const verification = emails.filter((e) => e.template === 'email.verification');
    expect(verification).toHaveLength(1);

    // THE ASSERTION THAT WAVES 1–2 WERE MISSING: what a recipient can act on is a link, and the
    // digest that travelled in the outbox payload must NOT be what they are asked to submit.
    // (The rendered body also prints a "Reference:" block echoing userId/tokenHash, so the
    // digest's mere presence proves nothing — the ACTIONABLE value is what is checked here.)
    const body = verification[0].text;
    const match = body.match(/https?:\/\/\S*\/verify-email\?token=([A-Za-z0-9._~-]+)/);
    expect(match).toBeTruthy(); // a real single-use URL, not a hash and not a placeholder
    const deliveredToken = match[1];
    expect(deliveredToken).not.toBe(jobs[0].payload.tokenHash);

    // A REGISTERED USER, holding only what the email delivered, verifies their address.
    const verified = await request(app).post('/api/auth/verify-email').send({
      token: deliveredToken,
    });
    expect(verified.status).toBe(200);

    const { rows: after } = await dbh.query('SELECT email_verified FROM users WHERE id = $1', [
      userId,
    ]);
    expect(after[0].email_verified).toBe(true); // FR-10 closed, end to end
  }, 30000);

  test('the delivered token is single-use: replaying the SAME delivered value is refused', async () => {
    const email = `fr10-replay-${Date.now()}@homeplate.invalid`;
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'Verify-Me-9!aa' });
    expect(registered.status).toBe(201);

    const emails = await drainCapturingEmails();
    const body = emails.find((e) => e.template === 'email.verification').text;
    const deliveredToken = body.match(/https?:\/\/\S*\/verify-email\?token=([A-Za-z0-9._~-]+)/)[1];

    expect(
      (await request(app).post('/api/auth/verify-email').send({ token: deliveredToken })).status
    ).toBe(200);
    const replay = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: deliveredToken });
    expect(replay.status).toBe(400); // consumed — FR-10 tokens are single-use

    const { rows } = await dbh.query('SELECT email_verified FROM users WHERE id = $1', [
      registered.body.user.id,
    ]);
    expect(rows[0].email_verified).toBe(true); // the first, legitimate verification stands
  }, 30000);

  test('RT-02 exactly-once meets FR-10: a redelivered job mails nothing new, and the first delivered token still verifies', async () => {
    // The outbox may redeliver after a lost commit. The dedupe key is
    // `email.verification:<tokenHash>`, so the redelivery must NOT mail a second link (which
    // would invalidate the one the recipient already holds, putting FR-10 back where
    // TCB-W3-01 found it) — and the token already delivered must still work afterwards.
    const email = `fr10-redeliver-${Date.now()}@homeplate.invalid`;
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'Verify-Me-9!aa' });
    expect(registered.status).toBe(201);

    const first = await drainCapturingEmails();
    const firstVerification = first.filter((e) => e.template === 'email.verification');
    expect(firstVerification).toHaveLength(1);
    const deliveredToken = firstVerification[0].text.match(
      /https?:\/\/\S*\/verify-email\?token=([A-Za-z0-9._~-]+)/
    )[1];

    // Simulate the crash-then-redeliver case: put the same job back as pending.
    // Scoped to THIS test's own row (PRIORITY-0 determinism rule: never assert over, or
    // mutate, rows a sibling test created — sister cases above leave their own jobs behind).
    const reset = await dbh.query(
      `UPDATE outbox_jobs SET status = 'pending', delivered_at = NULL, available_at = now()
         WHERE type = 'email.verification' AND payload->>'userId' = $1`,
      [registered.body.user.id]
    );
    expect(reset.rowCount).toBe(1);

    const second = await drainCapturingEmails();
    // Exactly-once: the redelivery is deduped at the transport, so no second email goes out.
    expect(second.filter((e) => e.template === 'email.verification')).toHaveLength(0);
    // …and the job is not left stuck pending — the dedupe COMPLETES it (RT-02).
    const { rows: jobRows } = await dbh.query(
      `SELECT status FROM outbox_jobs
         WHERE type = 'email.verification' AND payload->>'userId' = $1`,
      [registered.body.user.id]
    );
    expect(jobRows.map((r) => r.status)).toEqual(['delivered']);

    const verified = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: deliveredToken });
    expect(verified.status).toBe(200);

    const { rows } = await dbh.query('SELECT email_verified FROM users WHERE id = $1', [
      registered.body.user.id,
    ]);
    expect(rows[0].email_verified).toBe(true);
  }, 30000);
});
