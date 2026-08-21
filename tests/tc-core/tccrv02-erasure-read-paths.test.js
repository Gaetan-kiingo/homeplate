// tests/tc-core/tccrv02-erasure-read-paths.test.js — the NFR-12 U4-PRIVACY CASCADE CONTRACT
// (finding TCC-RV-02, residual of TCC-02).
//
// Requirement traceability (SRS Appendix B):
//   NFR-12 — "Upon deletion, all personal data … shall be erased or irreversibly anonymized …
//            reviews may be retained in anonymized form." The v1.0 deletion endpoint is
//            wave-4 U4-PRIVACY; the read-path halves of the semantics wave 3 implements are
//            pinned per requirement in the canonical suites:
//              discovery (FR-01 search, FR-03 host page + example dishes) —
//                tc01-search.test.js, tc03-host-profile.test.js;
//              retention (FR-02 detail answers without the erased identity) —
//                tc02-listing-detail.test.js (TCC-01 describe).
//   FR-12  — the booking path must refuse a meal whose host is gone.
//
// THE SEMANTICS UNDER TEST (recorded in the src/modules/listings/repo.js module header):
// a soft-deleted account makes its listings UNDISCOVERABLE and its identity ANONYMOUS, while an
// already-referenced meal record is RETAINED. This file keeps the FORWARD CONTRACT for the
// wave-4 erasure cascade: with the ONE write the cascade is specified to make — status →
// 'cancelled' on the host's active listings — search, example dishes, the detail payload and
// the FR-12 booking path all agree, with no further read predicate. It is what makes "cancel
// in the deletion transaction" a sufficient fix rather than a guess. The four tests share one
// fixture and are asserted together on purpose: the contract is that ALL surfaces agree after
// that single write, so splitting them per-requirement would dissolve the very property this
// file exists to pin.
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

/** An FR-09-eligible guest (email verified + name + phone) and their session cookie. */
async function eligibleViewer() {
  const user = await dbh.makeUser({ phone_enc: `enc:v1:tccrv02v-${RUN}` });
  return { user, cookie: await support.cookieFor(user) };
}

describe('NFR-12 cascade contract — status → cancelled makes all read paths and FR-12 agree', () => {
  const cuisine = `tccrv02casc${RUN}`;
  let host;
  let listing;
  let viewer;

  beforeAll(async () => {
    viewer = await eligibleViewer();
    ({ host, listing } = await support.seedDeletedHostWithListing({ cuisine }));
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
    // The 200-vs-404 choice is the OPEN U4-PRIVACY sub-decision (see the module header of
    // src/modules/listings/repo.js); tc02-listing-detail.test.js (TCC-01 describe) pins the
    // current answer. What NFR-12 requires either way is asserted here.
    expect([200, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain(host.full_name);
    if (res.status === 200) {
      expect(res.body.listing.status).toBe('cancelled');
    }
  });
});
