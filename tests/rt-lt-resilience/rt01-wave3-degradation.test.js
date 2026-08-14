// tests/rt-lt-resilience/rt01-wave3-degradation.test.js — RT-01 on the WAVE-3 HTTP surface
// (SRS §4.4, NFR-09; ADR-002/004/005/007/011). Extends the wave-2 adapter-level drills in
// rt01-degradation.test.js with the read/write paths that now exist: GET /api/listings/search,
// POST /api/bookings, POST /api/listings, GET /api/listings/:id.
//
// Outage lever: the shared adapter module objects are monkey-patched through the require
// cache (wave3.patchFn) — the exact function the application resolves at call time — so every
// drill exercises the REAL route → service → repo → serializer chain with only the external
// provider call replaced. Restores run in finally/afterEach so no drill leaks.
'use strict';

const request = require('supertest');

const { createApp } = require('../../src/app');
const maps = require('../../src/adapters/maps');
const objectStorage = require('../../src/adapters/objectStorage');
const llmMock = require('../../src/adapters/llmModeration.mock');
const mockTransport = require('../../src/adapters/mockTransport');
const { ServiceUnavailableError } = require('../../src/lib/errors');
const { pollOnce } = require('../../src/outbox/worker');
const { loadHandlers } = require('../../src/outbox/dispatch');

const dbh = require('../helpers/db');
const rh = require('../helpers/redis');
const { quietLogger } = require('./helpers');
const w3 = require('./wave3');

const quiet = quietLogger();
let app;

function mapsOutageError() {
  return new ServiceUnavailableError('maps.searchArea: provider unavailable and no cached result', {
    code: 'MAPS_UNAVAILABLE',
  });
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

describe('RT-01 wave-3 drill 1 — Google Maps outage against GET /api/listings/search (NFR-09, ADR-005)', () => {
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
    // The adapter-level stale-cache fallback (proven live in rt01-degradation.test.js drill 1)
    // is simulated at the adapter boundary so the service/route degraded contract is exercised.
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

describe('RT-01 wave-3 drill 2 — notification provider outage against POST /api/bookings (FR-12/FR-13, ADR-011)', () => {
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

describe('RT-01 wave-3 drill 3 — moderation LLM outage against POST /api/listings (FR-08, ADR-002/007)', () => {
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

    // The moderation.scan job is committed and deferred — a worker cycle during the outage
    // must leave it queued (wave 3 has no moderation handler yet; either way it may NOT
    // complete as an approval) and the listing must still be pending afterwards.
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
      `SELECT status FROM outbox_jobs WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
      [listingId]
    );
    expect(scanAfter[0].status).toBe('pending'); // deferred, not dropped, not dead yet

    // Publicly invisible while pending: search never returns it (FR-08/ADR-002).
    const search = await request(app)
      .get('/api/listings/search')
      .query({ cuisine: 'rt01llmdrill' })
      .set('Cookie', guestCookie);
    expect(search.status).toBe(200);
    expect(search.body.results).toHaveLength(0);
  }, 30000);
});

describe('RT-01 wave-3 drill 4 — object storage outage against GET /api/listings/:id (ADR-004)', () => {
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
    const boom = async () => {
      throw new ServiceUnavailableError('storage outage drill', {
        code: 'OBJECT_STORAGE_UNAVAILABLE',
      });
    };
    const restores = ['put', 'get', 'deleteByKey'].map((fn) => w3.patchFn(objectStorage, fn, boom));
    try {
      const res = await request(app).get(`/api/listings/${listing.id}`).set('Cookie', cookie);
      expect(res.status).toBe(200); // never a 500 (NFR-09 acceptance)
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

describe('RT-01 wave-3 drill 5 — combined Google-side outage: Maps AND moderation LLM down at once (NFR-09 acceptance)', () => {
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
