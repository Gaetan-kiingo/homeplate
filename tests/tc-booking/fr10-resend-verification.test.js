// tests/tc-booking/fr10-resend-verification.test.js — regression proof for finding TCBV2-03
// (FR-10 had no recovery path: users.email_verified is written ONLY by consuming a raw token
// that arrives by email, and the only producer of a mailable link is the 'email.verification'
// outbox job. config.outbox.maxAttempts bounds the worker's retry budget, so a provider outage
// longer than that budget DEAD-LETTERS the job — after which the account could never be
// verified, the FR-09/NFR-06 eligibility policy returned EMAIL_UNVERIFIED forever, and
// POST /api/bookings and POST /api/listings were refused for that user permanently).
//
// What is proven here against the REAL app, the REAL outbox handler and the REAL transport:
//   1. FR-10 / NFR-09 — after the first job dead-letters, POST /api/auth/resend-verification
//      commits a FRESH token + a FRESH outbox row, the worker delivers a usable link, and the
//      account reaches email_verified = true (and can_reserve_seat = true).
//   2. ADR-001/003 — that request path enqueues and returns: token row and outbox row share
//      one xmin (ONE transaction, no dual write), the payload carries IDs only, and no
//      NOTIFICATION_ATTEMPT row exists until the worker runs (no adapter on the request path).
//   3. AB-05 — unknown address, already-verified account and soft-deleted account are
//      indistinguishable from a successful re-queue: always 202, and nothing is enqueued.
//   4. NFR-05 — the throttle is a SEPARATE counter from the login lockout, in both directions:
//      exhausting the resend budget never locks the owner out of login (an unauthenticated
//      account-lockout DoS if it did), and a login lockout never blocks the recovery path.
//   5. ADR-011 — the dev-loop half of the finding: under NODE_ENV=development the mock
//      transport asks for the render context and keeps the link on its in-memory record, while
//      under NODE_ENV=test it declares nothing and records nothing, so the ADR-003 "IDs only in
//      rows" assertions elsewhere in the suite stay exactly as strict as before.
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { query, closeDb } = require('../helpers/db');
const { redis, closeTestRedis } = require('../helpers/redis');
const config = require('../../src/config');
const dispatch = require('../../src/outbox/dispatch');
const mockTransport = require('../../src/adapters/mockTransport');
const rateLimit = require('../../src/modules/auth/rateLimit');
const authService = require('../../src/modules/auth/service');
const { logger } = require('../../src/lib/logger');

let app;
let emailSeq = 0;
function uniqueEmail() {
  emailSeq += 1;
  return `fr10resend-u${emailSeq}-${process.pid}-${Date.now()}@tcbooking.homeplate.invalid`;
}
const PASSWORD = 'Fr10-resend-pw!42';

/** Every 'email.verification' job belonging to ONE user — scoped so a parallel lane's rows
 *  can never influence this file's assertions (suite-determinism discipline). */
async function verificationJobs(userId) {
  const { rows } = await query(
    `SELECT * FROM outbox_jobs WHERE type = 'email.verification'
       AND payload->>'userId' = $1 ORDER BY id`,
    [userId]
  );
  return rows;
}

async function registerAndQueue() {
  const email = uniqueEmail();
  // fullName + phone so the NFR-06 eligibility policy has everything EXCEPT the verified
  // email: can_reserve_seat then flips on exactly the step this file is about.
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: PASSWORD, fullName: 'Resend Prober', phone: '+16195550142' });
  expect(res.status).toBe(201);
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  expect(rows).toHaveLength(1);
  const jobs = await verificationJobs(rows[0].id);
  expect(jobs).toHaveLength(1);
  return { email, user: rows[0], job: jobs[0] };
}

function ctxFor(job) {
  return {
    jobId: job.id,
    type: job.type,
    attempt: 1,
    correlationId: job.correlation_id,
    idempotencyKey: job.dedupe_key,
    log: logger.child({ correlationId: job.correlation_id }),
  };
}

/**
 * Run the real 'email.verification' handler while the ADR-011 mock adapter stands in for a
 * body-composing adapter (it declares requiresRenderContext exactly as src/adapters/sendgrid.js
 * does), and capture what the adapter received. Nothing is stubbed below the adapter seam.
 */
async function drainCapturingDelivery(job) {
  const handler = dispatch.loadHandlers({ log: logger }).get('email.verification');
  const realDeliver = mockTransport.adapter.deliver;
  const received = [];
  mockTransport.adapter.requiresRenderContext = true;
  mockTransport.adapter.deliver = async (input) => {
    received.push(input);
    return realDeliver(input);
  };
  try {
    const result = await handler.handle(job.payload, ctxFor(job));
    return { result, received };
  } finally {
    mockTransport.adapter.deliver = realDeliver;
    delete mockTransport.adapter.requiresRenderContext;
  }
}

