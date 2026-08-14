// tests/unit/identity.test.js — U2-IDENTITY unit/integration suite.
//
// Verifies (SRS Appendix B): FR-10 (TC-10 registration + email verification end-to-end
// through the outbox), NFR-04 (ST-02 Argon2id parameters, per-user salt, no plaintext),
// NFR-05 (ST-03 exact 5-in-10-minutes lockout boundary, Redis counters by account AND
// source IP, Retry-After, window expiry, success reset), NFR-06 (IT-02 flags recomputed
// through the single eligibility policy on registration/verification/profile update),
// NFR-03 (Secure cookie — transport itself is ST-01/U1-HTTP), NFR-08 (MT-01 audit records
// with correlation IDs, PII-free logs), AB-05 (opaque >=256-bit Redis sessions, logout
// kills the token), AB-07 (duplicate email 409).
//
// Runs against the seeded *_test database + isolated test Redis (tests/helpers/env.js).
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const request = require('supertest');

const config = require('../../src/config');
const { createLogger } = require('../../src/lib/logger');
const { createApp } = require('../../src/app');
const { query, closeDb } = require('../helpers/db');
const { redis, flushNamespace, closeTestRedis } = require('../helpers/redis');

const passwords = require('../../src/modules/auth/passwords');
const sessions = require('../../src/modules/auth/sessions');
const rateLimit = require('../../src/modules/auth/rateLimit');
const authService = require('../../src/modules/auth/service');
const policy = require('../../src/modules/eligibility/policy');
const outboxModule = require('../../src/outbox/outbox');

const COOKIE_NAME = config.auth.sessionCookieName;
const PASSWORD = 'S3cret-identity-pw!';

// ---- recording logger: every line the app logs is captured for the NFR-08 assertions ----
const logLines = [];
const sink = {
  write(line) {
    logLines.push(line);
  },
};
const logger = createLogger({ level: 'info', stream: sink });

let app;

let emailSeq = 0;
function uniqueEmail() {
  emailSeq += 1;
  return `id-u${emailSeq}-${process.pid}-${Date.now()}@identity-unit.homeplate.invalid`;
}

async function getUserRow(email) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
  return rows[0] || null;
}

function cookieTokenFrom(res) {
  const setCookies = res.headers['set-cookie'] || [];
  const raw = setCookies.find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return null;
  return decodeURIComponent(raw.split(';')[0].slice(COOKIE_NAME.length + 1));
}

function sessionCookieHeaderString(res) {
  const setCookies = res.headers['set-cookie'] || [];
  return setCookies.find((c) => c.startsWith(`${COOKIE_NAME}=`)) || '';
}

async function scanKeys(pattern) {
  const found = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    found.push(...keys);
  } while (cursor !== '0');
  return found;
}

async function registerViaHttp(overrides = {}) {
  const email = overrides.email || uniqueEmail();
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, password: PASSWORD, ...overrides.body });
  return { email, res };
}

beforeAll(async () => {
  app = createApp({ logger });
  await flushNamespace('ratelimit'); // start with a clean NFR-05 window
});

afterAll(async () => {
  // Never leave rate-limit residue for later suites (600 s TTLs would outlive this file).
  await flushNamespace('ratelimit');
  await closeTestRedis();
  await closeDb();
});

