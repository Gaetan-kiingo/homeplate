// tests/tc-booking/fr10-verification-link.test.js — regression proof for finding TCB-W3-01
// (FR-10 was unmeetable in production: the delivery pipeline could only carry the token
// DIGEST, so no real recipient could ever verify an email — and with email_verified stuck
// false, the NFR-06 eligibility policy locked every account out of FR-11 and FR-12).
//
// What is proven here, end to end, against the REAL app, the REAL outbox handler and the
// REAL transport (ADR-011 mock adapter, as the whole suite requires):
//   1. FR-10 — the value the delivery pipeline hands the mail adapter is a single-use LINK
//      whose token verifies the account: POST /api/auth/verify-email → 200 and
//      users.email_verified = true. This is the exact scenario that returned 400 before.
//   2. ADR-003 / §3.4 — closing that loop changed nothing about what is PERSISTED: the
//      outbox payload and the NOTIFICATION_ATTEMPT row still carry {userId, tokenHash} and
//      no raw token appears in either.
//   3. FR-09 / NFR-06 — after verifying through the emailed link the eligibility policy
//      recomputes canReserveSeat = true (the consequence chain the finding described).
//   4. ADR-011 — the SendGrid body the production path would send contains that link under
//      the verification subject, and a verification send WITHOUT a link is refused instead
//      of delivered empty.
//   5. ADR-001/003 — no credential is minted where none is mailed: the mock transport path
//      never invokes the link minter, and a deduped redelivery does not either.
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { query, closeDb } = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const config = require('../../src/config');
const dispatch = require('../../src/outbox/dispatch');
const mockTransport = require('../../src/adapters/mockTransport');
const sendgrid = require('../../src/adapters/sendgrid');
const { logger } = require('../../src/lib/logger');
const { ctxFor, drainCapturingDelivery } = require('../helpers/outboxDirect');

let app;
let emailSeq = 0;
function uniqueEmail() {
  emailSeq += 1;
  return `fr10link-u${emailSeq}-${process.pid}-${Date.now()}@tcbooking.homeplate.invalid`;
}
const PASSWORD = 'Fr10-strong-pw!42';

/** Register through HTTP and return the user row plus its pending verification job. */
async function registerAndQueue(overrides = {}) {
  const email = uniqueEmail();
  const res = await request(app)
    .post('/api/auth/register')
    .send({
      email,
      password: PASSWORD,
      fullName: 'Link Prober',
      phone: '+16195550142',
      ...overrides,
    });
  expect(res.status).toBe(201);

  const { rows: users } = await query('SELECT * FROM users WHERE email = $1', [email]);
  expect(users).toHaveLength(1);
  expect(users[0].email_verified).toBe(false);

  const { rows: jobs } = await query(
    `SELECT * FROM outbox_jobs WHERE type = 'email.verification' AND payload->>'userId' = $1`,
    [users[0].id]
  );
  expect(jobs).toHaveLength(1);
  return { email, user: users[0], job: jobs[0] };
}

// ctxFor / drainCapturingDelivery (tests/helpers/outboxDirect.js) run the real
// 'email.verification' handler with the ADR-011 mock adapter standing in for a body-composing
// one, capturing what the adapter received. Nothing about the transport, handler or auth
// service is stubbed.

beforeAll(() => {
  app = createApp();
});

afterAll(async () => {
  await closeDb();
  await closeTestRedis();
});

beforeEach(() => {
  mockTransport.reset();
});

