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
// ORDERING MATTERS: the require.cache adapter-purity checks run FIRST; tests that
// legitimately load adapters (worker drain, object-storage verification) run LAST.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const dbh = require('../helpers/db');

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

beforeAll(() => {
  const { createApp } = require('../../src/app');
  app = createApp();
  config = require('../../src/config');
  sessions = require('../../src/modules/auth/sessions');
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

  test('the full wave-3 write+read surface executes without loading any adapter', async () => {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);

    // FR-11 create (enqueues listing.geocode + moderation.scan — deferred, not called inline)
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send(listingBody());
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;

    // FR-11 update
    const patched = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', hostCookie)
      .send({ description: 'Updated by the adr-conformance lane.' });
    expect(patched.status).toBe(200);

    // FR-02 detail
    await approve(listingId);
    const detail = await request(app).get(`/api/listings/${listingId}`).set('Cookie', hostCookie);
    expect(detail.status).toBe(200);

    // FR-12 booking create + FR-14 cancel (notify jobs enqueued, never sent inline)
    const guest = await makeEligibleGuest();
    const guestCookie = await cookieFor(guest);
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .send({ listingId });
    expect(booked.status).toBe(201);
    const cancelled = await request(app)
      .post(`/api/bookings/${booked.body.booking.id}/cancel`)
      .set('Cookie', guestCookie)
      .send({});
    expect(cancelled.status).toBe(200);

    // FR-03 host page (media URLs derived locally — ADR-004/mediaUrls, no storage adapter)
    const hostPage = await request(app).get(`/api/hosts/${host.id}`).set('Cookie', guestCookie);
    expect(hostPage.status).toBe(200);

    // Media upload target minting: pure local SigV4 (build-plan §6.3)
    const target = await request(app)
      .post('/api/media/uploads')
      .set('Cookie', hostCookie)
      .send({ kind: 'listing', contentType: 'image/jpeg', sizeBytes: 1024 });
    expect(target.status).toBe(200);
    expect(target.body.storageKey.startsWith(`listing/${host.id.toLowerCase()}/`)).toBe(true);
    expect(typeof target.body.uploadUrl).toBe('string');

    // FR-01 search WITHOUT a location — must not touch the Maps adapter at all
    const search = await request(app)
      .get('/api/listings/search')
      .query({ hostId: host.id })
      .set('Cookie', guestCookie);
    expect(search.status).toBe(200);

    // THE INVARIANT: after every request-path flow above, ZERO adapter modules loaded.
    expect(loadedAdapters()).toEqual([]);
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

  test('static: wave-3 modules have no module-scope adapter require', () => {
    const offenders = [];
    for (const mod of ['listings', 'search', 'hosts', 'bookings', 'media']) {
      for (const file of listJsFiles(path.join(SRC, 'modules', mod))) {
        const text = fs.readFileSync(file, 'utf8');
        let depth = 0;
        for (const rawLine of text.split('\n')) {
          const line = rawLine.replace(/\/\/.*$/, '');
          if (depth === 0 && /require\(['"][^'"]*adapters\//.test(line)) {
            offenders.push(path.relative(SRC, file));
          }
          for (const ch of line) {
            if (ch === '{' || ch === '(') depth += 1;
            else if (ch === '}' || ch === ')') depth = Math.max(0, depth - 1);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
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
  });

  test('an ineligible host is 403 on POST /api/listings and no listing row is written', async () => {
    // Missing phone AND host profile — canPublishListing must refuse.
    const notHost = await dbh.makeUser({ can_publish_listing: false });
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(notHost))
      .send(listingBody());
    expect(res.status).toBe(403);
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
    // 2029-06-05/06/07 are Tue/Wed/Thu of one LA week (20:00Z = 13:00 PDT).
    const tue = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody({ scheduledStart: '2029-06-05T20:00:00Z', seatCapacity: daily }));
    expect(tue.status).toBe(201);
    const wed = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody({ scheduledStart: '2029-06-06T20:00:00Z', seatCapacity: weekly - daily }));
    expect(wed.status).toBe(201);
    // The week's seats are exactly at the configured cap — one more seat must refuse.
    const thu = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody({ scheduledStart: '2029-06-07T20:00:00Z', seatCapacity: 1 }));
    expect(thu.status).toBe(422);
    expect(thu.body.error.code).toBe('MEHKO_WEEKLY_MEAL_LIMIT');
  });

  test('static: no cap-valued literal in wave-3 modules or schemas (config is the only home)', () => {
    const capValues = [
      config.mehko.listingsPerHostPerDay,
      config.mehko.maxMealsPerDay,
      config.mehko.maxMealsPerWeek,
    ];
    // listingsPerHostPerDay=1 appears legitimately as array indices etc.; the meal caps are
    // distinctive numbers and must not appear at all outside src/config.
    const distinctive = capValues.filter((v) => v > 1);
    const pattern = new RegExp(`\\b(${distinctive.join('|')})\\b`);
    const offenders = [];
    for (const dir of [path.join(SRC, 'modules'), path.join(SRC, 'schemas')]) {
      for (const file of listJsFiles(dir)) {
        if (pattern.test(fs.readFileSync(file, 'utf8'))) {
          offenders.push(path.relative(SRC, file));
        }
      }
    }
    expect(offenders).toEqual([]);
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
    await stampPreciseLocation(listingId);
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
    expect(res.body.listing.coarseLat).not.toBeNull(); // coarse projection IS served
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
    for (const dish of res.body.host.exampleDishes) expectPublicShape(dish);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(EMAIL_SHAPE);
    expect(text).not.toMatch(/phone|password|argon2|addressLine|postalCode|"lat"|"lng"/i);
    expect(text).not.toContain(SECRET_STREET);
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

    const dispatch = require('../../src/outbox/dispatch');
    const worker = require('../../src/outbox/worker');
    const registry = dispatch.loadHandlers();
    let stats;
    let guard = 0;
    do {
      stats = await worker.pollOnce({ registry });
      guard += 1;
    } while (stats.claimed > 0 && guard < 20);

    for (const recipient of [guest.id, host.id]) {
      const { rows } = await dbh.query(
        `SELECT channel, status, params FROM notification_attempts WHERE recipient_user_id = $1`,
        [recipient]
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        expect(row.channel).toBe('email'); // push stays gated default-false (ADR-011)
        expect(['sent', 'failed']).toContain(row.status);
        expect(JSON.stringify(row.params)).not.toMatch(EMAIL_SHAPE); // IDs only
      }
      expect(rows.some((r) => r.status === 'sent')).toBe(true);
    }
  });
});

// ==========================================================================================
// ADR-007 (h) — repo-wide: no provider hostname, model id or API key literal anywhere
// ==========================================================================================
describe('ADR-007 — nothing under src/ hardcodes a moderation provider, model id or key', () => {
  test('repo-wide scan of src/ for provider/model/key literals', () => {
    const offenders = [];
    for (const file of listJsFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      if (/gemini|generativelanguage|AIza[0-9A-Za-z_-]{10}|SG\.[A-Za-z0-9_-]{16}/i.test(text)) {
        offenders.push(path.relative(SRC, file));
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
    // Source-of-truth sanity: bookings/listings live in PostgreSQL, never Redis.
    const businessShaped = keys.filter((k) => /booking|listing:|outbox|user:/.test(k));
    for (const k of businessShaped) expect(k).toMatch(/^hp:cache:/);
  });
});
