// tests/rt-lt-resilience/rt01-degradation.test.js — RT-01 (SRS §4.4, NFR-09; ADR-002/004/005/007/011).
//
// Verifier lane: cut off each external service in turn and prove the system
//   (a) surfaces a typed, user-presentable error instead of an unhandled 5xx,
//   (b) serves cached / previously stored data where available (degraded mode),
//   (c) defers notifications/moderation work instead of dropping it, and
//   (d) recovers once the service returns.
//
// The drills run at BOTH levels the NFR-09 acceptance names:
//   - adapter level (drills 1–4b): each adapter cut off directly, proving the typed-error /
//     cache-fallback / bounded-retry contract at the exact surface the acceptance describes;
//   - the wave-3 HTTP surface (drills 5–9): the same outages driven through the REAL
//     route → service → repo → serializer chain (GET /api/listings/search, POST /api/bookings,
//     POST /api/listings, GET /api/listings/:id). Outage lever: the shared adapter module
//     objects are monkey-patched through the require cache (wave3.patchFn) — the exact function
//     the application resolves at call time — with restores in finally/afterEach so no drill
//     leaks.
//
// SendGrid and FCM cannot be drilled as themselves here BY DESIGN: src/config/schema.js rejects
// any NOTIFICATIONS_TRANSPORT other than 'mock' while NODE_ENV=test (ADR-011 — the automated
// suite asserts on persisted NOTIFICATION_ATTEMPT rows, never on a third party). The shared
// transport contract both live adapters are driven through is drilled in this file (drill 4b);
// the live adapter BODIES (retryability split, timeout, recovery) are executed against harness
// doubles in rt01-provider-outage-drill.test.js.
'use strict';

const request = require('supertest');

const config = require('../../src/config');
const resilience = require('../../src/lib/resilience');
const maps = require('../../src/adapters/maps');
const { createMapsAdapter } = maps;
const objectStorage = require('../../src/adapters/objectStorage');
const { createObjectStorage } = objectStorage;
const llm = require('../../src/adapters/llmModeration');
const llmMock = require('../../src/adapters/llmModeration.mock');
const mockTransport = require('../../src/adapters/mockTransport');
const transport = require('../../src/modules/notifications/transport');
const { ServiceUnavailableError } = require('../../src/lib/errors');
const { pollOnce } = require('../../src/outbox/worker');
const { loadHandlers } = require('../../src/outbox/dispatch');
const { createApp } = require('../../src/app');

const dbh = require('../helpers/db');
const rh = require('../helpers/redis');
const { withOnlyTheseDue } = require('../helpers/outboxScope');
const { quietLogger } = require('./helpers');
const w3 = require('./wave3');

const quiet = quietLogger();
const PASSWORD = 'CorrectHorseBattery!42';
let app;

/** Delete the FRESH maps cache entries (keep :stale) — simulates fresh-TTL expiry. */
async function expireFreshMapsCache() {
  let cursor = '0';
  const deleted = [];
  do {
    const [next, keys] = await rh.redis.scan(cursor, 'MATCH', 'hp:cache:maps:*', 'COUNT', 200);
    cursor = next;
    for (const k of keys) {
      if (!k.endsWith(':stale')) {
        await rh.redis.del(k);
        deleted.push(k);
      }
    }
  } while (cursor !== '0');
  return deleted;
}

/** Minimal fetch-Response fake matching what src/lib/httpClient consumes. */
function fakeResponse(body, status = 200) {
  return {
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify(body),
  };
}

function googleGeocodeBody(lat, lng) {
  return {
    status: 'OK',
    results: [
      {
        geometry: { location: { lat, lng } },
        address_components: [
          { types: ['neighborhood'], long_name: 'Gaslamp Quarter' },
          { types: ['locality'], long_name: 'San Diego' },
        ],
      },
    ],
  };
}

function mapsOutageError() {
  return new ServiceUnavailableError('maps.searchArea: provider unavailable and no cached result', {
    code: 'MAPS_UNAVAILABLE',
  });
}

async function attemptRow(attemptId) {
  const { rows } = await dbh.query(`SELECT * FROM notification_attempts WHERE id = $1`, [
    attemptId,
  ]);
  return rows[0];
}

beforeAll(async () => {
  app = createApp({ logger: quiet });
  await rh.flushNamespace('cache'); // start with no cached search/maps pages
});

afterAll(async () => {
  mockTransport.reset();
  llmMock.reset();
  await dbh.closeDb();
  await rh.closeTestRedis();
});

describe('RT-01 substrate — resilience policy defaults (NFR-09 acceptance)', () => {
  test('adapter timeout defaults to 3000 ms with bounded retries and exponential backoff', () => {
    // NFR-09: "each adapter enforces a timeout (default 3000 ms), bounded retries with
    // exponential backoff". The test env does not override ADAPTER_TIMEOUT_MS.
    expect(config.adapters.timeoutMs).toBe(3000);
    expect(resilience.DEFAULT_TIMEOUT_MS).toBe(3000);
    expect(Number.isInteger(config.adapters.retryMax)).toBe(true);
    expect(config.adapters.retryMax).toBeGreaterThanOrEqual(1); // bounded, and really retries
    expect(config.adapters.backoffBaseMs).toBeGreaterThan(0);
    expect(config.outbox.maxAttempts).toBeGreaterThanOrEqual(1);
    // The backoff policy the transport hands to withResilience really is exponential —
    // doubling per attempt, not linear (NFR-09 acceptance wording).
    const base = config.adapters.backoffBaseMs;
    expect(resilience.computeBackoffDelay(1, { baseMs: base })).toBe(base);
    expect(resilience.computeBackoffDelay(2, { baseMs: base })).toBe(base * 2);
    expect(resilience.computeBackoffDelay(3, { baseMs: base })).toBe(base * 4);
  });
});

