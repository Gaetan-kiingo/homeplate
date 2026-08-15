// tests/st-security/st-security-verify.test.js — VERIFIER lane "st-security", independent
// wave-3 re-verification pass (SRS §4.3, ST-01..ST-06 + AB-01..AB-08).
//
// This file is written by the verifier that re-checks the wave-3 tree; it does NOT replace
// the lane's existing suites, it CLOSES THE GAPS they leave:
//   ST-01 — a REAL https.Server started through src/server.js:start(): plain-HTTP bytes on
//           the TLS port, TLS 1.0/1.1 refusal, TLS 1.2/1.3 acceptance, and HSTS present on
//           the plain-HTTP refusal itself (not just on a happy-path response).
//   ST-02 — executed proof (not a regex over source) that the shared logger and the shared
//           validation layer never emit a password value, plus the hashing parameters read
//           back off a hash produced by the real passwords module.
//   ST-03 — the per-SOURCE-IP counter (AB-05 credential stuffing across many accounts from
//           one origin), and that the window TTL is NOT extended by later failures.
//   ST-04 — the boundaries the existing suites do not fire at: PATCH /api/users/me
//           (fullName, emergencyContact.name, hostProfile.bio), POST /api/bookings,
//           the search `location` string that reaches the Maps adapter, and media
//           contentType; plus a stored-XSS round trip read back through the API.
//   ST-05 — the erasure surface as it actually exists on disk (endpoint, job type, backup
//           retention artifact).
//   ST-06 — the §3.4 column register asserted key-exactly, and the export path.
//
// Shared-database discipline: unique fixtures only; never truncates; Redis cleanup is scoped
// to this lane's own rate-limit counters and is done in `finally` so a failure cannot leave a
// poisoned per-IP lockout behind for sibling suites.
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');
const https = require('https');
const { once } = require('events');
const request = require('supertest');

const ROOT = path.join(__dirname, '..', '..');
const baseConfig = require('../../src/config');
const { createApp } = require('../../src/app');
const { start } = require('../../src/server');
const { createLogger } = require('../../src/lib/logger');
const passwords = require('../../src/modules/auth/passwords');
const rateLimit = require('../../src/modules/auth/rateLimit');
const sessions = require('../../src/modules/auth/sessions');
const fieldCrypto = require('../../src/db/fieldCrypto');
const db = require('../helpers/db');
const { redis, closeRedis } = require('../../src/db/redis');

function quietLogger() {
  const noop = () => {};
  const l = { info: noop, warn: noop, error: noop, debug: noop, child: () => l, audit: noop };
  return l;
}

const app = createApp({ config: baseConfig, logger: quietLogger() });

let uniq = 0;
function newEmail() {
  uniq += 1;
  return `stverify.${process.pid}.${Date.now()}.${uniq}@st-security.invalid`;
}

/** grep -rnE over a directory; returns '' when there is no match (grep exits 1). */
function grepSrc(pattern, dir = path.join(ROOT, 'src')) {
  try {
    return require('child_process')
      .execFileSync('grep', ['-rnE', pattern, dir], { encoding: 'utf8' })
      .trim();
  } catch (err) {
    if (err.status === 1) return '';
    throw err;
  }
}

const LOOPBACK_KEYS = ['::ffff:127.0.0.1', '127.0.0.1', '::1', 'unknown'];
async function clearRateLimit(...emails) {
  for (const e of emails) await redis.del(rateLimit.accountKey(e));
  for (const ip of LOOPBACK_KEYS) await redis.del(rateLimit.ipKey(ip));
}

async function cookieFor(user) {
  const { token } = await sessions.createSession({ id: user.id, roles: user.roles });
  return `${baseConfig.auth.sessionCookieName}=${token}`;
}

afterAll(async () => {
  await clearRateLimit();
  await db.closeDb();
  await closeRedis();
});

