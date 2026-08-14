// tests/rt-lt-resilience/lt-volume-latency.test.js — LT-01 / LT-02 (SRS §4.4; NFR-01, NFR-02).
//
// Wave-2 reality check: the NFR-01 core operations (GET /api/listings/search, listing detail,
// host reviews) and POST /api/bookings (FR-12 race) are wave-3 modules that DO NOT EXIST yet,
// so the specified LT-01 k6 scenario cannot be run meaningfully and is NOT claimed here.
// What this file executes honestly at wave-2:
//   LT-02 (partial): the NFR-02 volume seed at full scale (10,000 users / 1,000 listings /
//     1,000 bookings on one America/Los_Angeles day), the required-index inventory, and
//     EXPLAIN ANALYZE on a representative future-search predicate proving index usage
//     (no sequential scan) at volume.
//   LT-01 (approximation only): a 200-concurrent-client latency probe against the ONE
//     authenticated read path that exists (GET /api/users/me — Redis session + PostgreSQL
//     read). The measured numbers are recorded in the test output; they are NOT evidence
//     for NFR-01, whose core operations are unimplemented.
'use strict';

const http = require('http');
const request = require('supertest');

const { createApp } = require('../../src/app');
const { seed, VOLUME_TARGETS } = require('../../scripts/seed');

const dbh = require('../helpers/db');
const rh = require('../helpers/redis');
const { quietLogger, quantile } = require('./helpers');

const quiet = quietLogger();
const quietSeedLog = { log: () => {}, warn: () => {} };

afterAll(async () => {
  await dbh.closeDb();
  await rh.closeTestRedis();
});

describe('LT-02 — NFR-02 volume dataset', () => {
  test('volume seed loads >= 10,000 users, >= 1,000 listings and >= 1,000 bookings on ONE LA day', async () => {
    const result = await seed({ set: 'volume', log: quietSeedLog });
    expect(result.counts).toBeDefined();

    const { rows: userCount } = await dbh.query(`SELECT count(*)::int AS n FROM users`);
    expect(userCount[0].n).toBeGreaterThanOrEqual(VOLUME_TARGETS.users);
    expect(userCount[0].n).toBeGreaterThanOrEqual(10000);

    // All volume listings land on a single America/Los_Angeles calendar day.
    const { rows: dayRows } = await dbh.query(
      `SELECT local_date, count(*)::int AS n
         FROM listings
         WHERE status = 'active' AND moderation_status = 'approved'
         GROUP BY local_date ORDER BY n DESC LIMIT 1`
    );
    expect(dayRows.length).toBe(1);
    expect(dayRows[0].n).toBeGreaterThanOrEqual(1000);

    const volumeDay = dayRows[0].local_date;
    const { rows: bookingCount } = await dbh.query(
      `SELECT count(*)::int AS n
         FROM bookings b JOIN listings l ON l.id = b.listing_id
         WHERE l.local_date = $1`,
      [volumeDay]
    );
    expect(bookingCount[0].n).toBeGreaterThanOrEqual(1000);

    // Idempotent: re-running adds nothing (deterministic UUIDs + ON CONFLICT DO NOTHING).
    const again = await seed({ set: 'volume', log: quietSeedLog });
    expect(again.rows).toBe(0);
  }, 180000);

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

  test('EXPLAIN ANALYZE on the representative search predicate shows index usage — no seq scan on listings', async () => {
    const { rows: dayRows } = await dbh.query(
      `SELECT local_date FROM listings
         WHERE status = 'active' AND moderation_status = 'approved'
         GROUP BY local_date ORDER BY count(*) DESC LIMIT 1`
    );
    const volumeDay = dayRows[0].local_date;

    // The wave-3 search predicate per FR-01 acceptance: approved + active + day window
    // (+ cuisine / coarse-geo variants). Parameter-shaped exactly as the API will issue it.
    const collectSeqScans = (node, found = []) => {
      if (node && typeof node === 'object') {
        if (node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'listings') {
          found.push(node);
        }
        for (const child of node.Plans || []) collectSeqScans(child, found);
      }
      return found;
    };
    const explain = async (label, sql, params) => {
      const { rows } = await dbh.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
      const plan = rows[0]['QUERY PLAN'][0];
      // Assert the LISTINGS scan is indexed. (Other tables may seq-scan tiny sets.)
      expect(collectSeqScans(plan.Plan)).toHaveLength(0);
      return plan;
    };

    const dayCuisine = await explain(
      'day+cuisine',
      `SELECT id, title, cuisine, scheduled_start, coarse_lat, coarse_lng, area_label
         FROM listings
         WHERE moderation_status = 'approved' AND status = 'active'
           AND local_date = $1 AND cuisine = $2
         ORDER BY scheduled_start LIMIT 20`,
      [volumeDay, 'mexican']
    );
    const geo = await explain(
      'geo-box',
      `SELECT id, title, scheduled_start, coarse_lat, coarse_lng, area_label
         FROM listings
         WHERE moderation_status = 'approved' AND status = 'active'
           AND coarse_lat BETWEEN $1 AND $2 AND coarse_lng BETWEEN $3 AND $4
         ORDER BY scheduled_start LIMIT 20`,
      [32.6, 32.75, -117.25, -117.1]
    );

    // Record the measured single-query execution times in the test output for the report.
    // eslint-disable-next-line no-console
    console.log(
      `LT-02 EXPLAIN ANALYZE at volume: day+cuisine=${dayCuisine['Execution Time']} ms, ` +
        `geo-box=${geo['Execution Time']} ms (planner: no Seq Scan on listings)`
    );
    expect(dayCuisine['Execution Time']).toBeLessThan(500);
    expect(geo['Execution Time']).toBeLessThan(500);
  }, 60000);
});

