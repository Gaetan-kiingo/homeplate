// tests/tc-core/tccrv02-erasure-read-paths.test.js — NFR-12 erasure direction across every
// wave-3 read path that can reach a listing (finding TCC-RV-02, residual of TCC-02).
//
// Requirement traceability (SRS Appendix B):
//   NFR-12 — "Upon deletion, all personal data … shall be erased or irreversibly anonymized …
//            reviews may be retained in anonymized form." The v1.0 deletion endpoint is
//            wave-4 U4-PRIVACY; this file pins the READ-PATH half of the semantics wave 3
//            implements so the cascade is written against a proven contract.
//   FR-01  — search must not surface a soft-deleted host's meals (src/modules/search/repo.js
//            VISIBLE_PREDICATES).
//   FR-02  — the detail read is a RETENTION surface: it keeps answering, but the erased
//            identity must not come back with it.
//   FR-03  — the host page 404s and the example-dishes read is empty
//            (src/modules/listings/repo.js findApprovedByHost).
//   FR-12  — the booking path must refuse a meal whose host is gone.
//
// THE SEMANTICS UNDER TEST (recorded in the src/modules/listings/repo.js module header):
// a soft-deleted account makes its listings UNDISCOVERABLE and its identity ANONYMOUS, while an
// already-referenced meal record is RETAINED. Group 1 pins the discovery half. Group 2 pins the
// retention half as a property (no erased PII on the wire) rather than as a status code, so it
// holds whichever way U4-PRIVACY finally resolves the 200-vs-404 sub-decision. Group 3 is the
// forward contract for that cascade: with the ONE write the cascade is specified to make —
// status → 'cancelled' on the host's active listings — search, the host page, example dishes,
// the detail payload and the FR-12 booking path all agree, with no further read predicate. It
// is what makes "cancel in the deletion transaction" a sufficient fix rather than a guess.
//
// DELIBERATELY NOT ASSERTED: whether POST /api/bookings on a still-'active' listing of a
// soft-deleted host succeeds today. It does (bookings/repo.selectListing classifies bookability
// from listings.status / moderation_status / scheduled_start only), and that is the open gap
// TCC-RV-02 reports — pinning it would freeze the defect as the contract.
'use strict';

const request = require('supertest');

const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const listingsRepo = require('../../src/modules/listings/repo');
const dbh = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const support = require('./support');

const RUN = `${process.pid}${Date.now() % 1e7}`;
const sink = { write() {} };
let app;

beforeAll(() => {
  app = createApp({ logger: createLogger({ level: 'silent', stream: sink }) });
});

afterAll(async () => {
  await dbh.closeDb();
  await closeTestRedis();
});

/**
 * A host with a complete profile plus one approved/active/future listing on a cuisine unique to
 * this run, then soft-deleted. Returns the host row (pre-deletion, so full_name is readable for
 * the leak assertions) and the listing.
 */
async function seedDeletedHostWithListing(cuisine) {
  const host = await dbh.makeUser({
    can_publish_listing: true,
    phone_enc: `enc:v1:tccrv02-${RUN}`,
  });
  await dbh.makeHostProfile({ user_id: host.id });
  const listing = await support.makeApprovedListing({ host_id: host.id, cuisine });
  await dbh.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [host.id]);
  return { host, listing };
}

/** An FR-09-eligible guest (email verified + name + phone) and their session cookie. */
async function eligibleViewer() {
  const user = await dbh.makeUser({ phone_enc: `enc:v1:tccrv02v-${RUN}` });
  return { user, cookie: await support.cookieFor(user) };
}

