// tests/it-adapters/it01-wave3-worker-paths.test.js — IT-01 extension for wave 3 (SRS §4.2):
// the NEW worker-side adapter paths this wave added are exercised end-to-end through the REAL
// outbox worker — enqueue (same transaction as the business write) → pollOnce → handler →
// adapter/transport — for the HAPPY path and against injected failures for the DEGRADED path
// (NFR-09). Per ADR-007/ADR-011 nothing here calls a live provider: the Maps and LLM adapters
// run in their deterministic mock modes, transports resolve to the mock recording
// NOTIFICATION_ATTEMPT rows, and outages are injected (jest spies / mockTransport.injectFailures).
//
// Requirement traceability (SRS Appendix B):
//   FR-01/FR-11 — 'listing.geocode' handler: worker-only Maps call writes precise + coarse
//        coordinates to PostgreSQL; an outage defers, never blocks (NFR-09); ADR-010: the
//        precise pair never reaches the Redis maps cache (precision:'exact' bypasses it).
//   FR-13/FR-14 — 'notify.booking' handler: booking create/cancel notifications delivered by
//        the worker through the ONE transport; NOTIFICATION_ATTEMPT per try; retry after
//        recovery reuses the same row (exactly-once, RT-02 subset); dead-letter + requeue.
//   FR-04/FR-12 — 'booking.promote' scheduled job: pending → in_progress when due; idempotent
//        redelivery; self-repairing reschedule when the listing's start moves later.
//   NFR-09 (RT-01 subset) — Maps on the FR-01 search read path: degraded pass-through is never
//        cached; outage with no cached area is a typed 503 SEARCH_DEGRADED, never a 500.
//   FR-08 substrate — 'moderation.scan' has NO handler until wave 4: the job retries then
//        dead-letters and the listing STAYS pending (the ADR-002 safe direction).
'use strict';

// Fast resilience knobs for THIS FILE ONLY (Jest module registry is per-file; restored in
// afterAll so nothing leaks into a re-run in the same process).
process.env.ADAPTER_TIMEOUT_MS = '250';
process.env.ADAPTER_RETRY_MAX = '1';
process.env.ADAPTER_BACKOFF_BASE_MS = '10';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');

const config = require('../../src/config');
const { createApp } = require('../../src/app');
const maps = require('../../src/adapters/maps'); // spied on for injected outages (mock mode)
const { coarsen } = require('../../src/lib/geoPrecision');
const mockTransport = require('../../src/adapters/mockTransport');
const sendgrid = require('../../src/adapters/sendgrid');
const { loadHandlers } = require('../../src/outbox/dispatch');
const { pollOnce } = require('../../src/outbox/worker');
const outbox = require('../../src/outbox/outbox');
const notifRepo = require('../../src/modules/notifications/repo');
const bookingsService = require('../../src/modules/bookings/service');
const listingsService = require('../../src/modules/listings/service');
const lifecycle = require('../../src/modules/bookings/lifecycle');
const searchService = require('../../src/modules/search/service');
const { NotFoundError, ServiceUnavailableError } = require('../../src/lib/errors');
const dbh = require('../helpers/db');
const { redis, flushNamespace, closeTestRedis } = require('../helpers/redis');

const TRANSPORT_ATTEMPTS = Number(process.env.ADAPTER_RETRY_MAX) + 1; // per transport.send

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

const uniq = () => crypto.randomBytes(6).toString('hex');

beforeAll(async () => {
  expect(config.isTest).toBe(true); // mock adapters only in the suite (ADR-007/ADR-011)
  registry = loadHandlers({ log: quietLog });
  app = createApp();
  await flushNamespace('cache'); // start from a cold maps/search cache
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
  await flushNamespace('cache');
  await dbh.query(`DELETE FROM users WHERE email LIKE '%@dbunit.homeplate.invalid'`);
  await dbh.closeDb();
  await closeTestRedis();
});

