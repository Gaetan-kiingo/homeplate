// tests/coverage/coverage-lane.test.js — COVERAGE verification lane.
//
// Answers "is every exported module and function actually implemented and tested?" for the
// wave 0-2 build (build-plan §6: coverage is a primary signal at this stage).
//
//  1. Static stub scan — no TODO/FIXME/not-implemented markers anywhere in src/, scripts/,
//     db/migrations (ground rule: no placeholder implementations).
//  2. Public-interface inventory — every contract published in build-plan §3 ("Public
//     interfaces other units may rely on") exists on disk with the declared export shape.
//  3. HTTP route inventory — the wave-2 mounted surface is exactly auth + users, the seven
//     declared endpoints are reachable (not 404), and wave 3-6 modules are NOT mounted.
//  4. Previously unexercised exports — functions the lcov report showed at 0 hits
//     (media/repo.findByKey, notifications/repo.getRecipientEmail,
//     requestContext.getContext) are executed here against the real seeded database so no
//     exported function in the wave 0-2 surface remains untested.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');

const ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------------------------
// 1. Static stub scan
// ---------------------------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(js|sql)$/.test(entry.name)) out.push(p);
  }
  return out;
}

describe('coverage lane — no stubs or placeholders in the wave 0-2 surface', () => {
  const files = [
    ...walk(path.join(ROOT, 'src')),
    ...walk(path.join(ROOT, 'scripts')),
    ...walk(path.join(ROOT, 'db', 'migrations')),
  ];

  test('at least the full wave 0-2 file inventory is on disk', () => {
    // 45+ source files, 6 scripts, 3 migrations existed at verification time.
    expect(files.length).toBeGreaterThanOrEqual(50);
  });

  test('no TODO / FIXME / not-implemented / stub markers', () => {
    const offenders = [];
    const marker = /\bTODO\b|\bFIXME\b|\bXXX\b|not.?implemented|throw new Error\(["']stub/i;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (marker.test(line)) offenders.push(`${path.relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Public-interface inventory (build-plan §3 contract table)
// ---------------------------------------------------------------------------------------------

describe('coverage lane — every published wave 0-2 contract exists with real exports', () => {
  test('U1-CONFIG: frozen config object with the mandated sections', () => {
    const config = require('../../src/config');
    expect(Object.isFrozen(config)).toBe(true);
    expect(config.mehko).toMatchObject({
      listingsPerHostPerDay: expect.any(Number),
      maxMealsPerDay: expect.any(Number),
      maxMealsPerWeek: expect.any(Number),
      timezone: expect.any(String),
    });
    expect(config.notifications.push.enabled).toBe(false);
    expect(typeof config.adapters.timeoutMs).toBe('number');
  });

  test('U1-DB: pool/tx/redis/fieldCrypto/cache contracts', () => {
    const pool = require('../../src/db/pool');
    const tx = require('../../src/db/tx');
    const redis = require('../../src/db/redis');
    const fieldCrypto = require('../../src/db/fieldCrypto');
    const cache = require('../../src/lib/cache');
    for (const fn of [pool.query, pool.getClient, tx.withTransaction, redis.key,
      fieldCrypto.encrypt, fieldCrypto.decrypt, cache.get, cache.set, cache.wrap, cache.del]) {
      expect(typeof fn).toBe('function');
    }
    expect(redis.redis).toBeDefined();
  });

  test('U1-OBS: logger/errors/resilience/httpClient contracts', () => {
    const { logger } = require('../../src/lib/logger');
    const errors = require('../../src/lib/errors');
    const { withResilience } = require('../../src/lib/resilience');
    const httpClient = require('../../src/lib/httpClient');
    expect(typeof logger.child).toBe('function');
    expect(typeof errors.AppError).toBe('function');
    expect(typeof withResilience).toBe('function');
    expect(typeof httpClient.request).toBe('function');
  });

  test('U1-VALID: validate middleware and sanitizers', () => {
    const validate = require('../../src/middleware/validate');
    const sanitize = require('../../src/lib/sanitize');
    expect(typeof validate).toBe('function');
    for (const fn of [sanitize.text, sanitize.html, sanitize.identifier]) {
      expect(typeof fn).toBe('function');
    }
  });

  test('U1-HTTP: createApp factory and route registry', () => {
    const { createApp } = require('../../src/app');
    const registry = require('../../src/routes');
    expect(typeof createApp).toBe('function');
    expect(typeof registry.mountModuleRoutes).toBe('function');
    expect(Array.isArray(registry.KNOWN_MODULES)).toBe(true);
  });

  test('U2-OUTBOX: enqueue, dispatcher, worker', () => {
    const outbox = require('../../src/outbox/outbox');
    const dispatch = require('../../src/outbox/dispatch');
    const worker = require('../../src/outbox/worker');
    expect(typeof outbox.enqueue).toBe('function');
    expect(typeof dispatch.loadHandlers).toBe('function');
    expect(typeof worker.pollOnce).toBe('function');
    expect(typeof worker.startWorker).toBe('function');
  });

  test('U2-IDENTITY: auth service, session middleware, verification handler', () => {
    const authService = require('../../src/modules/auth/service');
    const { requireSession } = require('../../src/modules/auth/middleware');
    const handler = require('../../src/outbox/handlers/emailVerification');
    for (const fn of [authService.register, authService.login, authService.logout,
      authService.verifyEmail]) {
      expect(typeof fn).toBe('function');
    }
    expect(typeof requireSession).toBe('function');
    expect(typeof handler.type).toBe('string');
    expect(typeof handler.handle).toBe('function');
  });

  test('U2-ELIGIBILITY: single policy interface', () => {
    const policy = require('../../src/modules/eligibility/policy');
    const { requireEligibility } = require('../../src/modules/eligibility/middleware');
    for (const fn of [policy.evaluate, policy.canReserveSeat, policy.canPublishListing]) {
      expect(typeof fn).toBe('function');
    }
    expect(typeof requireEligibility).toBe('function');
  });

  test('U2-ADAPTERS-COMMS: transport.send and channel gating', () => {
    const transport = require('../../src/modules/notifications/transport');
    expect(typeof transport.send).toBe('function');
    expect(typeof transport.resolveAdapter).toBe('function');
    // ADR-011: push refused while notifications.push.enabled=false.
    expect(transport.resolveAdapter('push')).toBeNull();
  });

  test('U2-ADAPTER-MAPS: geocode/searchArea/coarsen', () => {
    const maps = require('../../src/adapters/maps');
    const geo = require('../../src/lib/geoPrecision');
    expect(typeof maps.geocode).toBe('function');
    expect(typeof maps.searchArea).toBe('function');
    const coarse = geo.coarsen(32.7157, -117.1611);
    expect(coarse).toMatchObject({
      lat: expect.any(Number),
      lng: expect.any(Number),
      areaLabel: expect.any(String),
    });
  });

  test('U2-MEDIA-LLM: objectStorage, mediaService, llmModeration', () => {
    const objectStorage = require('../../src/adapters/objectStorage');
    const mediaService = require('../../src/modules/media/service');
    const llm = require('../../src/adapters/llmModeration');
    for (const fn of [objectStorage.put, objectStorage.get, objectStorage.deleteByKey,
      mediaService.attach, mediaService.list, mediaService.deleteForUser, llm.classify]) {
      expect(typeof fn).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. HTTP route inventory (wave-2 mounted surface = auth + users, nothing else)
// ---------------------------------------------------------------------------------------------

describe('coverage lane — mounted HTTP surface matches the wave-2 plan', () => {
  let app;
  beforeAll(() => {
    const { createApp } = require('../../src/app');
    app = createApp();
  });

  test('GET /health answers 200 {status:"ok"} from the process alone (NFR-09 liveness)', async () => {
    // Round-2 coverage gap: the /health handler (src/app.js) had zero Jest coverage — only
    // the k6 script (ignored by Jest) referenced it. NOTE: the route still lacks a validate()
    // schema, which the st-security NFR-11 route-enumeration test fails on; that source fix
    // belongs to the app.js owner (finding COV-05), this test only closes the exercise gap.
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('POST /api/auth/register is mounted (422 on invalid body, not 404)', async () => {
    const res = await request(app).post('/api/auth/register').send({});
    expect(res.status).toBe(422);
  });

  test('POST /api/auth/login is mounted (422 on invalid body, not 404)', async () => {
    const res = await request(app).post('/api/auth/login').send({});
    expect(res.status).toBe(422);
  });

  test('email verification endpoints are mounted', async () => {
    const post = await request(app).post('/api/auth/verify-email').send({});
    const get = await request(app).get('/api/auth/verify-email');
    expect([400, 422]).toContain(post.status);
    expect([400, 422]).toContain(get.status);
  });

  test('POST /api/auth/logout requires a session (401, not 404)', async () => {
    const res = await request(app).post('/api/auth/logout').send({});
    expect(res.status).toBe(401);
  });

  test('GET and PATCH /api/users/me require a session (401, not 404)', async () => {
    expect((await request(app).get('/api/users/me')).status).toBe(401);
    expect((await request(app).patch('/api/users/me').send({})).status).toBe(401);
  });

  test('wave 3-6 modules are NOT mounted (404)', async () => {
    for (const p of ['/api/listings', '/api/search', '/api/bookings', '/api/reviews',
      '/api/messaging', '/api/moderation', '/api/safety', '/api/privacy']) {
      const res = await request(app).get(p);
      expect(res.status).toBe(404);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Exports the coverage report showed at zero hits — executed against the real database
// ---------------------------------------------------------------------------------------------

describe('coverage lane — previously unexercised exports do real work', () => {
  const dbHelper = require('../helpers/db');
  const mediaRepo = require('../../src/modules/media/repo');
  const notifRepo = require('../../src/modules/notifications/repo');
  const requestContext = require('../../src/middleware/requestContext');

  afterAll(async () => {
    await dbHelper.closeDb();
    const { closeRedis } = require('../../src/db/redis');
    await closeRedis();
  });

  test('media/repo.findByKey returns the row for an existing key and null otherwise', async () => {
    await dbHelper.withRollback(async (client) => {
      const user = await dbHelper.makeUser({}, client);
      const key = `coverage-lane/${crypto.randomUUID()}.jpg`;
      const inserted = await mediaRepo.insertMediaObject(
        { ownerUserId: user.id, storageKey: key, entityType: 'host_profile' },
        client
      );
      const found = await mediaRepo.findByKey(key, client);
      expect(found).not.toBeNull();
      expect(found.id).toBe(inserted.id);
      expect(found.storageKey).toBe(key);
      const missing = await mediaRepo.findByKey(`coverage-lane/none-${crypto.randomUUID()}`, client);
      expect(missing).toBeNull();
    });
  });

  test('notifications/repo.getRecipientEmail resolves email + verified flag, null for unknown', async () => {
    // getRecipientEmail queries the pool directly (send-time resolution), so use a committed
    // row and clean it up afterwards.
    const user = await dbHelper.makeUser({ email_verified: false });
    try {
      const got = await notifRepo.getRecipientEmail(user.id);
      expect(got).toEqual({ email: user.email, emailVerified: false });
      const unknown = await notifRepo.getRecipientEmail(crypto.randomUUID());
      expect(unknown).toBeNull();
    } finally {
      await dbHelper.query('DELETE FROM users WHERE id = $1', [user.id]);
    }
  });

  test('server.js start() binds HTTPS and wireShutdown drains to exit 0 on SIGTERM', async () => {
    // wireShutdown/signal handlers only wire under require.main, so exercise the real
    // process: spawn src/server.js, wait until it accepts TLS, then SIGTERM and require a
    // clean (code 0) drain — the NFR-08 graceful-shutdown claim of U1-HTTP.
    const { spawn } = require('child_process');
    const tlsMod = require('tls');
    const PORT = 8444;
    const env = { ...process.env, PORT: String(PORT) };
    const child = spawn('node', [path.join(ROOT, 'src', 'server.js')], {
      env,
      cwd: ROOT,
      stdio: 'ignore',
    });
    const exitCode = await new Promise((resolve, reject) => {
      let tries = 0;
      const probe = () => {
        const sock = tlsMod.connect({ port: PORT, rejectUnauthorized: false }, () => {
          sock.destroy();
          child.kill('SIGTERM');
        });
        sock.on('error', () => {
          tries += 1;
          if (tries > 40) {
            child.kill('SIGKILL');
            reject(new Error('server never accepted a TLS connection'));
            return;
          }
          setTimeout(probe, 200);
        });
      };
      child.on('exit', (code) => resolve(code));
      child.on('error', reject);
      probe();
    });
    expect(exitCode).toBe(0);
  }, 12000);

  test('requestContext.getContext exposes the active context and undefined outside one', () => {
    expect(requestContext.getContext()).toBeUndefined();
    requestContext.run({ correlationId: 'coverage-lane-cid' }, () => {
      const ctx = requestContext.getContext();
      expect(ctx).toBeDefined();
      expect(ctx.correlationId).toBe('coverage-lane-cid');
      expect(requestContext.getCorrelationId()).toBe('coverage-lane-cid');
    });
  });
});
