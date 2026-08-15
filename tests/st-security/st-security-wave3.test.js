// tests/st-security/st-security-wave3.test.js — VERIFIER lane "st-security", wave-3 extension
// (build-plan §7: this run's verifiers extend the lane over the newly mounted marketplace
// surface). ST-04 injection over the wave-3 input boundaries (search, listing text, hosts,
// media), ST-06 role-restricted + LOGGED precise-location access (NFR-13 / ADR-010) — both
// end-to-end over the routes AND directly against listings/access.js, whose deny-by-default
// guards no session-gated route can reach — and the abuse cases that became executable this
// wave: AB-01, AB-02, AB-03, AB-07 (publish gate), AB-08 (401 walls + serializer allowlists).
//
// Shared-database discipline (NFR-08 determinism): one seeded homeplate_test database is
// shared by every lane — this file NEVER truncates or deletes rows it did not create; all
// fixtures are uniquely keyed via tests/helpers/db factories. The search result-page cache
// is avoided (not flushed) by giving every phase of a test a distinct cache identity
// (unique hostId filter and/or distinct pageSize), so no other lane's Redis state is touched.
'use strict';

const crypto = require('crypto');
const request = require('supertest');

const config = require('../../src/config');
const { createApp } = require('../../src/app');
const sessions = require('../../src/modules/auth/sessions');
const listingSerializers = require('../../src/modules/listings/serializers');
const listingAccess = require('../../src/modules/listings/access');
const hostSerializers = require('../../src/modules/hosts/serializers');
const db = require('../helpers/db');
const { closeRedis } = require('../../src/db/redis');

function quietLogger() {
  const noop = () => {};
  const l = { info: noop, warn: noop, error: noop, debug: noop, child: () => l, audit: noop };
  return l;
}

const app = createApp({ config, logger: quietLogger() });

// ---- fixtures -------------------------------------------------------------------------------

async function cookieFor(user) {
  const { token } = await sessions.createSession({ id: user.id, roles: user.roles });
  return `${config.auth.sessionCookieName}=${token}`;
}

/** canReserveSeat-eligible plain user (email verified + name + phone). */
async function makeEligibleGuest(overrides = {}) {
  return db.makeUser({ phone_enc: 'enc:v1:fixture', ...overrides });
}

/** canPublishListing-eligible host (guest attributes + host profile + agreement). */
async function makeEligibleHost(overrides = {}) {
  const host = await db.makeUser({
    can_publish_listing: true,
    phone_enc: 'enc:v1:fixture',
    ...overrides,
  });
  await db.makeHostProfile({ user_id: host.id });
  return host;
}

/** An approved, active, future listing carrying a PRECISE address (ADR-010 leak canary). */
const CANARY_STREET = '742 Evergreen Canary Terrace';
async function makeApprovedListing(overrides = {}) {
  return db.makeListing({
    moderation_status: 'approved',
    address_line1: CANARY_STREET,
    postal_code: '92103',
    lat: 32.7461234,
    lng: -117.1631234,
    ...overrides,
  });
}

let daySeq = 200; // offset so we never collide with other suites' 2028 fixture days
function uniqueFutureStart() {
  daySeq += 1;
  return new Date(Date.UTC(2028, 5, 1, 20, 0, 0) + daySeq * 24 * 3600 * 1000).toISOString();
}

function listingBody(overrides = {}) {
  return {
    title: 'Security lane dinner',
    description: 'A perfectly ordinary meal for the security suite.',
    ingredients: ['rice', 'beans'],
    allergens: ['none'],
    cuisine: 'test-cuisine',
    scheduledStart: uniqueFutureStart(),
    durationMinutes: 90,
    seatCapacity: 4,
    addressLine1: '99 Security Lane',
    city: 'San Diego',
    region: 'CA',
    postalCode: '92101',
    ...overrides,
  };
}

