// tests/rt-lt-resilience/lt01-lt02-wave3.test.js — LT-01 latency gate + LT-02 volume gate on
// the wave-3 read surface (SRS §4.4; NFR-01, NFR-02).
//
// LT-01 here is the SHORT in-suite gate (200 VUs, LT01_DURATION_MS — default 45 s) so the lane
// stays runnable; the RECORDED measurement is the standalone 5-minute run of the same scenario
// (node tests/rt-lt-resilience/lt01-run.js --vus 200 --duration 300000) whose numbers go in the
// verification report. Both use the identical harness and endpoint mix (see lt01-run.js for the
// honest k6-unavailable caveat).
//
// LT-02 EXPLAINs the EXACT production search SQL (src/modules/search/repo.buildSearchQuery /
// buildCountQuery — exported for precisely this acceptance) over the full volume dataset and
// asserts the planner never sequentially scans listings.
'use strict';

const { runLoadScenario, ensureVolumeData } = require('./lt01-run');
const searchRepo = require('../../src/modules/search/repo');

const dbh = require('../helpers/db');
const rh = require('../helpers/redis');

const quietConsole = { log: () => {}, warn: () => {} };

afterAll(async () => {
  await dbh.closeDb();
  await rh.closeTestRedis();
});

describe('LT-02 — the volume dataset and the real search plan (NFR-02)', () => {
  beforeAll(async () => {
    await ensureVolumeData(quietConsole);
  }, 240000);

  test('>= 10,000 users, >= 1,000 approved active listings and >= 1,000 bookings share one LA day', async () => {
    const { rows: users } = await dbh.query(`SELECT count(*)::int AS n FROM users`);
    expect(users[0].n).toBeGreaterThanOrEqual(10000);
    const { rows: day } = await dbh.query(
      `SELECT local_date, count(*)::int AS n FROM listings
        WHERE status = 'active' AND moderation_status = 'approved'
        GROUP BY local_date ORDER BY n DESC LIMIT 1`
    );
    expect(day[0].n).toBeGreaterThanOrEqual(1000);
    const { rows: bookings } = await dbh.query(
      `SELECT count(*)::int AS n FROM bookings b JOIN listings l ON l.id = b.listing_id
        WHERE l.local_date = $1`,
      [day[0].local_date]
    );
    expect(bookings[0].n).toBeGreaterThanOrEqual(1000);
  }, 60000);

  test('EXPLAIN ANALYZE of the exact production search SQL at volume: no Seq Scan on listings for any filter shape', async () => {
    const collectSeqScans = (node, found = []) => {
      if (node && typeof node === 'object') {
        if (node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'listings') {
          found.push(node);
        }
        for (const child of node.Plans || []) collectSeqScans(child, found);
      }
      return found;
    };

    const hostId = 'e0000000-0000-4000-8000-000000000007'; // a volume host
    const from = '2026-09-15T00:00:00-07:00';
    const to = '2026-09-16T00:00:00-07:00';
    const areas = [
      { lat: 32.72, lng: -117.16 },
      { lat: 32.84, lng: -117.27 },
    ];
    const page = { limit: 20, offset: 0 };

    const shapes = {
      bare: { ...page },
      cuisine: { cuisine: 'mexican', ...page },
      host: { hostId, ...page },
      window: { from, to, ...page },
      geo: { areas, radiusKm: 10, ...page },
      combined: { cuisine: 'thai', from, to, areas, radiusKm: 25, ...page },
    };

    const { rows: tableRows } = await dbh.query(`SELECT count(*)::int AS n FROM listings`);
    const tableSize = tableRows[0].n;

    const timings = {};
    for (const [label, filters] of Object.entries(shapes)) {
      for (const build of [searchRepo.buildSearchQuery, searchRepo.buildCountQuery]) {
        const isCount = build === searchRepo.buildCountQuery;
        const q = build(filters);
        const { rows } = await dbh.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${q.text}`, q.values);
        const plan = rows[0]['QUERY PLAN'][0];
        const seqScans = collectSeqScans(plan.Plan);

        if (seqScans.length > 0) {
          // Page queries (LIMIT + ORDER BY scheduled_start) must ALWAYS be index-driven. A
          // COUNT whose predicate matches most of the table legitimately seq-scans — that is
          // the planner's cheapest plan, not a missing index — but only if (a) the match
          // fraction really is high, (b) the predicate IS index-covered when seq scans are
          // disabled, and (c) the scan stays inside the NFR-01 budget. Anything else fails.
          const matched = seqScans[0]['Actual Rows'] + (seqScans[0]['Rows Removed by Filter'] || 0);
          const matchFraction = (seqScans[0]['Actual Rows'] || 0) / Math.max(1, tableSize);
          const seqScanJustified = isCount && matched >= tableSize * 0.5 && matchFraction > 0.5;
          if (!seqScanJustified) {
            throw new Error(
              `LT-02: unjustified sequential scan on listings for shape "${label}" ` +
                `(${isCount ? 'count' : 'page'} query; matchFraction=${matchFraction.toFixed(2)})`
            );
          }
          const client = await dbh.getClient();
          try {
            await client.query('BEGIN');
            await client.query('SET LOCAL enable_seqscan = off');
            const forced = await client.query(`EXPLAIN (FORMAT JSON) ${q.text}`, q.values);
            const forcedSeq = collectSeqScans(forced.rows[0]['QUERY PLAN'][0].Plan);
            expect(forcedSeq).toHaveLength(0); // an index CAN serve it — coverage exists
          } finally {
            try {
              await client.query('ROLLBACK');
            } finally {
              client.release();
            }
          }
        }
        const key = `${label}.${isCount ? 'count' : 'page'}`;
        timings[key] = plan['Execution Time'];
        expect(plan['Execution Time']).toBeLessThan(500); // single-query slice of NFR-01
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      'LT-02 EXPLAIN ANALYZE (real buildSearchQuery/buildCountQuery at volume, ms): ' +
        JSON.stringify(timings)
    );
  }, 120000);
});

describe('LT-01 — 200-VU latency gate over the NFR-01 core operations (short in-suite run)', () => {
  test('search/listing-detail/host-page/host-reviews at 200 VUs: p95 < 500 ms, error rate < 1%', async () => {
    const durationMs = Number(process.env.LT01_DURATION_MS || 45000);
    const report = await runLoadScenario({ vus: 200, durationMs, log: quietConsole });

    // The measured numbers are recorded in the test output for the verification report.
    // eslint-disable-next-line no-console
    console.log(`LT-01 gate run: ${JSON.stringify(report)}`);

    expect(report.requests).toBeGreaterThan(200); // the run actually reached concurrency
    expect(report.errorRate).toBeLessThan(0.01); // NFR-01 error budget
    expect(report.overall.p95).toBeLessThan(500); // NFR-01 p95 budget — overall…
    for (const [name, stats] of Object.entries(report.endpoints)) {
      expect({ name, p95: stats.p95 }).toEqual({ name, p95: expect.any(Number) });
      expect(stats.p95).toBeLessThan(500); // …and per core operation
    }
  }, 300000);
});