/** Enqueue one outbox job in its own committed transaction (test scaffolding only). */
async function enqueueJob(fields) {
  return dbh.withTransaction(async (client) => {
    const { job } = await outbox.enqueue(client, fields);
    return job;
  });
}

async function jobRow(id) {
  const { rows } = await dbh.query('SELECT * FROM outbox_jobs WHERE id = $1', [id]);
  return rows[0];
}

async function listingRow(id) {
  const { rows } = await dbh.query('SELECT * FROM listings WHERE id = $1', [id]);
  return rows[0];
}

async function bookingRow(id) {
  const { rows } = await dbh.query('SELECT * FROM bookings WHERE id = $1', [id]);
  return rows[0];
}

async function makeDue(jobId) {
  await dbh.query(`UPDATE outbox_jobs SET available_at = now() WHERE id = $1`, [jobId]);
}

/** Drain every currently-due job (retried jobs back off into the future and drop out). */
async function drainDue(options = {}) {
  let stats;
  do {
    stats = await pollOnce({ registry, log: quietLog, ...options });
  } while (stats.claimed > 0);
}

/** A listing with a geocodable street address and no geocode yet. */
async function makeAddressedListing(overrides = {}) {
  return dbh.makeListing({
    address_line1: `4610 Cass St #${uniq()}`,
    city: 'San Diego',
    region: 'CA',
    postal_code: '92109',
    country: 'US',
    lat: null,
    lng: null,
    coarse_lat: null,
    coarse_lng: null,
    area_label: null,
    ...overrides,
  });
}

/** Host + guest + an approved bookable listing (FR-12 preconditions). */
async function makeBookableWorld({ startInMs = 6 * 3600 * 1000 } = {}) {
  const host = await dbh.makeUser({ can_publish_listing: true });
  const guest = await dbh.makeUser();
  const listing = await dbh.makeListing({
    host_id: host.id,
    moderation_status: 'approved',
    scheduled_start: new Date(Date.now() + startInMs),
    seat_capacity: 4,
    seats_remaining: 4,
  });
  return { host, guest, listing };
}

