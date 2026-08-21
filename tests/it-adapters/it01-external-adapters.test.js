// tests/it-adapters/it01-external-adapters.test.js — IT-01 (SRS §4.2): every external
// adapter (Google Maps/Places, SendGrid, FCM, moderation LLM) exercised against its
// sandbox/mock endpoint for the HAPPY path and against injected failures for the DEGRADED
// path (NFR-09). Per ADR-007/ADR-011 the automated suite never calls a live provider:
// "sandbox" here is the deterministic mock adapter (LLM, transport) or an injected
// fetchImpl playing the provider (Maps, LLM live shape) — the sanctioned CI pattern.
//
// Requirement traceability (SRS Appendix B):
//   NFR-09 (RT-01 subset) — timeout / bounded retries / exponential backoff / documented
//        fallback on each adapter; injected outages resolve to typed errors or failed
//        rows, never unhandled rejections
//   FR-13/FR-14/FR-07 substrate — transport.send persists NOTIFICATION_ATTEMPT rows
//        (ADR-011: assertions on rows, never on a third party)
//   ADR-005/ADR-010 — Maps results cached in Redis at PUBLIC precision only
//   ADR-007 — provider-agnostic LLM adapter; mock resolved under NODE_ENV=test
//   ADR-011 — FCM refused while notifications.push.enabled=false (default)
'use strict';

// Fast resilience knobs for THIS FILE ONLY (Jest runs files sequentially in one worker;
// restored in afterAll so sibling files see the defaults again).
process.env.ADAPTER_TIMEOUT_MS = '250';
process.env.ADAPTER_RETRY_MAX = '2';
process.env.ADAPTER_BACKOFF_BASE_MS = '10';

const crypto = require('crypto');

const config = require('../../src/config');
const { createMapsAdapter } = require('../../src/adapters/maps');
const { coarsen } = require('../../src/lib/geoPrecision');
const llm = require('../../src/adapters/llmModeration');
const llmMock = require('../../src/adapters/llmModeration.mock');
const mockTransport = require('../../src/adapters/mockTransport');
const sendgrid = require('../../src/adapters/sendgrid');
const fcm = require('../../src/adapters/fcm');
const transport = require('../../src/modules/notifications/transport');
const notifRepo = require('../../src/modules/notifications/repo');
const { NotFoundError, ServiceUnavailableError, InternalError } = require('../../src/lib/errors');
const dbh = require('../helpers/db');
const { redis, flushNamespace, closeTestRedis } = require('../helpers/redis');

const RETRIES = 2; // must mirror ADAPTER_RETRY_MAX above
const ATTEMPTS = RETRIES + 1;

let user;

beforeAll(async () => {
  expect(config.isTest).toBe(true); // ADR-007/ADR-011: mock adapters only in the suite
  user = await dbh.makeUser();
});

beforeEach(async () => {
  mockTransport.reset();
  llmMock.reset();
});

afterAll(async () => {
  delete process.env.ADAPTER_TIMEOUT_MS;
  delete process.env.ADAPTER_RETRY_MAX;
  delete process.env.ADAPTER_BACKOFF_BASE_MS;
  llmMock.reset();
  mockTransport.reset();
  await flushNamespace('cache');
  await dbh.query(`DELETE FROM users WHERE email LIKE '%@dbunit.homeplate.invalid'`);
  await dbh.closeDb();
  await closeTestRedis();
});

// ---- provider-shaped fake fetch helpers ------------------------------------------------------

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify(body),
  };
}

/** Google Geocoding sandbox body: a street-level result with full address components. */
const GEOCODE_BODY = {
  status: 'OK',
  results: [
    {
      formatted_address: '4610 Cass St, San Diego, CA 92109, USA',
      address_components: [
        { long_name: '4610', types: ['street_number'] },
        { long_name: 'Cass Street', types: ['route'] },
        { long_name: 'Pacific Beach', types: ['neighborhood'] },
        { long_name: 'San Diego', types: ['locality'] },
        { long_name: 'California', types: ['administrative_area_level_1'] },
      ],
      geometry: { location: { lat: 32.798512, lng: -117.244123 } },
    },
  ],
};

