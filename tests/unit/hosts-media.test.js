// tests/unit/hosts-media.test.js — U3-HOSTS-MEDIA acceptance suite (build-plan wave 3B).
//
// Requirement traceability (SRS Appendix B):
//   FR-03 (TC-03) — GET /api/hosts/:id returns selfIntroduction (host_profiles.bio),
//            exampleDishes as the host's approved active upcoming listings in publicListing
//            shape (coarse location only — ADR-010), approved reviews about the host with
//            numeric ratings, averageRating + reviewCount, and host_profile image URLs
//            derived from storage keys; pending/rejected reviews, non-approved/cancelled/past
//            listings and deleted media are all excluded; unknown host 404.
//            GET /api/hosts/:id/reviews paginates approved reviews (LT-01 target).
//   FR-02 / FR-05 — the media supply path: POST /api/media/uploads mints a namespaced
//            direct-to-storage target computed locally (no network call, no src/adapters
//            import on the request path — both pinned here); POST /api/media records the
//            attachment via the wave-2 media service (403 outside the caller's namespace,
//            listing/review/profile ownership verified); DELETE /api/media/:id delete-marks
//            only — physical deletion stays on the worker/erasure path (ADR-004, NFR-12).
//   NFR-13 / AB-08 — 401 unauthenticated on every route; a recursive key allowlist proves no
//            email, phone, emergency contact, password hash or exact address for ANY user in
//            the host-page payload.
//   NFR-11 / AB-06 (ST-04) — hostile payloads at every hosts/media input produce no 500 and
//            no stored executable markup.
//   NFR-08 (MT-01) — media mutations write audit records with the request correlation id.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const request = require('supertest');

const config = require('../../src/config');
const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const mediaUrls = require('../../src/lib/mediaUrls');
const sessions = require('../../src/modules/auth/sessions');
const listingSerializers = require('../../src/modules/listings/serializers');
const hostSerializers = require('../../src/modules/hosts/serializers');
const dbh = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');

const ROOT = path.join(__dirname, '..', '..');
const ADAPTERS_DIR = path.join(ROOT, 'src', 'adapters') + path.sep;
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// ---- captured-log app (NFR-08 audit assertions run against real log output) ------------------
const logLines = [];
const sink = {
  write(line) {
    logLines.push(line);
  },
};
let app;

beforeAll(() => {
  app = createApp({ logger: createLogger({ level: 'info', stream: sink }) });
});

afterAll(async () => {
  await dbh.closeDb();
  await closeTestRedis();
});

function parsedAuditLines() {
  return logLines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && entry.audit === true);
}

// ---- fixtures --------------------------------------------------------------------------------

async function cookieFor(user) {
  const { token } = await sessions.createSession({ id: user.id, roles: user.roles });
  return `${config.auth.sessionCookieName}=${token}`;
}

async function makeHost({ bio = 'I cook for my neighbourhood.', fullName = 'Hana Cook' } = {}) {
  const host = await dbh.makeUser({ can_publish_listing: true, full_name: fullName });
  await dbh.makeHostProfile({ user_id: host.id, bio });
  return host;
}

/** An approved review about `hostId` on its own booking (unique (booking_id, author_id)). */
async function makeHostReview(hostId, listingId, overrides = {}) {
  const guest = await dbh.makeUser({ full_name: overrides.author_full_name ?? 'Alice Guest' });
  const booking = await dbh.makeBooking({ listing_id: listingId, guest_id: guest.id });
  return dbh.insertRow('reviews', {
    booking_id: booking.id,
    author_id: overrides.anonymized ? null : guest.id,
    target_user_id: hostId,
    rating: overrides.rating ?? 5,
    body: overrides.body ?? 'Wonderful meal.',
    moderation_status: overrides.moderation_status ?? 'approved',
    ...(overrides.created_at ? { created_at: overrides.created_at } : {}),
  });
}

function mediaKeyFor(userId, kind, name) {
  return `${kind}/${userId}/${name}`;
}

