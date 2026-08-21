// tests/tc-core/tc01-search.test.js — TC-01 / FR-01: search meals by location, time, host,
// cuisine (SRS §3.1; acceptance per docs/_generated/requirements-inventory.json).
//
// Asserted here, by execution against the seeded test DB (SRS §4.1):
//   - each filter alone (location+radiusKm, from/to window, hostId, cuisine) and all four
//     combined return exactly the expected listing IDs;
//   - the acceptance clause "the resolved COORDINATES … are written to Redis with a TTL"
//     (the ADR-005 geocode cache, distinct from the result-page cache) and the
//     {page, pageSize, total} paging contract the LT-01 harness depends on;
//   - NFR-12 erasure direction on search: a soft-deleted host's listings are never offered
//     (findings TCC-02 / TCC-RV-02);
//   - only approved + active + future listings are returned — a pending/rejected/cancelled/
//     past listing seeded in range is never returned;
//   - the result page lands in Redis with a TTL and a second identical query performs ZERO
//     Maps adapter calls (adapter spy);
//   - NFR-09 degraded mode: with the adapter down, a previously page-cached query still
//     answers; a stale-cache (degraded:true) adapter answer is passed through as
//     `degraded: true` and never page-cached; an uncached location query is a typed 503;
//   - ADR-010/AB-08: results are EXACTLY the publicListing key allowlist; the Redis page
//     cache holds public precision only (raw value audited for the seeded street address and
//     precise coordinates); unauthenticated → 401.
//
// Cache assertions here read the EXACT page key (see readCachedPage) rather than sampling the
// keyspace with one SCAN pass, which under-reports on a busy index. Parallel lanes must still
// get their own TEST_DATABASE_URL / TEST_REDIS_URL / OBJECT_STORAGE_BUCKET: sharing an index
// means another run's flush can delete this lane's cache cell mid-test.
'use strict';

const request = require('supertest');

const { createApp } = require('../../src/app');
const config = require('../../src/config');
const { createLogger } = require('../../src/lib/logger');
const serializers = require('../../src/modules/listings/serializers');
const searchSchemas = require('../../src/schemas/search');
const searchService = require('../../src/modules/search/service');
const maps = require('../../src/adapters/maps');
const dbh = require('../helpers/db');
const { redis, closeTestRedis, flushNamespace } = require('../helpers/redis');
const support = require('./support');

const sink = { write() {} };
let app;

// Unique per-run markers so this lane's fixtures are isolated inside the shared test DB.
const RUN = `${process.pid}${Date.now() % 1e7}`;
const CUISINE = `tc01cuisine${RUN}`;
const OTHER_CUISINE = `tc01other${RUN}`;
const STREET = `742 Tc01 Evergreen Terrace ${RUN}`;
const PRECISE = { lat: 32.712345, lng: -117.187654 };

// Deterministic mock-Maps location strings (one per concern — no cache-cell collisions).
const LOC_MAIN = `tc01 filters ${RUN}`;
const LOC_OUTAGE_CACHED = `tc01 cached outage ${RUN}`;
const LOC_OUTAGE_COLD = `tc01 cold outage ${RUN}`;
const RADIUS_KM = 2;
const FAR = { lat: 25.0, lng: -100.0 }; // > 1000 km from every mock San Diego area

// Distinct far-future window nothing else in the shared DB occupies.
const WINDOW_DAY_1 = '2033-03-03T19:00:00.000Z';
const WINDOW_DAY_2 = '2033-03-04T19:00:00.000Z';
const WINDOW_FROM = '2033-03-01T00:00:00Z';
const WINDOW_TO = '2033-03-06T00:00:00Z';

let center; // mock areas[0] for LOC_MAIN
let hostA;
let hostB;
let viewerCookie;
let inWindowA; // hostA, CUISINE, WINDOW_DAY_1, coarse at center  (matches every filter)
let inWindowB; // hostB, CUISINE, WINDOW_DAY_2, coarse FAR        (cuisine+window, not location)
let outWindow; // hostA, CUISINE, far outside the window, coarse FAR
let otherCuisine; // hostB, OTHER_CUISINE, in window, coarse FAR

