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
const { withOnlyTheseDue } = require('../helpers/outboxScope');
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

  const jobId = (
    await dbh.query(
      `SELECT id FROM outbox_jobs WHERE type = 'email.verification'
       AND payload->>'userId' = $1`,
      [user.id]
    )
  ).rows[0].id;

  // Outage: the transport exhausts its bounded retries, the handler throws, the outbox
  // job stays queued for redelivery — deferred, never dropped (NFR-09/ADR-001).
  // F-01 determinism: both worker passes below are scoped to THIS registration's job, so its
  // claim never depends on foreign pending rows sibling suites left in the shared table — and
  // the transport delivery count asserted after recovery counts only OUR delivery.
  mockTransport.injectFailures(20);
  await withOnlyTheseDue([jobId], () => pollOnce({ registry, log: quietLog }));
  let attempts = await notifRepo.listForUser(user.id);
  expect(attempts).toHaveLength(1);
  expect(attempts[0].status).toBe('failed');
  const job = (await dbh.query(`SELECT * FROM outbox_jobs WHERE id = $1`, [jobId])).rows[0];
  expect(job).toBeTruthy();
  expect(job.status).toBe('pending'); // still claimable — deferred, not dropped

  // Recovery: make the job immediately claimable again, clear the injected failures, poll.
  mockTransport.reset();
  await dbh.query(`UPDATE outbox_jobs SET available_at = now() WHERE id = $1`, [job.id]);
  await withOnlyTheseDue([jobId], () => drainOutbox());
  attempts = await notifRepo.listForUser(user.id);
  expect(attempts).toHaveLength(1); // idempotency key reuses the SAME row (no duplicate)
  expect(attempts[0].status).toBe('sent');
  expect(mockTransport.deliveries()).toHaveLength(1);
});

// ==============================================================================================
// FR-10 / TCB-W3-01 re-verification (moved from it02b-fr10-delivered-email.test.js, round 2).
//
// WHY THIS TEST EXISTS. Waves 1-2 reported FR-10 as PASS while the value the recipient would
// actually have received was a SHA-256 digest, not a usable link: every FR-10 test took the raw
// token from authService.register()'s IN-PROCESS return value (`verification.rawToken`), which a
// real user never sees, instead of from the message the delivery path composed. The IT-02 test
// above still does exactly that at step 4 — deliberately, because it is testing the eligibility
// policy, not the mail body. The blocker was invisible to it.
//
// This block closes that loop through the REAL production delivery path (outbox row -> worker
// handler -> transport -> the SendGrid adapter that composes the message body), lifts the URL out
// of the text the adapter handed the (faked) provider SDK, and verifies the account with THAT
// value only. Sibling regression proofs use lighter mechanisms — a recording adapter plus
// renderEmail in tests/rt-lt-resilience/rt02-fr10-delivered-token.test.js and renderContext
// capture in tests/tc-booking/fr10-verification-link.test.js — but only this test executes the
// byte-for-byte production composition chain end to end, which is the independence that caught
// TCB-W3-01 in the first place.
//
//   FR-10 (TC-10)  — a registered user can verify their email with the value actually delivered
//   ADR-001/003    — the link is minted worker-side; no persisted row or payload carries it
//   ADR-011        — no live provider: @sendgrid/mail is substituted with a `__fake` double and
//                    the adapter's own LIVE_PROVIDER_REFUSED_IN_TEST guard is left armed
// ==============================================================================================

/**
 * Load the FR-10 delivery stack in an ISOLATED jest registry configured for the LIVE email
 * transport, with @sendgrid/mail replaced by a double. Every module in the returned tree is a
 * fresh instance (its own config, its own pg pool, its own Redis client), so the ambient suite
 * stays on the ADR-011 mock transport; `dispose()` closes the isolated connections.
 *
 * The `__fake: true` marker is not decoration: src/adapters/sendgrid.js refuses to proceed under
 * NODE_ENV=test unless the SDK carries it (LIVE_PROVIDER_REFUSED_IN_TEST, finding IT-F4), so a
 * broken substitution fails the test instead of contacting SendGrid.
 */