/** Recursively collect every key present anywhere in a JSON payload. */
function collectKeys(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

// NFR-13 / AB-08: keys that must NEVER appear in any hosts payload, for any user.
const FORBIDDEN_KEYS = [
  'email',
  'phone',
  'phoneEnc',
  'phone_enc',
  'passwordHash',
  'password_hash',
  'emergencyContact',
  'emergencyContactName',
  'emergencyContactPhone',
  'emergencyContactEmail',
  'addressLine1',
  'addressLine2',
  'address_line1',
  'address_line2',
  'postalCode',
  'postal_code',
  'lat', // precise coordinates; coarseLat/coarseLng are the allowed public precision
  'lng',
];

function loadedAdapterModules() {
  return Object.keys(require.cache).filter((p) => p.startsWith(ADAPTERS_DIR));
}

/** Capture every http/https request target issued while fn runs (network-call pinning). */
async function captureOutbound(fn) {
  const seen = [];
  const record = (args) => {
    const first = args[0];
    try {
      if (typeof first === 'string') {
        const u = new URL(first);
        seen.push({ host: u.hostname, port: u.port });
        return;
      }
      if (first instanceof URL) {
        seen.push({ host: first.hostname, port: String(first.port) });
        return;
      }
      if (first && typeof first === 'object') {
        seen.push({
          host: String(first.hostname || first.host || ''),
          port: String(first.port || ''),
        });
        return;
      }
    } catch {
      /* fall through */
    }
    seen.push({ host: String(first), port: '' });
  };
  const origHttp = http.request;
  const origHttps = https.request;
  http.request = function patchedHttpRequest(...args) {
    record(args);
    return origHttp.apply(http, args);
  };
  https.request = function patchedHttpsRequest(...args) {
    record(args);
    return origHttps.apply(https, args);
  };
  try {
    const result = await fn();
    return { seen, result };
  } finally {
    http.request = origHttp;
    https.request = origHttps;
  }
}

// ----------------------------------------------------------------------------------------------
// AB-08 — every hosts/media route requires a session
// ----------------------------------------------------------------------------------------------
describe('AB-08 — 401 unauthenticated on every hosts/media route', () => {
  const someUuid = '11111111-2222-4333-8444-555555555555';

  test.each([
    ['GET', `/api/hosts/${someUuid}`],
    ['GET', `/api/hosts/${someUuid}/reviews`],
    ['POST', '/api/media/uploads'],
    ['POST', '/api/media'],
    ['DELETE', `/api/media/${someUuid}`],
  ])('%s %s → 401 with a structured error and no data', async (method, url) => {
    const res = await request(app)[method.toLowerCase()](url);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(EMAIL_SHAPE);
  });
});

// ----------------------------------------------------------------------------------------------
// FR-03 — the host personal page
// ----------------------------------------------------------------------------------------------
describe('FR-03 — GET /api/hosts/:id personal page (TC-03)', () => {
  let host;
  let viewerCookie;
  let approvedListing;
  let pendingListing;
  let cancelledListing;
  let pastListing;
  let approvedReview;
  let anonymizedReview;
  let pendingReview;
  let rejectedReview;
  let deletedMediaId;

  beforeAll(async () => {
    host = await makeHost({ bio: 'Persian home cooking, twenty years of it.' });
    const viewer = await dbh.makeUser();
    viewerCookie = await cookieFor(viewer);

    // Listings: only approved + active + upcoming may appear as example dishes.
    approvedListing = await dbh.makeListing({
      host_id: host.id,
      moderation_status: 'approved',
      title: 'Ghormeh sabzi night',
      address_line1: '4076 Secret Home Way',
      postal_code: '92103',
      lat: 32.123456,
      lng: -117.654321,
    });
    pendingListing = await dbh.makeListing({ host_id: host.id, moderation_status: 'pending' });
    cancelledListing = await dbh.makeListing({
      host_id: host.id,
      moderation_status: 'approved',
      status: 'cancelled',
    });
    pastListing = await dbh.makeListing({
      host_id: host.id,
      moderation_status: 'approved',
      scheduled_start: new Date('2020-05-05T19:00:00Z'),
    });

    // Listing media (FR-02 supply): one live image on the approved listing.
    await dbh.insertRow('media_objects', {
      owner_user_id: host.id,
      entity_type: 'listing',
      entity_id: approvedListing.id,
      storage_key: mediaKeyFor(host.id, 'listing', 'dish-1.jpg'),
      content_type: 'image/jpeg',
    });

    // Host-profile media (kitchen/dining images): two live, one delete-marked.
    await dbh.insertRow('media_objects', {
      owner_user_id: host.id,
      entity_type: 'host_profile',
      storage_key: mediaKeyFor(host.id, 'host_profile', 'kitchen.jpg'),
      content_type: 'image/jpeg',
    });
    await dbh.insertRow('media_objects', {
      owner_user_id: host.id,
      entity_type: 'host_profile',
      storage_key: mediaKeyFor(host.id, 'host_profile', 'dining.webp'),
      content_type: 'image/webp',
    });
    const deleted = await dbh.insertRow('media_objects', {
      owner_user_id: host.id,
      entity_type: 'host_profile',
      storage_key: mediaKeyFor(host.id, 'host_profile', 'old-kitchen.jpg'),
      content_type: 'image/jpeg',
      deleted_at: new Date(),
    });
    deletedMediaId = deleted.id;

    // Reviews about the host: approved ×2 (one anonymized), pending, rejected.
    approvedReview = await makeHostReview(host.id, approvedListing.id, {
      rating: 5,
      body: 'Best khoresh in town.',
      author_full_name: 'Alice Guest',
    });
    anonymizedReview = await makeHostReview(host.id, approvedListing.id, {
      rating: 4,
      anonymized: true,
      body: 'Lovely evening.',
    });
    pendingReview = await makeHostReview(host.id, approvedListing.id, {
      rating: 1,
      moderation_status: 'pending',
      body: 'PENDING-SHOULD-NOT-APPEAR',
    });
    rejectedReview = await makeHostReview(host.id, approvedListing.id, {
      rating: 1,
      moderation_status: 'rejected',
      body: 'REJECTED-SHOULD-NOT-APPEAR',
    });
  });

  test('returns bio, example dishes (publicListing shape), approved reviews, images', async () => {
    const res = await request(app).get(`/api/hosts/${host.id}`).set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
    const page = res.body.host;

    // Self-introduction + display identity (FR-03).
    expect(page.id).toBe(host.id);
    expect(page.selfIntroduction).toBe('Persian home cooking, twenty years of it.');
    expect(page.displayName).toBe('Hana Cook');
    expect(page.memberSince).toBeTruthy();

    // The page shape is exactly the frozen allowlist.
    expect(Object.keys(page).sort()).toEqual([...hostSerializers.HOST_PAGE_KEYS].sort());

    // Example dishes: ONLY the approved active upcoming listing, in publicListing shape.
    expect(page.exampleDishes.map((d) => d.id)).toEqual([approvedListing.id]);
    for (const excluded of [pendingListing, cancelledListing, pastListing]) {
      expect(page.exampleDishes.map((d) => d.id)).not.toContain(excluded.id);
    }
    const dish = page.exampleDishes[0];
    expect(Object.keys(dish).sort()).toEqual([...listingSerializers.PUBLIC_KEYS].sort());
    expect(dish.coarseLat).toBeCloseTo(32.75, 5);
    expect(dish.areaLabel).toBe('San Diego');
    expect(dish.images).toHaveLength(1);
    expect(dish.images[0].url).toContain(`listing/${host.id}/dish-1.jpg`);

    // Approved reviews with numeric ratings + aggregate (FR-05/FR-08 visibility).
    expect(page.reviewCount).toBe(2);
    expect(page.averageRating).toBe(4.5);
    const reviewIds = page.reviews.map((r) => r.id);
    expect(reviewIds).toEqual(expect.arrayContaining([approvedReview.id, anonymizedReview.id]));
    expect(reviewIds).not.toContain(pendingReview.id);
    expect(reviewIds).not.toContain(rejectedReview.id);
    for (const review of page.reviews) {
      expect(Object.keys(review).sort()).toEqual([...hostSerializers.REVIEW_KEYS].sort());
      expect(typeof review.rating).toBe('number');
    }
    const anon = page.reviews.find((r) => r.id === anonymizedReview.id);
    expect(anon.authorId).toBeNull();
    expect(anon.authorDisplayName).toBe(hostSerializers.ANONYMIZED_AUTHOR);
    expect(JSON.stringify(page)).not.toContain('SHOULD-NOT-APPEAR');

    // Kitchen/dining images from storage keys; delete-marked media excluded (ADR-004).
    expect(page.images).toHaveLength(2);
    for (const image of page.images) {
      expect(image.url).toContain(config.objectStorage.bucket);
      expect(image.url).toContain(`host_profile/${host.id}/`);
      expect(image.id).not.toBe(deletedMediaId);
    }
    expect(JSON.stringify(page)).not.toContain('old-kitchen.jpg');
  });

  test('NFR-13/AB-08 key allowlist: no email/phone/contact/hash/exact address anywhere', async () => {
    const res = await request(app).get(`/api/hosts/${host.id}`).set('Cookie', viewerCookie);
    expect(res.status).toBe(200);

    const keys = collectKeys(res.body);
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys.has(forbidden)).toBe(false);
    }
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toMatch(EMAIL_SHAPE); // no email-shaped string at all
    expect(bodyText).not.toContain('4076 Secret Home Way'); // exact address value (ADR-010)
    expect(bodyText).not.toContain('32.123456'); // precise coordinates never leave
  });

  test('the host themselves sees the same public-shape page (ADR-010 default)', async () => {
    const res = await request(app)
      .get(`/api/hosts/${host.id}`)
      .set('Cookie', await cookieFor(host));
    expect(res.status).toBe(200);
    expect(collectKeys(res.body).has('addressLine1')).toBe(false);
  });

  test('unknown host, profile-less user and deleted account are all 404', async () => {
    const unknown = await request(app)
      .get('/api/hosts/99999999-9999-4999-8999-999999999999')
      .set('Cookie', viewerCookie);
    expect(unknown.status).toBe(404);

    const profileLess = await dbh.makeUser();
    const noProfile = await request(app)
      .get(`/api/hosts/${profileLess.id}`)
      .set('Cookie', viewerCookie);
    expect(noProfile.status).toBe(404);

    const ghost = await makeHost({ fullName: 'Gone Host' });
    await dbh.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [ghost.id]);
    const deleted = await request(app).get(`/api/hosts/${ghost.id}`).set('Cookie', viewerCookie);
    expect(deleted.status).toBe(404);
  });

  test('malformed host id is a 422 shape violation, never a 500 (NFR-11)', async () => {
    const res = await request(app).get('/api/hosts/not-a-uuid').set('Cookie', viewerCookie);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

// ----------------------------------------------------------------------------------------------
// FR-03 — paginated reviews list (LT-01 target)
// ----------------------------------------------------------------------------------------------
describe('FR-03 — GET /api/hosts/:id/reviews pagination', () => {
  let host;
  let listing;
  let viewerCookie;
  const approvedIds = []; // newest first

  beforeAll(async () => {
    host = await makeHost({ fullName: 'Paging Host' });
    listing = await dbh.makeListing({ host_id: host.id, moderation_status: 'approved' });
    const viewer = await dbh.makeUser();
    viewerCookie = await cookieFor(viewer);

    const base = Date.now() - 7 * 24 * 3600 * 1000;
    for (let i = 0; i < 7; i += 1) {
      const review = await makeHostReview(host.id, listing.id, {
        rating: (i % 5) + 1,
        body: `Review number ${i}`,
        created_at: new Date(base + i * 3600 * 1000),
      });
      approvedIds.unshift(review.id); // later created_at = newer = earlier in the list
    }
    await makeHostReview(host.id, listing.id, {
      rating: 1,
      moderation_status: 'pending',
      body: 'PAGINATION-PENDING-HIDDEN',
    });
  });

  test('pages approved reviews newest-first with a stable total', async () => {
    const page1 = await request(app)
      .get(`/api/hosts/${host.id}/reviews?page=1&pageSize=3`)
      .set('Cookie', viewerCookie);
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(7);
    expect(page1.body.reviewCount).toBe(7);
    expect(page1.body.page).toBe(1);
    expect(page1.body.pageSize).toBe(3);
    expect(page1.body.reviews.map((r) => r.id)).toEqual(approvedIds.slice(0, 3));

    const page3 = await request(app)
      .get(`/api/hosts/${host.id}/reviews?page=3&pageSize=3`)
      .set('Cookie', viewerCookie);
    expect(page3.body.reviews.map((r) => r.id)).toEqual(approvedIds.slice(6));

    const defaults = await request(app)
      .get(`/api/hosts/${host.id}/reviews`)
      .set('Cookie', viewerCookie);
    expect(defaults.body.reviews).toHaveLength(7);
    expect(JSON.stringify(defaults.body)).not.toContain('PAGINATION-PENDING-HIDDEN');
  });

  test('a host with no reviews reports count 0 and a null average', async () => {
    const quietHost = await makeHost({ fullName: 'Quiet Host' });
    const res = await request(app)
      .get(`/api/hosts/${quietHost.id}/reviews`)
      .set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 0, reviewCount: 0, averageRating: null, reviews: [] });
  });

  test('unknown host 404; hostile pagination input 422 (ST-04)', async () => {
    const unknown = await request(app)
      .get('/api/hosts/88888888-8888-4888-8888-888888888888/reviews')
      .set('Cookie', viewerCookie);
    expect(unknown.status).toBe(404);

    const hostile = await request(app)
      .get(`/api/hosts/${host.id}/reviews?page=<script>alert(1)</script>&pageSize=1e9`)
      .set('Cookie', viewerCookie);
    expect(hostile.status).toBe(422);
  });
});

