// tests/tc-core — verifier lane "tc-core": TC-01..TC-07 covering FR-01..FR-07
// (discovery, listing detail, host profile, meal completion, reviews, messaging, safety alert).
//
// BUILD-WAVE STATUS PROBES. This run built waves 1-2 only (foundation + platform services);
// the marketplace modules that implement FR-01..FR-07 (listings, search, hosts, bookings,
// reviews, messaging, moderation, safety) land in waves 3-4. This suite therefore:
//
//   1. PROVES BY EXECUTION that every FR-01..FR-07 endpoint is currently absent — each probe
//      first asserts src/modules/<name>/routes.js is not on disk, then asserts the live app
//      answers the endpoint with the structured JSON 404 envelope (NFR-08: JSON error, never
//      HTML; correlation ID present). If a wave-3 module lands, the routes.js-absence
//      assertion fails LOUDLY, telling the tc-core lane to replace these probes with the
//      real TC-01..TC-07 acceptance tests from requirements-inventory.json.
//
//   2. PROVES the §3.4 schema substrate wave 1 already shipped for these requirements holds
//      its invariants against the real database (SRS §4.1: Jest + seeded test DB):
//        FR-04 — bookings_completed_requires_both_confirmations CHECK: single confirmation
//                can NEVER yield status='completed'; both flags can.
//        FR-05 — reviews rating CHECK 1..5, one-review-per-(booking,author) UNIQUE,
//                moderation_status defaults to 'pending' (stays pending until FR-08 approval).
//        FR-06 — messages row persists FK'd to a booking; moderation_status defaults
//                'pending' as the ADR-002 async-scan state (delivery never waits on it).
//        FR-07 — safety_alerts row persists with delivery_status defaulting 'pending';
//                notification_attempts (ADR-011 assert-on-rows table) exists.
//
// No application source is touched; this lane owns tests/tc-core only.
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
// Any syntactically valid UUID works for absent-route probes — the 404 must come from the
// route registry (no module mounted), not from a handler's not-found branch.
const SOME_UUID = '00000000-0000-4000-8000-000000000000';

/** Fails loudly when a wave-3/4 module has landed: these probes must then be replaced. */
function assertModuleStillAbsent(name) {
  const routesPath = path.join(MODULES_DIR, name, 'routes.js');
  if (fs.existsSync(routesPath)) {
    throw new Error(
      `src/modules/${name}/routes.js now exists — the wave has landed. Replace the ` +
        'tc-core wave-status probes with the real TC acceptance tests for this module.'
    );
  }
}