// =================================================================================================
// 1. DISCOVERY — every surface that OFFERS a meal must hide a soft-deleted host's listings
// =================================================================================================
describe('NFR-12 discovery direction — a soft-deleted host is offered by no read path', () => {
  const cuisine = `tccrv02disc${RUN}`;
  let host;
  let listing;
  let liveHost;
  let liveListing;
  let viewer;

  beforeAll(async () => {
    viewer = await eligibleViewer();
    // A live host on the SAME cuisine, so an empty result cannot be mistaken for a broken query.
    liveHost = await dbh.makeUser({ can_publish_listing: true });
    await dbh.makeHostProfile({ user_id: liveHost.id });
    liveListing = await support.makeApprovedListing({ host_id: liveHost.id, cuisine });
    ({ host, listing } = await seedDeletedHostWithListing(cuisine));
  });

  test('FR-01 search returns the live host’s listing and never the deleted host’s', async () => {
    const res = await request(app)
      .get('/api/listings/search')
      .set('Cookie', viewer.cookie)
      .query({ cuisine });
    expect(res.status).toBe(200);
    const ids = res.body.results.map((r) => r.id);
    expect(ids).toContain(liveListing.id);
    expect(ids).not.toContain(listing.id);
  });

  test('FR-03 the host page is 404 and indistinguishable from an unknown id', async () => {
    const res = await request(app).get(`/api/hosts/${host.id}`).set('Cookie', viewer.cookie);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(host.full_name);
  });

  test('FR-03 the example-dishes read is empty for the deleted host and populated for a live one', async () => {
    // The repo primitive itself, not just the 404 one call frame up: hosts/service.getHostPage
    // 404s first today, so this is the assertion that actually exercises the erasure predicate
    // added to listings/repo.findApprovedByHost (TCC-RV-02).
    await expect(listingsRepo.findApprovedByHost(host.id)).resolves.toEqual([]);
    const liveRows = await listingsRepo.findApprovedByHost(liveHost.id);
    expect(liveRows.map((r) => r.id)).toContain(liveListing.id);
  });
});

// =================================================================================================
// 2. RETENTION — the FR-02 detail read may still answer, but never with the erased identity
// =================================================================================================
describe('NFR-12 retention direction — the FR-02 detail payload carries no erased PII', () => {
  test('a soft-deleted host’s listing never leaks the erased name or email, whatever the status', async () => {
    const { host, listing } = await seedDeletedHostWithListing(`tccrv02ret${RUN}`);
    const viewer = await eligibleViewer();

    const res = await request(app).get(`/api/listings/${listing.id}`).set('Cookie', viewer.cookie);

    // The 200-vs-404 choice is the OPEN U4-PRIVACY sub-decision (see the module header of
    // src/modules/listings/repo.js); tests/tc-core/tc02-host-summary-fallback.test.js pins the
    // current answer. What NFR-12 requires either way is asserted here.
    expect([200, 404]).toContain(res.status);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(host.full_name);
    expect(body).not.toContain(host.email);
    if (res.status === 200) {
      // FR-02 still holds: a summary is present, and it is the anonymized identity (TCC-01).
      expect(res.body.listing.host).not.toBeNull();
      expect(typeof res.body.listing.host.displayName).toBe('string');
      expect(res.body.listing.host.displayName.length).toBeGreaterThan(0);
    }
  });
});

// =================================================================================================
// 3. THE U4-PRIVACY CASCADE CONTRACT — cancelling the host's active listings closes every surface
// =================================================================================================
describe('NFR-12 cascade contract — status → cancelled makes all read paths and FR-12 agree', () => {
  const cuisine = `tccrv02casc${RUN}`;
  let host;
  let listing;
  let viewer;

  beforeAll(async () => {
    viewer = await eligibleViewer();
    ({ host, listing } = await seedDeletedHostWithListing(cuisine));
    // The single write the wave-4 erasure transaction is specified to make. Applied here
    // directly because no v1.0 endpoint sets users.deleted_at or runs the cascade yet; this
    // test states what that transaction must achieve, not how it is triggered.
    await dbh.query(`UPDATE listings SET status = 'cancelled' WHERE host_id = $1`, [host.id]);
  });

  test('search still excludes it (status = active predicate, unchanged)', async () => {
    const res = await request(app)
      .get('/api/listings/search')
      .set('Cookie', viewer.cookie)
      .query({ cuisine });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => r.id)).not.toContain(listing.id);
  });

  test('the example-dishes read stays empty', async () => {
    await expect(listingsRepo.findApprovedByHost(host.id)).resolves.toEqual([]);
  });

  test('FR-12: reserving the cancelled meal by known id is a 409 LISTING_NOT_BOOKABLE', async () => {
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', viewer.cookie)
      .send({ listingId: listing.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LISTING_NOT_BOOKABLE');
    // No seat was taken: capacity is untouched and no booking row exists.
    const { rows } = await dbh.query(
      `SELECT seats_remaining,
              (SELECT count(*)::int FROM bookings WHERE listing_id = $1) AS bookings
         FROM listings WHERE id = $1`,
      [listing.id]
    );
    expect(rows[0].seats_remaining).toBe(4);
    expect(rows[0].bookings).toBe(0);
  });

  test('the detail read reports the meal as cancelled and still hides the erased identity', async () => {
    const res = await request(app).get(`/api/listings/${listing.id}`).set('Cookie', viewer.cookie);
    expect([200, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain(host.full_name);
    if (res.status === 200) {
      expect(res.body.listing.status).toBe('cancelled');
    }
  });
});