describe('LT-01 — approximation probe (state-aware: full LT-01 lands with the wave-3 read paths)', () => {
  test('NFR-01 core endpoints: 404 documented while their wave-3 module is absent, mounted once it lands', async () => {
    // State-aware wave-status marker (scaffold reconciliation for the wave-3 run): while a
    // module's routes.js is not on disk the endpoint 404s (the recorded LT-01 blocker); once
    // the unit lands, the route must be mounted (any non-404 — behaviour belongs to the
    // unit's own tests and this run's verifier extensions, build-plan §7).
    const fs = require('fs');
    const path = require('path');
    const routesOnDisk = (name) =>
      fs.existsSync(path.join(__dirname, '..', '..', 'src', 'modules', name, 'routes.js'));
    const app = createApp({ logger: quiet });

    const search = await request(app).get('/api/listings/search').query({ cuisine: 'mexican' });
    if (routesOnDisk('search')) expect(search.status).not.toBe(404);
    else expect(search.status).toBe(404); // wave-3 module not mounted — LT-01 cannot be run

    const hosts = await request(app).get('/api/hosts/00000000-0000-4000-8000-000000000000');
    if (routesOnDisk('hosts')) expect(hosts.status).not.toBe(404);
    else expect(hosts.status).toBe(404);

    const bookings = await request(app).post('/api/bookings').send({});
    if (routesOnDisk('bookings')) expect(bookings.status).not.toBe(404);
    else expect(bookings.status).toBe(404); // FR-12 race test target absent
  });

  test('200-concurrent-client probe against GET /api/users/me (approximation; measured numbers recorded)', async () => {
    const app = createApp({ logger: quiet });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      // A loginable account (the seeded fixtures/volume rows have inert hashes).
      const email = `lt01.probe.${Date.now()}@resilience.homeplate.invalid`;
      const password = 'CorrectHorseBattery!42';
      const reg = await request(app).post('/api/auth/register').send({ email, password });
      expect(reg.status).toBe(201);
      const login = await request(app).post('/api/auth/login').send({ email, password });
      expect(login.status).toBe(200);
      const cookie = login.headers['set-cookie'][0].split(';')[0];

      const CONCURRENCY = 200;
      const DURATION_MS = 10000;
      const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });
      const latencies = [];
      let errors = 0;
      const errorKinds = {}; // status code or ERR:<code> -> count (diagnosis on failure)
      const deadline = Date.now() + DURATION_MS;

      const oneRequest = () =>
        new Promise((resolve) => {
          const started = process.hrtime.bigint();
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              path: '/api/users/me',
              method: 'GET',
              agent,
              headers: { cookie },
            },
            (res) => {
              res.resume();
              res.on('end', () => {
                const ms = Number(process.hrtime.bigint() - started) / 1e6;
                if (res.statusCode === 200) latencies.push(ms);
                else {
                  errors += 1;
                  errorKinds[res.statusCode] = (errorKinds[res.statusCode] || 0) + 1;
                }
                resolve();
              });
            }
          );
          req.on('error', (e) => {
            errors += 1;
            const k = 'ERR:' + (e.code || e.message);
            errorKinds[k] = (errorKinds[k] || 0) + 1;
            resolve();
          });
          req.end();
        });

      const vu = async () => {
        while (Date.now() < deadline) {
          await oneRequest();
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, vu));
      agent.destroy();

      const total = latencies.length + errors;
      const p50 = quantile(latencies, 0.5);
      const p95 = quantile(latencies, 0.95);
      const p99 = quantile(latencies, 0.99);
      // eslint-disable-next-line no-console
      console.log(
        `LT-01 APPROXIMATION (NOT the NFR-01 scenario — search/browse/review endpoints ` +
          `do not exist at wave 2): GET /api/users/me, ${CONCURRENCY} concurrent clients, ` +
          `${DURATION_MS} ms, in-process server. requests=${total} errors=${errors} ` +
          `throughput=${(total / (DURATION_MS / 1000)).toFixed(0)} req/s ` +
          `p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms p99=${p99.toFixed(1)} ms` +
          (errors > 0 ? ` errorKinds=${JSON.stringify(errorKinds)}` : '')
      );

      expect(total).toBeGreaterThan(CONCURRENCY); // the probe actually ran at concurrency
      expect(errors).toBe(0); // no unhandled failures under load
      expect(Number.isFinite(p95)).toBe(true); // a number was measured and recorded
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 120000);
});