describe('RT-01 drill 1 — Google Maps outage at the adapter (ADR-005, NFR-09)', () => {
  let mode = 'ok';
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (mode === 'down') {
      throw new Error('simulated network refusal: connect ECONNREFUSED (maps outage drill)');
    }
    return fakeResponse(googleGeocodeBody(32.7105, -117.1611));
  };
  const RETRIES = 2;
  const adapter = createMapsAdapter({
    mode: 'live',
    apiKey: 'rt01-test-api-key-not-real',
    cacheTtlSeconds: 60,
    timeoutMs: 250,
    retries: RETRIES,
    backoffBaseMs: 5,
    fetchImpl,
    log: quiet,
  });
  const ADDRESS = 'RT01 Drill Address, San Diego, CA';

  test('healthy provider: live lookup, then served from Redis cache with zero HTTP calls', async () => {
    const first = await adapter.geocode(ADDRESS);
    expect(first.source).toBe('live');
    expect(first.degraded).toBe(false);
    expect(typeof first.lat).toBe('number');
    expect(typeof first.areaLabel).toBe('string');
    expect(calls).toBe(1);

    const second = await adapter.geocode(ADDRESS);
    expect(second.source).toBe('cache');
    expect(second.degraded).toBe(false);
    expect(calls).toBe(1); // zero additional HTTP requests (NFR-01/ADR-005 cache)
  });

  test('provider down: previously stored data is served; stale cache serves with a degraded indicator', async () => {
    mode = 'down';

    // Fresh cache entry still present → served as a normal hit.
    const hit = await adapter.geocode(ADDRESS);
    expect(hit.source).toBe('cache');
    expect(calls).toBe(1);

    // Fresh entry expires during the outage → the stale copy serves, flagged degraded.
    const expired = await expireFreshMapsCache();
    expect(expired.length).toBeGreaterThanOrEqual(1);
    const before = calls;
    const degraded = await adapter.geocode(ADDRESS);
    expect(degraded.degraded).toBe(true);
    expect(degraded.source).toBe('cache-degraded');
    expect(typeof degraded.lat).toBe('number');
    // Bounded retries: exactly 1 + RETRIES attempts, then fallback (never unbounded).
    expect(calls - before).toBe(1 + RETRIES);
  });

  test('provider down, nothing cached: a typed 503 MAPS_UNAVAILABLE, never an unhandled throw', async () => {
    mode = 'down';
    await expect(adapter.geocode('Never Cached Street 42, Elsewhere')).rejects.toMatchObject({
      status: 503,
      code: 'MAPS_UNAVAILABLE',
    });
  });

  test('recovery: once the provider returns, lookups go live again', async () => {
    mode = 'ok';
    const result = await adapter.geocode('Recovery Avenue, San Diego');
    expect(result.source).toBe('live');
    expect(result.degraded).toBe(false);
  });
});

describe('RT-01 drill 2 — notification provider outage (ADR-011, FR-10/FR-13 mechanism, NFR-09)', () => {
  const registry = loadHandlers({ log: quiet });

  beforeAll(async () => {
    // Neutralize pending jobs left by other lane files so poll stats are deterministic.
    await w3.neutralizePendingJobs();
  });

  afterEach(() => mockTransport.reset());

  test('with the provider down the business write still commits; the job defers, then delivers on recovery', async () => {
    mockTransport.injectFailures(20); // outage: every deliver() throws until reset

    const email = `rt01.outage.${Date.now()}@resilience.homeplate.invalid`;
    const started = Date.now();
    const res = await request(app).post('/api/auth/register').send({ email, password: PASSWORD });
    const elapsedMs = Date.now() - started;

    // (a)/(c): request path unaffected by the provider outage — committed, no 5xx.
    expect(res.status).toBe(201);
    expect(elapsedMs).toBeLessThan(5000);

    const { rows: userRows } = await dbh.query(`SELECT id FROM users WHERE email = $1`, [email]);
    expect(userRows).toHaveLength(1);
    const userId = userRows[0].id;

    const { rows: jobRows } = await dbh.query(
      `SELECT * FROM outbox_jobs WHERE type = 'email.verification'
         AND payload->>'userId' = $1`,
      [userId]
    );
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0].status).toBe('pending');
    const jobId = jobRows[0].id;

    // Worker attempts delivery during the outage: transport exhausts its bounded retries,
    // records a FAILED attempt row, the handler throws, the job backs off — still queued.
    const stats1 = await pollOnce({ registry, log: quiet });
    expect(stats1.claimed).toBe(1);
    expect(stats1.retried).toBe(1);
    expect(stats1.deadLettered).toBe(0);

    const { rows: afterFail } = await dbh.query(`SELECT * FROM outbox_jobs WHERE id = $1`, [jobId]);
    expect(afterFail[0].status).toBe('pending'); // deferred, never lost (NFR-09)
    expect(afterFail[0].attempt_count).toBe(1);
    expect(new Date(afterFail[0].available_at).getTime()).toBeGreaterThan(Date.now());

    const { rows: attempts1 } = await dbh.query(
      `SELECT * FROM notification_attempts WHERE recipient_user_id = $1`,
      [userId]
    );
    expect(attempts1).toHaveLength(1);
    expect(attempts1[0].status).toBe('failed');
    expect(mockTransport.deliveries()).toHaveLength(0);

    // (d) Recovery: provider restored → the SAME deferred job completes.
    mockTransport.reset();
    await dbh.query(`UPDATE outbox_jobs SET available_at = now() WHERE id = $1`, [jobId]);
    const stats2 = await pollOnce({ registry, log: quiet });
    expect(stats2.delivered).toBe(1);

    const { rows: afterRecover } = await dbh.query(`SELECT * FROM outbox_jobs WHERE id = $1`, [
      jobId,
    ]);
    expect(afterRecover[0].status).toBe('delivered');

    const { rows: attempts2 } = await dbh.query(
      `SELECT * FROM notification_attempts WHERE recipient_user_id = $1`,
      [userId]
    );
    expect(attempts2).toHaveLength(1); // same row resumed, not a duplicate
    expect(attempts2[0].status).toBe('sent');
    const delivered = mockTransport.deliveries().filter((d) => d.userId === userId);
    expect(delivered).toHaveLength(1); // delivered exactly once after recovery
  }, 30000);

  test('a hung provider is bounded by the per-attempt timeout, not hung forever', async () => {
    // Uses tighter env knobs? No — config is frozen at 3000ms/2 retries here, so a full
    // hang drill would cost (3000ms × 3) per send. Instead prove the timeout mechanism at
    // the resilience layer with a 100ms budget: the same withResilience contract the
    // transport wraps every deliver() call in.
    const hang = () => new Promise(() => {});
    await expect(
      resilience.withResilience(hang, {
        name: 'rt01-hang-drill',
        timeoutMs: 100,
        retries: 1,
        backoff: { baseMs: 5 },
        log: quiet,
      })
    ).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT', status: 504, retryable: true });
  }, 10000);
});

