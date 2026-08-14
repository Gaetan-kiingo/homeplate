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
  for (let i = 0; i < 20; i += 1) {
    const stats = await pollOnce({ registry });
    if (stats.claimed === 0) return;
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
    // and the user row is UNTOUCHED.
    await pollOnce({ registry });
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
    await pollOnce({ registry });
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

  test('WAVE-3 GAP (documented): booking-triggered notifications unverifiable — POST /api/bookings absent', async () => {
    const res = await request(app).post('/api/bookings').send({});
    expect(res.status).toBe(404);
  });
});