// ================================================================================================
// Password hashing (NFR-04 / ST-02)
// ================================================================================================
describe('passwords (NFR-04, ST-02)', () => {
  test('hashes with Argon2id at documented parameters (m >= 19456 KiB, t >= 2)', async () => {
    const hash = await passwords.hashPassword(PASSWORD);
    if (passwords.activeAlgorithm === 'argon2id') {
      const match = hash.match(/^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/);
      expect(match).not.toBeNull();
      expect(Number(match[1])).toBeGreaterThanOrEqual(19456);
      expect(Number(match[2])).toBeGreaterThanOrEqual(2);
    } else {
      // Documented bcryptjs fallback (ST-02 deviation path): cost >= 12.
      const match = hash.match(/^\$2[aby]\$(\d{2})\$/);
      expect(match).not.toBeNull();
      expect(Number(match[1])).toBeGreaterThanOrEqual(12);
    }
    await expect(passwords.verifyPassword(hash, PASSWORD)).resolves.toBe(true);
    await expect(passwords.verifyPassword(hash, 'not-the-password')).resolves.toBe(false);
  });

  test('same password twice → different hashes (per-user salt)', async () => {
    const [a, b] = await Promise.all([
      passwords.hashPassword(PASSWORD),
      passwords.hashPassword(PASSWORD),
    ]);
    expect(a).not.toEqual(b);
  });

  test('verifies both hash formats regardless of active algorithm', async () => {
    // A bcrypt hash must keep verifying even while Argon2id is primary (migration safety).
    // eslint-disable-next-line global-require
    const bcrypt = require('bcryptjs');
    const bcryptHash = await bcrypt.hash(PASSWORD, 12);
    await expect(passwords.verifyPassword(bcryptHash, PASSWORD)).resolves.toBe(true);
    await expect(passwords.verifyPassword(bcryptHash, 'wrong')).resolves.toBe(false);
  });

  test('malformed inputs fail loudly; non-string candidate fails closed (NFR-04 guards)', async () => {
    await expect(passwords.hashPassword('')).rejects.toThrow(TypeError);
    await expect(passwords.verifyPassword('', PASSWORD)).rejects.toThrow(TypeError);
    // An unknown format in users.password_hash is a data-integrity bug: throw, never "false".
    await expect(passwords.verifyPassword('md5$deadbeef', PASSWORD)).rejects.toThrow(
      /unrecognized password hash format/
    );
    // A non-string candidate password is simply a failed verification, not an error.
    await expect(passwords.verifyPassword('$2a$12$not-actually-compared', 42)).resolves.toBe(false);
  });
});

// ================================================================================================
// bcryptjs fallback backend (NFR-04 / ST-02 documented deviation path)
//
// The build plan documents bcryptjs cost 12 as the contingency for a build host where the
// @node-rs/argon2 prebuilt native binding cannot load. Simulate exactly that failure: inside an
// isolated module registry the require of '@node-rs/argon2' throws, so a FRESH copy of
// passwords.js takes its real catch branch and selects the bcrypt backend — the same code path
// production would run, with no test-only seam.
// ================================================================================================
describe('passwords bcryptjs fallback (NFR-04, ST-02 deviation path)', () => {
  let fallback; // passwords.js loaded with the native binding unavailable

  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock('@node-rs/argon2', () => {
        throw new Error('simulated: no prebuilt @node-rs/argon2 binding on this host (ST-02)');
      });
      // eslint-disable-next-line global-require
      fallback = require('../../src/modules/auth/passwords');
    });
    // Never leak the failing mock into any other require of the real binding.
    jest.dontMock('@node-rs/argon2');
  });

  test('backend selection records the deviation: activeAlgorithm=bcrypt, cost >= 12', () => {
    expect(fallback.activeAlgorithm).toBe('bcrypt');
    expect(fallback.activeParams.cost).toBe(fallback.BCRYPT_COST);
    expect(fallback.BCRYPT_COST).toBeGreaterThanOrEqual(12);
    // The ST-02 record must show this run deviated from the Argon2id primary path.
    expect(fallback.activeParams.note).toMatch(/fallback/);
  });

  test('hashPassword produces a cost>=12 bcrypt hash that round-trips through verifyPassword', async () => {
    const hash = await fallback.hashPassword(PASSWORD);
    const match = hash.match(/^\$2[aby]\$(\d{2})\$/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeGreaterThanOrEqual(12);
    expect(hash).not.toContain(PASSWORD); // NFR-04: no plaintext embedded in the hash
    await expect(fallback.verifyPassword(hash, PASSWORD)).resolves.toBe(true);
    await expect(fallback.verifyPassword(hash, 'not-the-password')).resolves.toBe(false);
  });

  test('per-call random salt on the fallback path too: same password → different hashes', async () => {
    const [a, b] = await Promise.all([
      fallback.hashPassword(PASSWORD),
      fallback.hashPassword(PASSWORD),
    ]);
    expect(a).not.toEqual(b);
  });

  test('cross-format migration safety: a fallback-era bcrypt hash verifies under the PRIMARY module', async () => {
    // A user who registered while the binding was broken must still log in once it is restored.
    const fallbackEraHash = await fallback.hashPassword(PASSWORD);
    await expect(passwords.verifyPassword(fallbackEraHash, PASSWORD)).resolves.toBe(true);
    await expect(passwords.verifyPassword(fallbackEraHash, 'wrong')).resolves.toBe(false);
  });

  test('fails CLOSED on an Argon2 hash it cannot verify — never a silent false', async () => {
    // On a fallback host an Argon2 hash in users.password_hash is unverifiable. Returning
    // false would present as "wrong password" and mask the operational problem; it must throw.
    const argon2FormatHash =
      passwords.activeAlgorithm === 'argon2id'
        ? await passwords.hashPassword(PASSWORD)
        : '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$c29tZWhhc2g';
    await expect(fallback.verifyPassword(argon2FormatHash, PASSWORD)).rejects.toThrow(
      /@node-rs\/argon2 is unavailable/
    );
  });
});