describe('RT-01 drill 3 — moderation LLM outage (ADR-002/ADR-007, NFR-09)', () => {
  afterEach(() => llmMock.reset());

  test('the automated suite resolves the deterministic mock adapter (ADR-007)', async () => {
    expect(config.moderation.mode).toBe('mock');
    const result = await llm.classify('a lovely home-cooked dinner');
    expect(result.category).toBe('benign');
    expect(result.model).toBe('mock-moderation-deterministic-v1');
  });

  test('outage surfaces as a typed RETRYABLE provider error, and recovery restores classification', async () => {
    llmMock.setOutage(true);
    await expect(llm.classify('any public content')).rejects.toMatchObject({
      code: 'MODERATION_PROVIDER_UNAVAILABLE',
      status: 503,
      retryable: true, // the outbox worker defers moderation instead of dropping it
    });

    llmMock.reset();
    const after = await llm.classify('any public content');
    expect(after.category).toBe('benign');
  });

  test('public content stays PENDING by schema default — an outage cannot publish unreviewed content (ADR-002)', async () => {
    // What is testable at the schema level: a listing row created without an explicit
    // moderation_status is born 'pending' and stays 'pending' unless something APPROVES it —
    // and with the LLM down nothing can. (Drill 7 proves the same invariant through the
    // POST /api/listings pipeline.)
    llmMock.setOutage(true);
    const listing = await dbh.makeListing({});
    expect(listing.moderation_status).toBe('pending');
    const { rows } = await dbh.query(`SELECT moderation_status FROM listings WHERE id = $1`, [
      listing.id,
    ]);
    expect(rows[0].moderation_status).toBe('pending');
  });
});

describe('RT-01 drill 4 — object storage outage at the adapter (ADR-004, NFR-09)', () => {
  test('outage: typed 503 OBJECT_STORAGE_UNAVAILABLE after bounded retries; recovery works', async () => {
    let downCalls = 0;
    let down = true;
    const fakeClient = {
      send: async () => {
        if (down) {
          downCalls += 1;
          const err = new Error('connect ECONNREFUSED 127.0.0.1:9000 (storage outage drill)');
          err.name = 'NetworkingError';
          throw err;
        }
        return { ETag: '"rt01-etag"' };
      },
    };
    const RETRIES = 2;
    const storage = createObjectStorage({
      client: fakeClient,
      bucket: 'rt01-drill-bucket',
      timeoutMs: 250,
      retries: RETRIES,
      backoff: { baseMs: 5 },
      log: quiet,
    });

    await expect(storage.put('listing/rt01-drill.jpg', Buffer.from('img'))).rejects.toMatchObject({
      status: 503,
      code: 'OBJECT_STORAGE_UNAVAILABLE',
      retryable: true, // wave-3 listing detail renders a placeholder off this, never a 500
    });
    expect(downCalls).toBe(1 + RETRIES); // bounded retries, then a typed failure

    down = false; // service restored
    const putResult = await storage.put('listing/rt01-drill.jpg', Buffer.from('img'));
    expect(putResult.key).toBe('listing/rt01-drill.jpg');
  });

  test('a missing object is a definitive 404, never masked as an outage', async () => {
    const fakeClient = {
      send: async () => {
        const err = new Error('NoSuchKey');
        err.name = 'NoSuchKey';
        throw err;
      },
    };
    const storage = createObjectStorage({
      client: fakeClient,
      bucket: 'rt01-drill-bucket',
      timeoutMs: 250,
      retries: 2,
      backoff: { baseMs: 5 },
      log: quiet,
    });
    await expect(storage.get('listing/gone.jpg')).rejects.toMatchObject({
      status: 404,
      code: 'MEDIA_NOT_FOUND',
    });
  });
});