// ==============================================================================================
describe('IT-01 wave 3 · listing.geocode worker path (Maps adapter — ADR-005/ADR-010, NFR-09)', () => {
  test('happy path: worker geocodes via the Maps adapter and persists precise + coarse pairs', async () => {
    const listing = await makeAddressedListing();
    const job = await enqueueJob({
      type: 'listing.geocode',
      payload: { listingId: listing.id },
    });
    await drainDue();

    const delivered = await jobRow(job.id);
    expect(delivered.status).toBe('delivered');

    const row = await listingRow(listing.id);
    expect(typeof row.lat).toBe('number');
    expect(typeof row.lng).toBe('number');
    expect(row.area_label).toBeTruthy();
    // Public pair is exactly the ADR-010 coarsening of the precise pair.
    const snapped = coarsen(row.lat, row.lng, {});
    expect(row.coarse_lat).toBe(snapped.lat);
    expect(row.coarse_lng).toBe(snapped.lng);
    // Precise and public precision genuinely differ (grid-snapped vs provider-exact).
    expect(row.lat).not.toBe(row.coarse_lat);

    // ADR-010: precision:'exact' bypasses the Redis cache — the precise pair must not
    // appear in any hp:cache:maps:* value.
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'hp:cache:maps:*', 'COUNT', 200);
      cursor = next;
      for (const k of keys) {
        const raw = await redis.get(k);
        if (raw === null) continue;
        expect(raw).not.toContain(String(row.lat));
        expect(raw).not.toContain(String(row.lng));
        expect(raw).not.toContain('precise');
      }
    } while (cursor !== '0');
  });

  test('degraded path: Maps outage leaves the job queued with backoff; recovery completes it (NFR-09)', async () => {
    const listing = await makeAddressedListing();
    const job = await enqueueJob({
      type: 'listing.geocode',
      payload: { listingId: listing.id },
    });

    const spy = jest
      .spyOn(maps, 'geocode')
      .mockRejectedValue(
        new ServiceUnavailableError('injected Maps outage', { code: 'MAPS_UNAVAILABLE' })
      );
    await pollOnce({ registry, log: quietLog });

    let row = await jobRow(job.id);
    expect(row.status).toBe('pending'); // deferred, never dropped
    expect(row.attempt_count).toBe(1);
    expect(row.last_error).toMatch(/injected Maps outage/);
    expect(new Date(row.available_at).getTime()).toBeGreaterThan(Date.now() - 50); // backed off
    expect((await listingRow(listing.id)).lat).toBeNull(); // nothing half-written

    spy.mockRestore();
    await makeDue(job.id);
    await drainDue();
    row = await jobRow(job.id);
    expect(row.status).toBe('delivered');
    expect((await listingRow(listing.id)).lat).not.toBeNull();
  });

  test('definitive no-results completes the job (never retried); listing keeps a null geocode', async () => {
    const listing = await makeAddressedListing();
    const job = await enqueueJob({
      type: 'listing.geocode',
      payload: { listingId: listing.id },
    });
    const spy = jest
      .spyOn(maps, 'geocode')
      .mockRejectedValue(new NotFoundError('no results', { code: 'MAPS_NO_RESULTS' }));
    await pollOnce({ registry, log: quietLog });
    expect(spy).toHaveBeenCalledTimes(1);
    const row = await jobRow(job.id);
    expect(row.status).toBe('delivered'); // completed, not dead-lettered — retrying cannot help
    expect((await listingRow(listing.id)).lat).toBeNull();
  });

  test('cancelled listing: clean skip, zero adapter calls', async () => {
    const listing = await makeAddressedListing({ status: 'cancelled' });
    const job = await enqueueJob({
      type: 'listing.geocode',
      payload: { listingId: listing.id },
    });
    const spy = jest.spyOn(maps, 'geocode');
    await drainDue();
    expect(spy).not.toHaveBeenCalled();
    expect((await jobRow(job.id)).status).toBe('delivered');
  });

  test('malformed payload is a caller bug: retries then dead-letters with the reason recorded', async () => {
    await drainDue(); // clear the runway so the small maxAttempts below hits only this job
    const job = await enqueueJob({
      type: 'listing.geocode',
      payload: { listingId: 'not-a-uuid' },
    });
    await pollOnce({ registry, log: quietLog, maxAttempts: 1 });
    const row = await jobRow(job.id);
    expect(row.status).toBe('dead');
    expect(row.last_error).toMatch(/UUID/i);
  });
});

