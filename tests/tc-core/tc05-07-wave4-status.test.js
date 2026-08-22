// tests/tc-core/tc05-07-wave4-status.test.js — verifier lane "tc-core": TC-05..TC-07 status
// probes for FR-05 (reviews), FR-06 (messaging), FR-07 (safety alerts).
//
// Wave 3 built listings/search/hosts/bookings only; reviews, messaging, moderation and safety
// land in wave 4 (build-plan §7: FR-05/06/07 remain `not_implemented`, never skipped/failed).
// This suite therefore:
//
//   1. PROVES BY EXECUTION the wave-4 status of every FR-05..FR-07 endpoint — originally each
//      probe asserted src/modules/<name>/routes.js was not on disk and that the live app
//      answered the structured JSON 404 envelope (NFR-08). The paths nest under /api/bookings,
//      which IS mounted since wave 3 — multi-segment suffixes like /:id/reviews match none of
//      the bookings router's routes and fall through to the module that declares them (or,
//      before it landed, to the registry 404).
//      When a wave-4 module lands, the routes.js-absence assertion fails LOUDLY, telling this
//      lane to replace the probes with the real TC-05..TC-07 acceptance tests. FR-07 made
//      that transition first (U4-SAFETY → tc07-safety.test.js), FR-05 followed in wave 4B
//      (U4-REVIEWS → tc05-reviews.test.js), and FR-06 completed the set in wave 4C:
//      U4-MESSAGING shipped, so its probe now asserts the mounted, session-gated surface
//      and the acceptance test lives in tc06-messaging.test.js. No absence probe remains —
//      every FR-05..FR-07 surface is landed and its probe converted (build-plan §4
//      probe-conversion rule).
//
//   2. PROVES the §3.4 schema substrate for FR-05..FR-07 holds its invariants against the
//      real database (SRS §4.1):
//        FR-05 — reviews rating CHECK 1..5, one-review-per-(booking,author) UNIQUE (max two,
//                one per direction), moderation_status defaults 'pending' (FR-08 gate).
//        FR-06 — messages persist FK'd to a booking; moderation_status defaults 'pending'
//                as the ADR-002 async-scan state (delivery never waits on it).
//        FR-07 — safety_alerts rows persist with delivery_status defaulting 'pending';
//                notification_attempts (ADR-011 assert-on-rows table) exists.
//
// This file supersedes tc-core-wave-status.test.js: its TC-01..TC-04 probes were replaced by
// the real acceptance suites tc01-search / tc02-listing-detail / tc03-host-profile /
// tc04-completion in this run, exactly as that file's own header instructed.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { createLogger } = require('../../src/lib/logger');
const { createApp } = require('../../src/app');
const {
  makeUser,
  makeBooking,
  insertRow,
  countRows,
  withRollback,
  closeDb,
} = require('../helpers/db');

const MODULES_DIR = path.join(__dirname, '..', '..', 'src', 'modules');
const SOME_UUID = '00000000-0000-4000-8000-000000000000';

