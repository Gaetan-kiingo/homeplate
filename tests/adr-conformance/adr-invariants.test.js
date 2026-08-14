// tests/adr-conformance/adr-invariants.test.js — ADR conformance lane (verifier-owned).
//
// Executable audit of the binding architecture invariants for the wave-0..2 surface:
//   ADR-001/003 — no adapter on any request path; business row + outbox row in ONE
//                 transaction (no dual writes); outbox payloads carry IDs only.
//   ADR-002     — schema substrate: public content defaults moderation_status='pending'
//                 (the pipeline itself is wave 4 and is reported not_implemented).
//   ADR-004     — media referenced by storage key; per-object deletion (deleteForUser
//                 calls deleteByKey per owned key against real MinIO).
//   ADR-005/010 — maps results cached in Redis at PUBLIC precision only; repeat lookup
//                 served from cache; coarsening deterministic and idempotent.
//   ADR-006     — exactly one eligibility-policy implementation; sessions + login rate
//                 limiting behave per NFR-05/AB-05.
//   ADR-007     — no provider/model/key hardcoded; test suite resolves the mock adapter.
//   ADR-009     — caps come from config; DB backstop refuses a second listing on the same
//                 America/Los_Angeles day across UTC-day boundaries.
//   ADR-011     — push gated off by default; every send persists a NOTIFICATION_ATTEMPT
//                 row; nothing leaves the process in the automated suite.
//   Redis role  — every key in the test keyspace is session / rate-limit / cache only.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const dbHelper = require('../helpers/db');
const { localDateFor } = require('../../scripts/seed');

const SRC = path.join(__dirname, '..', '..', 'src');