function ids(res) {
  return res.body.results.map((r) => r.id).sort();
}

function search(query, cookie = viewerCookie) {
  return request(app).get('/api/listings/search').set('Cookie', cookie).query(query);
}

/**
 * The EXACT Redis page key the service derives for a query, produced by running the
 * PRODUCTION path (boundary schema parse → normalizeQuery → cacheKeyFor) instead of
 * re-deriving a key shape here — so this stays a check of the real cache cell.
 */
function pageCacheKey(query) {
  return searchService.cacheKeyFor(searchService.normalizeQuery(searchSchemas.query.parse(query)));
}

/**
 * Read one query's cached result page back by exact key.
 *
 * A single `SCAN 0 MATCH hp:cache:search:page:* COUNT n` is a SAMPLE of the keyspace, not an
 * existence check: Redis only guarantees a complete iteration once the cursor returns to '0',
 * so as soon as the shared test index holds more than ~512 keys (session keys accumulate for
 * the whole run and flushNamespace('cache') does not clear them) one pass returns a non-zero
 * cursor and reports ZERO matches for a key that provably exists. That false negative — not a
 * product defect — is what made this cell fail under load (finding TCC-05). Reading the exact
 * key is deterministic AND a stronger assertion: it proves THIS query's page is the cached
 * one, not merely that some page key exists.
 *
 * The bounded re-issue covers the other half: src/lib/cache.set deliberately swallows a failed
 * Redis write (NFR-09 — a lost cache write costs latency, never correctness), so on a
 * genuinely contended box the first attempt may not have landed. Re-running the IDENTICAL
 * query re-attempts the write; the assertions at the call site are unchanged and still fail if
 * no page is ever cached.
 * @param {object} query
 * @returns {Promise<{cacheKey: string, raw: string|null, ttl: number}>}
 */
async function readCachedPage(query, { timeoutMs = 2000 } = {}) {
  const cacheKey = pageCacheKey(query);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = await redis.get(cacheKey);
    const ttl = await redis.ttl(cacheKey);
    if (raw !== null && ttl > 0) return { cacheKey, raw, ttl };
    if (Date.now() >= deadline) return { cacheKey, raw, ttl };
    await search(query); // rebuild the page and re-attempt the swallowed-on-failure write
  }
}