/** The loopback per-IP resend counters this file's own HTTP requests increment. Cleared at
 *  both ends so neither a previous run nor this one can influence anything else. */
const LOOPBACK_RESEND_KEYS = ['127.0.0.1', '::ffff:127.0.0.1', '::1'].map((ip) =>
  rateLimit.resendIpKey(ip)
);

beforeAll(async () => {
  app = createApp();
  await redis.del(...LOOPBACK_RESEND_KEYS);
});

afterAll(async () => {
  await redis.del(...LOOPBACK_RESEND_KEYS);
  await closeDb();
  await closeTestRedis();
});

beforeEach(() => {
  mockTransport.reset();
});

describe('FR-10 / TCBV2-03 — a dead-lettered verification email no longer strands an account', () => {
  test('resend → fresh job → delivered link → email_verified = true', async () => {
    const { email, user, job } = await registerAndQueue();

    // The outage the finding describes: the first job exhausted config.outbox.maxAttempts.
    await query(
      `UPDATE outbox_jobs SET status = 'dead',
              last_error = 'fr10-resend test: simulated provider outage beyond the retry budget'
        WHERE id = $1`,
      [job.id]
    );
    expect((await verificationJobs(user.id))[0].status).toBe('dead');

    const res = await request(app).post('/api/auth/resend-verification').send({ email });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });

    const jobs = await verificationJobs(user.id);
    expect(jobs).toHaveLength(2);
    const fresh = jobs.find((j) => j.id !== job.id);
    expect(fresh.status).toBe('pending');
    // ADR-003: IDs only — exactly {userId, tokenHash}, and a NEW digest, so the dead-lettered
    // predecessor's dedupe key cannot suppress this delivery.
    expect(Object.keys(fresh.payload).sort()).toEqual(['tokenHash', 'userId']);
    expect(fresh.payload.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh.payload.tokenHash).not.toBe(job.payload.tokenHash);
    expect(fresh.dedupe_key).toBe(`email.verification:${fresh.payload.tokenHash}`);
    expect(JSON.stringify(fresh.payload)).not.toContain(email);

    // ADR-001: the token row and its outbox row were written by ONE transaction.
    const { rows: xmin } = await query(
      `SELECT (SELECT xmin::text FROM email_verification_tokens WHERE token_hash = $1) AS token_xmin,
              (SELECT xmin::text FROM outbox_jobs WHERE id = $2) AS job_xmin`,
      [fresh.payload.tokenHash, fresh.id]
    );
    expect(xmin[0].token_xmin).toBe(xmin[0].job_xmin);

    // ADR-001/003: no adapter ran on the request path — the worker has not gone yet.
    const { rows: attemptsBefore } = await query(
      'SELECT * FROM notification_attempts WHERE recipient_user_id = $1',
      [user.id]
    );
    expect(attemptsBefore).toHaveLength(0);

    // The worker delivers the re-queued job; the recipient can finally close FR-10.
    const { result, received } = await drainCapturingDelivery(fresh);
    expect(result.status).toBe('sent');
    expect(received).toHaveLength(1);
    const url = received[0].renderContext.verificationUrl;
    expect(url.startsWith(`${config.server.publicBaseUrl}/api/auth/verify-email?`)).toBe(true);
    const token = new URL(url).searchParams.get('token');

    const verified = await request(app).post('/api/auth/verify-email').send({ token });
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ emailVerified: true });

    const { rows } = await query(
      'SELECT email_verified, can_reserve_seat FROM users WHERE id = $1',
      [user.id]
    );
    expect(rows[0].email_verified).toBe(true);
    // FR-09 / NFR-06: the consequence chain the finding described is unblocked.
    expect(rows[0].can_reserve_seat).toBe(true);

    // §3.4 / ADR-003: closing the loop persisted no credential.
    const { rows: attemptsAfter } = await query(
      'SELECT * FROM notification_attempts WHERE recipient_user_id = $1',
      [user.id]
    );
    expect(attemptsAfter).toHaveLength(1);
    expect(JSON.stringify(attemptsAfter[0])).not.toContain(token);
  });

  test('unknown, already-verified and soft-deleted addresses answer 202 and enqueue nothing (AB-05)', async () => {
    // (a) No such account: 202, and no account is created by asking.
    const unknown = uniqueEmail();
    const r1 = await request(app).post('/api/auth/resend-verification').send({ email: unknown });
    expect(r1.status).toBe(202);
    expect(r1.body).toEqual({ accepted: true });
    expect((await query('SELECT id FROM users WHERE email = $1', [unknown])).rows).toHaveLength(0);

    // (b) Already verified: nothing to verify, so nothing is mailed — same 202.
    const verified = await registerAndQueue();
    await query('UPDATE users SET email_verified = true WHERE id = $1', [verified.user.id]);
    const r2 = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: verified.email });
    expect(r2.status).toBe(202);
    expect(r2.body).toEqual({ accepted: true });
    expect(await verificationJobs(verified.user.id)).toHaveLength(1); // registration's job only

    // (c) Soft-deleted account: same 202, still nothing enqueued (NFR-12 — a deleted account
    //     must not be re-activatable by mail).
    const deleted = await registerAndQueue();
    await query('UPDATE users SET deleted_at = now() WHERE id = $1', [deleted.user.id]);
    const r3 = await request(app)
      .post('/api/auth/resend-verification')
      .send({ email: deleted.email });
    expect(r3.status).toBe(202);
    expect(r3.body).toEqual({ accepted: true });
    expect(await verificationJobs(deleted.user.id)).toHaveLength(1);
  });
});