// ==============================================================================================
describe('IT-01 wave 3 · notify.booking end-to-end (FR-13 — transport, ADR-011, RT-02 subset)', () => {
  test('booking create → outbox rows (IDs only) → worker → sent NOTIFICATION_ATTEMPT per recipient', async () => {
    const { host, guest, listing } = await makeBookableWorld();
    const booking = await bookingsService.createBooking(guest.id, listing.id, { log: quietLog });

    // Exactly one notify row per recipient, plus the scheduled promote job — all committed
    // with the booking (ADR-001/003; same-transaction rollback is proven in tc-booking).
    const { rows: jobs } = await dbh.query(
      `SELECT * FROM outbox_jobs WHERE payload->>'bookingId' = $1 ORDER BY type`,
      [booking.id]
    );
    const notifyJobs = jobs.filter((j) => j.type === 'notify.booking');
    const promoteJobs = jobs.filter((j) => j.type === 'booking.promote');
    expect(notifyJobs).toHaveLength(2);
    expect(promoteJobs).toHaveLength(1);
    expect(new Set(notifyJobs.map((j) => j.payload.recipientUserId))).toEqual(
      new Set([guest.id, host.id])
    );
    // ADR-003: payloads carry IDs only — no email/phone/name shapes.
    for (const j of jobs) {
      const text = JSON.stringify(j.payload);
      expect(text).not.toMatch(/@/);
      expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/);
    }
    // The promote job is scheduled at the listing's start, not now (build-plan §6.4).
    expect(new Date(promoteJobs[0].available_at).getTime()).toBeGreaterThan(
      Date.now() + 3600 * 1000
    );

    await drainDue();
    for (const recipient of [guest.id, host.id]) {
      const attempt = await notifRepo.findByIdempotencyKey(
        `notify.booking:${booking.id}:created:${recipient}`
      );
      expect(attempt).toBeTruthy();
      expect(attempt.status).toBe('sent');
      expect(attempt.channel).toBe('email'); // ADR-011: email is the v1.0 channel
      expect(attempt.recipient_user_id).toBe(recipient);
    }
    // The promote job must NOT have been claimed early.
    expect((await jobRow(promoteJobs[0].id)).status).toBe('pending');
    expect(mockTransport.deliveries().length).toBeGreaterThanOrEqual(2);
  });

  test('degraded path: provider outage → failed row, job retried; recovery reuses the SAME row (exactly-once)', async () => {
    const { guest, listing } = await makeBookableWorld();
    const booking = await bookingsService.createBooking(guest.id, listing.id, { log: quietLog });
    const guestKey = `notify.booking:${booking.id}:created:${guest.id}`;

    mockTransport.injectFailures(20); // outage across every recipient and retry
    await drainDue();

    const failedAttempt = await notifRepo.findByIdempotencyKey(guestKey);
    expect(failedAttempt.status).toBe('failed');
    expect(failedAttempt.attempt_count).toBe(TRANSPORT_ATTEMPTS);
    const { rows: pendingJobs } = await dbh.query(
      `SELECT * FROM outbox_jobs WHERE type = 'notify.booking' AND payload->>'bookingId' = $1`,
      [booking.id]
    );
    for (const j of pendingJobs) {
      expect(j.status).toBe('pending'); // deferred, never dropped (NFR-09)
      expect(j.attempt_count).toBe(1);
      expect(j.last_error).toMatch(/delivery failed/);
    }

    mockTransport.reset();
    for (const j of pendingJobs) await makeDue(j.id);
    await drainDue();

    const sentAttempt = await notifRepo.findByIdempotencyKey(guestKey);
    expect(sentAttempt.status).toBe('sent');
    expect(sentAttempt.id).toBe(failedAttempt.id); // SAME row — no duplicate send (RT-02)
    const allForGuest = await notifRepo.listForUser(guest.id);
    expect(allForGuest).toHaveLength(1);
  });

  test('dead-letter at the cap stays visible with its reason; requeueDeadLetter delivers after the fix', async () => {
    const { guest, listing } = await makeBookableWorld();
    const booking = await bookingsService.createBooking(guest.id, listing.id, { log: quietLog });
    await drainDue(); // deliver the create notifications normally

    // A fresh completed-event job for the guest, forced to fail past a 2-attempt budget.
    const job = await dbh.withTransaction(async (client) => {
      const [j] = await lifecycle.enqueueBookingNotifications(client, {
        bookingId: booking.id,
        event: 'completed',
        recipientUserIds: [guest.id],
      });
      return j;
    });
    mockTransport.injectFailures(20);
    await pollOnce({ registry, log: quietLog, maxAttempts: 2 }); // attempt 1 → retry
    await makeDue(job.id);
    await pollOnce({ registry, log: quietLog, maxAttempts: 2 }); // attempt 2 → dead

    let row = await jobRow(job.id);
    expect(row.status).toBe('dead');
    expect(row.last_error).toMatch(/delivery failed/); // NFR-09: reason stays visible
    expect((await outbox.listDeadLetters({ limit: 100 })).map((d) => d.id)).toContain(row.id);

    mockTransport.reset();
    const requeued = await outbox.requeueDeadLetter(job.id);
    expect(requeued.status).toBe('pending');
    await drainDue();
    row = await jobRow(job.id);
    expect(row.status).toBe('delivered');
    const attempt = await notifRepo.findByIdempotencyKey(
      `notify.booking:${booking.id}:completed:${guest.id}`
    );
    expect(attempt.status).toBe('sent');
  });
});