beforeAll(async () => {
  app = createApp({ logger: createLogger({ level: 'silent', stream: sink }) });
  viewerCookie = await support.cookieFor(await dbh.makeUser());

  // Resolve the deterministic mock area the location fixtures anchor to.
  const resolved = await maps.searchArea(LOC_MAIN);
  center = resolved.areas[0];
  expect(center).toBeDefined();

  hostA = await dbh.makeUser({ can_publish_listing: true });
  hostB = await dbh.makeUser({ can_publish_listing: true });

  inWindowA = await support.makeApprovedListing({
    host_id: hostA.id,
    cuisine: CUISINE,
    scheduled_start: new Date(WINDOW_DAY_1),
    coarse_lat: center.lat,
    coarse_lng: center.lng,
    area_label: center.areaLabel || 'Test Area',
    address_line1: STREET,
    lat: PRECISE.lat,
    lng: PRECISE.lng,
  });
  inWindowB = await support.makeApprovedListing({
    host_id: hostB.id,
    cuisine: CUISINE,
    scheduled_start: new Date(WINDOW_DAY_2),
    coarse_lat: FAR.lat,
    coarse_lng: FAR.lng,
  });
  outWindow = await support.makeApprovedListing({
    host_id: hostA.id,
    cuisine: CUISINE,
    scheduled_start: new Date('2034-07-07T19:00:00Z'),
    coarse_lat: FAR.lat,
    coarse_lng: FAR.lng,
  });
  otherCuisine = await support.makeApprovedListing({
    host_id: hostB.id,
    cuisine: OTHER_CUISINE,
    scheduled_start: new Date('2033-03-03T21:00:00Z'),
    coarse_lat: FAR.lat,
    coarse_lng: FAR.lng,
  });

  // Visibility counter-fixtures: seeded IN range/cuisine but never returnable (FR-08/AB-01).
  // Each gets its own host so the FR-11 (host, local_date) unique index can never collide
  // with the visible fixtures above.
  const hostPending = await dbh.makeUser({ can_publish_listing: true });
  const hostRejected = await dbh.makeUser({ can_publish_listing: true });
  const hostCancelled = await dbh.makeUser({ can_publish_listing: true });
  const hostPast = await dbh.makeUser({ can_publish_listing: true });
  await dbh.makeListing({
    host_id: hostPending.id,
    cuisine: CUISINE,
    scheduled_start: new Date('2033-03-03T20:00:00Z'),
    moderation_status: 'pending',
    status: 'active',
  });
  await dbh.makeListing({
    host_id: hostRejected.id,
    cuisine: CUISINE,
    scheduled_start: new Date('2033-03-05T20:00:00Z'),
    moderation_status: 'rejected',
    status: 'active',
  });
  await dbh.makeListing({
    host_id: hostCancelled.id,
    cuisine: CUISINE,
    scheduled_start: new Date('2033-03-05T22:00:00Z'),
    moderation_status: 'approved',
    status: 'cancelled',
  });
  await dbh.makeListing({
    host_id: hostPast.id,
    cuisine: CUISINE,
    scheduled_start: new Date('2020-01-05T20:00:00Z'), // past
    moderation_status: 'approved',
    status: 'active',
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  await closeTestRedis();
  await dbh.closeDb();
});

describe('TC-01 / FR-01 — filters, alone and combined', () => {
  test('cuisine alone returns exactly the approved/active/future listings of that cuisine', async () => {
    const res = await search({ cuisine: CUISINE });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([inWindowA.id, inWindowB.id, outWindow.id].sort());
  });

  test('hostId alone returns exactly that host approved/active/future listings', async () => {
    const res = await search({ hostId: hostA.id });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([inWindowA.id, outWindow.id].sort());
  });

  test('from/to window alone returns exactly the listings inside the window', async () => {
    const res = await search({ from: WINDOW_FROM, to: WINDOW_TO });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([inWindowA.id, inWindowB.id, otherCuisine.id].sort());
  });

  test('location+radiusKm alone returns exactly the listings whose COARSE point is in range', async () => {
    const res = await search({ location: LOC_MAIN, radiusKm: RADIUS_KM, cuisine: CUISINE });
    expect(res.status).toBe(200);
    // inWindowA sits coarse-at-center; every other CUISINE fixture is coarse-FAR (>1000 km).
    expect(ids(res)).toEqual([inWindowA.id]);
  });

  test('all four filters combined return exactly the one listing matching them all', async () => {
    const res = await search({
      location: LOC_MAIN,
      radiusKm: RADIUS_KM,
      from: WINDOW_FROM,
      to: WINDOW_TO,
      hostId: hostA.id,
      cuisine: CUISINE,
    });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([inWindowA.id]);
  });

  test('pending/rejected/cancelled/past listings seeded in range are never returned', async () => {
    const res = await search({ cuisine: CUISINE, from: WINDOW_FROM, to: WINDOW_TO });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([inWindowA.id, inWindowB.id].sort());
  });
});

describe('TC-01 / FR-01 — Redis result cache + zero adapter calls on repeat (NFR-01)', () => {
  test('the result page is cached with a TTL and an identical repeat performs zero Maps adapter calls', async () => {
    await flushNamespace('cache'); // clean cell: this test owns the cache namespace state
    const query = { location: LOC_MAIN, radiusKm: RADIUS_KM, cuisine: CUISINE };
    const first = await search(query);
    expect(first.status).toBe(200);
    expect(ids(first)).toEqual([inWindowA.id]);

    // Result page in Redis, under the documented digest-keyed namespace, with a live TTL
    // bounded by the configured search TTL (FR-01 acceptance). Read by exact key, never by a
    // single-pass SCAN — see readCachedPage.
    const cached = await readCachedPage(query);
    expect(cached.cacheKey).toMatch(/^hp:cache:search:page:[0-9a-f]{32}$/);
    expect(cached.raw).not.toBeNull();
    expect(cached.ttl).toBeGreaterThan(0);
    expect(cached.ttl).toBeLessThanOrEqual(config.search.cacheTtlSeconds);
    // …and it is THIS query's page, not merely some page.
    expect(JSON.parse(cached.raw).results.map((r) => r.id)).toEqual([inWindowA.id]);

    const spy = jest.spyOn(maps, 'searchArea');
    const second = await search(query);
    expect(second.status).toBe(200);
    expect(ids(second)).toEqual([inWindowA.id]);
    expect(spy).not.toHaveBeenCalled(); // zero adapter calls (page cache answered)
  });

  test('ADR-010: the cached page value holds PUBLIC precision only — never the street address or precise coordinates', async () => {
    await flushNamespace('cache');
    const query = { location: LOC_MAIN, radiusKm: RADIUS_KM, cuisine: CUISINE };
    const res = await search(query);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([inWindowA.id]);

    // The page under audit, read by exact key: the sweep below must audit at least this value,
    // and a single SCAN pass cannot be trusted to surface it (see readCachedPage).
    const cached = await readCachedPage(query);
    expect(cached.raw).not.toBeNull();

    let cursor = '0';
    const values = [cached.raw];
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'hp:cache:*', 'COUNT', 500);
      cursor = next;
      for (const key of keys) {
        // Keys are digests — a location string / address must never appear in a key name.
        expect(key).not.toMatch(/tc01|evergreen/i);
        const value = await redis.get(key);
        if (value) values.push(value);
      }
    } while (cursor !== '0');
    expect(values.length).toBeGreaterThan(0);
    const blob = values.join('\n');
    expect(blob).not.toContain(STREET);
    expect(blob).not.toContain('742 Tc01');
    expect(blob).not.toContain(String(PRECISE.lat));
    expect(blob).not.toContain(String(PRECISE.lng));
    expect(blob).not.toContain('addressLine1');
  });
});

