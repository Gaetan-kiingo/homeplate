// tests/tc-core/tcc-w3-reverify.test.js — INDEPENDENT RE-VERIFICATION of the tc-core lane's
// wave-3 findings (TCC-01..TCC-05) plus the FR-07 surface that landed in repair round 1
// (f7f954c). Written by the re-verification lane; it re-executes each ORIGINAL failureScenario
// verbatim rather than trusting the fixer's claim or the green suite.
//
// Requirement traceability (SRS Appendix B):
//   FR-01 (TC-01) — TCC-02 erasure direction on search; TCC-03 three degraded-mode cases;
//                   TCC-05 page-cache existence under a busy Redis index.
//   FR-02 (TC-02) — TCC-01 host-summary fallback; TCC-04 review-preview truncation (REPAIRED
//                   in this round — the pinning probe is inverted into a regression guard).
//   FR-05 / FR-06  — absence probes (wave 4, must NOT be reported as pass).
//   FR-07 (TC-07, IT-04) — persist → worker → moderator notice + emergency-contact email,
//                   and "failed delivery … remains visible for review".
'use strict';

const request = require('supertest');

const { createApp } = require('../../src/app');
const config = require('../../src/config');
const { createLogger } = require('../../src/lib/logger');
const { encrypt } = require('../../src/db/fieldCrypto');
const maps = require('../../src/adapters/maps');
const mockTransport = require('../../src/adapters/mockTransport');
const searchSchemas = require('../../src/schemas/search');
const searchService = require('../../src/modules/search/service');
const { loadHandlers } = require('../../src/outbox/dispatch');
const { pollOnce } = require('../../src/outbox/worker');
const dbh = require('../helpers/db');
const { redis, closeTestRedis } = require('../helpers/redis');
const support = require('./support');

const sink = { write() {} };
const quietLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() {
    return this;
  },
};

const RUN = `${process.pid}${Date.now() % 1e7}`;
let app;
let registry;

beforeAll(async () => {
  app = createApp({ logger: createLogger({ level: 'silent', stream: sink }) });
  registry = loadHandlers({ log: quietLog });
});

afterAll(async () => {
  jest.restoreAllMocks();
  mockTransport.reset();
  await dbh.closeDb();
  await closeTestRedis();
});

function search(query, cookie) {
  return request(app).get('/api/listings/search').set('Cookie', cookie).query(query);
}

/** Drain every currently-due outbox job (jobs that back off drop out of the loop). */
async function drainDue() {
  let stats;
  do {
    stats = await pollOnce({ registry, log: quietLog });
  } while (stats.claimed > 0);
}

// =============================================================================================
// TCC-01 (claimed FIXED) — FR-02 host summary must not be `null`
// =============================================================================================
describe('RE-VERIFY TCC-01 · FR-02 host summary on the degraded host paths', () => {
  test('(a) soft-deleted host: detail is 200 and listing.host is a summary, not null', async () => {
    const host = await dbh.makeUser({ can_publish_listing: true });
    await dbh.makeHostProfile({ user_id: host.id });
    const listing = await support.makeApprovedListing({ host_id: host.id });
    await dbh.query('UPDATE users SET deleted_at = now() WHERE id = $1', [host.id]);

    const viewer = await dbh.makeUser();
    const res = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set('Cookie', await support.cookieFor(viewer));

    // Original failureScenario logged: 'PROBE detail status 200 host= null'
    expect(res.status).toBe(200);
    expect(res.body.listing.host).not.toBeNull();
    expect(typeof res.body.listing.host.displayName).toBe('string');
    expect(res.body.listing.host.displayName.length).toBeGreaterThan(0);
    // NFR-12: the fallback must not resurface the erased name.
    expect(JSON.stringify(res.body)).not.toContain(host.full_name);
  });

  test('(b) host with NO host_profiles row: detail is 200 with a named summary', async () => {
    const host = await dbh.makeUser({ can_publish_listing: true });
    const listing = await support.makeApprovedListing({ host_id: host.id });

    const viewer = await dbh.makeUser();
    const res = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set('Cookie', await support.cookieFor(viewer));

    expect(res.status).toBe(200);
    expect(res.body.listing.host).not.toBeNull();
    expect(res.body.listing.host.displayName).toBe(host.full_name);
    expect(res.body.listing.host.reviewCount).toBe(0);
  });
});

