// tests/tc-booking/tc10-registration.test.js — VERIFIER lane "tc-booking", TC-10 (FR-10).
//
// FR-10 acceptance (docs/_generated/requirements-inventory.json):
//  - POST /api/auth/register with valid data creates a USER row with email_verified=false,
//    an Argon2id/bcrypt hash (never plaintext), and IN THE SAME TRANSACTION an outbox row
//    of type 'email.verification' carrying only IDs.
//  - Duplicate email -> 409 (AB-07).
//  - GET/POST /api/auth/verify-email with the correct single-use token sets
//    email_verified=true and consumes it; wrong / already-used / expired -> 400 and the
//    flag stays false.
//  - No email adapter call occurs on the request path.
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { query, closeDb } = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const authService = require('../../src/modules/auth/service');
const outboxModule = require('../../src/outbox/outbox');
const mockTransport = require('../../src/adapters/mockTransport');

let app;
let emailSeq = 0;
function uniqueEmail() {
  emailSeq += 1;
  return `tc10-u${emailSeq}-${process.pid}-${Date.now()}@tcbooking.homeplate.invalid`;
}
const PASSWORD = 'Tc10-strong-pw!42';

async function userRow(email) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0] || null;
}

async function outboxRowsForUser(userId) {
  const { rows } = await query(
    `SELECT * FROM outbox_jobs WHERE type = 'email.verification'
       AND payload->>'userId' = $1 ORDER BY id`,
    [userId]
  );
  return rows;
}

beforeAll(() => {
  app = createApp();
});

afterAll(async () => {
  await closeDb();
  await closeTestRedis();
});

describe('FR-10 / TC-10 — registration and email verification', () => {
  test('valid registration: 201, unverified user row, hashed password, same-tx outbox row with IDs only', async () => {
    const email = uniqueEmail();
    const before = mockTransport.deliveries().length;

    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: PASSWORD, fullName: 'TC Ten', phone: '+16195550110' });

    expect(res.status).toBe(201);
    // The raw verification token must never be in the response.
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);

    const row = await userRow(email);
    expect(row).not.toBeNull();
    expect(row.email_verified).toBe(false);
    // Argon2id primary, bcrypt documented fallback — never the plaintext.
    expect(row.password_hash).toMatch(/^\$(argon2id|2[aby])\$/);
    expect(row.password_hash).not.toContain(PASSWORD);

    const jobs = await outboxRowsForUser(row.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
    // IDs only (ADR-003): exactly {userId, tokenHash}, no email/phone/name anywhere.
    expect(Object.keys(jobs[0].payload).sort()).toEqual(['tokenHash', 'userId']);
    expect(JSON.stringify(jobs[0].payload)).not.toContain(email);
    expect(JSON.stringify(jobs[0].payload)).not.toContain('+1619');

    // No adapter call on the request path: nothing delivered, no attempt row yet.
    expect(mockTransport.deliveries().length).toBe(before);
    const { rows: attempts } = await query(
      'SELECT * FROM notification_attempts WHERE recipient_user_id = $1',
      [row.id]
    );
    expect(attempts).toHaveLength(0);
  });

  test('duplicate email -> 409, no second row (AB-07)', async () => {
    const email = uniqueEmail();
    await request(app).post('/api/auth/register').send({ email, password: PASSWORD }).expect(201);
    const dup = await request(app).post('/api/auth/register').send({ email, password: PASSWORD });
    expect(dup.status).toBe(409);
    const { rows } = await query('SELECT count(*)::int AS c FROM users WHERE email = $1', [email]);
    expect(rows[0].c).toBe(1);
  });

  test('registration is one transaction: forced outbox failure leaves NO user row and NO outbox row', async () => {
    const email = uniqueEmail();
    const spy = jest.spyOn(outboxModule, 'enqueue').mockImplementation(async () => {
      throw new Error('tc10: injected enqueue failure');
    });
    try {
      const res = await request(app).post('/api/auth/register').send({ email, password: PASSWORD });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await userRow(email)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test('correct token verifies exactly once; reuse -> 400 with flag unchanged', async () => {
    const email = uniqueEmail();
    const { user, verification } = await authService.register({ email, password: PASSWORD });

    const ok = await request(app)
      .get('/api/auth/verify-email')
      .query({ token: verification.rawToken });
    expect(ok.status).toBe(200);
    expect(ok.body.emailVerified).toBe(true);
    expect((await userRow(email)).email_verified).toBe(true);

    const again = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: verification.rawToken });
    expect(again.status).toBe(400);
    // Flag unchanged (still true from the first, single, use).
    expect((await userRow(email)).email_verified).toBe(true);
    expect(user.id).toBeDefined();
  });

  test('wrong token -> 400, email_verified stays false', async () => {
    const email = uniqueEmail();
    await authService.register({ email, password: PASSWORD });
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: 'A'.repeat(43) });
    expect(res.status).toBe(400);
    expect((await userRow(email)).email_verified).toBe(false);
  });

  test('expired token (> EMAIL_TOKEN_TTL_HOURS) -> 400, email_verified stays false', async () => {
    const email = uniqueEmail();
    const { user, verification } = await authService.register({ email, password: PASSWORD });
    await query(
      `UPDATE email_verification_tokens SET expires_at = now() - interval '1 hour'
        WHERE user_id = $1`,
      [user.id]
    );
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: verification.rawToken });
    expect(res.status).toBe(400);
    expect((await userRow(email)).email_verified).toBe(false);
  });
});
