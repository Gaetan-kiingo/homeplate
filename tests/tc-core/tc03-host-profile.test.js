// tests/tc-core/tc03-host-profile.test.js — TC-03 / FR-03: host personal page (SRS §3.1;
// acceptance per docs/_generated/requirements-inventory.json).
//
// Asserted here, by execution against the seeded test DB (SRS §4.1):
//   - GET /api/hosts/:id returns selfIntroduction, exampleDishes (the host's approved
//     listings), reviews with numeric ratings + average, and kitchen/dining image URLs
//     resolved from object-storage keys;
//   - only approved reviews (and non-deleted media) are returned — pending/rejected reviews
//     are invisible; an anonymized author renders a neutral display name;
//   - the response contains no email, phone, emergency contact, or password hash for ANY
//     user (key allowlists asserted);
//   - unauthenticated → 401 (AB-08);
//   - ADR-010: exampleDishes show coarse location + area label only — never a street address
//     or precise coordinates;
//   - GET /api/hosts/:id/reviews paginates the approved reviews newest-first;
//   - NFR-12 erasure: media marked deleted_at never resurface on the host page (ADR-004);
//     a soft-deleted host account is a 404 indistinguishable from an unknown id, and the
//     example-dishes repo read is empty for it (findings TCC-02 / TCC-RV-02).
'use strict';

const request = require('supertest');

const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const listingSerializers = require('../../src/modules/listings/serializers');
const listingsRepo = require('../../src/modules/listings/repo');
const hostSerializers = require('../../src/modules/hosts/serializers');
const dbh = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const support = require('./support');

const sink = { write() {} };
let app;

const RUN = `${process.pid}${Date.now() % 1e7}`;
const BIO = `Tc03 self introduction: I host weekly dinners. ${RUN}`;
const STREET = `88 Tc03 Hidden Street ${RUN}`;
const PRECISE = { lat: 32.881234, lng: -117.234567 };

let host;
let hostProfileMedia;
let viewerCookie;
let approvedDish; // approved + active + future, with media — must appear
let pendingDish; // pending — must NOT appear
let rejectedDish; // rejected — must NOT appear
let dishMedia;
let approvedReviewIds; // 3 approved reviews, insertion order oldest→newest
let anonReviewId;

function hostPage(id, cookie = viewerCookie) {
  return support.get(app, `/api/hosts/${id}`, cookie);
}

async function makeReview({ guestName, rating, body, moderation, anonymized = false }) {
  const guest = await dbh.makeUser({ full_name: guestName });
  const listingForBooking = await support.makeApprovedListing({ host_id: host.id });
  const booking = await support.makeCompletedBooking(listingForBooking.id, guest.id);
  const review = await dbh.insertRow('reviews', {
    booking_id: booking.id,
    author_id: anonymized ? null : guest.id,
    target_user_id: host.id,
    rating,
    body,
    moderation_status: moderation,
  });
  return review;
}

beforeAll(async () => {
  app = createApp({ logger: createLogger({ level: 'silent', stream: sink }) });
  viewerCookie = await support.cookieFor(await dbh.makeUser());

  host = await dbh.makeUser({ can_publish_listing: true, full_name: 'Tc03 Host Miriam' });
  await dbh.makeHostProfile({ user_id: host.id, bio: BIO });
  hostProfileMedia = [
    await support.attachHostProfileMedia(host.id, 'kitchen.jpg'),
    await support.attachHostProfileMedia(host.id, 'dining.jpg'),
  ];

  approvedDish = await support.makeApprovedListing({
    host_id: host.id,
    title: `Tc03 Approved Dish ${RUN}`,
    address_line1: STREET,
    lat: PRECISE.lat,
    lng: PRECISE.lng,
    coarse_lat: 32.88,
    coarse_lng: -117.23,
    area_label: 'University City, San Diego',
  });
  dishMedia = await support.attachListingMedia(approvedDish, host.id, 'dish.jpg');
  pendingDish = await dbh.makeListing({
    host_id: host.id,
    title: `Tc03 Pending Dish ${RUN}`,
    moderation_status: 'pending',
    status: 'active',
  });
  rejectedDish = await dbh.makeListing({
    host_id: host.id,
    title: `Tc03 Rejected Dish ${RUN}`,
    moderation_status: 'rejected',
    status: 'active',
  });

  // Reviews: 3 approved (ratings 5, 4, 3 — average 4), 1 pending, 1 rejected, 1 anonymized
  // approved (rating 2 → average over approved set becomes 3.5 with 4 approved reviews).
  approvedReviewIds = [];
  approvedReviewIds.push(
    (
      await makeReview({
        guestName: 'Tc03 Guest A',
        rating: 5,
        body: 'Great!',
        moderation: 'approved',
      })
    ).id
  );
  approvedReviewIds.push(
    (
      await makeReview({
        guestName: 'Tc03 Guest B',
        rating: 4,
        body: 'Nice.',
        moderation: 'approved',
      })
    ).id
  );
  approvedReviewIds.push(
    (
      await makeReview({
        guestName: 'Tc03 Guest C',
        rating: 3,
        body: 'Fine.',
        moderation: 'approved',
      })
    ).id
  );
  await makeReview({
    guestName: 'Tc03 Guest D',
    rating: 1,
    body: 'PENDING-INVISIBLE',
    moderation: 'pending',
  });
  await makeReview({
    guestName: 'Tc03 Guest E',
    rating: 1,
    body: 'REJECTED-INVISIBLE',
    moderation: 'rejected',
  });
  anonReviewId = (
    await makeReview({
      guestName: 'Tc03 Ghost Guest',
      rating: 2,
      body: 'Anonymized author.',
      moderation: 'approved',
      anonymized: true,
    })
  ).id;
});