// ==============================================================================================
describe('IT-01 wave 3 · booking.promote scheduled worker path (FR-04/FR-12, RT-02 subset)', () => {
  test('due promotion: pending → in_progress exactly once; redelivery is a clean no-op', async () => {
    const { guest, listing } = await makeBookableWorld();
    const booking = await bookingsService.createBooking(guest.id, listing.id, { log: quietLog });
    await drainDue(); // clear the create notifications

    // Come due: the listing starts now (worker delivers at/after scheduled_start).
    await dbh.query(
      `UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`,
      [listing.id]
    );
    const { rows: promoteJobs } = await dbh.query(
      `SELECT * FROM outbox_jobs WHERE type = 'booking.promote' AND payload->>'bookingId' = $1`,
      [booking.id]
    );
    expect(promoteJobs).toHaveLength(1);
    await makeDue(promoteJobs[0].id);
    await drainDue();

    let row = await bookingRow(booking.id);
    expect(row.status).toBe('in_progress');
    expect((await jobRow(promoteJobs[0].id)).status).toBe('delivered');

    // Redelivery (fresh job for a different instant): idempotent no-op.
    await dbh.withTransaction(async (client) =>
      lifecycle.enqueuePromotion(client, { bookingId: booking.id, scheduledStart: new Date() })
    );
    await drainDue();
    row = await bookingRow(booking.id);
    expect(row.status).toBe('in_progress');
    expect(row.completed_at).toBeNull();
  });

  test('cancelled booking is never promoted', async () => {
    const { guest, listing } = await makeBookableWorld();
    const booking = await bookingsService.createBooking(guest.id, listing.id, { log: quietLog });
    await bookingsService.cancelBooking(guest.id, booking.id, { log: quietLog });
    await dbh.query(
      `UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`,
      [listing.id]
    );
    const { rows: promoteJobs } = await dbh.query(
      `SELECT * FROM outbox_jobs WHERE type = 'booking.promote' AND payload->>'bookingId' = $1`,
      [booking.id]
    );
    await makeDue(promoteJobs[0].id);
    await drainDue();
    expect((await bookingRow(booking.id)).status).toBe('cancelled');
    expect((await jobRow(promoteJobs[0].id)).status).toBe('delivered'); // clean no-op
  });

  test('start moved LATER: the old job re-enqueues a fresh job for the new instant (self-repair)', async () => {
    const { guest, listing } = await makeBookableWorld();
    const booking = await bookingsService.createBooking(guest.id, listing.id, { log: quietLog });
    await drainDue();

    // The host moves the meal 12 hours later; the original job then comes due at the OLD start.
    await dbh.query(
      `UPDATE listings SET scheduled_start = now() + interval '12 hours' WHERE id = $1`,
      [listing.id]
    );
    const { rows: before } = await dbh.query(
      `SELECT * FROM outbox_jobs WHERE type = 'booking.promote' AND payload->>'bookingId' = $1`,
      [booking.id]
    );
    expect(before).toHaveLength(1);
    await makeDue(before[0].id);
    await drainDue();

    expect((await bookingRow(booking.id)).status).toBe('pending'); // NOT promoted early
    expect((await jobRow(before[0].id)).status).toBe('delivered');
    const { rows: after } = await dbh.query(
      `SELECT * FROM outbox_jobs
       WHERE type = 'booking.promote' AND payload->>'bookingId' = $1 AND status = 'pending'`,
      [booking.id]
    );
    expect(after).toHaveLength(1); // a FRESH job exists for the new instant
    expect(new Date(after[0].available_at).getTime()).toBeGreaterThan(Date.now() + 3600 * 1000);
  });

  test('IT3-F1 fixed: job delivered before an UNCHANGED future start keeps a live promote row', async () => {
    // If the promote job is claimed while the listing's scheduled_start is still (per the
    // app clock) in the future AND unchanged — DB/app clock skew or an operator requeue is
    // enough — a naive re-enqueue would dedupe onto the SAME job row (identical dedupe key),
    // which the worker then marks delivered: the promotion would be silently lost. The
    // IT3-F1 fix (lifecycle.securePromotionSchedule, fed ctx.jobId by the handler) detects
    // that self-dedupe and secures a FRESH pending row — disambiguated dedupe key — still
    // scheduled at the true start, so the booking promotes when the start really arrives.
    const { guest, listing } = await makeBookableWorld();
    const booking = await bookingsService.createBooking(guest.id, listing.id, { log: quietLog });
    await drainDue();

    const { rows: jobs } = await dbh.query(
      `SELECT * FROM outbox_jobs WHERE type = 'booking.promote' AND payload->>'bookingId' = $1`,
      [booking.id]
    );
    expect(jobs).toHaveLength(1);
    await makeDue(jobs[0].id); // claimed early; scheduled_start unchanged (still future)
    await drainDue();

    const { rows: surviving } = await dbh.query(
      `SELECT * FROM outbox_jobs
       WHERE type = 'booking.promote' AND payload->>'bookingId' = $1 AND status = 'pending'`,
      [booking.id]
    );
    // FIXED behaviour: exactly one FRESH pending row survives (not the delivered one),
    // scheduled at the listing's true start — the promotion is never lost.
    expect(surviving).toHaveLength(1);
    expect(surviving[0].id).not.toBe(jobs[0].id);
    expect(
      Math.abs(
        new Date(surviving[0].available_at).getTime() - new Date(listing.scheduled_start).getTime()
      )
    ).toBeLessThan(1000);
    expect((await jobRow(jobs[0].id)).status).toBe('delivered');
    expect((await bookingRow(booking.id)).status).toBe('pending'); // still not promoted early
  });
});