// ================================================================================================
// Registration (FR-10, AB-07, NFR-04, ADR-001/003)
// ================================================================================================
describe('registration (FR-10, AB-07)', () => {
  test('request path touches no adapter module (ADR-001/003) — static import scan', () => {
    // Everything reachable from the auth/users request handlers; none may require
    // src/adapters/* (the email goes through the outbox worker instead).
    const requestPathFiles = [
      'src/modules/auth/routes.js',
      'src/modules/auth/service.js',
      'src/modules/auth/middleware.js',
      'src/modules/auth/sessions.js',
      'src/modules/auth/rateLimit.js',
      'src/modules/auth/passwords.js',
      'src/modules/users/routes.js',
      'src/modules/users/service.js',
      'src/modules/users/repo.js',
      'src/modules/users/tokens.js',
      'src/schemas/auth.js',
    ];
    const requireOfAdapters = /require\(\s*['"][^'"]*adapters\/[^'"]*['"]\s*\)/;
    for (const rel of requestPathFiles) {
      const source = fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
      expect(`${rel}: ${requireOfAdapters.test(source)}`).toBe(`${rel}: false`);
    }
  });

  test('valid data → 201, USER row with email_verified=false and a real hash; no plaintext stored', async () => {
    const { email, res } = await registerViaHttp({
      body: { fullName: 'Reg TestUser', phone: '+14155550100' },
    });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.emailVerified).toBe(false);
    expect(res.body.user.canReserveSeat).toBe(false);
    expect(res.body.user.canPublishListing).toBe(false);

    const row = await getUserRow(email);
    expect(row).not.toBeNull();
    expect(row.email_verified).toBe(false);
    if (passwords.activeAlgorithm === 'argon2id') {
      expect(row.password_hash.startsWith('$argon2id$')).toBe(true);
    } else {
      expect(/^\$2[aby]\$/.test(row.password_hash)).toBe(true);
    }
    // NFR-04: the plaintext appears in NO column of the row.
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    // NFR-13: phone is ciphertext at rest, never plaintext.
    expect(row.phone_enc.startsWith('enc:v1:')).toBe(true);
    expect(row.phone_enc).not.toContain('+14155550100');

    // Response never exposes hash/ciphertext/token (allowlist serializer).
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('password');
    expect(body).not.toContain('_enc');
    expect(body).not.toContain('token');
  });

  test('same password on two accounts → different stored hashes (per-user salt)', async () => {
    const first = await registerViaHttp();
    const second = await registerViaHttp();
    const [rowA, rowB] = [await getUserRow(first.email), await getUserRow(second.email)];
    expect(rowA.password_hash).not.toEqual(rowB.password_hash);
  });

  test('outbox row: type email.verification, IDs only, correlation ID propagated (NFR-08)', async () => {
    const { email, res } = await registerViaHttp();
    expect(res.status).toBe(201);
    const userId = res.body.user.id;

    const { rows } = await query(
      `SELECT * FROM outbox_jobs WHERE type = 'email.verification' AND payload->>'userId' = $1`,
      [userId]
    );
    expect(rows).toHaveLength(1);
    const job = rows[0];
    expect(job.status).toBe('pending');
    // ADR-003: IDs only — exactly {userId, tokenHash}, nothing email/phone/name-shaped.
    expect(Object.keys(job.payload).sort()).toEqual(['tokenHash', 'userId']);
    expect(job.payload.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(job.payload)).not.toMatch(/@/);
    expect(JSON.stringify(job.payload)).not.toContain(email);
    expect(job.dedupe_key).toBe(`email.verification:${job.payload.tokenHash}`);
    // NFR-08: the request's correlation ID is stamped onto the job.
    expect(job.correlation_id).toBe(res.headers['x-correlation-id']);

    // The stored token is the DIGEST of the raw token, never the raw token itself.
    const tokenRows = await query('SELECT * FROM email_verification_tokens WHERE user_id = $1', [
      userId,
    ]);
    expect(tokenRows.rows).toHaveLength(1);
    expect(tokenRows.rows[0].token_hash).toBe(job.payload.tokenHash);

    // Zero adapter activity on the request path: no notification attempt exists yet.
    const attempts = await query(
      'SELECT count(*)::int AS n FROM notification_attempts WHERE recipient_user_id = $1',
      [userId]
    );
    expect(attempts.rows[0].n).toBe(0);
  });

  test('token TTL follows EMAIL_TOKEN_TTL_HOURS (FR-10)', async () => {
    const { res } = await registerViaHttp();
    const { rows } = await query(
      'SELECT created_at, expires_at FROM email_verification_tokens WHERE user_id = $1',
      [res.body.user.id]
    );
    const ttlMs = rows[0].expires_at.getTime() - rows[0].created_at.getTime();
    const expectedMs = config.auth.emailTokenTtlHours * 3600 * 1000;
    expect(Math.abs(ttlMs - expectedMs)).toBeLessThan(120 * 1000);
  });

  test('user row and outbox row commit in ONE transaction: enqueue failure rolls back the user', async () => {
    const before = await query(`SELECT count(*)::int AS n FROM outbox_jobs`);
    const spy = jest.spyOn(outboxModule, 'enqueue').mockImplementationOnce(async () => {
      throw new Error('injected enqueue failure (atomicity drill)');
    });
    try {
      const email = uniqueEmail();
      const res = await request(app).post('/api/auth/register').send({ email, password: PASSWORD });
      expect(res.status).toBe(500);
      // ADR-001/003 no dual writes: NEITHER the user nor any outbox row survived.
      expect(await getUserRow(email)).toBeNull();
      const after = await query(`SELECT count(*)::int AS n FROM outbox_jobs`);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    } finally {
      spy.mockRestore();
    }
  });

  test('duplicate email → 409 EMAIL_IN_USE, no second row (AB-07)', async () => {
    const { email } = await registerViaHttp();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'another-Password-9' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_IN_USE');
    const { rows } = await query('SELECT count(*)::int AS n FROM users WHERE email = $1', [email]);
    expect(rows[0].n).toBe(1);
  });

  test('invalid input → 422 with field errors, password value redacted (NFR-11)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const fields = res.body.error.fields.map((f) => f.path);
    expect(fields).toEqual(expect.arrayContaining(['body.email', 'body.password']));
    // The password field's message is replaced wholesale (never echoes values/policy detail).
    const passwordIssue = res.body.error.fields.find((f) => f.path === 'body.password');
    expect(passwordIssue.message).toBe('Invalid value');
    expect(JSON.stringify(res.body)).not.toContain('short');
  });
});