describe('TC-01 / FR-01 — ADR-010 public serializer + AB-08 session gate', () => {
  test('every result is EXACTLY the publicListing key allowlist; no address/precise coords/host contact data', async () => {
    const res = await search({ cuisine: CUISINE });
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThan(0);
    for (const item of res.body.results) {
      expect(Object.keys(item).sort()).toEqual([...serializers.PUBLIC_KEYS].sort());
    }
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(STREET);
    expect(raw).not.toContain(String(PRECISE.lat));
    expect(raw).not.toContain(String(PRECISE.lng));
    expect(raw).not.toMatch(support.EMAIL_SHAPE);
  });

  test('unauthenticated search is refused with 401 (AB-08)', async () => {
    const res = await request(app).get('/api/listings/search').query({ cuisine: CUISINE });
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

describe('TC-01 / FR-01 — NFR-09 degraded mode (Maps outage)', () => {
  test('with the adapter down, a previously page-cached query still returns results', async () => {
    await flushNamespace('cache');
    const warm = await search({ location: LOC_OUTAGE_CACHED, cuisine: CUISINE });
    expect(warm.status).toBe(200);

    const spy = jest
      .spyOn(maps, 'searchArea')
      .mockRejectedValue(new Error('simulated Maps outage'));
    const during = await search({ location: LOC_OUTAGE_CACHED, cuisine: CUISINE });
    expect(during.status).toBe(200);
    expect(during.body.results.map((r) => r.id).sort()).toEqual(
      warm.body.results.map((r) => r.id).sort()
    );
    expect(spy).not.toHaveBeenCalled(); // served from the page cache, provider never touched
    // A page-cache hit is NOT a degraded answer: the flag must be absent (re-verify TCC-03(i)).
    expect(during.body.degraded).toBeUndefined();
  });

  test('a stale-cache adapter answer surfaces as degraded:true and the degraded page is never cached', async () => {
    await flushNamespace('cache');
    const spy = jest.spyOn(maps, 'searchArea').mockResolvedValue({
      areas: [{ lat: center.lat, lng: center.lng, areaLabel: 'Stale Area' }],
      degraded: true,
    });
    const first = await search({
      location: LOC_OUTAGE_CACHED,
      radiusKm: RADIUS_KM,
      cuisine: CUISINE,
    });
    expect(first.status).toBe(200);
    expect(first.body.degraded).toBe(true);
    expect(first.body.results.map((r) => r.id)).toEqual([inWindowA.id]);

    // Degraded pages are not cached — proven twice (re-verify TCC-03(ii)): the exact page
    // key is absent from Redis, and the identical query consults the adapter again.
    expect(
      await redis.get(
        pageCacheKey({ location: LOC_OUTAGE_CACHED, radiusKm: RADIUS_KM, cuisine: CUISINE })
      )
    ).toBeNull();
    const second = await search({
      location: LOC_OUTAGE_CACHED,
      radiusKm: RADIUS_KM,
      cuisine: CUISINE,
    });
    expect(second.status).toBe(200);
    expect(second.body.degraded).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('an uncached location query during the outage is a typed 503 SEARCH_DEGRADED, never a 500', async () => {
    await flushNamespace('cache');
    jest.spyOn(maps, 'searchArea').mockRejectedValue(new Error('simulated Maps outage'));
    const res = await search({ location: LOC_OUTAGE_COLD, cuisine: CUISINE });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SEARCH_DEGRADED');
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body.error.message.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toMatch(/at\s+\S+\s+\(/); // no stack trace (NFR-08)
  });

  test('non-location queries are unaffected by the outage', async () => {
    jest.spyOn(maps, 'searchArea').mockRejectedValue(new Error('simulated Maps outage'));
    const res = await search({ cuisine: CUISINE });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([inWindowA.id, inWindowB.id, outWindow.id].sort());
  });
});

describe('TC-01 / FR-01 — geocode-coordinate cache and the paging contract (acceptance gaps)', () => {
  const LOC_GEOCACHE = `tc01 geocache ${RUN}`;
  const PAGING_CUISINE = `tc01paging${RUN}`;

  /** Every 'hp:cache:maps:*' key currently in this lane's Redis index (SCAN, never KEYS). */
  async function mapsCacheKeys() {
    let cursor = '0';
    const keys = [];
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', 'hp:cache:maps:*', 'COUNT', 500);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  test('a location query writes the RESOLVED COORDINATES to Redis with a TTL, at public precision only', async () => {
    // Determinism (finding MTUT-RV-03): this test used to open with flushNamespace('cache'),
    // which deletes EVERY 'hp:cache:*' key in the lane — every other suite's cached search
    // pages and geocodes, not just this one's. It was unnecessary: LOC_GEOCACHE carries the
    // per-run RUN token, so no earlier suite (or earlier run) can have cached it and the
    // ADR-005 adapter is guaranteed to be called. Scoping replaces flushing: snapshot the
    // maps-cache keyspace, fire the query, and assert on the keys THIS query added. That is
    // strictly stronger than the old form — after a flush the surviving keys were this test's
    // by construction, so the old sweep proved only "some key exists", while the diff proves
    // this query wrote one.
    const before = new Set(await mapsCacheKeys());

    const res = await search({ location: LOC_GEOCACHE, radiusKm: 5 });
    expect(res.status).toBe(200);

    // The ADR-005 adapter's own geocode cache — separate from the result-page cache.
    const allKeys = await mapsCacheKeys();
    const geoKeys = allKeys.filter((k) => !before.has(k));
    expect(geoKeys.length).toBeGreaterThan(0);

    for (const key of geoKeys) {
      expect(await redis.ttl(key)).toBeGreaterThan(0); // TTL, never a permanent entry
      const value = await redis.get(key);
      expect(value).not.toMatch(/addressLine1|postalCode/);
    }

    // ADR-010 is a safety property of the WHOLE keyspace, not just of the keys this query
    // added: a raw location string (possibly a street address) must never appear in any maps
    // cache key. Every location string this file sends carries the 'tc01' marker plus the
    // per-run RUN token, so only this file can put one there — scanning every key costs
    // nothing in determinism and catches a leak written anywhere.
    for (const key of allKeys) {
      expect(key).not.toMatch(/tc01/i);
    }
  });

  test('the response carries the {page, pageSize, total} paging contract and pages do not overlap', async () => {
    const created = [];
    for (let i = 0; i < 3; i += 1) {
      const host = await dbh.makeUser({ can_publish_listing: true });
      created.push(
        await support.makeApprovedListing({
          host_id: host.id,
          cuisine: PAGING_CUISINE,
          scheduled_start: new Date(`203${4 + i}-04-0${i + 1}T18:00:00Z`),
        })
      );
    }

    const page1 = await search({ cuisine: PAGING_CUISINE, page: 1, pageSize: 2 });
    expect(page1.status).toBe(200);
    expect(page1.body.page).toBe(1);
    expect(page1.body.pageSize).toBe(2);
    expect(page1.body.total).toBe(3);
    expect(page1.body.results).toHaveLength(2);

    const page2 = await search({ cuisine: PAGING_CUISINE, page: 2, pageSize: 2 });
    expect(page2.status).toBe(200);
    expect(page2.body.total).toBe(3);
    expect(page2.body.results).toHaveLength(1);

    const seen = [...page1.body.results, ...page2.body.results].map((r) => r.id);
    expect(new Set(seen).size).toBe(3);
    expect(seen.sort()).toEqual(created.map((l) => l.id).sort());
  });
});

// NFR-12 erasure, discovery direction (findings TCC-02 / TCC-RV-02): search is the surface
// that OFFERS meals, so it must never offer a soft-deleted host's listing. The v1.0 deletion
// endpoint is wave-4 U4-PRIVACY; this pins the read-path predicate wave 3 implements
// (src/modules/search/repo.js VISIBLE_PREDICATES) so the cascade is written against a proven
// contract. The retention half (the detail read) lives in tc02-listing-detail.test.js; the
// cascade contract itself in tccrv02-erasure-read-paths.test.js.
describe('TC-01 / FR-01 — NFR-12: a soft-deleted host is never offered by search', () => {
  test('search returns the live host’s listing and never the soft-deleted host’s', async () => {
    const cuisine = `tc01erasure${RUN}`;
    // A live host on the SAME cuisine, so an empty result cannot be mistaken for a broken query.
    const liveHost = await dbh.makeUser({ can_publish_listing: true });
    await dbh.makeHostProfile({ user_id: liveHost.id });
    const liveListing = await support.makeApprovedListing({ host_id: liveHost.id, cuisine });
    const { listing: deletedHostListing } = await support.seedDeletedHostWithListing({ cuisine });

    const res = await search({ cuisine });
    expect(res.status).toBe(200);
    const resultIds = res.body.results.map((r) => r.id);
    expect(resultIds).toContain(liveListing.id);
    // Original TCC-02 failureScenario: 'PROBE search status 200 n= 1' for the deleted host.
    expect(resultIds).not.toContain(deletedHostListing.id);
  });
});
