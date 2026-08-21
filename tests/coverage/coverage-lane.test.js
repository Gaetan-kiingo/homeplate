// tests/coverage/coverage-lane.test.js — COVERAGE verification lane (wave 3 revision).
//
// Answers "is every exported module and function actually implemented and tested?" for the
// wave 0-3 build (build-plan 2026-08-14 §3: U3-LISTINGS, U3-BOOKINGS, U3-SEARCH,
// U3-HOSTS-MEDIA now on disk; §7 assigns lane updates to the verifiers — this revision
// replaces the wave-2 "wave 3-6 modules NOT mounted" probes with the wave-3 surface).
//
//  1. Static stub scan — no TODO/FIXME/not-implemented markers anywhere in src/, scripts/,
//     db/migrations (ground rule: no placeholder implementations).
//  2. Public-interface inventory — every contract published in build-plan §3 ("Public
//     interfaces this run publishes") exists on disk with the declared export shape, for
//     waves 0-2 AND wave 3.
//  3. HTTP route inventory — the wave-3 mounted surface is exactly auth + users + listings
//     (+ /api/listings/search) + bookings + hosts + media; wave 4-6 modules stay 404.
//  4. Previously unexercised exports — functions the wave-3 coverage report showed at 0 hits
//     (listings/repo.toListing; the 23505 unique-index → 409 MEHKO_DAILY_LISTING_LIMIT
//     mapping in listings/service) plus the wave-2 set (media/repo.findByKey,
//     notifications/repo.getRecipientEmail, requestContext.getContext, server.js shutdown)
//     are executed here so no exported function in the wave 0-3 surface remains untested.
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

