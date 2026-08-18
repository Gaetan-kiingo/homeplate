// tests/rt-lt-resilience/rt02-fr10-delivered-token.test.js — RT-02 re-verification of the
// TCB-W3-01 blocker: FR-10 email verification, proved through the value that is ACTUALLY
// DELIVERED rather than through an in-process return value (SRS §4.4; FR-10; ADR-003, ADR-011).
//
// THE BUG THIS GUARDS. Waves 1–2 reported FR-10 as PASS while the delivered email carried only
// the token's SHA-256 DIGEST: the outbox payload is IDs-only by ADR-003, the raw token is never
// persisted, and the tests read the token from the in-process return value of the register call
// instead of from the delivery. So no real recipient could ever verify — and nobody could become
// eligible to book or publish. The repair mints the deliverable link WORKER-SIDE, in the
// handler's `resolveRenderContext()` callback, which the transport invokes only for an adapter
// that declares `requiresRenderContext` (src/adapters/sendgrid.js does; the ADR-011 mock
// deliberately does not, so dev/test never mint a credential).
//
// WHY THE ADR-011 MOCK CANNOT PROVE THIS ALONE, AND WHAT THIS FILE DOES INSTEAD. Because the
// mock declines the render context, `mockTransport.deliveries()` records `params:{userId,
// tokenHash}` — a digest, still not a usable token. Reading the mock's delivery therefore
// cannot demonstrate FR-10 end to end. This test instead substitutes a RECORDING EMAIL ADAPTER
// that declares `requiresRenderContext: true` exactly as SendGrid does, so the production
// sequence runs unchanged (handler → transport.send(..., {resolveRenderContext}) → adapter
// .deliver({renderContext})), and then composes the message body with the REAL SendGrid
// renderer, `renderEmail()` from src/adapters/sendgrid.js. The token is then scraped out of
// that rendered email text with a regex — the same thing a recipient does by clicking — and
// posted to the public verify endpoint. Nothing here contacts a provider: renderEmail is pure
// and no SDK is loaded (ADR-011).
'use strict';

const request = require('supertest');

const { createApp } = require('../../src/app');
const { renderEmail } = require('../../src/adapters/sendgrid');
const mockTransport = require('../../src/adapters/mockTransport');
const notificationsTransport = require('../../src/modules/notifications/transport');
const { pollOnce } = require('../../src/outbox/worker');
const { loadHandlers } = require('../../src/outbox/dispatch');

const dbh = require('../helpers/db');
const rh = require('../helpers/redis');
const { quietLogger } = require('./helpers');
const w3 = require('./wave3');

const quiet = quietLogger();
const app = createApp();

let registry;

beforeAll(() => {
  registry = loadHandlers({ log: quiet });
});

afterAll(async () => {
  mockTransport.reset();
  await dbh.closeDb();
  await rh.closeTestRedis();
});

/**
 * Drain every claimable outbox job, capturing the email body each delivery would put on the
 * wire. The recording adapter stands in for SendGrid at the transport's adapter seam and
 * declares the same `requiresRenderContext` contract, so the worker-side link minting runs.
 * @returns {Promise<Array<{template: string, params: object, subject: string, text: string}>>}
 */
async function drainCapturingEmails() {
  const emails = [];
  const restoreDeliver = w3.patchFn(mockTransport.adapter, 'deliver', async (input) => {
    const { subject, text } = renderEmail(input.template, input.params, input.renderContext || {});
    emails.push({ template: input.template, params: input.params, subject, text });
    return { providerMessageId: `capture-${emails.length}` };
  });
  const hadFlag = Object.prototype.hasOwnProperty.call(
    mockTransport.adapter,
    'requiresRenderContext'
  );
  mockTransport.adapter.requiresRenderContext = true;
  try {
    // Drain to quiescence: a job scheduled with backoff may need more than one pass.
    for (let pass = 0; pass < 10; pass += 1) {
      const stats = await pollOnce({ registry, log: quiet });
      if (stats.claimed === 0) break;
    }
  } finally {
    restoreDeliver();
    if (hadFlag) mockTransport.adapter.requiresRenderContext = false;
    else delete mockTransport.adapter.requiresRenderContext;
  }
  return emails;
}