// ----------------------------------------------------------------------------------------------
// FR-02/FR-05 media — upload-target minting (build-plan §6.3)
// ----------------------------------------------------------------------------------------------
describe('POST /api/media/uploads — namespaced direct-to-storage targets', () => {
  let user;
  let cookie;

  beforeAll(async () => {
    user = await dbh.makeUser();
    cookie = await cookieFor(user);
  });

  test('mints {storageKey, uploadUrl, headers, expiresAt} under the caller namespace', async () => {
    const res = await request(app)
      .post('/api/media/uploads')
      .set('Cookie', cookie)
      .send({ kind: 'listing', contentType: 'image/jpeg', sizeBytes: 123456 });
    expect(res.status).toBe(200);

    const { storageKey, uploadUrl, headers, expiresAt } = res.body;
    expect(storageKey.startsWith(`listing/${user.id}/`)).toBe(true);
    expect(storageKey).toMatch(mediaUrls.KEY_PATTERN);
    expect(uploadUrl).toContain(storageKey);
    expect(uploadUrl).toContain('X-Amz-Signature=');
    expect(uploadUrl).toContain(new URL(config.objectStorage.endpoint).host);
    expect(headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  test('namespaces follow the kind (host_profile → host_profile/<userId>/…)', async () => {
    const res = await request(app)
      .post('/api/media/uploads')
      .set('Cookie', cookie)
      .send({ kind: 'host_profile', contentType: 'image/png', sizeBytes: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.storageKey.startsWith(`host_profile/${user.id}/`)).toBe(true);
  });

  test.each([
    [{ kind: 'avatar', contentType: 'image/jpeg', sizeBytes: 10 }, 'kind outside the enum'],
    [{ kind: 'listing', contentType: 'image/gif', sizeBytes: 10 }, 'contentType off-allowlist'],
    [{ kind: 'listing', contentType: 'text/html', sizeBytes: 10 }, 'markup contentType'],
    [{ kind: 'listing', contentType: 'image/jpeg', sizeBytes: 0 }, 'zero size'],
    [
      { kind: 'listing', contentType: 'image/jpeg', sizeBytes: config.media.maxUploadBytes + 1 },
      'over the configured cap',
    ],
    [{ kind: 'listing', sizeBytes: 10 }, 'missing contentType'],
  ])('rejects %j (%s) with 422 (NFR-11, config allowlists)', async (body) => {
    const res = await request(app).post('/api/media/uploads').set('Cookie', cookie).send(body);
    expect(res.status).toBe(422);
  });

  test('the request path performs NO network call and loads NO src/adapters module', async () => {
    const adaptersBefore = loadedAdapterModules();
    const storagePort = new URL(config.objectStorage.endpoint).port || '9000';

    const { seen, result } = await captureOutbound(() =>
      request(app)
        .post('/api/media/uploads')
        .set('Cookie', cookie)
        .send({ kind: 'review', contentType: 'image/webp', sizeBytes: 2048 })
    );

    expect(result.status).toBe(200);
    // The capture is live (supertest's own call into the app under test is recorded), and
    // the ONLY sockets opened are those — nothing ever targets the object-storage endpoint
    // (or any other provider) from the handler.
    expect(seen.length).toBeGreaterThan(0);
    const external = seen.filter((t) => t.port === storagePort);
    expect(external).toEqual([]);
    expect(loadedAdapterModules()).toEqual(adaptersBefore);
  });

  test('no U3-HOSTS-MEDIA source file imports src/adapters/* (ADR-001 static scan)', () => {
    const owned = [
      'src/schemas/hosts.js',
      'src/schemas/media.js',
      'src/modules/hosts/repo.js',
      'src/modules/hosts/service.js',
      'src/modules/hosts/serializers.js',
      'src/modules/hosts/routes.js',
      'src/modules/media/routes.js',
    ];
    for (const rel of owned) {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(content).not.toMatch(/require\(['"][^'"]*adapters\//);
    }
  });
});

// ----------------------------------------------------------------------------------------------
// FR-02/FR-05 media — attach (namespace + entity ownership) and delete-mark
// ----------------------------------------------------------------------------------------------
describe('POST /api/media and DELETE /api/media/:id', () => {
  let host;
  let hostCookie;
  let otherUser;
  let otherCookie;
  let ownListing;
  let otherListing;

  beforeAll(async () => {
    host = await makeHost({ fullName: 'Media Host' });
    hostCookie = await cookieFor(host);
    otherUser = await dbh.makeUser();
    otherCookie = await cookieFor(otherUser);
    ownListing = await dbh.makeListing({ host_id: host.id, moderation_status: 'approved' });
    otherListing = await dbh.makeListing({ moderation_status: 'approved' });
  });

  async function mint(cookie, kind, contentType = 'image/jpeg') {
    const res = await request(app)
      .post('/api/media/uploads')
      .set('Cookie', cookie)
      .send({ kind, contentType, sizeBytes: 4096 });
    expect(res.status).toBe(200);
    return res.body;
  }

  test('a minted key attaches to the caller’s own listing and is recorded in media_objects', async () => {
    const target = await mint(hostCookie, 'listing');
    const res = await request(app).post('/api/media').set('Cookie', hostCookie).send({
      storageKey: target.storageKey,
      kind: 'listing',
      entityId: ownListing.id,
      contentType: 'image/jpeg',
      sizeBytes: 4096,
    });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.media).sort()).toEqual(
      [
        'contentType',
        'createdAt',
        'entityId',
        'id',
        'kind',
        'sizeBytes',
        'storageKey',
        'url',
      ].sort()
    );
    expect(res.body.media.url).toContain(target.storageKey);

    const { rows } = await dbh.query(`SELECT * FROM media_objects WHERE storage_key = $1`, [
      target.storageKey,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner_user_id: host.id,
      entity_type: 'listing',
      entity_id: ownListing.id,
      content_type: 'image/jpeg',
      deleted_at: null,
    });

    // NFR-08 / MT-01: the mutation wrote an audit record carrying a correlation id.
    const auditLine = parsedAuditLines().find(
      (l) => l.event === 'media.attached' && l.entityId === rows[0].id
    );
    expect(auditLine).toMatchObject({ actorUserId: host.id, outcome: 'success' });
    expect(auditLine.correlationId).toBeTruthy();
  });

  test('attach integrates with the FR-02 listing detail read path', async () => {
    const target = await mint(hostCookie, 'listing');
    await request(app)
      .post('/api/media')
      .set('Cookie', hostCookie)
      .send({ storageKey: target.storageKey, kind: 'listing', entityId: ownListing.id })
      .expect(201);

    const detail = await request(app)
      .get(`/api/listings/${ownListing.id}`)
      .set('Cookie', otherCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.listing.images.map((i) => i.url).join(' ')).toContain(target.storageKey);
  });

  test('403 for any key outside the caller’s own <kind>/<userId>/ namespace (AB-08)', async () => {
    // Another user's namespace.
    const foreign = await request(app)
      .post('/api/media')
      .set('Cookie', hostCookie)
      .send({ storageKey: `listing/${otherUser.id}/stolen.jpg`, kind: 'listing' });
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('MEDIA_KEY_FORBIDDEN');

    // Own id but the WRONG kind namespace: still outside the declared kind's prefix.
    const wrongKind = await request(app)
      .post('/api/media')
      .set('Cookie', hostCookie)
      .send({ storageKey: `review/${host.id}/sneaky.jpg`, kind: 'listing' });
    expect(wrongKind.status).toBe(403);

    const { rows } = await dbh.query(
      `SELECT count(*)::int AS n FROM media_objects WHERE storage_key IN ($1, $2)`,
      [`listing/${otherUser.id}/stolen.jpg`, `review/${host.id}/sneaky.jpg`]
    );
    expect(rows[0].n).toBe(0); // nothing was recorded
  });

  test('attaching to an entity the caller does not own is 403; unknown entity 404', async () => {
    const target = await mint(hostCookie, 'listing');
    const notOwned = await request(app)
      .post('/api/media')
      .set('Cookie', hostCookie)
      .send({ storageKey: target.storageKey, kind: 'listing', entityId: otherListing.id });
    expect(notOwned.status).toBe(403);
    expect(notOwned.body.error.code).toBe('MEDIA_ENTITY_NOT_OWNED');

    const missing = await request(app).post('/api/media').set('Cookie', hostCookie).send({
      storageKey: target.storageKey,
      kind: 'listing',
      entityId: '77777777-7777-4777-8777-777777777777',
    });
    expect(missing.status).toBe(404);

    // host_profile media may only ever reference the caller's own profile.
    const profileTarget = await mint(hostCookie, 'host_profile', 'image/png');
    const foreignProfile = await request(app)
      .post('/api/media')
      .set('Cookie', hostCookie)
      .send({ storageKey: profileTarget.storageKey, kind: 'host_profile', entityId: otherUser.id });
    expect(foreignProfile.status).toBe(403);
  });

  // FR-05 / AB-08 — review photos travel through this same surface (kind='review'). Since
  // U4-REVIEWS landed (wave 4B) the authorship lookup lives in its owning module —
  // src/modules/reviews/repo.js findReviewAuthorId, re-exported unchanged by mediaRepo for
  // the route's pinned call site (ADR-001: routes validate, repos query; the identity of
  // the two exports is pinned in tests/unit/reviews.test.js). The rejection paths exercised
  // below are unchanged by the move.
  /** A review row authored by `authorId` about `targetUserId`, on its own booking. */
  async function makeReviewAuthoredBy(authorId, targetUserId) {
    const booking = await dbh.makeBooking({
      listing_id: otherListing.id,
      ...(authorId ? { guest_id: authorId } : {}),
    });
    return dbh.insertRow('reviews', {
      booking_id: booking.id,
      author_id: authorId,
      target_user_id: targetUserId,
      rating: 5,
      body: 'Review-attach fixture.',
      moderation_status: 'pending',
    });
  }

  test('a minted review key attaches to a review the caller authored (FR-05)', async () => {
    const review = await makeReviewAuthoredBy(host.id, otherListing.host_id);
    const target = await mint(hostCookie, 'review');

    const res = await request(app).post('/api/media').set('Cookie', hostCookie).send({
      storageKey: target.storageKey,
      kind: 'review',
      entityId: review.id,
      contentType: 'image/jpeg',
      sizeBytes: 4096,
    });
    expect(res.status).toBe(201);
    expect(res.body.media).toMatchObject({ kind: 'review', entityId: review.id });

    const { rows } = await dbh.query(`SELECT * FROM media_objects WHERE storage_key = $1`, [
      target.storageKey,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner_user_id: host.id,
      entity_type: 'review',
      entity_id: review.id,
      deleted_at: null,
    });
  });

  test('attaching to a review the caller did not author is 403; unknown review 404 (AB-08)', async () => {
    // Authored by someone else — the caller's own namespace key is not enough.
    const foreignReview = await makeReviewAuthoredBy(otherUser.id, host.id);
    const target = await mint(hostCookie, 'review');
    const notAuthor = await request(app)
      .post('/api/media')
      .set('Cookie', hostCookie)
      .send({ storageKey: target.storageKey, kind: 'review', entityId: foreignReview.id });
    expect(notAuthor.status).toBe(403);
    expect(notAuthor.body.error.code).toBe('MEDIA_ENTITY_NOT_OWNED');

    // A review whose author was severed by the NFR-12 anonymization path belongs to nobody.
    const anonymized = await makeReviewAuthoredBy(null, host.id);
    const anon = await request(app)
      .post('/api/media')
      .set('Cookie', hostCookie)
      .send({ storageKey: target.storageKey, kind: 'review', entityId: anonymized.id });
    expect(anon.status).toBe(403);

    const missing = await request(app).post('/api/media').set('Cookie', hostCookie).send({
      storageKey: target.storageKey,
      kind: 'review',
      entityId: '88888888-8888-4888-8888-888888888888',
    });
    expect(missing.status).toBe(404);

    // Nothing was recorded by any of the three refusals.
    const { rows } = await dbh.query(
      `SELECT count(*)::int AS n FROM media_objects WHERE storage_key = $1`,
      [target.storageKey]
    );
    expect(rows[0].n).toBe(0);
  });

  test('attaching the same storage key twice is a 409 conflict', async () => {
    const target = await mint(hostCookie, 'host_profile', 'image/png');
    const body = { storageKey: target.storageKey, kind: 'host_profile' };
    await request(app).post('/api/media').set('Cookie', hostCookie).send(body).expect(201);
    const dup = await request(app).post('/api/media').set('Cookie', hostCookie).send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('MEDIA_KEY_EXISTS');
  });

  test('host_profile attach surfaces on the FR-03 page; delete-mark removes it (ADR-004/NFR-12)', async () => {
    const target = await mint(hostCookie, 'host_profile', 'image/webp');
    const attach = await request(app)
      .post('/api/media')
      .set('Cookie', hostCookie)
      .send({ storageKey: target.storageKey, kind: 'host_profile', entityId: host.id })
      .expect(201);
    const mediaId = attach.body.media.id;

    const before = await request(app).get(`/api/hosts/${host.id}`).set('Cookie', otherCookie);
    expect(before.body.host.images.map((i) => i.id)).toContain(mediaId);

    // Delete-mark: 204, deleted_at set, ROW AND OBJECT INTACT (physical deletion is the
    // worker/erasure path — ADR-004, NFR-12), and the image leaves every read path.
    await request(app).delete(`/api/media/${mediaId}`).set('Cookie', hostCookie).expect(204);
    const { rows } = await dbh.query(`SELECT deleted_at FROM media_objects WHERE id = $1`, [
      mediaId,
    ]);
    expect(rows).toHaveLength(1); // still present — only marked
    expect(rows[0].deleted_at).not.toBeNull();

    const after = await request(app).get(`/api/hosts/${host.id}`).set('Cookie', otherCookie);
    expect(after.body.host.images.map((i) => i.id)).not.toContain(mediaId);

    // Idempotent for the owner.
    await request(app).delete(`/api/media/${mediaId}`).set('Cookie', hostCookie).expect(204);
  });

  test('deleting someone else’s media (or an unknown id) is 404 and changes nothing', async () => {
    const target = await mint(hostCookie, 'host_profile', 'image/png');
    const attach = await request(app)
      .post('/api/media')
      .set('Cookie', hostCookie)
      .send({ storageKey: target.storageKey, kind: 'host_profile' })
      .expect(201);
    const mediaId = attach.body.media.id;

    const foreign = await request(app).delete(`/api/media/${mediaId}`).set('Cookie', otherCookie);
    expect(foreign.status).toBe(404);
    const { rows } = await dbh.query(`SELECT deleted_at FROM media_objects WHERE id = $1`, [
      mediaId,
    ]);
    expect(rows[0].deleted_at).toBeNull();

    const unknown = await request(app)
      .delete('/api/media/66666666-6666-4666-8666-666666666666')
      .set('Cookie', hostCookie);
    expect(unknown.status).toBe(404);
  });
});

// ----------------------------------------------------------------------------------------------
// ST-04 — hostile payloads at every hosts/media input: no 500, nothing executable stored
// ----------------------------------------------------------------------------------------------
describe('ST-04 — hostile payloads across hosts/media inputs', () => {
  const PAYLOADS = [
    '<script>alert(1)</script>',
    '"><img src=x onerror=alert(1)>',
    "'; DROP TABLE media_objects;--",
    '../../etc/passwd',
    '{{7*7}}',
  ];
  let cookie;
  let host;

  beforeAll(async () => {
    host = await makeHost({ fullName: 'ST04 Host' });
    cookie = await cookieFor(host);
  });

  test('every injection attempt is refused (4xx) — never a 500', async () => {
    for (const payload of PAYLOADS) {
      const probes = [
        request(app)
          .get(`/api/hosts/${encodeURIComponent(payload)}`)
          .set('Cookie', cookie),
        request(app)
          .get(`/api/hosts/${host.id}/reviews`)
          .query({ page: payload, pageSize: payload })
          .set('Cookie', cookie),
        request(app)
          .post('/api/media/uploads')
          .set('Cookie', cookie)
          .send({ kind: payload, contentType: payload, sizeBytes: payload }),
        request(app)
          .post('/api/media')
          .set('Cookie', cookie)
          .send({ storageKey: payload, kind: 'listing' }),
        request(app)
          .delete(`/api/media/${encodeURIComponent(payload)}`)
          .set('Cookie', cookie),
      ];
      for (const probe of probes) {
        const res = await probe;
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      }
    }
  });

  test('a storage key that matches the caller prefix but carries markup is still refused', async () => {
    const res = await request(app)
      .post('/api/media')
      .set('Cookie', cookie)
      .send({ storageKey: `listing/${host.id}/x<script>.jpg`, kind: 'listing' });
    expect(res.status).toBe(422);
  });

  test('no executable markup was stored in media_objects', async () => {
    const { rows } = await dbh.query(
      `SELECT count(*)::int AS n FROM media_objects
        WHERE storage_key LIKE '%<%' OR storage_key LIKE '%>%'
           OR content_type LIKE '%<%' OR content_type LIKE '%>%'`
    );
    expect(rows[0].n).toBe(0);
  });

  test('a bio submitted through the API renders inert on the host page (NFR-11 sanitize)', async () => {
    await request(app)
      .patch('/api/users/me')
      .set('Cookie', cookie)
      .send({ hostProfile: { bio: '<script>alert(1)</script> honest cooking' } })
      .expect(200);

    const res = await request(app).get(`/api/hosts/${host.id}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.host.selfIntroduction).not.toContain('<');
    expect(res.body.host.selfIntroduction).toContain('honest cooking');
    expect(JSON.stringify(res.body)).not.toContain('<script');
  });
});