const uniq = () => crypto.randomBytes(6).toString('hex');

// ==============================================================================================
describe('IT-01 · Google Maps/Places adapter (ADR-005, ADR-010, NFR-09)', () => {
  test('mock mode is the suite default and serves the full cache pipeline', async () => {
    expect(config.maps.mode).toBe('mock');
    const adapter = createMapsAdapter({ cacheTtlSeconds: 60 });
    const address = `1 Test Way, San Diego ${uniq()}`;
    const first = await adapter.geocode(address);
    expect(first.source).toBe('live');
    expect(first.degraded).toBe(false);
    expect(typeof first.lat).toBe('number');
    expect(typeof first.lng).toBe('number');
    expect(typeof first.areaLabel).toBe('string');
    const second = await adapter.geocode(address);
    expect(second.source).toBe('cache');
    expect(second.lat).toBe(first.lat);
    const areas = await adapter.searchArea(`la jolla ${uniq()}`);
    expect(Array.isArray(areas.areas)).toBe(true);
    expect(areas.areas.length).toBeGreaterThan(0);
  });

  test('happy path (live shape): one HTTP call, coarsened public result, zero HTTP on repeat', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(200, GEOCODE_BODY);
    };
    const adapter = createMapsAdapter({
      mode: 'live',
      apiKey: 'test-injected-key',
      cacheTtlSeconds: 60,
      fetchImpl,
    });
    const address = `4610 Cass St, San Diego it01-${uniq()}`;
    const result = await adapter.geocode(address);
    expect(calls).toBe(1);
    expect(result.source).toBe('live');
    // ADR-010: default result is the PUBLIC projection — grid-snapped, not provider-exact.
    const snapped = coarsen(32.798512, -117.244123, {});
    expect(result.lat).toBe(snapped.lat);
    expect(result.lng).toBe(snapped.lng);
    expect(result.lat).not.toBe(32.798512);
    // Area label is neighbourhood/city granularity — never the street.
    expect(result.areaLabel).toBe('Pacific Beach, San Diego');
    expect(result.areaLabel).not.toMatch(/cass|4610/i);
    // Repeat: served from Redis, zero additional HTTP (NFR-01/ADR-005).
    const again = await adapter.geocode(address);
    expect(calls).toBe(1);
    expect(again.source).toBe('cache');
    expect(again.lat).toBe(snapped.lat);
  });

  test("precision:'exact' returns precise coords via a forced live call and never caches them", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(200, GEOCODE_BODY);
    };
    const adapter = createMapsAdapter({
      mode: 'live',
      apiKey: 'test-injected-key',
      cacheTtlSeconds: 60,
      fetchImpl,
    });
    const address = `4610 Cass St exact-${uniq()}`;
    const exact = await adapter.geocode(address, { precision: 'exact' });
    expect(exact.precise).toEqual({ lat: 32.798512, lng: -117.244123 });
    // A second exact lookup calls the provider again — exact never reads the cache.
    await adapter.geocode(address, { precision: 'exact' });
    expect(calls).toBe(2);
  });

  test('ADR-010 audit: no hp:cache:maps:* key or value carries a street address or exact coordinates', async () => {
    // Runs after the tests above populated the cache with the street-level provider body.
    let cursor = '0';
    const keys = [];
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', 'hp:cache:maps:*', 'COUNT', 200);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).not.toMatch(/cass|4610/i); // keys are hashes, never raw input
      const raw = await redis.get(k);
      if (raw === null) continue;
      expect(raw).not.toMatch(/cass st|4610/i);
      expect(raw).not.toContain('32.798512');
      expect(raw).not.toContain('-117.244123');
      const value = JSON.parse(raw);
      const flat = JSON.stringify(value);
      // Values hold coarsened coords + labels only — assert every lat/lng is grid-snapped.
      const entries = value.areas ? value.areas : [value];
      for (const entry of entries) {
        if (typeof entry.lat === 'number') {
          const snapped = coarsen(entry.lat, entry.lng, {});
          expect(entry.lat).toBe(snapped.lat);
          expect(entry.lng).toBe(snapped.lng);
        }
      }
      expect(flat).not.toContain('precise');
    }
  });

  test('degraded path: provider outage serves the stale cached copy with degraded:true', async () => {
    let fail = false;
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (fail) throw new Error('ECONNREFUSED (injected outage)');
      return jsonResponse(200, GEOCODE_BODY);
    };
    const adapter = createMapsAdapter({
      mode: 'live',
      apiKey: 'test-injected-key',
      cacheTtlSeconds: 60,
      fetchImpl,
    });
    const address = `900 Degraded Ave ${uniq()}`;
    await adapter.geocode(address); // populate fresh + stale copies
    // Expire the FRESH entry only (simulates TTL passing) so the pipeline must go live.
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(
        cursor,
        'MATCH',
        'hp:cache:maps:geocode:*',
        'COUNT',
        200
      );
      cursor = next;
      for (const k of batch) if (!k.endsWith(':stale')) await redis.del(k);
    } while (cursor !== '0');
    fail = true;
    const callsBefore = calls;
    const degraded = await adapter.geocode(address);
    expect(degraded.degraded).toBe(true);
    expect(degraded.source).toBe('cache-degraded');
    expect(degraded.areaLabel).toBe('Pacific Beach, San Diego');
    // Bounded retries: exactly ATTEMPTS provider calls before falling back (NFR-09).
    expect(calls - callsBefore).toBe(ATTEMPTS);
  });

  test('degraded path: uncached lookup during an outage fails typed (MAPS_UNAVAILABLE), bounded retries', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error('ECONNREFUSED (injected outage)');
    };
    const adapter = createMapsAdapter({
      mode: 'live',
      apiKey: 'test-injected-key',
      cacheTtlSeconds: 60,
      fetchImpl,
    });
    const err = await adapter.geocode(`never seen before ${uniq()}`).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.code).toBe('MAPS_UNAVAILABLE');
    expect(calls).toBe(ATTEMPTS);
  });

  test('ZERO_RESULTS is a definitive answer (MAPS_NO_RESULTS), never retried or masked by fallback', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return jsonResponse(200, { status: 'ZERO_RESULTS', results: [] });
    };
    const adapter = createMapsAdapter({
      mode: 'live',
      apiKey: 'test-injected-key',
      cacheTtlSeconds: 60,
      fetchImpl,
    });
    const err = await adapter.geocode(`nowhere at all ${uniq()}`).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.code).toBe('MAPS_NO_RESULTS');
    expect(calls).toBe(1);
  });
});

