// tests/adr-conformance/adr-wave3-invariants.test.js — ADR conformance lane (verifier-owned).
//
// Executable audit of the binding architecture invariants over the WAVE-3 core-marketplace
// surface (U3-LISTINGS, U3-SEARCH, U3-HOSTS-MEDIA, U3-BOOKINGS):
//   ADR-001/003 — no adapter loads on any wave-3 request path (the ONE documented exception:
//                 the Maps READ adapter at call time inside a location search, ADR-005 /
//                 build-plan §6.1); listing + its outbox rows and booking + its outbox rows
//                 commit in ONE transaction; injected enqueue failure rolls back the business
//                 row too; every persisted payload is IDs-only.
//   ADR-002     — direction: pending content is invisible (detail 404, absent from search,
//                 unbookable) until approved; the LLM pipeline itself is wave 4.
//   ADR-004     — DELETE /api/media/:id delete-marks only (row + object survive for the
//                 per-object worker/erasure path) and the media disappears from read paths.
//   ADR-006     — both restricted wave-3 flows sit behind requireEligibility (grep + 403
//                 behaviour with zero capacity work).
//   ADR-009     — caps behave as configured over HTTP; the LA-midnight/day-boundary test
//                 submits from a Tokyo-offset client; no cap-valued literal in wave-3 code.
//   ADR-010     — endpoint-by-endpoint allowlist audit (search, listing detail, host page,
//                 booking payloads, Redis-cached search pages) + the full disclosure matrix
//                 (stranger/guest/reverted guest/moderator±alert/owner, with access_log).
//   ADR-011     — booking notifications drain through the worker to persisted
//                 NOTIFICATION_ATTEMPT rows on the mock transport; nothing leaves the process.
//   ADR-007     — repo-wide scan: no provider hostname, model id or key literal anywhere in src.
//   Redis role  — after all wave-3 flows the keyspace is still sessions/rate-limit/cache only.
//
// This file also carries the surviving assertions of the round-1 and round-2 verifier files
// (verify-adr-wave0-3.test.js, reverify-round2-adr.test.js), folded in 2026-08: the per-route
// adapter-purity audits, the xmin-level one-transaction proofs, the watermark-scoped strict
// payload audit, and the FR-07 safety-surface checks those rounds added.
//
// ORDERING MATTERS: the require.cache adapter-purity checks run FIRST; tests that
// legitimately load adapters (worker drain, object-storage verification) run LAST.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const dbh = require('../helpers/db');
const { withOnlyTheseDue } = require('../helpers/outboxScope');

const SRC = path.join(__dirname, '..', '..', 'src');
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// Distinctive precise-location fixture values — must never appear in any public payload,
// search result, cached page or key name.
const SECRET_STREET = 'Adrwave Secret Kitchen St';
const PRECISE_LAT = 32.987654;
const PRECISE_LNG = -117.123456;

let app;
let config;
let sessions;

/** Adapter modules currently loaded in this process (by file path relative to src/). */
function loadedAdapters() {
  return Object.keys(require.cache)
    .filter((p) => p.includes(`${path.sep}src${path.sep}adapters${path.sep}`))
    .map((p) => path.basename(p))
    .sort();
}

/** Recursively list .js files under a directory. */
function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(p));
    else if (entry.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

async function cookieFor(user) {
  const { token } = await sessions.createSession({ id: user.id, roles: user.roles });
  return `${config.auth.sessionCookieName}=${token}`;
}

/** Fully canPublishListing-eligible host (NFR-06: email+name+phone+profile+agreement). */
async function makeEligibleHost(overrides = {}) {
  const host = await dbh.makeUser({
    can_publish_listing: true,
    phone_enc: 'enc:v1:adrconf-fixture',
    ...overrides,
  });
  await dbh.makeHostProfile({ user_id: host.id });
  return host;
}

/** canReserveSeat-eligible guest. */
async function makeEligibleGuest(overrides = {}) {
  return dbh.makeUser({ phone_enc: 'enc:v1:adrconf-fixture', ...overrides });
}

let daySeq = 0;
/** A unique future LA calendar day per call (12:00 PT — no FR-11 collisions). */
function uniqueFutureStart() {
  daySeq += 1;
  return new Date(Date.UTC(2029, 2, 1 + daySeq, 20, 0, 0)).toISOString();
}

function listingBody(overrides = {}) {
  return {
    title: 'ADR lane tasting menu',
    description: 'Wave-3 conformance fixture meal.',
    ingredients: ['rice', 'beans'],
    allergens: ['none'],
    cuisine: 'adrlane',
    scheduledStart: uniqueFutureStart(),
    durationMinutes: 90,
    seatCapacity: 4,
    addressLine1: `4076 ${SECRET_STREET}`,
    city: 'San Diego',
    region: 'CA',
    postalCode: '92103',
    ...overrides,
  };
}

async function approve(listingId) {
  await dbh.query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [listingId]);
}

/** Stamp distinctive precise coordinates + coarse projection onto a listing (simulating the
 *  worker-side geocode result) so leak checks have concrete values to look for. */
async function stampPreciseLocation(listingId) {
  const { coarsen } = require('../../src/lib/geoPrecision');
  const coarse = coarsen(PRECISE_LAT, PRECISE_LNG);
  await dbh.query(
    `UPDATE listings SET lat = $2, lng = $3, coarse_lat = $4, coarse_lng = $5,
            area_label = 'North Park area' WHERE id = $1`,
    [listingId, PRECISE_LAT, PRECISE_LNG, coarse.lat, coarse.lng]
  );
  return coarse;
}

/** Per-route adapter-purity auditor: attributes any newly-loaded adapter to the exact route
 *  that pulled it in, so a violation names its offender instead of failing opaquely. */
function makeRouteAuditor() {
  const perRoute = [];
  const check = async (label, fn) => {
    const before = loadedAdapters();
    const res = await fn();
    const newly = loadedAdapters().filter((a) => !before.includes(a));
    perRoute.push({ label, status: res && res.status, newly });
    return res;
  };
  const expectAdapterFree = () => {
    const offenders = perRoute.filter((r) => r.newly.length > 0);
    expect({
      offenders,
      all: perRoute.map((r) => `${r.label} [${r.status}] -> ${r.newly.join(',') || 'none'}`),
    }).toMatchObject({ offenders: [] });
  };
  return { check, expectAdapterFree };
}

// Watermark for the strict ADR-003 payload audit below. The suite shares ONE database across
// all serially-run suite files and outbox_jobs is only reset in globalSetup, so a whole-table
// scan audits OTHER files' rows as if this file's production paths had written them:
// tests/rt-lt-resilience/rt02-outbox.test.js leaves `rt02.concurrent {"n":0..5}` and
// `rt02.crash/{rt02.retry} {"entityId":"rt02-crash-1"}` behind for good, and other files exercise
// invalid-payload paths that write and then delete a row of a PRODUCTION type (e.g. a
// `listing.geocode {"listingId":"not-a-uuid"}`). Whether those files run before or after this one
// is decided by Jest's timing-cache sequencer, which is why the audit failed in some full-suite
// runs and passed in others (RTLT-04 / ADRC2-01). jest.config maxWorkers=1 runs suite files
// serially and simultaneous `npm test` runs are serialised by the globalSetup advisory lock, so
// every outbox_jobs row with created_at >= this watermark was caused by THIS file — and this file
// never inserts a synthetic outbox row itself (its direct outbox writes are none; the
// enqueue-refuses-the-pool probes live in adr-invariants.test.js and never commit a row).
// Scoping the strict audit to that watermark therefore audits exactly this file's
// production-written rows and nothing else, with no OR clause re-opening the scan to global
// table state. It is also strictly WIDER than filtering by registered handler type: it keeps
// auditing production rows whose handler ships later, such as the `moderation.scan` row the
// listing create path already writes (wave-4 handler).
let outboxWatermark;