describe('coverage lane — no stubs or placeholders in the wave 0-3 surface', () => {
  const files = [
    ...walk(path.join(ROOT, 'src')),
    ...walk(path.join(ROOT, 'scripts')),
    ...walk(path.join(ROOT, 'db', 'migrations')),
  ];

  test('at least the full wave 0-3 file inventory is on disk', () => {
    // 76 src files + 6 scripts + 4 migrations = 86+ existed at wave-3 verification time.
    expect(files.length).toBeGreaterThanOrEqual(80);
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

  test('wave 4-6 modules are NOT on disk yet (scope guard — SRS §1.2 / build-plan §4)', () => {
    // `safety` left this list when U4-SAFETY landed (FR-07): its coverage is asserted by
    // tests/unit/safety.test.js, tc07-safety.test.js and it04-safety-delivery.test.js.
    for (const mod of ['reviews', 'messaging', 'moderation', 'privacy']) {
      expect(fs.existsSync(path.join(ROOT, 'src', 'modules', mod))).toBe(false);
    }
    expect(fs.existsSync(path.join(ROOT, 'client'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Public-interface inventory (build-plan §3 contract tables, waves 0-2 and 3)
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

describe('coverage lane — every published wave-3 contract exists with real exports', () => {
  test('U3-LISTINGS: serializers, access gate, MEHKO enforcement point, repo, service', () => {
    const serializers = require('../../src/modules/listings/serializers');
    const access = require('../../src/modules/listings/access');
    const mehko = require('../../src/modules/listings/mehko');
    const repo = require('../../src/modules/listings/repo');
    const service = require('../../src/modules/listings/service');
    for (const fn of [serializers.publicListing, serializers.privilegedListing,
      access.canViewPreciseLocation, mehko.assertWithinCaps, mehko.localDateFor,
      repo.findById, repo.findApprovedByHost, service.createListing, service.getListing,
      service.updateListing, service.cancelListing]) {
      expect(typeof fn).toBe('function');
    }
    // ADR-010: the public allowlist must exist, be frozen, and exclude precise location keys.
    expect(Object.isFrozen(serializers.PUBLIC_KEYS)).toBe(true);
    const publicKeys = Array.from(serializers.PUBLIC_KEYS);
    for (const banned of ['addressLine1', 'address_line1', 'lat', 'lng']) {
      expect(publicKeys).not.toContain(banned);
    }
  });

  test('U3-LISTINGS: mediaUrls derives URLs and upload targets locally (no adapter import)', () => {
    const mediaUrls = require('../../src/lib/mediaUrls');
    expect(typeof mediaUrls.urlForKey).toBe('function');
    expect(typeof mediaUrls.createUploadTarget).toBe('function');
    const src = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'mediaUrls.js'), 'utf8');
    expect(src).not.toMatch(/require\(['"][^'"]*adapters\//);
  });

  test('U3-BOOKINGS: service, repo (incl. wave-4 gate findParticipantBooking), lifecycle', () => {
    const service = require('../../src/modules/bookings/service');
    const repo = require('../../src/modules/bookings/repo');
    const lifecycle = require('../../src/modules/bookings/lifecycle');
    for (const fn of [service.createBooking, service.cancelBooking, service.confirmCompletion,
      service.getBooking, service.listBookings, repo.findParticipantBooking,
      lifecycle.enqueueBookingNotifications, lifecycle.enqueuePromotion,
      lifecycle.promoteDueBooking]) {
      expect(typeof fn).toBe('function');
    }
  });

  test('U3-BOOKINGS: migration 0004 applied — bookings.completed_at exists (FR-04)', async () => {
    const dbHelper = require('../helpers/db');
    const { rows } = await dbHelper.query(
      `SELECT data_type FROM information_schema.columns
       WHERE table_name = 'bookings' AND column_name = 'completed_at'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('timestamp with time zone');
  });

  test('U3-SEARCH: module exports basePath /api/listings + router; service and repo real', () => {
    const routes = require('../../src/modules/search/routes');
    const service = require('../../src/modules/search/service');
    const repo = require('../../src/modules/search/repo');
    expect(routes.basePath).toBe('/api/listings');
    expect(typeof routes.router).toBe('function');
    for (const fn of [service.searchListings, service.normalizeQuery, service.cacheKeyFor,
      repo.buildSearchQuery, repo.buildCountQuery, repo.searchListings]) {
      expect(typeof fn).toBe('function');
    }
  });

  test('U3-HOSTS-MEDIA: host page service/serializers with frozen non-PII allowlists', () => {
    const service = require('../../src/modules/hosts/service');
    const serializers = require('../../src/modules/hosts/serializers');
    const repo = require('../../src/modules/hosts/repo');
    for (const fn of [service.getHostPage, service.listHostReviews, serializers.hostPage,
      serializers.publicReview, repo.findHost, repo.getReviewStats,
      repo.listApprovedReviews]) {
      expect(typeof fn).toBe('function');
    }
    expect(Object.isFrozen(serializers.HOST_PAGE_KEYS)).toBe(true);
    expect(Object.isFrozen(serializers.REVIEW_KEYS)).toBe(true);
    const hostKeys = Array.from(serializers.HOST_PAGE_KEYS);
    for (const banned of ['email', 'phone', 'phoneEnc', 'passwordHash', 'addressLine1']) {
      expect(hostKeys).not.toContain(banned);
    }
  });

  test('outbox handler registry now serves the four wave 0-3 job types', () => {
    const dispatch = require('../../src/outbox/dispatch');
    const registry = dispatch.loadHandlers();
    const types = registry.types();
    for (const t of ['email.verification', 'listing.geocode', 'notify.booking',
      'booking.promote']) {
      expect(types).toContain(t);
    }
    // moderation.scan is enqueued by wave 3 but its handler is wave-4 (build-plan §6.2):
    // jobs dead-letter and content stays pending — assert no handler pretends otherwise.
    expect(types).not.toContain('moderation.scan');
  });
});

// ---------------------------------------------------------------------------------------------
// 3. HTTP route inventory (wave-3 mounted surface; wave 4-6 stays 404)
// ---------------------------------------------------------------------------------------------

describe('coverage lane — mounted HTTP surface matches the wave-3 plan', () => {
  const UUID = '11111111-1111-4111-8111-111111111111';
  let app;
  beforeAll(() => {
    const { createApp } = require('../../src/app');
    app = createApp();
  });

  test('GET /health answers 200 {status:"ok"} from the process alone (NFR-09 liveness)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('wave-2 auth/users endpoints stay mounted', async () => {
    expect((await request(app).post('/api/auth/register').send({})).status).toBe(422);
    expect((await request(app).post('/api/auth/login').send({})).status).toBe(422);
    expect((await request(app).post('/api/auth/logout').send({})).status).toBe(401);
    expect((await request(app).get('/api/users/me')).status).toBe(401);
    expect((await request(app).patch('/api/users/me').send({})).status).toBe(401);
  });

  test('U3-LISTINGS routes are mounted and session-gated (401/405, never 404)', async () => {
    expect((await request(app).post('/api/listings').send({})).status).toBe(401);
    expect((await request(app).get(`/api/listings/${UUID}`)).status).toBe(401);
    expect((await request(app).patch(`/api/listings/${UUID}`).send({})).status).toBe(401);
    expect((await request(app).post(`/api/listings/${UUID}/cancel`).send({})).status).toBe(401);
    // No collection GET is specified for /api/listings — a proper 405, not a silent 404.
    expect((await request(app).get('/api/listings')).status).toBe(405);
  });

  test('U3-SEARCH: GET /api/listings/search reaches the search router; /api/search stays 404', async () => {
    expect((await request(app).get('/api/listings/search')).status).toBe(401);
    expect((await request(app).post('/api/listings/search').send({})).status).toBe(405);
    expect((await request(app).get('/api/search')).status).toBe(404);
  });

  test('U3-BOOKINGS routes are mounted and session-gated (401, never 404)', async () => {
    expect((await request(app).post('/api/bookings').send({})).status).toBe(401);
    expect((await request(app).get('/api/bookings')).status).toBe(401);
    expect((await request(app).get(`/api/bookings/${UUID}`)).status).toBe(401);
    expect((await request(app).post(`/api/bookings/${UUID}/cancel`).send({})).status).toBe(401);
    expect(
      (await request(app).post(`/api/bookings/${UUID}/confirm-completion`).send({})).status
    ).toBe(401);
  });

  test('U3-HOSTS-MEDIA routes are mounted and session-gated (401, never 404)', async () => {
    expect((await request(app).get(`/api/hosts/${UUID}`)).status).toBe(401);
    expect((await request(app).get(`/api/hosts/${UUID}/reviews`)).status).toBe(401);
    expect((await request(app).post('/api/media/uploads').send({})).status).toBe(401);
    expect((await request(app).post('/api/media').send({})).status).toBe(401);
    expect((await request(app).delete(`/api/media/${UUID}`)).status).toBe(401);
  });

  test('wave 4-6 modules are NOT mounted (404); the landed FR-07 surface is session-gated', async () => {
    for (const p of ['/api/reviews', '/api/messaging', '/api/moderation', '/api/safety',
      '/api/privacy']) {
      const res = await request(app).get(p);
      expect(res.status).toBe(404);
    }
    // U4-SAFETY mounts exactly two FULL paths (never a bare /api/safety or /api/moderation):
    // they answer 401 unauthenticated, which is what proves they are mounted at all.
    expect((await request(app).get('/api/moderation/alerts')).status).toBe(401);
    expect((await request(app).post(`/api/bookings/${UUID}/safety-alerts`).send({})).status).toBe(
      401
    );
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
    // clean (code 0) drain — the NFR-08 graceful-shutdown claim of U1-HTTP. (Child-process
    // execution is invisible to Jest instrumentation, so src/server.js legitimately reports
    // low in-process coverage; THIS test is its exercise record.)
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

  test('listings/repo.toListing maps a full row to camelCase and feeds the serializers', () => {
    // Wave-3 coverage gap: toListing is exported (build-plan §3 row-mapping projection) but
    // had zero hits — services pass raw rows to the serializers, which accept both shapes.
    const { toListing } = require('../../src/modules/listings/repo');
    const serializers = require('../../src/modules/listings/serializers');
    expect(toListing(null)).toBeNull();
    const row = {
      id: crypto.randomUUID(),
      host_id: crypto.randomUUID(),
      title: 'Coverage-lane dinner',
      description: 'Row-mapper exercise',
      ingredients: ['rice'],
      allergens: ['none'],
      cuisine: 'test',
      scheduled_start: new Date('2028-06-01T02:00:00Z'),
      duration_minutes: 90,
      local_date: '2028-05-31',
      address_line1: '1 Exact St',
      address_line2: null,
      city: 'San Diego',
      region: 'CA',
      postal_code: '92103',
      country: 'US',
      lat: 32.7157,
      lng: -117.1611,
      coarse_lat: 32.72,
      coarse_lng: -117.16,
      area_label: 'Downtown San Diego',
      seat_capacity: 4,
      seats_remaining: 4,
      moderation_status: 'approved',
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
    };
    const mapped = toListing(row);
    expect(mapped).toMatchObject({
      id: row.id,
      hostId: row.host_id,
      addressLine1: '1 Exact St',
      coarseLat: 32.72,
      areaLabel: 'Downtown San Diego',
      seatsRemaining: 4,
    });
    // The serializers' documented claim: they accept repo.toListing output too — and the
    // public projection must still strip the precise location from the camelCase shape.
    const pub = serializers.publicListing(mapped, []);
    expect(pub.areaLabel).toBe('Downtown San Diego');
    expect(pub.addressLine1).toBeUndefined();
    expect(pub.lat).toBeUndefined();
    expect(pub.lng).toBeUndefined();
  });

  test('the 23505 unique-index backstop maps to 409 MEHKO_DAILY_LISTING_LIMIT (race loser path)', async () => {
    // Wave-3 coverage gap: tests/unit/listings.test.js races two HTTP creates, but in the
    // recorded runs the loser was refused by the in-transaction MEHKO pre-check — the
    // isDailyLimitViolation → dailyLimitConflict mapping (listings/service.js) had ZERO hits,
    // so the ADR-009 unique-index backstop's error mapping was unverified. Deterministically
    // force the backstop: bypass the pre-check so both creates reach the INSERT and the 0002
    // unique index (listings_host_local_date_key) itself must refuse the duplicate.
    const mehko = require('../../src/modules/listings/mehko');
    const service = require('../../src/modules/listings/service');
    const { logger } = require('../../src/lib/logger');
    const host = await dbHelper.makeUser({ can_publish_listing: true });
    const spy = jest
      .spyOn(mehko, 'assertWithinCaps')
      .mockResolvedValue({ localDate: '2028-03-07' });
    const input = {
      title: 'Backstop dinner',
      description: 'Coverage-lane 23505 exercise',
      ingredients: ['rice', 'beans'],
      allergens: ['none'],
      cuisine: 'test',
      scheduledStart: '2028-03-07T19:00:00-08:00',
      durationMinutes: 90,
      seatCapacity: 2,
      addressLine1: '2 Backstop Way',
      city: 'San Diego',
      region: 'CA',
      postalCode: '92103',
    };
    try {
      const first = await service.createListing({ userId: host.id }, input, { log: logger });
      expect(first).toBeDefined();
      let caught = null;
      try {
        await service.createListing(
          { userId: host.id },
          { ...input, title: 'Backstop dinner two' },
          { log: logger }
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).not.toBeNull();
      expect(caught.status).toBe(409);
      expect(caught.code).toBe('MEHKO_DAILY_LISTING_LIMIT');
    } finally {
      spy.mockRestore();
      await dbHelper.query('DELETE FROM listings WHERE host_id = $1', [host.id]);
      await dbHelper.query('DELETE FROM users WHERE id = $1', [host.id]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Statically unreferenced exports (folded in from the lane's re-verification probes) —
//    the exports the lane's static cross-reference flagged as never named outside their own
//    file are executed here so the coverage report shows a real hit rather than an
//    unexercised branch.
// ---------------------------------------------------------------------------------------------

describe('coverage lane — statically unreferenced exports do real work', () => {
  const { defaultAreaLabel, METERS_PER_DEGREE_LAT } = require('../../src/lib/geoPrecision');
  const sanitize = require('../../src/lib/sanitize');
  const resilience = require('../../src/lib/resilience');
  const dispatch = require('../../src/outbox/dispatch');
  const routeRegistry = require('../../src/routes/index');
  const policy = require('../../src/modules/eligibility/policy');
  const tokens = require('../../src/modules/users/tokens');
  const fcm = require('../../src/adapters/fcm');

  test('geoPrecision.defaultAreaLabel and METERS_PER_DEGREE_LAT compute real values', () => {
    expect(typeof METERS_PER_DEGREE_LAT).toBe('number');
    expect(METERS_PER_DEGREE_LAT).toBeGreaterThan(110000);
    const label = defaultAreaLabel(32.7157, -117.1611);
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toMatch(/\d{3,}\s+\w+\s+(st|ave|blvd)/i);
  });

  test('sanitize.escapeHtml escapes every HTML metacharacter (NFR-11 / AB-06)', () => {
    expect(sanitize.escapeHtml('<script>a&b"c\'d</script>')).toBe(
      '&lt;script&gt;a&amp;b&quot;c&#x27;d&lt;/script&gt;'
    );
  });

  test('resilience.defaultIsRetryable and DEFAULT_RETRIES classify real errors', () => {
    expect(Number.isInteger(resilience.DEFAULT_RETRIES)).toBe(true);
    expect(resilience.DEFAULT_RETRIES).toBeGreaterThan(0);
    // The contract is the typed-error `retryable` flag (src/lib/errors.js), not HTTP status:
    // anything not explicitly marked non-retryable is retried (NFR-09 bounded retries).
    const netErr = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(resilience.defaultIsRetryable(netErr)).toBe(true);
    expect(resilience.defaultIsRetryable(undefined)).toBe(true);
    const permanent = Object.assign(new Error('bad request'), { retryable: false });
    expect(resilience.defaultIsRetryable(permanent)).toBe(false);
  });

  test('dispatch.validateHandler rejects malformed handlers and accepts real ones', () => {
    expect(typeof dispatch.DEFAULT_HANDLERS_DIR).toBe('string');
    expect(() => dispatch.validateHandler({ type: 'x.y', handle: async () => {} })).not.toThrow();
    expect(() => dispatch.validateHandler({ type: 'x.y' })).toThrow();
    expect(() => dispatch.validateHandler({ handle: async () => {} })).toThrow();
  });

  test('routes.collectAllowedMethods reports the real methods of a known path', () => {
    const express = require('express');
    const app = express();
    const r = express.Router();
    r.get('/thing', (_q, s) => s.json({}));
    r.post('/thing', (_q, s) => s.json({}));
    app.use('/api/x', r);
    // Signature is (stack, pathname) — it walks an Express router stack, not an app.
    const allowed = [...routeRegistry.collectAllowedMethods(app._router.stack, '/api/x/thing')];
    expect(allowed.map((m) => m.toUpperCase()).sort()).toEqual(['GET', 'POST']);
    expect([...routeRegistry.collectAllowedMethods(app._router.stack, '/api/x/nope')]).toEqual([]);
  });

  test('eligibility.isHostProfileComplete distinguishes complete from incomplete profiles', () => {
    expect(typeof policy.isHostProfileComplete).toBe('function');
    const complete = policy.isHostProfileComplete({
      displayName: 'Ada',
      bio: 'Home cook in North Park.',
      addressLine1: '1 Main St',
      city: 'San Diego',
      state: 'CA',
      postalCode: '92103',
    });
    const incomplete = policy.isHostProfileComplete({ displayName: 'Ada' });
    expect(typeof complete).toBe('boolean');
    expect(typeof incomplete).toBe('boolean');
    expect(complete).not.toBe(incomplete); // the predicate actually discriminates
  });

  test('users/tokens.generateToken + hashToken produce a verifiable, non-reversible pair', () => {
    const a = tokens.generateToken(); // { raw, hash }
    const b = tokens.generateToken();
    expect(typeof a.raw).toBe('string');
    expect(a.raw.length).toBeGreaterThan(20);
    expect(a.raw).not.toBe(b.raw); // real randomness, not a constant
    expect(a.hash).not.toBe(a.raw); // the stored form is not the token
    expect(tokens.hashToken(a.raw)).toBe(a.hash); // deterministic, matches generateToken
    expect(tokens.hashToken(b.raw)).not.toBe(a.hash);
    expect(() => tokens.hashToken('')).toThrow(TypeError);
  });

  test('fcm.pushDisabledError is the ADR-011 gated-channel error, not a generic throw', () => {
    const err = fcm.pushDisabledError();
    expect(err).toBeInstanceOf(Error);
    expect(typeof err.code).toBe('string');
    expect(err.code.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. Open-handle regression guard (COV-09 / MTUT-RV-01; NFR-08 reproducible toolchain)
//
// The defect this guards against was in tests/coverage/cov-verify-probes.test.js (since folded
// into this file): it required the shared ioredis client (src/db/redis.js, re-exported by
// tests/helpers/redis.js) and never quit it, so the Jest worker held a live TCPWRAP handle
// after the last suite finished and every run ended with "Jest did not exit one second after
// the test run has completed" — making automated invocations look hung (one had to be killed
// at 8m20s despite the tests finishing in 91s). `--detectOpenHandles` named exactly one
// handle, that file's `redis.keys()` call.
//
// The leak is invisible in a scoped green run — the tests still PASS, the process just never
// exits — so nothing else in the suite catches it. This static scan does: any test file that
// takes the shared client must also give it back. It is deliberately a source scan rather
// than a runtime probe, because a runtime probe would have to open the very handle it is
// checking for. `--forceExit` is not an acceptable alternative: it masks the leak and can
// abandon a Redis connection mid-command, leaving the lane's claim registry stale.
// ---------------------------------------------------------------------------------------------
describe('coverage lane — every Redis-using test file quits the shared client', () => {
  const TESTS_ROOT = path.resolve(__dirname, '..');

  // Matches `require('…/helpers/redis')` and `require('…/src/db/redis')` in any quote style.
  const REQUIRES_SHARED_REDIS = /require\(\s*['"][^'"]*(?:helpers\/redis|db\/redis)['"]\s*\)/;
  // closeRedis() (the app's own quit) or closeTestRedis() (the helper's thin wrapper).
  const QUITS_SHARED_REDIS = /\bclose(?:Test)?Redis\s*\(/;
  const HAS_AFTER_ALL = /\bafterAll\s*\(/;

  /**
   * Drop comments before matching. Without this the guard is satisfiable by PROSE: the header
   * above explains the fix in words, and a leaking file that merely mentioned "closeRedis()"
   * in a comment would pass while still holding the handle open.
   * @param {string} src
   * @returns {string} source with block and line comments blanked out
   */
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  function testFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) testFiles(p, out);
      else if (entry.name.endsWith('.test.js')) out.push(p);
    }
    return out;
  }

  const redisUsers = testFiles(TESTS_ROOT)
    .map((file) => ({ file, code: stripComments(fs.readFileSync(file, 'utf8')) }))
    .filter(({ code }) => REQUIRES_SHARED_REDIS.test(code));

  test('the scan actually reaches the suite (a broken walk must fail, not pass vacuously)', () => {
    // 54 test files required the shared client at wave-3 re-verification; the floor is set well
    // below that so ordinary suite churn does not trip it, but an empty/mis-rooted walk does.
    expect(redisUsers.length).toBeGreaterThan(20);
    // This file is itself in scope — the guard must cover the kind of file that broke the rule.
    expect(redisUsers.map(({ file }) => file)).toContain(__filename);
  });

  test('no test file opens the shared ioredis client without closing it in afterAll', () => {
    const offenders = redisUsers
      .filter(({ code }) => !(QUITS_SHARED_REDIS.test(code) && HAS_AFTER_ALL.test(code)))
      .map(({ file }) => path.relative(TESTS_ROOT, file));
    // Named, not just counted: the failure message must point at the file to fix.
    expect(offenders).toEqual([]);
  });
});