// ==============================================================================================
describe('IT-01 · SendGrid email channel through the transport (ADR-011, NFR-09, FR-07 substrate)', () => {
  test('happy path: mock transport delivers and persists a sent NOTIFICATION_ATTEMPT row', async () => {
    const key = `it01-email-happy-${uniq()}`;
    const result = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'booking-created',
      params: { bookingId: '00000000-0000-4000-8000-000000000001' },
      idempotencyKey: key,
    });
    expect(result.status).toBe('sent');
    const row = await notifRepo.findByIdempotencyKey(key);
    expect(row.status).toBe('sent');
    expect(row.channel).toBe('email');
    expect(row.recipient_user_id).toBe(user.id);
    expect(row.attempt_count).toBe(1);
    expect(mockTransport.deliveries()).toHaveLength(1);
  });

  test('retry path: one injected failure, then success — attempt_count 2, final status sent', async () => {
    const key = `it01-email-retry-${uniq()}`;
    mockTransport.injectFailures(1);
    const result = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'booking-confirmed',
      idempotencyKey: key,
    });
    expect(result.status).toBe('sent');
    const row = await notifRepo.findByIdempotencyKey(key);
    expect(row.status).toBe('sent');
    expect(row.attempt_count).toBe(2);
    expect(mockTransport.deliveries()).toHaveLength(1);
  });

  test('degraded path: full provider outage resolves to a failed ROW after bounded retries, never a throw', async () => {
    const key = `it01-email-outage-${uniq()}`;
    mockTransport.injectFailures(ATTEMPTS + 2); // more failures than the retry budget
    const result = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'booking-cancelled',
      idempotencyKey: key,
    });
    expect(result.status).toBe('failed');
    const row = await notifRepo.findByIdempotencyKey(key);
    expect(row.status).toBe('failed');
    expect(row.attempt_count).toBe(ATTEMPTS);
    expect(row.last_error).toBeTruthy();
    expect(mockTransport.deliveries()).toHaveLength(0);
  });

  test('degraded path: a hung provider is cut off by the per-attempt timeout (NFR-09)', async () => {
    const key = `it01-email-hang-${uniq()}`;
    mockTransport.injectHangs(ATTEMPTS);
    const started = Date.now();
    const result = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'booking-status-changed',
      idempotencyKey: key,
    });
    expect(result.status).toBe('failed');
    // 3 attempts x 250 ms timeout + backoff — must finish well under the Jest timeout.
    expect(Date.now() - started).toBeLessThan(5000);
    const row = await notifRepo.findByIdempotencyKey(key);
    expect(row.status).toBe('failed');
  });

  test('duplicate idempotencyKey reuses the sent row and does not double-send', async () => {
    const key = `it01-email-idem-${uniq()}`;
    await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'booking-created',
      idempotencyKey: key,
    });
    const second = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'booking-created',
      idempotencyKey: key,
    });
    expect(second.deduped).toBe(true);
    expect(mockTransport.deliveries()).toHaveLength(1);
  });

  test('live SendGrid adapter fails closed without configuration (never retried)', async () => {
    expect(config.notifications.sendgridApiKey ?? null).toBeFalsy();
    const err = await sendgrid.adapter
      .deliver({ recipientEmail: 'x@example.test', template: 'booking-created', params: {} })
      .catch((e) => e);
    expect(err).toBeInstanceOf(InternalError);
    expect(err.code).toBe('SENDGRID_NOT_CONFIGURED');
    expect(err.retryable).toBe(false);
  });

  test('FR-07 substrate: safety-alert email templates are registered for wave 4', () => {
    expect(sendgrid.EMAIL_SUBJECTS['safety-alert-emergency']).toBeTruthy();
    expect(sendgrid.EMAIL_SUBJECTS['safety-alert-moderator']).toBeTruthy();
    const rendered = sendgrid.renderEmail('safety-alert-emergency', { alertId: 'abc' });
    expect(rendered.subject).toMatch(/safety alert/i);
  });
});

