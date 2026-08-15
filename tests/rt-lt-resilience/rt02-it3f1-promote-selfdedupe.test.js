// tests/rt-lt-resilience/rt02-it3f1-promote-selfdedupe.test.js — RT-02 regression for the
// IT3-F1 residual: a 'booking.promote' job delivered EARLY while the listing's scheduled_start
// is UNCHANGED must not lose the promotion.
//
// Why this case and not the "start moved later" case already covered in
// rt02-wave3-outbox.test.js: when the start moves, the re-enqueue's dedupe key
// ('booking.promote:<bookingId>:<startMs>') differs from the delivered row's key, so a fresh
// row is created and nothing is lost. The dangerous case is the start being UNCHANGED — the
// re-enqueue reproduces the delivered row's own key, ON CONFLICT (dedupe_key) DO NOTHING
// collapses onto the row the worker is about to mark 'delivered', and the booking would stay
// 'pending' forever (FR-04 completion then 409s for both parties).
//
// Reachable in production without anything exotic: available_at <= now() is evaluated by
// PostgreSQL while startsAt > Date.now() is evaluated by Node, so DB/app clock skew alone
// delivers the row early; an operator requeue of a dead-lettered promote row does the same.
//
// Requirement traceability: FR-04 (meal completion depends on the booking reaching
// 'in_progress'), FR-12/FR-13 (booking lifecycle deferred work), NFR-09 (deferred work is
// never silently lost), ADR-001/003 (outbox is the only deferred-work mechanism).
'use strict';

const request = require('supertest');

const { createApp } = require('../../src/app');
const mockTransport = require('../../src/adapters/mockTransport');
const { pollOnce } = require('../../src/outbox/worker');
const { loadHandlers } = require('../../src/outbox/dispatch');

const dbh = require('../helpers/db');
const rh = require('../helpers/redis');
const { quietLogger } = require('./helpers');
const w3 = require('./wave3');

const quiet = quietLogger();
let app;
let registry;

async function promoteJobs(bookingId) {
  const { rows } = await dbh.query(
    `SELECT * FROM outbox_jobs
      WHERE type = 'booking.promote' AND payload->>'bookingId' = $1
      ORDER BY id`,
    [bookingId]
  );
  return rows;
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

describe('RT-02 / IT3-F1 — an early promote delivery with an UNCHANGED start keeps the schedule', () => {
  test('the delivered row does not swallow its own re-enqueue; a live pending row survives and later promotes', async () => {
    const { listing, bookingId } = await makeBookingViaApi();
    const startsAt = new Date(listing.scheduled_start);
    expect(startsAt.getTime()).toBeGreaterThan(Date.now()); // future start, as seeded

    const before = await promoteJobs(bookingId);
    expect(before).toHaveLength(1);
    const originalJob = before[0];
    expect(new Date(originalJob.available_at).getTime()).toBe(startsAt.getTime());

    // Silence the booking's notify jobs so pollOnce stats describe the promote row alone.
    await dbh.query(
      `UPDATE outbox_jobs SET status = 'delivered', delivered_at = now()
        WHERE status = 'pending' AND type <> 'booking.promote'`
    );

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
    const after = await promoteJobs(bookingId);
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
    await dbh.query(
      `UPDATE outbox_jobs SET status = 'delivered', delivered_at = now()
        WHERE status = 'pending' AND type <> 'booking.promote'`
    );

    // Three successive early deliveries of whatever row is currently live.
    for (let i = 0; i < 3; i += 1) {
      const live = (await promoteJobs(bookingId)).filter((j) => j.status === 'pending');
      expect(live).toHaveLength(1); // invariant after every cycle
      await dbh.query(`UPDATE outbox_jobs SET available_at = now() WHERE id = $1`, [live[0].id]);
      const stats = await pollOnce({ registry, log: quiet });
      expect(stats.delivered).toBe(1);
      expect(stats.deadLettered).toBe(0);
    }

    const live = (await promoteJobs(bookingId)).filter((j) => j.status === 'pending');
    expect(live).toHaveLength(1);
    expect(new Date(live[0].available_at).getTime()).toBe(startsAt.getTime());
    const { rows: booking } = await dbh.query(`SELECT status FROM bookings WHERE id = $1`, [
      bookingId,
    ]);
    expect(booking[0].status).toBe('pending'); // still not promoted early
  }, 30000);
});