function loadLiveEmailStack() {
  const sent = [];
  const saved = {};
  // NOTIFICATIONS_TRANSPORT is deliberately NOT touched: src/config/schema.js refuses a non-mock
  // transport under NODE_ENV=test with no escape hatch (ADR-011), and that guard is correct — so
  // this harness leaves the configuration alone and substitutes the ADR-011 mock ADAPTER with the
  // real SendGrid one inside the isolated registry. The composition path under test
  // (handler -> transport -> adapter.deliver -> renderEmail) is then byte-for-byte the production
  // one, while the ambient suite and its configuration stay on the mock.
  const env = {
    SENDGRID_API_KEY: 'SG.substituted-in-test',
    SENDGRID_FROM_EMAIL: 'no-reply@homeplate.test',
  };
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  jest.doMock('@sendgrid/mail', () => ({
    __fake: true,
    setApiKey: () => {},
    send: async (msg) => {
      sent.push(msg);
      return [{ headers: { 'x-message-id': `msg-it02b-${sent.length}` } }];
    },
  }));
  jest.doMock('../../src/adapters/mockTransport', () => {
    // eslint-disable-next-line global-require
    const sg = require('../../src/adapters/sendgrid');
    return {
      __substituted: 'sendgrid',
      adapter: sg.adapter,
      injectFailures: () => {},
      injectHangs: () => {},
      deliveries: () => [],
      reset: () => {},
    };
  });

  let loaded;
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      if (require('@sendgrid/mail').__fake !== true) {
        throw new Error('loadLiveEmailStack: @sendgrid/mail is not substituted — aborting');
      }
      /* eslint-disable global-require */
      const isoConfig = require('../../src/config');
      const handler = require('../../src/outbox/handlers/emailVerification');
      const pool = require('../../src/db/pool');
      const isoRedis = require('../../src/db/redis');
      /* eslint-enable global-require */
      loaded = {
        config: isoConfig,
        handler,
        sent,
        async dispose() {
          await pool.closePool();
          await isoRedis.closeRedis();
        },
      };
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return loaded;
}

/**
 * Un-register the module doubles. Deliberately NOT done in loadLiveEmailStack's finally block:
 * src/adapters/sendgrid.js requires @sendgrid/mail LAZILY, inside deliver(), so releasing the
 * double at load time lets the REAL SDK resolve at call time. (Verified: doing so made the
 * adapter's own ADR-011 guard fire with LIVE_PROVIDER_REFUSED_IN_TEST instead of reaching the
 * network — the finding IT-F4 fix working exactly as designed.)
 */
function releaseIsolatedMocks() {
  jest.dontMock('@sendgrid/mail');
  jest.dontMock('../../src/adapters/mockTransport');
  // dontMock drops the FACTORY but leaves the built double cached, so reset the registry too.
  jest.resetModules();
}

describe('FR-10 / TCB-W3-01 · the value the recipient actually receives is the value that verifies', () => {
  test('register -> worker delivery path -> the URL in the delivered body flips email_verified to true', async () => {
    const email = `it02b.${Date.now()}@it02.homeplate.invalid`;
    const { user, verification } = await authService.register(
      { email, password: PASSWORD },
      { log: quietLog }
    );
    expect(user.email_verified ?? user.emailVerified ?? false).toBe(false);

    // The outbox row is IDs/digests only (ADR-003): it cannot itself carry a mailable link.
    const { rows: jobs } = await dbh.query(
      `SELECT * FROM outbox_jobs WHERE type = 'email.verification' AND payload->>'userId' = $1`,
      [user.id]
    );
    const job = jobs[0];
    expect(job).toBeTruthy();
    expect(job.payload).toEqual({
      userId: user.id,
      tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(job.payload)).not.toContain(verification.rawToken);

    // Run the REAL handler through the REAL transport into the adapter that composes bodies.
    const stack = loadLiveEmailStack();
    let deliveredText;
    try {
      // ADR-011 stays intact: the CONFIGURATION is still the mock transport; only the adapter
      // object behind it was substituted, and it is the real production one.
      expect(stack.config.notifications.transport).toBe('mock');
      const result = await stack.handler.handle(
        { userId: user.id, tokenHash: job.payload.tokenHash },
        { log: quietLog, idempotencyKey: `email.verification:${job.payload.tokenHash}` }
      );
      expect(result.status).toBe('sent');
      expect(stack.sent).toHaveLength(1);
      expect(stack.sent[0].to).toBe(email);
      deliveredText = stack.sent[0].text;
    } finally {
      await stack.dispose();
      releaseIsolatedMocks();
    }

    // THE REGRESSION GUARD. Before the TCB-W3-01 fix the body carried the SHA-256 digest and
    // nothing else; a recipient had no actionable value at all.
    expect(deliveredText).not.toBe(undefined);
    const urls = deliveredText.match(/https?:\/\/\S+/g) || [];
    expect(urls.length).toBeGreaterThan(0);
    const verifyUrl = urls.find((u) => /token=/.test(u));
    expect(verifyUrl).toBeTruthy();
    const deliveredToken = new URL(verifyUrl).searchParams.get('token');
    expect(typeof deliveredToken).toBe('string');
    expect(deliveredToken.length).toBeGreaterThan(20);
    // It is a credential, not the digest the row carries.
    expect(deliveredToken).not.toBe(job.payload.tokenHash);

    // Verify using ONLY what was delivered — the register() return value is never used here.
    const res = await request(app).post('/api/auth/verify-email').send({ token: deliveredToken });
    expect(res.status).toBe(200);
    const row = (await dbh.query('SELECT * FROM users WHERE id = $1', [user.id])).rows[0];
    expect(row.email_verified).toBe(true);
  });
});