// ================================================================================================
// Email verification (FR-10)
// ================================================================================================
describe('email verification (FR-10)', () => {
  test('correct single-use token → email_verified=true, token consumed, flags recomputed (NFR-06)', async () => {
    const email = uniqueEmail();
    const { user, verification } = await authService.register({
      email,
      password: PASSWORD,
      fullName: 'Verified User',
      phone: '+14155550101',
    });
    expect(user.can_reserve_seat).toBe(false); // unverified email blocks canReserveSeat

    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: verification.rawToken });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ emailVerified: true });

    const row = await getUserRow(email);
    expect(row.email_verified).toBe(true);
    // NFR-06: name + phone + now-verified email → canReserveSeat recomputed to TRUE
    // through the single policy; host gate still closed.
    expect(row.can_reserve_seat).toBe(true);
    expect(row.can_publish_listing).toBe(false);

    const consumed = await query(
      'SELECT consumed_at FROM email_verification_tokens WHERE user_id = $1',
      [user.id]
    );
    expect(consumed.rows[0].consumed_at).not.toBeNull();

    // Single-use: replaying the same token is 400 and the flag is untouched.
    const replay = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: verification.rawToken });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('INVALID_VERIFICATION_TOKEN');
    expect((await getUserRow(email)).email_verified).toBe(true);
  });

  test('GET variant verifies too (FR-10 "GET/POST")', async () => {
    const { verification, user } = await authService.register({
      email: uniqueEmail(),
      password: PASSWORD,
    });
    const res = await request(app).get(`/api/auth/verify-email?token=${verification.rawToken}`);
    expect(res.status).toBe(200);
    const { rows } = await query('SELECT email_verified FROM users WHERE id = $1', [user.id]);
    expect(rows[0].email_verified).toBe(true);
  });

  test('wrong token → 400, flag unchanged', async () => {
    const email = uniqueEmail();
    await authService.register({ email, password: PASSWORD });
    const res = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: 'A'.repeat(43) });
    expect(res.status).toBe(400);
    expect((await getUserRow(email)).email_verified).toBe(false);
  });

  test('expired token (> EMAIL_TOKEN_TTL_HOURS) → 400, flag unchanged', async () => {
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
    const row = await getUserRow(email);
    expect(row.email_verified).toBe(false);
  });
});

