// tests/rt-lt-resilience/rt01-degradation.test.js — RT-01 (SRS §4.4, NFR-09; ADR-002/005/007/011).
//
// Verifier lane: cut off each external service in turn and prove the system
//   (a) surfaces a typed, user-presentable error instead of an unhandled 5xx,
//   (b) serves cached / previously stored data where available (degraded mode),
//   (c) defers notifications/moderation work instead of dropping it, and
//   (d) recovers once the service returns.
//
// Wave-2 scope note: the wave-3/4 read paths (search endpoint, listing detail, moderation
// pipeline) do not exist yet, so the drills run at the adapter/outbox level — the exact
// surface the NFR-09 acceptance names — plus the one real end-to-end flow that exists
// (FR-10 registration → outbox → notification transport).
'use strict';

const request = require('supertest');

const config = require('../../src/config');
const resilience = require('../../src/lib/resilience');
const { createMapsAdapter } = require('../../src/adapters/maps');
const { createObjectStorage } = require('../../src/adapters/objectStorage');
const llm = require('../../src/adapters/llmModeration');
const llmMock = require('../../src/adapters/llmModeration.mock');
const mockTransport = require('../../src/adapters/mockTransport');
const { pollOnce } = require('../../src/outbox/worker');
const { loadHandlers } = require('../../src/outbox/dispatch');
const { createApp } = require('../../src/app');

const dbh = require('../helpers/db');
const rh = require('../helpers/redis');
const { quietLogger } = require('./helpers');

const quiet = quietLogger();
const PASSWORD = 'CorrectHorseBattery!42';

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

afterAll(async () => {
  mockTransport.reset();
  llmMock.reset();
  await dbh.closeDb();
  await rh.closeTestRedis();
});

describe('RT-01 substrate — resilience policy defaults (NFR-09 acceptance)', () => {
  test('adapter timeout defaults to 3000 ms with bounded retries and backoff in config', () => {
    // NFR-09: "each adapter enforces a timeout (default 3000 ms), bounded retries with
    // exponential backoff". The test env does not override ADAPTER_TIMEOUT_MS.
    expect(config.adapters.timeoutMs).toBe(3000);
    expect(resilience.DEFAULT_TIMEOUT_MS).toBe(3000);
    expect(Number.isInteger(config.adapters.retryMax)).toBe(true);
    expect(config.adapters.retryMax).toBeGreaterThanOrEqual(0);
    expect(config.adapters.backoffBaseMs).toBeGreaterThan(0);
    expect(config.outbox.maxAttempts).toBeGreaterThanOrEqual(1);
  });
});

describe('RT-01 drill 1 — Google Maps outage (ADR-005, NFR-09)', () => {
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
  let app;
  const registry = loadHandlers({ log: quiet });

  beforeAll(async () => {
    app = createApp({ logger: quiet });
    // Neutralize pending jobs left by other lane files so poll stats are deterministic.
    await dbh.query(
      `UPDATE outbox_jobs SET status = 'delivered', delivered_at = now() WHERE status = 'pending'`
    );
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
    // Wave-4 note: the runtime moderation pipeline does not exist yet. What IS testable now
    // is the database invariant the pipeline builds on: a listing row created without an
    // explicit moderation_status is born 'pending' and stays 'pending' unless something
    // APPROVES it — and with the LLM down nothing can.
    llmMock.setOutage(true);
    const listing = await dbh.makeListing({});
    expect(listing.moderation_status).toBe('pending');
    const { rows } = await dbh.query(`SELECT moderation_status FROM listings WHERE id = $1`, [
      listing.id,
    ]);
    expect(rows[0].moderation_status).toBe('pending');
  });
});

describe('RT-01 drill 4 — object storage outage (ADR-004, NFR-09)', () => {
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

describe('RT-01 drill 5 — combined Google-side outage: Maps AND moderation LLM down at once (NFR-09 acceptance)', () => {
  test('business writes still commit and public content stays pending', async () => {
    // Both Google-backed services down simultaneously.
    llmMock.setOutage(true);
    const deadFetch = async () => {
      throw new Error('simulated Google-wide outage');
    };
    const maps = createMapsAdapter({
      mode: 'live',
      apiKey: 'rt01-test-api-key-not-real',
      cacheTtlSeconds: 60,
      timeoutMs: 100,
      retries: 0,
      backoffBaseMs: 5,
      fetchImpl: deadFetch,
      log: quiet,
    });

    // Maps: typed failure only.
    await expect(maps.geocode('Uncached Combined-Outage Lane 7')).rejects.toMatchObject({
      code: 'MAPS_UNAVAILABLE',
    });
    // LLM: typed retryable failure only.
    await expect(llm.classify('combined outage content')).rejects.toMatchObject({
      code: 'MODERATION_PROVIDER_UNAVAILABLE',
    });

    // The transactional write path is untouched: a registration (wave-2's stand-in for the
    // wave-3 booking commit) succeeds, and new public content is born 'pending'.
    const app = createApp({ logger: quiet });
    const email = `rt01.combined.${Date.now()}@resilience.homeplate.invalid`;
    const res = await request(app).post('/api/auth/register').send({ email, password: PASSWORD });
    expect(res.status).toBe(201);

    const listing = await dbh.makeListing({});
    expect(listing.moderation_status).toBe('pending');

    llmMock.reset();
  }, 20000);
});