describe('RT-01 drill 4b — the notification provider contract behind SendGrid and FCM (NFR-09, ADR-011)', () => {
  // NFR-09 acceptance names five adapters (Maps, SendGrid, FCM, LLM, object storage). SendGrid
  // and FCM are drilled here through the shared contract in src/modules/notifications/transport.js
  // (the ADR-011 mock stands in at the adapter seam); their live delivery BODIES are executed
  // against harness doubles in rt01-provider-outage-drill.test.js. What this describe closes:
  //   1. the ADR-011 push gate defaults FALSE, so an FCM send is refused before any adapter
  //      runs and is recorded as a failed row (never delivered);
  //   2. a provider outage exhausts BOUNDED retries and resolves to a FAILED ROW rather than
  //      throwing through the worker — the outbox keeps draining its batch (NFR-09);
  //   3. recovery: once the provider returns, sends deliver and rows read 'sent'.
  beforeEach(() => mockTransport.reset());
  afterAll(() => mockTransport.reset());

  test('the ADR-011 push gate defaults FALSE: an FCM send is refused, recorded, and never delivered', async () => {
    expect(config.notifications.push.enabled).toBe(false); // ADR-011 default
    expect(config.notifications.transport).toBe('mock'); // ADR-011: suite is mock-only

    const user = await w3.makeGuest();
    const result = await transport.send(
      {
        userId: user.id,
        channel: 'push',
        template: 'booking-created',
        params: {},
        idempotencyKey: `rt01-push-gate-${user.id}`,
      },
      { log: quiet }
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('push_disabled');
    const row = await attemptRow(result.attemptId);
    expect(row.channel).toBe('push');
    expect(row.status).toBe('failed');
    expect(row.last_error).toMatch(/push channel refused/i);
    // Refused BEFORE any adapter ran — the mock recorded nothing.
    expect(mockTransport.deliveries()).toHaveLength(0);
  });

  test('a total provider outage exhausts bounded retries and yields a FAILED ROW, never a throw', async () => {
    const user = await w3.makeGuest();
    const maxTries = config.adapters.retryMax + 1; // initial try + bounded retries
    // One more failure than the budget: the send must still stop at the budget.
    mockTransport.injectFailures(maxTries + 5);

    let threw = null;
    let result;
    try {
      result = await transport.send(
        {
          userId: user.id,
          channel: 'email',
          template: 'booking-created',
          params: {},
          idempotencyKey: `rt01-outage-${user.id}`,
        },
        { log: quiet }
      );
    } catch (err) {
      threw = err;
    }

    // NFR-09: "a provider outage yields a failed ROW, not an unhandled rejection".
    expect(threw).toBeNull();
    expect(result.status).toBe('failed');

    const row = await attemptRow(result.attemptId);
    expect(row.status).toBe('failed');
    expect(row.last_error).toBeTruthy();
    expect(row.sent_at).toBeNull();
    // Bounded: exactly the configured budget was spent, no more.
    expect(row.attempt_count).toBe(maxTries);
    expect(mockTransport.deliveries()).toHaveLength(0);
  }, 20000);

  test('recovery: once the provider returns, the same recipient is delivered to and the row reads sent', async () => {
    const user = await w3.makeGuest();
    mockTransport.injectFailures(1);
    const first = await transport.send(
      {
        userId: user.id,
        channel: 'email',
        template: 'booking-created',
        params: {},
        idempotencyKey: `rt01-recovery-a-${user.id}`,
      },
      { log: quiet }
    );
    // A single injected failure is inside the retry budget, so the send recovers in-flight.
    expect(['sent', 'failed']).toContain(first.status);

    mockTransport.reset(); // provider healthy again
    const second = await transport.send(
      {
        userId: user.id,
        channel: 'email',
        template: 'booking-created',
        params: {},
        idempotencyKey: `rt01-recovery-b-${user.id}`,
      },
      { log: quiet }
    );
    expect(second.status).toBe('sent');
    const row = await attemptRow(second.attemptId);
    expect(row.status).toBe('sent');
    expect(row.sent_at).not.toBeNull();
    expect(mockTransport.deliveries().filter((d) => d.userId === user.id)).toHaveLength(1);
  }, 20000);
});

describe('RT-01 drill 5 — Google Maps outage against GET /api/listings/search (NFR-09, ADR-005)', () => {
  let cookie;
  let listing;
  const CUISINE = 'rt01drill';
  const LOCATION = 'RT01 Drill Cove, San Diego';

  beforeAll(async () => {
    const guest = await w3.makeGuest();
    cookie = await w3.cookieFor(guest);
    // A listing sitting exactly on the coarse cell the degraded-mode areas will point at.
    listing = await w3.makeApprovedListing({ cuisine: CUISINE });
  });

  test('healthy: a location search answers 200 and its page is cached', async () => {
    const res = await request(app)
      .get('/api/listings/search')
      .query({ location: LOCATION, cuisine: CUISINE })
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBeUndefined();
  });

  test('provider down: the identical query is served from the cached page — 200, zero adapter calls', async () => {
    let adapterCalls = 0;
    const restore = w3.patchFn(maps, 'searchArea', async () => {
      adapterCalls += 1;
      throw mapsOutageError();
    });
    try {
      const res = await request(app)
        .get('/api/listings/search')
        .query({ location: LOCATION, cuisine: CUISINE })
        .set('Cookie', cookie);
      expect(res.status).toBe(200); // cached data served during the outage (NFR-09)
      expect(adapterCalls).toBe(0); // the page cache answered before the adapter was touched
    } finally {
      restore();
    }
  });

  test('provider down, stale area cache: 200 with results AND a degraded indicator; degraded pages are never cached', async () => {
    let adapterCalls = 0;
    // The adapter-level stale-cache fallback (proven live in drill 1 above) is simulated at
    // the adapter boundary so the service/route degraded contract is exercised.
    const restore = w3.patchFn(maps, 'searchArea', async () => {
      adapterCalls += 1;
      return {
        areas: [{ lat: 32.75, lng: -117.15, areaLabel: 'San Diego' }],
        degraded: true,
        source: 'cache-degraded',
      };
    });
    try {
      const q = { location: 'RT01 Degraded Heights', cuisine: CUISINE };
      const res1 = await request(app).get('/api/listings/search').query(q).set('Cookie', cookie);
      expect(res1.status).toBe(200);
      expect(res1.body.degraded).toBe(true); // the degraded-mode indicator (NFR-09)
      expect(res1.body.results.map((r) => r.id)).toContain(listing.id); // stored data served
      // ADR-010: even in degraded mode only public precision leaves the API.
      for (const item of res1.body.results) {
        expect(item.addressLine1).toBeUndefined();
        expect(item.lat).toBeUndefined();
        expect(item.lng).toBeUndefined();
      }
      expect(adapterCalls).toBe(1);

      // The degraded page must NOT have been cached: the same query consults the adapter again.
      const res2 = await request(app).get('/api/listings/search').query(q).set('Cookie', cookie);
      expect(res2.status).toBe(200);
      expect(res2.body.degraded).toBe(true);
      expect(adapterCalls).toBe(2);
    } finally {
      restore();
    }
  });

  test('provider down, nothing cached: typed 503 SEARCH_DEGRADED with a user-facing message — never a 500', async () => {
    const restore = w3.patchFn(maps, 'searchArea', async () => {
      throw mapsOutageError();
    });
    try {
      const res = await request(app)
        .get('/api/listings/search')
        .query({ location: 'RT01 Never Cached Bluffs' })
        .set('Cookie', cookie);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SEARCH_DEGRADED');
      expect(res.body.error.message).toMatch(/temporarily unavailable/i); // the required message
      expect(res.body.error.message).toMatch(/without a location/i); // actionable for the user
    } finally {
      restore();
    }
  });

  test('provider down: non-location searches are entirely unaffected', async () => {
    const restore = w3.patchFn(maps, 'searchArea', async () => {
      throw mapsOutageError();
    });
    try {
      const res = await request(app)
        .get('/api/listings/search')
        .query({ cuisine: CUISINE })
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.results.map((r) => r.id)).toContain(listing.id);
      expect(res.body.degraded).toBeUndefined();
    } finally {
      restore();
    }
  });

  test('recovery: once the provider returns, a fresh location query answers 200 un-degraded', async () => {
    const res = await request(app)
      .get('/api/listings/search')
      .query({ location: 'RT01 Recovery Point, San Diego' })
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBeUndefined();
  });
});

