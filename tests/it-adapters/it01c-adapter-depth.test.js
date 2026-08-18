// tests/it-adapters/it01c-adapter-depth.test.js — IT-01..IT-04 verification depth pass
// (SRS §4.2). Adds the adapter surfaces the existing IT-01 files do NOT reach, and records
// executable evidence for the IT-03 / IT-04 readiness questions:
//
//   IT-01 · Google PLACES Text Search (maps.searchArea) LIVE shape — happy path, cache,
//           ADR-010 street-level safety, and the injected-outage degraded path. The existing
//           it01-external-adapters.test.js exercises the live shape of GEOCODE only; the
//           Places branch (liveSearchArea / areaLabelFromPlace) had no live-shape coverage,
//           and it is the branch the FR-01 location search actually calls in production.
//   IT-01 · Object storage adapter against the REAL MinIO sandbox (ADR-004, NFR-09) — the
//           only adapter in the NFR-09 list with a genuine local sandbox endpoint; happy
//           round trip, definitive 404, idempotent delete, injected outage bounded by the
//           retry budget, hung backend bounded by the per-attempt timeout.
//   IT-01 · booking.promote IT3-F1 depth — a SECOND consecutive early delivery must still
//           leave exactly one live promote row (the first fix could have been single-shot).
//   IT-03 · NFR-10 measurement readiness — executable proof that no measurement can be
//           claimed today: the ADR-008 versioned eval set now exists but its labels are
//           unreviewed, there is no results file with a human sign-off, no deterministic
//           pre-filter and no moderation.scan handler, and the ADR-007 MOCK classifier is
//           demonstrably no substitute for the measured pipeline.
//   IT-04 · FR-07 delivery-leg substrate — the alert row, both email templates and the
//           retry/dead-letter behaviour of the emergency-contact + moderator notifications
//           are exercised through the ADR-011 MOCK transport (NOTIFICATION_ATTEMPT rows),
//           with the still-missing service layer asserted as absent rather than assumed.
//
// Requirement traceability (SRS Appendix B):
//   FR-01  (TC-01, LT-01)  — Places area lookup feeding location search
//   FR-07  (TC-07, IT-04)  — safety-alert persistence + emergency-contact email delivery
//   FR-08  (TC-08, IT-03)  — moderation LLM stage
//   FR-04/FR-12 (TC-12)    — scheduled booking promotion
//   NFR-09 (RT-01)         — timeout / bounded retries / backoff / documented fallback
//   NFR-10 (IT-03)         — moderation FP/FN < 5 % — NOT measurable in this tree
//   NFR-12 (ST-05)         — per-object media deletion primitive
//   NFR-13 (ST-06)         — emergency-contact PII encrypted at rest
//   ADR-004/005/007/010/011
'use strict';

// Fast resilience knobs for THIS FILE ONLY (Jest module registry is per-file; restored below).
process.env.ADAPTER_TIMEOUT_MS = '250';
process.env.ADAPTER_RETRY_MAX = '2';
process.env.ADAPTER_BACKOFF_BASE_MS = '10';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('../../src/config');
const { createMapsAdapter } = require('../../src/adapters/maps');
const { coarsen } = require('../../src/lib/geoPrecision');
const objectStorage = require('../../src/adapters/objectStorage');
const llm = require('../../src/adapters/llmModeration');
const llmMock = require('../../src/adapters/llmModeration.mock');
const mockTransport = require('../../src/adapters/mockTransport');
const sendgrid = require('../../src/adapters/sendgrid');
const transport = require('../../src/modules/notifications/transport');
const notifRepo = require('../../src/modules/notifications/repo');
const { loadHandlers } = require('../../src/outbox/dispatch');
const { pollOnce } = require('../../src/outbox/worker');
const bookingsService = require('../../src/modules/bookings/service');
const { NotFoundError, ServiceUnavailableError } = require('../../src/lib/errors');
const dbh = require('../helpers/db');
const { redis, flushNamespace, closeTestRedis } = require('../helpers/redis');

const RETRIES = 2; // mirrors ADAPTER_RETRY_MAX above
const ATTEMPTS = RETRIES + 1;
const REPO_ROOT = path.join(__dirname, '..', '..');

const quietLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() {
    return this;
  },
};

const uniq = () => crypto.randomBytes(6).toString('hex');

let registry;

beforeAll(async () => {
  expect(config.isTest).toBe(true); // ADR-007/ADR-011: mock adapters only in the suite
  registry = loadHandlers({ log: quietLog });
});

beforeEach(() => {
  mockTransport.reset();
  llmMock.reset();
});

afterAll(async () => {
  delete process.env.ADAPTER_TIMEOUT_MS;
  delete process.env.ADAPTER_RETRY_MAX;
  delete process.env.ADAPTER_BACKOFF_BASE_MS;
  mockTransport.reset();
  llmMock.reset();
  await flushNamespace('cache');
  await dbh.query(`DELETE FROM users WHERE email LIKE '%@dbunit.homeplate.invalid'`);
  await dbh.closeDb();
  await closeTestRedis();
});

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify(body),
  };
}