/** Recursively list .js files under a directory. */
function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(p));
    else if (entry.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

let app; // created once in the ADR-001 describe, reused by later behavioural tests

afterAll(async () => {
  const { closeRedis } = require('../../src/db/redis');
  await dbHelper.closeDb();
  await closeRedis();
});

// ------------------------------------------------------------------------------------------
// ADR-001 / ADR-003 — modular monolith, worker-only adapters, transactional outbox
// ------------------------------------------------------------------------------------------
describe('ADR-001/003 — request path never touches an adapter; outbox is transactional', () => {
  test('booting the full HTTP app loads NO module from src/adapters/*', () => {
    // Evidence by execution: require the real app factory (which mounts every module
    // routes.js on disk) and inspect the module registry. Any adapter reachable at
    // module scope from a request handler would appear in require.cache here.
    const { createApp } = require('../../src/app');
    app = createApp();
    const adapterModules = Object.keys(require.cache).filter((p) =>
      p.includes(`${path.sep}src${path.sep}adapters${path.sep}`)
    );
    expect(adapterModules).toEqual([]);
  });

  test('static scan: no module-scope adapter require in routes/services/middleware/app', () => {
    // Belt-and-braces over the runtime check: scan request-reachable directories for a
    // top-level (brace-depth-0) require of src/adapters. Call-time requires inside
    // documented worker-only functions (media/service.deleteForUser) are exempt because
    // they never run on a request; the runtime check above proves they did not load.
    const scanDirs = [
      path.join(SRC, 'modules'),
      path.join(SRC, 'routes'),
      path.join(SRC, 'middleware'),
    ];
    const offenders = [];
    for (const dir of scanDirs) {
      for (const file of listJsFiles(dir)) {
        // transport.js is the worker-only delivery layer (imported ONLY from outbox
        // handlers — verified in the next test); everything else must stay adapter-free.
        if (file.endsWith(path.join('notifications', 'transport.js'))) continue;
        const text = fs.readFileSync(file, 'utf8');
        let depth = 0;
        for (const rawLine of text.split('\n')) {
          const line = rawLine.replace(/\/\/.*$/, '');
          if (depth === 0 && /require\(['"][^'"]*adapters\//.test(line)) {
            offenders.push(path.relative(SRC, file));
          }
          for (const ch of line) {
            if (ch === '{' || ch === '(') depth += 1;
            else if (ch === '}' || ch === ')') depth = Math.max(0, depth - 1);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the worker-only transport is imported only from outbox handler / notifications code', () => {
    const importers = [];
    for (const file of listJsFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      if (/require\(['"][^'"]*notifications\/transport['"]\)/.test(text)) {
        importers.push(path.relative(SRC, file));
      }
    }
    // ADR-001/003: ONLY outbox handlers (worker-only code) may consume the delivery
    // transport. Wave 3 added bookingNotifications.js — an outbox handler, i.e. exactly
    // the sanctioned location class. Anything outside src/outbox/handlers/ is a violation.
    expect(importers.sort()).toEqual([
      path.join('outbox', 'handlers', 'bookingNotifications.js'),
      path.join('outbox', 'handlers', 'emailVerification.js'),
    ]);
    for (const importer of importers) {
      expect(importer.startsWith(path.join('outbox', 'handlers') + path.sep)).toBe(true);
    }
  });

  test('register commits USER row + outbox row together, payload is IDs only', async () => {
    const email = `adrconf.atomic.${Date.now()}@adrlane.homeplate.invalid`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'correct-horse-battery' });
    expect(res.status).toBe(201);

    const { rows: users } = await dbHelper.query('SELECT * FROM users WHERE email = $1', [email]);
    expect(users).toHaveLength(1);

    const { rows: jobs } = await dbHelper.query(
      `SELECT * FROM outbox_jobs WHERE type = 'email.verification'
       AND payload->>'userId' = $1`,
      [users[0].id]
    );
    expect(jobs).toHaveLength(1);
    // ADR-003: IDs/digests only — exactly {userId, tokenHash}, nothing email/phone-shaped.
    expect(Object.keys(jobs[0].payload).sort()).toEqual(['tokenHash', 'userId']);
    expect(JSON.stringify(jobs[0].payload)).not.toMatch(EMAIL_SHAPE);
  });

  test('no dual write: outbox enqueue failure rolls back the USER row too', async () => {
    const outbox = require('../../src/outbox/outbox');
    const spy = jest
      .spyOn(outbox, 'enqueue')
      .mockRejectedValue(new Error('adr-conformance: injected enqueue failure'));
    const email = `adrconf.rollback.${Date.now()}@adrlane.homeplate.invalid`;
    try {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email, password: 'correct-horse-battery' });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      spy.mockRestore();
    }
    const { rows } = await dbHelper.query('SELECT id FROM users WHERE email = $1', [email]);
    expect(rows).toEqual([]); // both writes rolled back — no dual write
  });

  test('enqueue REJECTS a PII-bearing payload (email-shaped value / PII key)', async () => {
    const outbox = require('../../src/outbox/outbox');
    await dbHelper.withRollback(async (client) => {
      await expect(
        outbox.enqueue(client, {
          type: 'adrconf.test',
          payload: { contact: 'person@example.com' },
        })
      ).rejects.toMatchObject({ code: 'OUTBOX_PAYLOAD_PII' });
      await expect(
        outbox.enqueue(client, { type: 'adrconf.test', payload: { email: 'x' } })
      ).rejects.toMatchObject({ code: 'OUTBOX_PAYLOAD_PII' });
    });
  });

  test('audit: every persisted outbox payload is free of email/phone-shaped values', async () => {
    const { rows } = await dbHelper.query('SELECT id, payload FROM outbox_jobs');
    const offenders = rows.filter((r) => EMAIL_SHAPE.test(JSON.stringify(r.payload)));
    expect(offenders).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------
// ADR-002 — moderation substrate (pipeline itself is wave 4)
// ------------------------------------------------------------------------------------------
describe('ADR-002 — public content is born PENDING (schema substrate)', () => {
  test('a listing inserted without moderation_status defaults to pending', async () => {
    const listing = await dbHelper.makeListing();
    expect(listing.moderation_status).toBe('pending');
  });

  test('a review inserted without moderation_status defaults to pending', async () => {
    const booking = await dbHelper.makeBooking();
    const { rows } = await dbHelper.query(
      `INSERT INTO reviews (booking_id, author_id, target_user_id, rating, body)
       SELECT b.id, b.guest_id, l.host_id, 5, 'adr-conformance review'
       FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE b.id = $1
       RETURNING moderation_status`,
      [booking.id]
    );
    expect(rows[0].moderation_status).toBe('pending');
  });
});

// ------------------------------------------------------------------------------------------
// ADR-004 — media by key, per-object deletion (real MinIO)
// ------------------------------------------------------------------------------------------
describe('ADR-004 — media stored by key; erasure deletes per object', () => {
  test('attach records the key; deleteForUser deletes each object then its row', async () => {
    const objectStorage = require('../../src/adapters/objectStorage');
    const mediaService = require('../../src/modules/media/service');
    const user = await dbHelper.makeUser();
    const k1 = `listing/${user.id}/adrconf-a-${Date.now()}.jpg`;
    const k2 = `listing/${user.id}/adrconf-b-${Date.now()}.jpg`;
    await objectStorage.put(k1, Buffer.from('adrconf-object-1'), { contentType: 'image/jpeg' });
    await objectStorage.put(k2, Buffer.from('adrconf-object-2'), { contentType: 'image/jpeg' });
    await mediaService.attach(user.id, k1, 'listing');
    await mediaService.attach(user.id, k2, 'listing');

    // PostgreSQL references the object BY KEY (ADR-004), never inline bytes.
    const { rows } = await dbHelper.query(
      'SELECT storage_key FROM media_objects WHERE owner_user_id = $1 ORDER BY created_at',
      [user.id]
    );
    expect(rows.map((r) => r.storage_key)).toEqual([k1, k2]);

    const spy = jest.spyOn(objectStorage, 'deleteByKey');
    const result = await mediaService.deleteForUser(user.id);
    expect(result).toMatchObject({ deletedObjects: 2, deletedRows: 2, total: 2 });
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual([k1, k2]); // one call PER key
    spy.mockRestore();

    await expect(objectStorage.get(k1)).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    const { rows: after } = await dbHelper.query(
      'SELECT id FROM media_objects WHERE owner_user_id = $1',
      [user.id]
    );
    expect(after).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------
// ADR-005 / ADR-010 — maps cache is public-precision only; repeat lookups hit cache
// ------------------------------------------------------------------------------------------
describe('ADR-005/010 — Redis maps cache holds ONLY coarse public precision', () => {
  test('repeat geocode is served from cache; cached values are coarse and label-only', async () => {
    const maps = require('../../src/adapters/maps');
    const { coarsen } = require('../../src/lib/geoPrecision');
    const { redis } = require('../../src/db/redis');

    const address = '4076 Adr Conformance St, San Diego, CA 92103';
    const first = await maps.geocode(address);
    const second = await maps.geocode(address);
    expect(second.source).toBe('cache'); // NFR-01/ADR-005: zero provider work on repeat
    expect(second.lat).toBe(first.lat);
    expect(second.lng).toBe(first.lng);

    // The returned default projection is ALREADY coarse: coarsening it again is a no-op.
    const recoarsened = coarsen(first.lat, first.lng);
    expect(recoarsened.lat).toBe(first.lat);
    expect(recoarsened.lng).toBe(first.lng);

    // Audit EVERY maps cache key/value in Redis: hashed keys (no address text), values
    // limited to coarse lat/lng + area label — a cache read cannot leak an exact location.
    const keys = await redis.keys('hp:cache:maps:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toMatch(/adr|conformance|st,|street|92103/i);
      const raw = await redis.get(key);
      const value = JSON.parse(raw);
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) {
        if (item === null || typeof item !== 'object') continue; // negative cache entries
        expect(Object.keys(item).sort()).toEqual(['areaLabel', 'lat', 'lng']);
        const again = coarsen(item.lat, item.lng);
        expect(again.lat).toBe(item.lat); // already grid-snapped ⇒ public precision
        expect(again.lng).toBe(item.lng);
        expect(String(item.areaLabel)).not.toMatch(/\d{3,}\s+\w+\s+(st|ave|road|rd|blvd)/i);
      }
    }
  });

  test('exact precision is an explicit opt-in and is never written to the cache', async () => {
    const maps = require('../../src/adapters/maps');
    const { redis } = require('../../src/db/redis');
    const address = '999 Exact Precision Way, San Diego, CA';
    const exact = await maps.geocode(address, { precision: 'exact' });
    expect(exact.precise).toBeDefined();
    // The precise coordinates must not appear in any cached value.
    const keys = await redis.keys('hp:cache:maps:*');
    for (const key of keys) {
      const raw = await redis.get(key);
      expect(raw.includes(String(exact.precise.lat))).toBe(false);
      expect(raw.includes(String(exact.precise.lng))).toBe(false);
    }
  });
});

// ------------------------------------------------------------------------------------------
// ADR-006 — one eligibility policy; sessions + rate limiting
// ------------------------------------------------------------------------------------------
describe('ADR-006 — single eligibility policy, session lifecycle, login rate limit', () => {
  test('canReserveSeat / canPublishListing are implemented ONLY in eligibility/policy.js', () => {
    const definition =
      /(function\s+can(ReserveSeat|PublishListing)\b)|(\bcan(ReserveSeat|PublishListing)\s*[:=]\s*(async\s*)?(function\b|\())/;
    const offenders = [];
    for (const file of listJsFiles(SRC)) {
      if (file.endsWith(path.join('eligibility', 'policy.js'))) continue;
      if (definition.test(fs.readFileSync(file, 'utf8'))) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('login issues an opaque cookie session; logout kills it server-side (AB-05)', async () => {
    const passwords = require('../../src/modules/auth/passwords');
    const hash = await passwords.hashPassword('adrconf-password-1');
    const user = await dbHelper.makeUser({ password_hash: hash });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'adrconf-password-1' });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie'];
    expect(cookie).toBeDefined();
    expect(cookie.join(';')).toMatch(/HttpOnly/i);

    const me = await request(app).get('/api/users/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    // NFR-13/ADR-010 allowlist serializer: no password/hash material leaves the API.
    expect(JSON.stringify(me.body)).not.toMatch(/password|hash|argon2/i);

    const out = await request(app).post('/api/auth/logout').set('Cookie', cookie).send({});
    expect(out.status).toBeLessThan(300);
    const meAfter = await request(app).get('/api/users/me').set('Cookie', cookie);
    expect(meAfter.status).toBe(401); // Redis record destroyed — token unusable
  });

  test('6th login attempt in the window is 429 even with correct credentials (ST-03)', async () => {
    const passwords = require('../../src/modules/auth/passwords');
    const hash = await passwords.hashPassword('adrconf-password-2');
    const user = await dbHelper.makeUser({ password_hash: hash });

    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'wrong-password-attempt' });
      expect(res.status).toBe(401);
    }
    const sixth = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'adrconf-password-2' });
    expect(sixth.status).toBe(429);
    expect(sixth.headers['retry-after']).toBeDefined();
  });
});

// ------------------------------------------------------------------------------------------
// ADR-007 — provider-agnostic LLM adapter, mock in the automated suite
// ------------------------------------------------------------------------------------------
describe('ADR-007 — no hardcoded provider/model/key; suite runs the mock', () => {
  test('adapter sources contain no provider name, model id or API key literal', () => {
    const files = [
      path.join(SRC, 'adapters', 'llmModeration.js'),
      path.join(SRC, 'adapters', 'llmModeration.mock.js'),
    ];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toMatch(/gemini|generativelanguage|googleapis|AIza[0-9A-Za-z_-]{10}/i);
      expect(text).not.toMatch(/api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]/i);
    }
  });

  test('NODE_ENV=test resolves the deterministic mock adapter', async () => {
    const config = require('../../src/config');
    expect(config.moderation.mode).toBe('mock');
    const llm = require('../../src/adapters/llmModeration');
    const adapter = llm.getAdapter ? llm.getAdapter() : llm;
    const a = await adapter.classify('hello, a perfectly benign message');
    const b = await adapter.classify('hello, a perfectly benign message');
    expect(a).toEqual(b); // deterministic
    expect(a.model).toMatch(/mock/i); // never a live model id in the suite
    expect(['offensive', 'spam', 'fraudulent', 'benign']).toContain(a.category);
    expect(a.confidence).toBeGreaterThanOrEqual(0);
    expect(a.confidence).toBeLessThanOrEqual(1);
  });
});

// ------------------------------------------------------------------------------------------
// ADR-009 — caps from config; America/Los_Angeles day boundary (DB backstop)
// ------------------------------------------------------------------------------------------
describe('ADR-009 — MEHKO caps in config; LA-day uniqueness backstop', () => {
  test('caps are configuration with the mandated values', () => {
    const config = require('../../src/config');
    expect(config.mehko).toMatchObject({
      listingsPerHostPerDay: 1,
      maxMealsPerDay: 30,
      maxMealsPerWeek: 60,
      timezone: 'America/Los_Angeles',
    });
  });

  test('second listing on the same LA day is refused across UTC-day boundaries', async () => {
    const host = await dbHelper.makeUser();
    // 2027-03-10T21:00Z = 13:00 America/Los_Angeles on Mar 10 (PST, pre-DST).
    const t1 = new Date('2027-03-10T21:00:00Z');
    // 2027-03-11T07:30Z = 23:30 America/Los_Angeles on Mar 10 — a DIFFERENT UTC day and a
    // different date for, e.g., a client in Tokyo, but the SAME LA calendar day.
    const t2 = new Date('2027-03-11T07:30:00Z');
    // 2027-03-11T08:10Z = 00:10 LA on Mar 11 — the SAME UTC day as t2 but the NEXT LA day.
    const t3 = new Date('2027-03-11T08:10:00Z');

    expect(localDateFor(t1)).toBe('2027-03-10');
    expect(localDateFor(t2)).toBe('2027-03-10'); // same LA day, different UTC day
    expect(localDateFor(t3)).toBe('2027-03-11'); // next LA day, same UTC day as t2

    await dbHelper.makeListing({ host_id: host.id, scheduled_start: t1 });
    // Refused: one listing per host per LA calendar day (FR-11 / AB-07 / ADR-009).
    await expect(
      dbHelper.makeListing({ host_id: host.id, scheduled_start: t2 })
    ).rejects.toMatchObject({ code: '23505' });
    // Allowed: just after LA midnight it is a new LA day even though UTC day is unchanged.
    await expect(
      dbHelper.makeListing({ host_id: host.id, scheduled_start: t3 })
    ).resolves.toMatchObject({ local_date: expect.anything() });
  });
});

// ------------------------------------------------------------------------------------------
// ADR-010 — mounted-surface audit (wave-3 scope: core marketplace mounted, wave 4 absent)
// ------------------------------------------------------------------------------------------
describe('ADR-010 — mounted surface audit (wave-3 scope)', () => {
  test('wave-4 modules are NOT mounted; /api/search stays 404 (search lives under /api/listings/search)', async () => {
    for (const p of [
      '/api/reviews',
      '/api/messaging',
      '/api/moderation',
      '/api/safety',
      '/api/privacy',
    ]) {
      const res = await request(app).get(p);
      expect(res.status).toBe(404); // wave-4 surface must not exist yet
    }
    // Build-plan §6.5: the search module mounts at /api/listings/search only.
    const search = await request(app).get('/api/search');
    expect(search.status).toBe(404);
  });

  test('every mounted wave-3 read path refuses unauthenticated access (AB-08 — never data)', async () => {
    const listing = await dbHelper.makeListing();
    for (const p of [
      `/api/listings/${listing.id}`,
      '/api/listings/search',
      `/api/hosts/${listing.host_id}`,
      `/api/hosts/${listing.host_id}/reviews`,
      '/api/bookings',
    ]) {
      const res = await request(app).get(p);
      expect(res.status).toBe(401); // session required — no listing/host data unauthenticated
      expect(JSON.stringify(res.body)).not.toMatch(/address|"lat"|"lng"|street/i);
    }
  });

  test('profile serializer allowlist carries no location or credential fields', async () => {
    const passwords = require('../../src/modules/auth/passwords');
    const hash = await passwords.hashPassword('adrconf-password-3');
    const user = await dbHelper.makeUser({ password_hash: hash });
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'adrconf-password-3' });
    const me = await request(app).get('/api/users/me').set('Cookie', login.headers['set-cookie']);
    expect(me.status).toBe(200);
    const body = JSON.stringify(me.body);
    expect(body).not.toMatch(/address|street|latitude|longitude|"lat"|"lng"/i);
  });
});

// ------------------------------------------------------------------------------------------
// ADR-011 — push default-false; every attempt persists a NOTIFICATION_ATTEMPT row
// ------------------------------------------------------------------------------------------
describe('ADR-011 — email channel, gated push, persisted attempts, mock in suite', () => {
  test('notifications.push.enabled defaults to FALSE with no env override', () => {
    const { validateEnv } = require('../../src/config/schema');
    const cfg = validateEnv({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://u:p@localhost:5432/homeplate',
      REDIS_URL: 'redis://localhost:6379/0',
      FIELD_ENCRYPTION_KEY: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
      OBJECT_STORAGE_BUCKET: 'b',
      OBJECT_STORAGE_ACCESS_KEY: 'a',
      OBJECT_STORAGE_SECRET_KEY: 's',
    });
    expect(cfg.notifications.push.enabled).toBe(false);
    expect(cfg.notifications.transport).toBe('mock'); // dev/test default (ADR-011)
  });

  test('an email send persists a NOTIFICATION_ATTEMPT row (mock transport, no live send)', async () => {
    const config = require('../../src/config');
    expect(config.notifications.transport).toBe('mock'); // the suite never leaves process
    const transport = require('../../src/modules/notifications/transport');
    const user = await dbHelper.makeUser();
    const key = `adrconf-email-${Date.now()}`;
    const result = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'email.verification',
      params: { userId: user.id },
      idempotencyKey: key,
    });
    expect(result.status).toBe('sent');
    const { rows } = await dbHelper.query(
      'SELECT * FROM notification_attempts WHERE idempotency_key = $1',
      [key]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_user_id: user.id,
      channel: 'email',
      status: 'sent',
    });
    // The row carries the recipient's ID only — never an email address (ADR-003/§3.4).
    expect(JSON.stringify(rows[0].params)).not.toMatch(EMAIL_SHAPE);
  });

  test('a push send is REFUSED under the default-false gate and recorded as failed', async () => {
    const transport = require('../../src/modules/notifications/transport');
    const user = await dbHelper.makeUser();
    const key = `adrconf-push-${Date.now()}`;
    const result = await transport.send({
      userId: user.id,
      channel: 'push',
      template: 'email.verification',
      params: { userId: user.id },
      idempotencyKey: key,
    });
    expect(result.status).toBe('failed');
    const { rows } = await dbHelper.query(
      'SELECT status FROM notification_attempts WHERE idempotency_key = $1',
      [key]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
  });

  test('end-to-end FR-10: register → worker poll → persisted email attempt', async () => {
    const dispatch = require('../../src/outbox/dispatch');
    const worker = require('../../src/outbox/worker');
    const email = `adrconf.e2e.${Date.now()}@adrlane.homeplate.invalid`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'correct-horse-battery' });
    expect(res.status).toBe(201);
    const { rows: users } = await dbHelper.query('SELECT id FROM users WHERE email = $1', [email]);

    const registry = dispatch.loadHandlers();
    // Drain the queue (other tests may have left jobs behind).
    let stats;
    let guard = 0;
    do {
      stats = await worker.pollOnce({ registry });
      guard += 1;
    } while (stats.claimed > 0 && guard < 10);

    const { rows: attempts } = await dbHelper.query(
      `SELECT channel, status FROM notification_attempts WHERE recipient_user_id = $1`,
      [users[0].id]
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ channel: 'email', status: 'sent' });
  });
});

// ------------------------------------------------------------------------------------------
// Redis role — sessions, rate-limit counters and cache ONLY (no business state)
// ------------------------------------------------------------------------------------------
describe('Redis holds sessions / rate-limit counters / cache only', () => {
  test('every key created by the exercised flows is in an approved namespace', async () => {
    const { redis } = require('../../src/db/redis');
    const keys = await redis.keys('*');
    expect(keys.length).toBeGreaterThan(0); // sessions + cache + counters were created above
    const offenders = keys.filter((k) => !/^hp:(session|ratelimit|cache):/.test(k));
    expect(offenders).toEqual([]);
  });
});