/** Common assertions for "endpoint not implemented yet": structured JSON 404, never HTML. */
function expectStructuredNotFound(res) {
  expect(res.status).toBe(404);
  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(res.body).toHaveProperty('error.code', 'NOT_FOUND');
  expect(res.body.error).toHaveProperty('correlationId');
  // NFR-08: no HTML error page, no stack trace in the body.
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
// 1. FR-01..FR-07 endpoint surface — not implemented in waves 1-2 (by plan), proven live.
// ------------------------------------------------------------------------------------------
describe('FR-01..FR-07 endpoint surface (waves 3-4 pending)', () => {
  test('TC-01 / FR-01 — GET /api/listings/search is not implemented yet', async () => {
    assertModuleStillAbsent('search');
    assertModuleStillAbsent('listings');
    const res = await request(app).get('/api/listings/search').query({ cuisine: 'test' });
    expectStructuredNotFound(res);
  });

  test('TC-02 / FR-02 — GET /api/listings/:id is not implemented yet', async () => {
    assertModuleStillAbsent('listings');
    const res = await request(app).get(`/api/listings/${SOME_UUID}`);
    expectStructuredNotFound(res);
  });

  test('TC-03 / FR-03 — GET /api/hosts/:id is not implemented yet', async () => {
    assertModuleStillAbsent('hosts');
    const res = await request(app).get(`/api/hosts/${SOME_UUID}`);
    expectStructuredNotFound(res);
  });

  test('TC-04 / FR-04 — POST /api/bookings/:id/confirm-completion is not implemented yet', async () => {
    assertModuleStillAbsent('bookings');
    const res = await request(app).post(`/api/bookings/${SOME_UUID}/confirm-completion`).send({});
    expectStructuredNotFound(res);
  });

  test('TC-05 / FR-05 — POST /api/bookings/:id/reviews is not implemented yet', async () => {
    assertModuleStillAbsent('reviews');
    const res = await request(app)
      .post(`/api/bookings/${SOME_UUID}/reviews`)
      .send({ rating: 5, comment: 'probe' });
    expectStructuredNotFound(res);
  });

  test('TC-06 / FR-06 — booking messages endpoints are not implemented yet', async () => {
    assertModuleStillAbsent('messaging');
    const post = await request(app)
      .post(`/api/bookings/${SOME_UUID}/messages`)
      .send({ body: 'probe' });
    expectStructuredNotFound(post);
    const get = await request(app).get(`/api/bookings/${SOME_UUID}/messages`);
    expectStructuredNotFound(get);
  });

  test('TC-07 / FR-07 — safety-alert endpoints are not implemented yet', async () => {
    assertModuleStillAbsent('safety');
    assertModuleStillAbsent('moderation');
    const post = await request(app).post(`/api/bookings/${SOME_UUID}/safety-alerts`).send({});
    expectStructuredNotFound(post);
    const alerts = await request(app).get('/api/moderation/alerts');
    expectStructuredNotFound(alerts);
  });
});

// ------------------------------------------------------------------------------------------
// 2. §3.4 schema substrate already shipped for FR-04..FR-07 — invariants proven on the DB.
// ------------------------------------------------------------------------------------------
describe('FR-04 substrate — dual-confirmation CHECK (bookings)', () => {
  test('a single confirmation can never produce status=completed', async () => {
    // Host-only confirmation refused by the database.
    await withRollback(async (client) => {
      const booking = await makeBooking({ status: 'in_progress' }, client);
      await client.query('SAVEPOINT sp');
      await expect(
        client.query(
          `UPDATE bookings
             SET status = 'completed', host_confirmed_completion = true
           WHERE id = $1`,
          [booking.id]
        )
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'bookings_completed_requires_both_confirmations',
      });
      await client.query('ROLLBACK TO SAVEPOINT sp');

      // Guest-only confirmation refused too.
      await client.query('SAVEPOINT sp2');
      await expect(
        client.query(
          `UPDATE bookings
             SET status = 'completed', guest_confirmed_completion = true
           WHERE id = $1`,
          [booking.id]
        )
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT sp2');

      // Both confirmations: completed is accepted.
      const { rows } = await client.query(
        `UPDATE bookings
           SET status = 'completed',
               host_confirmed_completion = true,
               guest_confirmed_completion = true
         WHERE id = $1
         RETURNING status, host_confirmed_completion, guest_confirmed_completion`,
        [booking.id]
      );
      expect(rows[0]).toEqual({
        status: 'completed',
        host_confirmed_completion: true,
        guest_confirmed_completion: true,
      });
    });
  });
});

describe('FR-05 substrate — reviews invariants', () => {
  test('rating outside 1..5 is refused; valid review defaults to moderation pending; one review per author per booking', async () => {
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
      // FR-05/FR-08: a new review is pending until moderation approves it.
      expect(review.moderation_status).toBe('pending');

      // Second review by the SAME author on the same booking: refused (unique).
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
      // ADR-002: this column is the asynchronous scan state — delivery never waits on it.
      expect(message.moderation_status).toBe('pending');

      // A message may not reference a nonexistent booking (FK enforced).
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
    // FR-07's delivery evidence in the automated suite is NOTIFICATION_ATTEMPT rows, never
    // SendGrid's behaviour. The wave-4 flow will write here; today the table must exist.
    await expect(countRows('notification_attempts')).resolves.toEqual(expect.any(Number));
  });
});