/** "No route mounted here": structured JSON 404 envelope, never HTML (NFR-08). */
function expectStructuredNotFound(res) {
  expect(res.status).toBe(404);
  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(res.body).toHaveProperty('error.code', 'NOT_FOUND');
  expect(res.body.error).toHaveProperty('correlationId');
  expect(JSON.stringify(res.body)).not.toMatch(/<html|at\s+\S+\s+\(/i);
}

let app;

beforeAll(() => {
  app = createApp({ logger: createLogger({ level: 'silent' }) });
});

afterAll(async () => {
  await closeDb();
});

// ------------------------------------------------------------------------------------------
// 1. FR-05..FR-07 endpoint surface — all landed in wave 4, proven live.
// ------------------------------------------------------------------------------------------
describe('FR-05..FR-07 endpoint surface (wave 4 landed)', () => {
  test('TC-05 / FR-05 — the review endpoint HAS landed (U4-REVIEWS); probe replaced', async () => {
    // This probe used to assert the FR-05 surface was absent. U4-REVIEWS landed it, so per
    // this file's header the real acceptance test now lives in tests/tc-core/tc05-reviews.test.js
    // (with the service/repo/schema legs in tests/unit/reviews.test.js). What remains here is
    // the boundary fact that the path is mounted and session-gated (401, not 404), which is
    // what distinguishes "implemented" from "still missing" for the wave-4 status sweep.
    expect(fs.existsSync(path.join(MODULES_DIR, 'reviews', 'routes.js'))).toBe(true);
    const res = await request(app)
      .post(`/api/bookings/${SOME_UUID}/reviews`)
      .send({ rating: 5, comment: 'probe' });
    expect(res.status).toBe(401);
    // …while nothing mounts a public collection at /api/reviews (build-plan §4B: approved
    // reviews are read through the EXISTING hosts/listings read paths only).
    expectStructuredNotFound(await request(app).get('/api/reviews'));
  });

  test('TC-06 / FR-06 — the booking-messages endpoints HAVE landed (U4-MESSAGING); probe replaced', async () => {
    // This probe used to assert the FR-06 surface was absent. U4-MESSAGING landed it, so per
    // this file's header the real acceptance test now lives in tests/tc-core/
    // tc06-messaging.test.js (with the service/repo/schema legs in tests/unit/
    // messaging.test.js). What remains here is the boundary fact that BOTH verbs are mounted
    // and session-gated (401, not 404), which is what distinguishes "implemented" from
    // "still missing" for the wave-4 status sweep.
    expect(fs.existsSync(path.join(MODULES_DIR, 'messaging', 'routes.js'))).toBe(true);
    const post = await request(app)
      .post(`/api/bookings/${SOME_UUID}/messages`)
      .send({ body: 'probe' });
    expect(post.status).toBe(401);
    const get = await request(app).get(`/api/bookings/${SOME_UUID}/messages`);
    expect(get.status).toBe(401);
    // …while nothing mounts a collection at /api/messaging (build-plan §4C: the thread is
    // an object ON A BOOKING; there is no standalone messaging noun, and no moderator
    // thread-reading route exists beyond the moderation queue — NFR-13).
    expectStructuredNotFound(await request(app).get('/api/messaging'));
  });

  test('TC-07 / FR-07 — the safety-alert endpoints HAVE landed (U4-SAFETY); probes replaced', async () => {
    // This probe used to assert the FR-07 surface was absent. U4-SAFETY landed it, so per this
    // file's header the real acceptance test now lives in tests/tc-core/tc07-safety.test.js and
    // the worker legs in tests/it-adapters/it04-safety-delivery.test.js. What remains here is
    // the boundary fact that both paths are mounted and session-gated (401, not 404), which is
    // what distinguishes "implemented" from "still missing" for the wave-4 status sweep.
    expect(fs.existsSync(path.join(MODULES_DIR, 'safety', 'routes.js'))).toBe(true);
    const post = await request(app).post(`/api/bookings/${SOME_UUID}/safety-alerts`).send({});
    expect(post.status).toBe(401);
    const alerts = await request(app).get('/api/moderation/alerts');
    expect(alerts.status).toBe(401);
  });
});

// ------------------------------------------------------------------------------------------
// 2. §3.4 schema substrate for FR-05..FR-07 — invariants proven on the DB.
// ------------------------------------------------------------------------------------------
describe('FR-05 substrate — reviews invariants', () => {
  test('rating outside 1..5 refused; new review defaults moderation pending; one review per author per booking, two per booking max', async () => {
    await withRollback(async (client) => {
      const booking = await makeBooking(
        {
          status: 'completed',
          host_confirmed_completion: true,
          guest_confirmed_completion: true,
        },
        client
      );
      const author = await makeUser({}, client);
      const target = await makeUser({}, client);

      for (const badRating of [0, 6]) {
        await client.query('SAVEPOINT sp');
        await expect(
          insertRow(
            'reviews',
            {
              booking_id: booking.id,
              author_id: author.id,
              target_user_id: target.id,
              rating: badRating,
              body: 'probe',
            },
            client
          )
        ).rejects.toMatchObject({ code: '23514' });
        await client.query('ROLLBACK TO SAVEPOINT sp');
      }

      const review = await insertRow(
        'reviews',
        {
          booking_id: booking.id,
          author_id: author.id,
          target_user_id: target.id,
          rating: 5,
          body: 'probe',
        },
        client
      );
      expect(review.moderation_status).toBe('pending'); // FR-05/FR-08 gate

      await client.query('SAVEPOINT sp3');
      await expect(
        insertRow(
          'reviews',
          {
            booking_id: booking.id,
            author_id: author.id,
            target_user_id: target.id,
            rating: 4,
            body: 'dup',
          },
          client
        )
      ).rejects.toMatchObject({ code: '23505', constraint: 'reviews_one_per_booking_author' });
      await client.query('ROLLBACK TO SAVEPOINT sp3');

      // The OTHER direction (target reviews author) is allowed — two per booking max.
      const reverse = await insertRow(
        'reviews',
        {
          booking_id: booking.id,
          author_id: target.id,
          target_user_id: author.id,
          rating: 3,
          body: 'reverse',
        },
        client
      );
      expect(reverse.moderation_status).toBe('pending');
    });
  });
});

describe('FR-06 substrate — messages persist against a booking', () => {
  test('a message row persists FK-bound to its booking with async-scan state pending (ADR-002)', async () => {
    await withRollback(async (client) => {
      const booking = await makeBooking({}, client);
      const sender = await makeUser({}, client);
      const message = await insertRow(
        'messages',
        { booking_id: booking.id, sender_id: sender.id, body: 'Is the meal vegetarian?' },
        client
      );
      expect(message.id).toBeTruthy();
      expect(message.booking_id).toBe(booking.id);
      expect(message.moderation_status).toBe('pending');

      await client.query('SAVEPOINT sp');
      await expect(
        insertRow(
          'messages',
          { booking_id: SOME_UUID, sender_id: sender.id, body: 'orphan' },
          client
        )
      ).rejects.toMatchObject({ code: '23503' });
      await client.query('ROLLBACK TO SAVEPOINT sp');
    });
  });
});

describe('FR-07 substrate — safety_alerts and notification_attempts', () => {
  test('a safety alert persists with delivery_status defaulting to pending', async () => {
    await withRollback(async (client) => {
      const booking = await makeBooking({}, client);
      const raiser = await makeUser({}, client);
      const alert = await insertRow(
        'safety_alerts',
        { booking_id: booking.id, raised_by: raiser.id },
        client
      );
      expect(alert.delivery_status).toBe('pending');
      expect(alert.delivered_at).toBeNull();
    });
  });

  test('notification_attempts (ADR-011 assert-on-rows substrate) exists and is queryable', async () => {
    await expect(countRows('notification_attempts')).resolves.toEqual(expect.any(Number));
  });
});
