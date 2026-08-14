// tests/unit/adapter-maps.test.js — U2-ADAPTER-MAPS unit suite (build-plan wave 2).
//
// Verifies:
//   FR-01  — geocode(address) / searchArea(query) resolve locations through the Google
//            endpoints (injected fetch; the suite never calls the real provider).
//   NFR-01 — results cached in Redis with a TTL; a repeated identical call performs ZERO
//            HTTP requests (spy assertion).
//   NFR-09 (RT-01) — 3000 ms-class per-attempt timeout, bounded retries with backoff; with
//            the HTTP layer forced to fail, a cached entry is served with degraded: true and
//            an uncached call rejects with a typed ServiceUnavailableError (MAPS_UNAVAILABLE),
//            never an unhandled throw.
//   NFR-13 / AB-08 / ADR-010 — the critical cache-precision audit: every Redis key the
//            adapter writes contains ONLY coarsened coordinates and area labels — never the
//            exact input coordinates, never a street address, not even in the key name.
//   ADR-005 — API key comes from the environment/config only; grep-style source assertion.
//   geoPrecision.coarsen — snaps using config.privacy.coarsenRadiusMeters, differs from a
//            precise input, is stable and idempotent.
'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../../src/config');
const { coarsen, METERS_PER_DEGREE_LAT } = require('../../src/lib/geoPrecision');
const maps = require('../../src/adapters/maps');
const { ValidationError, NotFoundError, ServiceUnavailableError } = require('../../src/lib/errors');
const { redis, flushNamespace, closeTestRedis } = require('../helpers/redis');

const { createMapsAdapter } = maps;

// ---- fixtures --------------------------------------------------------------------------------

const TEST_API_KEY = 'test-maps-key-from-env';
const PRECISE = { lat: 32.880062, lng: -117.23401 }; // 9500 Gilman Dr — a precise address point
const ADDRESS = '9500 Gilman Dr, La Jolla, CA 92093';

const GEOCODE_OK_BODY = {
  status: 'OK',
  results: [
    {
      formatted_address: '9500 Gilman Dr, La Jolla, CA 92093, USA',
      geometry: { location: { lat: PRECISE.lat, lng: PRECISE.lng } },
      address_components: [
        { long_name: '9500', short_name: '9500', types: ['street_number'] },
        { long_name: 'Gilman Drive', short_name: 'Gilman Dr', types: ['route'] },
        { long_name: 'La Jolla', short_name: 'La Jolla', types: ['neighborhood', 'political'] },
        { long_name: 'San Diego', short_name: 'San Diego', types: ['locality', 'political'] },
        {
          long_name: 'California',
          short_name: 'CA',
          types: ['administrative_area_level_1', 'political'],
        },
      ],
    },
  ],
};

const PLACES_OK_BODY = {
  status: 'OK',
  results: [
    {
      name: 'La Jolla',
      types: ['neighborhood', 'political'],
      geometry: { location: { lat: 32.8328, lng: -117.2713 } },
    },
    {
      name: '7863 Girard Ave',
      types: ['street_address'],
      formatted_address: '7863 Girard Ave, La Jolla, CA 92037, USA',
      plus_code: { compound_code: 'RPMH+2F La Jolla, San Diego, CA, USA' },
      geometry: { location: { lat: 32.8449, lng: -117.274 } },
    },
  ],
};

/** Minimal fetch Response fake matching what src/lib/httpClient.js consumes. */
function jsonResponse(body, status = 200) {
  return {
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify(body),
  };
}

function okFetch(body) {
  return jest.fn(async () => jsonResponse(body));
}

/** Network-level failure (fetch rejects), as if the provider were unreachable. */
function downFetch() {
  return jest.fn(async () => {
    throw new TypeError('fetch failed: network down');
  });
}

/** Hangs until the per-attempt timeout aborts it (NFR-09 timeout path). */
function hangingFetch() {
  return jest.fn(
    (url, opts) =>
      new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
      })
  );
}

