// tests/rt-lt-resilience/lt01-run.js — the LT-01/LT-02 load scenario (SRS §4.4; NFR-01,
// NFR-02). Lane-owned harness, NOT a Jest file.
//
// k6 is not installed on this machine (`which k6` → not found), so this is the largest honest
// approximation available: a Node VU loop driving the REAL Express app over REAL loopback TCP
// (http.createServer on 127.0.0.1, keep-alive agent, one in-flight request per VU — the k6
// closed model). The endpoint mix is the NFR-01 core-operation set the acceptance names:
//   40%  GET /api/listings/search   (rotating cuisine/time-window/location/page queries)
//   25%  GET /api/listings/:id      (random volume listing)
//   20%  GET /api/hosts/:id         (random volume host page)
//   15%  GET /api/hosts/:id/reviews (random volume host's review page)
// against the NFR-02 volume dataset (10,000 users / 1,000 approved listings on one LA day /
// 1,000 bookings, plus one approved review per volume booking so the review read path has
// real rows). Sessions are real Redis sessions spread across SESSION_COUNT distinct guests.
//
// Usage:
//   Jest (short gate run): const { runLoadScenario } = require('./lt01-run');
//   CLI (measurement run): node tests/rt-lt-resilience/lt01-run.js --vus 200 --duration 300000
//     (requires the docker compose services; runs against the guarded *_test database)
'use strict';

// Idempotent: under Jest this is already loaded; under the CLI it pins the *_test database,
// the isolated Redis index and mock adapter modes before any src/ module loads.
require('../helpers/env');

const http = require('http');

const { createApp } = require('../../src/app');
const { seed, VOLUME_TARGETS } = require('../../scripts/seed');
const { query } = require('../../src/db/pool');

const { quietLogger, quantile } = require('./helpers');
const w3 = require('./wave3');

const SESSION_COUNT = 20;

const CUISINES = [
  'mexican',
  'vietnamese',
  'italian',
  'ethiopian',
  'indian',
  'japanese',
  'american',
  'thai',
];

const LOCATIONS = [
  'La Jolla',
  'downtown san diego',
  'North Park',
  'Chula Vista',
  'Hillcrest',
  'Pacific Beach',
  'Gaslamp Quarter',
  'Ocean Beach',
];