// Mock registrations stay LIVE until the test finishes: both adapters require their provider
// SDK lazily, inside deliver(), so un-mocking at load time would let the real @sendgrid/mail
// or firebase-admin resolve at call time — i.e. a live provider call from the suite. Cleared
// by the owning describe's afterEach.
const pendingMockNames = new Set();

function releaseIsolatedMocks() {
  for (const name of pendingMockNames) jest.dontMock(name);
  pendingMockNames.clear();
  // dontMock removes the FACTORY but leaves the already-built fake in the registry cache, so
  // the next test's lazily-required SDK would silently be the previous test's fake. Reset the
  // registry too; every module this file uses is already held by reference at the top.
  jest.resetModules();
}

/**
 * Loads a module tree in an ISOLATED jest registry with `env` applied and the named provider
 * SDKs replaced by fakes, then restores the ambient environment. The returned module keeps
 * working after the registry is torn down, so the caller can await its async surface.
 *
 * This is how the LIVE SendGrid / FCM delivery bodies get executed without a real provider and
 * without disturbing the shared config the rest of the suite asserts on (ADR-011: the ambient
 * process stays transport=mock, push disabled — re-asserted at the end of each such test).
 */
function loadIsolated({ env = {}, mocks = {}, modulePath }) {
  releaseIsolatedMocks(); // never inherit a previous load's cached fake
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  // doMock must be registered BEFORE isolateModules opens the fresh registry, otherwise the
  // real SDK is required and the "test" would call a live provider (ADR-011 violation).
  for (const [name, factory] of Object.entries(mocks)) {
    jest.doMock(name, factory);
    pendingMockNames.add(name);
  }
  let loaded;
  try {
    jest.isolateModules(() => {
      // Hard guard: if the fake is not in place, abort before the adapter can reach the network.
      for (const name of Object.keys(mocks)) {
        // eslint-disable-next-line global-require
        if (require(name).__fake !== true) {
          throw new Error(
            `loadIsolated: ${name} is not mocked — refusing to touch a live provider`
          );
        }
      }
      loaded = require(modulePath);
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return loaded;
}

// ==============================================================================================
describe('IT-01 · Google Places Text Search live shape (ADR-005, ADR-010, NFR-09)', () => {
  // A neighbourhood-level Places body plus a STREET-LEVEL one, the shape that would leak a
  // host address through the area label if areaLabelFromPlace were wrong.
  const PLACES_BODY = {
    status: 'OK',
    results: [
      {
        name: 'La Jolla',
        types: ['neighborhood', 'political'],
        geometry: { location: { lat: 32.84702, lng: -117.274513 } },
      },
      {
        name: 'Pacific Beach',
        types: ['neighborhood', 'political'],
        geometry: { location: { lat: 32.798512, lng: -117.244123 } },
      },
    ],
  };

  const STREET_LEVEL_BODY = {
    status: 'OK',
    results: [
      {
        name: '4610 Cass St',
        types: ['street_address'],
        plus_code: { compound_code: 'RQ4C+2X San Diego, CA, USA' },
        geometry: { location: { lat: 32.798512, lng: -117.244123 } },
      },
    ],
  };

  function liveAdapter(fetchImpl) {
    return createMapsAdapter({
      mode: 'live',
      apiKey: 'test-injected-key',
      cacheTtlSeconds: 60,
      fetchImpl,
    });
  }

  test('happy path: Places results become PUBLIC-precision areas; repeat query = zero HTTP', async () => {
    let calls = 0;
    const adapter = liveAdapter(async (url) => {
      calls += 1;
      expect(String(url)).toContain('/place/textsearch/json');
      return jsonResponse(200, PLACES_BODY);
    });
    const query = `la jolla places-${uniq()}`;
    const first = await adapter.searchArea(query);
    expect(calls).toBe(1);
    expect(first.source).toBe('live');
    expect(first.degraded).toBe(false);
    expect(first.areas).toHaveLength(2);
    // ADR-010: every returned coordinate is the coarsened grid point, never the provider's.
    for (const area of first.areas) {
      const snapped = coarsen(area.lat, area.lng, {});
      expect(area.lat).toBe(snapped.lat);
      expect(area.lng).toBe(snapped.lng);
    }
    expect(first.areas[0].lat).not.toBe(32.84702);
    expect(first.areas.map((a) => a.areaLabel)).toEqual(['La Jolla', 'Pacific Beach']);

    const again = await adapter.searchArea(query);
    expect(calls).toBe(1); // served from Redis (ADR-005 cache)
    expect(again.source).toBe('cache');
    expect(again.areas).toEqual(first.areas);
  });

  test('ADR-010: a STREET-LEVEL Places hit never yields a street label or exact coords, in the result or in Redis', async () => {
    const adapter = liveAdapter(async () => jsonResponse(200, STREET_LEVEL_BODY));
    const query = `4610 cass st places-${uniq()}`;
    const result = await adapter.searchArea(query);
    expect(result.areas).toHaveLength(1);
    const [area] = result.areas;
    expect(area.areaLabel).not.toMatch(/cass|4610/i);
    expect(area.areaLabel).toBe('San Diego, CA, USA'); // plus_code city tail, not the street
    expect(area.lat).not.toBe(32.798512);
    expect(area.lng).not.toBe(-117.244123);

    // Audit every maps search key written by this test: no street text, no exact coordinates.
    let cursor = '0';
    const keys = [];
    do {
      const [next, batch] = await redis.scan(
        cursor,
        'MATCH',
        'hp:cache:maps:search:*',
        'COUNT',
        300
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    expect(keys.length).toBeGreaterThan(0);
    let audited = 0;
    for (const key of keys) {
      const raw = await redis.get(key);
      if (raw === null) continue;
      audited += 1;
      expect(raw).not.toMatch(/cass|4610/i);
      expect(raw).not.toContain('32.798512');
      expect(raw).not.toContain('-117.244123');
      expect(raw).not.toContain('precise');
      for (const entry of JSON.parse(raw).areas ?? []) {
        const snapped = coarsen(entry.lat, entry.lng, {});
        expect(entry.lat).toBe(snapped.lat);
        expect(entry.lng).toBe(snapped.lng);
      }
    }
    expect(audited).toBeGreaterThan(0);
  });

  test('degraded path: outage serves the stale cached areas with degraded:true after bounded retries', async () => {
    let fail = false;
    let calls = 0;
    const adapter = liveAdapter(async () => {
      calls += 1;
      if (fail) throw new Error('ECONNREFUSED (injected Places outage)');
      return jsonResponse(200, PLACES_BODY);
    });
    const query = `degraded places ${uniq()}`;
    await adapter.searchArea(query); // populates fresh + stale

    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(
        cursor,
        'MATCH',
        'hp:cache:maps:search:*',
        'COUNT',
        300
      );
      cursor = next;
      for (const key of batch) if (!key.endsWith(':stale')) await redis.del(key);
    } while (cursor !== '0');

    fail = true;
    const before = calls;
    const degraded = await adapter.searchArea(query);
    expect(degraded.degraded).toBe(true);
    expect(degraded.source).toBe('cache-degraded');
    expect(degraded.areas).toHaveLength(2);
    expect(calls - before).toBe(ATTEMPTS); // NFR-09: bounded retries before the fallback
  });

  test('degraded path: uncached outage is a typed 503 MAPS_UNAVAILABLE, bounded, never a bare throw', async () => {
    let calls = 0;
    const adapter = liveAdapter(async () => {
      calls += 1;
      throw new Error('ECONNREFUSED (injected Places outage)');
    });
    const err = await adapter.searchArea(`nothing cached ${uniq()}`).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.code).toBe('MAPS_UNAVAILABLE');
    expect(err.status ?? err.statusCode).toBe(503);
    expect(calls).toBe(ATTEMPTS);
  });

  test('ZERO_RESULTS is a real (negatively cached) search answer, not an outage', async () => {
    let calls = 0;
    const adapter = liveAdapter(async () => {
      calls += 1;
      return jsonResponse(200, { status: 'ZERO_RESULTS', results: [] });
    });
    const query = `atlantis ${uniq()}`;
    const first = await adapter.searchArea(query);
    expect(first.areas).toEqual([]);
    expect(first.degraded).toBe(false);
    const second = await adapter.searchArea(query);
    expect(second.source).toBe('cache');
    expect(calls).toBe(1); // negative answer cached — no repeat provider call
  });

  test('REQUEST_DENIED (bad key) is permanent: exactly one provider call, no retry storm', async () => {
    let calls = 0;
    const adapter = liveAdapter(async () => {
      calls += 1;
      return jsonResponse(200, { status: 'REQUEST_DENIED', error_message: 'bad key' });
    });
    const err = await adapter.searchArea(`denied ${uniq()}`).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.code).toBe('MAPS_UNAVAILABLE'); // masked by the documented NFR-09 fallback
    expect(err.cause && err.cause.code).toBe('MAPS_REQUEST_REJECTED');
    expect(err.cause.retryable).toBe(false);
    expect(calls).toBe(1);
  });
});

// ==============================================================================================
describe('IT-01 · LIVE SendGrid and FCM delivery bodies (ADR-011) — executed against fake SDKs', () => {
  // The suite always routes notifications through the ADR-011 mock transport, so
  // sendgrid.adapter.deliver / fcm.adapter.deliver — the code that actually runs in
  // production — were reachable only through their "not configured" guards. These tests load
  // each adapter in an isolated registry with the provider SDK faked, so the send body and
  // the error-mapping branch are executed. Nothing leaves the process.

  afterEach(() => releaseIsolatedMocks());

  test('SendGrid happy path: renders the template, sends from the configured address, returns the message id', async () => {
    const sent = [];
    const sg = loadIsolated({
      env: { SENDGRID_API_KEY: 'SG.test-injected', SENDGRID_FROM_EMAIL: 'no-reply@homeplate.test' },
      mocks: {
        '@sendgrid/mail': () => ({
          __fake: true,
          setApiKey: () => {},
          send: async (msg) => {
            sent.push(msg);
            return [{ headers: { 'x-message-id': 'msg-it01c-1' } }];
          },
        }),
      },
      modulePath: '../../src/adapters/sendgrid',
    });
    const result = await sg.adapter.deliver({
      userId: '00000000-0000-4000-8000-000000000001',
      recipientEmail: 'guest@example.test',
      template: 'safety-alert-emergency',
      params: { alertId: 'alert-123' },
    });
    expect(result).toEqual({ providerMessageId: 'msg-it01c-1' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('guest@example.test');
    expect(sent[0].from).toBe('no-reply@homeplate.test');
    expect(sent[0].subject).toMatch(/safety alert/i);
    expect(sent[0].text).toContain('alert-123');
    // ADR-011 isolation held: the ambient suite process is still on the mock transport.
    expect(config.notifications.transport ?? 'mock').toBe('mock');
  });

  test('SendGrid degraded path: 5xx maps to a RETRYABLE upstream error, 400 to a permanent one, never leaking the address', async () => {
    const build = (code) =>
      loadIsolated({
        env: {
          SENDGRID_API_KEY: 'SG.test-injected',
          SENDGRID_FROM_EMAIL: 'no-reply@homeplate.test',
        },
        mocks: {
          '@sendgrid/mail': () => ({
            __fake: true,
            setApiKey: () => {},
            send: async () => {
              const err = new Error('sendgrid failure');
              err.code = code;
              throw err;
            },
          }),
        },
        modulePath: '../../src/adapters/sendgrid',
      });

    const transient = await build(503)
      .adapter.deliver({
        recipientEmail: 'guest@example.test',
        template: 'booking-created',
        params: {},
      })
      .catch((e) => e);
    expect(transient.retryable).toBe(true);
    expect(transient.message).not.toContain('guest@example.test'); // NFR-08 PII register

    const permanent = await build(400)
      .adapter.deliver({
        recipientEmail: 'guest@example.test',
        template: 'booking-created',
        params: {},
      })
      .catch((e) => e);
    expect(permanent.retryable).toBe(false);
    expect(permanent.message).not.toContain('guest@example.test');
  });

  test('SendGrid: a delivery with no resolved recipient is a permanent configuration fault, not a retry', async () => {
    const sg = loadIsolated({
      env: { SENDGRID_API_KEY: 'SG.test-injected', SENDGRID_FROM_EMAIL: 'no-reply@homeplate.test' },
      mocks: {
        '@sendgrid/mail': () => ({ __fake: true, setApiKey: () => {}, send: async () => [{}] }),
      },
      modulePath: '../../src/adapters/sendgrid',
    });
    const err = await sg.adapter
      .deliver({ recipientEmail: null, template: 'booking-created', params: {} })
      .catch((e) => e);
    expect(err.code).toBe('SENDGRID_NO_RECIPIENT');
    expect(err.retryable).toBe(false);
  });

  test('FCM (gate opened only inside the isolated registry): addresses the per-user topic with IDs only', async () => {
    const sends = [];
    const fcmIsolated = loadIsolated({
      env: {
        NOTIFICATIONS_PUSH_ENABLED: 'true',
        FCM_SERVICE_ACCOUNT_JSON: '{"project_id":"homeplate-test"}',
      },
      mocks: {
        'firebase-admin': () => ({
          __fake: true,
          credential: { cert: () => ({}) },
          initializeApp: () => ({}),
          messaging: () => ({
            send: async (message) => {
              sends.push(message);
              return 'projects/homeplate-test/messages/1';
            },
          }),
        }),
      },
      modulePath: '../../src/adapters/fcm',
    });
    const userId = '00000000-0000-4000-8000-0000000000ab';
    const result = await fcmIsolated.adapter.deliver({
      userId,
      template: 'booking-created',
      params: { bookingId: 'b-1' },
    });
    expect(result.providerMessageId).toBe('projects/homeplate-test/messages/1');
    expect(sends[0].topic).toBe(`user-${userId}`);
    expect(sends[0].data.template).toBe('booking-created');
    expect(JSON.parse(sends[0].data.params)).toEqual({ bookingId: 'b-1' }); // IDs only (ADR-003)
    // ADR-011: the ambient suite process still has push OFF — the gate was never opened here.
    expect(config.notifications.push.enabled).toBe(false);
    expect(process.env.NOTIFICATIONS_PUSH_ENABLED).toBe('false');
  });

  test('FCM degraded path: transient FCM codes retry, everything else is permanent', async () => {
    const build = (code) =>
      loadIsolated({
        env: {
          NOTIFICATIONS_PUSH_ENABLED: 'true',
          FCM_SERVICE_ACCOUNT_JSON: '{"project_id":"homeplate-test"}',
        },
        mocks: {
          'firebase-admin': () => ({
            __fake: true,
            credential: { cert: () => ({}) },
            initializeApp: () => ({}),
            messaging: () => ({
              send: async () => {
                const err = new Error('fcm failure');
                err.code = code;
                throw err;
              },
            }),
          }),
        },
        modulePath: '../../src/adapters/fcm',
      });
    const payload = { userId: '00000000-0000-4000-8000-0000000000ab', template: 't', params: {} };

    const transient = await build('messaging/server-unavailable')
      .adapter.deliver(payload)
      .catch((e) => e);
    expect(transient.retryable).toBe(true);

    const permanent = await build('messaging/invalid-argument')
      .adapter.deliver(payload)
      .catch((e) => e);
    expect(permanent.retryable).toBe(false);
    expect(config.notifications.push.enabled).toBe(false);
  });
});

// ==============================================================================================
describe('IT-01 · object storage adapter against the MinIO sandbox (ADR-004, NFR-09, NFR-12)', () => {
  const key = () => `listing/00000000-0000-4000-8000-00000000000${1}/it01c-${uniq()}.bin`;

  test('happy path (real sandbox endpoint): put → get round trip through the configured bucket', async () => {
    const store = objectStorage.createObjectStorage({ retries: RETRIES, timeoutMs: 4000 });
    try {
      const k = key();
      const body = Buffer.from(`homeplate it01c ${uniq()}`);
      const put = await store.put(k, body, { contentType: 'application/octet-stream' });
      expect(put.key).toBe(k);
      expect(put.sizeBytes).toBe(body.length);
      const got = await store.get(k);
      expect(got.body.equals(body)).toBe(true);
      expect(got.contentType).toBe('application/octet-stream');
      await store.deleteByKey(k);
    } finally {
      store.destroy();
    }
  });

  test('NFR-12 primitive: per-object delete removes exactly that key; re-delete is idempotent; get 404s', async () => {
    const store = objectStorage.createObjectStorage({ retries: RETRIES, timeoutMs: 4000 });
    try {
      const doomed = key();
      const survivor = key();
      await store.put(doomed, Buffer.from('doomed'));
      await store.put(survivor, Buffer.from('survivor'));
      await store.deleteByKey(doomed);
      const err = await store.get(doomed).catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err.code).toBe('MEDIA_NOT_FOUND');
      // Idempotent under retry after a partial erasure failure (ADR-004).
      await expect(store.deleteByKey(doomed)).resolves.toEqual({ key: doomed, deleted: true });
      // The neighbouring key is untouched — deletion is per object, never a prefix wipe.
      const still = await store.get(survivor);
      expect(still.body.toString()).toBe('survivor');
      await store.deleteByKey(survivor);
    } finally {
      store.destroy();
    }
  });

  test('degraded path: a down backend surfaces a typed retryable error after exactly the retry budget', async () => {
    let sends = 0;
    const failing = objectStorage.createObjectStorage({
      client: {
        send: async () => {
          sends += 1;
          const err = new Error('ECONNREFUSED (injected object-storage outage)');
          err.name = 'ECONNREFUSED';
          throw err;
        },
        destroy() {},
      },
      retries: RETRIES,
      timeoutMs: 250,
      backoff: { baseMs: 5 },
    });
    const err = await failing.get('listing/x/y.bin').catch((e) => e);
    expect(err).toBeInstanceOf(objectStorage.ObjectStorageUnavailableError);
    expect(err.retryable).toBe(true);
    expect(sends).toBe(ATTEMPTS);
  });

  test('degraded path: a hung backend is cut off by the per-attempt timeout (NFR-09)', async () => {
    let sends = 0;
    const hung = objectStorage.createObjectStorage({
      client: {
        send: async (_cmd, { abortSignal } = {}) => {
          sends += 1;
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 10000);
            if (abortSignal) {
              abortSignal.addEventListener('abort', () => {
                clearTimeout(timer);
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              });
            }
          });
        },
        destroy() {},
      },
      retries: RETRIES,
      timeoutMs: 200,
      backoff: { baseMs: 5 },
    });
    const started = Date.now();
    const err = await hung.put('listing/x/y.bin', Buffer.from('x')).catch((e) => e);
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(Error);
    expect(err.retryable !== false).toBe(true);
    expect(sends).toBe(ATTEMPTS);
    expect(elapsed).toBeLessThan(5000); // bounded, not hung for the SDK's own 10 s
  });
});

