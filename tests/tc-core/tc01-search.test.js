// tests/tc-core/tc01-search.test.js — TC-01 / FR-01: search meals by location, time, host,
// cuisine (SRS §3.1; acceptance per docs/_generated/requirements-inventory.json).
//
// Asserted here, by execution against the seeded test DB (SRS §4.1):
//   - each filter alone (location+radiusKm, from/to window, hostId, cuisine) and all four
//     combined return exactly the expected listing IDs;
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
'use strict';

const request = require('supertest');

const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const serializers = require('../../src/modules/listings/serializers');
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
    const first = await search({ location: LOC_MAIN, radiusKm: RADIUS_KM, cuisine: CUISINE });
    expect(first.status).toBe(200);
    expect(ids(first)).toEqual([inWindowA.id]);

    // Result page in Redis with a TTL (FR-01 acceptance).
    const [, pageKeys] = await redis.scan('0', 'MATCH', 'hp:cache:search:page:*', 'COUNT', 500);
    expect(pageKeys.length).toBeGreaterThan(0);
    const ttl = await redis.ttl(pageKeys[0]);
    expect(ttl).toBeGreaterThan(0);

    const spy = jest.spyOn(maps, 'searchArea');
    const second = await search({ location: LOC_MAIN, radiusKm: RADIUS_KM, cuisine: CUISINE });
    expect(second.status).toBe(200);
    expect(ids(second)).toEqual([inWindowA.id]);
    expect(spy).not.toHaveBeenCalled(); // zero adapter calls (page cache answered)
  });

  test('ADR-010: the cached page value holds PUBLIC precision only — never the street address or precise coordinates', async () => {
    await flushNamespace('cache');
    const res = await search({ location: LOC_MAIN, radiusKm: RADIUS_KM, cuisine: CUISINE });
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([inWindowA.id]);

    let cursor = '0';
    const values = [];
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

    // Degraded pages are not cached: the identical query consults the adapter again.
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
