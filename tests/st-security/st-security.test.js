// tests/st-security/st-security.test.js — VERIFIER lane "st-security" (SRS §4.3).
// ST-01..ST-06 + abuse cases AB-01..AB-08. This file is owned by the st-security verifier;
// it does NOT modify application source. Every "pass" here is backed by an executed
// assertion, not a code read.
//
// Shared-database discipline (NFR-08 determinism, finding MTQ-03): every suite shares ONE
// seeded homeplate_test database, so this lane NEVER calls truncateAll()/reseedBase() or
// deletes rows it did not create — destructive resets belong to tests/helpers/globalSetup.js
// only. All fixtures here are uniquely keyed (newEmail() below / db.makeUser), and Redis
// cleanup is scoped to this lane's own rate-limit counters.
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const https = require('https');
const tls = require('tls');
const { once } = require('events');
const request = require('supertest');

const ROOT = path.join(__dirname, '..', '..');
const baseConfig = require('../../src/config');
const { createApp } = require('../../src/app');
const { buildTlsOptions, start } = require('../../src/server');
const { enforceTls, HSTS_MAX_AGE_SECONDS } = require('../../src/middleware/security');
const { validateEnv } = require('../../src/config/schema');
const passwords = require('../../src/modules/auth/passwords');
const rateLimit = require('../../src/modules/auth/rateLimit');
const sessions = require('../../src/modules/auth/sessions');
const fieldCrypto = require('../../src/db/fieldCrypto');
const db = require('../helpers/db');
const { grepSrc } = require('../helpers/srcGrep');
const { quietLogger, serverBinder } = require('../helpers/httpHarness');
const { redis, closeRedis } = require('../../src/db/redis');

function configWith(serverOverrides = {}, rootOverrides = {}) {
  return {
    ...baseConfig,
    ...rootOverrides,
    server: { ...baseConfig.server, ...serverOverrides },
  };
}

// App under test: transport relaxed (test env) so Supertest can drive it over http.
const app = createApp({ config: baseConfig, logger: quietLogger() });

// Deterministic loopback binding — see tests/helpers/httpHarness.js (finding STS-R2-01).
const binder = serverBinder();
afterAll(() => binder.closeAll());
const listener = binder.bind(app);
const api = () => request(listener);

function cookieFromLogin(res) {
  const setCookie = res.headers['set-cookie'] || [];
  const hp = setCookie.find((c) => c.startsWith(`${baseConfig.auth.sessionCookieName}=`));
  if (!hp) return null;
  return hp.split(';')[0]; // "hp.sid=<token>"
}

let uniq = 0;
function newEmail() {
  uniq += 1;
  return `stsec.${process.pid}.${Date.now()}.${uniq}@st-security.invalid`;
}

// Supertest requests originate from one loopback IP; which textual form shows up depends on
// the address family the throwaway server bound, so all spellings are cleared/inspected.
const LOOPBACK_KEYS = ['::ffff:127.0.0.1', '127.0.0.1', '::1', 'unknown'];

async function delRateLimitKeys(...emails) {
  // Clear only our own counters — never flushdb (other lanes share redis index 1).
  for (const email of emails) await redis.del(rateLimit.accountKey(email));
  for (const ip of LOOPBACK_KEYS) await redis.del(rateLimit.ipKey(ip));
}

/** Session cookie for a db-factory user (no HTTP login round trip needed). */
async function cookieFor(user) {
  const { token } = await sessions.createSession({ id: user.id, roles: user.roles });
  return `${baseConfig.auth.sessionCookieName}=${token}`;
}

afterAll(async () => {
  // Leave no poisoned per-IP lockout behind for sibling suites, even after a failure.
  await delRateLimitKeys();
  await db.closeDb();
  await closeRedis();
});