/**
 * Walk a response body and collect every LEAF value with its dotted path.
 *
 * The AB-08 / NFR-13 canary assertions below target these values instead of
 * `JSON.stringify(body)`. A whole-blob substring check is not a leak detector: the payload
 * also carries randomly generated UUIDs and millisecond timestamps, so a bare digit canary
 * such as the canary STREET NUMBER ('742') matches by chance — measured at 1.04% of runs
 * from the two UUIDs a single result row embeds (listing id + hostId), e.g. an id of
 * "24a03a9a-d1d2-4739-9264-6758616742d8". A security gate that reddens ~1 CI run in 100
 * with no leak behind it is worse than no gate: it teaches reviewers to re-run the leak
 * detector. Scoping to leaf values (and, for coordinates, comparing numbers numerically)
 * keeps the assertion deterministic AND strictly sharper — it also catches a coordinate
 * re-serialized at a different precision, which a string `toContain` would miss.
 */
function leaves(value, path = 'body', out = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => leaves(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) leaves(v, `${path}.${k}`, out);
  } else {
    out.push({ path, value });
  }
  return out;
}
const stringLeaves = (body) => leaves(body).filter((l) => typeof l.value === 'string');
const numberLeaves = (body) => leaves(body).filter((l) => typeof l.value === 'number');

const SQLI = ["' OR 1=1 --", "'; DROP TABLE listings; --", "admin'--", '1; DELETE FROM users'];
const XSS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '"><svg/onload=alert(1)>',
];

afterAll(async () => {
  await db.closeDb();
  await closeRedis();
});

// =============================================================================================
// ST-04 — injection over the wave-3 boundaries (NFR-11, AB-06)
// =============================================================================================
describe('ST-04 wave-3 injection: search boundary (FR-01)', () => {
  let cookie;
  beforeAll(async () => {
    cookie = await cookieFor(await makeEligibleGuest());
  });

  test('SQLi in cuisine never 500s and leaves the listings table intact', async () => {
    const before = await db.countRows('listings');
    for (const p of SQLI) {
      const res = await request(app)
        .get('/api/listings/search')
        .set('Cookie', cookie)
        .query({ cuisine: p, pageSize: 5 });
      expect(res.status).not.toBe(500);
      expect([200, 422]).toContain(res.status);
    }
    const after = await db.countRows('listings');
    expect(after).toBeGreaterThanOrEqual(before); // table still exists and did not shrink
  });

  test('XSS in cuisine comes back inert — no raw markup anywhere in the response', async () => {
    for (const p of XSS) {
      const res = await request(app)
        .get('/api/listings/search')
        .set('Cookie', cookie)
        .query({ cuisine: p, pageSize: 5 });
      expect(res.status).not.toBe(500);
      const flat = JSON.stringify(res.body);
      expect(flat).not.toContain('<script');
      expect(flat).not.toMatch(/<img[^>]*onerror/i);
      expect(flat).not.toContain('<svg');
    }
  });

  test('hostId must be a UUID — SQLi in hostId is a field-level 422, never a query', async () => {
    const res = await request(app)
      .get('/api/listings/search')
      .set('Cookie', cookie)
      .query({ hostId: "' OR 1=1 --" });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.js:\d+/); // no stack trace leaks
  });

  test('unknown query params are stripped (NFR-11), request still succeeds', async () => {
    const res = await request(app)
      .get('/api/listings/search')
      .set('Cookie', cookie)
      .query({ evil: "'; DROP TABLE users; --", pageSize: 5 });
    expect(res.status).toBe(200);
    expect(await db.countRows('users')).toBeGreaterThan(0); // users table alive
  });

  test('malformed from/to returns 422 field errors with no stack trace', async () => {
    const res = await request(app)
      .get('/api/listings/search')
      .set('Cookie', cookie)
      .query({ from: 'not-a-date', to: "1' OR '1'='1" });
    expect(res.status).toBe(422);
    const flat = JSON.stringify(res.body);
    expect(flat).not.toContain('node_modules');
    expect(flat).not.toMatch(/at .*\.js:\d+/);
  });
});

