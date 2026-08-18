// tests/it-adapters/it02b-fr10-delivered-email.test.js — IT-02 re-verification of finding
// TCB-W3-01 (FR-10 blocker), written for verification round 2.
//
// WHY THIS FILE EXISTS. Waves 1-2 reported FR-10 as PASS while the value the recipient would
// actually have received was a SHA-256 digest, not a usable link: every FR-10 test took the raw
// token from authService.register()'s IN-PROCESS return value (`verification.rawToken`), which a
// real user never sees, instead of from the message the delivery path composed. tests/it-adapters/
// it02-verification-eligibility.test.js still does exactly that at step 4 — deliberately, because
// it is testing the eligibility policy, not the mail body. The blocker was invisible to it.
//
// This file closes that loop: it drives the REAL production delivery path (outbox row -> worker
// handler -> transport -> the adapter that composes the message body), lifts the URL out of the
// text the adapter handed the provider SDK, and verifies the account with THAT value only.
// The raw token from register() is never used to verify here; it is asserted absent from the
// delivered artefacts instead.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-10 (TC-10)  — a registered user can verify their email with the value actually delivered
//   ADR-001/003    — the link is minted worker-side; no persisted row or payload carries it
//   ADR-011        — no live provider: @sendgrid/mail is substituted with a `__fake` double and
//                    the adapter's own LIVE_PROVIDER_REFUSED_IN_TEST guard is left armed
//   NFR-08 / §3.4  — the delivered body and the persisted row are checked for PII/credential leaks
'use strict';

const request = require('supertest');

const config = require('../../src/config');
const { createApp } = require('../../src/app');
const authService = require('../../src/modules/auth/service');
const notifRepo = require('../../src/modules/notifications/repo');
const mockTransport = require('../../src/adapters/mockTransport');
const { loadHandlers } = require('../../src/outbox/dispatch');
const { pollOnce } = require('../../src/outbox/worker');
const dbh = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');

const PASSWORD = 'correct-horse-battery-staple-9!';
const EMAIL_DOMAIN = '@it02b.homeplate.invalid';

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
  expect(config.isTest).toBe(true);
  app = createApp();
  registry = loadHandlers({ log: quietLog });
});

beforeEach(() => {
  mockTransport.reset();
});

afterAll(async () => {
  mockTransport.reset();
  await dbh.query(`DELETE FROM users WHERE email LIKE '%${EMAIL_DOMAIN}'`);
  await dbh.closeDb();
  await closeTestRedis();
});

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
      const transport = require('../../src/modules/notifications/transport');
      const handler = require('../../src/outbox/handlers/emailVerification');
      const pool = require('../../src/db/pool');
      const redis = require('../../src/db/redis');
      /* eslint-enable global-require */
      loaded = {
        config: isoConfig,
        transport,
        handler,
        sent,
        async dispose() {
          await pool.closePool();
          await redis.closeRedis();
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

/** The single outbox row registration commits alongside the user (ADR-001). */
async function verificationJobFor(userId) {
  const { rows } = await dbh.query(
    `SELECT * FROM outbox_jobs WHERE type = 'email.verification' AND payload->>'userId' = $1`,
    [userId]
  );
  return rows[0];
}

// ==============================================================================================
describe('FR-10 / TCB-W3-01 · the value the recipient actually receives is the value that verifies', () => {
  test('register -> worker delivery path -> the URL in the delivered body flips email_verified to true', async () => {
    const email = `it02b.${Date.now()}${EMAIL_DOMAIN}`;
    const { user, verification } = await authService.register(
      { email, password: PASSWORD },
      { log: quietLog }
    );
    expect(user.email_verified ?? user.emailVerified ?? false).toBe(false);

    // The outbox row is IDs/digests only (ADR-003): it cannot itself carry a mailable link.
    const job = await verificationJobFor(user.id);
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

  test('the delivered digest alone can never verify — the pre-fix email body was unusable', async () => {
    const email = `it02b.digest.${Date.now()}${EMAIL_DOMAIN}`;
    const { user } = await authService.register({ email, password: PASSWORD }, { log: quietLog });
    const job = await verificationJobFor(user.id);

    // This is precisely what the pre-fix email contained. Feeding it back is a 400 and leaves
    // the account unverified: mailing a digest made FR-10 unmeetable in production.
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: job.payload.tokenHash });
    expect(res.status).toBe(400);
    const row = (await dbh.query('SELECT * FROM users WHERE id = $1', [user.id])).rows[0];
    expect(row.email_verified).toBe(false);
  });

  test('no persisted artefact carries the mailable credential (ADR-003 / §3.4)', async () => {
    const email = `it02b.leak.${Date.now()}${EMAIL_DOMAIN}`;
    const { user } = await authService.register({ email, password: PASSWORD }, { log: quietLog });

    // Drain on the AMBIENT (mock) transport, exactly as the rest of the suite runs.
    let stats;
    do {
      stats = await pollOnce({ registry, log: quietLog });
    } while (stats.claimed > 0);

    const attempts = await notifRepo.listForUser(user.id);
    expect(attempts).toHaveLength(1);
    const attemptText = JSON.stringify(attempts[0]);
    expect(attemptText).not.toContain(email);
    expect(attemptText).not.toMatch(/verify-email\?token=/);

    const job = await verificationJobFor(user.id);
    expect(JSON.stringify(job.payload)).not.toMatch(/token=/);

    // And the ADR-011 mock genuinely composes no body: the link is minted only when a delivery
    // is about to be attempted by an adapter that needs it (transport.requiresRenderContext),
    // which is why the mock-transport suite alone can never prove FR-10 end to end.
    const [delivery] = mockTransport.deliveries().filter((d) => d.userId === user.id);
    expect(delivery).toBeTruthy();
    expect(delivery.template).toBe('email.verification');
    expect(JSON.stringify(delivery.params)).not.toMatch(/token=/);
  });
});
