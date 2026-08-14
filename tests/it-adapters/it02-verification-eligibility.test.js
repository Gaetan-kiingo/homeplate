// tests/it-adapters/it02-verification-eligibility.test.js — IT-02 (SRS §4.2 / Appendix B):
// NFR-06 integration across Email Verification and the Eligibility Policy Service, driven
// end-to-end through the REAL deferred-work path: register → outbox row → worker →
// notification transport (mock, ADR-011) → persisted NOTIFICATION_ATTEMPT → verify-email →
// eligibility recomputation on profile mutation.
//
// Requirement traceability (SRS Appendix B):
//   NFR-06 (IT-02) — eligibility flags recomputed and persisted on registration, email
//        verification and profile update; flags always equal the single policy's answer
//   FR-10 (TC-10)  — the verification email is delivered by the WORKER through the
//        transport, never on the request path (ADR-001/003)
//   ADR-011        — assertions on NOTIFICATION_ATTEMPT rows, never on a provider
'use strict';

const request = require('supertest');

const { createApp } = require('../../src/app');
const authService = require('../../src/modules/auth/service');
const policy = require('../../src/modules/eligibility/policy');
const { loadHandlers } = require('../../src/outbox/dispatch');
const { pollOnce } = require('../../src/outbox/worker');
const notifRepo = require('../../src/modules/notifications/repo');
const mockTransport = require('../../src/adapters/mockTransport');
const dbh = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');

const PASSWORD = 'correct-horse-battery-staple-9!';
const quietLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() {
    return this;
  },
};

let app;
let registry;

beforeAll(() => {
  app = createApp();
  registry = loadHandlers({ log: quietLog });
});

beforeEach(() => {
  mockTransport.reset();
});

afterAll(async () => {
  mockTransport.reset();
  await dbh.query(`DELETE FROM users WHERE email LIKE '%@it02.homeplate.invalid'`);
  await dbh.closeDb();
  await closeTestRedis();
});

async function drainOutbox() {
  // Drain every ready job (the verification email plus anything siblings enqueued).
  let stats;
  let total = 0;
  do {
    stats = await pollOnce({ registry, log: quietLog });
    total += stats.claimed;
  } while (stats.claimed > 0);
  return total;
}

test('IT-02: register → worker delivers verification email → verify → eligibility flips with the policy', async () => {
  const email = `it02.${Date.now()}@it02.homeplate.invalid`;

  // 1. Register (service-level so the single-use raw token is observable; the HTTP route
  //    deliberately never returns it). The outbox row commits with the USER row (ADR-001).
  const { user, verification } = await authService.register(
    { email, password: PASSWORD },
    { log: quietLog }
  );
  expect(user.email_verified ?? user.emailVerified ?? false).toBe(false);

  // 2. No adapter ran on the request path: the attempt row appears only after the WORKER polls.
  expect(await notifRepo.listForUser(user.id)).toHaveLength(0);
  await drainOutbox();
  const attempts = await notifRepo.listForUser(user.id);
  expect(attempts).toHaveLength(1);
  expect(attempts[0].channel).toBe('email');
  expect(attempts[0].template).toBe('email.verification');
  expect(attempts[0].status).toBe('sent');
  // ADR-003/§3.4: rows carry IDs/digests only — never the address or the raw token.
  const rowText = JSON.stringify(attempts[0]);
  expect(rowText).not.toContain(email);
  expect(rowText).not.toContain(verification.rawToken);
  expect(attempts[0].params.tokenHash).toMatch(/^[0-9a-f]{64}$/);

  // 3. Before verification: not eligible, reason EMAIL_UNVERIFIED (single policy, NFR-06).
  const before = await policy.evaluate(user.id, 'reserve_seat');
  expect(before.allowed).toBe(false);
  expect(before.reasons).toContain('EMAIL_UNVERIFIED');
  let row = (await dbh.query('SELECT * FROM users WHERE id = $1', [user.id])).rows[0];
  expect(row.can_reserve_seat).toBe(before.allowed); // persisted flag equals policy answer

  // 4. Verify over HTTP with the single-use token.
  const verifyRes = await request(app)
    .post('/api/auth/verify-email')
    .send({ token: verification.rawToken });
  expect(verifyRes.status).toBe(200);
  row = (await dbh.query('SELECT * FROM users WHERE id = $1', [user.id])).rows[0];
  expect(row.email_verified).toBe(true);

  // 5. Still missing name+phone → still not eligible, with exactly those machine reasons.
  const midway = await policy.evaluate(user.id, 'reserve_seat');
  expect(midway.allowed).toBe(false);
  expect(midway.reasons.sort()).toEqual(['NAME_MISSING', 'PHONE_MISSING']);
  expect(row.can_reserve_seat).toBe(midway.allowed);

  // 6. Complete the profile through the real HTTP surface (login → PATCH /api/users/me).
  const loginRes = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  expect(loginRes.status).toBe(200);
  const cookie = loginRes.headers['set-cookie'];
  expect(cookie).toBeTruthy();

  const patchRes = await request(app)
    .patch('/api/users/me')
    .set('Cookie', cookie)
    .send({ fullName: 'IT Two Tester', phone: '+16195550142' });
  expect(patchRes.status).toBe(200);
  expect(patchRes.body.user.canReserveSeat).toBe(true);

  // 7. Persisted flags equal the single policy's verdict after the mutation (NFR-06).
  const after = await policy.evaluate(user.id, 'reserve_seat');
  expect(after.allowed).toBe(true);
  row = (await dbh.query('SELECT * FROM users WHERE id = $1', [user.id])).rows[0];
  expect(row.can_reserve_seat).toBe(true);
  expect(row.can_publish_listing).toBe((await policy.evaluate(user.id, 'publish_listing')).allowed);

  // 8. A wrong token never verifies and is single-use (FR-10).
  const replay = await request(app)
    .post('/api/auth/verify-email')
    .send({ token: verification.rawToken });
  expect(replay.status).toBe(400);
});

test('IT-02 degraded (NFR-09): provider outage leaves the job queued; delivery completes after recovery', async () => {
  const email = `it02.retry.${Date.now()}@it02.homeplate.invalid`;
  const { user } = await authService.register({ email, password: PASSWORD }, { log: quietLog });

  // Outage: the transport exhausts its bounded retries, the handler throws, the outbox
  // job stays queued for redelivery — deferred, never dropped (NFR-09/ADR-001).
  mockTransport.injectFailures(20);
  await pollOnce({ registry, log: quietLog });
  let attempts = await notifRepo.listForUser(user.id);
  expect(attempts).toHaveLength(1);
  expect(attempts[0].status).toBe('failed');
  const job = (
    await dbh.query(
      `SELECT * FROM outbox_jobs WHERE type = 'email.verification'
       AND payload->>'userId' = $1`,
      [user.id]
    )
  ).rows[0];
  expect(job).toBeTruthy();
  expect(job.status).toBe('pending'); // still claimable — deferred, not dropped

  // Recovery: make the job immediately claimable again, clear the injected failures, poll.
  mockTransport.reset();
  await dbh.query(`UPDATE outbox_jobs SET available_at = now() WHERE id = $1`, [job.id]);
  await drainOutbox();
  attempts = await notifRepo.listForUser(user.id);
  expect(attempts).toHaveLength(1); // idempotency key reuses the SAME row (no duplicate)
  expect(attempts[0].status).toBe('sent');
  expect(mockTransport.deliveries()).toHaveLength(1);
});