describe('ST-04 wave-3 injection: listing text boundary (FR-11/FR-02)', () => {
  test('XSS in title/description/ingredients is stored ESCAPED — no executable markup persists', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(
        listingBody({
          title: `Dinner ${XSS[0]}`,
          description: `Tasty ${XSS[1]} stew`,
          ingredients: [XSS[2], 'rice'],
        })
      );
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(201);
    const { rows } = await db.query(
      `SELECT title, description, ingredients FROM listings WHERE id = $1`,
      [res.body.listing.id]
    );
    const stored = JSON.stringify(rows[0]);
    expect(stored).not.toContain('<script');
    expect(stored).not.toMatch(/<img[^>]*onerror/i);
    expect(stored).not.toContain('<svg');
    // The response echo is equally inert.
    const echoed = JSON.stringify(res.body);
    expect(echoed).not.toContain('<script');
    expect(echoed).not.toContain('<svg');
  });

  test('SQLi in description is inert data; users and listings tables survive', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const usersBefore = await db.countRows('users');
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody({ description: SQLI[1] }));
    expect(res.status).toBe(201);
    expect(await db.countRows('users')).toBeGreaterThanOrEqual(usersBefore);
    expect(await db.countRows('listings')).toBeGreaterThan(0);
  });

  test('XSS via PATCH update is stored escaped too', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody());
    expect(created.status).toBe(201);
    const patch = await request(app)
      .patch(`/api/listings/${created.body.listing.id}`)
      .set('Cookie', cookie)
      .send({ description: `updated ${XSS[0]}` });
    expect(patch.status).toBe(200);
    const { rows } = await db.query(`SELECT description FROM listings WHERE id = $1`, [
      created.body.listing.id,
    ]);
    expect(rows[0].description).not.toContain('<script');
    expect(rows[0].description).not.toContain('<');
  });

  test('non-UUID junk in /api/listings/:id path is 404, never 500 (falls through the UUID constraint)', async () => {
    const cookie = await cookieFor(await makeEligibleGuest());
    for (const p of ["' OR 1=1 --", '1;DELETE', '%00', '..%2f..%2fetc']) {
      const res = await request(app)
        .get(`/api/listings/${encodeURIComponent(p)}`)
        .set('Cookie', cookie);
      expect(res.status).not.toBe(500);
      expect([404, 422]).toContain(res.status);
    }
  });
});