function liveAdapter(overrides = {}) {
  return createMapsAdapter({
    mode: 'live',
    apiKey: TEST_API_KEY,
    cacheTtlSeconds: 60,
    backoffBaseMs: 1, // keep retry backoff out of the test wall clock
    ...overrides,
  });
}

async function scanMapsKeys() {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', 'hp:cache:maps:*', 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys.sort();
}

async function deleteFreshMapsKeys() {
  const keys = await scanMapsKeys();
  const fresh = keys.filter((k) => !k.endsWith(':stale'));
  if (fresh.length > 0) await redis.del(...fresh);
  return fresh.length;
}

beforeEach(async () => {
  await flushNamespace('cache');
});

afterAll(async () => {
  await closeTestRedis();
});

// ---- geoPrecision.coarsen (ADR-010 substrate) ------------------------------------------------

describe('geoPrecision.coarsen (ADR-010 / NFR-13 — public precision)', () => {
  test('coarsened output differs from a precise input and carries an area label', () => {
    const out = coarsen(PRECISE.lat, PRECISE.lng);
    expect(out.lat).not.toBe(PRECISE.lat);
    expect(out.lng).not.toBe(PRECISE.lng);
    expect(typeof out.areaLabel).toBe('string');
    expect(out.areaLabel.length).toBeGreaterThan(0);
    // Displacement is bounded by the cell diagonal (~0.71 × radius per axis).
    const radius = config.privacy.coarsenRadiusMeters;
    const latErrMeters = Math.abs(out.lat - PRECISE.lat) * METERS_PER_DEGREE_LAT;
    expect(latErrMeters).toBeLessThanOrEqual(radius);
  });

  test('same input → same cell; a nearby point in the same cell snaps identically', () => {
    const a1 = coarsen(32.88, -117.23);
    const a2 = coarsen(32.88, -117.23);
    const nearby = coarsen(32.88001, -117.22999); // ~1 m away, same 300 m cell
    expect(a2).toEqual(a1);
    expect(nearby.lat).toBe(a1.lat);
    expect(nearby.lng).toBe(a1.lng);
  });

  test('coarsening is idempotent: a cell center maps to itself', () => {
    const once = coarsen(PRECISE.lat, PRECISE.lng);
    const twice = coarsen(once.lat, once.lng);
    expect(twice.lat).toBe(once.lat);
    expect(twice.lng).toBe(once.lng);
  });

  test('uses config.privacy.coarsenRadiusMeters by default; radius changes the grid', () => {
    const viaDefault = coarsen(PRECISE.lat, PRECISE.lng);
    const viaExplicit = coarsen(PRECISE.lat, PRECISE.lng, {
      radiusMeters: config.privacy.coarsenRadiusMeters,
    });
    expect(viaDefault.lat).toBe(viaExplicit.lat);
    expect(viaDefault.lng).toBe(viaExplicit.lng);

    const wide = coarsen(PRECISE.lat, PRECISE.lng, { radiusMeters: 5000 });
    expect(wide.lat).not.toBe(viaDefault.lat);
  });

  test('passes a provided areaLabel through; default label uses coarse coordinates only', () => {
    const labelled = coarsen(PRECISE.lat, PRECISE.lng, { areaLabel: '  La Jolla, San Diego ' });
    expect(labelled.areaLabel).toBe('La Jolla, San Diego');

    const unlabelled = coarsen(PRECISE.lat, PRECISE.lng);
    expect(unlabelled.areaLabel).toContain(unlabelled.lat.toFixed(3));
    expect(unlabelled.areaLabel).not.toContain(String(PRECISE.lat));
  });

  test('rejects out-of-range or non-finite inputs and a non-positive radius', () => {
    expect(() => coarsen(91, 0)).toThrow(RangeError);
    expect(() => coarsen(0, -200)).toThrow(RangeError);
    expect(() => coarsen(NaN, 0)).toThrow(RangeError);
    expect(() => coarsen('32.88', -117.23)).toThrow(RangeError);
    expect(() => coarsen(0, 0, { radiusMeters: 0 })).toThrow(RangeError);
    expect(() => coarsen(0, 0, { radiusMeters: -5 })).toThrow(RangeError);
  });
});