// ==============================================================================================
describe('IT-01 · booking.promote early-delivery depth (IT3-F1 regression, FR-04/FR-12)', () => {
  async function drainDue() {
    let stats;
    do {
      stats = await pollOnce({ registry, log: quietLog });
    } while (stats.claimed > 0);
  }

  test('TWO consecutive early deliveries still leave exactly one live promote row, and it promotes when due', async () => {
    const host = await dbh.makeUser({ can_publish_listing: true });
    const guest = await dbh.makeUser();
    const listing = await dbh.makeListing({
      host_id: host.id,
      moderation_status: 'approved',
      scheduled_start: new Date(Date.now() + 6 * 3600 * 1000),
      seat_capacity: 4,
      seats_remaining: 4,
    });
    const booking = await bookingsService.createBooking(guest.id, listing.id, { log: quietLog });
    await drainDue(); // clear the create notifications

    const livePromoteRows = async () => {
      const { rows } = await dbh.query(
        `SELECT * FROM outbox_jobs
         WHERE type = 'booking.promote' AND payload->>'bookingId' = $1 AND status = 'pending'
         ORDER BY created_at`,
        [booking.id]
      );
      return rows;
    };

    // Round 1 and round 2: force the promote row due while the start is still in the future.
    const seen = [];
    for (let round = 0; round < 2; round += 1) {
      const live = await livePromoteRows();
      expect(live).toHaveLength(1); // never zero — the promotion is never lost
      seen.push(live[0].id);
      await dbh.query(`UPDATE outbox_jobs SET available_at = now() WHERE id = $1`, [live[0].id]);
      await drainDue();
      const { rows: bookingRows } = await dbh.query('SELECT status FROM bookings WHERE id = $1', [
        booking.id,
      ]);
      expect(bookingRows[0].status).toBe('pending'); // still not promoted early
    }
    const afterTwo = await livePromoteRows();
    expect(afterTwo).toHaveLength(1);
    expect(seen).not.toContain(afterTwo[0].id); // a fresh row each round, never a resurrected one

    // Now the meal genuinely starts: the surviving row promotes the booking.
    await dbh.query(
      `UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`,
      [listing.id]
    );
    await dbh.query(`UPDATE outbox_jobs SET available_at = now() WHERE id = $1`, [afterTwo[0].id]);
    await drainDue();
    const { rows: finalRows } = await dbh.query('SELECT status FROM bookings WHERE id = $1', [
      booking.id,
    ]);
    expect(finalRows[0].status).toBe('in_progress');
  });
});