describe('ST-04 wave-3 injection: hosts + media boundaries (FR-03, ADR-004)', () => {
  let guest;
  let cookie;
  beforeAll(async () => {
    guest = await makeEligibleGuest();
    cookie = await cookieFor(guest);
  });

  test('SQLi/XSS in /api/hosts/:id is 422/404, never 500', async () => {
    for (const p of [...SQLI, ...XSS]) {
      const res = await request(app)
        .get(`/api/hosts/${encodeURIComponent(p)}`)
        .set('Cookie', cookie);
      expect(res.status).not.toBe(500);
      expect([404, 422]).toContain(res.status);
    }
  });

  test('hosts reviews pagination rejects hostile page/pageSize with 422', async () => {
    const host = await makeEligibleHost();
    const res = await request(app)
      .get(`/api/hosts/${host.id}/reviews`)
      .set('Cookie', cookie)
      .query({ page: "1' OR '1'='1", pageSize: -5 });
    expect(res.status).toBe(422);
  });

  test('media upload target refuses executable content types (text/html) with 422', async () => {
    const res = await request(app)
      .post('/api/media/uploads')
      .set('Cookie', cookie)
      .send({ kind: 'listing', contentType: 'text/html', sizeBytes: 100 });
    expect(res.status).toBe(422);
  });

  test('media attach refuses traversal and malformed storage keys (4xx, never 500)', async () => {
    const hostiles = [
      '../../etc/passwd',
      `listing/${guest.id}/../../../secrets`,
      '/absolute/leading/slash.jpg',
      `listing/${guest.id}/ok.jpg; DROP TABLE media_objects;`,
    ];
    for (const key of hostiles) {
      const res = await request(app)
        .post('/api/media')
        .set('Cookie', cookie)
        .send({ storageKey: key, kind: 'listing' });
      expect(res.status).not.toBe(500);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(await db.countRows('media_objects')).toBeGreaterThanOrEqual(0); // table intact
  });

  test("media attach outside the caller's own namespace is 403 (AB-08 cross-user planting)", async () => {
    const other = await makeEligibleGuest();
    const foreignKey = `listing/${other.id}/${crypto.randomUUID()}.jpg`;
    const res = await request(app)
      .post('/api/media')
      .set('Cookie', cookie)
      .send({ storageKey: foreignKey, kind: 'listing' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MEDIA_KEY_FORBIDDEN');
  });
});

// =============================================================================================
// AB-01 — fake host / fake listing: publish gate + pending-until-approved invisibility
// =============================================================================================
describe('AB-01 fake host / unapproved listing (FR-08/FR-09)', () => {
  test('a host without the profile/agreement gate cannot publish (403 before any listing work)', async () => {
    const bare = await db.makeUser({ phone_enc: 'enc:v1:fixture' }); // no host profile
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(bare))
      .send(listingBody());
    expect(res.status).toBe(403);
    // Nothing persisted for this host.
    const { rows } = await db.query(`SELECT count(*)::int c FROM listings WHERE host_id = $1`, [
      bare.id,
    ]);
    expect(rows[0].c).toBe(0);
  });

  test('a freshly created listing is pending and INVISIBLE in search until approved', async () => {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const viewer = await cookieFor(await makeEligibleGuest());

    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send(listingBody());
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;
    const { rows } = await db.query(`SELECT moderation_status FROM listings WHERE id = $1`, [
      listingId,
    ]);
    expect(rows[0].moderation_status).toBe('pending');

    // Distinct pageSize per phase => distinct search cache identity (no stale-page bleed).
    const hidden = await request(app)
      .get('/api/listings/search')
      .set('Cookie', viewer)
      .query({ hostId: host.id, pageSize: 20 });
    expect(hidden.status).toBe(200);
    expect(hidden.body.results.map((r) => r.id)).not.toContain(listingId);
    expect(hidden.body.total).toBe(0);

    await db.query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [listingId]);

    const visible = await request(app)
      .get('/api/listings/search')
      .set('Cookie', viewer)
      .query({ hostId: host.id, pageSize: 19 });
    expect(visible.status).toBe(200);
    expect(visible.body.results.map((r) => r.id)).toContain(listingId);
  });
});

// =============================================================================================
// AB-02 — booking hoarding: config.booking.maxConcurrentPending enforced race-free
// =============================================================================================
describe('AB-02 hoarding bookings (FR-12, config.booking.maxConcurrentPending)', () => {
  test('the cap-th+1 sequential booking is 409 BOOKING_LIMIT, creates no row, moves no seat', async () => {
    const cap = config.booking.maxConcurrentPending;
    expect(cap).toBe(3); // documented default — a change here is a config regression

    const guest = await makeEligibleGuest();
    const cookie = await cookieFor(guest);
    const listings = [];
    for (let i = 0; i <= cap; i += 1) listings.push(await makeApprovedListing());

    for (let i = 0; i < cap; i += 1) {
      const res = await request(app)
        .post('/api/bookings')
        .set('Cookie', cookie)
        .send({ listingId: listings[i].id });
      expect(res.status).toBe(201);
    }

    const blockedListing = listings[cap];
    const blocked = await request(app)
      .post('/api/bookings')
      .set('Cookie', cookie)
      .send({ listingId: blockedListing.id });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('BOOKING_LIMIT');

    const { rows: bookingRows } = await db.query(
      `SELECT count(*)::int c FROM bookings WHERE guest_id = $1 AND status = 'pending'`,
      [guest.id]
    );
    expect(bookingRows[0].c).toBe(cap);
    const { rows: seatRows } = await db.query(
      `SELECT seats_remaining, seat_capacity FROM listings WHERE id = $1`,
      [blockedListing.id]
    );
    expect(seatRows[0].seats_remaining).toBe(seatRows[0].seat_capacity); // untouched
  });

  test('an ineligible guest is 403 BEFORE any capacity work (FR-09)', async () => {
    const ineligible = await db.makeUser(); // no phone => canReserveSeat false
    const listing = await makeApprovedListing();
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(ineligible))
      .send({ listingId: listing.id });
    expect(res.status).toBe(403);
    const { rows } = await db.query(
      `SELECT seats_remaining, seat_capacity FROM listings WHERE id = $1`,
      [listing.id]
    );
    expect(rows[0].seats_remaining).toBe(rows[0].seat_capacity);
  });
});

