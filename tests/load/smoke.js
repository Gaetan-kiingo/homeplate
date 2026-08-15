// tests/load/smoke.js — the LT-01 / LT-02 load scenario expressed in the instrument the
// acceptance criteria name: k6 (SRS §4.4; NFR-01, NFR-02).
//
// Runs under the k6 runtime (`npm run test:load`), NOT under Jest/Node — excluded from
// jest.config.js testPathIgnorePatterns and from the node --check walk in check-build.js.
//
// Requirement traceability (SRS Appendix B):
//   NFR-01 (LT-01) — "200 concurrent virtual users for >= 5 minutes ... http_req_duration
//            p(95) < 500 ms" over the CORE OPERATIONS. The four core read operations of
//            v1.0 are exercised in the mix the wave-3 read paths actually expose:
//              40%  GET /api/listings/search   (FR-01, rotating filter shapes)
//              25%  GET /api/listings/:id      (FR-02 detail: listing + host summary + reviews)
//              20%  GET /api/hosts/:id         (FR-03 host personal page)
//              15%  GET /api/hosts/:id/reviews (FR-03 paginated approved reviews)
//            p(95) is asserted on the STEADY phase only (see `phase` tag below): the warm-up
//            ramp is measured and reported, but the acceptance number is the one produced
//            while 200 VUs are actually concurrent.
//   NFR-02 (LT-02) — the run refuses to start unless the catalogue behind the search
//            endpoint already holds MIN_LISTINGS (default 1000, the NFR-02 floor) active
//            approved listings, so a "pass" can never be claimed against the 4-row dev
//            fixture. Load `npm run seed:volume` first (10,000 users / 1,000 listings /
//            1,000 bookings on one America/Los_Angeles day).
//   NFR-03 / AB-05 — every request carries a real Redis-backed session cookie obtained
//            through POST /api/auth/login over TLS; the endpoints under test all sit behind
//            requireSession, so an unauthenticated load run would only measure 401s.
//   ADR-001 — this is a black-box HTTP client. It imports nothing from src/, calls no
//            adapter and touches neither PostgreSQL nor Redis directly.
//
// HOW TO RUN THE RECORDED MEASUREMENT (the LT-01 evidence run)
//   1. docker compose up -d                      # PostgreSQL, Redis, MinIO
//   2. npm run migrate && npm run seed:volume    # NFR-02 dataset, dev database
//   3. npm run dev                               # server on https://localhost:3000
//   4. npm run test:load                         # this file, defaults = the acceptance shape
//      (add --summary-export=docs/results/lt01-k6-summary.json to capture the numbers, and
//       record the k6 version, run date and dataset size next to them in
//       docs/verification-report.md)
//
//   Point BASE_URL at a server on the DEV database, never at one on the *_test database:
//   Jest owns that one behind the 'homeplate_test_suite' advisory lock and a concurrent
//   load run would corrupt it (verification-report finding F-1). k6 cannot hold that lock.
//
// SMOKE SHAPE (CI-sized sanity run, seconds not minutes):
//   VUS=5 WARMUP=2s DURATION=20s MIN_LISTINGS=1 SESSIONS=2 npm run test:load
//
// ENV KNOBS (all optional): BASE_URL, VUS, DURATION, WARMUP, THINK, SESSIONS, MIN_LISTINGS,
//   CATALOG_PAGES, SESSION_COOKIE_NAME, RUN_ID, LOAD_USER_PASSWORD, LOAD_USER_DOMAIN.
import http from 'k6/http';
import exec from 'k6/execution';
import { check, fail, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'https://localhost:3000';
const VUS = Number(__ENV.VUS || 200); // NFR-01: 200 concurrent virtual users
const DURATION = __ENV.DURATION || '5m'; // NFR-01: >= 5 minutes at that concurrency
const WARMUP = __ENV.WARMUP || '30s'; // ramp 0 -> VUS; measured, but not asserted on
const THINK = Number(__ENV.THINK || 0); // per-iteration think time, seconds (0 = closed model)
const SESSIONS = Number(__ENV.SESSIONS || 20); // distinct logged-in guests sharing the load
const MIN_LISTINGS = Number(__ENV.MIN_LISTINGS || 1000); // NFR-02 dataset floor
const CATALOG_PAGES = Number(__ENV.CATALOG_PAGES || 10); // id-discovery pages (x100 listings)
const COOKIE_NAME = __ENV.SESSION_COOKIE_NAME || 'hp.sid';

// Load-test accounts are created per run. Pin RUN_ID to reuse the previous run's accounts
// (register then answers 409 and the derived password still logs in) instead of adding 20
// more rows. LOAD_USER_PASSWORD overrides the derived value; nothing here is a real secret,
// and no credential is ever hardcoded for a real account.
const RUN_ID = __ENV.RUN_ID || String(Date.now());
const LOAD_USER_DOMAIN = __ENV.LOAD_USER_DOMAIN || 'loadtest.homeplate.invalid';
const LOAD_USER_PASSWORD = __ENV.LOAD_USER_PASSWORD || `lt01-${RUN_ID}-Pw!aa`;

// Query material for the search mix — the same shapes the volume seed produces, so pages
// hit both the Redis page cache and PostgreSQL rather than one warm cell forever.
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

// Two scenarios rather than one ramp with time arithmetic: k6 tags every metric a scenario
// emits with that scenario's tags, so `phase` is exact — no clock reading inside the VU can
// mis-attribute a request that straddles the boundary.
export const options = {
  scenarios: {
    warmup: {
      executor: 'ramping-vus',
      exec: 'coreOperations',
      startVUs: 1,
      stages: [{ duration: WARMUP, target: VUS }],
      gracefulRampDown: '0s',
      gracefulStop: '0s',
      tags: { phase: 'warmup' },
    },
    steady: {
      executor: 'constant-vus',
      exec: 'coreOperations',
      vus: VUS,
      duration: DURATION,
      startTime: WARMUP,
      gracefulStop: '10s',
      tags: { phase: 'steady' },
    },
  },
  // Local dev cert is self-signed (scripts/gen-dev-certs.sh); TLS itself is still enforced —
  // the server refuses plain HTTP (NFR-03).
  insecureSkipTLSVerify: true,
  thresholds: {
    // NFR-01 acceptance: p95 < 500 ms for the core operations at 200 VUs. Asserted overall
    // AND per operation, so one slow endpoint cannot hide behind three fast ones.
    'http_req_duration{phase:steady}': ['p(95)<500'],
    'http_req_duration{phase:steady,endpoint:search}': ['p(95)<500'],
    'http_req_duration{phase:steady,endpoint:listingDetail}': ['p(95)<500'],
    'http_req_duration{phase:steady,endpoint:hostPage}': ['p(95)<500'],
    'http_req_duration{phase:steady,endpoint:hostReviews}': ['p(95)<500'],
    // NFR-01 is a latency budget for SUCCESSFUL work: a run that sheds load is not a pass.
    'http_req_failed{phase:steady}': ['rate<0.01'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max', 'count'],
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Mulberry32 — deterministic per-VU RNG so successive runs are comparable. */
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

/**
 * Create (or reuse) one load-test guest and return its session cookie value.
 * Registration is FR-10: 201 for a new account, 409 when RUN_ID is pinned to a previous run.
 */
function loginSession(index) {
  const email = `lt01-${RUN_ID}-${index}@${LOAD_USER_DOMAIN}`;
  const registered = http.post(
    `${BASE_URL}/api/auth/register`,
    JSON.stringify({ email, password: LOAD_USER_PASSWORD }),
    { headers: JSON_HEADERS, tags: { endpoint: 'setup' } }
  );
  if (registered.status !== 201 && registered.status !== 409) {
    fail(
      `setup: POST /api/auth/register for ${email} answered ${registered.status} ` +
        `(expected 201, or 409 when reusing RUN_ID): ${registered.body}`
    );
  }

  const loggedIn = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email, password: LOAD_USER_PASSWORD }),
    { headers: JSON_HEADERS, tags: { endpoint: 'setup' } }
  );
  if (loggedIn.status !== 200) {
    fail(
      `setup: POST /api/auth/login for ${email} answered ${loggedIn.status}. ` +
        'If RUN_ID is pinned, LOAD_USER_PASSWORD must match the run that created the ' +
        `accounts. Body: ${loggedIn.body}`
    );
  }
  const jar = loggedIn.cookies[COOKIE_NAME];
  if (!jar || jar.length === 0) {
    fail(
      `setup: login response carried no ${COOKIE_NAME} cookie — set SESSION_COOKIE_NAME to ` +
        "match the server's SESSION_COOKIE_NAME."
    );
  }
  return jar[0].value;
}

/**
 * Discover real listing and host ids from the search endpoint (FR-01) and assert the
 * NFR-02 dataset floor. Reading ids from the API instead of hardcoding seed UUIDs keeps
 * the scenario valid against any dataset that is big enough.
 */
function discoverCatalog(cookie) {
  const listingIds = [];
  const hostIds = {};
  let total = 0;

  for (let page = 1; page <= CATALOG_PAGES; page += 1) {
    const res = http.get(`${BASE_URL}/api/listings/search?page=${page}&pageSize=100`, {
      headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
      tags: { endpoint: 'setup' },
    });
    if (res.status !== 200) {
      fail(`setup: GET /api/listings/search?page=${page} answered ${res.status}: ${res.body}`);
    }
    const body = res.json();
    total = body.total;
    for (const listing of body.results) {
      listingIds.push(listing.id);
      if (listing.hostId) hostIds[listing.hostId] = true;
    }
    if (body.results.length < 100) break; // last page
  }

  if (total < MIN_LISTINGS) {
    fail(
      `setup: the catalogue holds ${total} active approved listings but this run requires ` +
        `${MIN_LISTINGS} (NFR-02 floor). Run \`npm run seed:volume\` against the server's ` +
        'database, or lower MIN_LISTINGS for a smoke run — a latency number measured on a ' +
        'toy dataset is not an NFR-01/NFR-02 result.'
    );
  }
  if (listingIds.length === 0) {
    fail('setup: search returned no listings — nothing to measure.');
  }

  return { listingIds, hostIds: Object.keys(hostIds), total };
}

export function setup() {
  const health = http.get(`${BASE_URL}/health`, { tags: { endpoint: 'setup' } });
  if (health.status !== 200) {
    fail(
      `setup: ${BASE_URL}/health answered ${health.status} — start the server ` +
        '(`npm run dev`) before the load run.'
    );
  }

  const cookies = [];
  for (let i = 0; i < SESSIONS; i += 1) {
    cookies.push(loginSession(i));
  }

  const catalog = discoverCatalog(cookies[0]);
  // Printed into the run log so the recorded evidence always states what it measured against.
  console.log(
    `LT-01 setup: ${cookies.length} sessions · catalogue ${catalog.total} active listings · ` +
      `${catalog.listingIds.length} listing ids · ${catalog.hostIds.length} host ids · ` +
      `${VUS} VUs · warmup ${WARMUP} · steady ${DURATION}`
  );
  return { cookies, listingIds: catalog.listingIds, hostIds: catalog.hostIds };
}

/** Pick one core operation according to the LT-01 mix. */
function pickOperation(rng, data) {
  const r = rng();
  if (r < 0.4) {
    // FR-01 search — rotate the filter dimensions so the Redis page cache is exercised
    // alongside cold PostgreSQL pages instead of one permanently warm cell.
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
      return { name: 'search', path: `/api/listings/search?location=${location}&radiusKm=25` };
    }
    return { name: 'search', path: `/api/listings/search?page=${page}` };
  }
  if (r < 0.65) {
    const id = data.listingIds[Math.floor(rng() * data.listingIds.length)];
    return { name: 'listingDetail', path: `/api/listings/${id}` };
  }
  if (r < 0.85) {
    const id = data.hostIds[Math.floor(rng() * data.hostIds.length)];
    return { name: 'hostPage', path: `/api/hosts/${id}` };
  }
  const id = data.hostIds[Math.floor(rng() * data.hostIds.length)];
  return { name: 'hostReviews', path: `/api/hosts/${id}/reviews?pageSize=20` };
}

export function coreOperations(data) {
  const vuId = exec.vu.idInTest;
  const rng = mulberry32((0x9e3779b9 ^ vuId) + exec.scenario.iterationInTest);
  const cookie = data.cookies[vuId % data.cookies.length];
  const operation = pickOperation(rng, data);

  const res = http.get(`${BASE_URL}${operation.path}`, {
    headers: { Cookie: `${COOKIE_NAME}=${cookie}` },
    tags: { endpoint: operation.name },
  });
  check(res, {
    'core operation responds 200': (r) => r.status === 200,
  });

  if (THINK > 0) sleep(THINK);
}