afterAll(async () => {
  await closeTestRedis();
  await dbh.closeDb();
});

describe('TC-03 / FR-03 — host page content', () => {
  test('returns selfIntroduction, exampleDishes, reviews with numeric ratings + average, and kitchen/dining image URLs', async () => {
    const res = await hostPage(host.id);
    expect(res.status).toBe(200);
    const page = res.body.host;

    expect(page.selfIntroduction).toBe(BIO);
    expect(page.displayName).toBe('Tc03 Host Miriam');

    // Kitchen/dining images resolved from object-storage keys (ADR-004).
    expect(page.images).toHaveLength(2);
    const imageUrls = page.images.map((i) => i.url).join('\n');
    for (const m of hostProfileMedia) {
      expect(imageUrls).toContain(m.storage_key);
    }

    // Example dishes: the approved listing appears (with its media), pending/rejected never.
    const dishIds = page.exampleDishes.map((d) => d.id);
    expect(dishIds).toContain(approvedDish.id);
    expect(dishIds).not.toContain(pendingDish.id);
    expect(dishIds).not.toContain(rejectedDish.id);
    const dish = page.exampleDishes.find((d) => d.id === approvedDish.id);
    expect(dish.images.map((i) => i.url).join('')).toContain(dishMedia.storage_key);

    // Approved reviews with numeric ratings; average over the approved set only:
    // (5 + 4 + 3 + 2) / 4 = 3.5, count 4.
    expect(page.reviewCount).toBe(4);
    expect(page.averageRating).toBe(3.5);
    expect(page.reviews.length).toBeGreaterThan(0);
    for (const review of page.reviews) {
      expect(typeof review.rating).toBe('number');
      expect(review.rating).toBeGreaterThanOrEqual(1);
      expect(review.rating).toBeLessThanOrEqual(5);
    }
    const raw = JSON.stringify(page);
    expect(raw).not.toContain('PENDING-INVISIBLE');
    expect(raw).not.toContain('REJECTED-INVISIBLE');
  });

  test('an anonymized review author renders a neutral display name (NFR-12)', async () => {
    const res = await hostPage(host.id);
    expect(res.status).toBe(200);
    const anon = res.body.host.reviews.find((r) => r.id === anonReviewId);
    expect(anon).toBeDefined();
    expect(anon.authorId).toBeNull();
    expect(anon.authorDisplayName).toBe(hostSerializers.ANONYMIZED_AUTHOR);
    expect(JSON.stringify(res.body)).not.toContain('Tc03 Ghost Guest');
  });

  test('the payload matches the frozen key allowlists — no email, phone, emergency contact, or password hash for any user', async () => {
    const res = await hostPage(host.id);
    expect(res.status).toBe(200);
    const page = res.body.host;
    expect(Object.keys(page).sort()).toEqual([...hostSerializers.HOST_PAGE_KEYS].sort());
    for (const review of page.reviews) {
      expect(Object.keys(review).sort()).toEqual([...hostSerializers.REVIEW_KEYS].sort());
    }
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(support.EMAIL_SHAPE);
    expect(raw).not.toContain(host.email);
    expect(raw).not.toMatch(/password|phone|emergency/i);
  });

  test('ADR-010: exampleDishes carry coarse location + area label only — never a street address or precise coordinates', async () => {
    const res = await hostPage(host.id);
    expect(res.status).toBe(200);
    for (const dish of res.body.host.exampleDishes) {
      expect(Object.keys(dish).sort()).toEqual([...listingSerializers.PUBLIC_KEYS].sort());
      expect(dish.addressLine1).toBeUndefined();
      expect(dish.lat).toBeUndefined();
      expect(dish.lng).toBeUndefined();
    }
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(STREET);
    expect(raw).not.toContain(String(PRECISE.lat));
    expect(raw).not.toContain(String(PRECISE.lng));
  });

  test('unauthenticated host-page read is refused with 401 (AB-08)', async () => {
    const res = await request(app).get(`/api/hosts/${host.id}`);
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  test('an unknown host id (and a user without a host profile) is a structured 404', async () => {
    const nobody = await dbh.makeUser(); // no host profile
    expect((await hostPage('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await hostPage(nobody.id)).status).toBe(404);
  });
});

// NFR-12 erasure marks and deleted accounts on the FR-03 surface (findings TCC-02/TCC-RV-02).
// The v1.0 deletion endpoint is wave-4 U4-PRIVACY; these pin the read-path semantics wave 3
// implements so the erasure cascade is written against a proven contract. The search half
// lives in tc01-search.test.js, the detail-retention half in tc02-listing-detail.test.js,
// and the cascade contract itself in tccrv02-erasure-read-paths.test.js.
describe('TC-03 / FR-03 — NFR-12: deleted media and deleted accounts', () => {
  test('media marked deleted_at never resurface on the host page (NFR-12 / ADR-004)', async () => {
    const probeHost = await dbh.makeUser({ can_publish_listing: true });
    await dbh.makeHostProfile({ user_id: probeHost.id, bio: `Erasure probe ${RUN}` });
    const live = await support.attachHostProfileMedia(probeHost.id, `tc03-live-${RUN}.jpg`);
    const erased = await dbh.insertRow('media_objects', {
      owner_user_id: probeHost.id,
      entity_type: 'host_profile',
      entity_id: probeHost.id,
      storage_key: `host_profile/${probeHost.id}/tc03-erased-${RUN}.jpg`,
      content_type: 'image/jpeg',
      deleted_at: new Date(),
    });

    const dish = await support.makeApprovedListing({ host_id: probeHost.id });
    const dishLive = await support.attachListingMedia(
      dish,
      probeHost.id,
      `tc03-dish-live-${RUN}.jpg`
    );
    const dishErased = await dbh.insertRow('media_objects', {
      owner_user_id: probeHost.id,
      entity_type: 'listing',
      entity_id: dish.id,
      storage_key: `listing/${probeHost.id}/tc03-dish-erased-${RUN}.jpg`,
      content_type: 'image/jpeg',
      deleted_at: new Date(),
    });

    const res = await hostPage(probeHost.id);
    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    expect(raw).toContain(live.storage_key);
    expect(raw).not.toContain(erased.storage_key);

    const dishPayload = res.body.host.exampleDishes.find((d) => d.id === dish.id);
    expect(dishPayload).toBeDefined();
    const dishUrls = dishPayload.images.map((i) => i.url).join('\n');
    expect(dishUrls).toContain(dishLive.storage_key);
    expect(dishUrls).not.toContain(dishErased.storage_key);
  });

  test('a soft-deleted host account is a structured 404 indistinguishable from an unknown id (NFR-12)', async () => {
    const doomedHost = await dbh.makeUser({ can_publish_listing: true });
    await dbh.makeHostProfile({ user_id: doomedHost.id, bio: `Deleted host ${RUN}` });
    expect((await hostPage(doomedHost.id)).status).toBe(200); // visible until deleted

    await dbh.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [doomedHost.id]);
    const res = await hostPage(doomedHost.id);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('NOT_FOUND');
    // …and the 404 envelope itself never leaks the erased name (TCC-RV-02).
    expect(JSON.stringify(res.body)).not.toContain(doomedHost.full_name);
  });

  test('the example-dishes read is empty for a soft-deleted host and populated for a live one', async () => {
    // The repo primitive itself, not just the 404 one call frame up: hosts/service.getHostPage
    // 404s first today, so this is the assertion that actually exercises the erasure predicate
    // added to listings/repo.findApprovedByHost (TCC-RV-02).
    const cuisine = `tc03erasure${RUN}`;
    const liveHost = await dbh.makeUser({ can_publish_listing: true });
    await dbh.makeHostProfile({ user_id: liveHost.id });
    const liveListing = await support.makeApprovedListing({ host_id: liveHost.id, cuisine });
    const { host: goneHost } = await support.seedDeletedHostWithListing({ cuisine });

    await expect(listingsRepo.findApprovedByHost(goneHost.id)).resolves.toEqual([]);
    const liveRows = await listingsRepo.findApprovedByHost(liveHost.id);
    expect(liveRows.map((r) => r.id)).toContain(liveListing.id);
  });
});

describe('TC-03 / FR-03 — GET /api/hosts/:id/reviews pagination', () => {
  test('paginates approved reviews newest-first; pending/rejected are never listed', async () => {
    const page1 = await support.get(
      app,
      `/api/hosts/${host.id}/reviews?page=1&pageSize=3`,
      viewerCookie
    );
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(4);
    expect(page1.body.reviews).toHaveLength(3);

    const page2 = await support.get(
      app,
      `/api/hosts/${host.id}/reviews?page=2&pageSize=3`,
      viewerCookie
    );
    expect(page2.status).toBe(200);
    expect(page2.body.reviews).toHaveLength(1);

    const listed = [...page1.body.reviews, ...page2.body.reviews];
    // Newest-first: insertion order was A(5), B(4), C(3), anon(2) — reversed on the wire.
    expect(listed.map((r) => r.id)).toEqual([anonReviewId, ...[...approvedReviewIds].reverse()]);
    const raw = JSON.stringify(listed);
    expect(raw).not.toContain('PENDING-INVISIBLE');
    expect(raw).not.toContain('REJECTED-INVISIBLE');
    expect(raw).not.toMatch(support.EMAIL_SHAPE);
  });

  test('unauthenticated reviews read is refused with 401 (AB-08)', async () => {
    const res = await request(app).get(`/api/hosts/${host.id}/reviews`);
    expect(res.status).toBe(401);
  });
});