// ==============================================================================================
describe('IT-01/RT-01 wave 3 · Maps adapter on the FR-01 search read path (NFR-09)', () => {
  const base = { page: 1, pageSize: 10 };

  test('healthy repeat query performs ZERO adapter calls (page cache); no degraded flag', async () => {
    const location = `la jolla it-lane ${uniq()}`;
    const first = await searchService.searchListings({ ...base, location });
    expect(Array.isArray(first.results)).toBe(true);
    expect(first.degraded).toBeUndefined();
    const spy = jest.spyOn(maps, 'searchArea');
    const second = await searchService.searchListings({ ...base, location });
    expect(spy).not.toHaveBeenCalled(); // served from the Redis page cache
    // Compare the JSON wire shape: the cache round-trip turns Date objects into the same ISO
    // strings res.json() would have produced anyway.
    expect(JSON.parse(JSON.stringify(second))).toEqual(JSON.parse(JSON.stringify(first)));
  });

  test('degraded pass-through: stale-served area flags the page and the page is NEVER cached', async () => {
    const location = `degraded town ${uniq()}`;
    const area = coarsen(32.8, -117.2, { areaLabel: 'Degraded Town' });
    const spy = jest
      .spyOn(maps, 'searchArea')
      .mockResolvedValue({ areas: [area], degraded: true, source: 'cache-degraded' });
    const first = await searchService.searchListings({ ...base, location });
    expect(first.degraded).toBe(true);
    const second = await searchService.searchListings({ ...base, location });
    expect(second.degraded).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2); // degraded pages bypass the cache — recovery is visible
  });

  test('outage with no cached area: typed 503 SEARCH_DEGRADED with a user-facing message, never a 500', async () => {
    jest
      .spyOn(maps, 'searchArea')
      .mockRejectedValue(
        new ServiceUnavailableError('injected outage', { code: 'MAPS_UNAVAILABLE' })
      );
    const err = await searchService
      .searchListings({ ...base, location: `never seen ${uniq()}` })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.code).toBe('SEARCH_DEGRADED');
    expect(err.status ?? err.statusCode).toBe(503);
    expect(err.message).toMatch(/try again|without a location/i);
  });
});

