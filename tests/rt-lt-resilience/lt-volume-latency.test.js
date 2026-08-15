// tests/rt-lt-resilience/lt-volume-latency.test.js — LT-02 index coverage (SRS §4.4; NFR-02).
//
// SCOPE (post wave-3). This file is the surviving remainder of the wave-2 LT lane. Everything it
// used to APPROXIMATE while the NFR-01 read paths were unimplemented now has a real measurement,
// so those halves were removed rather than left printing claims that stopped being true when the
// wave-3 modules landed:
//   • LT-01 — measured for real over the NFR-01 core-operation mix (GET /api/listings/search,
//     GET /api/listings/:id, GET /api/hosts/:id, GET /api/hosts/:id/reviews) at 200 VUs by
//     tests/rt-lt-resilience/lt01-lt02-wave3.test.js (short in-suite gate) and by
//     tests/rt-lt-resilience/lt01-run.js (the recorded 5-minute measurement run). The old
//     GET /api/users/me probe — whose console line still announced the search, browse and review
//     endpoints as unimplemented — is gone: those endpoints exist and are exercised by the real
//     scenario, which drives them through real Redis sessions, so the probe measured nothing the
//     LT-01 gate does not. The "routes 404 while the module is absent, non-404 once it lands"
//     state marker is gone too: it passed in either state and therefore asserted nothing about
//     this tree.
//   • LT-02 dataset — the NFR-02 volume seed (>= 10,000 users, >= 1,000 approved listings on ONE
//     America/Los_Angeles day, >= 1,000 bookings) and its idempotency are asserted by
//     tests/unit/db.test.js against a dedicated volume database; the same row counts in the shared
//     test database are re-asserted by lt01-lt02-wave3.test.js before it runs the load scenario.
//   • LT-02 query plans — EXPLAIN ANALYZE at volume now runs the EXACT production search SQL
//     (src/modules/search/repo.buildSearchQuery / buildCountQuery, exported for that acceptance)
//     across six filter shapes in lt01-lt02-wave3.test.js, superseding the hand-written
//     predicate this file used as a stand-in for the then-unwritten query.
//
// What remains is the one NFR-02 assertion nothing else makes: the required index INVENTORY on
// listings. Those index shapes must exist by definition — independently of whichever plan the
// planner happens to pick for today's dataset — so this check needs no volume data and stays
// cheap.
'use strict';

const dbh = require('../helpers/db');

afterAll(async () => {
  await dbh.closeDb();
});

describe('LT-02 — NFR-02 required index inventory on listings', () => {
  test('the NFR-02 required indexes exist on listings', async () => {
    const { rows } = await dbh.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'listings'`
    );
    const defs = rows.map((r) => r.indexdef.toLowerCase());
    const has = (fragment) => defs.some((d) => d.includes(fragment));

    expect(has('(scheduled_start)')).toBe(true); // (scheduled_start)
    expect(has('(host_id, local_date)')).toBe(true); // (host_id, local_date)
    expect(has('(moderation_status)')).toBe(true); // (moderation_status)
    expect(has('(cuisine)')).toBe(true); // cuisine filter
    expect(has('(coarse_lat, coarse_lng)')).toBe(true); // public-precision geo filter
  });
});