// ==============================================================================================
describe('IT-03 · NFR-10 measurement readiness (ADR-007, ADR-008) — NOT measurable in this tree', () => {
  test('ADR-008 evaluation set now EXISTS and conforms, but no results file and no sign-off exist', () => {
    // Was: "the set is absent". The set landed (IT-F1, U4-EVALSET) so the premise changed; what
    // this probe guards has not — every OTHER ADR-008 precondition for claiming NFR-10 is still
    // missing, and this asserts each one rather than inferring them from an empty directory.
    const evalRoot = path.join(REPO_ROOT, 'tests', 'fixtures', 'moderation-eval');
    expect(fs.existsSync(evalRoot)).toBe(true);

    const evalSet = require(evalRoot);
    const set = evalSet.loadSet('v1');
    expect(evalSet.validateSet(set)).toEqual([]); // >= 200 items, balanced, synthetic, never scraped
    expect(set.items.length).toBeGreaterThanOrEqual(200);

    // No results file anywhere: no reviewer, no date, no model id, no measured rate.
    expect(set.hasResults).toBe(false);
    expect(fs.existsSync(path.join(set.dir, 'RESULTS.md'))).toBe(false);
    // DETERMINISM (findings MTUT-RV-02 / COV-11, verification round 2): this used to assert that
    // the *directories* docs/results and docs/_generated/results did not exist at all. That is an
    // assertion over global repository state this test does not own, and it is false the moment
    // any unrelated measurement runs: package.json `scan:zap:run` begins with
    // `mkdir -p docs/results`, and build-plan wave 7 tells the team to commit the LT-01 k6 summary
    // and the ZAP baseline there. An unrelated lane writing docs/results/lt01-k6-summary.json (and
    // even the bare empty directory, which git does not track, so `git status` showed nothing)
    // reddened this test on a checkout byte-identical to a green one — observed 2026-08-17,
    // full-suite runs A/B/C. An empty directory is not evidence of a measurement.
    //
    // What ADR-008 actually forbids is claiming NFR-10 without a *moderation* measurement result
    // carrying a human label sign-off. So scan for that artefact by name (recursively, since a
    // future run may nest it), and let every unrelated artefact in the same directory stay inert.
    // The token must not be swallowed by a longer word, or the probe reacquires exactly the
    // defect it is fixing: bare `eval` matches "retrieval-*.json" and bare `it-?03` matches
    // "unit03-*.json", so an unrelated lane could redden NFR-10 readiness by choosing a filename.
    // The lookbehind rejects a preceding LETTER only, so "-eval", "_eval" and "nfr10_it-03" still
    // match. Keep this pattern in step with the note in tests/rt-lt-resilience/lt01-lt02-wave3.js,
    // which names its artefact deliberately to avoid it.
    const MODERATION_RESULT_RE = /(moderation|(?<![a-z])nfr-?10|(?<![a-z])it-?03|(?<![a-z])eval)/i;
    const moderationResultFiles = [];
    const scanForModerationResults = (dir, rel) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const childRel = `${rel}/${entry.name}`;
        if (MODERATION_RESULT_RE.test(entry.name)) moderationResultFiles.push(childRel);
        else if (entry.isDirectory())
          scanForModerationResults(path.join(dir, entry.name), childRel);
      }
    };
    for (const rel of ['docs/results', 'docs/_generated/results']) {
      scanForModerationResults(path.join(REPO_ROOT, rel), rel);
    }
    expect(moderationResultFiles).toEqual([]);
    expect(set.manifest.labelReview.status).toBe('unreviewed');
    expect(set.manifest.labelReview.reviewer).toBeNull();
    expect(set.manifest.labelReview.date).toBeNull();

    // So even handed a live model id, ADR-008 refuses the claim: numbers would be provisional.
    const verdict = evalSet.claimability({
      set,
      modelId: 'a-live-model-id',
      promptVersion: 'moderation-prompt-v1',
    });
    expect(verdict.claimable).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/sign-off/i);
  });

  test('the ADR-002 pipeline stages the measurement must run through do not exist yet', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'src', 'modules', 'moderation'))).toBe(false);
    expect(registry.has('moderation.scan')).toBe(false);
    // Stage 1 of ADR-002 (deterministic blocklist/regex/rate-limit pre-filter) has no module.
    const srcFiles = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) srcFiles.push(full);
      }
    };
    walk(path.join(REPO_ROOT, 'src'));
    const prefilter = srcFiles.filter((f) => /prefilter|pre-filter|blocklist/i.test(f));
    expect(prefilter).toEqual([]);
  });

  test('the ADR-007 MOCK classifier cannot stand in for the measurement: it is a fixture matcher, not a classifier', async () => {
    expect(llm.mode).toBe('mock');
    expect(llm.model).toBe('mock-moderation-deterministic-v1');
    expect(llm.model).not.toMatch(/gemini|gpt|claude|llama/i); // never mistakable for a live run

    // Genuinely abusive / scammy / spammy content that no fixture pattern covers is scored
    // 'benign' with 0.99 confidence. Scoring an eval set through the mock would therefore
    // report an invented false-negative rate — which is exactly why ADR-008 requires the
    // live model id in the results file.
    const missed = [
      'You people are worthless trash and should not be allowed near a kitchen.',
      'Send $300 in crypto to reserve the whole table, I will refund you after the meal.',
      'VISIT MY SITE!!! cheap-meals-now.example for 90% off every listing, message me daily.',
    ];
    for (const text of missed) {
      const result = await llm.classify(text);
      expect(result.category).toBe('benign');
      expect(result.confidence).toBe(0.99);
    }
    // A benign listing description is also 'benign' — the mock has no discriminating power
    // over unseen text, so FP/FN measured against it carry no information about NFR-10.
    const benign = await llm.classify('Homemade tamales, six seats, Saturday evening in PB.');
    expect(benign.category).toBe('benign');
  });

  test('live-mode plumbing IS ready for the wave-7 measurement: provider facts are env-only (ADR-007)', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'adapters', 'llmModeration.js'),
      'utf8'
    );
    // No provider host, model id or key may be hardcoded — only the env var NAMES may appear.
    expect(source).not.toMatch(/generativelanguage\.googleapis\.com/);
    expect(source).not.toMatch(/gemini-[0-9]/i);
    expect(source).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
    const envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
    for (const name of [
      'LLM_MODERATION_BASE_URL',
      'LLM_MODERATION_API_KEY',
      'MODERATION_MODEL',
      'LLM_MODERATION_MODE',
    ]) {
      expect(envExample).toContain(name);
    }
  });
});