// =============================================================================================
// AB-03 — spam / scripted listings: DB-backed daily uniqueness + validation wall
// =============================================================================================
describe('AB-03 scripted listings (FR-11 daily cap, NFR-11 validation)', () => {
  test('10 same-day creations for one host yield exactly 1 persisted listing and 9 x 409', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const day = uniqueFutureStart();
    const sameDayLater = new Date(new Date(day).getTime() + 3600 * 1000).toISOString();

    const statuses = [];
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app)
        .post('/api/listings')
        .set('Cookie', cookie)
        .send(
          listingBody({ scheduledStart: i === 0 ? day : sameDayLater, title: `Spam ${i} spam` })
        );
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 201).length).toBe(1);
    expect(statuses.filter((s) => s === 409).length).toBe(9);
    const { rows } = await db.query(`SELECT count(*)::int c FROM listings WHERE host_id = $1`, [
      host.id,
    ]);
    expect(rows[0].c).toBe(1);
  });

  test('malformed / oversized payloads are rejected by validation with 422', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody({ title: 'x'.repeat(500) }));
    expect(res.status).toBe(422);
    const res2 = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send({ title: 'no other fields' });
    expect(res2.status).toBe(422);
  });
});

// =============================================================================================
// AB-07 — MEHKO evasion / unverified accounts cannot publish (FR-10 gate)
// =============================================================================================
describe('AB-07 unverified email cannot publish (FR-10/NFR-06)', () => {
  test('an unverified host with profile+agreement is still 403 on POST /api/listings', async () => {
    const host = await db.makeUser({
      email_verified: false,
      can_publish_listing: true,
      phone_enc: 'enc:v1:fixture',
    });
    await db.makeHostProfile({ user_id: host.id });
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    expect(res.status).toBe(403);
  });
});

