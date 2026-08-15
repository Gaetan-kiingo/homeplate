// tests/rt-lt-resilience/rt02-wave3-outbox.test.js — RT-02 on the WAVE-3 deferred work
// (SRS §4.4; FR-13; ADR-001/003). Extends the wave-2 mechanism tests in rt02-outbox.test.js
// (crash recovery, SKIP LOCKED, generic retry/backoff/dead-letter/requeue) to the three
// handlers wave 3 added: notify.booking, booking.promote, listing.geocode — duplicate-delivery
// idempotency, retry/backoff under a provider outage, and dead-letter with the reason visible.
'use strict';

const request = require('supertest');

const { createApp } = require('../../src/app');
const maps = require('../../src/adapters/maps');
const mockTransport = require('../../src/adapters/mockTransport');
const { NotFoundError, ServiceUnavailableError } = require('../../src/lib/errors');
const { pollOnce } = require('../../src/outbox/worker');
const { loadHandlers } = require('../../src/outbox/dispatch');

const dbh = require('../helpers/db');
const rh = require('../helpers/redis');
const { quietLogger } = require('./helpers');
const w3 = require('./wave3');

const quiet = quietLogger();
let app;
let registry;

async function jobsFor(type, key, id) {
  const { rows } = await dbh.query(
    `SELECT * FROM outbox_jobs WHERE type = $1 AND payload->>${key === 'bookingId' ? `'bookingId'` : `'listingId'`} = $2 ORDER BY id`,
    [type, id]
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
  mockTransport.reset();
  await w3.neutralizePendingJobs();
});

afterAll(async () => {
  mockTransport.reset();
  await dbh.closeDb();
  await rh.closeTestRedis();
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
    const outbox = require('../../src/outbox/outbox');
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
    await dbh.query(
      `UPDATE outbox_jobs SET status = 'delivered', delivered_at = now()
        WHERE status = 'pending' AND type <> 'booking.promote'`
    );

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
    await dbh.query(
      `UPDATE outbox_jobs SET status = 'delivered', delivered_at = now()
        WHERE status = 'pending' AND type <> 'booking.promote'`
    );
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