describe('RT-02 / FR-10 (TCB-W3-01 re-verification) — the DELIVERED email carries a usable token', () => {
  test('register → drain the outbox → take the token out of the delivered email → email_verified = true', async () => {
    // The transport really is the ADR-011 mock; the recording adapter below only borrows its
    // seam, so this test cannot be read as proof about a live provider.
    expect(notificationsTransport.send).toBeInstanceOf(Function);

    await w3.neutralizePendingJobs(); // isolate this run's job from sibling drills

    const email = `fr10-delivered-${Date.now()}@homeplate.invalid`;
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'Verify-Me-9!aa' });
    expect(registered.status).toBe(201);
    const userId = registered.body.user.id;

    const { rows: before } = await dbh.query('SELECT email_verified FROM users WHERE id = $1', [
      userId,
    ]);
    expect(before[0].email_verified).toBe(false);

    // The outbox row exists and is IDs-only (ADR-003) — it carries a DIGEST, not the token.
    const { rows: jobs } = await dbh.query(
      `SELECT payload FROM outbox_jobs
         WHERE type = 'email.verification' AND status = 'pending' AND payload->>'userId' = $1`,
      [userId]
    );
    expect(jobs).toHaveLength(1);
    expect(Object.keys(jobs[0].payload).sort()).toEqual(['tokenHash', 'userId']);
    expect(jobs[0].payload.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    const emails = await drainCapturingEmails();
    const verification = emails.filter((e) => e.template === 'email.verification');
    expect(verification).toHaveLength(1);

    // THE ASSERTION THAT WAVES 1–2 WERE MISSING: what a recipient can act on is a link, and the
    // digest that travelled in the outbox payload must NOT be what they are asked to submit.
    // (The rendered body also prints a "Reference:" block echoing userId/tokenHash, so the
    // digest's mere presence proves nothing — the ACTIONABLE value is what is checked here.)
    const body = verification[0].text;
    const match = body.match(/https?:\/\/\S*\/verify-email\?token=([A-Za-z0-9._~-]+)/);
    expect(match).toBeTruthy(); // a real single-use URL, not a hash and not a placeholder
    const deliveredToken = match[1];
    expect(deliveredToken).not.toBe(jobs[0].payload.tokenHash);

    // A REGISTERED USER, holding only what the email delivered, verifies their address.
    const verified = await request(app).post('/api/auth/verify-email').send({
      token: deliveredToken,
    });
    expect(verified.status).toBe(200);

    const { rows: after } = await dbh.query('SELECT email_verified FROM users WHERE id = $1', [
      userId,
    ]);
    expect(after[0].email_verified).toBe(true); // FR-10 closed, end to end
  }, 30000);

  test('the delivered token is single-use: replaying the SAME delivered value is refused', async () => {
    await w3.neutralizePendingJobs();

    const email = `fr10-replay-${Date.now()}@homeplate.invalid`;
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'Verify-Me-9!aa' });
    expect(registered.status).toBe(201);

    const emails = await drainCapturingEmails();
    const body = emails.find((e) => e.template === 'email.verification').text;
    const deliveredToken = body.match(/https?:\/\/\S*\/verify-email\?token=([A-Za-z0-9._~-]+)/)[1];

    expect(
      (await request(app).post('/api/auth/verify-email').send({ token: deliveredToken })).status
    ).toBe(200);
    const replay = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: deliveredToken });
    expect(replay.status).toBe(400); // consumed — FR-10 tokens are single-use

    const { rows } = await dbh.query('SELECT email_verified FROM users WHERE id = $1', [
      registered.body.user.id,
    ]);
    expect(rows[0].email_verified).toBe(true); // the first, legitimate verification stands
  }, 30000);

  test('RT-02 exactly-once meets FR-10: a redelivered job mails nothing new, and the first delivered token still verifies', async () => {
    // The outbox may redeliver after a lost commit. The dedupe key is
    // `email.verification:<tokenHash>`, so the redelivery must NOT mail a second link (which
    // would invalidate the one the recipient already holds, putting FR-10 back where
    // TCB-W3-01 found it) — and the token already delivered must still work afterwards.
    await w3.neutralizePendingJobs();

    const email = `fr10-redeliver-${Date.now()}@homeplate.invalid`;
    const registered = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'Verify-Me-9!aa' });
    expect(registered.status).toBe(201);

    const first = await drainCapturingEmails();
    const firstVerification = first.filter((e) => e.template === 'email.verification');
    expect(firstVerification).toHaveLength(1);
    const deliveredToken = firstVerification[0].text.match(
      /https?:\/\/\S*\/verify-email\?token=([A-Za-z0-9._~-]+)/
    )[1];

    // Simulate the crash-then-redeliver case: put the same job back as pending.
    // Scoped to THIS test's own row (PRIORITY-0 determinism rule: never assert over, or
    // mutate, rows a sibling test created — sister cases above leave their own jobs behind).
    const reset = await dbh.query(
      `UPDATE outbox_jobs SET status = 'pending', delivered_at = NULL, available_at = now()
         WHERE type = 'email.verification' AND payload->>'userId' = $1`,
      [registered.body.user.id]
    );
    expect(reset.rowCount).toBe(1);

    const second = await drainCapturingEmails();
    // Exactly-once: the redelivery is deduped at the transport, so no second email goes out.
    expect(second.filter((e) => e.template === 'email.verification')).toHaveLength(0);
    // …and the job is not left stuck pending — the dedupe COMPLETES it (RT-02).
    const { rows: jobRows } = await dbh.query(
      `SELECT status FROM outbox_jobs
         WHERE type = 'email.verification' AND payload->>'userId' = $1`,
      [registered.body.user.id]
    );
    expect(jobRows.map((r) => r.status)).toEqual(['delivered']);

    const verified = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: deliveredToken });
    expect(verified.status).toBe(200);

    const { rows } = await dbh.query('SELECT email_verified FROM users WHERE id = $1', [
      registered.body.user.id,
    ]);
    expect(rows[0].email_verified).toBe(true);
  }, 30000);
});