// ---- geocode: live path, caching, degraded mode ----------------------------------------------

describe('maps.geocode (FR-01 / NFR-01 / NFR-09 / ADR-005)', () => {
  test('calls the Google geocode endpoint with the env-sourced key and returns coarse public precision', async () => {
    const fetchImpl = okFetch(GEOCODE_OK_BODY);
    const adapter = liveAdapter({ fetchImpl });

    const result = await adapter.geocode(ADDRESS);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchImpl.mock.calls[0][0]);
    expect(calledUrl.host).toBe('maps.googleapis.com');
    expect(calledUrl.pathname).toBe('/maps/api/geocode/json');
    expect(calledUrl.searchParams.get('address')).toBe(ADDRESS);
    expect(calledUrl.searchParams.get('key')).toBe(TEST_API_KEY);

    // Default result is the PUBLIC projection: coarsened coordinates + area label, no precise.
    const expected = coarsen(PRECISE.lat, PRECISE.lng);
    expect(result.lat).toBe(expected.lat);
    expect(result.lng).toBe(expected.lng);
    expect(result.lat).not.toBe(PRECISE.lat);
    expect(result.lng).not.toBe(PRECISE.lng);
    expect(result.areaLabel).toBe('La Jolla, San Diego');
    expect(result.degraded).toBe(false);
    expect(result.source).toBe('live');
    expect(result).not.toHaveProperty('precise');
  });

  test('a repeated identical call performs ZERO HTTP requests and serves from Redis with a TTL', async () => {
    const fetchImpl = okFetch(GEOCODE_OK_BODY);
    const adapter = liveAdapter({ fetchImpl });

    const first = await adapter.geocode(ADDRESS);
    const second = await adapter.geocode(`  ${ADDRESS.toUpperCase()}  `); // normalization collapses

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.source).toBe('cache');
    expect(second.degraded).toBe(false);
    expect(second.lat).toBe(first.lat);
    expect(second.lng).toBe(first.lng);
    expect(second.areaLabel).toBe(first.areaLabel);

    // Fresh entry expires at the configured TTL; the stale fallback copy outlives it.
    const keys = await scanMapsKeys();
    const freshKeys = keys.filter((k) => !k.endsWith(':stale'));
    const staleKeys = keys.filter((k) => k.endsWith(':stale'));
    expect(freshKeys).toHaveLength(1);
    expect(staleKeys).toHaveLength(1);
    const freshTtl = await redis.ttl(freshKeys[0]);
    const staleTtl = await redis.ttl(staleKeys[0]);
    expect(freshTtl).toBeGreaterThan(0);
    expect(freshTtl).toBeLessThanOrEqual(60);
    expect(staleTtl).toBeGreaterThan(60);
    expect(staleTtl).toBeLessThanOrEqual(60 * 7);
  });

  test('bounded retries with backoff: transient 500s are retried, then the call succeeds', async () => {
    let calls = 0;
    const fetchImpl = jest.fn(async () => {
      calls += 1;
      if (calls <= 2) return jsonResponse({ error: 'boom' }, 500);
      return jsonResponse(GEOCODE_OK_BODY);
    });
    const adapter = liveAdapter({ fetchImpl, retries: 2 });

    const result = await adapter.geocode(ADDRESS);

    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 attempt + 2 bounded retries
    expect(result.source).toBe('live');
    expect(result.areaLabel).toBe('La Jolla, San Diego');
  });

  test('NFR-09 degraded mode: with HTTP down, a cached entry is served with degraded: true', async () => {
    const warm = liveAdapter({ fetchImpl: okFetch(GEOCODE_OK_BODY) });
    const baseline = await warm.geocode(ADDRESS);

    // Simulate fresh-TTL expiry (only the long-lived stale copy remains), then an outage.
    expect(await deleteFreshMapsKeys()).toBe(1);
    const fetchImpl = downFetch();
    const broken = liveAdapter({ fetchImpl, retries: 1 });

    const result = await broken.geocode(ADDRESS);

    expect(fetchImpl).toHaveBeenCalledTimes(2); // it DID try (1 + 1 retry) before falling back
    expect(result.degraded).toBe(true);
    expect(result.source).toBe('cache-degraded');
    expect(result.lat).toBe(baseline.lat);
    expect(result.lng).toBe(baseline.lng);
    expect(result.areaLabel).toBe(baseline.areaLabel);
  });

  test('NFR-09: an uncached call with HTTP down rejects with a typed MAPS_UNAVAILABLE error', async () => {
    const adapter = liveAdapter({ fetchImpl: downFetch(), retries: 1 });

    const promise = adapter.geocode('an address nobody has ever cached');
    await expect(promise).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(promise).rejects.toMatchObject({
      code: 'MAPS_UNAVAILABLE',
      status: 503,
    });
  });

  test('NFR-09: a hung provider is timed out per attempt and surfaces the typed fallback error', async () => {
    const fetchImpl = hangingFetch();
    const adapter = liveAdapter({ fetchImpl, timeoutMs: 40, retries: 0 });

    let caught;
    try {
      await adapter.geocode('another never-cached address');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ServiceUnavailableError);
    expect(caught.code).toBe('MAPS_UNAVAILABLE');
    expect(caught.cause && caught.cause.code).toBe('UPSTREAM_TIMEOUT');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('ZERO_RESULTS is a definitive NotFound, not an outage, and is not cached', async () => {
    const fetchImpl = okFetch({ status: 'ZERO_RESULTS', results: [] });
    const adapter = liveAdapter({ fetchImpl });

    await expect(adapter.geocode('nowhere at all')).rejects.toBeInstanceOf(NotFoundError);
    await expect(adapter.geocode('nowhere at all')).rejects.toMatchObject({
      code: 'MAPS_NO_RESULTS',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // no negative cache for geocode errors
  });

  test('REQUEST_DENIED is not retried (non-transient provider rejection)', async () => {
    const fetchImpl = okFetch({ status: 'REQUEST_DENIED', error_message: 'bad key' });
    const adapter = liveAdapter({ fetchImpl, retries: 2 });

    await expect(adapter.geocode('any address here')).rejects.toMatchObject({
      code: 'MAPS_UNAVAILABLE',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // retryable: false → single attempt
  });

  test("precision: 'exact' bypasses the cache, returns precise coordinates, and never caches them", async () => {
    const warmFetch = okFetch(GEOCODE_OK_BODY);
    const adapter = liveAdapter({ fetchImpl: warmFetch });
    await adapter.geocode(ADDRESS); // fresh cache entry now exists

    const result = await adapter.geocode(ADDRESS, { precision: 'exact' });

    expect(warmFetch).toHaveBeenCalledTimes(2); // cache was NOT consulted for exact
    expect(result.precise).toEqual({ lat: PRECISE.lat, lng: PRECISE.lng });
    expect(result.lat).not.toBe(PRECISE.lat); // top-level shape stays coarse
    expect(result.source).toBe('live');
  });

  test('rejects bad input with a typed ValidationError before any HTTP or cache work', async () => {
    const fetchImpl = okFetch(GEOCODE_OK_BODY);
    const adapter = liveAdapter({ fetchImpl });

    await expect(adapter.geocode('')).rejects.toBeInstanceOf(ValidationError);
    await expect(adapter.geocode('   ')).rejects.toBeInstanceOf(ValidationError);
    await expect(adapter.geocode(42)).rejects.toBeInstanceOf(ValidationError);
    await expect(adapter.geocode('x'.repeat(600))).rejects.toBeInstanceOf(ValidationError);
    await expect(adapter.geocode(ADDRESS, { precision: 'street' })).rejects.toBeInstanceOf(
      ValidationError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---- searchArea ------------------------------------------------------------------------------

describe('maps.searchArea (FR-01 / NFR-01 / NFR-09)', () => {
  test('resolves a location query to coarsened candidate areas via Places Text Search', async () => {
    const fetchImpl = okFetch(PLACES_OK_BODY);
    const adapter = liveAdapter({ fetchImpl });

    const result = await adapter.searchArea('La Jolla');

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchImpl.mock.calls[0][0]);
    expect(calledUrl.host).toBe('maps.googleapis.com');
    expect(calledUrl.pathname).toBe('/maps/api/place/textsearch/json');
    expect(calledUrl.searchParams.get('query')).toBe('La Jolla');
    expect(calledUrl.searchParams.get('key')).toBe(TEST_API_KEY);

    expect(result.degraded).toBe(false);
    expect(result.source).toBe('live');
    expect(result.areas).toHaveLength(2);

    const [areaResult, streetResult] = result.areas;
    expect(areaResult.areaLabel).toBe('La Jolla'); // area-typed result keeps its name
    expect(areaResult.lat).not.toBe(32.8328); // …but its coordinates are coarsened
    // A street-typed result must NOT contribute its street name as the label (ADR-010):
    expect(streetResult.areaLabel).toBe('La Jolla, San Diego, CA, USA');
    expect(streetResult.areaLabel).not.toContain('Girard');
    expect(streetResult.lat).not.toBe(32.8449);
  });

  test('a repeated identical query performs zero HTTP requests', async () => {
    const fetchImpl = okFetch(PLACES_OK_BODY);
    const adapter = liveAdapter({ fetchImpl });

    const first = await adapter.searchArea('La Jolla');
    const second = await adapter.searchArea('la  jolla'); // normalization collapses

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.source).toBe('cache');
    expect(second.areas).toEqual(first.areas);
  });

  test('ZERO_RESULTS yields an empty (and cached) area list, not an error', async () => {
    const fetchImpl = okFetch({ status: 'ZERO_RESULTS', results: [] });
    const adapter = liveAdapter({ fetchImpl });

    const first = await adapter.searchArea('xyzzy nowhere');
    const second = await adapter.searchArea('xyzzy nowhere');

    expect(first.areas).toEqual([]);
    expect(second.source).toBe('cache');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // negative result is a cacheable answer
  });

  test('NFR-09 degraded mode: serves the stale cached area list when the provider is down', async () => {
    const warm = liveAdapter({ fetchImpl: okFetch(PLACES_OK_BODY) });
    const baseline = await warm.searchArea('La Jolla');
    await deleteFreshMapsKeys();

    const broken = liveAdapter({ fetchImpl: downFetch(), retries: 0 });
    const result = await broken.searchArea('La Jolla');

    expect(result.degraded).toBe(true);
    expect(result.source).toBe('cache-degraded');
    expect(result.areas).toEqual(baseline.areas);
  });
});

// ---- ADR-010 critical assertion: the cache can never leak an exact location ------------------

describe('ADR-010 cache-precision audit (NFR-13 / AB-08)', () => {
  test('every Redis key the adapter writes holds ONLY coarsened coordinates and area labels', async () => {
    const adapter = liveAdapter({ fetchImpl: okFetch(GEOCODE_OK_BODY) });
    await adapter.geocode(ADDRESS);
    await adapter.geocode(ADDRESS, { precision: 'exact' }); // precise result must NOT be cached
    const placesAdapter = liveAdapter({ fetchImpl: okFetch(PLACES_OK_BODY) });
    await placesAdapter.searchArea('dinner near 7863 Girard Ave, La Jolla');

    const keys = await scanMapsKeys();
    expect(keys.length).toBeGreaterThan(0);

    const expectedPublic = coarsen(PRECISE.lat, PRECISE.lng);
    for (const cacheKey of keys) {
      // Key names are namespace + SHA-256 hash — never the input address or query text.
      expect(cacheKey).toMatch(/^hp:cache:maps:(geocode|search):[0-9a-f]{32}(:stale)?$/);

      const raw = await redis.get(cacheKey);
      // The raw stored bytes contain no street number, street name, exact coordinate, or key.
      expect(raw).not.toMatch(/9500|gilman|girard|7863/i);
      expect(raw).not.toContain(String(PRECISE.lat));
      expect(raw).not.toContain(String(PRECISE.lng));
      expect(raw).not.toContain('32.8328');
      expect(raw).not.toContain('32.8449');
      expect(raw).not.toContain(TEST_API_KEY);

      // And the parsed shape is exactly the public projection — nothing else rides along.
      const value = JSON.parse(raw);
      if (cacheKey.includes(':geocode:')) {
        expect(Object.keys(value).sort()).toEqual(['areaLabel', 'lat', 'lng']);
        expect(value.lat).toBe(expectedPublic.lat);
        expect(value.lng).toBe(expectedPublic.lng);
      } else {
        expect(Object.keys(value)).toEqual(['areas']);
        for (const area of value.areas) {
          expect(Object.keys(area).sort()).toEqual(['areaLabel', 'lat', 'lng']);
        }
      }
    }
  });
});

// ---- mock mode + default instance ------------------------------------------------------------

describe('mock mode (config.maps.mode = mock — dev/test determinism, ADR-007 pattern)', () => {
  test('is deterministic, HTTP-free, and still writes only public precision to the cache', async () => {
    const fetchImpl = jest.fn();
    const adapter = createMapsAdapter({ mode: 'mock', fetchImpl, cacheTtlSeconds: 60 });

    const first = await adapter.geocode('123 Anywhere St, San Diego');
    await flushNamespace('cache'); // force regeneration — determinism must come from the input
    const again = await adapter.geocode('123 Anywhere St, San Diego');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(again.lat).toBe(first.lat);
    expect(again.lng).toBe(first.lng);
    expect(again.areaLabel).toBe(first.areaLabel);
    expect(first).not.toHaveProperty('precise');
    expect(first.areaLabel).toMatch(/^Mock Area [0-9a-f]{6}$/);

    const search = await adapter.searchArea('balboa park');
    expect(search.areas).toHaveLength(3);
    expect(fetchImpl).not.toHaveBeenCalled();

    for (const cacheKey of await scanMapsKeys()) {
      expect(cacheKey).toMatch(/^hp:cache:maps:(geocode|search):[0-9a-f]{32}(:stale)?$/);
    }
  });

  test('the default exported instance runs in mock mode under NODE_ENV=test and never fetches', async () => {
    expect(config.maps.mode).toBe('mock'); // tests/helpers/env.js pins MAPS_MODE=mock
    const result = await maps.geocode('456 Test Ave, San Diego');
    expect(result.degraded).toBe(false);
    expect(typeof result.lat).toBe('number');
    expect(typeof result.areaLabel).toBe('string');
    const search = await maps.searchArea('gaslamp quarter');
    expect(Array.isArray(search.areas)).toBe(true);
  });
});

// ---- ADR-005 secret hygiene ------------------------------------------------------------------

describe('ADR-005 — no API key in source (env only)', () => {
  test('src/adapters/maps.js contains no Google API key literal and reads config.maps.apiKey', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'adapters', 'maps.js'),
      'utf8'
    );
    expect(source).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/); // Google API key literal shape
    expect(source).toMatch(/config\.maps\.apiKey/); // key sourced from env-backed config
    expect(source).not.toMatch(/apiKey\s*[:=]\s*['"][^'"]+['"]/); // never a hardcoded default
  });

  test('createMapsAdapter refuses live mode without an API key', () => {
    expect(() => createMapsAdapter({ mode: 'live', apiKey: undefined })).toThrow(
      /requires an API key/
    );
  });
});