// =============================================================================================
// AB-08 — scraping personal data: session walls + serializer allowlists (ADR-010, NFR-13)
// =============================================================================================
describe('AB-08 scraping defenses on the wave-3 surface', () => {
  test('every wave-3 read/write endpoint is 401 unauthenticated — never data', async () => {
    const listing = await makeApprovedListing();
    const host = await makeEligibleHost();
    const probes = [
      request(app).get('/api/listings/search'),
      request(app).get(`/api/listings/${listing.id}`),
      request(app).get(`/api/hosts/${host.id}`),
      request(app).get(`/api/hosts/${host.id}/reviews`),
      request(app).get('/api/bookings'),
      request(app).post('/api/bookings').send({ listingId: listing.id }),
      request(app).post('/api/listings').send(listingBody()),
      request(app).post('/api/media/uploads').send({
        kind: 'listing',
        contentType: 'image/jpeg',
        sizeBytes: 10,
      }),
    ];
    for (const probe of probes) {
      const res = await probe;
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain(CANARY_STREET);
    }
  });

  test('search results are EXACTLY the public allowlist — no address, coords, or contact data', async () => {
    const host = await makeEligibleHost();
    const listing = await makeApprovedListing({ host_id: host.id });
    const viewer = await cookieFor(await makeEligibleGuest());
    const res = await request(app)
      .get('/api/listings/search')
      .set('Cookie', viewer)
      .query({ hostId: host.id, pageSize: 18 });
    expect(res.status).toBe(200);
    const found = res.body.results.find((r) => r.id === listing.id);
    expect(found).toBeTruthy();
    // Key-exact allowlist check against the frozen serializer contract.
    expect(Object.keys(found).sort()).toEqual([...listingSerializers.PUBLIC_KEYS].sort());
    // …and the allowlist stays closed on EVERY row of the page, not only the canary row.
    for (const r of res.body.results) {
      expect(Object.keys(r).sort()).toEqual([...listingSerializers.PUBLIC_KEYS].sort());
    }
    const flat = JSON.stringify(res.body);
    expect(flat).not.toContain(CANARY_STREET);
    // The street NUMBER on its own, asserted against string leaf VALUES in address position.
    // `\b742\s` is address-shaped ('742 Evergreen…') and cannot match inside a hex UUID or an
    // ISO timestamp — neither contains whitespace — so this fires only on a real address leak
    // (see the `leaves` helper for the measured false-positive rate of the blob check).
    const streetNumber = CANARY_STREET.split(' ')[0];
    const addressShaped = new RegExp(`\\b${streetNumber}\\s`);
    expect(
      stringLeaves(res.body).filter(
        ({ value }) => value.includes(CANARY_STREET) || addressShaped.test(value)
      )
    ).toEqual([]);
    // Precise coordinates never serialized: compared NUMERICALLY, so a short decimal embedded
    // in a longer number cannot false-fire and a re-rounded coordinate cannot slip through.
    const precise = [Number(listing.lat), Number(listing.lng)];
    expect(numberLeaves(res.body).filter(({ value }) => precise.includes(value))).toEqual([]);
    expect(flat).not.toMatch(/addressLine1|postal_code|postalCode/);
    expect(flat).not.toMatch(/@dbunit\.homeplate\.invalid/); // host email never leaks
  });

  test('listing detail for a STRANGER is the public projection; a pending guest gets the address; a cancelled booking reverts it', async () => {
    const listing = await makeApprovedListing();
    const stranger = await makeEligibleGuest();
    const strangerRes = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set('Cookie', await cookieFor(stranger));
    expect(strangerRes.status).toBe(200);
    expect(JSON.stringify(strangerRes.body)).not.toContain(CANARY_STREET);
    expect(strangerRes.body.listing.addressLine1).toBeUndefined();

    // Pending guest: privileged (ADR-010 disclosure window).
    const guest = await makeEligibleGuest();
    const booking = await db.makeBooking({
      listing_id: listing.id,
      guest_id: guest.id,
      status: 'pending',
    });
    const guestCookie = await cookieFor(guest);
    const guestRes = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set('Cookie', guestCookie);
    expect(guestRes.status).toBe(200);
    expect(guestRes.body.listing.addressLine1).toContain('Evergreen Canary');

    // Cancelled booking: back to public.
    await db.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [booking.id]);
    const after = await request(app).get(`/api/listings/${listing.id}`).set('Cookie', guestCookie);
    expect(after.status).toBe(200);
    expect(JSON.stringify(after.body)).not.toContain(CANARY_STREET);
  });

  test('host personal page is EXACTLY the HOST_PAGE_KEYS allowlist — no email/phone/address', async () => {
    const host = await makeEligibleHost();
    await makeApprovedListing({ host_id: host.id });
    const viewer = await cookieFor(await makeEligibleGuest());
    const res = await request(app).get(`/api/hosts/${host.id}`).set('Cookie', viewer);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.host).sort()).toEqual([...hostSerializers.HOST_PAGE_KEYS].sort());
    const flat = JSON.stringify(res.body);
    expect(flat).not.toContain(CANARY_STREET);
    expect(flat).not.toMatch(/@dbunit\.homeplate\.invalid/);
    expect(flat).not.toMatch(/password_hash|phone_enc|emergency/);
    // exampleDishes ride the public listing serializer — coarse location only.
    for (const dish of res.body.host.exampleDishes) {
      expect(dish.addressLine1).toBeUndefined();
      expect(dish.lat).toBeUndefined();
    }
  });

  test('booking payloads embed a public-fields-only listing reference (no street address)', async () => {
    const guest = await makeEligibleGuest();
    const cookie = await cookieFor(guest);
    const listing = await makeApprovedListing();
    const created = await request(app)
      .post('/api/bookings')
      .set('Cookie', cookie)
      .send({ listingId: listing.id });
    expect(created.status).toBe(201);
    const detail = await request(app)
      .get(`/api/bookings/${created.body.booking.id}`)
      .set('Cookie', cookie);
    expect(detail.status).toBe(200);
    for (const body of [created.body, detail.body]) {
      const flat = JSON.stringify(body);
      expect(flat).not.toContain(CANARY_STREET);
      expect(flat).not.toMatch(/addressLine1|postalCode/);
    }
  });

  test("another user's media id is 404 on DELETE — existence never confirmed", async () => {
    const owner = await makeEligibleGuest();
    const mediaService = require('../../src/modules/media/service');
    const media = await mediaService.attach(
      owner.id,
      `listing/${owner.id}/${crypto.randomUUID()}.jpg`,
      'listing'
    );
    const attacker = await cookieFor(await makeEligibleGuest());
    const res = await request(app).delete(`/api/media/${media.id}`).set('Cookie', attacker);
    expect(res.status).toBe(404);
    const { rows } = await db.query(`SELECT deleted_at FROM media_objects WHERE id = $1`, [
      media.id,
    ]);
    expect(rows[0].deleted_at).toBeNull(); // untouched
  });
});