// ==============================================================================================
describe('IT-03 substrate (FR-08/ADR-002) — the safe direction holds while the pipeline is wave 4', () => {
  test('moderation.scan dead-letters harmlessly; the listing STAYS pending and never surfaces', async () => {
    const host = await dbh.makeUser({ can_publish_listing: true });
    const scheduledStart = new Date(Date.now() + 300 * 24 * 3600 * 1000).toISOString();
    const created = await listingsService.createListing(
      { userId: host.id },
      {
        title: 'IT-03 substrate meal',
        description: 'Wave-3 moderation substrate check.',
        ingredients: ['rice', 'beans'],
        allergens: ['none'],
        cuisine: 'test',
        scheduledStart,
        durationMinutes: 90,
        seatCapacity: 4,
        addressLine1: '4610 Cass St',
        city: 'San Diego',
        region: 'CA',
        postalCode: '92109',
        country: 'US',
      },
      { log: quietLog }
    );
    expect(created.moderationStatus ?? created.moderation_status).toBe('pending');

    const { rows: scans } = await dbh.query(
      `SELECT * FROM outbox_jobs WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
      [created.id]
    );
    expect(scans).toHaveLength(1);

    await drainDue({ maxAttempts: 2 }); // attempt 1: no handler → retry
    await makeDue(scans[0].id);
    await drainDue({ maxAttempts: 2 }); // attempt 2: dead-letter

    const dead = await jobRow(scans[0].id);
    expect(dead.status).toBe('dead');
    expect(dead.last_error).toMatch(/no outbox handler registered/);
    // The ADR-002 safe direction: content stays pending and never publishes unreviewed.
    expect((await listingRow(created.id)).moderation_status).toBe('pending');
    const page = await searchService.searchListings({ page: 1, pageSize: 20, hostId: host.id });
    expect(page.results).toHaveLength(0);
  });

  test('WAVE-4 GAP: the IT-03 measurement protocol is not yet buildable — no eval set, no scan handler', () => {
    // NFR-10/ADR-008: a versioned ≥200-item labelled set under tests/fixtures/moderation-eval/vN/
    // scored through the REAL pipeline, with a recorded human sign-off. Neither the set nor the
    // pipeline exists in wave 3 — NFR-10 stays not_implemented (build-plan §7), never "passed".
    // When U4-MODERATION lands, this probe FAILS by design: replace it with the real IT-03
    // measurement harness (score the set, print FP/FN rates, assert < 0.05, check sign-off).
    const evalDir = path.join(__dirname, '..', 'fixtures', 'moderation-eval');
    expect(fs.existsSync(evalDir)).toBe(false);
    expect(registry.has('moderation.scan')).toBe(false);
  });
});

// ==============================================================================================
describe('IT-04 (FR-07) — safety-alert delivery is wave 4; only the substrate exists today', () => {
  test('WAVE-4 GAP: POST /api/bookings/:id/safety-alerts does not exist yet (404)', async () => {
    // When U4-SAFETY lands this probe FAILS by design: replace it with the real IT-04 —
    // alert persisted + moderator queue entry + emergency-contact email through the MOCK
    // transport (NOTIFICATION_ATTEMPT rows, ADR-011), retry on injected failure, dead-letter
    // visible in GET /api/moderation/alerts.
    const res = await request(app)
      .post('/api/bookings/00000000-0000-4000-8000-000000000001/safety-alerts')
      .send({ reason: 'test' });
    expect(res.status).toBe(404);
    const alerts = await request(app).get('/api/moderation/alerts');
    expect(alerts.status).toBe(404);
  });

  test('FR-07 substrate present: safety-alert email templates + transport row recording', async () => {
    expect(sendgrid.EMAIL_SUBJECTS['safety-alert-emergency']).toBeTruthy();
    expect(sendgrid.EMAIL_SUBJECTS['safety-alert-moderator']).toBeTruthy();
    const rendered = sendgrid.renderEmail('safety-alert-emergency', { alertId: 'abc' });
    expect(rendered.subject).toMatch(/safety alert/i);
  });
});