// =============================================================================================
// TCC-02 (claimed FIXED on search only) — a soft-deleted host's listings must not be browsable
// =============================================================================================
describe('RE-VERIFY TCC-02 · NFR-12 erasure direction on the FR-01/FR-02 read paths', () => {
  const cuisine = `tcc02reverify${RUN}`;
  let liveListing;
  let deletedHostListing;
  let deletedHost;
  let viewerCookie;

  beforeAll(async () => {
    viewerCookie = await support.cookieFor(await dbh.makeUser());
    const liveHost = await dbh.makeUser({ can_publish_listing: true });
    await dbh.makeHostProfile({ user_id: liveHost.id });
    liveListing = await support.makeApprovedListing({ host_id: liveHost.id, cuisine });

    deletedHost = await dbh.makeUser({ can_publish_listing: true });
    await dbh.makeHostProfile({ user_id: deletedHost.id });
    deletedHostListing = await support.makeApprovedListing({ host_id: deletedHost.id, cuisine });
    await dbh.query('UPDATE users SET deleted_at = now() WHERE id = $1', [deletedHost.id]);
  });

  test('search returns the live host’s listing and NOT the soft-deleted host’s', async () => {
    const res = await search({ cuisine }, viewerCookie);
    expect(res.status).toBe(200);
    const ids = res.body.results.map((r) => r.id);
    expect(ids).toContain(liveListing.id);
    // Original failureScenario: 'PROBE search status 200 n= 1' for the deleted host.
    expect(ids).not.toContain(deletedHostListing.id);
  });

  test('GET /api/hosts/:id for the soft-deleted host is 404 (unchanged)', async () => {
    const res = await request(app).get(`/api/hosts/${deletedHost.id}`).set('Cookie', viewerCookie);
    expect(res.status).toBe(404);
  });

  test('RESIDUAL: direct GET /api/listings/:id for the soft-deleted host still answers', async () => {
    const res = await request(app)
      .get(`/api/listings/${deletedHostListing.id}`)
      .set('Cookie', viewerCookie);
    // This documents the half of TCC-02 the fixer deliberately did NOT change; the detail
    // read path carries no users.deleted_at predicate. Recorded as an observation, not a
    // wave-3 pass/fail: the erasure cascade is U4-PRIVACY's to specify.
    expect([200, 404]).toContain(res.status);
    // eslint-disable-next-line no-console
    console.log(`REVERIFY TCC-02 residual: detail status ${res.status}`);
  });
});

