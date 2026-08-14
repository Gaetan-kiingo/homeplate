// tests/unit/search.test.js — U3-SEARCH acceptance suite (build-plan wave 3B).
//
// Requirement traceability (SRS Appendix B):
//   FR-01 (TC-01) — each filter alone (location+radiusKm, from/to, hostId, cuisine) and all
//            combined return the expected seeded listing IDs; pending/rejected/cancelled/past
//            listings are never returned; distance filtering uses COARSE coordinates.
//   NFR-01 — a repeat identical query performs ZERO Maps adapter calls (adapter spy + page
//            cache hit on the service's cache key).
//   NFR-02 — EXPLAIN over the exact production SQL at volume-seed scale (>=10k users,
//            >=1k listings on one LA day) shows index usage — no sequential scan on listings.
//   NFR-09 (RT-01) — degraded mode: a stale-cache adapter answer serves results with
//            degraded:true (and is never page-cached); an uncached location query during an
//            outage is a typed 503 SEARCH_DEGRADED with a user-facing message, never an
//            unhandled 500; non-location queries and previously page-cached queries keep
//            working with the provider down.
//   NFR-11 (ST-04) — unknown query params stripped; SQLi/XSS payloads yield 422 or clean
//            results, never a 500; tables intact; no stack traces.
//   AB-08 / ADR-010 — 401 unauthenticated; every result is EXACTLY the publicListing key
//            allowlist (no address_line, lat/lng, host email/phone); the cached page read
//            directly from Redis holds public precision only and its key carries a digest,
//            never the location text.
//   Build-plan §6.5 — GET /api/listings/search is reachable through the basePath override +
//            listings :id UUID constraint; nothing mounts at /api/search.
'use strict';

const request = require('supertest');

const config = require('../../src/config');
const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const { ServiceUnavailableError } = require('../../src/lib/errors');
const sessions = require('../../src/modules/auth/sessions');
const serializers = require('../../src/modules/listings/serializers');
const searchService = require('../../src/modules/search/service');
const searchRepo = require('../../src/modules/search/repo');
const searchRoutes = require('../../src/modules/search/routes');
const maps = require('../../src/adapters/maps');
const { seed } = require('../../scripts/seed');
const dbh = require('../helpers/db');
const { redis, closeTestRedis } = require('../helpers/redis');

const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// Deterministic mock-Maps location queries (ADR-005/007 mock-in-CI). Each test concern uses
// its own string so page-cache cells never collide across tests.
const LOC_FILTERS = 'la jolla cove test kitchen';
const LOC_CACHE = 'pacific beach cache probe';
const LOC_PAGECACHE = 'page cache outage probe';
const LOC_OUTAGE = 'uncached outage location probe';
const RADIUS_KM = 2;

// A point far (>1000 km) from every mock area (the mock fans out over San Diego county) —
// coarse coordinates placed here can never fall inside any RADIUS_KM search circle.
const FAR = { lat: 25.0, lng: -100.0 };

/** Test-side haversine (km) mirroring the repo's SQL formula, for fixture guards. */
function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const s =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

const sink = { write() {} };
let app;

// ---- fixtures --------------------------------------------------------------------------------

const TAG = `search-tc01-${process.pid}-${Date.now()}`;
let areas; // resolved candidate areas for LOC_FILTERS (deterministic mock)
let center; // areas[0]
let hostV; // visibility-invariant host
let vIn; // hostV's ONLY visible listing
let hostA;
let hostB;
let A1; // TAG cuisine, June 5 2031, coarse AT center, precise FAR (proves coarse-based filter)
let A2; // TAG cuisine, June 6 2031, coarse FAR, precise AT center (proves coarse-based filter)
let B1; // TAG cuisine, July 10 2031, coarse ~0.55 km from center (inside RADIUS_KM)
let B2; // other cuisine, coarse FAR
let a1MediaKey;
let viewerCookie;