// ==============================================================================================
describe('IT-04 · FR-07 safety-alert delivery — service layer present, delivery leg exercised on the substrate', () => {
  test('the FR-07 write path exists: safety module, alert route, moderator queue route, delivery handler', () => {
    // This assertion USED to record the wave-3 gap (no safety module at all). U4-SAFETY closed
    // it; the behavioural IT-04 lives in it04-safety-delivery.test.js. What stays here is the
    // structural fact that the registry's `safety` entry now has something to mount.
    const routes = fs.readFileSync(path.join(REPO_ROOT, 'src', 'routes', 'index.js'), 'utf8');
    expect(routes).toMatch(/safety/); // registry names it…
    const moduleDir = path.join(REPO_ROOT, 'src', 'modules', 'safety');
    for (const f of ['routes.js', 'service.js', 'repo.js']) {
      expect(fs.existsSync(path.join(moduleDir, f))).toBe(true); // …and now it mounts
    }
    expect(fs.existsSync(path.join(REPO_ROOT, 'src', 'outbox', 'handlers', 'safetyAlert.js'))).toBe(
      true
    );
    // ADR-001/003: the request path stays adapter-free — only the handler may deliver.
    const service = fs.readFileSync(path.join(moduleDir, 'service.js'), 'utf8');
    const routesSrc = fs.readFileSync(path.join(moduleDir, 'routes.js'), 'utf8');
    expect(service).not.toMatch(/require\(['"][^'"]*adapters\//);
    expect(routesSrc).not.toMatch(/require\(['"][^'"]*adapters\//);
    expect(service).not.toMatch(/notifications\/transport/);
  });

  test('substrate: the alert row states FR-07 needs all exist in the schema', async () => {
    const { rows } = await dbh.query(
      `SELECT e.enumlabel FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = 'alert_delivery_status'
        ORDER BY e.enumsortorder`
    );
    expect(rows.map((r) => r.enumlabel)).toEqual([
      'pending',
      'retrying',
      'delivered',
      'failed',
      'no_channel',
    ]);
    const { rows: cols } = await dbh.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' AND column_name LIKE 'emergency_contact%'
        ORDER BY column_name`
    );
    // NFR-13: third-party emergency-contact PII is stored encrypted (…_enc columns only).
    expect(cols.map((c) => c.column_name)).toEqual([
      'emergency_contact_email_enc',
      'emergency_contact_name_enc',
      'emergency_contact_phone_enc',
    ]);
  });

  test('delivery leg (ADR-011 mock transport): alert persisted → moderator + emergency-contact attempts recorded', async () => {
    const guest = await dbh.makeUser();
    const moderator = await dbh.makeUser();
    const booking = await dbh.makeBooking({ guest_id: guest.id, status: 'in_progress' });
    const alert = await dbh.insertRow('safety_alerts', {
      booking_id: booking.id,
      raised_by: guest.id,
    });
    expect(alert.delivery_status).toBe('pending'); // FR-07 initial state

    const modKey = `it04-moderator-${uniq()}`;
    const contactKey = `it04-emergency-${uniq()}`;
    const modAttempt = await transport.send({
      userId: moderator.id,
      channel: 'email',
      template: 'safety-alert-moderator',
      params: { alertId: alert.id },
      idempotencyKey: modKey,
    });
    const contactAttempt = await transport.send({
      userId: guest.id,
      channel: 'email',
      template: 'safety-alert-emergency',
      params: { alertId: alert.id },
      idempotencyKey: contactKey,
    });
    expect(modAttempt.status).toBe('sent');
    expect(contactAttempt.status).toBe('sent');
    for (const key of [modKey, contactKey]) {
      const row = await notifRepo.findByIdempotencyKey(key);
      expect(row.status).toBe('sent');
      expect(row.channel).toBe('email');
      // ADR-003: params carry IDs only — no email address, phone or name.
      expect(JSON.stringify(row.params)).not.toMatch(/@|\+1|phone|email/i);
    }
    expect(mockTransport.deliveries()).toHaveLength(2);
  });

  test('retry leg: an injected emergency-contact delivery failure retries, then the failed row stays visible', async () => {
    const guest = await dbh.makeUser();
    const booking = await dbh.makeBooking({ guest_id: guest.id, status: 'in_progress' });
    const alert = await dbh.insertRow('safety_alerts', {
      booking_id: booking.id,
      raised_by: guest.id,
    });

    // One failure then success — the attempt count proves the retry actually happened.
    const retryKey = `it04-retry-${uniq()}`;
    mockTransport.injectFailures(1);
    const retried = await transport.send({
      userId: guest.id,
      channel: 'email',
      template: 'safety-alert-emergency',
      params: { alertId: alert.id },
      idempotencyKey: retryKey,
    });
    expect(retried.status).toBe('sent');
    expect((await notifRepo.findByIdempotencyKey(retryKey)).attempt_count).toBe(2);

    // Full outage: the attempt row ends 'failed' with the error retained and nothing delivered.
    const deadKey = `it04-dead-${uniq()}`;
    mockTransport.injectFailures(ATTEMPTS + 2);
    const failed = await transport.send({
      userId: guest.id,
      channel: 'email',
      template: 'safety-alert-emergency',
      params: { alertId: alert.id },
      idempotencyKey: deadKey,
    });
    expect(failed.status).toBe('failed');
    const deadRow = await notifRepo.findByIdempotencyKey(deadKey);
    expect(deadRow.status).toBe('failed');
    expect(deadRow.last_error).toBeTruthy();
    // The alert itself is still 'pending' and therefore still reviewable — no wave-4 code
    // exists to advance it, which is the ADR-002-shaped safe direction for FR-07 too.
    const { rows } = await dbh.query('SELECT delivery_status FROM safety_alerts WHERE id = $1', [
      alert.id,
    ]);
    expect(rows[0].delivery_status).toBe('pending');
  });

  test('both FR-07 email templates render with a subject and an ID-only body', () => {
    for (const template of ['safety-alert-emergency', 'safety-alert-moderator']) {
      expect(sendgrid.EMAIL_SUBJECTS[template]).toBeTruthy();
      const rendered = sendgrid.renderEmail(template, { alertId: 'abcd-1234' });
      expect(rendered.subject).toMatch(/safety alert/i);
      expect(JSON.stringify(rendered)).toContain('abcd-1234');
    }
  });
});