// =============================================================================================
// ST-06 — role-restricted precise-location access IS logged (NFR-13, ADR-010 case c)
// =============================================================================================
describe('ST-06 moderator precise-location access is role-restricted AND logged', () => {
  test('moderator WITHOUT an FR-07 alert gets the PUBLIC projection and writes no access_log row', async () => {
    const listing = await makeApprovedListing();
    const moderator = await db.makeUser({ roles: ['user', 'moderator'] });
    const res = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set('Cookie', await cookieFor(moderator));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(CANARY_STREET);
    const { rows } = await db.query(
      `SELECT count(*)::int c FROM access_log WHERE actor_user_id = $1`,
      [moderator.id]
    );
    expect(rows[0].c).toBe(0);
  });

  test('moderator WITH an FR-07 alert gets the address and ONE access_log row (actor, subject, purpose)', async () => {
    const host = await makeEligibleHost();
    const listing = await makeApprovedListing({ host_id: host.id });
    const guest = await makeEligibleGuest();
    const booking = await db.makeBooking({
      listing_id: listing.id,
      guest_id: guest.id,
      status: 'in_progress',
    });
    await db.insertRow('safety_alerts', { booking_id: booking.id, raised_by: guest.id });

    const moderator = await db.makeUser({ roles: ['user', 'moderator'] });
    const res = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set('Cookie', await cookieFor(moderator));
    expect(res.status).toBe(200);
    expect(res.body.listing.addressLine1).toContain('Evergreen Canary');

    const { rows } = await db.query(
      `SELECT actor_user_id, subject_user_id, purpose, resource FROM access_log
       WHERE actor_user_id = $1`,
      [moderator.id]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].subject_user_id).toBe(host.id);
    expect(rows[0].purpose).toBe('fr07_safety_alert');
    expect(rows[0].resource).toBe(`listing:${listing.id}`);
  });

  test('a NON-moderator user with no booking never triggers the moderator path even with an alert present', async () => {
    const listing = await makeApprovedListing();
    const guest = await makeEligibleGuest();
    const booking = await db.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    await db.insertRow('safety_alerts', { booking_id: booking.id, raised_by: guest.id });

    const plainUser = await makeEligibleGuest();
    const res = await request(app)
      .get(`/api/listings/${listing.id}`)
      .set('Cookie', await cookieFor(plainUser));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(CANARY_STREET);
    const { rows } = await db.query(
      `SELECT count(*)::int c FROM access_log WHERE actor_user_id = $1`,
      [plainUser.id]
    );
    expect(rows[0].c).toBe(0);
  });
});