// =============================================================================================
// TCC-03 (claimed FIXED by correcting the criterion) — the three NFR-09 cases
// =============================================================================================
describe('RE-VERIFY TCC-03 · FR-01 degraded-mode cases (i)/(ii)/(iii)', () => {
  const cuisine = `tcc03reverify${RUN}`;
  const locWarm = `tcc03 warm ${RUN}`;
  const locCold = `tcc03 cold ${RUN}`;
  let viewerCookie;
  let listing;

  beforeAll(async () => {
    viewerCookie = await support.cookieFor(await dbh.makeUser());
    const host = await dbh.makeUser({ can_publish_listing: true });
    await dbh.makeHostProfile({ user_id: host.id });
    const area = await maps.searchArea(locWarm);
    const center = area.areas[0];
    listing = await support.makeApprovedListing({
      host_id: host.id,
      cuisine,
      coarse_lat: center.lat,
      coarse_lng: center.lng,
    });
  });

  afterEach(() => jest.restoreAllMocks());

  test('(i) a page-cached query during an outage: 200, zero adapter calls, NO degraded flag', async () => {
    const query = { location: locWarm, radiusKm: 25, cuisine };
    const warm = await search(query, viewerCookie);
    expect(warm.status).toBe(200);
    expect(warm.body.results.map((r) => r.id)).toContain(listing.id);

    const spy = jest.spyOn(maps, 'searchArea').mockRejectedValue(new Error('simulated outage'));
    const during = await search(query, viewerCookie);
    // eslint-disable-next-line no-console
    console.log(
      `REVERIFY TCC-03(i): status ${during.status} degraded=${during.body.degraded} ` +
        `n=${(during.body.results || []).length} adapterCalls=${spy.mock.calls.length}`
    );
    expect(during.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect(during.body.degraded).toBeUndefined();
    expect(during.body.results.map((r) => r.id)).toContain(listing.id);
  });

  test('(ii) a STALE adapter answer is 200 with degraded:true and is never page-cached', async () => {
    const query = { location: `${locWarm} stale`, radiusKm: 25, cuisine };
    const area = await maps.searchArea(locWarm);
    jest
      .spyOn(maps, 'searchArea')
      .mockResolvedValue({ areas: area.areas, degraded: true, stale: true });
    const res = await search(query, viewerCookie);
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    const cacheKey = searchService.cacheKeyFor(
      searchService.normalizeQuery(searchSchemas.query.parse(query))
    );
    expect(await redis.get(cacheKey)).toBeNull();
  });

  test('(iii) a location query with nothing cached during an outage is a typed 503', async () => {
    jest.spyOn(maps, 'searchArea').mockRejectedValue(new Error('simulated outage'));
    const res = await search({ location: locCold, radiusKm: 25, cuisine }, viewerCookie);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SEARCH_DEGRADED');
  });
});

// =============================================================================================
// TCC-04 (REPAIRED in the re-verification round) — the FR-02 review preview now LABELS itself.
//
// The assertion below is the verifier's original reproduction with its open half INVERTED
// rather than weakened: the same fixture (one host, 7 approved reviews, one approved listing)
// is still built and the same detail response is still read, but where the probe used to pin
// the defect (`reviewsTotal`/`reviewsPageSize` undefined) it now demands the repaired
// contract — the bounded array plus the total and page size that make the truncation
// self-describing. Re-running this test against the pre-fix tree fails on
// `expect(reviewsTotal).toBe(7)` (received undefined), which is what makes it a regression
// guard rather than a restatement of whatever the code happens to do.
// =============================================================================================
describe('RE-VERIFY TCC-04 · FR-02 detail review preview', () => {
  test('7 approved reviews -> a 5-item preview that states reviewsTotal 7 and its page size', async () => {
    const host = await dbh.makeUser({ can_publish_listing: true });
    await dbh.makeHostProfile({ user_id: host.id });
    const listing = await support.makeApprovedListing({ host_id: host.id });

    for (let i = 0; i < 7; i += 1) {
      const guest = await dbh.makeUser();
      const bookedListing = await support.makeApprovedListing({ host_id: host.id });
      const booking = await support.makeCompletedBooking(bookedListing.id, guest.id);
      await dbh.insertRow('reviews', {
        booking_id: booking.id,
        author_id: guest.id,
        target_user_id: host.id,
        rating: 5,
        body: `tcc04 reverify review ${i}`,
        moderation_status: 'approved',
      });
    }

    const viewer = await dbh.makeUser();
    const res = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set('Cookie', await support.cookieFor(viewer));

    expect(res.status).toBe(200);
    // eslint-disable-next-line no-console
    console.log(
      `REVERIFY TCC-04: reviews returned ${res.body.listing.reviews.length}, ` +
        `host.reviewCount ${res.body.listing.host.reviewCount}, ` +
        `payload keys ${Object.keys(res.body.listing).join(',')}`
    );
    expect(res.body.listing.host.reviewCount).toBe(7);
    expect(res.body.listing.reviews.length).toBe(5);
    // The formerly open half of the finding, now inverted: the payload DOES disclose that the
    // array is a page — total, page size, and (total > length) meaning "there is more".
    expect(res.body.listing.reviewsTotal).toBe(7);
    expect(res.body.listing.reviewsPageSize).toBe(5);
    expect(res.body.listing.reviewsTotal).toBeGreaterThan(res.body.listing.reviews.length);

    // …and the remainder is genuinely reachable: the documented pager returns the other 2.
    const rest = await request(app)
      .get(`/api/hosts/${host.id}/reviews?page=2&pageSize=5`)
      .set('Cookie', await support.cookieFor(viewer));
    expect(rest.status).toBe(200);
    expect(rest.body.total).toBe(7);
    expect(rest.body.reviews.length).toBe(2);
  });
});

// =============================================================================================
// TCC-05 (claimed FIXED) — the page-cache existence check must survive a busy Redis index
// =============================================================================================
describe('RE-VERIFY TCC-05 · FR-01 result-page cache assertion determinism', () => {
  const cuisine = `tcc05reverify${RUN}`;
  const AMBIENT = 900;
  const ambientPrefix = `hp:session:tcc05reverify:${RUN}:`;
  let viewerCookie;
  let listing;

  beforeAll(async () => {
    viewerCookie = await support.cookieFor(await dbh.makeUser());
    const host = await dbh.makeUser({ can_publish_listing: true });
    await dbh.makeHostProfile({ user_id: host.id });
    listing = await support.makeApprovedListing({ host_id: host.id, cuisine });
    const pipeline = redis.pipeline();
    for (let i = 0; i < AMBIENT; i += 1) pipeline.set(`${ambientPrefix}${i}`, 'x', 'EX', 300);
    await pipeline.exec();
  });

  afterAll(async () => {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${ambientPrefix}*`, 'COUNT', 1000);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');
  });

  test('with ~900 ambient keys the exact page key is present with a bounded TTL', async () => {
    const query = { cuisine };
    const res = await search(query, viewerCookie);
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => r.id)).toContain(listing.id);

    const cacheKey = searchService.cacheKeyFor(
      searchService.normalizeQuery(searchSchemas.query.parse(query))
    );
    const raw = await redis.get(cacheKey);
    const ttl = await redis.ttl(cacheKey);
    // The single-pass SCAN the old assertion used, for contrast.
    const [singlePassCursor, singlePassKeys] = await redis.scan(
      '0',
      'MATCH',
      'hp:cache:search:page:*',
      'COUNT',
      500
    );
    // eslint-disable-next-line no-console
    console.log(
      `REVERIFY TCC-05: exact-key present=${raw !== null} ttl=${ttl}; ` +
        `single-pass SCAN cursor=${singlePassCursor} matched=${singlePassKeys.length}`
    );
    expect(cacheKey).toMatch(/^hp:cache:search:page:[0-9a-f]{32}$/);
    expect(raw).not.toBeNull();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(config.search.cacheTtlSeconds);
    expect(JSON.parse(raw).results.map((r) => r.id)).toContain(listing.id);
  });
});

// =============================================================================================
// FR-05 / FR-06 — wave-4 absence probes (must never be reported as a pass)
// =============================================================================================
describe('FR-05 / FR-06 — not implemented (wave 4)', () => {
  test('review and message endpoints answer a structured JSON 404', async () => {
    const cookie = await support.cookieFor(await dbh.makeUser());
    const booking = await dbh.makeBooking({});
    const review = await request(app)
      .post(`/api/bookings/${booking.id}/reviews`)
      .set('Cookie', cookie)
      .send({ rating: 5, comment: 'x' });
    const messages = await request(app)
      .get(`/api/bookings/${booking.id}/messages`)
      .set('Cookie', cookie);
    // eslint-disable-next-line no-console
    console.log(`REVERIFY FR-05 status ${review.status}; FR-06 status ${messages.status}`);
    expect(review.status).toBe(404);
    expect(messages.status).toBe(404);
    expect(review.body.error.code).toBe('NOT_FOUND');
    expect(messages.body.error.code).toBe('NOT_FOUND');
  });
});

// =============================================================================================
// FR-07 — the surface that landed in f7f954c, driven end to end through the REAL worker
// =============================================================================================
describe('RE-VERIFY FR-07 · persist → worker → moderator notice + emergency contact', () => {
  let host;
  let moderatorCookie;
  let listing;

  beforeAll(async () => {
    host = await dbh.makeUser({ can_publish_listing: true });
    await dbh.makeHostProfile({ user_id: host.id });
    const moderator = await dbh.makeUser({ roles: ['user', 'moderator'] });
    moderatorCookie = await support.cookieFor(moderator);
    listing = await support.makeApprovedListing({
      host_id: host.id,
      seat_capacity: 8,
      seats_remaining: 8,
    });
    await drainDue(); // start from an empty queue
  });

  beforeEach(() => {
    mockTransport.reset();
    jest.restoreAllMocks();
  });

  async function raise(bookingId, cookie) {
    const res = await request(app)
      .post(`/api/bookings/${bookingId}/safety-alerts`)
      .set('Cookie', cookie)
      .send({});
    return res;
  }

  test('happy path: 201 with no inline send, then the worker delivers to moderator + contact', async () => {
    const guest = await dbh.makeUser({
      emergency_contact_email_enc: encrypt('reverify-contact@relative.invalid'),
    });
    const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const before = await dbh.query('SELECT count(*)::int AS n FROM notification_attempts');

    const res = await raise(booking.id, await support.cookieFor(guest));
    expect(res.status).toBe(201);
    const alertId = res.body.alert.id;
    expect(res.body.alert.deliveryStatus).toBe('pending');

    // ADR-001/003: nothing was delivered on the request path.
    const during = await dbh.query('SELECT count(*)::int AS n FROM notification_attempts');
    expect(during.rows[0].n).toBe(before.rows[0].n);

    // The alert and its outbox row committed together.
    const jobs = await dbh.query(
      `SELECT status, payload FROM outbox_jobs
        WHERE type = 'safety.alert' AND payload->>'alertId' = $1`,
      [alertId]
    );
    expect(jobs.rows).toHaveLength(1);
    expect(Object.keys(jobs.rows[0].payload).sort()).toEqual(['alertId', 'bookingId']);

    // Visible for review from the instant it was persisted.
    const queueBefore = await request(app)
      .get('/api/moderation/alerts')
      .set('Cookie', moderatorCookie)
      .query({ pageSize: 50 });
    expect(queueBefore.status).toBe(200);
    expect(queueBefore.body.alerts.map((a) => a.id)).toContain(alertId);

    await drainDue();

    const after = await dbh.query(
      `SELECT template, status FROM notification_attempts
        WHERE params->>'alertId' = $1 ORDER BY template`,
      [alertId]
    );
    const templates = after.rows.map((r) => `${r.template}:${r.status}`);
    // eslint-disable-next-line no-console
    console.log(`REVERIFY FR-07 happy: attempts ${JSON.stringify(templates)}`);
    expect(templates).toContain('safety-alert-emergency:sent');
    expect(templates.some((t) => t.startsWith('safety-alert-moderator:sent'))).toBe(true);

    const alert = await dbh.query('SELECT delivery_status FROM safety_alerts WHERE id = $1', [
      alertId,
    ]);
    expect(alert.rows[0].delivery_status).toBe('delivered');
  });

  test('no emergency contact on file: delivery_status becomes no_channel, never a failure', async () => {
    const guest = await dbh.makeUser(); // no emergency_contact_email_enc
    const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const res = await raise(booking.id, await support.cookieFor(guest));
    expect(res.status).toBe(201);
    await drainDue();
    const alert = await dbh.query('SELECT delivery_status FROM safety_alerts WHERE id = $1', [
      res.body.alert.id,
    ]);
    // eslint-disable-next-line no-console
    console.log(`REVERIFY FR-07 no-contact: delivery_status ${alert.rows[0].delivery_status}`);
    expect(alert.rows[0].delivery_status).toBe('no_channel');
  });

  test('an injected transport failure leaves the alert retrying AND still visible for review', async () => {
    const guest = await dbh.makeUser({
      emergency_contact_email_enc: encrypt('reverify-fail@relative.invalid'),
    });
    const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const res = await raise(booking.id, await support.cookieFor(guest));
    expect(res.status).toBe(201);
    const alertId = res.body.alert.id;

    const transport = require('../../src/modules/notifications/transport');
    jest.spyOn(transport, 'send').mockResolvedValue({ status: 'failed', attemptId: null });

    const jobState = async () => {
      const { rows } = await dbh.query(
        `SELECT status, attempt_count, available_at FROM outbox_jobs
          WHERE type = 'safety.alert' AND payload->>'alertId' = $1`,
        [alertId]
      );
      return rows[0];
    };
    const alertState = async () => {
      const { rows } = await dbh.query('SELECT delivery_status FROM safety_alerts WHERE id = $1', [
        alertId,
      ]);
      return rows[0].delivery_status;
    };

    // First attempt: the job must back off (available_at pushed into the future) and the
    // alert must be marked 'retrying' — not left silently 'pending'.
    await drainDue();
    const afterFirst = await jobState();
    const alertAfterFirst = await alertState();
    expect(afterFirst.attempt_count).toBe(1);
    expect(new Date(afterFirst.available_at).getTime()).toBeGreaterThan(Date.now());
    expect(alertAfterFirst).toBe('retrying');

    const queueRetrying = await request(app)
      .get('/api/moderation/alerts')
      .set('Cookie', moderatorCookie)
      .query({ pageSize: 100 });
    expect(queueRetrying.body.alerts.map((a) => a.id)).toContain(alertId);

    // Exhaust the whole retry budget by collapsing the backoff (never by weakening it).
    for (let i = 0; i < config.outbox.maxAttempts + 2; i += 1) {
      await dbh.query(
        `UPDATE outbox_jobs SET available_at = now()
          WHERE type = 'safety.alert' AND payload->>'alertId' = $1 AND status = 'pending'`,
        [alertId]
      );
      await drainDue();
    }
    const dead = await jobState();
    const alertFinal = await alertState();
    const queueDead = await request(app)
      .get('/api/moderation/alerts')
      .set('Cookie', moderatorCookie)
      .query({ pageSize: 100 });
    // eslint-disable-next-line no-console
    console.log(
      `REVERIFY FR-07 failure: job ${dead.status} attempt_count ${dead.attempt_count} ` +
        `(maxAttempts ${config.outbox.maxAttempts}); alert ${alertFinal}; ` +
        `still queued=${queueDead.body.alerts.map((a) => a.id).includes(alertId)}`
    );
    expect(dead.status).toBe('dead');
    expect(dead.attempt_count).toBe(config.outbox.maxAttempts);
    expect(alertFinal).toBe('failed');
    expect(queueDead.body.alerts.map((a) => a.id)).toContain(alertId);
    jest.restoreAllMocks();
  });
});