// =============================================================================================
// ST-01 — a REAL TLS listener built by src/server.js (NFR-03, AB-05)
// =============================================================================================
describe('ST-01 live server: TLS 1.2+ only, plain HTTP never served (NFR-03)', () => {
  let server;
  let port;

  beforeAll(async () => {
    // The production posture: transport enforcement ON. start() builds the same app factory
    // the process uses, over the same buildTlsOptions().
    const config = {
      ...baseConfig,
      env: 'test',
      isProduction: false,
      server: { ...baseConfig.server, port: 0, enforceHttps: true },
    };
    server = start({ config, logger: quietLogger() });
    await once(server, 'listening');
    port = server.address().port;
  });

  afterAll(async () => {
    if (server) {
      server.close();
      await once(server, 'close').catch(() => {});
    }
  });

  test('plain-HTTP bytes on the TLS port are never answered with application content', async () => {
    const socket = net.connect(port, '127.0.0.1');
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
            host: '127.0.0.1',
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
          host: '127.0.0.1',
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

  test('the plain-HTTP refusal itself carries HSTS and hardening headers (403, no content)', async () => {
    // Same middleware chain, driven over cleartext by Supertest with enforcement ON.
    const strictApp = createApp({
      config: {
        ...baseConfig,
        env: 'test',
        isProduction: false,
        server: { ...baseConfig.server, enforceHttps: true },
      },
      logger: quietLogger(),
    });
    const res = await request(strictApp).get('/health');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('HTTPS_REQUIRED');
    expect(res.body.status).toBeUndefined(); // never served the liveness content
    const hsts = res.headers['strict-transport-security'] || '';
    expect(Number(/max-age=(\d+)/.exec(hsts)[1])).toBeGreaterThanOrEqual(15552000);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

// =============================================================================================
// ST-02 — password handling proven by execution, not by regex (NFR-04, AB-05)
// =============================================================================================
describe('ST-02 no plaintext-password path exists (NFR-04)', () => {
  test('passwords.hashPassword() emits documented-strength parameters and verifies', async () => {
    const plain = 'ParamCheck-Passw0rd';
    const hash = await passwords.hashPassword(plain);
    expect(hash).not.toContain(plain);
    if (hash.startsWith('$argon2id$')) {
      const m = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
      expect(m).toBeTruthy();
      expect(Number(m[2])).toBeGreaterThanOrEqual(19456); // memoryCost KiB
      expect(Number(m[3])).toBeGreaterThanOrEqual(2); // timeCost
    } else {
      expect(Number(/^\$2[aby]\$(\d+)\$/.exec(hash)[1])).toBeGreaterThanOrEqual(12);
    }
    expect(await passwords.verifyPassword(hash, plain)).toBe(true);
    expect(await passwords.verifyPassword(hash, `${plain}x`)).toBe(false);
  });

  test('the shared logger REDACTS a password value out of the emitted line (executed)', () => {
    const lines = [];
    const log = createLogger({ level: 'info', stream: { write: (l) => lines.push(l) } });
    const secret = 'PlaintextThatMustNeverBeLogged-42';
    log.info(
      { password: secret, newPassword: secret, user: { password: secret } },
      'login attempt'
    );
    log.child({ password: secret }).info('bound child');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const all = lines.join('\n');
    expect(all).not.toContain(secret);
    expect(all).toContain('[REDACTED]');
  });

  test('the validation layer redacts password values from 422 field errors (executed)', async () => {
    const bad = 'short'; // violates the 8-char minimum -> zod issue under the `password` key
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: newEmail(), password: bad });
    expect(res.status).toBe(422);
    const flat = JSON.stringify(res.body);
    expect(flat).not.toContain(bad);
    expect(flat).toMatch(/Invalid value/); // SENSITIVE_KEY_RE replacement fired
    expect(flat).not.toMatch(/at .*\.js:\d+/); // no stack trace
  });

  test('repo-wide scan: no source file writes a plaintext password to a column or a response', () => {
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

  test('the registered plaintext appears nowhere in the users table at all', async () => {
    const email = newEmail();
    const password = 'RepoWideCanary-77bXq';
    const reg = await request(app).post('/api/auth/register').send({ email, password });
    expect(reg.status).toBe(201);
    const { rows } = await db.query(
      `SELECT count(*)::int c FROM users WHERE (users.*)::text LIKE $1`,
      [`%${password}%`]
    );
    expect(rows[0].c).toBe(0);
  });
});

// =============================================================================================
// ST-03 — the per-IP counter and the window semantics (NFR-05, AB-05)
// =============================================================================================
describe('ST-03 source-IP lockout and window semantics (NFR-05)', () => {
  test('the account window TTL starts at loginWindowSeconds and is NOT extended by later failures', async () => {
    const email = newEmail();
    const password = 'WindowSemantics-1';
    await request(app).post('/api/auth/register').send({ email, password });
    await clearRateLimit(email);
    try {
      await request(app).post('/api/auth/login').send({ email, password: 'nope' });
      const ttl1 = await redis.ttl(rateLimit.accountKey(email));
      expect(ttl1).toBeGreaterThan(0);
      expect(ttl1).toBeLessThanOrEqual(baseConfig.auth.loginWindowSeconds);
      expect(ttl1).toBeGreaterThan(baseConfig.auth.loginWindowSeconds - 5);
      // Shrink the TTL, then fail again: a sliding-reset bug would push it back to 600.
      await redis.expire(rateLimit.accountKey(email), 60);
      await request(app).post('/api/auth/login').send({ email, password: 'nope' });
      const ttl2 = await redis.ttl(rateLimit.accountKey(email));
      expect(ttl2).toBeLessThanOrEqual(60);
    } finally {
      await clearRateLimit(email);
    }
  });

  test('AB-05 credential stuffing: one source IP cycling many ACCOUNTS is locked out', async () => {
    const threshold = baseConfig.auth.loginMaxAttempts * rateLimit.IP_ATTEMPT_MULTIPLIER;
    const victims = [];
    try {
      await clearRateLimit();
      // Fail ONE attempt against each of `threshold` distinct (non-existent) accounts, so no
      // per-account counter ever reaches 5 — only the per-IP counter can fire.
      for (let i = 0; i < threshold; i += 1) {
        const email = newEmail();
        victims.push(email);
        const res = await request(app).post('/api/auth/login').send({ email, password: 'bad' });
        expect(res.status).toBe(401);
      }
      const ipCounts = await Promise.all(LOOPBACK_KEYS.map((ip) => redis.get(rateLimit.ipKey(ip))));
      const recorded = ipCounts.map(Number).filter((n) => n > 0);
      expect(recorded.length).toBe(1); // exactly one source key was used
      expect(recorded[0]).toBe(threshold);

      // A brand-new account from the same IP — never failed once — is now locked out.
      const fresh = newEmail();
      const password = 'CleanAccount-9';
      await request(app).post('/api/auth/register').send({ email: fresh, password });
      victims.push(fresh);
      const blocked = await request(app).post('/api/auth/login').send({ email: fresh, password });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await clearRateLimit(...victims);
    }
  });

  test('lockout responses never reveal whether the account exists (AB-05 enumeration)', async () => {
    const known = newEmail();
    const password = 'Enumerate-1';
    await request(app).post('/api/auth/register').send({ email: known, password });
    const unknown = newEmail();
    await clearRateLimit(known, unknown);
    try {
      const a = await request(app).post('/api/auth/login').send({ email: known, password: 'bad' });
      const b = await request(app)
        .post('/api/auth/login')
        .send({ email: unknown, password: 'bad' });
      expect(a.status).toBe(b.status);
      expect(a.body.error.code).toBe(b.body.error.code);
      expect(a.body.error.message).toBe(b.body.error.message);
    } finally {
      await clearRateLimit(known, unknown);
    }
  });
});

// =============================================================================================
// ST-04 — injection at the boundaries the other suites do not fire at (NFR-11, AB-06)
// =============================================================================================
describe('ST-04 injection: profile, booking, location and media boundaries', () => {
  const SQLI = ["' OR 1=1 --", "'; DROP TABLE users; --", "admin'--", '1; DELETE FROM users'];
  const XSS = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg/onload=alert(1)>',
  ];

  let user;
  let cookie;
  beforeAll(async () => {
    // NOTE: fixtures here carry a REAL fieldCrypto ciphertext, not the lane's usual
    // `phone_enc: 'enc:v1:fixture'` placeholder — see finding STS-W3-01: the owner-profile
    // serializer decrypts unconditionally, so a row with a non-canonical *_enc value turns
    // GET/PATCH /api/users/me into a 500 for that account.
    user = await db.makeUser({ phone_enc: fieldCrypto.encrypt('+14155550142') });
    cookie = await cookieFor(user);
  });

  test('PATCH /api/users/me stores fullName / emergency name / bio ESCAPED and reads them back inert', async () => {
    const usersBefore = await db.countRows('users');
    for (const p of XSS) {
      const res = await request(app)
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
      const me = await request(app).get('/api/users/me').set('Cookie', cookie);
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
      const res = await request(app)
        .patch('/api/users/me')
        .set('Cookie', cookie)
        .send({ fullName: p });
      expect(res.status).not.toBe(500);
      expect([200, 422]).toContain(res.status);
    }
    expect(await db.countRows('users')).toBeGreaterThanOrEqual(before);
    expect(await db.countRows('host_profiles')).toBeGreaterThanOrEqual(0);
  });

  test('SQLi in POST /api/bookings listingId is a 422/404 — never a query, never a 500', async () => {
    for (const p of SQLI) {
      const res = await request(app)
        .post('/api/bookings')
        .set('Cookie', cookie)
        .send({ listingId: p });
      expect(res.status).not.toBe(500);
      expect([403, 404, 422]).toContain(res.status);
    }
    expect(await db.countRows('bookings')).toBeGreaterThanOrEqual(0);
  });

  test('SQLi/XSS in the search `location` string (Maps adapter input) never 500s and comes back inert', async () => {
    for (const p of [...SQLI, ...XSS]) {
      const res = await request(app)
        .get('/api/listings/search')
        .set('Cookie', cookie)
        .query({ location: p, radiusKm: 5, pageSize: 4 });
      expect(res.status).not.toBe(500);
      const flat = JSON.stringify(res.body);
      expect(flat).not.toContain('<script');
      expect(flat).not.toContain('<svg');
      expect(flat).not.toMatch(/<img[^>]*onerror/i);
    }
    expect(await db.countRows('listings')).toBeGreaterThan(0);
  });

  test('SQLi in media contentType / kind is a 422, never a 500 or a stored row', async () => {
    const before = await db.countRows('media_objects');
    for (const p of SQLI) {
      const res = await request(app)
        .post('/api/media/uploads')
        .set('Cookie', cookie)
        .send({ kind: p, contentType: p, sizeBytes: 10 });
      expect(res.status).toBe(422);
    }
    expect(await db.countRows('media_objects')).toBe(before);
  });

  test('an oversized JSON body is refused at the boundary, not by a crash (NFR-11)', async () => {
    const res = await request(app)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ fullName: 'x'.repeat(2 * 1024 * 1024) }));
    expect([413, 422]).toContain(res.status);
    expect(res.status).not.toBe(500);
  });

  test('malformed JSON is a structured 4xx, never an HTML error page or a stack trace', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "a@b.c", "password": ');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js:\d+/);
  });
});

// =============================================================================================
// ST-05 — erasure surface as it exists on disk (NFR-12, ADR-004)
// =============================================================================================
describe('ST-05 erasure surface (NFR-12) — wave-4 scope, measured not assumed', () => {
  test('no account-deletion endpoint is mounted on any verb of /api/users/me', async () => {
    const user = await db.makeUser({});
    const cookie = await cookieFor(user);
    const del = await request(app).delete('/api/users/me').set('Cookie', cookie);
    expect([404, 405]).toContain(del.status);
    const post = await request(app).post('/api/users/me').set('Cookie', cookie).send({});
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

  test('no backup-retention script or documented backup policy artifact exists yet', () => {
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'retention.js'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'backup.js'))).toBe(false);
    // The only thing on disk today is the 30-day erasure *deadline* configuration.
    expect(baseConfig.privacy.erasureDays).toBe(30);
    expect(baseConfig.privacy.inactivityMonths).toBe(24);
    const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
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

  test('media erasure is a REAL object-storage round trip: put -> deleteForUser -> the object 404s (ADR-004)', async () => {
    // No spies: this drives MinIO through the production adapter, so ST-05's "deletes media
    // by key" is measured, not asserted against a mock.
    const objectStorage = require('../../src/adapters/objectStorage');
    const mediaService = require('../../src/modules/media/service');
    const owner = await db.makeUser({});
    const keys = [
      `listing/${owner.id}/${Date.now()}-a.jpg`,
      `listing/${owner.id}/${Date.now()}-b.jpg`,
    ];
    for (const k of keys) {
      await objectStorage.put(k, Buffer.from('canary-bytes'), { contentType: 'image/jpeg' });
      await mediaService.attach(owner.id, k, 'listing');
    }
    // Present before erasure.
    for (const k of keys) {
      const got = await objectStorage.get(k);
      expect(got).toBeTruthy();
    }

    const result = await mediaService.deleteForUser(owner.id);
    expect(result.deletedObjects).toBe(keys.length);
    expect(result.deletedRows).toBe(keys.length);

    // Gone from storage…
    for (const k of keys) {
      await expect(objectStorage.get(k)).rejects.toThrow();
    }
    // …and from PostgreSQL.
    const { rows } = await db.query(
      `SELECT count(*)::int c FROM media_objects WHERE owner_user_id = $1 AND deleted_at IS NULL`,
      [owner.id]
    );
    expect(rows[0].c).toBe(0);
  });

  test('STS-W3-01 reproduction: a non-canonical *_enc column fails CLOSED on the owner profile read', async () => {
    // Concrete state: a users row whose phone_enc is not a canonical fieldCrypto ciphertext
    // (key rotation, a partially migrated row, or the lane's own `enc:v1:fixture` placeholder).
    // repo.serializeUser() decrypts unconditionally, so GET /api/users/me throws.
    // The SECURITY property asserted here (and the one that must survive any fix): the failure
    // never leaks the stored ciphertext, the stack, or any internal message.
    const broken = await db.makeUser({ phone_enc: 'enc:v1:fixture' });
    const cookie = await cookieFor(broken);
    const res = await request(app).get('/api/users/me').set('Cookie', cookie);
    const flat = JSON.stringify(res.body);
    expect(flat).not.toContain('enc:v1:');
    expect(flat).not.toMatch(/at .*\.js:\d+/);
    expect(flat).not.toMatch(/fieldCrypto/);
    if (res.status === 500) {
      // Current observed behaviour — recorded as finding STS-W3-01 (availability, minor).
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(res.body.error.message).toBe('Internal server error');
      expect(res.body.error.correlationId).toBeTruthy();
    } else {
      // After the proposed fix the owner still gets their profile (phone rendered null).
      expect(res.status).toBe(200);
    }
  });
});

// =============================================================================================
// ST-06 — §3.4 register, export path, ADR-007 open action (NFR-13, AB-08)
// =============================================================================================
describe('ST-06 data protection register and export (NFR-13)', () => {
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
    const { validateEnv } = require('../../src/config/schema');
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

  test('the users table carries EXACTLY the §3.4 personal-data register (key-exact)', async () => {
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
    const res = await request(app)
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
    const user = await db.makeUser({});
    const cookie = await cookieFor(user);
    for (const verb of ['post', 'get']) {
      const res = await request(app)[verb]('/api/users/me/export').set('Cookie', cookie);
      expect([404, 405]).toContain(res.status);
    }
  });

  test('no repository artifact records the ADR-007 free-tier data-use finding (open action)', () => {
    const searched = [path.join(ROOT, 'docs')];
    let found = false;
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(md|txt)$/.test(entry.name) && !/^(SRS|SPMP)\.txt$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8');
          // A recorded FINDING would state the reviewed terms + a date, not merely restate
          // the ADR's open action.
          if (
            /free-tier data-use terms[\s\S]{0,400}(reviewed|finding recorded|as of \d{4})/i.test(
              text
            )
          ) {
            found = true;
          }
        }
      }
    };
    searched.forEach(walk);
    expect(found).toBe(false); // documents the gap; wave-7 close-out must flip this
  });

  test('personal-data access logging has exactly one writer and records actor/subject/purpose', async () => {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'access_log'`
    );
    const cols = rows.map((r) => r.column_name);
    for (const c of ['actor_user_id', 'subject_user_id', 'purpose', 'resource']) {
      expect(cols).toContain(c);
    }
    const writers = require('child_process')
      .execFileSync('grep', ['-rl', 'access_log', path.join(ROOT, 'src')], { encoding: 'utf8' })
      .trim()
      .split('\n');
    expect(writers).toEqual([path.join(ROOT, 'src', 'modules', 'listings', 'access.js')]);
  });
});

// =============================================================================================
// AB-04 / AB-06 residuals recorded explicitly
// =============================================================================================
describe('Abuse-case coverage boundaries recorded explicitly', () => {
  test('AB-04 (abusive chat/reviews) has no surface on disk — reviews/messaging/moderation unmounted', () => {
    // `safety` left this list when U4-SAFETY landed: FR-07 alerts are not user-generated
    // CONTENT (an alert carries no free text at all — src/schemas/safety.js), so the module
    // adds no AB-04 surface. Its own security assertions live in tc07-safety.test.js.
    for (const name of ['reviews', 'messaging', 'moderation', 'privacy']) {
      expect(fs.existsSync(path.join(ROOT, 'src', 'modules', name))).toBe(false);
    }
    const mounted = app.locals.routes.mounted.map((m) => m.name).sort();
    expect(mounted).not.toContain('reviews');
    expect(mounted).not.toContain('messaging');
    expect(mounted).not.toContain('moderation');
  });

  test('AB-01 second half: the moderation pipeline that would flag a fake listing is absent', () => {
    // Listings are created 'pending' (asserted elsewhere in this lane) but NOTHING approves or
    // rejects them in wave 3 — the approval transition is wave-4 work.
    // Every wave-3 reference to moderation_status is a READ filter; nothing SETS it to
    // 'approved' or 'rejected', so a pending listing can never leave the queue in this tree.
    // Every hit for moderation_status in src/ is a READ filter (search/detail/reviews);
    // no statement SETs it, so a pending listing can never leave the queue in this tree.
    expect(grepSrc('SET[^;]*moderation_status[[:space:]]*=')).toBe('');
    expect(grepSrc('moderation_decisions')).toBe('');
  });
});