function volumeUuid(block, n) {
  return `${block}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Make sure the NFR-02 volume dataset (plus per-booking approved reviews) is loaded. */
async function ensureVolumeData(log = console) {
  const quietSeedLog = { log: () => {}, warn: () => {} };
  const { rows: listingCount } = await query(
    `SELECT count(*)::int AS n FROM listings WHERE id::text LIKE 'f1000000-%'`
  );
  if (listingCount[0].n < VOLUME_TARGETS.listings) {
    log.log('lt01-run: loading the NFR-02 volume seed…');
    await seed({ set: 'volume', log: quietSeedLog });
  }
  // One approved review per volume booking (guest → host) so FR-03/FR-05 review reads have
  // realistic rows. Deterministic id (= booking id) + ON CONFLICT keeps this idempotent.
  await query(
    `INSERT INTO reviews (id, booking_id, author_id, target_user_id, rating, body, moderation_status)
     SELECT b.id, b.id, b.guest_id, l.host_id,
            1 + (ascii(substr(b.id::text, 36, 1)) % 5),
            'LT volume review — synthetic evaluation text.', 'approved'
       FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE b.id::text LIKE 'f2000000-%'
     ON CONFLICT (id) DO NOTHING`
  );
  const { rows: reviewCount } = await query(
    `SELECT count(*)::int AS n FROM reviews WHERE moderation_status = 'approved'`
  );
  return {
    listings: Math.max(listingCount[0].n, VOLUME_TARGETS.listings),
    reviews: reviewCount[0].n,
  };
}

function pickEndpoint(rng) {
  const r = rng();
  if (r < 0.4) {
    // search — rotate filter shapes so pages hit both the Redis page cache and PostgreSQL.
    const kind = Math.floor(rng() * 4);
    const page = 1 + Math.floor(rng() * 3);
    if (kind === 0) {
      const cuisine = CUISINES[Math.floor(rng() * CUISINES.length)];
      return { name: 'search', path: `/api/listings/search?cuisine=${cuisine}&page=${page}` };
    }
    if (kind === 1) {
      const from = encodeURIComponent('2026-09-15T00:00:00-07:00');
      const to = encodeURIComponent('2026-09-16T00:00:00-07:00');
      return { name: 'search', path: `/api/listings/search?from=${from}&to=${to}&page=${page}` };
    }
    if (kind === 2) {
      const location = encodeURIComponent(LOCATIONS[Math.floor(rng() * LOCATIONS.length)]);
      return {
        name: 'search',
        path: `/api/listings/search?location=${location}&radiusKm=25&page=1`,
      };
    }
    return { name: 'search', path: `/api/listings/search?page=${page}` };
  }
  if (r < 0.65) {
    const id = volumeUuid('f1000000', Math.floor(rng() * VOLUME_TARGETS.listings));
    return { name: 'listingDetail', path: `/api/listings/${id}` };
  }
  if (r < 0.85) {
    const id = volumeUuid('e0000000', Math.floor(rng() * VOLUME_TARGETS.hostProfiles));
    return { name: 'hostPage', path: `/api/hosts/${id}` };
  }
  const id = volumeUuid('e0000000', Math.floor(rng() * VOLUME_TARGETS.hostProfiles));
  return { name: 'hostReviews', path: `/api/hosts/${id}/reviews?pageSize=20` };
}

/** Mulberry32 — deterministic per-VU RNG so runs are comparable. */
function mulberry32(seedValue) {
  let a = seedValue >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function summarize(latencies) {
  // No spread over the sample arrays: at 200 VUs × minutes they hold millions of entries and
  // Math.max(...arr) would overflow the call stack.
  let max = -Infinity;
  for (const v of latencies) if (v > max) max = v;
  return {
    count: latencies.length,
    p50: Number(quantile(latencies, 0.5).toFixed(1)),
    p95: Number(quantile(latencies, 0.95).toFixed(1)),
    p99: Number(quantile(latencies, 0.99).toFixed(1)),
    max: Number(max.toFixed(1)),
  };
}

/**
 * Run the LT-01 scenario.
 * @param {{vus?: number, durationMs?: number, log?: Console}} [options]
 * @returns {Promise<object>} report — measured numbers only, no judgement calls
 */
async function runLoadScenario({ vus = 200, durationMs = 60000, log = console } = {}) {
  const dataset = await ensureVolumeData(log);

  const cookies = [];
  for (let i = 0; i < SESSION_COUNT; i += 1) {
    const guest = await w3.makeGuest();
    cookies.push(await w3.cookieFor(guest));
  }

  const app = createApp({ logger: quietLogger() });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const agent = new http.Agent({ keepAlive: true, maxSockets: vus });

  const byEndpoint = new Map(); // name -> number[]
  const errorKinds = {}; // status/ERR:code -> count
  let errors = 0;
  const startedAt = Date.now();
  const deadline = startedAt + durationMs;

  const oneRequest = (endpoint, cookie) =>
    new Promise((resolve) => {
      const started = process.hrtime.bigint();
      const req = http.request(
        { host: '127.0.0.1', port, path: endpoint.path, method: 'GET', agent, headers: { cookie } },
        (res) => {
          res.resume();
          res.on('end', () => {
            const ms = Number(process.hrtime.bigint() - started) / 1e6;
            if (res.statusCode === 200) {
              if (!byEndpoint.has(endpoint.name)) byEndpoint.set(endpoint.name, []);
              byEndpoint.get(endpoint.name).push(ms);
            } else {
              errors += 1;
              const k = `${endpoint.name}:${res.statusCode}`;
              errorKinds[k] = (errorKinds[k] || 0) + 1;
            }
            resolve();
          });
        }
      );
      req.on('error', (e) => {
        errors += 1;
        const k = `${endpoint.name}:ERR:${e.code || e.message}`;
        errorKinds[k] = (errorKinds[k] || 0) + 1;
        resolve();
      });
      req.end();
    });

  const vu = async (index) => {
    const rng = mulberry32(0x9e3779b9 ^ index);
    const cookie = cookies[index % cookies.length];
    while (Date.now() < deadline) {
      await oneRequest(pickEndpoint(rng), cookie);
    }
  };

  try {
    await Promise.all(Array.from({ length: vus }, (_, i) => vu(i)));
  } finally {
    agent.destroy();
    await new Promise((resolve) => server.close(resolve));
  }

  const wallMs = Date.now() - startedAt;
  const all = [];
  const endpoints = {};
  for (const [name, latencies] of byEndpoint) {
    endpoints[name] = summarize(latencies);
    for (const v of latencies) all.push(v); // no spread — see summarize()
  }
  const total = all.length + errors;
  return {
    scenario: 'LT-01 core-operation mix (search/listing-detail/host-page/host-reviews)',
    harness:
      'node in-process VU loop over real loopback HTTP (k6 unavailable on this host); ' +
      'closed model, 1 in-flight request per VU',
    vus,
    requestedDurationMs: durationMs,
    wallMs,
    dataset: {
      volumeListings: dataset.listings,
      approvedReviews: dataset.reviews,
      users: VOLUME_TARGETS.users,
      bookings: VOLUME_TARGETS.bookings,
    },
    requests: total,
    throughputRps: Number((total / (wallMs / 1000)).toFixed(1)),
    errors,
    errorRate: total > 0 ? Number((errors / total).toFixed(5)) : null,
    errorKinds,
    overall: all.length > 0 ? summarize(all) : null,
    endpoints,
  };
}

module.exports = { runLoadScenario, ensureVolumeData, volumeUuid };

// ---- CLI entry (the recorded measurement run) ------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : fallback;
  };
  (async () => {
    // CONCURRENCY RULE (tests/helpers/env.js, verification-report F-1): standalone scripts on
    // the shared *_test database MUST hold the same 'homeplate_test_suite' advisory lock that
    // serializes Jest runs, for their whole lifetime — otherwise a concurrent suite's schema
    // reset / outbox drills and this load run corrupt each other silently.
    const { acquireSuiteLock } = require('../helpers/env');
    const lock = await acquireSuiteLock({
      onWait: () =>
        console.error(
          'lt01-run: test database is locked by a concurrent suite run — waiting for it to finish'
        ),
    });
    try {
      const report = await runLoadScenario({
        vus: flag('vus', 200),
        durationMs: flag('duration', 300000),
        // Progress to stderr so stdout stays pure JSON (pipeable).
        log: { log: (...a) => console.error(...a), warn: (...a) => console.error(...a) },
      });
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(report, null, 2));
    } finally {
      await lock.release();
    }
    // Pools/redis keep the loop alive; exit explicitly with the run's verdict left to the reader.
    process.exit(0);
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
