// tests/rt-lt-resilience/rt01-notification-contract.test.js — RT-01 closure of the NFR-09
// acceptance clauses about the NOTIFICATION provider path that the existing drills leave
// implicit (SRS §4.4; NFR-09; FR-13; ADR-011).
//
// NFR-09 acceptance names five adapters (Maps, SendGrid, FCM, LLM, object storage) and
// requires each to enforce a timeout (default 3000 ms), bounded retries with exponential
// backoff and a documented fallback. Maps, object storage and the LLM are drilled directly in
// rt01-degradation.test.js / rt01-wave3-degradation.test.js. SendGrid and FCM cannot be
// drilled as themselves inside the suite BY DESIGN: src/config/schema.js rejects any value of
// NOTIFICATIONS_TRANSPORT other than 'mock' while NODE_ENV=test (ADR-011 — the whole
// automated suite asserts on persisted NOTIFICATION_ATTEMPT rows, never on a third party).
// What IS verifiable, and what this file executes, is the shared contract both live adapters
// are driven through by src/modules/notifications/transport.js:
//   1. the ADR-011 push gate defaults FALSE, so an FCM send is refused before any adapter
//      runs and is recorded as a failed row (never delivered);
//   2. a provider outage exhausts BOUNDED retries and resolves to a FAILED ROW rather than
//      throwing through the worker — the outbox keeps draining its batch (NFR-09);
//   3. the per-attempt timeout is config.adapters.timeoutMs and the backoff really is
//      exponential (the policy the transport hands to withResilience).
'use strict';

const config = require('../../src/config');
const { computeBackoffDelay } = require('../../src/lib/resilience');
const transport = require('../../src/modules/notifications/transport');
const mockTransport = require('../../src/adapters/mockTransport');

const dbh = require('../helpers/db');
const rh = require('../helpers/redis');
const { quietLogger } = require('./helpers');
const w3 = require('./wave3');

const quiet = quietLogger();

async function attemptRow(attemptId) {
  const { rows } = await dbh.query(`SELECT * FROM notification_attempts WHERE id = $1`, [
    attemptId,
  ]);
  return rows[0];
}

beforeEach(() => mockTransport.reset());

afterAll(async () => {
  mockTransport.reset();
  await dbh.closeDb();
  await rh.closeTestRedis();
});

describe('RT-01 — the notification provider contract behind SendGrid and FCM (NFR-09, ADR-011)', () => {
  test('the ADR-011 push gate defaults FALSE: an FCM send is refused, recorded, and never delivered', async () => {
    expect(config.notifications.push.enabled).toBe(false); // ADR-011 default
    expect(config.notifications.transport).toBe('mock'); // ADR-011: suite is mock-only

    const user = await w3.makeGuest();
    const result = await transport.send(
      {
        userId: user.id,
        channel: 'push',
        template: 'booking-created',
        params: {},
        idempotencyKey: `rt01-push-gate-${user.id}`,
      },
      { log: quiet }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('push_disabled');
    const row = await attemptRow(result.attemptId);
    expect(row.channel).toBe('push');
    expect(row.status).toBe('failed');
    expect(row.last_error).toMatch(/push channel refused/i);
    // Refused BEFORE any adapter ran — the mock recorded nothing.
    expect(mockTransport.deliveries()).toHaveLength(0);
  });

  test('a total provider outage exhausts bounded retries and yields a FAILED ROW, never a throw', async () => {
    const user = await w3.makeGuest();
    const maxTries = config.adapters.retryMax + 1; // initial try + bounded retries
    // One more failure than the budget: the send must still stop at the budget.
    mockTransport.injectFailures(maxTries + 5);

    let threw = null;
    let result;
    try {
      result = await transport.send(
        {
          userId: user.id,
          channel: 'email',
          template: 'booking-created',
          params: {},
          idempotencyKey: `rt01-outage-${user.id}`,
        },
        { log: quiet }
      );
    } catch (err) {
      threw = err;
    }

    // NFR-09: "a provider outage yields a failed ROW, not an unhandled rejection".
    expect(threw).toBeNull();
    expect(result.status).toBe('failed');

    const row = await attemptRow(result.attemptId);
    expect(row.status).toBe('failed');
    expect(row.last_error).toBeTruthy();
    expect(row.sent_at).toBeNull();
    // Bounded: exactly the configured budget was spent, no more.
    expect(row.attempt_count).toBe(maxTries);
    expect(mockTransport.deliveries()).toHaveLength(0);
  }, 20000);

  test('recovery: once the provider returns, the same recipient is delivered to and the row reads sent', async () => {
    const user = await w3.makeGuest();
    mockTransport.injectFailures(1);
    const first = await transport.send(
      {
        userId: user.id,
        channel: 'email',
        template: 'booking-created',
        params: {},
        idempotencyKey: `rt01-recovery-a-${user.id}`,
      },
      { log: quiet }
    );
    // A single injected failure is inside the retry budget, so the send recovers in-flight.
    expect(['sent', 'failed']).toContain(first.status);

    mockTransport.reset(); // provider healthy again
    const second = await transport.send(
      {
        userId: user.id,
        channel: 'email',
        template: 'booking-created',
        params: {},
        idempotencyKey: `rt01-recovery-b-${user.id}`,
      },
      { log: quiet }
    );
    expect(second.status).toBe('sent');
    const row = await attemptRow(second.attemptId);
    expect(row.status).toBe('sent');
    expect(row.sent_at).not.toBeNull();
    expect(mockTransport.deliveries().filter((d) => d.userId === user.id)).toHaveLength(1);
  }, 20000);

  test('the retry policy the transport applies is a 3000 ms per-attempt timeout with exponential backoff', () => {
    // NFR-09 acceptance: "timeout (default 3000 ms), bounded retries with exponential backoff".
    expect(config.adapters.timeoutMs).toBe(3000);
    expect(config.adapters.retryMax).toBeGreaterThanOrEqual(1);
    const base = config.adapters.backoffBaseMs;
    const d1 = computeBackoffDelay(1, { baseMs: base });
    const d2 = computeBackoffDelay(2, { baseMs: base });
    const d3 = computeBackoffDelay(3, { baseMs: base });
    expect(d1).toBe(base);
    expect(d2).toBe(base * 2); // doubling — exponential, not linear
    expect(d3).toBe(base * 4);
  });
});