// =============================================================================================
// ST-06 (cont.) — the ADR-010 gate itself, called DIRECTLY (AB-08, NFR-13, FR-07)
//
// Every other ADR-010 assertion in this repository drives listings/access.js through an HTTP
// route, and every wave-3 route is session-gated — so the route surface can only ever hand the
// gate a well-formed, authenticated viewer. That leaves the function's two deny-by-default
// guards (anonymous/non-UUID viewer, malformed listingId) unreachable from the suite: a future
// edit that reorders them, drops the null check, or lets a non-UUID viewer fall through to the
// `viewer.userId === hostId` comparison would keep the whole suite green while opening the
// exact-address gate. access.js is the SINGLE decision point ADR-010 mandates (listing service,
// host profile, booking payloads, wave-4 moderation views), so its fail-closed default is a
// safety property and is pinned here directly rather than only end-to-end.
// =============================================================================================
describe('ADR-010 gate: canViewPreciseLocation is deny-by-default when called directly', () => {
  /**
   * A stand-in for the optional transaction client access.js accepts. It records and then
   * REFUSES any SQL, so a guard that stops short-circuiting fails twice over: the recorded-call
   * assertion reddens, and the promise rejects instead of resolving false. This is what makes
   * the table below a real gate rather than a restatement of the function's return type.
   */
  function tripwireClient() {
    const calls = [];
    return {
      calls,
      query(text) {
        calls.push(text);
        throw new Error('ADR-010 guard fell through to SQL for a malformed caller');
      },
    };
  }

  let host;
  let listing;
  beforeAll(async () => {
    host = await makeEligibleHost();
    listing = await makeApprovedListing({ host_id: host.id });
  });

  test.each([
    ['null viewer (anonymous)', null],
    ['undefined viewer (anonymous)', undefined],
    ['viewer object carrying no userId', {}],
    ['viewer.userId is not a UUID', { userId: 'not-a-uuid' }],
    ['viewer.userId is a non-string', { userId: 12345 }],
    ['viewer.userId is SQL', { userId: "' OR '1'='1" }],
    // A claimed moderator role must not buy a way past the identity guard (FR-07 case c).
    ['moderator role with a malformed userId', { userId: 'moderator', roles: ['moderator'] }],
  ])('%s is refused BEFORE any database work (AB-08)', async (_label, viewer) => {
    const client = tripwireClient();
    await expect(listingAccess.canViewPreciseLocation(viewer, listing.id, client)).resolves.toBe(
      false
    );
    expect(client.calls).toEqual([]); // never reached the listings/bookings/access_log queries
  });

  test.each([
    ['not-a-uuid'],
    [''],
    ["'; DROP TABLE listings; --"],
    [null],
    [undefined],
    [42],
    [{}],
  ])(
    'a malformed listingId (%p) is refused BEFORE any database work, even for the real host',
    async (badId) => {
      const client = tripwireClient();
      await expect(
        listingAccess.canViewPreciseLocation({ userId: host.id }, badId, client)
      ).resolves.toBe(false);
      expect(client.calls).toEqual([]);
    }
  );

  test('positive control: the same call shape with well-formed ids still DECIDES (the guards are not a blanket false)', async () => {
    // Without this, `return false` pasted at the top of canViewPreciseLocation would satisfy
    // every assertion above. Host sees their own address; an unrelated user does not.
    await expect(
      listingAccess.canViewPreciseLocation({ userId: host.id }, listing.id)
    ).resolves.toBe(true);

    const stranger = await makeEligibleGuest();
    await expect(
      listingAccess.canViewPreciseLocation({ userId: stranger.id }, listing.id)
    ).resolves.toBe(false);

    // A well-formed viewer against a well-formed but NON-EXISTENT listing is still false.
    await expect(
      listingAccess.canViewPreciseLocation({ userId: host.id }, crypto.randomUUID())
    ).resolves.toBe(false);
  });

  test('PURPOSE_SAFETY_ALERT is the exported literal the FR-07 access_log row is written with (NFR-13)', async () => {
    // The constant is this module's published contract with the wave-4 moderation views and with
    // any NFR-13 audit query that filters access_log by purpose. Pin the literal AND bind it to
    // the row the moderator branch actually writes, so a rename cannot pass silently.
    expect(listingAccess.PURPOSE_SAFETY_ALERT).toBe('fr07_safety_alert');

    const alertHost = await makeEligibleHost();
    const alertListing = await makeApprovedListing({ host_id: alertHost.id });
    const guest = await makeEligibleGuest();
    const booking = await db.makeBooking({
      listing_id: alertListing.id,
      guest_id: guest.id,
      status: 'pending',
    });
    await db.insertRow('safety_alerts', { booking_id: booking.id, raised_by: guest.id });

    const moderator = await db.makeUser({ roles: ['user', 'moderator'] });
    await expect(
      listingAccess.canViewPreciseLocation(
        { userId: moderator.id, roles: ['user', 'moderator'] },
        alertListing.id
      )
    ).resolves.toBe(true);

    const { rows } = await db.query(
      `SELECT subject_user_id, purpose, resource FROM access_log WHERE actor_user_id = $1`,
      [moderator.id]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].purpose).toBe(listingAccess.PURPOSE_SAFETY_ALERT);
    expect(rows[0].subject_user_id).toBe(alertHost.id); // IDs only — no personal data logged
    expect(rows[0].resource).toBe(`listing:${alertListing.id}`);
  });
});