async function cookieFor(user) {
  const { token } = await sessions.createSession({ id: user.id, roles: user.roles });
  return `${config.auth.sessionCookieName}=${token}`;
}

/** Approved + active + future listing (the only publicly visible kind — FR-08/AB-01). */
function approved(overrides = {}) {
  return dbh.makeListing({ moderation_status: 'approved', status: 'active', ...overrides });
}

function search(cookie, query) {
  return request(app).get('/api/listings/search').set('Cookie', cookie).query(query);
}

function ids(res) {
  return res.body.results.map((r) => r.id).sort();
}

beforeAll(async () => {
  app = createApp({ logger: createLogger({ level: 'warn', stream: sink }) });
  const viewer = await dbh.makeUser();
  viewerCookie = await cookieFor(viewer);

  // Resolve the deterministic mock areas the location tests build their geometry around.
  const resolved = await maps.searchArea(LOC_FILTERS);
  areas = resolved.areas;
  center = areas[0];
  expect(areas.length).toBeGreaterThan(0);
  // Geometry guard: FAR is far outside every candidate area's search circle.
  for (const area of areas) {
    expect(distanceKm(area, FAR)).toBeGreaterThan(1000);
  }

  hostV = await dbh.makeUser({ can_publish_listing: true });
  hostA = await dbh.makeUser({ can_publish_listing: true });
  hostB = await dbh.makeUser({ can_publish_listing: true });

  // Visibility fixtures (one host, five states, distinct LA days for the FR-11 unique index).
  vIn = await approved({
    host_id: hostV.id,
    scheduled_start: new Date('2031-05-05T19:00:00-07:00'),
  });
  await dbh.makeListing({
    host_id: hostV.id,
    moderation_status: 'pending',
    scheduled_start: new Date('2031-05-06T19:00:00-07:00'),
  });
  await dbh.makeListing({
    host_id: hostV.id,
    moderation_status: 'rejected',
    scheduled_start: new Date('2031-05-07T19:00:00-07:00'),
  });
  await approved({
    host_id: hostV.id,
    status: 'cancelled',
    scheduled_start: new Date('2031-05-08T19:00:00-07:00'),
  });
  await approved({
    host_id: hostV.id,
    scheduled_start: new Date(Date.now() - 2 * 24 * 3600 * 1000), // past — never returned
  });

  // Filter fixtures (TC-01). Coarse vs precise are deliberately CROSSED on A1/A2 so a filter
  // reading the precise pair would return the wrong set (ADR-010: search sees coarse only).
  A1 = await approved({
    host_id: hostA.id,
    cuisine: TAG,
    scheduled_start: new Date('2031-06-05T19:00:00-07:00'),
    coarse_lat: center.lat,
    coarse_lng: center.lng,
    area_label: center.areaLabel,
    lat: FAR.lat,
    lng: FAR.lng,
  });
  A2 = await approved({
    host_id: hostA.id,
    cuisine: TAG,
    scheduled_start: new Date('2031-06-06T19:00:00-07:00'),
    coarse_lat: FAR.lat,
    coarse_lng: FAR.lng,
    lat: center.lat,
    lng: center.lng,
  });
  B1 = await approved({
    host_id: hostB.id,
    cuisine: TAG,
    scheduled_start: new Date('2031-07-10T19:00:00-07:00'),
    coarse_lat: center.lat + 0.005, // ~0.55 km north — inside RADIUS_KM
    coarse_lng: center.lng,
  });
  B2 = await approved({
    host_id: hostB.id,
    cuisine: `${TAG}-other`,
    scheduled_start: new Date('2031-06-05T19:00:00-07:00'),
    coarse_lat: FAR.lat,
    coarse_lng: FAR.lng,
  });

  // One image on A1, attached BEFORE any query so cached pages carry it too (ADR-004).
  a1MediaKey = `listing/${hostA.id}/search-${Date.now()}.jpg`;
  await dbh.insertRow('media_objects', {
    owner_user_id: hostA.id,
    entity_type: 'listing',
    entity_id: A1.id,
    storage_key: a1MediaKey,
    content_type: 'image/jpeg',
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await dbh.closeDb();
  await closeTestRedis();
});

// =============================================================================================
// Build-plan §6.5 — mounting; AB-08 — session gate
// =============================================================================================
describe('routing — basePath override and session gate', () => {
  test('module exports { basePath: "/api/listings", router } and nothing answers at /api/search', async () => {
    expect(searchRoutes.basePath).toBe('/api/listings');
    expect(typeof searchRoutes.router).toBe('function');

    const res = await request(app).get('/api/search/search').set('Cookie', viewerCookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect((await request(app).get('/api/search').set('Cookie', viewerCookie)).status).toBe(404);
  });

  test('GET /api/listings/search reaches the search router (falls through the UUID-constrained listings :id)', async () => {
    const res = await search(viewerCookie, { cuisine: TAG });
    expect(res.status).toBe(200); // answered by U3-SEARCH, not a listings 404
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  test('AB-08: no session → 401, never data', async () => {
    const res = await request(app).get('/api/listings/search').query({ cuisine: TAG });
    expect(res.status).toBe(401);
    expect(res.body.results).toBeUndefined();
  });

  test('non-GET on /api/listings/search is 405 with an Allow header', async () => {
    const res = await request(app)
      .post('/api/listings/search')
      .set('Cookie', viewerCookie)
      .send({});
    expect(res.status).toBe(405);
    expect(res.headers.allow).toContain('GET');
  });
});

// =============================================================================================
// NFR-11 / AB-06 / ST-04 — boundary validation, hostile input
// =============================================================================================
describe('validation — NFR-11 / ST-04 boundary', () => {
  test('unknown query params are stripped, not errors', async () => {
    const res = await search(viewerCookie, {
      cuisine: TAG,
      admin: '1',
      'drop-table': 'users',
      moderation_status: 'pending', // stripping this is also a visibility defence
    });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([A1.id, A2.id, B1.id].sort());
  });

  test('shape violations are field-level 422s with no stack trace', async () => {
    const cases = [
      { hostId: 'not-a-uuid' },
      { from: 'yesterday-ish' },
      { from: '2031-06-01T00:00:00' }, // naive datetime — timezone required (ADR-009)
      { from: '2031-07-01T00:00:00Z', to: '2031-06-01T00:00:00Z' }, // to before from
      { location: 'x'.repeat(201) },
      { location: 'la jolla', radiusKm: '0' },
      { location: 'la jolla', radiusKm: '101' },
      { pageSize: '101' },
      { page: '0' },
    ];
    for (const query of cases) {
      const res = await search(viewerCookie, query);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(Array.isArray(res.body.error.fields)).toBe(true);
      expect(JSON.stringify(res.body)).not.toMatch(/at\s+\S+\s+\(/); // no stack trace
    }
  });

  test('ST-04: SQLi payloads are inert — no 500, tables intact', async () => {
    const sqli = await search(viewerCookie, { location: `' OR 1=1 --`, radiusKm: '2' });
    expect(sqli.status).toBe(200); // resolved as a (nonsense) location; parameterized SQL

    const sqliCuisine = await search(viewerCookie, { cuisine: `'; DROP TABLE users; --` });
    expect(sqliCuisine.status).toBe(200);
    expect(sqliCuisine.body.results).toEqual([]);

    expect(await dbh.countRows('users')).toBeGreaterThan(0); // users survived (ST-04)
    expect(await dbh.countRows('listings')).toBeGreaterThan(0);
  });

  test('ST-04: XSS payloads come back clean — no executable markup in any response', async () => {
    const res = await search(viewerCookie, { cuisine: '<script>alert(1)</script>' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(res.text).not.toContain('<script');
    expect(res.text).not.toContain('onerror=');
  });
});

// =============================================================================================
// FR-01 / FR-08 / AB-01 — visibility invariant
// =============================================================================================
describe('visibility — only approved, active, future listings are ever returned', () => {
  test('pending / rejected / cancelled / past listings never appear (hostId isolates the set)', async () => {
    const res = await search(viewerCookie, { hostId: hostV.id });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([vIn.id]); // exactly the one visible listing of five seeded
    expect(res.body.total).toBe(1);
  });
});

// =============================================================================================
// FR-01 / TC-01 — each filter alone and all combined
// =============================================================================================
describe('filters — TC-01', () => {
  test('cuisine alone returns exactly the tagged listings', async () => {
    const res = await search(viewerCookie, { cuisine: TAG });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([A1.id, A2.id, B1.id].sort());
    expect(res.body.total).toBe(3);
  });

  test('hostId alone returns exactly that host’s visible listings', async () => {
    const res = await search(viewerCookie, { hostId: hostA.id });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([A1.id, A2.id].sort());
  });

  test('from/to alone returns exactly the listings inside the window', async () => {
    const res = await search(viewerCookie, {
      from: '2031-07-01T00:00:00Z',
      to: '2031-08-01T00:00:00Z',
    });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([B1.id]);
  });

  test('location+radiusKm alone: in-radius listings in, far listings out, every result honestly in radius', async () => {
    // pageSize 100: other suites (and a volume seed left by the LT lane, depending on jest
    // file order) may legitimately own in-radius listings scheduled earlier than these 2031
    // fixtures — a wide page keeps the membership assertions order-independent.
    const res = await search(viewerCookie, {
      location: LOC_FILTERS,
      radiusKm: String(RADIUS_KM),
      pageSize: '100',
    });
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBeUndefined();

    const returned = ids(res);
    expect(returned).toContain(A1.id); // coarse at the resolved centre
    expect(returned).toContain(B1.id); // coarse 0.55 km away
    expect(returned).not.toContain(A2.id); // coarse FAR (despite precise at centre)
    expect(returned).not.toContain(B2.id);

    // The filter's own definition, asserted over EVERY result regardless of other fixtures:
    // within radiusKm of at least one resolved area, measured on COARSE coordinates.
    for (const r of res.body.results) {
      const within = areas.some(
        (area) => distanceKm(area, { lat: r.coarseLat, lng: r.coarseLng }) <= RADIUS_KM
      );
      expect(within).toBe(true);
    }
  });

  test('ADR-010: distance filtering uses coarse coordinates, never the precise pair', async () => {
    const res = await search(viewerCookie, {
      location: LOC_FILTERS,
      radiusKm: String(RADIUS_KM),
      pageSize: '100',
    });
    const returned = ids(res);
    // A1: precise coordinates FAR away, coarse at the centre → returned.
    expect(returned).toContain(A1.id);
    // A2: precise coordinates AT the centre, coarse FAR away → not returned. A search reading
    // lat/lng instead of coarse_lat/coarse_lng would invert both of these.
    expect(returned).not.toContain(A2.id);
  });

  test('all four filters combined return exactly the one matching listing', async () => {
    const res = await search(viewerCookie, {
      location: LOC_FILTERS,
      radiusKm: String(RADIUS_KM),
      from: '2031-06-01T00:00:00Z',
      to: '2031-06-30T00:00:00Z',
      hostId: hostA.id,
      cuisine: TAG,
    });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([A1.id]);
    expect(res.body.total).toBe(1);
  });

  test('pagination is deterministic (scheduled_start, id) with a stable total', async () => {
    const page1 = await search(viewerCookie, { cuisine: TAG, pageSize: '2', page: '1' });
    const page2 = await search(viewerCookie, { cuisine: TAG, pageSize: '2', page: '2' });
    expect(page1.body.results.map((r) => r.id)).toEqual([A1.id, A2.id]); // June 5, June 6
    expect(page2.body.results.map((r) => r.id)).toEqual([B1.id]); // July 10
    expect(page1.body.total).toBe(3);
    expect(page2.body.total).toBe(3);
    expect(page1.body.page).toBe(1);
    expect(page2.body.page).toBe(2);
  });
});

// =============================================================================================
// ADR-010 / AB-08 / NFR-13 — public shape only
// =============================================================================================
describe('response shape — publicListing allowlist on every result', () => {
  test('every result is EXACTLY the public key allowlist; no address, precise coords, or contact data', async () => {
    const res = await search(viewerCookie, { cuisine: TAG });
    expect(res.body.results.length).toBeGreaterThan(0);
    for (const result of res.body.results) {
      expect(Object.keys(result).sort()).toEqual([...serializers.PUBLIC_KEYS].sort());
      for (const forbidden of serializers.PRIVILEGED_ONLY_KEYS) {
        expect(result).not.toHaveProperty(forbidden);
      }
    }
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(EMAIL_SHAPE); // no host contact data (AB-08)
    expect(text).not.toMatch(/address_line|addressLine|postal/i);
  });

  test('images ride along, derived from media_objects storage keys (ADR-004)', async () => {
    const res = await search(viewerCookie, { cuisine: TAG });
    const a1 = res.body.results.find((r) => r.id === A1.id);
    expect(a1.images).toHaveLength(1);
    expect(a1.images[0].url).toContain(a1MediaKey);
    expect(a1.images[0].contentType).toBe('image/jpeg');
  });
});

// =============================================================================================
// NFR-01 / FR-01 — Redis page cache: repeat query costs zero adapter calls
// =============================================================================================
describe('caching — result pages in Redis, public precision only', () => {
  test('a repeat identical query performs ZERO Maps adapter calls (page-cache hit)', async () => {
    // Distinctive precise coordinates prove precision hygiene on the cached value below.
    const probeAreas = (await maps.searchArea(LOC_CACHE)).areas;
    const cacheHost = await dbh.makeUser({ can_publish_listing: true });
    const cached = await approved({
      host_id: cacheHost.id,
      cuisine: `${TAG}-cache`,
      coarse_lat: probeAreas[0].lat,
      coarse_lng: probeAreas[0].lng,
      area_label: probeAreas[0].areaLabel,
      lat: 32.123456,
      lng: -117.654321,
    });

    const spy = jest.spyOn(maps, 'searchArea');
    const query = { location: LOC_CACHE, radiusKm: '3', pageSize: '50' };

    const first = await search(viewerCookie, query);
    expect(first.status).toBe(200);
    expect(ids(first)).toContain(cached.id);
    expect(spy).toHaveBeenCalledTimes(1);

    const second = await search(viewerCookie, query);
    expect(second.status).toBe(200);
    expect(ids(second)).toEqual(ids(first));
    expect(spy).toHaveBeenCalledTimes(1); // ZERO additional adapter calls (NFR-01)
  });

  test('the cached value read directly from Redis is public precision only; its key carries no location text', async () => {
    const normalized = searchService.normalizeQuery({
      location: LOC_CACHE,
      radiusKm: 3,
      page: 1,
      pageSize: 50,
    });
    const cacheKey = searchService.cacheKeyFor(normalized);
    expect(cacheKey).toMatch(/^hp:cache:search:page:[0-9a-f]{32}$/); // digest, never the query
    expect(cacheKey).not.toContain('pacific');

    const raw = await redis.get(cacheKey);
    expect(raw).not.toBeNull(); // the previous test cached this exact page
    expect(raw).not.toMatch(EMAIL_SHAPE);
    expect(raw).not.toContain('32.123456'); // the precise pair never reaches Redis (ADR-010)
    expect(raw).not.toContain('-117.654321');
    expect(raw).not.toMatch(/addressLine|address_line|postal/i);

    const page = JSON.parse(raw);
    expect(page.results.length).toBeGreaterThan(0);
    for (const result of page.results) {
      expect(Object.keys(result).sort()).toEqual([...serializers.PUBLIC_KEYS].sort());
      expect(result).not.toHaveProperty('lat');
      expect(result).not.toHaveProperty('lng');
    }
  });

  test('equivalent location spellings normalize onto one cache cell', () => {
    const a = searchService.normalizeQuery({
      location: '  Pacific   BEACH cache PROBE ',
      radiusKm: 3,
      page: 1,
      pageSize: 20,
    });
    const b = searchService.normalizeQuery({
      location: 'pacific beach cache probe',
      radiusKm: 3,
      page: 1,
      pageSize: 20,
    });
    expect(searchService.cacheKeyFor(a)).toBe(searchService.cacheKeyFor(b));
    // radiusKm without a location is normalized away — it cannot fragment the browse cache.
    const bare = searchService.normalizeQuery({ page: 1, pageSize: 20 });
    const bareWithRadius = searchService.normalizeQuery({ radiusKm: 50, page: 1, pageSize: 20 });
    expect(searchService.cacheKeyFor(bare)).toBe(searchService.cacheKeyFor(bareWithRadius));
  });
});

// =============================================================================================
// NFR-09 / RT-01 — degraded mode with Maps down
// =============================================================================================
describe('degraded mode — Maps outage (NFR-09, RT-01)', () => {
  test('adapter serving its stale cached area → 200 with degraded:true, and the page is NOT cached', async () => {
    const staleArea = { lat: 32.71, lng: -117.16, areaLabel: 'Stale Cached Area' };
    const staleHost = await dbh.makeUser({ can_publish_listing: true });
    const nearStale = await approved({
      host_id: staleHost.id,
      cuisine: `${TAG}-stale`,
      coarse_lat: staleArea.lat,
      coarse_lng: staleArea.lng,
    });

    // The adapter's documented NFR-09 outage behaviour (tested against the real adapter in
    // tests/unit/adapter-maps.test.js): stale Redis copy + degraded flag.
    const spy = jest
      .spyOn(maps, 'searchArea')
      .mockResolvedValue({ areas: [staleArea], degraded: true, source: 'cache-degraded' });

    const query = { location: 'degraded stale probe', radiusKm: '2', pageSize: '100' };
    const res = await search(viewerCookie, query);
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true); // stale-served, flagged (NFR-09)
    expect(ids(res)).toContain(nearStale.id);

    // Degraded pages are never cached: the identical query consults the adapter again.
    const again = await search(viewerCookie, query);
    expect(again.status).toBe(200);
    expect(again.body.degraded).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('uncached location query during the outage → typed 503 SEARCH_DEGRADED with a user-facing message, never a 500', async () => {
    const spy = jest.spyOn(maps, 'searchArea').mockRejectedValue(
      new ServiceUnavailableError('provider unavailable and no cached result to serve', {
        code: 'MAPS_UNAVAILABLE',
      })
    );

    const res = await search(viewerCookie, { location: LOC_OUTAGE, radiusKm: '2' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SEARCH_DEGRADED');
    expect(res.body.error.message).toMatch(/temporarily unavailable/i); // user-facing
    expect(res.body.error.message).toMatch(/try again|without a location/i);
    expect(JSON.stringify(res.body)).not.toMatch(/at\s+\S+\s+\(/); // no stack trace

    // Non-location queries are entirely unaffected — the adapter is never consulted.
    const before = spy.mock.calls.length;
    const plain = await search(viewerCookie, { cuisine: TAG });
    expect(plain.status).toBe(200);
    expect(ids(plain)).toEqual([A1.id, A2.id, B1.id].sort());
    expect(spy.mock.calls.length).toBe(before); // zero adapter calls without a location
  });

  test('a previously page-cached location query still answers with the provider down', async () => {
    // Prime the page cache while healthy.
    const primed = await search(viewerCookie, { location: LOC_PAGECACHE, radiusKm: '3' });
    expect(primed.status).toBe(200);

    const spy = jest
      .spyOn(maps, 'searchArea')
      .mockRejectedValue(new ServiceUnavailableError('maps down', { code: 'MAPS_UNAVAILABLE' }));

    const res = await search(viewerCookie, { location: LOC_PAGECACHE, radiusKm: '3' });
    expect(res.status).toBe(200); // served from the Redis page cache (NFR-09)
    expect(ids(res)).toEqual(ids(primed));
    expect(spy).not.toHaveBeenCalled();
  });
});

// =============================================================================================
// NFR-02 / LT-02 — EXPLAIN at volume-seed scale: index usage, no seq scan on listings
// =============================================================================================
describe('NFR-02 — volume seed and EXPLAIN', () => {
  beforeAll(async () => {
    await seed({ set: 'volume', log: { log: () => {} } });
  }, 180000);

  afterAll(async () => {
    // Return the shared test database to the base seeded state for whatever runs next.
    await dbh.reseedBase();
  }, 180000);

  /** Collect every plan node of an EXPLAIN (FORMAT JSON) tree. */
  function planNodes(plan, out = []) {
    out.push(plan);
    for (const child of plan.Plans || []) planNodes(child, out);
    return out;
  }

  async function explainNodes(built) {
    const { rows } = await dbh.query(`EXPLAIN (FORMAT JSON) ${built.text}`, built.values);
    return planNodes(rows[0]['QUERY PLAN'][0].Plan);
  }

  function expectNoListingsSeqScan(nodes) {
    const seqScans = nodes.filter(
      (n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'listings'
    );
    expect(seqScans).toEqual([]);
    expect(nodes.some((n) => (n['Node Type'] || '').includes('Index'))).toBe(true);
  }

  test('the volume dataset meets the NFR-02 floors', async () => {
    expect(await dbh.countRows('users')).toBeGreaterThanOrEqual(10000);
    const { rows } = await dbh.query(
      `SELECT count(*)::int AS n FROM listings
       WHERE local_date = '2026-09-15' AND status = 'active' AND moderation_status = 'approved'`
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(1000);
    expect(await dbh.countRows('bookings')).toBeGreaterThanOrEqual(1000);
  });

  test('EXPLAIN: bare browse, host, cuisine, geo and all-combined queries all avoid a listings seq scan', async () => {
    const hostId = 'e0000000-0000-4000-8000-000000000000'; // volume host 0
    const areasVol = [{ lat: 32.75, lng: -117.2 }];

    const queries = [
      searchRepo.buildSearchQuery({ limit: 20, offset: 0 }),
      searchRepo.buildSearchQuery({ hostId, limit: 20, offset: 0 }),
      searchRepo.buildSearchQuery({ cuisine: 'mexican', limit: 20, offset: 0 }),
      searchRepo.buildSearchQuery({ areas: areasVol, radiusKm: 2, limit: 20, offset: 0 }),
      searchRepo.buildSearchQuery({
        hostId,
        cuisine: 'american',
        from: '2026-09-15T00:00:00Z',
        to: '2026-09-17T00:00:00Z',
        areas: areasVol,
        radiusKm: 5,
        limit: 20,
        offset: 0,
      }),
      searchRepo.buildCountQuery({ areas: areasVol, radiusKm: 2 }),
    ];
    for (const built of queries) {
      expectNoListingsSeqScan(await explainNodes(built));
    }
  });

  test('the search API stays correct and page-bounded at volume', async () => {
    const res = await search(viewerCookie, {
      from: '2026-09-15T00:00:00Z',
      to: '2026-09-17T00:00:00Z',
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(20); // pageSize default cap, not 1000 rows
    expect(res.body.total).toBeGreaterThanOrEqual(1000);
    for (const result of res.body.results) {
      expect(Object.keys(result).sort()).toEqual([...serializers.PUBLIC_KEYS].sort());
    }
  });
});