describe('FR-10 / NFR-05 — the resend throttle and the login lockout are independent counters', () => {
  test('exhausting the resend budget answers 429 + Retry-After and does NOT lock login', async () => {
    const { email } = await registerAndQueue();

    for (let i = 0; i < rateLimit.RESEND_MAX_ATTEMPTS; i += 1) {
      const ok = await request(app).post('/api/auth/resend-verification').send({ email });
      expect(ok.status).toBe(202);
    }
    const blocked = await request(app).post('/api/auth/resend-verification').send({ email });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // THE POINT: if this endpoint fed the login counters, any stranger could lock any account
    // out of login just by asking for verification emails.
    const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
  });

  test('a locked-out login does not block the recovery path', async () => {
    const { email, user } = await registerAndQueue();
    // A private IP counter: this test must not touch the loopback counter every other suite
    // shares (suite-determinism discipline).
    const ip = `fr10resend-${process.pid}-${Date.now()}`;

    for (let i = 0; i < config.auth.loginMaxAttempts; i += 1) {
      await rateLimit.recordFailure({ email, ip });
    }
    expect((await rateLimit.check({ email, ip })).limited).toBe(true);

    const out = await authService.resendVerificationEmail({ email, ip }, { log: logger });
    expect(out).toEqual({ enqueued: true });
    expect(await verificationJobs(user.id)).toHaveLength(2);
  });
});

describe('FR-10 / ADR-011 — the dev loop gets a link, the test suite still gets nothing', () => {
  test('NODE_ENV=development: the mock asks for render context and keeps the link in memory only', async () => {
    const originalEnv = process.env.NODE_ENV;
    const originalLevel = process.env.LOG_LEVEL;
    let devMock;
    try {
      process.env.NODE_ENV = 'development';
      process.env.LOG_LEVEL = 'silent'; // the dev branch prints the link; keep test output clean
      jest.isolateModules(() => {
        devMock = require('../../src/adapters/mockTransport');
      });
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalLevel === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = originalLevel;
    }

    expect(devMock.adapter.requiresRenderContext).toBe(true);
    await devMock.adapter.deliver({
      userId: '00000000-0000-4000-8000-000000000001',
      channel: 'email',
      template: 'email.verification',
      params: { userId: '00000000-0000-4000-8000-000000000001', tokenHash: 'a'.repeat(64) },
      renderContext: {
        verificationUrl: 'https://localhost:3443/api/auth/verify-email?token=dev-loop-token',
        expiresAt: new Date().toISOString(),
      },
    });
    const [devRecord] = devMock.deliveries();
    expect(devRecord.renderContext.verificationUrl).toContain('token=dev-loop-token');
    devMock.reset();

    // …while the ambient NODE_ENV=test adapter declares nothing and records nothing, so the
    // suite's stronger property holds: on the mock path no credential is minted at all unless
    // a test opts in itself (as drainCapturingDelivery above does).
    expect(config.isTest).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(mockTransport.adapter, 'requiresRenderContext')
    ).toBe(false);
    await mockTransport.adapter.deliver({
      userId: '00000000-0000-4000-8000-000000000002',
      channel: 'email',
      template: 'email.verification',
      params: {},
      renderContext: { verificationUrl: 'https://example.invalid/?token=must-not-be-recorded' },
    });
    expect(mockTransport.deliveries()[0].renderContext).toBeUndefined();
  });
});