describe('FR-10 / TCB-W3-01 — the emailed verification link closes the loop', () => {
  test('the token carried to the mail adapter verifies the account (200, email_verified=true)', async () => {
    const { user, job } = await registerAndQueue();

    const { result, received } = await drainCapturingDelivery(job);
    expect(result.status).toBe('sent');
    expect(received).toHaveLength(1);

    // What the recipient receives: an absolute, single-use link on this deployment's origin.
    const verificationUrl = received[0].renderContext.verificationUrl;
    expect(typeof verificationUrl).toBe('string');
    expect(
      verificationUrl.startsWith(`${config.server.publicBaseUrl}/api/auth/verify-email?`)
    ).toBe(true);
    const token = new URL(verificationUrl).searchParams.get('token');
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // It is NOT the digest the payload carries — that was the whole defect.
    expect(token).not.toBe(job.payload.tokenHash);

    // The exact submission that used to return 400.
    const verified = await request(app).post('/api/auth/verify-email').send({ token });
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ emailVerified: true });

    const { rows } = await query(
      'SELECT email_verified, can_reserve_seat FROM users WHERE id = $1',
      [user.id]
    );
    expect(rows[0].email_verified).toBe(true);
    // FR-09 / NFR-06: the eligibility chain unblocks, recomputed through the one policy.
    expect(rows[0].can_reserve_seat).toBe(true);

    // Single-use: the same link cannot be replayed (FR-10).
    const replay = await request(app).post('/api/auth/verify-email').send({ token });
    expect(replay.status).toBe(400);
  });

  test('the emailed link is a GET link too, and the digest still verifies nothing', async () => {
    const { user, job } = await registerAndQueue();
    const { received } = await drainCapturingDelivery(job);
    const url = new URL(received[0].renderContext.verificationUrl);

    // The digest a recipient used to receive: still (correctly) worthless.
    const digestAttempt = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: job.payload.tokenHash });
    expect(digestAttempt.status).toBe(400);
    expect(
      (await query('SELECT email_verified FROM users WHERE id = $1', [user.id])).rows[0]
        .email_verified
    ).toBe(false);

    // Clicking the link out of a mail client (GET, FR-10 "GET/POST") works.
    const clicked = await request(app).get(`${url.pathname}${url.search}`);
    expect(clicked.status).toBe(200);
    expect(
      (await query('SELECT email_verified FROM users WHERE id = $1', [user.id])).rows[0]
        .email_verified
    ).toBe(true);
  });

  test('ADR-003 / §3.4: the link is nowhere in the outbox payload, the attempt row or the token table', async () => {
    const { user, job } = await registerAndQueue();
    const { received } = await drainCapturingDelivery(job);
    const url = received[0].renderContext.verificationUrl;
    const token = new URL(url).searchParams.get('token');

    // Persisted outbox payload: unchanged, IDs only.
    const { rows: jobs } = await query('SELECT payload FROM outbox_jobs WHERE id = $1', [job.id]);
    expect(Object.keys(jobs[0].payload).sort()).toEqual(['tokenHash', 'userId']);
    expect(JSON.stringify(jobs[0].payload)).not.toContain(token);

    // Persisted NOTIFICATION_ATTEMPT row: IDs/digests only, no link, no raw token.
    const { rows: attempts } = await query(
      'SELECT * FROM notification_attempts WHERE recipient_user_id = $1',
      [user.id]
    );
    expect(attempts).toHaveLength(1);
    expect(Object.keys(attempts[0].params).sort()).toEqual(['tokenHash', 'userId']);
    expect(JSON.stringify(attempts[0])).not.toContain(token);

    // PostgreSQL keeps digests only — the raw token is not searchable anywhere.
    const { rows: tokenRows } = await query(
      'SELECT token_hash FROM email_verification_tokens WHERE user_id = $1',
      [user.id]
    );
    expect(tokenRows.length).toBeGreaterThanOrEqual(1);
    for (const row of tokenRows) {
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.token_hash).not.toBe(token);
    }
  });

  test('no credential is minted where none is mailed: mock path and deduped redelivery mint nothing', async () => {
    const tokenCount = async (userId) =>
      (
        await query('SELECT count(*)::int AS n FROM email_verification_tokens WHERE user_id = $1', [
          userId,
        ])
      ).rows[0].n;

    // (a) The ADR-011 mock adapter composes no body, so it never asks for render context —
    //     dev and the whole suite therefore mint no verification credentials at all.
    const plain = await registerAndQueue();
    expect(await tokenCount(plain.user.id)).toBe(1); // registration's own token only
    const handler = dispatch.loadHandlers({ log: logger }).get('email.verification');
    const sent = await handler.handle(plain.job.payload, ctxFor(plain.job));
    expect(sent.status).toBe('sent');
    expect(await tokenCount(plain.user.id)).toBe(1);

    // (b) A body-composing adapter mints exactly one link…
    const mailed = await registerAndQueue();
    const first = await drainCapturingDelivery(mailed.job);
    expect(first.received).toHaveLength(1);
    const afterFirst = await tokenCount(mailed.user.id);
    expect(afterFirst).toBe(2); // registration's token + the one mailed link

    // …and a redelivery deduped by the idempotency key mints nothing further (RT-02).
    const replay = await drainCapturingDelivery(mailed.job);
    expect(replay.result.status).toBe('sent');
    expect(replay.received).toHaveLength(0); // deduped before any adapter call
    expect(await tokenCount(mailed.user.id)).toBe(afterFirst);
  });
});

describe('FR-10 / ADR-011 — the SendGrid body the production path would send', () => {
  test('renders the verification subject and the single-use link (both template spellings)', async () => {
    const { user, job } = await registerAndQueue();
    const { received } = await drainCapturingDelivery(job);
    const { verificationUrl, expiresAt } = received[0].renderContext;

    for (const template of ['email.verification', 'email-verification']) {
      const rendered = sendgrid.renderEmail(
        template,
        { userId: user.id, tokenHash: job.payload.tokenHash },
        { verificationUrl, expiresAt }
      );
      // The dotted job-type spelling must not fall back to the neutral subject.
      expect(rendered.subject).toBe('Verify your Homeplate email address');
      expect(rendered.text).toContain(verificationUrl);
      expect(rendered.text).not.toMatch(/Homeplate notification \(/);
    }

    // The body a real recipient gets carries a token that actually verifies.
    const body = sendgrid.renderEmail(
      'email.verification',
      { userId: user.id, tokenHash: job.payload.tokenHash },
      { verificationUrl, expiresAt }
    ).text;
    const fromBody = /verify-email\?token=([A-Za-z0-9_-]+)/.exec(body)[1];
    const res = await request(app).post('/api/auth/verify-email').send({ token: fromBody });
    expect(res.status).toBe(200);
    expect(
      (await query('SELECT email_verified FROM users WHERE id = $1', [user.id])).rows[0]
        .email_verified
    ).toBe(true);
  });

  test('a verification send with no link is REFUSED, not delivered empty (FR-10 fail-loud)', async () => {
    await expect(
      sendgrid.adapter.deliver({
        recipientEmail: 'nobody@example.invalid',
        template: 'email.verification',
        params: { userId: '00000000-0000-4000-8000-000000000001', tokenHash: 'a'.repeat(64) },
      })
    ).rejects.toMatchObject({ code: 'SENDGRID_NO_VERIFICATION_LINK', retryable: false });

    // The adapter declares the need, which is what makes the transport resolve one.
    expect(sendgrid.adapter.requiresRenderContext).toBe(true);
    expect(mockTransport.adapter.requiresRenderContext).toBeUndefined();
  });

  test('other templates are unaffected: no link block, reference IDs still rendered', () => {
    const rendered = sendgrid.renderEmail('safety-alert-emergency', { alertId: 'abcd-1234' });
    expect(rendered.subject).toMatch(/safety alert/i);
    expect(rendered.text).toContain('alertId: abcd-1234');
    expect(rendered.text).not.toMatch(/Confirm this email address/);
  });
});