// ================================================================================================
// Login, sessions, logout (AB-05, ADR-006)
// ================================================================================================
describe('login and sessions (AB-05)', () => {
  test('login → opaque >=256-bit token in HttpOnly/Secure/SameSite=Lax cookie, Redis record with TTL', async () => {
    const { email } = await registerViaHttp();
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);

    const rawCookie = sessionCookieHeaderString(res);
    expect(rawCookie).toContain('HttpOnly');
    expect(rawCookie).toContain('Secure');
    expect(rawCookie).toMatch(/SameSite=Lax/i);
    expect(rawCookie).toContain('Path=/');

    const token = cookieTokenFrom(res);
    // 32 random bytes → 43 base64url chars: opaque, no structure, >= 256 bits (AB-05).
    expect(token).toMatch(/^[A-Za-z0-9_-]{43,}$/);

    const sessionKey = `hp:session:${sessions.sessionIdFor(token)}`;
    const record = await redis.get(sessionKey);
    expect(record).not.toBeNull();
    expect(JSON.parse(record).userId).toBe(res.body.user.id);
    const ttl = await redis.ttl(sessionKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(config.auth.sessionTtlSeconds);
    // The raw token itself is never a Redis key (digest-keyed storage).
    expect(await redis.exists(`hp:session:${token}`)).toBe(0);
  });

  test('requireSession: /api/users/me works with the cookie, 401 without (AB-08)', async () => {
    const { email } = await registerViaHttp();
    const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    const me = await request(app)
      .get('/api/users/me')
      .set('Cookie', `${COOKIE_NAME}=${cookieTokenFrom(login)}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    // Allowlist serializer: no hash, no ciphertext columns (NFR-13).
    const body = JSON.stringify(me.body);
    expect(body).not.toContain('password');
    expect(body).not.toContain('_enc');

    const anonymous = await request(app).get('/api/users/me');
    expect(anonymous.status).toBe(401);
  });

  test('wrong password and unknown account are indistinguishable 401s (AB-05)', async () => {
    const { email } = await registerViaHttp();
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'wrong-password-123' });
    const unknownAccount = await request(app)
      .post('/api/auth/login')
      .send({ email: uniqueEmail(), password: 'wrong-password-123' });
    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknownAccount.body.error.code).toBe(wrongPassword.body.error.code);
  });

  test('logout deletes the Redis session — the token is unusable afterwards (AB-05)', async () => {
    const { email } = await registerViaHttp();
    const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    const token = cookieTokenFrom(login);
    const cookie = `${COOKIE_NAME}=${token}`;
    const sessionKey = `hp:session:${sessions.sessionIdFor(token)}`;

    expect(await redis.exists(sessionKey)).toBe(1);
    const logout = await request(app).post('/api/auth/logout').set('Cookie', cookie);
    expect(logout.status).toBe(204);
    expect(await redis.exists(sessionKey)).toBe(0);

    const afterLogout = await request(app).get('/api/users/me').set('Cookie', cookie);
    expect(afterLogout.status).toBe(401);
  });
});

// ================================================================================================
// Login rate limiting (NFR-05 / ST-03 exact boundary)
// ================================================================================================
describe('login rate limiting (NFR-05, ST-03)', () => {
  beforeEach(async () => {
    await flushNamespace('ratelimit');
  });

  test('ST-03 boundary: attempts 1-5 fail as invalid credentials, attempt 6 is 429 even with CORRECT credentials', async () => {
    const { email } = await registerViaHttp();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email, password: 'definitely-wrong' });
      expect(`${attempt}:${res.status}`).toBe(`${attempt}:401`); // still credential failures
    }

    // Counters exist in Redis, keyed by account AND source IP, with the 600 s window TTL.
    expect(await redis.get(rateLimit.accountKey(email))).toBe('5');
    const acctTtl = await redis.ttl(rateLimit.accountKey(email));
    expect(acctTtl).toBeGreaterThan(0);
    expect(acctTtl).toBeLessThanOrEqual(config.auth.loginWindowSeconds);
    const ipKeys = await scanKeys('hp:ratelimit:login:ip:*');
    expect(ipKeys.length).toBeGreaterThanOrEqual(1);
    expect(Number(await redis.get(ipKeys[0]))).toBeGreaterThanOrEqual(5);

    // 6th attempt with the CORRECT password: locked out, 429 + Retry-After.
    const sixth = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('LOGIN_RATE_LIMITED');
    const retryAfter = Number(sixth.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(config.auth.loginWindowSeconds);
  });

  test('window expiry restores login (TTL-driven)', async () => {
    const { email } = await registerViaHttp();
    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/api/auth/login').send({ email, password: 'definitely-wrong' });
    }
    expect(
      (await request(app).post('/api/auth/login').send({ email, password: PASSWORD })).status
    ).toBe(429);

    // Simulate the window elapsing by collapsing the keys' TTLs (clock advance in test).
    const limitKeys = await scanKeys('hp:ratelimit:login:*');
    for (const k of limitKeys) {
      await redis.pexpire(k, 40);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));

    const afterWindow = await request(app)
      .post('/api/auth/login')
      .send({ email, password: PASSWORD });
    expect(afterWindow.status).toBe(200);
  });

  test('a successful login resets the account counter', async () => {
    const { email } = await registerViaHttp();
    for (let i = 0; i < 4; i += 1) {
      await request(app).post('/api/auth/login').send({ email, password: 'definitely-wrong' });
    }
    expect(await redis.get(rateLimit.accountKey(email))).toBe('4');

    const success = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(success.status).toBe(200);
    expect(await redis.exists(rateLimit.accountKey(email))).toBe(0);

    // Fresh window after the reset: failures start counting from zero again.
    for (let i = 0; i < 4; i += 1) {
      await request(app).post('/api/auth/login').send({ email, password: 'definitely-wrong' });
    }
    const stillCredentialFailure = await request(app)
      .post('/api/auth/login')
      .send({ email, password: PASSWORD });
    expect(stillCredentialFailure.status).toBe(200);
  });
});

// ================================================================================================
// Profile update + eligibility recomputation (NFR-06 / IT-02, NFR-13)
// ================================================================================================
describe('profile update recomputes eligibility via the single policy (NFR-06)', () => {
  async function registerVerifyLogin() {
    const email = uniqueEmail();
    const { user, verification } = await authService.register({ email, password: PASSWORD });
    await authService.verifyEmail(verification.rawToken);
    const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    return { email, userId: user.id, cookie: `${COOKIE_NAME}=${cookieTokenFrom(login)}` };
  }

  test('completing name+phone flips canReserveSeat; host profile+agreement flips canPublishListing', async () => {
    const { userId, cookie } = await registerVerifyLogin();

    // Verified email but no name/phone yet: both gates closed.
    let row = (await query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    expect(row.can_reserve_seat).toBe(false);
    expect(row.can_publish_listing).toBe(false);

    // Step 1: name + phone → canReserveSeat true, publish still false.
    const patch1 = await request(app)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({ fullName: 'Eligible Guest', phone: '+14155550102' });
    expect(patch1.status).toBe(200);
    expect(patch1.body.user.canReserveSeat).toBe(true);
    expect(patch1.body.user.canPublishListing).toBe(false);

    row = (await query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    expect(row.can_reserve_seat).toBe(true);
    expect(row.can_publish_listing).toBe(false);
    // NFR-13: phone at rest is ciphertext; response decrypts for the owner only.
    expect(row.phone_enc.startsWith('enc:v1:')).toBe(true);
    expect(patch1.body.user.phone).toBe('+14155550102');

    // Step 2: complete host profile + agreement → canPublishListing true.
    const patch2 = await request(app)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({ hostProfile: { bio: 'I cook Oaxacan food.', acceptHostAgreement: true } });
    expect(patch2.status).toBe(200);
    expect(patch2.body.user.canPublishListing).toBe(true);
    expect(patch2.body.user.hostProfile.bio).toBe('I cook Oaxacan food.');
    expect(patch2.body.user.hostProfile.hostAgreementAcceptedAt).not.toBeNull();

    // The persisted flags EQUAL the single policy's answer after every mutation (IT-02).
    row = (await query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    const reserve = await policy.evaluate(userId, policy.ACTIONS.RESERVE_SEAT);
    const publish = await policy.evaluate(userId, policy.ACTIONS.PUBLISH_LISTING);
    expect(row.can_reserve_seat).toBe(reserve.allowed);
    expect(row.can_publish_listing).toBe(publish.allowed);
    expect(reserve.allowed).toBe(true);
    expect(publish.allowed).toBe(true);
  });

  test('incomplete host profile (bio without agreement) keeps canPublishListing false', async () => {
    const { userId, cookie } = await registerVerifyLogin();
    await request(app)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({ fullName: 'Half Host', phone: '+14155550103', hostProfile: { bio: 'WIP bio' } });
    const row = (await query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    expect(row.can_reserve_seat).toBe(true);
    expect(row.can_publish_listing).toBe(false);
    const publish = await policy.evaluate(userId, policy.ACTIONS.PUBLISH_LISTING);
    expect(publish.allowed).toBe(false);
    expect(publish.reasons).toContain(policy.REASONS.HOST_AGREEMENT_MISSING);
  });

  test('emergency contact: stored encrypted (NFR-13), readable by owner, clearable with null', async () => {
    const { userId, cookie } = await registerVerifyLogin();
    const contact = {
      name: 'Emma Contact',
      phone: '+14155550104',
      email: 'emma.contact@identity-unit.homeplate.invalid',
    };
    const set = await request(app)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({ emergencyContact: contact });
    expect(set.status).toBe(200);
    expect(set.body.user.emergencyContact).toEqual(contact);

    let row = (await query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    for (const column of [
      'emergency_contact_name_enc',
      'emergency_contact_phone_enc',
      'emergency_contact_email_enc',
    ]) {
      expect(row[column].startsWith('enc:v1:')).toBe(true);
    }
    expect(JSON.stringify(row)).not.toContain(contact.email);
    expect(JSON.stringify(row)).not.toContain(contact.phone);

    // NFR-13 deletion scope: null clears all three emergency-contact fields together.
    const clear = await request(app)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({ emergencyContact: null });
    expect(clear.status).toBe(200);
    expect(clear.body.user.emergencyContact).toBeNull();
    row = (await query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    expect(row.emergency_contact_name_enc).toBeNull();
    expect(row.emergency_contact_phone_enc).toBeNull();
    expect(row.emergency_contact_email_enc).toBeNull();
  });

  test('invalid phone → 422; unauthenticated PATCH → 401', async () => {
    const { cookie } = await registerVerifyLogin();
    const bad = await request(app)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({ phone: 'not-a-phone' });
    expect(bad.status).toBe(422);

    const anonymous = await request(app).patch('/api/users/me').send({ fullName: 'Nobody' });
    expect(anonymous.status).toBe(401);
  });
});

// ================================================================================================
// Outbox handler: email.verification → transport → NOTIFICATION_ATTEMPT (FR-10 end-to-end)
// ================================================================================================
describe('email.verification outbox handler (FR-10 end-to-end, ADR-011)', () => {
  // Required lazily: these load src/adapters/* (worker-side world), which must never be
  // touched by the request-path tests above.
  let dispatch;
  let mockTransport;

  beforeAll(() => {
    // eslint-disable-next-line global-require
    dispatch = require('../../src/outbox/dispatch');
    // eslint-disable-next-line global-require
    mockTransport = require('../../src/adapters/mockTransport');
  });

  beforeEach(() => {
    mockTransport.reset();
  });

  async function registeredJob() {
    const { user } = await authService.register({ email: uniqueEmail(), password: PASSWORD });
    const { rows } = await query(
      `SELECT * FROM outbox_jobs WHERE type = 'email.verification' AND payload->>'userId' = $1`,
      [user.id]
    );
    expect(rows).toHaveLength(1);
    return { user, job: rows[0] };
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

  test('handler is discovered by the dispatch registry under type email.verification', () => {
    const registry = dispatch.loadHandlers({ log: logger });
    expect(registry.has('email.verification')).toBe(true);
    expect(typeof registry.get('email.verification').handle).toBe('function');
  });

  test('handle() sends via the transport contract and records a NOTIFICATION_ATTEMPT row', async () => {
    const { user, job } = await registeredJob();
    const handler = dispatch.loadHandlers({ log: logger }).get('email.verification');

    const result = await handler.handle(job.payload, ctxFor(job));
    expect(result.status).toBe('sent');

    const { rows } = await query(
      'SELECT * FROM notification_attempts WHERE recipient_user_id = $1',
      [user.id]
    );
    expect(rows).toHaveLength(1);
    const attempt = rows[0];
    expect(attempt.channel).toBe('email'); // ADR-011: email is the v1.0 channel
    expect(attempt.template).toBe('email.verification');
    expect(attempt.status).toBe('sent');
    expect(attempt.idempotency_key).toBe(job.dedupe_key);
    // §3.4 PII register: params carry IDs/digests only.
    expect(Object.keys(attempt.params).sort()).toEqual(['tokenHash', 'userId']);
    expect(JSON.stringify(attempt.params)).not.toMatch(/@/);

    const delivered = mockTransport.deliveries();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].userId).toBe(user.id);
    expect(delivered[0].template).toBe('email.verification');
  });

  test('redelivery of the same job is exactly-once: one row, one send (RT-02 idempotency)', async () => {
    const { user, job } = await registeredJob();
    const handler = dispatch.loadHandlers({ log: logger }).get('email.verification');

    await handler.handle(job.payload, ctxFor(job));
    const replay = await handler.handle(job.payload, ctxFor(job)); // worker crash redelivery
    expect(replay.status).toBe('sent');

    const { rows } = await query(
      'SELECT count(*)::int AS n FROM notification_attempts WHERE recipient_user_id = $1',
      [user.id]
    );
    expect(rows[0].n).toBe(1);
    expect(mockTransport.deliveries()).toHaveLength(1); // no double send
  });

  test('provider outage: handler throws (outbox will retry), attempt row reads failed; later retry succeeds (NFR-09)', async () => {
    const { user, job } = await registeredJob();
    const handler = dispatch.loadHandlers({ log: logger }).get('email.verification');

    // Exhaust the transport's own bounded retries (1 try + config.adapters.retryMax).
    mockTransport.injectFailures(1 + config.adapters.retryMax);
    await expect(handler.handle(job.payload, ctxFor(job))).rejects.toThrow(/delivery failed/);

    let attempt = (
      await query('SELECT * FROM notification_attempts WHERE recipient_user_id = $1', [user.id])
    ).rows[0];
    expect(attempt.status).toBe('failed');
    expect(attempt.last_error).not.toBeNull();

    // The worker's next redelivery (idempotency key reuses the row) succeeds after recovery.
    const retry = await handler.handle(job.payload, ctxFor(job));
    expect(retry.status).toBe('sent');
    attempt = (
      await query('SELECT * FROM notification_attempts WHERE recipient_user_id = $1', [user.id])
    ).rows[0];
    expect(attempt.status).toBe('sent');
    expect(attempt.attempt_count).toBeGreaterThanOrEqual(2);
  }, 30000);

  test('handler rejects a malformed payload (caller bug → outbox dead-letter path)', async () => {
    const handler = dispatch.loadHandlers({ log: logger }).get('email.verification');
    await expect(handler.handle({ userId: 'not-a-uuid', tokenHash: 'nope' }, {})).rejects.toThrow(
      /userId must be a UUID/
    );
    await expect(
      handler.handle({ userId: crypto.randomUUID(), tokenHash: 'nope' }, {})
    ).rejects.toThrow(/tokenHash/);
  });
});

// ================================================================================================
// Audit records + PII-free logs (NFR-08 / MT-01)
// ================================================================================================
describe('audit records and PII-free logs (NFR-08)', () => {
  test('registration/login/verification/logout each emit an audit record with a correlation ID', async () => {
    const email = uniqueEmail();
    const marker = logLines.length;
    const reg = await request(app).post('/api/auth/register').send({ email, password: PASSWORD });
    expect(reg.status).toBe(201);
    const { rows } = await query(
      `SELECT token_hash FROM email_verification_tokens WHERE user_id = $1`,
      [reg.body.user.id]
    );
    expect(rows).toHaveLength(1);
    const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `${COOKIE_NAME}=${cookieTokenFrom(login)}`);

    const records = logLines
      .slice(marker)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.audit === true);

    const registered = records.find((r) => r.event === 'user.registered');
    expect(registered).toBeDefined();
    expect(registered.outcome).toBe('success');
    expect(registered.actorUserId).toBe(reg.body.user.id);
    expect(registered.correlationId).toBe(reg.headers['x-correlation-id']);

    const loggedIn = records.find((r) => r.event === 'auth.login' && r.outcome === 'success');
    expect(loggedIn).toBeDefined();
    expect(loggedIn.actorUserId).toBe(reg.body.user.id);
    expect(loggedIn.correlationId).toBe(login.headers['x-correlation-id']);

    const loggedOut = records.find((r) => r.event === 'auth.logout');
    expect(loggedOut).toBeDefined();
    expect(loggedOut.outcome).toBe('success');
  });

  test('captured log output carries no plaintext password and no raw email address (SRS §3.4)', () => {
    const everything = logLines.join('\n');
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain('definitely-wrong');
    // Any email that reached a log line was scrubbed to [REDACTED] by U1-OBS.
    expect(everything).not.toMatch(/@identity-unit\.homeplate\.invalid/);
    expect(everything).not.toMatch(/@dbunit\.homeplate\.invalid/);
  });
});