beforeAll(async () => {
  const { createApp } = require('../../src/app');
  app = createApp();
  config = require('../../src/config');
  sessions = require('../../src/modules/auth/sessions');
  const { rows } = await dbh.query('SELECT now() AS ts');
  outboxWatermark = rows[0].ts;
});

afterAll(async () => {
  const { closeRedis } = require('../../src/db/redis');
  await dbh.closeDb();
  await closeRedis();
});

// ==========================================================================================
// ADR-001/003 (a) — the wave-3 request path never loads an adapter
// ==========================================================================================
describe('ADR-001/003 — wave-3 request paths are adapter-free', () => {
  test('booting the app with ALL wave-3 modules mounted loads zero adapters', () => {
    expect(loadedAdapters()).toEqual([]);
  });

  test('every mounted wave 0-3 route is exercised and none loads any adapter', async () => {
    // Per-route attribution over the FULL mounted surface (the round-1 verifier found gaps
    // when only the happy-path subset was exercised): auth register, users/me, all listing
    // routes, non-location search, host page + host reviews, all booking routes, and all
    // three media routes INCLUDING the attach path.
    const { check, expectAdapterFree } = makeRouteAuditor();
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const guest = await makeEligibleGuest();
    const guestCookie = await cookieFor(guest);

    // --- auth / users (waves 0-2) ---
    await check('POST /api/auth/register', () =>
      request(app)
        .post('/api/auth/register')
        .send({
          email: `adrconf.${Date.now()}@adrlane.homeplate.invalid`,
          password: 'Sufficiently-Long-Passphrase-9',
          fullName: 'ADR Lane Registrant',
        })
    );
    await check('GET /api/users/me', () =>
      request(app).get('/api/users/me').set('Cookie', hostCookie)
    );

    // --- listings (FR-11 create enqueues listing.geocode + moderation.scan — deferred) ---
    const created = await check('POST /api/listings', () =>
      request(app).post('/api/listings').set('Cookie', hostCookie).send(listingBody())
    );
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;
    await check('PATCH /api/listings/:id', () =>
      request(app)
        .patch(`/api/listings/${listingId}`)
        .set('Cookie', hostCookie)
        .send({ description: 'Updated by the adr-conformance lane.' })
    );
    await approve(listingId);
    await check('GET /api/listings/:id', () =>
      request(app).get(`/api/listings/${listingId}`).set('Cookie', hostCookie)
    );

    // --- search WITHOUT a location — must not touch the Maps adapter at all ---
    await check('GET /api/listings/search (no location)', () =>
      request(app).get('/api/listings/search').query({ hostId: host.id }).set('Cookie', guestCookie)
    );

    // --- hosts (media URLs derived locally — ADR-004/mediaUrls, no storage adapter) ---
    await check('GET /api/hosts/:id', () =>
      request(app).get(`/api/hosts/${host.id}`).set('Cookie', guestCookie)
    );
    await check('GET /api/hosts/:id/reviews', () =>
      request(app).get(`/api/hosts/${host.id}/reviews`).set('Cookie', guestCookie)
    );

    // --- bookings (FR-12..FR-14 — notify jobs enqueued, never sent inline) ---
    const booked = await check('POST /api/bookings', () =>
      request(app).post('/api/bookings').set('Cookie', guestCookie).send({ listingId })
    );
    expect(booked.status).toBe(201);
    const bookingId = booked.body.booking.id;
    await check('GET /api/bookings', () =>
      request(app).get('/api/bookings').set('Cookie', guestCookie)
    );
    await check('GET /api/bookings/:id', () =>
      request(app).get(`/api/bookings/${bookingId}`).set('Cookie', guestCookie)
    );
    const cancelled = await check('POST /api/bookings/:id/cancel', () =>
      request(app).post(`/api/bookings/${bookingId}/cancel`).set('Cookie', guestCookie).send({})
    );
    expect(cancelled.status).toBe(200);

    // --- media: upload-target minting is pure local SigV4 (build-plan §6.3) ---
    const target = await check('POST /api/media/uploads', () =>
      request(app)
        .post('/api/media/uploads')
        .set('Cookie', hostCookie)
        .send({ kind: 'listing', contentType: 'image/jpeg', sizeBytes: 2048 })
    );
    expect(target.status).toBe(200);
    expect(target.body.storageKey.startsWith(`listing/${host.id.toLowerCase()}/`)).toBe(true);
    expect(typeof target.body.uploadUrl).toBe('string');

    const attached = await check('POST /api/media (attach)', () =>
      request(app).post('/api/media').set('Cookie', hostCookie).send({
        storageKey: target.body.storageKey,
        kind: 'listing',
        entityId: listingId,
        contentType: 'image/jpeg',
        sizeBytes: 2048,
      })
    );
    expect(attached.status).toBe(201);
    await check('DELETE /api/media/:id', () =>
      request(app).delete(`/api/media/${attached.body.media.id}`).set('Cookie', hostCookie)
    );

    // THE INVARIANT: no route pulled in an adapter, and the whole process stays clean.
    expectAdapterFree();
    expect(loadedAdapters()).toEqual([]);
  });

  test('safety, auth-lifecycle, users, listing-cancel and completion routes load NO adapter', async () => {
    // Round-2 finding: repair round 1 LANDED A NEW MOUNTED MODULE — src/modules/safety —
    // adding POST /api/bookings/:id/safety-alerts and GET /api/moderation/alerts, and the
    // round-1 audit had never exercised auth login/logout/verify-email, PATCH /api/users/me,
    // listing cancel or booking confirm-completion either. Every route the surface gains
    // must enter this audit the day it mounts.
    const crypto = require('crypto');
    const { check, expectAdapterFree } = makeRouteAuditor();
    const password = 'Sufficiently-Long-Passphrase-9';
    const email = `adrconf.${crypto.randomUUID()}@adrlane.homeplate.invalid`;

    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const guest = await makeEligibleGuest();
    const guestCookie = await cookieFor(guest);

    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send(listingBody());
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;
    await approve(listingId);
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .send({ listingId });
    expect(booked.status).toBe(201);
    const bookingId = booked.body.booking.id;

    // A second listing that we will cancel, so the cancel path is exercised on its own row.
    const toCancel = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send(listingBody());
    expect(toCancel.status).toBe(201);

    const moderator = await dbh.makeUser({ roles: ['moderator'] });
    const moderatorCookie = await cookieFor(moderator);

    // --- auth (wave 0-1) paths the round-1 audit never exercised ---
    await check('POST /api/auth/register (login fixture)', () =>
      request(app)
        .post('/api/auth/register')
        .send({ email, password, fullName: 'ADR Lane Registrant' })
    );
    const login = await check('POST /api/auth/login', () =>
      request(app).post('/api/auth/login').send({ email, password })
    );
    expect(login.status).toBe(200);
    const loginCookie = login.headers['set-cookie'][0].split(';')[0];
    await check('POST /api/auth/verify-email (bad token)', () =>
      request(app)
        .post('/api/auth/verify-email')
        .send({ token: crypto.randomBytes(32).toString('hex') })
    );
    await check('GET /api/auth/verify-email (bad token)', () =>
      request(app)
        .get('/api/auth/verify-email')
        .query({ token: crypto.randomBytes(32).toString('hex') })
    );
    await check('POST /api/auth/logout', () =>
      request(app).post('/api/auth/logout').set('Cookie', loginCookie)
    );

    // --- users ---
    await check('PATCH /api/users/me', () =>
      request(app)
        .patch('/api/users/me')
        .set('Cookie', hostCookie)
        .send({ fullName: 'ADR Lane Renamed' })
    );

    // --- FR-07 safety (landed in repair round 1 — never audited before round 2) ---
    const alert = await check('POST /api/bookings/:id/safety-alerts', () =>
      request(app)
        .post(`/api/bookings/${bookingId}/safety-alerts`)
        .set('Cookie', guestCookie)
        .send()
    );
    expect(alert.status).toBe(201);
    await check('GET /api/moderation/alerts', () =>
      request(app).get('/api/moderation/alerts').set('Cookie', moderatorCookie)
    );

    // --- completion + cancel ---
    await check('POST /api/bookings/:id/confirm-completion', () =>
      request(app)
        .post(`/api/bookings/${bookingId}/confirm-completion`)
        .set('Cookie', guestCookie)
        .send({})
    );
    await check('POST /api/listings/:id/cancel', () =>
      request(app)
        .post(`/api/listings/${toCancel.body.listing.id}/cancel`)
        .set('Cookie', hostCookie)
        .send({})
    );

    expectAdapterFree();
  });

  test('a LOCATION search loads ONLY the Maps read adapter (the documented ADR-005 exception)', async () => {
    const guest = await makeEligibleGuest();
    const res = await request(app)
      .get('/api/listings/search')
      .query({ location: 'San Diego, CA', radiusKm: 10 })
      .set('Cookie', await cookieFor(guest));
    expect(res.status).toBe(200);
    // Maps (read path, cache-first, resilience-wrapped) is the ONE sanctioned exception;
    // SendGrid / FCM / LLM / object storage must still be absent from the process.
    const adapters = loadedAdapters();
    expect(adapters.length).toBeLessThanOrEqual(1);
    for (const name of adapters) expect(name).toBe('maps.js');
  });

  // (The static module-scope-adapter-require scan is repo-wide and lives in
  // adr-invariants.test.js — "static scan: no module-scope adapter require ANYWHERE in
  // src/ outside the worker layer" — which covers every wave-3 module file too.)
});