// ---------------------------------------------------------------------------------------------
// ST-01 — TLS: refuse plain HTTP, permit no protocol below TLS 1.2
// ---------------------------------------------------------------------------------------------
describe('ST-01 TLS enforcement (NFR-03, AB-05)', () => {
  test('HTTPS server options pin minVersion TLSv1.2', () => {
    const opts = buildTlsOptions(baseConfig);
    expect(opts.minVersion).toBe('TLSv1.2');
    expect(opts.cert).toBeTruthy();
    expect(opts.key).toBeTruthy();
  });

  test('server.js source literally sets minVersion TLSv1.2 (config review)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
    expect(src).toMatch(/minVersion:\s*'TLSv1\.2'/);
  });

  test('enforceTls refuses plain HTTP with 403 HTTPS_REQUIRED — and the refusal itself carries HSTS and hardening headers', async () => {
    // Merged from the wave-3 re-verification pass: HSTS must be present on the plain-HTTP
    // refusal itself (not just on a happy-path response), and the refusal must never serve
    // the requested content.
    const httpsApp = createApp({
      config: configWith({ enforceHttps: true }),
      logger: quietLogger(),
    });
    const res = await request(binder.bind(httpsApp)).get('/health');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('HTTPS_REQUIRED');
    expect(res.body.status).toBeUndefined(); // never served the liveness content
    const hsts = res.headers['strict-transport-security'] || '';
    expect(Number(/max-age=(\d+)/.exec(hsts)[1])).toBeGreaterThanOrEqual(15552000);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('HSTS header (max-age >= 15552000) is present on responses', async () => {
    const res = await api().post('/api/auth/login').send({ email: 'x@y.z', password: 'nope' });
    const hsts = res.headers['strict-transport-security'];
    expect(hsts).toBeTruthy();
    const m = /max-age=(\d+)/.exec(hsts);
    expect(Number(m[1])).toBeGreaterThanOrEqual(15552000);
    expect(HSTS_MAX_AGE_SECONDS).toBeGreaterThanOrEqual(15552000);
  });

  test('config fails closed: ENFORCE_HTTPS=false under NODE_ENV=production is rejected', () => {
    const bad = { ...process.env, NODE_ENV: 'production', ENFORCE_HTTPS: 'false' };
    expect(() => validateEnv(bad)).toThrow(/ENFORCE_HTTPS/);
  });

  test('enforceTls factory throws when constructed relaxed under production (fail closed)', () => {
    expect(() =>
      enforceTls({ server: { enforceHttps: false }, env: 'production', isProduction: true })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// ST-01 (cont.) — a REAL https.Server started through src/server.js:start() (NFR-03, AB-05).
// Merged from the wave-3 re-verification pass, which closed the gap that ST-01 was previously
// proven only against a listener assembled in the test from buildTlsOptions(): these tests
// drive the SAME construction path the production process uses — plain-HTTP bytes on the TLS
// port, TLS 1.0/1.1 refusal, TLS 1.2/1.3 acceptance, and HSTS on a real TLS response.
// ---------------------------------------------------------------------------------------------
describe('ST-01 live server via start(): TLS 1.2+ only, plain HTTP never served (NFR-03)', () => {
  let server;
  let port;
  // DETERMINISM (verification round 2 — see finding STS-R2-01). src/server.js binds the
  // WILDCARD address (`server.listen(config.server.port)` -> '::' dual-stack). The loopback
  // ephemeral-port space is machine-global: any sibling process — another verifier lane's jest
  // run, tests/rt-lt-resilience/lt01-race.test.js and lt01-run.js both do exactly this — may
  // legally bind a PLAINTEXT server to the SPECIFIC address 127.0.0.1 on the same port number
  // while we hold it on '::' (proven: the specific bind succeeds, the wildcard one gets
  // EADDRINUSE). BSD routing then sends every connection to 127.0.0.1:<port> to the sibling, so
  // `tls.connect('127.0.0.1')` speaks TLS to a cleartext server and dies with
  // ERR_SSL_PACKET_LENGTH_TOO_LONG — a red TLS test with nothing wrong in the TLS code.
  // Cause-level fix: address the server on the address family it actually bound, which a
  // specific-address sibling cannot shadow.
  let host;

  beforeAll(async () => {
    // The production posture: transport enforcement ON. start() builds the same app factory
    // the process uses, over the same buildTlsOptions().
    const config = configWith(
      { port: 0, enforceHttps: true },
      { env: 'test', isProduction: false }
    );
    server = start({ config, logger: quietLogger() });
    await once(server, 'listening');
    const addr = server.address();
    port = addr.port;
    host = addr.family === 'IPv6' ? '::1' : '127.0.0.1';
  });

  afterAll(async () => {
    if (server) {
      server.close();
      await once(server, 'close').catch(() => {});
    }
  });

  test('plain-HTTP bytes on the TLS port are never answered with application content', async () => {
    const socket = net.connect(port, host);
    await once(socket, 'connect');
    socket.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    await once(socket, 'close');
    const body = Buffer.concat(chunks).toString('latin1');
    // A TLS listener answers a cleartext HTTP request with a TLS alert or nothing at all.
    expect(body).not.toMatch(/^HTTP\/1\.[01] 200/);
    expect(body).not.toContain('"status":"ok"');
  });

  test('TLS 1.0 and TLS 1.1 handshakes are REFUSED; 1.2 and 1.3 are accepted', async () => {
    const tryVersion = (version) =>
      new Promise((resolve) => {
        const s = tls.connect(
          {
            port,
            host,
            rejectUnauthorized: false,
            minVersion: version,
            maxVersion: version,
          },
          () => {
            const negotiated = s.getProtocol();
            s.destroy();
            resolve({ ok: true, negotiated });
          }
        );
        s.on('error', (err) => resolve({ ok: false, error: err.code || err.message }));
      });

    const v10 = await tryVersion('TLSv1');
    const v11 = await tryVersion('TLSv1.1');
    const v12 = await tryVersion('TLSv1.2');
    const v13 = await tryVersion('TLSv1.3');
    expect(v10.ok).toBe(false);
    expect(v11.ok).toBe(false);
    expect(v12).toEqual({ ok: true, negotiated: 'TLSv1.2' });
    expect(v13).toEqual({ ok: true, negotiated: 'TLSv1.3' });
  });

  test('over TLS the API answers, is unauthenticated-walled, and carries HSTS', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          port,
          host,
          path: '/api/users/me',
          method: 'GET',
          rejectUnauthorized: false,
        },
        (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () =>
            resolve({
              status: r.statusCode,
              headers: r.headers,
              body: Buffer.concat(chunks).toString(),
            })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(401); // AB-08: personal data is never served unauthenticated
    const m = /max-age=(\d+)/.exec(res.headers['strict-transport-security'] || '');
    expect(m).toBeTruthy();
    expect(Number(m[1])).toBeGreaterThanOrEqual(15552000);
  });
});

// ---------------------------------------------------------------------------------------------
// ST-02 — Password handling (NFR-04, AB-05)
// ---------------------------------------------------------------------------------------------
describe('ST-02 password hashing (NFR-04)', () => {
  test('register stores an Argon2id/bcrypt hash, never the plaintext', async () => {
    const email = newEmail();
    const password = 'CorrectHorseBatteryStaple1';
    const res = await api().post('/api/auth/register').send({ email, password, fullName: 'Pat Q' });
    expect(res.status).toBe(201);

    const { rows } = await db.query('SELECT password_hash FROM users WHERE email = $1', [email]);
    const hash = rows[0].password_hash;
    expect(hash).not.toContain(password);
    // Format + parameters (Argon2id m>=19456,t>=2 OR bcrypt cost>=12).
    if (hash.startsWith('$argon2id$')) {
      const m = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
      expect(m).toBeTruthy();
      expect(Number(m[1])).toBeGreaterThanOrEqual(19456);
      expect(Number(m[2])).toBeGreaterThanOrEqual(2);
    } else {
      const m = /^\$2[aby]\$(\d+)\$/.exec(hash);
      expect(m).toBeTruthy();
      expect(Number(m[1])).toBeGreaterThanOrEqual(12);
    }
    expect(passwords.activeAlgorithm).toMatch(/argon2id|bcrypt/);
  });

  test('plaintext appears in no column of the row', async () => {
    const email = newEmail();
    const password = 'UniqueSecret-9f3aQ!plain';
    await api().post('/api/auth/register').send({ email, password });
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(password);
  });

  test('same password -> different hashes (per-user salt)', async () => {
    const password = 'SamePasswordTwice-123';
    const e1 = newEmail();
    const e2 = newEmail();
    await api().post('/api/auth/register').send({ email: e1, password });
    await api().post('/api/auth/register').send({ email: e2, password });
    const { rows } = await db.query(
      'SELECT email, password_hash FROM users WHERE email = ANY($1)',
      [[e1, e2]]
    );
    expect(rows.length).toBe(2);
    expect(rows[0].password_hash).not.toBe(rows[1].password_hash);
  });

  test('register/login responses never echo the password field', async () => {
    const email = newEmail();
    const password = 'NeverEchoed-55';
    const reg = await api().post('/api/auth/register').send({ email, password });
    expect(JSON.stringify(reg.body)).not.toContain(password);
    const login = await api().post('/api/auth/login').send({ email, password });
    expect(JSON.stringify(login.body)).not.toContain(password);
    await delRateLimitKeys(email);
  });

  test('grep: no source module logs/serializes a raw password field', () => {
    // Static review across src/: assert no obvious plaintext-password sink.
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          const text = fs.readFileSync(full, 'utf8');
          // log(...) or JSON with a .password or password: value being emitted
          if (/log[^\n]*\bpassword\b\s*[:,]/i.test(text) && !/redact|sensitive|never/i.test(text)) {
            offenders.push(full);
          }
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });

  test('repo-wide scan: no source file writes a plaintext password to a column or a response', () => {
    // Merged from the wave-3 re-verification pass: the scan above targets password SINKS in
    // log calls; this one targets password STORAGE — a column literally named "password"
    // (not password_hash) in any schema/migration, or an INSERT/UPDATE assigning a raw
    // password value, across src/, db/ and scripts/.
    const offenders = [];
    const skip = new Set(['node_modules', '.git', 'coverage', 'certs', 'client']);
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') || entry.name.endsWith('.sql')) {
          const text = fs.readFileSync(full, 'utf8').replace(/\/\/.*$/gm, '');
          // a column literally named "password" (not password_hash), or an INSERT/UPDATE
          // that assigns a raw password value.
          if (/\bpassword\b\s+(text|varchar|character)/i.test(text))
            offenders.push(`${full}:column`);
          if (/(INSERT|UPDATE)[\s\S]{0,200}?\bpassword\b\s*=\s*[^=]/i.test(text))
            offenders.push(`${full}:assignment`);
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    walk(path.join(ROOT, 'db'));
    walk(path.join(ROOT, 'scripts'));
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// ST-03 — Account lockout after 5 failed attempts in 10 minutes (NFR-05, AB-05)
// ---------------------------------------------------------------------------------------------
describe('ST-03 login lockout (NFR-05)', () => {
  test('5 failures then 6th locked out with Retry-After even for correct credentials', async () => {
    const email = newEmail();
    const password = 'RealPassword-321';
    await api().post('/api/auth/register').send({ email, password });
    await delRateLimitKeys(email);

    // Attempts 1..5: wrong password -> 401 invalid credentials.
    for (let i = 1; i <= 5; i += 1) {
      const res = await api().post('/api/auth/login').send({ email, password: 'wrong-pass' });
      expect(res.status).toBe(401);
    }
    // Attempt 6: CORRECT credentials, but locked out -> 429 with Retry-After.
    const locked = await api().post('/api/auth/login').send({ email, password });
    expect(locked.status).toBe(429);
    expect(locked.headers['retry-after']).toBeTruthy();
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);

    await delRateLimitKeys(email);
  });

  test('after the window resets, correct credentials succeed', async () => {
    const email = newEmail();
    const password = 'RealPassword-654';
    await api().post('/api/auth/register').send({ email, password });
    await delRateLimitKeys(email);
    for (let i = 1; i <= 5; i += 1) {
      await api().post('/api/auth/login').send({ email, password: 'wrong-pass' });
    }
    // Simulate window expiry by clearing the counters (TTL elapse).
    await delRateLimitKeys(email);
    const ok = await api().post('/api/auth/login').send({ email, password });
    expect(ok.status).toBe(200);
    await delRateLimitKeys(email);
  });

  test('a successful login resets the account counter', async () => {
    const email = newEmail();
    const password = 'RealPassword-987';
    await api().post('/api/auth/register').send({ email, password });
    await delRateLimitKeys(email);
    // 4 failures (below threshold)
    for (let i = 1; i <= 4; i += 1) {
      await api().post('/api/auth/login').send({ email, password: 'wrong-pass' });
    }
    // success resets account counter
    const ok = await api().post('/api/auth/login').send({ email, password });
    expect(ok.status).toBe(200);
    const acct = await redis.get(rateLimit.accountKey(email));
    expect(acct === null || Number(acct) === 0).toBe(true);
    await delRateLimitKeys(email);
  });

  test('AB-05 scripted brute-force of 50 attempts: locked from attempt 6 on, correct password refused throughout', async () => {
    const email = newEmail();
    const password = 'RealPassword-050';
    await api().post('/api/auth/register').send({ email, password });
    await delRateLimitKeys(email);

    const statuses = [];
    for (let i = 1; i <= 50; i += 1) {
      // Attackers mix guesses; make attempt 30 the CORRECT password — it must still be 429.
      const guess = i === 30 ? password : `guess-${i}`;
      const res = await api().post('/api/auth/login').send({ email, password: guess });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true); // incl. the correct one
    expect(statuses[29]).toBe(429);
    await delRateLimitKeys(email);
  });

  test('the account window TTL starts at loginWindowSeconds and is NOT extended by later failures', async () => {
    // Merged from the wave-3 re-verification pass: the window is FIXED, not sliding — a
    // sliding-reset bug would let an attacker keep an account locked forever by failing once
    // per window.
    const email = newEmail();
    const password = 'WindowSemantics-1';
    await api().post('/api/auth/register').send({ email, password });
    await delRateLimitKeys(email);
    try {
      await api().post('/api/auth/login').send({ email, password: 'nope' });
      const ttl1 = await redis.ttl(rateLimit.accountKey(email));
      expect(ttl1).toBeGreaterThan(0);
      expect(ttl1).toBeLessThanOrEqual(baseConfig.auth.loginWindowSeconds);
      expect(ttl1).toBeGreaterThan(baseConfig.auth.loginWindowSeconds - 5);
      // Shrink the TTL, then fail again: a sliding-reset bug would push it back to 600.
      await redis.expire(rateLimit.accountKey(email), 60);
      await api().post('/api/auth/login').send({ email, password: 'nope' });
      const ttl2 = await redis.ttl(rateLimit.accountKey(email));
      expect(ttl2).toBeLessThanOrEqual(60);
    } finally {
      await delRateLimitKeys(email);
    }
  });

  test('AB-05 credential stuffing: one source IP cycling many ACCOUNTS is locked out', async () => {
    // Merged from the wave-3 re-verification pass: the per-account counter alone cannot see
    // credential stuffing (one guess per account across many accounts), so the per-SOURCE-IP
    // counter must fire on its own.
    const threshold = baseConfig.auth.loginMaxAttempts * rateLimit.IP_ATTEMPT_MULTIPLIER;
    const victims = [];
    try {
      await delRateLimitKeys();
      // Fail ONE attempt against each of `threshold` distinct (non-existent) accounts, so no
      // per-account counter ever reaches 5 — only the per-IP counter can fire.
      for (let i = 0; i < threshold; i += 1) {
        const email = newEmail();
        victims.push(email);
        const res = await api().post('/api/auth/login').send({ email, password: 'bad' });
        expect(res.status).toBe(401);
      }
      const ipCounts = await Promise.all(LOOPBACK_KEYS.map((ip) => redis.get(rateLimit.ipKey(ip))));
      const recorded = ipCounts.map(Number).filter((n) => n > 0);
      expect(recorded.length).toBe(1); // exactly one source key was used
      expect(recorded[0]).toBe(threshold);

      // A brand-new account from the same IP — never failed once — is now locked out.
      const fresh = newEmail();
      const password = 'CleanAccount-9';
      await api().post('/api/auth/register').send({ email: fresh, password });
      victims.push(fresh);
      const blocked = await api().post('/api/auth/login').send({ email: fresh, password });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await delRateLimitKeys(...victims);
    }
  });

  test('lockout responses never reveal whether the account exists (AB-05 enumeration)', async () => {
    // tests/unit/identity.test.js asserts status+code parity for known vs unknown accounts;
    // this pins full MESSAGE parity too, so no copy tweak can reintroduce enumeration.
    const known = newEmail();
    const password = 'Enumerate-1';
    await api().post('/api/auth/register').send({ email: known, password });
    const unknown = newEmail();
    await delRateLimitKeys(known, unknown);
    try {
      const a = await api().post('/api/auth/login').send({ email: known, password: 'bad' });
      const b = await api().post('/api/auth/login').send({ email: unknown, password: 'bad' });
      expect(a.status).toBe(b.status);
      expect(a.body.error.code).toBe(b.body.error.code);
      expect(a.body.error.message).toBe(b.body.error.message);
    } finally {
      await delRateLimitKeys(known, unknown);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// ST-04 — Injection suite (NFR-11, AB-06)
// ---------------------------------------------------------------------------------------------
describe('ST-04 injection defenses (NFR-11, AB-06)', () => {
  const SQLI = ["' OR 1=1 --", "'; DROP TABLE users; --", "admin'--", '1; DELETE FROM users'];
  const XSS = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg/onload=alert(1)>',
  ];

  test('SQLi payloads at auth boundaries never 500 and never drop tables', async () => {
    const before = await db.countRows('users');
    for (const p of SQLI) {
      // login email/password
      const r1 = await api().post('/api/auth/login').send({ email: p, password: p });
      expect(r1.status).not.toBe(500);
      // register with payload as fullName (valid email so it reaches the DB layer)
      const r2 = await api()
        .post('/api/auth/register')
        .send({ email: newEmail(), password: 'ValidPass-123', fullName: p });
      expect(r2.status).not.toBe(500);
      // verify-email token param
      const r3 = await api().get('/api/auth/verify-email').query({ token: p });
      expect(r3.status).not.toBe(500);
    }
    // users table intact (still queryable, row count did not collapse to error)
    const after = await db.countRows('users');
    expect(after).toBeGreaterThanOrEqual(before);
  });

  test('XSS payloads in stored profile text are escaped (no raw <script> persists)', async () => {
    for (const p of XSS) {
      const email = newEmail();
      const res = await api()
        .post('/api/auth/register')
        .send({ email, password: 'ValidPass-123', fullName: p });
      expect(res.status).not.toBe(500);
      if (res.status === 201) {
        const { rows } = await db.query('SELECT full_name FROM users WHERE email = $1', [email]);
        const stored = rows[0].full_name || '';
        expect(stored).not.toContain('<script');
        expect(stored).not.toMatch(/<img[^>]*onerror/i);
        expect(stored).not.toContain('<svg');
      }
    }
  });

  test('every mounted route declares a validation schema (NFR-11 enumeration)', () => {
    const stack = app._router.stack;
    const routesWithoutSchema = [];
    const walk = (layer, mount) => {
      if (layer.route) {
        const p = mount + (layer.route.path === '/' ? '' : layer.route.path);
        const handlers = layer.route.stack.map((s) => s.handle);
        const hasValidator = handlers.some((h) => h && h.isValidator === true);
        if (!hasValidator) {
          routesWithoutSchema.push(`${Object.keys(layer.route.methods).join(',')} ${p}`);
        }
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        // best-effort mount path recovery from the regexp
        for (const l of layer.handle.stack) walk(l, mount);
      }
    };
    for (const l of stack) walk(l, '');
    // Wave 1-2 mounted routes (auth + users) must all carry a validator.
    expect(routesWithoutSchema).toEqual([]);
  });

  test('static grep: repositories build no string-concatenated / interpolated SQL', () => {
    const repoDir = path.join(ROOT, 'src', 'modules');
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          const text = fs.readFileSync(full, 'utf8');
          // Flag template literals / concatenation that inject a JS value INTO a SQL verb.
          if (/(SELECT|INSERT|UPDATE|DELETE)[^`'"]*\$\{[^}]+\}/i.test(text)) {
            // allow ${spec.column}/${sets.join} identifier-only interpolation? No: flag & inspect.
            offenders.push(full);
          }
          if (/\b(SELECT|INSERT|UPDATE|DELETE)\b[^;]*['"`]\s*\+\s*\w/i.test(text)) {
            offenders.push(full);
          }
        }
      }
    };
    walk(repoDir);
    // users/repo.js interpolates SET-clause fragments built from a FROZEN column allowlist
    // (values are always $n placeholders). Record which files interpolate so a human can
    // confirm they are identifier-only; the test asserts values are never interpolated.
    const valueInterp = offenders.filter((f) => {
      const t = fs.readFileSync(f, 'utf8');
      return /\$\{[^}]*\b(email|password|token|value|input|body|name|phone)\b[^}]*\}/i.test(
        t.replace(/\/\/.*$/gm, '')
      );
    });
    expect(valueInterp).toEqual([]);
  });

  // Merged from the wave-3 re-verification pass: the boundaries the tests above do not fire
  // at — PATCH /api/users/me (fullName, emergencyContact.name, hostProfile.bio) including a
  // stored-XSS round trip read back through the API, and the JSON body-size wall.
  describe('profile boundary (PATCH /api/users/me)', () => {
    let user;
    let cookie;
    beforeAll(async () => {
      // NOTE: this fixture carries a REAL fieldCrypto ciphertext, not the lane's usual
      // `phone_enc: 'enc:v1:fixture'` placeholder — see finding STS-W3-01: the owner-profile
      // serializer decrypts these columns, and this test reads the profile back through the API.
      user = await db.makeUser({ phone_enc: fieldCrypto.encrypt('+14155550142') });
      cookie = await cookieFor(user);
    });

    test('PATCH /api/users/me stores fullName / emergency name / bio ESCAPED and reads them back inert', async () => {
      const usersBefore = await db.countRows('users');
      for (const p of XSS) {
        const res = await api()
          .patch('/api/users/me')
          .set('Cookie', cookie)
          .send({
            fullName: `Pat ${p}`,
            emergencyContact: { name: `Kin ${p}`, phone: '+14155550100', email: 'kin@st.invalid' },
            hostProfile: { bio: `Bio ${p}` },
          });
        expect(res.status).not.toBe(500);
        expect(res.status).toBe(200);

        const { rows } = await db.query(`SELECT full_name FROM users WHERE id = $1`, [user.id]);
        expect(rows[0].full_name).not.toContain('<');
        const { rows: hp } = await db.query(`SELECT bio FROM host_profiles WHERE user_id = $1`, [
          user.id,
        ]);
        expect(hp[0].bio).not.toContain('<');

        // Second-order: reading it back through the API is inert too.
        const me = await api().get('/api/users/me').set('Cookie', cookie);
        expect(me.status).toBe(200);
        const flat = JSON.stringify(me.body);
        expect(flat).not.toContain('<script');
        expect(flat).not.toMatch(/<img[^>]*onerror/i);
        expect(flat).not.toContain('<svg');
      }
      expect(await db.countRows('users')).toBeGreaterThanOrEqual(usersBefore);
    });

    test('SQLi in profile fields is inert data — users and host_profiles survive', async () => {
      const before = await db.countRows('users');
      for (const p of SQLI) {
        const res = await api().patch('/api/users/me').set('Cookie', cookie).send({ fullName: p });
        expect(res.status).not.toBe(500);
        expect([200, 422]).toContain(res.status);
      }
      expect(await db.countRows('users')).toBeGreaterThanOrEqual(before);
      expect(await db.countRows('host_profiles')).toBeGreaterThanOrEqual(0);
    });

    test('an oversized JSON body is refused at the boundary, not by a crash (NFR-11)', async () => {
      const res = await api()
        .patch('/api/users/me')
        .set('Cookie', cookie)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ fullName: 'x'.repeat(2 * 1024 * 1024) }));
      expect([413, 422]).toContain(res.status);
      expect(res.status).not.toBe(500);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// ST-05 — Account deletion / erasure (NFR-12, ADR-004)  [wave-4 U4-PRIVACY endpoint/job]
// ---------------------------------------------------------------------------------------------
describe('ST-05 erasure (NFR-12) — endpoint/job are wave-4; primitives exist', () => {
  // (The media-erasure primitive itself — put -> deleteForUser -> per-key delete -> object
  // 404s, rows gone — is exercised against real MinIO in tests/adr-conformance/
  // adr-invariants.test.js, ADR-004 suite.)

  test('no account-deletion endpoint is mounted on any verb of /api/users/me', async () => {
    // Merged from the wave-3 re-verification pass: probed authenticated (so a session wall
    // cannot mask a mounted handler) and on POST as well as DELETE.
    const user = await db.makeUser({});
    const cookie = await cookieFor(user);
    const del = await api().delete('/api/users/me').set('Cookie', cookie);
    expect([404, 405]).toContain(del.status);
    const post = await api().post('/api/users/me').set('Cookie', cookie).send({});
    expect([404, 405]).toContain(post.status);
  });

  test('no erasure/retention job type is registered with the outbox dispatcher', () => {
    const dispatch = require('../../src/outbox/dispatch');
    const types = Object.keys(dispatch.buildRegistry ? dispatch.buildRegistry() : {});
    const registry = types.length
      ? types
      : fs.readdirSync(path.join(ROOT, 'src', 'outbox', 'handlers'));
    expect(registry.join(',')).not.toMatch(/eras|retent|delete|anonym/i);
  });

  test('backup-expiry is a documented 30-day config policy; no retention/backup script exists yet', () => {
    // ST-05 verifies backup expiry as configuration review (build-plan open item 8). The
    // policy's documented home is the config template (.env.example, NFR-12) — the 2026-08-14
    // plan revision no longer spells out the literal phrase, the configuration does.
    expect(baseConfig.privacy.erasureDays).toBe(30);
    expect(baseConfig.privacy.inactivityMonths).toBe(24);
    const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    expect(envExample).toMatch(/^PRIVACY_ERASURE_DAYS=30$/m);
    // A live retention sweep / backup script is a wave-4 U4-PRIVACY deliverable — not in this
    // run — and no backup-retention knob is documented before the code that honors it exists.
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'retention.js'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'backup.js'))).toBe(false);
    expect(envExample).not.toMatch(/BACKUP_RETENTION|BACKUP_EXPIR/i);
  });

  test('the NFR-12 erasure columns exist on users but are never written by wave-3 code', async () => {
    const { rows } = await db.query(
      `SELECT count(*)::int c FROM information_schema.columns
        WHERE table_name = 'users' AND column_name IN ('deleted_at','anonymized_at')`
    );
    expect(rows[0].c).toBe(2);
    // The only wave-3 reference is a READ in the eligibility repo's guard clause; nothing
    // SETS deleted_at/anonymized_at, so no erasure can happen today.
    expect(grepSrc('UPDATE users[^;]*SET[^;]*(anonymized_at|deleted_at)')).toBe('');
    expect(grepSrc('anonymized_at[[:space:]]*=[[:space:]]*(now|\\$)')).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// ST-06 — Encryption at rest, role-restricted+logged access, export (NFR-13)
// ---------------------------------------------------------------------------------------------
describe('ST-06 data protection (NFR-13)', () => {
  async function registerAndLogin() {
    const email = newEmail();
    const password = 'DataProtect-123';
    await api().post('/api/auth/register').send({ email, password, fullName: 'Data Owner' });
    await delRateLimitKeys(email);
    const login = await api().post('/api/auth/login').send({ email, password });
    return { email, cookie: cookieFromLogin(login), userId: login.body.user.id };
  }

  test('fieldCrypto AES-256-GCM: ciphertext != plaintext and round-trips', () => {
    const plain = '+14155550123';
    const ct = fieldCrypto.encrypt(plain);
    expect(ct).not.toBe(plain);
    expect(fieldCrypto.isEncrypted(ct)).toBe(true);
    expect(fieldCrypto.decrypt(ct)).toBe(plain);
    // Fresh IV per call: two encryptions differ.
    expect(fieldCrypto.encrypt(plain)).not.toBe(ct);
  });

  test('phone + emergency contact are stored as ciphertext (not plaintext) in the DB', async () => {
    const { cookie, userId } = await registerAndLogin();
    expect(cookie).toBeTruthy();
    const patch = await api()
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({
        phone: '+14155559999',
        emergencyContact: {
          name: 'Kin Person',
          phone: '+14155551111',
          email: 'kin@st-security.invalid',
        },
      });
    expect(patch.status).toBe(200);

    const { rows } = await db.query(
      `SELECT phone_enc, emergency_contact_name_enc, emergency_contact_phone_enc,
              emergency_contact_email_enc FROM users WHERE id = $1`,
      [userId]
    );
    const r = rows[0];
    expect(fieldCrypto.isEncrypted(r.phone_enc)).toBe(true);
    expect(r.phone_enc).not.toContain('4155559999');
    expect(fieldCrypto.isEncrypted(r.emergency_contact_name_enc)).toBe(true);
    expect(fieldCrypto.isEncrypted(r.emergency_contact_phone_enc)).toBe(true);
    expect(fieldCrypto.isEncrypted(r.emergency_contact_email_enc)).toBe(true);
    // Round-trips back to plaintext.
    expect(fieldCrypto.decrypt(r.phone_enc)).toBe('+14155559999');
  });

  test('GET /api/users/me output is an allowlist — no password_hash / raw ciphertext leaks', async () => {
    const { cookie } = await registerAndLogin();
    const res = await api().get('/api/users/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const flat = JSON.stringify(res.body);
    expect(flat).not.toMatch(/password_hash/);
    expect(flat).not.toMatch(/phone_enc/);
    expect(flat).not.toContain('enc:v1:');
  });

  test('the users table carries EXACTLY the §3.4 personal-data register (key-exact)', async () => {
    // Merged from the wave-3 re-verification pass: the register is asserted KEY-EXACTLY, so a
    // stray plaintext PII column cannot be added without this list — the §3.4 register —
    // being updated to admit it.
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' ORDER BY column_name`
    );
    const cols = rows.map((r) => r.column_name).sort();
    expect(cols).toEqual(
      [
        'anonymized_at',
        'can_publish_listing',
        'can_reserve_seat',
        'created_at',
        'deleted_at',
        'email',
        'email_verified',
        'emergency_contact_email_enc',
        'emergency_contact_name_enc',
        'emergency_contact_phone_enc',
        'full_name',
        'id',
        'last_active_at',
        'password_hash',
        'phone_enc',
        'roles',
        'updated_at',
      ].sort()
    );
  });

  test('emergency contact is exactly {name, phone, email} — a fourth attribute is rejected', async () => {
    const user = await db.makeUser({});
    const cookie = await cookieFor(user);
    const res = await api()
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({
        emergencyContact: {
          name: 'Kin',
          phone: '+14155550111',
          email: 'kin@st.invalid',
          relationship: 'sister', // NOT in the §3.4 register
          address: '1 Somewhere St',
        },
      });
    expect(res.status).toBe(200);
    const { rows } = await db.query(`SELECT (users.*)::text AS whole FROM users WHERE id = $1`, [
      user.id,
    ]);
    expect(rows[0].whole).not.toContain('sister');
    expect(rows[0].whole).not.toContain('Somewhere St');
  });

  test('no CCPA export path is mounted on any verb (wave-4 U4-PRIVACY)', async () => {
    const { cookie } = await registerAndLogin();
    for (const verb of ['post', 'get']) {
      const res = await api()[verb]('/api/users/me/export').set('Cookie', cookie);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect([404, 405]).toContain(res.status);
    }
  });

  test('access_log has exactly ONE writer: the ADR-010 access decision module (wave-3 landed)', async () => {
    const { rows } = await db.query(
      `SELECT count(*)::int c FROM information_schema.tables WHERE table_name = 'access_log'`
    );
    expect(rows[0].c).toBe(1); // schema is present (U1-DB)
    // Wave 3 landed the required NFR-13 writer: src/modules/listings/access.js logs the
    // moderator FR-07 precise-location read. It must stay the ONLY chokepoint that writes
    // access_log (a second writer would fragment the audit trail). Behavior is executed in
    // tests/st-security/st-security-wave3.test.js (ST-06 moderator suite).
    const found = require('child_process')
      .execFileSync('grep', ['-rl', 'access_log', path.join(ROOT, 'src')], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .sort();
    expect(found).toEqual([path.join(ROOT, 'src', 'modules', 'listings', 'access.js')]);
  });

  // Finding STS-W3-02 (FIXED): the config layer fails CLOSED on every other production-unsafe
  // combination (ENFORCE_HTTPS=false, mock adapters) but ACCEPTED the committed sample
  // FIELD_ENCRYPTION_KEY and the default MinIO credentials under NODE_ENV=production — i.e. an
  // operator who copied .env.example encrypted NFR-13 PII under a key published in this
  // repository, and exposed the media bucket on documented credentials (AB-08). The guard now
  // lives in the production branch of validateEnv(), so the assertions below are tightened from
  // "reproduce if still broken" to "must throw", while still proving the guard is not a blanket
  // ban: real, freshly generated credentials are accepted.
  function productionEnvFromExample(overrides = {}) {
    const env = {};
    for (const line of fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2];
    }
    return {
      ...env,
      NODE_ENV: 'production',
      ENFORCE_HTTPS: 'true',
      DATABASE_URL: 'postgres://u:p@h:5432/homeplate',
      REDIS_URL: 'redis://h:6379/0',
      NOTIFICATIONS_TRANSPORT: 'sendgrid',
      SENDGRID_API_KEY: 'SG.placeholder',
      SENDGRID_FROM_EMAIL: 'no-reply@homeplate.invalid',
      MAPS_MODE: 'live',
      MAPS_API_KEY: 'placeholder',
      LLM_MODERATION_MODE: 'live',
      LLM_MODERATION_BASE_URL: 'https://example.invalid',
      LLM_MODERATION_API_KEY: 'placeholder',
      MODERATION_MODEL: 'placeholder',
      ...overrides,
    };
  }

  // Credentials an operator would actually supply: 32 fresh random bytes and unguessable
  // object-storage credentials. Nothing here is committed anywhere.
  const realProductionSecrets = () => ({
    FIELD_ENCRYPTION_KEY: require('crypto').randomBytes(32).toString('hex'),
    OBJECT_STORAGE_ACCESS_KEY: require('crypto').randomBytes(12).toString('hex'),
    OBJECT_STORAGE_SECRET_KEY: require('crypto').randomBytes(24).toString('hex'),
  });

  test('STS-W3-02: production must refuse the committed sample FIELD_ENCRYPTION_KEY (NFR-13)', () => {
    const sampleKey = /^FIELD_ENCRYPTION_KEY=(.+)$/m.exec(
      fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8')
    )[1];
    expect(sampleKey).toMatch(/^[0-9a-f]{64}$/i); // a *valid-format* key ships in the repo

    // `cp .env.example .env` + real provider keys + NODE_ENV=production must NOT start.
    expect(() => validateEnv(productionEnvFromExample())).toThrow(/FIELD_ENCRYPTION_KEY/);
    // …and the same environment with only the key replaced still fails on the storage creds.
    expect(() =>
      validateEnv(
        productionEnvFromExample({
          FIELD_ENCRYPTION_KEY: require('crypto').randomBytes(32).toString('hex'),
        })
      )
    ).toThrow(/OBJECT_STORAGE_ACCESS_KEY[\s\S]*OBJECT_STORAGE_SECRET_KEY/);

    // Real, freshly generated credentials must always be accepted (not a blanket ban), and the
    // §3.4 PII columns are then encrypted under a key that exists only in the deployment.
    const real = realProductionSecrets();
    const cfg = validateEnv(productionEnvFromExample(real));
    expect(cfg.crypto.fieldEncryptionKeyHex).toBe(real.FIELD_ENCRYPTION_KEY);
    expect(cfg.crypto.fieldEncryptionKeyHex).not.toBe(sampleKey);
    expect(cfg.objectStorage.accessKey).not.toBe('minioadmin');
  });

  test('STS-W3-01 (FIXED, round 2): a non-canonical *_enc column degrades to null, never a 500', async () => {
    // Round-2 re-verification. The finding's original failure was: one non-canonical *_enc
    // column made GET *and* PATCH /api/users/me a permanent 500 for that account, so the owner
    // could neither read nor repair their own profile, and a FIELD_ENCRYPTION_KEY rotation would
    // lock out every user at once. src/modules/users/repo.js decryptForOwner() now renders null.
    // Three states are exercised: the lane placeholder, a REAL ciphertext under a DIFFERENT key
    // (an actual GCM auth failure = key rotation), and a healthy control.
    const rotated = (() => {
      // A canonical-looking ciphertext this process cannot authenticate.
      const crypto = require('crypto');
      const key = crypto.randomBytes(32);
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update('+14155559999', 'utf8'), c.final()]);
      return `enc:v1:${Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64')}`;
    })();
    for (const bad of ['enc:v1:fixture', rotated]) {
      const broken = await db.makeUser({
        phone_enc: bad,
        emergency_contact_name_enc: bad,
        emergency_contact_phone_enc: bad,
        emergency_contact_email_enc: bad,
      });
      const brokenCookie = await cookieFor(broken);
      const get = await api().get('/api/users/me').set('Cookie', brokenCookie);
      expect(get.status).toBe(200);
      expect(get.body.user.phone).toBeNull();
      expect(get.body.user.emergencyContact).toEqual({ name: null, phone: null, email: null });
      const patch = await api()
        .patch('/api/users/me')
        .set('Cookie', brokenCookie)
        .send({ fullName: 'Plain Name' });
      expect(patch.status).toBe(200);
      // The security property that had to survive the fix: no ciphertext, stack or internal
      // message ever reaches the client.
      const flat = JSON.stringify(get.body) + JSON.stringify(patch.body);
      expect(flat).not.toContain('enc:v1:');
      expect(flat).not.toMatch(/at .*\.js:\d+/);
      expect(flat).not.toMatch(/fieldCrypto/);
    }
    // Positive control: a healthy row still round-trips its real plaintext.
    const healthy = await db.makeUser({ phone_enc: fieldCrypto.encrypt('+14155550142') });
    const ok = await api()
      .get('/api/users/me')
      .set('Cookie', await cookieFor(healthy));
    expect(ok.status).toBe(200);
    expect(ok.body.user.phone).toBe('+14155550142');
  });

  test('STS-W3-05 (round 3): the ADR-007 data-use finding is RECORDED and human-signed', () => {
    // STS-W3-05 clause 1. Until 2026-08-18 this test asserted the OPPOSITE — that the sign-off
    // block still read `_unsigned_` — so a signature could not be lost silently and the clause
    // could not drift to "closed by assumption". The clause was ratified on 2026-08-18, so the
    // assertion is inverted rather than deleted: it now pins that the evidence is still present
    // AND that the signature is real, i.e. a named reviewer and an ISO date, matching §7.2's
    // machine-checkable predicate (no `_unsigned_` token left in the sign-off TABLE). Deleting
    // it would leave the clause unguarded in both directions. Same discipline as ADR-008's
    // label sign-off rule.
    const review = path.join(ROOT, 'docs', 'adr007-data-use-review.md');
    expect(fs.existsSync(review)).toBe(true);
    const text = fs.readFileSync(review, 'utf8');
    expect(text).toMatch(/https:\/\/ai\.google\.dev\/gemini-api\/terms/);
    expect(text).toMatch(/effective\s+\d{4}-\d{2}-\d{2}/i);

    // Signed: a named reviewer and an ISO review date, neither of them a placeholder.
    const reviewer = text.match(/\|\s*Reviewer \(name\)\s*\|([^|]+)\|/);
    const reviewed = text.match(/\|\s*Review date\s*\|([^|]+)\|/);
    expect(reviewer).not.toBeNull();
    expect(reviewed).not.toBeNull();
    expect(reviewer[1]).not.toMatch(/_unsigned_/);
    expect(reviewed[1]).not.toMatch(/_unsigned_/);
    expect(reviewer[1].replace(/[*\s]/g, '').length).toBeGreaterThan(0);
    const isoDate = reviewed[1].match(/\d{4}-\d{2}-\d{2}/);
    expect(isoDate).not.toBeNull();
    expect(Number.isNaN(Date.parse(isoDate[0]))).toBe(false);

    // The ratified answer still refuses real user content on the free tier (option (a) + (b)).
    expect(text).toMatch(/Live mode approved for real user content\?\s*\|\s*\*\*No\*\*/);

    // And the tree still cannot send real content anywhere: no moderation module exists.
    expect(fs.existsSync(path.join(ROOT, 'src', 'modules', 'moderation'))).toBe(false);
  });

  test('STS-W3-05 (round 2): the README deployment note documents volume/disk encryption', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    expect(readme).toMatch(/Deployment — data at rest/);
    expect(readme).toMatch(/encrypted volume/i);
    expect(readme).toMatch(/backup/i);
    expect(readme).toMatch(/30 days/);
  });
});

// ---------------------------------------------------------------------------------------------
// Abuse cases AB-01..AB-08 — reported explicitly
// ---------------------------------------------------------------------------------------------
describe('Abuse cases AB-01..AB-08', () => {
  test('AB-05 account takeover: opaque >=128-bit session cookie, HttpOnly+Secure+SameSite; logout invalidates', async () => {
    const email = newEmail();
    const password = 'Takeover-123';
    await api().post('/api/auth/register').send({ email, password });
    await delRateLimitKeys(email);
    const login = await api().post('/api/auth/login').send({ email, password });
    const setCookie = (login.headers['set-cookie'] || [])[0] || '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    const cookie = cookieFromLogin(login);
    const token = cookie.split('=')[1];
    // >= 256 bits: base64url of 32 bytes = 43 chars.
    expect(token.length).toBeGreaterThanOrEqual(43);

    // Session works, then logout invalidates it.
    const me1 = await api().get('/api/users/me').set('Cookie', cookie);
    expect(me1.status).toBe(200);
    await api().post('/api/auth/logout').set('Cookie', cookie);
    const me2 = await api().get('/api/users/me').set('Cookie', cookie);
    expect(me2.status).toBe(401);
    await delRateLimitKeys(email);
  });

  test('AB-07 duplicate email registration -> 409 (unique constraint)', async () => {
    const email = newEmail();
    const password = 'DupEmail-123';
    const r1 = await api().post('/api/auth/register').send({ email, password });
    expect(r1.status).toBe(201);
    const r2 = await api().post('/api/auth/register').send({ email, password });
    expect(r2.status).toBe(409);
  });

  test('AB-08 scraping personal data: unauthenticated profile read -> 401', async () => {
    const res = await api().get('/api/users/me');
    expect(res.status).toBe(401);
  });

  test('AB-06 injection: covered by ST-04 (no 500, tables intact, output escaped)', () => {
    expect(true).toBe(true); // marker — see ST-04 assertions
  });

  test('AB-04 abuse cases depend on wave-4 features not built in this run', () => {
    // AB-01 fake host/listing, AB-02 hoarding bookings and AB-03 spam listings become
    // verifiable as wave 3 lands (build-plan §7 — this run); the wave-3 verifiers extend this
    // lane with those cases. AB-04 abusive chat/reviews needs messaging+reviews+moderation,
    // which stay wave 4: their route modules must not be mounted in this run.
    for (const name of ['reviews', 'messaging', 'moderation']) {
      const routesPath = path.join(ROOT, 'src', 'modules', name, 'routes.js');
      expect(fs.existsSync(routesPath)).toBe(false);
    }
  });
});