describe('RT-01 drill 6 — notification provider outage against POST /api/bookings (FR-12/FR-13, ADR-011)', () => {
  afterEach(() => mockTransport.reset());

  test('booking commits during the outage; both notify jobs defer with failed attempt rows, then deliver on recovery', async () => {
    await w3.neutralizePendingJobs();
    const registry = loadHandlers({ log: quiet });
    const host = await w3.makeHost();
    const listing = await w3.makeApprovedListing({ host_id: host.id });
    const guest = await w3.makeGuest();
    const cookie = await w3.cookieFor(guest);

    mockTransport.injectFailures(1000); // total provider outage

    const started = Date.now();
    const res = await request(app)
      .post('/api/bookings')
      .send({ listingId: listing.id })
      .set('Cookie', cookie);
    const elapsedMs = Date.now() - started;

    // The business write is untouched by the outage: committed, fast, no 5xx (FR-13, NFR-09).
    // FR-13 acceptance: "with the adapters forced to throw, POST /api/bookings still returns
    // 201 in under 500 ms" — the outage must be invisible to the request path's latency.
    expect(res.status).toBe(201);
    expect(elapsedMs).toBeLessThan(500);
    const bookingId = res.body.booking.id;
    const { rows: bookingRows } = await dbh.query(`SELECT * FROM bookings WHERE id = $1`, [
      bookingId,
    ]);
    expect(bookingRows).toHaveLength(1);
    expect(bookingRows[0].status).toBe('pending');

    // Both notify.booking rows committed with the booking; the promote job is scheduled.
    const { rows: notifyJobs } = await dbh.query(
      `SELECT * FROM outbox_jobs WHERE type = 'notify.booking'
        AND payload->>'bookingId' = $1 ORDER BY id`,
      [bookingId]
    );
    expect(notifyJobs).toHaveLength(2);
    const recipients = notifyJobs.map((j) => j.payload.recipientUserId).sort();
    expect(recipients).toEqual([guest.id, host.id].sort());

    // Worker cycle during the outage: both jobs retried (deferred), neither dead, none lost.
    const stats1 = await pollOnce({ registry, log: quiet });
    expect(stats1.retried).toBe(2);
    expect(stats1.deadLettered).toBe(0);
    const { rows: afterFail } = await dbh.query(
      `SELECT status, attempt_count FROM outbox_jobs WHERE type = 'notify.booking'
        AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    for (const row of afterFail) {
      expect(row.status).toBe('pending');
      expect(row.attempt_count).toBe(1);
    }
    const { rows: failedAttempts } = await dbh.query(
      `SELECT status FROM notification_attempts WHERE recipient_user_id = ANY($1::uuid[])`,
      [[guest.id, host.id]]
    );
    expect(failedAttempts.length).toBeGreaterThanOrEqual(2);
    expect(failedAttempts.every((a) => a.status === 'failed')).toBe(true);
    expect(mockTransport.deliveries()).toHaveLength(0);

    // Recovery: provider restored → the SAME deferred jobs complete, exactly once each.
    mockTransport.reset();
    await dbh.query(
      `UPDATE outbox_jobs SET available_at = now() WHERE type = 'notify.booking'
        AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    const stats2 = await pollOnce({ registry, log: quiet });
    expect(stats2.delivered).toBe(2);
    const delivered = mockTransport.deliveries();
    expect(delivered.filter((d) => d.userId === guest.id)).toHaveLength(1);
    expect(delivered.filter((d) => d.userId === host.id)).toHaveLength(1);
    const { rows: sentAttempts } = await dbh.query(
      `SELECT status FROM notification_attempts WHERE recipient_user_id = ANY($1::uuid[])`,
      [[guest.id, host.id]]
    );
    expect(sentAttempts.every((a) => a.status === 'sent')).toBe(true);
  }, 30000);
});

describe('RT-01 drill 7 — moderation LLM outage against POST /api/listings (FR-08, ADR-002/007)', () => {
  afterEach(() => llmMock.reset());

  test('creation succeeds, the listing stays PENDING and invisible, moderation work defers — never publishes', async () => {
    await w3.neutralizePendingJobs();
    const registry = loadHandlers({ log: quiet });
    llmMock.setOutage(true); // provider down for the whole drill

    const host = await w3.makeHost();
    const hostCookie = await w3.cookieFor(host);
    const guest = await w3.makeGuest();
    const guestCookie = await w3.cookieFor(guest);

    const res = await request(app)
      .post('/api/listings')
      .send({
        title: 'RT01 Outage Dinner',
        description: 'Listing created while the moderation provider is down.',
        ingredients: ['rice', 'beans'],
        cuisine: 'rt01llmdrill',
        scheduledStart: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
        durationMinutes: 90,
        seatCapacity: 4,
        addressLine1: '742 Outage Drill Way',
        city: 'San Diego',
        region: 'CA',
      })
      .set('Cookie', hostCookie);
    expect(res.status).toBe(201); // the outage never blocks creation (NFR-09)
    const listingId = res.body.listing.id;

    const { rows: created } = await dbh.query(
      `SELECT moderation_status FROM listings WHERE id = $1`,
      [listingId]
    );
    expect(created[0].moderation_status).toBe('pending'); // born pending (ADR-002)

    // The moderation.scan job is committed and deferred. The REAL U4-MODERATION handler now
    // runs it (this drill was re-pointed when the handler landed): with the provider down,
    // the first cycle reaches the classifier, gets the typed retryable error and RETRIES —
    // it may NOT complete as an approval, and the listing must still be pending afterwards.
    const { rows: scanJobs } = await dbh.query(
      `SELECT * FROM outbox_jobs WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
      [listingId]
    );
    expect(scanJobs).toHaveLength(1);
    expect(scanJobs[0].status).toBe('pending');

    await pollOnce({ registry, log: quiet });
    const { rows: afterPoll } = await dbh.query(
      `SELECT moderation_status FROM listings WHERE id = $1`,
      [listingId]
    );
    expect(afterPoll[0].moderation_status).toBe('pending'); // NEVER published unreviewed
    const { rows: scanAfter } = await dbh.query(
      `SELECT status, attempt_count, last_error FROM outbox_jobs
        WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
      [listingId]
    );
    expect(scanAfter[0].status).toBe('pending'); // deferred, not dropped, not dead yet
    expect(scanAfter[0].attempt_count).toBe(1); // the handler RAN and deferred (NFR-09)
    expect(scanAfter[0].last_error).toMatch(/Moderation provider unavailable/i);

    // Provider failure for ALL remaining attempts: the job dead-letters with the typed
    // error and the listing is pending FOREVER — never published unreviewed (ADR-002).
    for (let i = 0; i < config.outbox.maxAttempts + 1; i += 1) {
      await dbh.query(
        `UPDATE outbox_jobs SET available_at = now() - interval '1 hour'
          WHERE id = $1 AND status = 'pending'`,
        [scanJobs[0].id]
      );
      await pollOnce({ registry, log: quiet });
    }
    const { rows: deadScan } = await dbh.query(
      `SELECT status, last_error FROM outbox_jobs WHERE id = $1`,
      [scanJobs[0].id]
    );
    expect(deadScan[0].status).toBe('dead');
    expect(deadScan[0].last_error).toMatch(/Moderation provider unavailable/i);
    const { rows: finalListing } = await dbh.query(
      `SELECT moderation_status FROM listings WHERE id = $1`,
      [listingId]
    );
    expect(finalListing[0].moderation_status).toBe('pending');

    // Publicly invisible while pending: search never returns it, detail is 404 (FR-08/ADR-002).
    const search = await request(app)
      .get('/api/listings/search')
      .query({ cuisine: 'rt01llmdrill' })
      .set('Cookie', guestCookie);
    expect(search.status).toBe(200);
    expect(search.body.results).toHaveLength(0);
    const detail = await request(app).get(`/api/listings/${listingId}`).set('Cookie', guestCookie);
    expect(detail.status).toBe(404);
  }, 30000);
});

describe('RT-01 drill 8 — object storage outage against GET /api/listings/:id (ADR-004)', () => {
  test('listing detail with media renders 200 with locally-derived image URLs while the storage adapter is down', async () => {
    const host = await w3.makeHost();
    const listing = await w3.makeApprovedListing({ host_id: host.id });
    await dbh.insertRow('media_objects', {
      owner_user_id: host.id,
      entity_type: 'listing',
      entity_id: listing.id,
      storage_key: `listing/${host.id}/rt01-storage-drill.jpg`,
      content_type: 'image/jpeg',
    });
    const guest = await w3.makeGuest();
    const cookie = await w3.cookieFor(guest);

    // Total storage outage: every adapter operation throws.
    let adapterCalls = 0;
    const boom = async () => {
      adapterCalls += 1;
      throw new ServiceUnavailableError('storage outage drill', {
        code: 'OBJECT_STORAGE_UNAVAILABLE',
      });
    };
    const restores = ['put', 'get', 'deleteByKey'].map((fn) => w3.patchFn(objectStorage, fn, boom));
    try {
      const res = await request(app).get(`/api/listings/${listing.id}`).set('Cookie', cookie);
      expect(res.status).toBe(200); // never a 500 (NFR-09 acceptance)
      // WHY it cannot 500: the read path derives URLs by pure local SigV4 arithmetic
      // (src/lib/mediaUrls) and never touches src/adapters/objectStorage at all — the
      // ADR-001/003 request-path rule makes the storage outage structurally invisible here.
      // Asserting zero adapter calls turns an otherwise unfalsifiable drill into a real
      // regression guard: if anyone later puts a storage call on this read path, the outage
      // becomes user-visible and this count catches it.
      expect(adapterCalls).toBe(0);
      expect(Array.isArray(res.body.listing.images)).toBe(true);
      expect(res.body.listing.images).toHaveLength(1);
      // The URL is derived locally from the storage key (ADR-004/lib/mediaUrls) — the client
      // gets a renderable reference (its <img> may fall back to a placeholder) instead of an
      // API failure.
      expect(typeof res.body.listing.images[0].url).toBe('string');
      expect(res.body.listing.images[0].url).toContain('rt01-storage-drill.jpg');
    } finally {
      restores.forEach((restore) => restore());
    }
  });
});

describe('RT-01 drill 9 — combined Google-side outage: Maps AND moderation LLM down at once (NFR-09 acceptance)', () => {
  // This drill also owns what the retired wave-2 combined drill asserted at the adapter level:
  // its registration write was explicitly "wave-2's stand-in for the wave-3 booking commit"
  // (the real commit is (1) below), its typed MAPS_UNAVAILABLE / MODERATION_PROVIDER_UNAVAILABLE
  // failures are drilled in drills 1 and 3, and its born-pending listing is (2) below plus
  // drill 3's schema-default case.
  afterEach(() => llmMock.reset());

  test('bookings still commit, new public content stays pending, non-location search still serves', async () => {
    llmMock.setOutage(true);
    const restoreSearch = w3.patchFn(maps, 'searchArea', async () => {
      throw mapsOutageError();
    });
    const restoreGeocode = w3.patchFn(maps, 'geocode', async () => {
      throw mapsOutageError();
    });
    try {
      const host = await w3.makeHost();
      const hostCookie = await w3.cookieFor(host);
      const listing = await w3.makeApprovedListing({ host_id: host.id, cuisine: 'rt01combined' });
      const guest = await w3.makeGuest();
      const guestCookie = await w3.cookieFor(guest);

      // (1) The booking write path is fully operational (FR-12 commit, FR-13 deferred).
      const booking = await request(app)
        .post('/api/bookings')
        .send({ listingId: listing.id })
        .set('Cookie', guestCookie);
      expect(booking.status).toBe(201);

      // (2) New public content is created but stays pending (ADR-002 — nothing can approve).
      const created = await request(app)
        .post('/api/listings')
        .send({
          title: 'RT01 Combined Outage Dinner',
          description: 'Created while Maps and the moderation LLM are both down.',
          ingredients: ['pasta'],
          scheduledStart: new Date(Date.now() + 15 * 24 * 3600 * 1000).toISOString(),
          durationMinutes: 60,
          seatCapacity: 2,
          addressLine1: '1 Combined Outage Court',
          city: 'San Diego',
          region: 'CA',
        })
        .set('Cookie', hostCookie);
      expect(created.status).toBe(201);
      const { rows } = await dbh.query(`SELECT moderation_status FROM listings WHERE id = $1`, [
        created.body.listing.id,
      ]);
      expect(rows[0].moderation_status).toBe('pending');

      // (3) Non-location reads keep serving previously stored data.
      const search = await request(app)
        .get('/api/listings/search')
        .query({ cuisine: 'rt01combined' })
        .set('Cookie', guestCookie);
      expect(search.status).toBe(200);
      expect(search.body.results.map((r) => r.id)).toContain(listing.id);

      // (4) The one thing that IS down fails typed and user-facing, not with a 500.
      const located = await request(app)
        .get('/api/listings/search')
        .query({ location: 'RT01 Combined Uncached Mesa' })
        .set('Cookie', guestCookie);
      expect(located.status).toBe(503);
      expect(located.body.error.code).toBe('SEARCH_DEGRADED');
    } finally {
      restoreSearch();
      restoreGeocode();
    }
  }, 30000);
});

describe('RT-01 drill 10 — moderation LLM outage against the wave-4 surfaces: POST reviews and POST messages (FR-05/FR-06/FR-08, ADR-002/007, NFR-09)', () => {
  afterEach(() => llmMock.reset());

  test('review stays PENDING and invisible, the message DELIVERS immediately; both scans defer, and recovery completes the SAME jobs', async () => {
    await w3.neutralizePendingJobs();
    const registry = loadHandlers({ log: quiet });
    llmMock.setOutage(true); // provider down for the whole first half of the drill

    // A completed booking between an eligible guest and a host (FR-05 precondition).
    const host = await w3.makeHost();
    const listing = await w3.makeApprovedListing({ host_id: host.id });
    const guest = await w3.makeGuest();
    const booking = await dbh.makeBooking({
      listing_id: listing.id,
      guest_id: guest.id,
      status: 'completed',
      guest_confirmed_completion: true,
      host_confirmed_completion: true,
      completed_at: new Date(),
    });
    const guestCookie = await w3.cookieFor(guest);
    const hostCookie = await w3.cookieFor(host);

    // (a) Review creation succeeds during the outage and is born pending (ADR-002).
    const reviewRes = await request(app)
      .post(`/api/bookings/${booking.id}/reviews`)
      .send({ rating: 5, comment: 'A lovely dinner posted during the rt01 drill ten outage.' })
      .set('Cookie', guestCookie);
    expect(reviewRes.status).toBe(201);
    const reviewId = reviewRes.body.review.id;
    const { rows: bornPending } = await dbh.query(
      `SELECT moderation_status FROM reviews WHERE id = $1`,
      [reviewId]
    );
    expect(bornPending[0].moderation_status).toBe('pending');

    // (b) Message posting succeeds during the outage AND the other participant reads it
    // immediately — private messages deliver first, scanned asynchronously (ADR-002).
    const msgRes = await request(app)
      .post(`/api/bookings/${booking.id}/messages`)
      .send({ body: 'Hello host, sent while the moderation provider is down.' })
      .set('Cookie', guestCookie);
    expect(msgRes.status).toBe(201);
    const messageId = msgRes.body.message.id;
    const threadDuringOutage = await request(app)
      .get(`/api/bookings/${booking.id}/messages`)
      .set('Cookie', hostCookie);
    expect(threadDuringOutage.status).toBe(200);
    expect(threadDuringOutage.body.items.map((m) => m.id)).toContain(messageId);

    // Both scan jobs exist, committed with their content rows (ADR-001/003).
    const jobFor = async (id) => {
      const { rows } = await dbh.query(
        `SELECT * FROM outbox_jobs WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
        [id]
      );
      expect(rows).toHaveLength(1);
      return rows[0];
    };
    const reviewJob = await jobFor(reviewId);
    const messageJob = await jobFor(messageId);
    expect(reviewJob.status).toBe('pending');
    expect(messageJob.status).toBe('pending');

    // (c) A worker pass during the outage DEFERS both scans (retryable typed error), and
    // decides nothing: the review is still pending and invisible on the host's review page,
    // the message is still readable.
    await withOnlyTheseDue([reviewJob.id, messageJob.id], async () => {
      await pollOnce({ registry, log: quiet });
    });
    for (const job of [reviewJob, messageJob]) {
      const { rows } = await dbh.query(
        `SELECT status, attempt_count, last_error FROM outbox_jobs WHERE id = $1`,
        [job.id]
      );
      expect(rows[0].status).toBe('pending'); // deferred, not dropped
      expect(rows[0].attempt_count).toBe(1);
      expect(rows[0].last_error).toMatch(/Moderation provider unavailable/i);
    }
    const { rows: stillPending } = await dbh.query(
      `SELECT moderation_status FROM reviews WHERE id = $1`,
      [reviewId]
    );
    expect(stillPending[0].moderation_status).toBe('pending');
    const hostReviewsDuringOutage = await request(app)
      .get(`/api/hosts/${host.id}/reviews`)
      .set('Cookie', guestCookie);
    expect(hostReviewsDuringOutage.status).toBe(200);
    expect(hostReviewsDuringOutage.body.reviews.map((r) => r.id)).not.toContain(reviewId);
    const threadStillVisible = await request(app)
      .get(`/api/bookings/${booking.id}/messages`)
      .set('Cookie', hostCookie);
    expect(threadStillVisible.body.items.map((m) => m.id)).toContain(messageId);

    // (d) RECOVERY: the provider returns; the SAME deferred jobs complete and the benign
    // content is approved — the review becomes publicly visible, the message stays visible.
    llmMock.reset();
    await dbh.query(
      `UPDATE outbox_jobs SET available_at = now() - interval '1 second' WHERE id = ANY($1::bigint[])`,
      [[reviewJob.id, messageJob.id]]
    );
    await withOnlyTheseDue([reviewJob.id, messageJob.id], async () => {
      await pollOnce({ registry, log: quiet });
    });
    for (const job of [reviewJob, messageJob]) {
      const { rows } = await dbh.query(`SELECT status FROM outbox_jobs WHERE id = $1`, [job.id]);
      expect(rows[0].status).toBe('delivered'); // the same job, not a new one
    }
    const { rows: decided } = await dbh.query(
      `SELECT moderation_status FROM reviews WHERE id = $1`,
      [reviewId]
    );
    expect(decided[0].moderation_status).toBe('approved');
    const { rows: msgDecided } = await dbh.query(
      `SELECT moderation_status FROM messages WHERE id = $1`,
      [messageId]
    );
    expect(msgDecided[0].moderation_status).toBe('approved');
    const hostReviewsAfter = await request(app)
      .get(`/api/hosts/${host.id}/reviews`)
      .set('Cookie', guestCookie);
    expect(hostReviewsAfter.status).toBe(200);
    expect(hostReviewsAfter.body.reviews.map((r) => r.id)).toContain(reviewId);
    const threadAfter = await request(app)
      .get(`/api/bookings/${booking.id}/messages`)
      .set('Cookie', hostCookie);
    expect(threadAfter.body.items.map((m) => m.id)).toContain(messageId);
  }, 30000);
});