// ==========================================================================================
// ADR-001/003 (b)(c) — one transaction for business row + outbox rows; IDs-only payloads
// ==========================================================================================
describe('ADR-001/003 — wave-3 transactional outbox, no dual writes, IDs-only payloads', () => {
  test('listing create commits listing + listing.geocode + moderation.scan rows together', async () => {
    const host = await makeEligibleHost();
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    expect(res.status).toBe(201);
    const listingId = res.body.listing.id;

    const { rows: geo } = await dbh.query(
      `SELECT payload, correlation_id FROM outbox_jobs
       WHERE type = 'listing.geocode' AND payload->>'listingId' = $1`,
      [listingId]
    );
    expect(geo).toHaveLength(1);
    expect(Object.keys(geo[0].payload)).toEqual(['listingId']);
    expect(geo[0].correlation_id).toBeTruthy(); // NFR-08: request correlation id on the row

    const { rows: scan } = await dbh.query(
      `SELECT payload FROM outbox_jobs
       WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
      [listingId]
    );
    expect(scan).toHaveLength(1);
    expect(Object.keys(scan[0].payload).sort()).toEqual(['contentId', 'contentType']);
    // ADR-003: nothing address- or email-shaped in any of the payloads.
    expect(JSON.stringify(geo[0].payload) + JSON.stringify(scan[0].payload)).not.toMatch(
      new RegExp(`${SECRET_STREET}|@`, 'i')
    );
  });

  test('listing row and BOTH its outbox rows carry the SAME xmin (one inserting transaction)', async () => {
    // Row-level PROOF of the single transaction: xmin is the inserting transaction id, so
    // three rows sharing one xmin were committed by one transaction — stronger evidence
    // than the rows merely existing together after the response.
    const host = await makeEligibleHost();
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    expect(res.status).toBe(201);
    const listingId = res.body.listing.id;

    const { rows: listingRows } = await dbh.query(
      `SELECT xmin::text AS xid FROM listings WHERE id = $1`,
      [listingId]
    );
    const { rows: jobRows } = await dbh.query(
      `SELECT type, xmin::text AS xid FROM outbox_jobs
        WHERE payload->>'listingId' = $1 OR payload->>'contentId' = $1
        ORDER BY type`,
      [listingId]
    );
    expect(jobRows.map((r) => r.type)).toEqual(['listing.geocode', 'moderation.scan']);
    const distinct = new Set([listingRows[0].xid, ...jobRows.map((r) => r.xid)]);
    expect([...distinct]).toHaveLength(1);
  });

  test('no dual write: injected enqueue failure rolls the LISTING row back too', async () => {
    const outbox = require('../../src/outbox/outbox');
    const host = await makeEligibleHost();
    const spy = jest
      .spyOn(outbox, 'enqueue')
      .mockRejectedValue(new Error('adr-conformance: injected enqueue failure'));
    let res;
    try {
      res = await request(app)
        .post('/api/listings')
        .set('Cookie', await cookieFor(host))
        .send(listingBody({ title: 'Rollback probe meal' }));
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBeGreaterThanOrEqual(500);
    const { rows } = await dbh.query(`SELECT id FROM listings WHERE host_id = $1`, [host.id]);
    expect(rows).toEqual([]); // the business row did not survive the outbox failure
  });

  test('booking create commits booking + 2 notify.booking + scheduled booking.promote together', async () => {
    const host = await makeEligibleHost();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;
    const scheduledStart = created.body.listing.scheduledStart;
    await approve(listingId);

    const guest = await makeEligibleGuest();
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId });
    expect(booked.status).toBe(201);
    const bookingId = booked.body.booking.id;

    const { rows: notify } = await dbh.query(
      `SELECT payload FROM outbox_jobs
       WHERE type = 'notify.booking' AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    expect(notify).toHaveLength(2); // guest + host
    const recipients = notify.map((r) => r.payload.recipientUserId).sort();
    expect(recipients).toEqual([guest.id, host.id].sort());
    for (const row of notify) {
      expect(Object.keys(row.payload).sort()).toEqual(['bookingId', 'event', 'recipientUserId']);
      expect(JSON.stringify(row.payload)).not.toMatch(EMAIL_SHAPE);
    }

    const { rows: promote } = await dbh.query(
      `SELECT payload, available_at FROM outbox_jobs
       WHERE type = 'booking.promote' AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    expect(promote).toHaveLength(1);
    expect(Object.keys(promote[0].payload)).toEqual(['bookingId']);
    // Scheduled deferral: the promote job becomes due exactly at the meal's start instant.
    expect(new Date(promote[0].available_at).getTime()).toBe(new Date(scheduledStart).getTime());
  });

  test('booking row, both notify.booking rows and booking.promote share ONE xmin', async () => {
    const host = await makeEligibleHost();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    const listingId = created.body.listing.id;
    await approve(listingId);

    const guest = await makeEligibleGuest();
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId });
    expect(booked.status).toBe(201);
    const bookingId = booked.body.booking.id;

    const { rows: bRows } = await dbh.query(
      `SELECT xmin::text AS xid FROM bookings WHERE id = $1`,
      [bookingId]
    );
    const { rows: jRows } = await dbh.query(
      `SELECT type, xmin::text AS xid FROM outbox_jobs WHERE payload->>'bookingId' = $1`,
      [bookingId]
    );
    expect(jRows).toHaveLength(3); // 2 × notify.booking + 1 × booking.promote
    const distinct = new Set([bRows[0].xid, ...jRows.map((r) => r.xid)]);
    expect([...distinct]).toHaveLength(1);
  });

  test('FR-07 safety alert: safety_alerts row and its safety.alert outbox row share one xmin, IDs only', async () => {
    // Round-2 scope: repair round 1 added the FR-07 write path, so the one-transaction /
    // IDs-only rules are re-proven on it. (tests/tc-core/tc07-safety.test.js pins the exact
    // payload shape; the xmin-level single-transaction proof lives only here.)
    const host = await makeEligibleHost();
    const guest = await makeEligibleGuest();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    const listingId = created.body.listing.id;
    await approve(listingId);
    const guestCookie = await cookieFor(guest);
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .send({ listingId });
    const bookingId = booked.body.booking.id;

    const res = await request(app)
      .post(`/api/bookings/${bookingId}/safety-alerts`)
      .set('Cookie', guestCookie)
      .send();
    expect(res.status).toBe(201);
    const alertId = res.body.alert.id;

    const { rows: alertRows } = await dbh.query(
      `SELECT xmin::text AS xid FROM safety_alerts WHERE id = $1`,
      [alertId]
    );
    const { rows: jobRows } = await dbh.query(
      `SELECT type, payload, xmin::text AS xid FROM outbox_jobs WHERE payload->>'alertId' = $1`,
      [alertId]
    );
    expect(jobRows.map((r) => r.type)).toEqual(['safety.alert']);
    expect(new Set([alertRows[0].xid, ...jobRows.map((r) => r.xid)]).size).toBe(1);

    // IDs only — no email, no street text, every value a UUID.
    const payload = jobRows[0].payload;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const [k, v] of Object.entries(payload)) {
      expect({ k, ok: typeof v === 'string' && UUID.test(v) }).toEqual({ k, ok: true });
    }
    expect(JSON.stringify(payload)).not.toContain(SECRET_STREET);
    expect(JSON.stringify(payload)).not.toMatch(EMAIL_SHAPE);
  });

  test('no dual write: injected enqueue failure rolls back the BOOKING row and the seat', async () => {
    const outbox = require('../../src/outbox/outbox');
    const host = await makeEligibleHost();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    const listingId = created.body.listing.id;
    await approve(listingId);
    const before = (
      await dbh.query(`SELECT seats_remaining FROM listings WHERE id = $1`, [listingId])
    ).rows[0].seats_remaining;

    const guest = await makeEligibleGuest();
    const spy = jest
      .spyOn(outbox, 'enqueue')
      .mockRejectedValue(new Error('adr-conformance: injected enqueue failure'));
    let res;
    try {
      res = await request(app)
        .post('/api/bookings')
        .set('Cookie', await cookieFor(guest))
        .send({ listingId });
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBeGreaterThanOrEqual(500);
    const { rows: bookings } = await dbh.query(`SELECT id FROM bookings WHERE guest_id = $1`, [
      guest.id,
    ]);
    expect(bookings).toEqual([]); // no booking row
    const after = (
      await dbh.query(`SELECT seats_remaining FROM listings WHERE id = $1`, [listingId])
    ).rows[0].seats_remaining;
    expect(after).toBe(before); // the conditional decrement rolled back with it
  });

  test('audit: EVERY persisted outbox payload in the database is free of PII shapes', async () => {
    const { rows } = await dbh.query('SELECT id, type, payload FROM outbox_jobs');
    const offenders = rows.filter(
      (r) =>
        EMAIL_SHAPE.test(JSON.stringify(r.payload)) ||
        JSON.stringify(r.payload).includes(SECRET_STREET)
    );
    expect(offenders).toEqual([]);
  });

  test('strict audit: every payload key/value THIS file wrote is an id, enum or digest', async () => {
    // Every outbox row this file's production paths wrote, and only those (see outboxWatermark
    // at the top of the file). No `OR type = ANY(...)` here: that half re-globalised the scan
    // to every row of a production type written by any other suite in the run, which is what
    // made this assertion order-dependent and intermittently red (RTLT-04).
    const { rows } = await dbh.query(
      `SELECT id, type, payload, dedupe_key FROM outbox_jobs WHERE created_at >= $1`,
      [outboxWatermark]
    );
    // Non-vacuity, in two parts: the window must hold rows at all, and at least one must be of a
    // REGISTERED production handler type — read from the handler modules themselves, so a wave-4
    // handler counts automatically. If the flows above ever stop enqueueing, this fails loudly
    // instead of auditing an empty set and reporting a green ADR-003 invariant.
    const productionTypes = fs
      .readdirSync(path.join(SRC, 'outbox', 'handlers'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => require(path.join(SRC, 'outbox', 'handlers', f)).type)
      .filter(Boolean);
    expect(productionTypes.length).toBeGreaterThan(0);
    expect(rows.length).toBeGreaterThan(0);
    const auditedTypes = new Set(rows.map((r) => r.type));
    expect(productionTypes.filter((t) => auditedTypes.has(t)).length).toBeGreaterThan(0);
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const SHA256 = /^[0-9a-f]{64}$/i;
    const ENUMISH = /^[a-z][a-z0-9_.]{0,60}$/;
    const offenders = [];
    for (const row of rows) {
      const text = JSON.stringify(row.payload);
      if (EMAIL_SHAPE.test(text)) offenders.push(`${row.type}#${row.id}: email-shaped value`);
      if (text.includes(SECRET_STREET)) offenders.push(`${row.type}#${row.id}: street address`);
      for (const [k, v] of Object.entries(row.payload || {})) {
        if (typeof v !== 'string') {
          offenders.push(`${row.type}#${row.id}: ${k} is not a string id (${typeof v})`);
          continue;
        }
        if (!UUID.test(v) && !SHA256.test(v) && !ENUMISH.test(v)) {
          offenders.push(`${row.type}#${row.id}: ${k}="${v}" is neither id, digest nor enum`);
        }
      }
      if (row.dedupe_key && EMAIL_SHAPE.test(row.dedupe_key)) {
        offenders.push(`${row.type}#${row.id}: dedupe_key is email-shaped`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ==========================================================================================
// ADR-002 (d) — pending content cannot reach the public (wave-3 direction)
// ==========================================================================================
describe('ADR-002 — unapproved listings are invisible and unbookable until approved', () => {
  test('a freshly created listing is pending, 404 to strangers, absent from search, unbookable', async () => {
    const host = await makeEligibleHost();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    expect(created.status).toBe(201);
    expect(created.body.listing.moderationStatus).toBe('pending');
    const listingId = created.body.listing.id;

    const stranger = await makeEligibleGuest();
    const strangerCookie = await cookieFor(stranger);

    // Detail: indistinguishable from absent (FR-08/AB-01).
    const detail = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Cookie', strangerCookie);
    expect(detail.status).toBe(404);

    // Search: the unconditional visibility invariant excludes it.
    const search = await request(app)
      .get('/api/listings/search')
      .query({ hostId: host.id })
      .set('Cookie', strangerCookie);
    expect(search.status).toBe(200);
    expect(search.body.results.map((r) => r.id)).not.toContain(listingId);

    // Booking: 404, no moderation-state oracle.
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', strangerCookie)
      .send({ listingId });
    expect(booked.status).toBe(404);

    // Host page: the pending listing is absent from the host's example dishes too.
    const hostPage = await request(app).get(`/api/hosts/${host.id}`).set('Cookie', strangerCookie);
    expect(hostPage.status).toBe(200);
    expect(hostPage.body.host.exampleDishes.map((d) => d.id)).not.toContain(listingId);

    // Only approval opens the gates.
    await approve(listingId);
    const detailAfter = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Cookie', strangerCookie);
    expect(detailAfter.status).toBe(200);
    const bookedAfter = await request(app)
      .post('/api/bookings')
      .set('Cookie', strangerCookie)
      .send({ listingId });
    expect(bookedAfter.status).toBe(201);
  });

  test('a MATERIAL edit resets an approved listing to pending and re-enqueues the scan', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody());
    const listingId = created.body.listing.id;
    await approve(listingId);

    const patched = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', cookie)
      .send({ title: 'Completely different dish now' });
    expect(patched.status).toBe(200);
    expect(patched.body.listing.moderationStatus).toBe('pending');

    const { rows } = await dbh.query(
      `SELECT count(*)::int AS n FROM outbox_jobs
       WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
      [listingId]
    );
    expect(rows[0].n).toBe(2); // create + material edit
  });

  test('a moderation-provider outage (no handler at all) leaves the listing PENDING, never published', async () => {
    // FR-08 failure direction: when the scan job cannot complete — here because the wave-4
    // handler does not exist yet, so it retries and DEAD-LETTERS — the content must stay
    // pending throughout. Dead-lettering may lose the scan; it may never publish unreviewed.
    // (A single-poll deferral under a mocked provider outage is drilled separately in
    // tests/rt-lt-resilience/rt01-wave3-degradation.test.js drill 3.)
    const host = await makeEligibleHost();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    const listingId = created.body.listing.id;

    const worker = require('../../src/outbox/worker');
    const dispatch = require('../../src/outbox/dispatch');
    const registry = dispatch.loadHandlers();
    const quiet = {
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => quiet,
    };
    // DETERMINISM (verification-report F-01): scope every pass to THIS listing's scan job.
    // Unscoped, each batchSize-50 pass also claimed whatever pending rows sibling suites left
    // in the shared table — delivering or retrying rows this test does not own.
    const { rows: ownScans } = await dbh.query(
      `SELECT id FROM outbox_jobs
        WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
      [listingId]
    );
    await withOnlyTheseDue(
      ownScans.map((r) => r.id),
      async () => {
        for (let i = 0; i < config.outbox.maxAttempts + 2; i += 1) {
          await dbh.query(
            `UPDATE outbox_jobs SET available_at = now() - interval '1 hour'
              WHERE type = 'moderation.scan' AND payload->>'contentId' = $1 AND status = 'pending'`,
            [listingId]
          );
          await worker.pollOnce({ registry, log: quiet, batchSize: 50 });
        }
      }
    );
    const { rows } = await dbh.query(
      `SELECT status, last_error FROM outbox_jobs
        WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
      [listingId]
    );
    expect(rows[0].status).toBe('dead');
    expect(rows[0].last_error).toMatch(/no outbox handler registered/);

    const listing = await dbh.query(`SELECT moderation_status FROM listings WHERE id = $1`, [
      listingId,
    ]);
    expect(listing.rows[0].moderation_status).toBe('pending');
  });
});

// ==========================================================================================
// ADR-006 (f) — the single eligibility gate fronts both restricted wave-3 flows
// ==========================================================================================
describe('ADR-006 — requireEligibility fronts listing create and booking create', () => {
  test('static: both wave-3 restricted routes consult the ONE eligibility middleware', () => {
    const listings = fs.readFileSync(path.join(SRC, 'modules', 'listings', 'routes.js'), 'utf8');
    const bookings = fs.readFileSync(path.join(SRC, 'modules', 'bookings', 'routes.js'), 'utf8');
    expect(listings).toMatch(/requireEligibility\(\s*ACTIONS\.PUBLISH_LISTING/);
    expect(bookings).toMatch(/requireEligibility\(\s*policy\.ACTIONS\.RESERVE_SEAT/);
    expect(listings).toMatch(/require\(['"][^'"]*eligibility\/middleware['"]\)/);
    expect(bookings).toMatch(/require\(['"][^'"]*eligibility\/middleware['"]\)/);

    // ...and the gated set is EXACTLY these two: any routes.js that names requireEligibility
    // must import the one middleware module, and no third route quietly grew a gate (or a
    // homegrown copy) without entering this audit.
    const gated = [];
    for (const file of listJsFiles(path.join(SRC, 'modules'))) {
      if (!file.endsWith('routes.js')) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('requireEligibility')) {
        expect(text).toMatch(/require\(['"][^'"]*eligibility\/middleware['"]\)/);
        gated.push(path.relative(SRC, file));
      }
    }
    expect(gated.sort()).toEqual([
      path.join('modules', 'bookings', 'routes.js'),
      path.join('modules', 'listings', 'routes.js'),
    ]);
  });

  test('an ineligible host is 403 on POST /api/listings and no listing row is written', async () => {
    // Missing phone AND host profile AND unverified email — canPublishListing must refuse,
    // with a TYPED error and FR-09 reason codes (not a bare status the client cannot act on).
    const notHost = await dbh.makeUser({ can_publish_listing: false, email_verified: false });
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(notHost))
      .send(listingBody());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_ELIGIBLE');
    expect(res.body.error.details.reasons).toEqual(expect.arrayContaining(['EMAIL_UNVERIFIED']));
    const { rows } = await dbh.query(`SELECT id FROM listings WHERE host_id = $1`, [notHost.id]);
    expect(rows).toEqual([]);
  });

  test('an ineligible guest is 403 on POST /api/bookings with ZERO capacity work (AB-02)', async () => {
    const listing = await dbh.makeListing({ moderation_status: 'approved' });
    const before = (
      await dbh.query(`SELECT seats_remaining FROM listings WHERE id = $1`, [listing.id])
    ).rows[0].seats_remaining;

    const ineligible = await dbh.makeUser({ phone_enc: null }); // PHONE_MISSING
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(ineligible))
      .send({ listingId: listing.id });
    expect(res.status).toBe(403);

    const after = (
      await dbh.query(`SELECT seats_remaining FROM listings WHERE id = $1`, [listing.id])
    ).rows[0].seats_remaining;
    expect(after).toBe(before); // the refusal happened BEFORE any capacity work
    const { rows } = await dbh.query(`SELECT id FROM bookings WHERE guest_id = $1`, [
      ineligible.id,
    ]);
    expect(rows).toEqual([]);
  });
});

// ==========================================================================================
// ADR-009 (i) — configured caps over HTTP; America/Los_Angeles day boundary from a
// different client timezone
// ==========================================================================================
describe('ADR-009 — MEHKO caps enforced server-side in America/Los_Angeles', () => {
  test('second listing just after LA midnight, submitted with Tokyo-offset timestamps, is refused', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);

    // 13:00 PST on 2029-03-10, sent in the host's own LA offset.
    const first = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody({ scheduledStart: '2029-03-10T13:00:00-08:00' }));
    expect(first.status).toBe(201);
    // ADRC-W3-01 (fixed round 2): localDate must be the plain YYYY-MM-DD calendar string
    // on the wire — never a server-timezone-dependent ISO timestamp (serializers.isoCalendarDate).
    expect(first.body.listing.localDate).toBe('2029-03-10');

    // A client in Tokyo submits "2029-03-11T16:30 local" = 07:30Z = 23:30 LA on MAR 10 —
    // a different UTC day and a different Tokyo day, but the SAME LA calendar day → 409.
    const sameLaDay = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody({ scheduledStart: '2029-03-11T16:30:00+09:00' }));
    expect(sameLaDay.status).toBe(409);
    expect(sameLaDay.body.error.code).toBe('MEHKO_DAILY_LISTING_LIMIT');

    // Forty minutes later in Tokyo = 00:10 LA on Mar 11 — the NEXT LA day (same UTC day as
    // the refused attempt) → allowed. Proves the boundary is LA midnight, not UTC/客-local.
    const nextLaDay = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody({ scheduledStart: '2029-03-11T17:10:00+09:00' }));
    expect(nextLaDay.status).toBe(201);
    expect(nextLaDay.body.listing.localDate).toBe('2029-03-11');
  });

  test('daily meal cap comes from config: maxMealsPerDay+1 seats → 422 MEHKO_DAILY_MEAL_LIMIT', async () => {
    const host = await makeEligibleHost();
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody({ seatCapacity: config.mehko.maxMealsPerDay + 1 }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MEHKO_DAILY_MEAL_LIMIT');
  });

  test('weekly meal cap comes from config across a Monday-anchored LA week', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const daily = config.mehko.maxMealsPerDay;
    const weekly = config.mehko.maxMealsPerWeek;
    // Mon 2029-06-04 … Sun 2029-06-10 is one LA week; 06-05 is Tue (20:00Z = 13:00 PDT).
    // Fill it with whole days of at most `daily` seats each: the DAILY cap forbids packing the
    // remainder into a single listing, which is what the AB 1325 move from 60 to 90 exposed.
    const day = (n) => `2029-06-${String(n).padStart(2, '0')}T20:00:00Z`;
    const remainder = weekly % daily;
    const fills = [
      ...Array(Math.floor(weekly / daily)).fill(daily),
      ...(remainder ? [remainder] : []),
    ];
    expect(fills.length).toBeLessThan(7); // must leave a day for the overflow listing

    for (let i = 0; i < fills.length; i += 1) {
      const res = await request(app)
        .post('/api/listings')
        .set('Cookie', cookie)
        .send(listingBody({ scheduledStart: day(5 + i), seatCapacity: fills[i] }));
      expect(res.status).toBe(201);
    }
    // The week's seats are exactly at the configured cap — one more seat must refuse.
    const over = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody({ scheduledStart: day(5 + fills.length), seatCapacity: 1 }));
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('MEHKO_WEEKLY_MEAL_LIMIT');
  });

  test('static: no cap-valued literal in wave-3 modules or schemas (config is the only home)', () => {
    const { fileHardcodesCap, capLiteralHits } = require('../helpers/capScan');
    const capValues = [
      config.mehko.listingsPerHostPerDay,
      config.mehko.maxMealsPerDay,
      config.mehko.maxMealsPerWeek,
    ];
    const offenders = [];
    for (const dir of [path.join(SRC, 'modules'), path.join(SRC, 'schemas')]) {
      for (const file of listJsFiles(dir)) {
        if (fileHardcodesCap(file, capValues)) offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);

    // The PRE-AB-1325 weekly cap (60) must not survive as a stale literal in the enforcement
    // module either: scanning only current config values would never notice a fossilized old
    // policy number that a future "revert" or copy-paste could silently reactivate.
    const mehkoSource = fs.readFileSync(path.join(SRC, 'modules', 'listings', 'mehko.js'), 'utf8');
    expect(capLiteralHits(mehkoSource, [60])).toEqual([]);
  });

  test('exactly ONE server-side enforcement point exists and every mutation path calls it', () => {
    const enforcement = [];
    for (const file of listJsFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      if (/function\s+assertWithinCaps/.test(text)) enforcement.push(path.relative(SRC, file));
    }
    expect(enforcement).toEqual([path.join('modules', 'listings', 'mehko.js')]);

    const service = fs.readFileSync(path.join(SRC, 'modules', 'listings', 'service.js'), 'utf8');
    // create + update both consult it; cancel needs no cap check (it frees capacity).
    expect(service.match(/mehko\.assertWithinCaps\(/g)).toHaveLength(2);
  });

  test('localDate is a plain YYYY-MM-DD date on EVERY read path (no timezone-bearing timestamp)', async () => {
    // ADRC-W3-01 (fixed round 2): localDate must be the plain calendar string on the wire —
    // never a server-timezone-dependent ISO timestamp — on detail, search and the host page,
    // not just on the create response (serializers.isoCalendarDate).
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody({ cuisine: 'adrlanedate' }));
    const listingId = created.body.listing.id;
    await approve(listingId);

    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    expect(created.body.listing.localDate).toMatch(DATE_ONLY);

    const detail = await request(app).get(`/api/listings/${listingId}`).set('Cookie', cookie);
    expect(detail.body.listing.localDate).toMatch(DATE_ONLY);

    const search = await request(app)
      .get('/api/listings/search')
      .query({ cuisine: 'adrlanedate' })
      .set('Cookie', cookie);
    for (const r of search.body.results) expect(r.localDate).toMatch(DATE_ONLY);

    const hostPage = await request(app).get(`/api/hosts/${host.id}`).set('Cookie', cookie);
    for (const d of hostPage.body.host.exampleDishes) expect(d.localDate).toMatch(DATE_ONLY);

    // And the value equals the stored SQL DATE, not an off-by-one projection of it.
    const { rows } = await dbh.query(`SELECT local_date::text AS d FROM listings WHERE id = $1`, [
      listingId,
    ]);
    expect(detail.body.listing.localDate).toBe(rows[0].d);
  });
});

// ==========================================================================================
// ADR-010 (j) — endpoint-by-endpoint disclosure audit
// ==========================================================================================
describe('ADR-010 — public serializer is the default on EVERY listing/host read path', () => {
  const serializers = () => require('../../src/modules/listings/serializers');

  let host;
  let hostCookie;
  let listingId;
  let coarse;

  beforeAll(async () => {
    host = await makeEligibleHost();
    hostCookie = await cookieFor(host);
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send(listingBody());
    expect(created.status).toBe(201);
    listingId = created.body.listing.id;
    await approve(listingId);
    coarse = await stampPreciseLocation(listingId);
  });

  function expectPublicShape(listing) {
    const { PUBLIC_KEYS, PRIVILEGED_ONLY_KEYS } = serializers();
    expect(Object.keys(listing).sort()).toEqual([...PUBLIC_KEYS].sort());
    for (const key of PRIVILEGED_ONLY_KEYS) expect(listing[key]).toBeUndefined();
    const text = JSON.stringify(listing);
    expect(text).not.toContain(SECRET_STREET);
    expect(text).not.toContain(String(PRECISE_LAT));
    expect(text).not.toContain(String(PRECISE_LNG));
  }

  // FR-02: the DETAIL endpoint additionally carries {host, reviews} (DETAIL_CONTEXT_KEYS) in
  // the SAME response. The listing projection itself must still be exactly PUBLIC_KEYS, the
  // host summary is its own exact allowlist, and the attached context may add no location or
  // contact data (the string canaries run over the FULL payload, context included).
  function expectPublicDetailShape(listing) {
    const { DETAIL_CONTEXT_KEYS, HOST_SUMMARY_KEYS } = serializers();
    const base = { ...listing };
    for (const key of DETAIL_CONTEXT_KEYS) delete base[key];
    expectPublicShape(base);
    if (listing.host !== null && listing.host !== undefined) {
      expect(Object.keys(listing.host).sort()).toEqual([...HOST_SUMMARY_KEYS].sort());
    }
    expect(Array.isArray(listing.reviews)).toBe(true);
    const text = JSON.stringify(listing);
    expect(text).not.toContain(SECRET_STREET);
    expect(text).not.toContain(String(PRECISE_LAT));
    expect(text).not.toContain(String(PRECISE_LNG));
  }

  test('LISTING DETAIL: a stranger gets exactly the PUBLIC_KEYS allowlist — nothing precise', async () => {
    const stranger = await makeEligibleGuest();
    const res = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Cookie', await cookieFor(stranger));
    expect(res.status).toBe(200);
    expectPublicDetailShape(res.body.listing);
    // The coarse projection IS served, and it is exactly the grid-snapped value — not the
    // precise coordinate under a reassuring name.
    expect(res.body.listing.coarseLat).toBeCloseTo(coarse.lat, 6);
    expect(res.body.listing.coarseLng).toBeCloseTo(coarse.lng, 6);
  });

  test('SEARCH: results are public-shaped AND the Redis-cached page holds public precision only', async () => {
    const { redis } = require('../../src/db/redis');
    const viewer = await makeEligibleGuest();
    const res = await request(app)
      .get('/api/listings/search')
      .query({ hostId: host.id })
      .set('Cookie', await cookieFor(viewer));
    expect(res.status).toBe(200);
    const mine = res.body.results.find((r) => r.id === listingId);
    expect(mine).toBeDefined();
    expectPublicShape(mine);

    // The cached copy can never leak what the response itself does not carry.
    const keys = await redis.keys('hp:cache:search:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toMatch(new RegExp(SECRET_STREET.split(' ')[0], 'i')); // digest keys only
      expect(key).not.toMatch(/\d{2,}\.\d{4,}/); // no coordinates in key names either
      const raw = await redis.get(key);
      if (raw === null) continue;
      expect(raw).not.toContain(SECRET_STREET);
      expect(raw).not.toContain(String(PRECISE_LAT));
      expect(raw).not.toContain(String(PRECISE_LNG));
    }
  });

  test('HOST PAGE: exact allowlist; example dishes public-shaped; zero contact/location PII', async () => {
    const { HOST_PAGE_KEYS } = require('../../src/modules/hosts/serializers');
    const viewer = await makeEligibleGuest();
    const res = await request(app)
      .get(`/api/hosts/${host.id}`)
      .set('Cookie', await cookieFor(viewer));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.host).sort()).toEqual([...HOST_PAGE_KEYS].sort());
    // Independent re-derivation of the allowlist (round-1 verifier): pin the ACTUAL key
    // names, so an unnoticed edit to HOST_PAGE_KEYS itself cannot silently widen the page.
    expect(Object.keys(res.body.host).sort()).toEqual(
      [
        'averageRating',
        'displayName',
        'exampleDishes',
        'id',
        'images',
        'memberSince',
        'reviewCount',
        'reviews',
        'selfIntroduction',
      ].sort()
    );
    for (const dish of res.body.host.exampleDishes) expectPublicShape(dish);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(EMAIL_SHAPE);
    expect(text).not.toMatch(/phone|password|argon2|addressLine|postalCode|"lat"|"lng"/i);
    expect(text).not.toContain(SECRET_STREET);

    // The host REVIEWS endpoint is a read path too — same canaries apply.
    const reviews = await request(app)
      .get(`/api/hosts/${host.id}/reviews`)
      .set('Cookie', await cookieFor(viewer));
    expect(reviews.status).toBe(200);
    const reviewText = JSON.stringify(reviews.body);
    expect(reviewText).not.toContain(SECRET_STREET);
    expect(reviewText).not.toContain(String(PRECISE_LAT));
    expect(reviewText).not.toContain(String(PRECISE_LNG));
    expect(reviewText).not.toMatch(EMAIL_SHAPE);
  });

  test('BOOKING PAYLOADS: create/detail/list embed only the public listing reference', async () => {
    const guest = await makeEligibleGuest();
    const guestCookie = await cookieFor(guest);
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .send({ listingId });
    expect(booked.status).toBe(201);
    const bookingId = booked.body.booking.id;

    const detail = await request(app).get(`/api/bookings/${bookingId}`).set('Cookie', guestCookie);
    const list = await request(app).get('/api/bookings').set('Cookie', guestCookie);
    for (const body of [booked.body, detail.body, list.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(SECRET_STREET);
      expect(text).not.toContain(String(PRECISE_LAT));
      expect(text).not.toContain(String(PRECISE_LNG));
      expect(text).not.toMatch(/addressLine|postalCode/);
    }
    // The live guest gets the address from the LISTING DETAIL endpoint (next test) — the
    // booking payload itself stays coarse by design.
    await request(app)
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Cookie', guestCookie)
      .send({});
  });

  test('DISCLOSURE MATRIX: pending guest → exact address; cancelled guest reverts to public', async () => {
    const { PUBLIC_KEYS, PRIVILEGED_ONLY_KEYS } = serializers();
    const guest = await makeEligibleGuest();
    const guestCookie = await cookieFor(guest);

    // Before booking: public only.
    const before = await request(app).get(`/api/listings/${listingId}`).set('Cookie', guestCookie);
    expectPublicDetailShape(before.body.listing);

    // Pending booking: the privileged projection appears, with the EXACT stored values.
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .send({ listingId });
    expect(booked.status).toBe(201);
    const during = await request(app).get(`/api/listings/${listingId}`).set('Cookie', guestCookie);
    expect(during.status).toBe(200);
    const { DETAIL_CONTEXT_KEYS } = serializers();
    const detailKeys = Object.keys(during.body.listing).filter(
      (k) => !DETAIL_CONTEXT_KEYS.includes(k)
    );
    expect(detailKeys.sort()).toEqual([...PUBLIC_KEYS, ...PRIVILEGED_ONLY_KEYS].sort());
    expect(during.body.listing.addressLine1).toContain(SECRET_STREET);
    expect(during.body.listing.lat).toBeCloseTo(PRECISE_LAT, 6);
    expect(during.body.listing.lng).toBeCloseTo(PRECISE_LNG, 6);

    // Cancelled booking: the disclosure window closes again.
    await request(app)
      .post(`/api/bookings/${booked.body.booking.id}/cancel`)
      .set('Cookie', guestCookie)
      .send({});
    const after = await request(app).get(`/api/listings/${listingId}`).set('Cookie', guestCookie);
    expect(after.status).toBe(200);
    expectPublicDetailShape(after.body.listing);
  });

  test('DISCLOSURE MATRIX: in_progress guest sees exact; COMPLETED guest reverts to public', async () => {
    // The two lifecycle states the pending/cancelled matrix above does not touch: the window
    // stays open while the meal is IN PROGRESS and closes again once it is COMPLETED — a past
    // guest keeps no standing grant to the host's home address (ADR-010, disclosure WINDOW).
    const guest = await makeEligibleGuest();
    const cookie = await cookieFor(guest);
    const booking = await dbh.makeBooking({ listing_id: listingId, guest_id: guest.id });

    await dbh.query(`UPDATE bookings SET status = 'in_progress' WHERE id = $1`, [booking.id]);
    const during = await request(app).get(`/api/listings/${listingId}`).set('Cookie', cookie);
    expect(during.body.listing.addressLine1).toContain(SECRET_STREET);
    expect(Number(during.body.listing.lat)).toBeCloseTo(PRECISE_LAT, 6);

    await dbh.query(
      `UPDATE bookings SET status='completed', guest_confirmed_completion=true,
              host_confirmed_completion=true, completed_at=now() WHERE id = $1`,
      [booking.id]
    );
    const after = await request(app).get(`/api/listings/${listingId}`).set('Cookie', cookie);
    expect(after.status).toBe(200);
    expectPublicDetailShape(after.body.listing);

    // Remove the direct-DB fixture so later matrix tests see the listing unencumbered.
    await dbh.query(`DELETE FROM bookings WHERE id = $1`, [booking.id]);
  });

  test('DISCLOSURE MATRIX: moderator sees public WITHOUT an alert; WITH an FR-07 alert sees precise AND is access-logged', async () => {
    const moderator = await dbh.makeUser({ roles: ['user', 'moderator'] });
    const modCookie = await cookieFor(moderator);

    // No safety alert on this listing → the moderator ROLE alone discloses nothing.
    const noAlert = await request(app).get(`/api/listings/${listingId}`).set('Cookie', modCookie);
    expect(noAlert.status).toBe(200);
    expectPublicDetailShape(noAlert.body.listing);
    const { rows: logBefore } = await dbh.query(
      `SELECT id FROM access_log WHERE actor_user_id = $1`,
      [moderator.id]
    );
    expect(logBefore).toEqual([]);

    // An FR-07 alert on one of the listing's bookings opens the moderator path — logged.
    const victim = await makeEligibleGuest();
    const booking = await dbh.makeBooking({ listing_id: listingId, guest_id: victim.id });
    await dbh.query(`INSERT INTO safety_alerts (booking_id, raised_by) VALUES ($1, $2)`, [
      booking.id,
      victim.id,
    ]);
    const withAlert = await request(app).get(`/api/listings/${listingId}`).set('Cookie', modCookie);
    expect(withAlert.status).toBe(200);
    expect(withAlert.body.listing.addressLine1).toContain(SECRET_STREET);

    const { rows: logAfter } = await dbh.query(
      `SELECT actor_user_id, subject_user_id, purpose, resource FROM access_log
       WHERE actor_user_id = $1`,
      [moderator.id]
    );
    expect(logAfter).toHaveLength(1);
    expect(logAfter[0]).toMatchObject({
      actor_user_id: moderator.id,
      subject_user_id: host.id,
      purpose: 'fr07_safety_alert',
      resource: `listing:${listingId}`,
    });
  });

  test('DISCLOSURE MATRIX: the owner sees their own listing privileged (own data)', async () => {
    const res = await request(app).get(`/api/listings/${listingId}`).set('Cookie', hostCookie);
    expect(res.status).toBe(200);
    expect(res.body.listing.addressLine1).toContain(SECRET_STREET);
  });
});

// ==========================================================================================
// ADR-004 (e) — delete-mark on the API path; per-object deletion stays on the worker path
// ==========================================================================================
describe('ADR-004 — media delete-mark keeps row+object for the per-object erasure path', () => {
  test('attach → delete-mark: row survives with deleted_at; media vanishes from the host page', async () => {
    const objectStorage = require('../../src/adapters/objectStorage'); // test-side only
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);

    const target = await request(app)
      .post('/api/media/uploads')
      .set('Cookie', cookie)
      .send({ kind: 'host_profile', contentType: 'image/jpeg', sizeBytes: 64 });
    expect(target.status).toBe(200);
    const { storageKey } = target.body;
    await objectStorage.put(storageKey, Buffer.from('adr-lane-bytes'), {
      contentType: 'image/jpeg',
    });

    const attached = await request(app)
      .post('/api/media')
      .set('Cookie', cookie)
      .send({ storageKey, kind: 'host_profile', contentType: 'image/jpeg', sizeBytes: 64 });
    expect(attached.status).toBe(201);
    const mediaId = attached.body.media.id;

    const viewer = await makeEligibleGuest();
    const pageBefore = await request(app)
      .get(`/api/hosts/${host.id}`)
      .set('Cookie', await cookieFor(viewer));
    expect(pageBefore.body.host.images.map((i) => i.id)).toContain(mediaId);

    const del = await request(app).delete(`/api/media/${mediaId}`).set('Cookie', cookie);
    expect(del.status).toBe(204);

    // Row survives (delete-marked) and the OBJECT survives — physical per-key deletion is
    // the worker/erasure path's job (ADR-004/NFR-12), never the request path's.
    const { rows } = await dbh.query(`SELECT deleted_at FROM media_objects WHERE id = $1`, [
      mediaId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).not.toBeNull();
    const still = await objectStorage.get(storageKey);
    expect(Buffer.isBuffer(still.body ?? still)).toBe(true);

    // ...but it is gone from every read path immediately.
    const pageAfter = await request(app)
      .get(`/api/hosts/${host.id}`)
      .set('Cookie', await cookieFor(viewer));
    expect(pageAfter.body.host.images.map((i) => i.id)).not.toContain(mediaId);
  });
});

// ==========================================================================================
// ADR-011 (k) — booking notifications drain to persisted NOTIFICATION_ATTEMPT rows
// ==========================================================================================
describe('ADR-011 — wave-3 booking notifications: worker → mock transport → persisted attempts', () => {
  test('booking create → worker poll → one email attempt per participant, no live send', async () => {
    expect(config.notifications.transport).toBe('mock'); // the suite never leaves the process

    const host = await makeEligibleHost();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    const listingId = created.body.listing.id;
    await approve(listingId);
    const guest = await makeEligibleGuest();
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId });
    expect(booked.status).toBe(201);
    const bookingId = booked.body.booking.id;

    // Nothing sent yet — delivery is worker work, not request work (ADR-001).
    const preDrain = await dbh.query(
      `SELECT count(*)::int AS n FROM notification_attempts WHERE params->>'bookingId' = $1`,
      [bookingId]
    );
    expect(preDrain.rows[0].n).toBe(0);

    const dispatch = require('../../src/outbox/dispatch');
    const worker = require('../../src/outbox/worker');
    const registry = dispatch.loadHandlers();
    const quiet = { info: () => {}, warn: () => {}, error: () => {}, child: () => quiet };
    // DETERMINISM (verification-report F-01): drain until the queue is empty, not for a fixed
    // number of passes. pollOnce claims oldest-first across the WHOLE outbox table, so a fixed
    // pass count silently makes this assertion depend on how many rows sibling suites left
    // behind. The 5000 is a runaway guard; the `claimed === 0` break is what ends the loop.
    for (let i = 0; i < 5000; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const stats = await worker.pollOnce({ registry, log: quiet, batchSize: 50 });
      if (!stats || stats.claimed === 0) break;
    }

    const { rows } = await dbh.query(
      `SELECT recipient_user_id, channel, status, params FROM notification_attempts
        WHERE params->>'bookingId' = $1 ORDER BY recipient_user_id`,
      [bookingId]
    );
    expect(rows).toHaveLength(2); // exactly one attempt per participant, none lost, none doubled
    for (const r of rows) {
      expect(r.channel).toBe('email'); // push stays gated default-false (ADR-011)
      expect(r.status).toBe('sent');
      expect(JSON.stringify(r.params)).not.toMatch(EMAIL_SHAPE); // IDs only
    }
    expect(rows.map((r) => r.recipient_user_id).sort()).toEqual([guest.id, host.id].sort());
  });

  test('notification_attempts rows carry IDs only — no email address, no address text', async () => {
    // Whole-table audit over everything every flow in this file persisted: the recipient is
    // referenced by USER ID, and neither params nor error text may carry an email address or
    // the fixture street (ADR-003 / SRS §3.4 PII register).
    const { rows } = await dbh.query('SELECT id, params, last_error FROM notification_attempts');
    const offenders = rows.filter((r) => {
      const text = `${JSON.stringify(r.params)} ${r.last_error || ''}`;
      return EMAIL_SHAPE.test(text) || text.includes(SECRET_STREET);
    });
    expect(offenders).toEqual([]);
  });
});

// ==========================================================================================
// ADR-007 (h) — repo-wide: no provider hostname, model id or API key literal anywhere
// ==========================================================================================
describe('ADR-007 — nothing under src/ or scripts/ hardcodes a provider, model id or key', () => {
  test('repo-wide scan of src/ and scripts/ for provider/model/key literals', () => {
    // Union of the round-1 and round-2 verifiers' pattern sets, over src/ AND scripts/
    // (a seed or ops script with a baked-in key is just as much a violation).
    const patterns = [
      /gemini/i,
      /generativelanguage/i,
      /\bgpt-[0-9]/i,
      /AIza[0-9A-Za-z_-]{10}/,
      /SG\.[A-Za-z0-9_-]{16}/,
      /sk-[A-Za-z0-9]{20}/,
    ];
    const ROOT = path.join(__dirname, '..', '..');
    const offenders = [];
    for (const file of [...listJsFiles(SRC), ...listJsFiles(path.join(ROOT, 'scripts'))]) {
      const text = fs.readFileSync(file, 'utf8');
      for (const p of patterns) {
        if (p.test(text)) offenders.push(`${path.relative(ROOT, file)}: ${p}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ==========================================================================================
// Redis role (g) — after every wave-3 flow the keyspace is still sessions/limits/cache only
// ==========================================================================================
describe('Redis role — wave-3 flows added only session/rate-limit/cache keys', () => {
  test('every key in the keyspace matches an approved namespace; no business state in Redis', async () => {
    const { redis } = require('../../src/db/redis');
    const keys = await redis.keys('*');
    expect(keys.length).toBeGreaterThan(0); // sessions + search cache created above
    const offenders = keys.filter((k) => !/^hp:(session|ratelimit|cache):/.test(k));
    expect(offenders).toEqual([]);
    // Source-of-truth sanity: bookings/listings live in PostgreSQL, never Redis. After every
    // wave-3 flow in this file NO key is even business-SHAPED — search/maps cache keys are
    // opaque digests, so a `hp:cache:booking:<id>`-style key would mean some code path began
    // treating the cache as a business store (round-1 verifier tightened this from
    // "business-shaped keys must at least be cache-prefixed" to "must not exist").
    expect(keys.filter((k) => /booking|outbox|listing:|user:/.test(k))).toEqual([]);
  });

  test('static: only session/rate-limit/cache modules (and the maps read adapter) touch Redis', () => {
    // The runtime keyspace audit above can only see keys that test flows created; this pins
    // the IMPORTER SET, so a new module cannot start writing business state to Redis without
    // showing up here by name.
    const users = [];
    for (const file of listJsFiles(SRC)) {
      const rel = path.relative(SRC, file);
      const text = fs.readFileSync(file, 'utf8');
      if (/require\(['"][^'"]*db\/redis['"]\)/.test(text)) users.push(rel);
    }
    expect(users.sort()).toEqual(
      [
        path.join('adapters', 'maps.js'),
        path.join('lib', 'cache.js'),
        path.join('modules', 'auth', 'rateLimit.js'),
        path.join('modules', 'auth', 'sessions.js'),
        path.join('modules', 'search', 'service.js'),
      ].sort()
    );
  });
});