// ==============================================================================================
describe('IT-01 · FCM push adapter gate (ADR-011: notifications.push.enabled default FALSE)', () => {
  test('config default: push disabled in the suite', () => {
    expect(config.notifications.push.enabled).toBe(false);
  });

  test('a push send is REFUSED and recorded as a failed row — nothing is delivered', async () => {
    const key = `it01-push-refused-${uniq()}`;
    const result = await transport.send({
      userId: user.id,
      channel: 'push',
      template: 'booking-created',
      idempotencyKey: key,
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('push_disabled');
    const row = await notifRepo.findByIdempotencyKey(key);
    expect(row.status).toBe('failed');
    expect(row.channel).toBe('push');
    expect(row.last_error).toMatch(/push\.enabled=false/);
    expect(mockTransport.deliveries()).toHaveLength(0);
  });

  test('defence in depth: the FCM adapter itself refuses while the gate is off', async () => {
    const err = await fcm.adapter
      .deliver({ userId: user.id, template: 'booking-created', params: {} })
      .catch((e) => e);
    expect(err.code).toBe('PUSH_DISABLED');
    expect(err.retryable).toBe(false);
  });
});

// ==============================================================================================
describe('IT-01 · moderation LLM adapter (ADR-007, NFR-09, ADR-002 substrate)', () => {
  test('NODE_ENV=test resolves the deterministic mock (ADR-007: mock in the automated suite)', () => {
    expect(config.moderation.mode).toBe('mock');
    expect(llm.mode).toBe('mock');
    expect(llm.model).toBe('mock-moderation-deterministic-v1');
  });

  test('happy path: deterministic {category, confidence, model} for every taxonomy category', async () => {
    const cases = [
      ['you are an idiot', 'offensive'],
      ['click here for free money', 'spam'],
      ['send me a wire transfer to hold your seat', 'fraudulent'],
      ['Homemade tamales, 6 seats, Saturday evening', 'benign'],
    ];
    for (const [text, category] of cases) {
      const a = await llm.classify(text);
      const b = await llm.classify(text);
      expect(a.category).toBe(category);
      expect(a).toEqual(b); // deterministic (ADR-007)
      expect(llm.CATEGORIES).toContain(a.category);
      expect(a.confidence).toBeGreaterThanOrEqual(0);
      expect(a.confidence).toBeLessThanOrEqual(1);
      expect(a.model).toBe('mock-moderation-deterministic-v1');
    }
  });

  test('degraded path: forced outage raises the typed retryable ModerationProviderError', async () => {
    llmMock.setOutage(true);
    const err = await llm.classify('any content').catch((e) => e);
    expect(err).toBeInstanceOf(llm.ModerationProviderError);
    expect(err.code).toBe('MODERATION_PROVIDER_UNAVAILABLE');
    expect(err.retryable).toBe(true); // ADR-002: worker retries, content stays pending
    llmMock.reset();
    await expect(llm.classify('any content')).resolves.toMatchObject({ category: 'benign' });
  });

  test('live shape happy path: provider-family response parsed, no provider facts hardcoded', async () => {
    const seen = { urls: [], bodies: [] };
    const fetchImpl = async (url, opts) => {
      seen.urls.push(url);
      seen.bodies.push(JSON.parse(opts.body));
      return jsonResponse(200, {
        candidates: [
          {
            content: {
              parts: [{ text: '```json\n{"category":"spam","confidence":0.92}\n```' }],
            },
          },
        ],
      });
    };
    const adapter = llm.createLiveLlmModerationAdapter({
      baseUrl: 'https://llm.sandbox.invalid',
      apiKey: 'test-injected-key',
      model: 'test-model-id',
      timeoutMs: 250,
      retries: RETRIES,
      backoff: { baseMs: 5 },
      fetchImpl,
    });
    const result = await adapter.classify('buy now buy now buy now');
    expect(result).toEqual({ category: 'spam', confidence: 0.92, model: 'test-model-id' });
    // Connection facts come from configuration/injection ONLY (ADR-007).
    expect(seen.urls[0]).toContain('https://llm.sandbox.invalid');
    expect(seen.urls[0]).toContain('test-model-id');
    expect(seen.urls[0]).toContain('key=test-injected-key');
    // The content travels inside the safety-policy prompt.
    expect(JSON.stringify(seen.bodies[0])).toContain('buy now buy now buy now');
  });

  test('live degraded: 5xx retries to the bound then surfaces retryable; 401 is permanent, one call', async () => {
    let calls500 = 0;
    const failing = llm.createLiveLlmModerationAdapter({
      baseUrl: 'https://llm.sandbox.invalid',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 250,
      retries: RETRIES,
      backoff: { baseMs: 5 },
      fetchImpl: async () => {
        calls500 += 1;
        return jsonResponse(503, { error: 'unavailable' });
      },
    });
    const err5xx = await failing.classify('text').catch((e) => e);
    expect(err5xx).toBeInstanceOf(llm.ModerationProviderError);
    expect(err5xx.retryable).toBe(true);
    expect(calls500).toBe(ATTEMPTS);

    let calls401 = 0;
    const rejected = llm.createLiveLlmModerationAdapter({
      baseUrl: 'https://llm.sandbox.invalid',
      apiKey: 'bad-key',
      model: 'm',
      timeoutMs: 250,
      retries: RETRIES,
      backoff: { baseMs: 5 },
      fetchImpl: async () => {
        calls401 += 1;
        return jsonResponse(401, { error: 'unauthorized' });
      },
    });
    const err401 = await rejected.classify('text').catch((e) => e);
    expect(err401).toBeInstanceOf(llm.ModerationProviderError);
    expect(err401.retryable).toBe(false); // dead-letters instead of spinning (NFR-09)
    expect(calls401).toBe(1);
  });

  test('live degraded: unusable provider output surfaces retryable — content can never publish on garbage', async () => {
    const garbage = llm.createLiveLlmModerationAdapter({
      baseUrl: 'https://llm.sandbox.invalid',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 250,
      retries: RETRIES,
      backoff: { baseMs: 5 },
      fetchImpl: async () =>
        jsonResponse(200, {
          candidates: [{ content: { parts: [{ text: 'I cannot classify that, sorry!' }] } }],
        }),
    });
    const err = await garbage.classify('text').catch((e) => e);
    expect(err).toBeInstanceOf(llm.ModerationProviderError);
    expect(err.retryable).toBe(true); // ADR-002: pending, never published unreviewed
  });
});

// ==============================================================================================
describe('IT-F3 / W3-ADR-01 re-verification · no object-storage adapter on the request path', () => {
  // Moved from it-w3rv-reverify.test.js (verification round 2). ORIGINAL failureScenario:
  // "POST /api/media → mediaService.attach() → getStorage() at src/modules/media/service.js:45
  // does require('../../adapters/objectStorage') on the request path. src/adapters/
  // objectStorage.js:220 builds `const defaultAdapter = createObjectStorage()` at module load,
  // so the first media attach in a fresh process constructs an S3Client (endpoint + credentials)
  // inside a request handler." (FR-02 / NFR-12, ADR-001.)
  //
  // The ADR lane's static scan deliberately exempts CALL-TIME requires inside worker-only
  // functions, and tests/unit/hosts-media.test.js pins only the /api/media/uploads mint route —
  // so attach()'s own load behaviour is pinned HERE and nowhere else. This test also lives in
  // THIS file on purpose: it needs a module registry that has never loaded
  // src/adapters/objectStorage, and it01c-adapter-depth requires that adapter top-level for its
  // MinIO sandbox tests.
  test('attach() rejects a bad key WITHOUT loading src/adapters/objectStorage into the registry', async () => {
    const adapterPath = require.resolve('../../src/adapters/objectStorage');
    // Baseline: the adapters THIS test file's own top-level imports already pulled in (the mock
    // transport and, through it, sendgrid/fcm/maps). The claim under test is that loading and
    // calling the media service adds NOTHING to that set — objectStorage above all.
    const adaptersBefore = Object.keys(require.cache)
      .filter((f) => f.includes('/src/adapters/'))
      .sort();
    expect(adaptersBefore).not.toContain(adapterPath);
    let loadedAdapters;
    let attachPromise;
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      const mediaService = require('../../src/modules/media/service');
      // attach() is async, so the rejection is captured, not thrown; the module-loading
      // snapshot below is taken while the isolated registry is still the live one.
      attachPromise = mediaService
        .attach('00000000-0000-4000-8000-000000000001', '../escape', 'listing')
        .then(
          () => null,
          (err) => err
        );
      loadedAdapters = Object.keys(require.cache)
        .filter((f) => f.includes('/src/adapters/'))
        .sort();
      expect(require.cache[adapterPath]).toBeUndefined();
    });
    // The pure validator still enforces the rule — the behaviour was preserved, not deleted.
    const thrown = await attachPromise;
    expect(thrown).toBeTruthy();
    expect(thrown.code || thrown.name).toMatch(/INVALID_STORAGE_KEY|ValidationError/);
    expect(loadedAdapters).toEqual(adaptersBefore);
    expect(loadedAdapters).not.toContain(adapterPath);
    jest.resetModules();
  });
});
