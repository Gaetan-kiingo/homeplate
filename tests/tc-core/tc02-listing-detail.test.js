// tests/tc-core/tc02-listing-detail.test.js — TC-02 / FR-02: meal detail view (SRS §3.1;
// acceptance per docs/_generated/requirements-inventory.json).
//
// Asserted here, by execution against the seeded test DB (SRS §4.1):
//   - GET /api/listings/:id returns every seeded content field (name/title, description,
//     ingredients, allergy warnings, date/duration, seatCapacity, seatsRemaining, image URLs
//     derived from object-storage keys);
//   - the acceptance additionally demands host summary (display name, bio, average rating,
//     review count) and the host's approved reviews IN THE SAME RESPONSE — asserted in its
//     own test so a gap is visible without masking the rest;
//   - TCC-04: that embedded review list is a BOUNDED preview, so the payload must label it —
//     reviewsTotal + reviewsPageSize — and the remainder must be reachable through the
//     documented pager GET /api/hosts/:id/reviews (asserted end to end, preview ∪ page 2);
//   - pending/rejected → 404 for any user but the owning host; the owner sees it WITH its
//     moderation status;
//   - NFR-13: no host email/phone/exact street address in the public payload;
//   - ADR-010: exact address + precise coordinates ONLY for (a) the owner, (b) a guest whose
//     booking on this listing is pending or in_progress — a cancelled/completed guest reverts
//     to public — and (c) a moderator handling an FR-07 alert on it (access_log row written);
//     a moderator WITHOUT an alert gets the public projection.
'use strict';

const request = require('supertest');

const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const serializers = require('../../src/modules/listings/serializers');
const dbh = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const support = require('./support');

const sink = { write() {} };
let app;

const RUN = `${process.pid}${Date.now() % 1e7}`;
const STREET = `1420 Tc02 Privileged Way ${RUN}`;
const PRECISE = { lat: 32.798765, lng: -117.212345 };
const SEEDED = {
  title: `Tc02 Family Paella ${RUN}`,
  description: 'Slow-cooked seafood paella with saffron rice.',
  ingredients: ['rice', 'shrimp', 'mussels', 'saffron'],
  allergens: ['shellfish'],
  cuisine: `tc02cuisine${RUN}`,
  duration_minutes: 120,
  seat_capacity: 6,
  seats_remaining: 4,
};

let host; // owning host (has profile + approved review — for the host-summary acceptance)
let hostCookie;
let listing; // approved + active + future, full address + precise + coarse coords, 2 images
let mediaRows;
let viewer;
let viewerCookie;

function detail(id, cookie) {
  return support.get(app, `/api/listings/${id}`, cookie);
}

beforeAll(async () => {
  app = createApp({ logger: createLogger({ level: 'silent', stream: sink }) });

  host = await dbh.makeUser({ can_publish_listing: true, full_name: 'Tc02 Host Hannah' });
  await dbh.makeHostProfile({ user_id: host.id, bio: 'I cook paella every Sunday.' });
  hostCookie = await support.cookieFor(host);

  listing = await support.makeApprovedListing({
    host_id: host.id,
    ...SEEDED,
    scheduled_start: new Date('2033-05-05T19:00:00Z'),
    address_line1: STREET,
    postal_code: '92109',
    lat: PRECISE.lat,
    lng: PRECISE.lng,
    coarse_lat: 32.8,
    coarse_lng: -117.21,
    area_label: 'Pacific Beach, San Diego',
  });
  mediaRows = [
    await support.attachListingMedia(listing, host.id, 'tc02-a.jpg'),
    await support.attachListingMedia(listing, host.id, 'tc02-b.jpg'),
  ];

  // An approved review about the host (the FR-02 acceptance embeds host reviews).
  const pastGuest = await dbh.makeUser({ full_name: 'Tc02 Past Guest' });
  const pastListing = await support.makeApprovedListing({ host_id: host.id });
  const doneBooking = await support.makeCompletedBooking(pastListing.id, pastGuest.id);
  await dbh.insertRow('reviews', {
    booking_id: doneBooking.id,
    author_id: pastGuest.id,
    target_user_id: host.id,
    rating: 5,
    body: 'Wonderful meal.',
    moderation_status: 'approved',
  });

  viewer = await dbh.makeUser();
  viewerCookie = await support.cookieFor(viewer);
});

afterAll(async () => {
  await closeTestRedis();
  await dbh.closeDb();
});

describe('TC-02 / FR-02 — content fields equal the seeded values', () => {
  test('an approved listing returns every seeded field, seats and storage-key-derived image URLs', async () => {
    const res = await detail(listing.id, viewerCookie);
    expect(res.status).toBe(200);
    const body = res.body.listing;
    expect(body).toMatchObject({
      id: listing.id,
      hostId: host.id,
      title: SEEDED.title,
      description: SEEDED.description,
      ingredients: SEEDED.ingredients,
      allergens: SEEDED.allergens,
      cuisine: SEEDED.cuisine,
      durationMinutes: SEEDED.duration_minutes,
      seatCapacity: SEEDED.seat_capacity,
      seatsRemaining: SEEDED.seats_remaining,
      status: 'active',
      moderationStatus: 'approved',
    });
    expect(new Date(body.scheduledStart).toISOString()).toBe('2033-05-05T19:00:00.000Z');
    // Image URLs derived from the media_objects storage keys (ADR-004).
    expect(body.images).toHaveLength(2);
    const urls = body.images.map((img) => img.url).join('\n');
    for (const m of mediaRows) {
      expect(urls).toContain(m.storage_key);
    }
  });

  test('FR-02 acceptance: host summary (display name, bio, average rating, review count) and approved host reviews ride the SAME response', async () => {
    const res = await detail(listing.id, viewerCookie);
    expect(res.status).toBe(200);
    const body = res.body.listing;
    // "in one response: … host summary (display name, bio, average rating, review count)
    //  and the approved reviews for that host" — requirements-inventory FR-02 / TC-02.
    expect(body.host).toBeDefined();
    expect(body.host).toMatchObject({
      displayName: 'Tc02 Host Hannah',
      bio: 'I cook paella every Sunday.',
      averageRating: 5,
      reviewCount: 1,
    });
    expect(Array.isArray(body.reviews)).toBe(true);
    expect(body.reviews.length).toBe(1);
    expect(body.reviews[0].rating).toBe(5);
    // A host with fewer reviews than the preview cap still states the total explicitly.
    expect(body.reviewsTotal).toBe(1);
    expect(body.reviewsPageSize).toBeGreaterThanOrEqual(body.reviews.length);
  });
});

// TCC-04 regression. The embedded review list is a BOUNDED preview (NFR-01/NFR-02: no read
// path returns an unbounded row set), so the payload has to say so — otherwise a client
// reading `reviews` cannot distinguish a 5-review host from a 500-review one, and the FR-02
// clause "and the approved reviews for that host" is only partly served. Pinned here:
// reviewsTotal + reviewsPageSize ride the detail response, and every review the preview
// omits is reachable through the documented pager GET /api/hosts/:id/reviews.
describe('TC-02 / FR-02 — the embedded review list is a self-describing page (TCC-04)', () => {
  const REVIEW_COUNT = 7; // > the preview cap
  let busyHost;
  let busyListing;

  beforeAll(async () => {
    busyHost = await dbh.makeUser({ can_publish_listing: true, full_name: 'Tc02 Busy Host' });
    await dbh.makeHostProfile({ user_id: busyHost.id, bio: 'Seven happy guests.' });
    busyListing = await support.makeApprovedListing({ host_id: busyHost.id });
    for (let i = 0; i < REVIEW_COUNT; i += 1) {
      const guest = await dbh.makeUser();
      const pastListing = await support.makeApprovedListing({ host_id: busyHost.id });
      const booking = await support.makeCompletedBooking(pastListing.id, guest.id);
      await dbh.insertRow('reviews', {
        booking_id: booking.id,
        author_id: guest.id,
        target_user_id: busyHost.id,
        rating: 5,
        body: `tc02 preview review ${i}`,
        moderation_status: 'approved',
      });
    }
  });

  test('a truncated preview declares its total and page size, and the pager serves the rest', async () => {
    const res = await detail(busyListing.id, viewerCookie);
    expect(res.status).toBe(200);
    const body = res.body.listing;

    // The array IS bounded …
    expect(body.reviews.length).toBe(body.reviewsPageSize);
    expect(body.reviewsPageSize).toBeLessThan(REVIEW_COUNT);
    // … and the response discloses the truncation instead of hiding it.
    expect(body.reviewsTotal).toBe(REVIEW_COUNT);
    expect(body.host.reviewCount).toBe(REVIEW_COUNT); // the two totals never disagree
    expect(body.reviewsTotal).toBeGreaterThan(body.reviews.length);

    // No review is unreachable from the detail payload: the documented pager returns the
    // remainder, and preview ∪ page 2 covers every approved review exactly once.
    const pageSize = body.reviewsPageSize;
    const page2 = await support.get(
      app,
      `/api/hosts/${busyHost.id}/reviews?page=2&pageSize=${pageSize}`,
      viewerCookie
    );
    expect(page2.status).toBe(200);
    expect(page2.body.total).toBe(REVIEW_COUNT);
    expect(page2.body.reviews.length).toBe(REVIEW_COUNT - pageSize);
    const ids = new Set([...body.reviews.map((r) => r.id), ...page2.body.reviews.map((r) => r.id)]);
    expect(ids.size).toBe(REVIEW_COUNT);
  });
});

describe('TC-02 / FR-02 — moderation visibility (FR-08/AB-01)', () => {
  let pendingListing;
  let rejectedListing;

  beforeAll(async () => {
    pendingListing = await dbh.makeListing({
      host_id: host.id,
      moderation_status: 'pending',
      status: 'active',
    });
    rejectedListing = await dbh.makeListing({
      host_id: host.id,
      moderation_status: 'rejected',
      status: 'active',
    });
  });

  test('a pending listing is 404 to any other user', async () => {
    const res = await detail(pendingListing.id, viewerCookie);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  test('a rejected listing is 404 to any other user', async () => {
    const res = await detail(rejectedListing.id, viewerCookie);
    expect(res.status).toBe(404);
  });

  test('the owning host sees their own pending listing WITH its moderation status', async () => {
    const res = await detail(pendingListing.id, hostCookie);
    expect(res.status).toBe(200);
    expect(res.body.listing.id).toBe(pendingListing.id);
    expect(res.body.listing.moderationStatus).toBe('pending');
  });

  test('the owning host sees their own rejected listing with its moderation status', async () => {
    const res = await detail(rejectedListing.id, hostCookie);
    expect(res.status).toBe(200);
    expect(res.body.listing.moderationStatus).toBe('rejected');
  });
});

describe('TC-02 / FR-02 — NFR-13 + ADR-010 progressive disclosure', () => {
  test('the public payload carries EXACTLY the public allowlist keys plus no email/phone/street address', async () => {
    const res = await detail(listing.id, viewerCookie);
    expect(res.status).toBe(200);
    // Strip the FR-02 detail-only context (host summary + labelled review preview) by the
    // serializer's own constant rather than a hardcoded pair, so this assertion keeps
    // measuring "the listing projection is exactly PUBLIC_KEYS" as the context set evolves.
    const keys = Object.keys(res.body.listing).filter(
      (k) => !serializers.DETAIL_CONTEXT_KEYS.includes(k)
    );
    expect(keys.sort()).toEqual([...serializers.PUBLIC_KEYS].sort());
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(STREET);
    expect(raw).not.toContain(String(PRECISE.lat));
    expect(raw).not.toContain(String(PRECISE.lng));
    expect(raw).not.toContain('92109');
    expect(raw).not.toMatch(support.EMAIL_SHAPE);
    expect(raw).not.toContain(host.email);
  });

  test('a guest with a PENDING booking on the listing receives the exact address and precise coordinates', async () => {
    const guest = await dbh.makeUser();
    await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id, status: 'pending' });
    const res = await detail(listing.id, await support.cookieFor(guest));
    expect(res.status).toBe(200);
    expect(res.body.listing.addressLine1).toBe(STREET);
    expect(res.body.listing.lat).toBe(PRECISE.lat);
    expect(res.body.listing.lng).toBe(PRECISE.lng);
  });

  test('a guest with an IN-PROGRESS booking receives the precise projection', async () => {
    const guest = await dbh.makeUser();
    await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id, status: 'in_progress' });
    const res = await detail(listing.id, await support.cookieFor(guest));
    expect(res.status).toBe(200);
    expect(res.body.listing.addressLine1).toBe(STREET);
  });

  test('a guest whose booking was CANCELLED reverts to the public projection', async () => {
    const guest = await dbh.makeUser();
    await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id, status: 'cancelled' });
    const res = await detail(listing.id, await support.cookieFor(guest));
    expect(res.status).toBe(200);
    expect(res.body.listing.addressLine1).toBeUndefined();
    expect(res.body.listing.lat).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(STREET);
  });

  test('a guest whose booking is COMPLETED reverts to the public projection', async () => {
    const guest = await dbh.makeUser();
    await dbh.makeBooking({
      listing_id: listing.id,
      guest_id: guest.id,
      status: 'completed',
      host_confirmed_completion: true,
      guest_confirmed_completion: true,
    });
    const res = await detail(listing.id, await support.cookieFor(guest));
    expect(res.status).toBe(200);
    expect(res.body.listing.addressLine1).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(STREET);
  });

  test('the owning host receives the precise projection of their own listing', async () => {
    const res = await detail(listing.id, hostCookie);
    expect(res.status).toBe(200);
    expect(res.body.listing.addressLine1).toBe(STREET);
    expect(res.body.listing.lat).toBe(PRECISE.lat);
  });

  test('a moderator WITHOUT a safety alert on the listing gets the public projection only', async () => {
    const moderator = await dbh.makeUser({ roles: ['user', 'moderator'] });
    const res = await detail(listing.id, await support.cookieFor(moderator, ['user', 'moderator']));
    expect(res.status).toBe(200);
    expect(res.body.listing.addressLine1).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(STREET);
  });

  test('a moderator handling an FR-07 safety alert receives the precise projection AND an access_log row is written', async () => {
    const alertGuest = await dbh.makeUser();
    const alertBooking = await dbh.makeBooking({
      listing_id: listing.id,
      guest_id: alertGuest.id,
      status: 'in_progress',
    });
    await dbh.insertRow('safety_alerts', { booking_id: alertBooking.id, raised_by: alertGuest.id });

    const moderator = await dbh.makeUser({ roles: ['user', 'moderator'] });
    const before = await dbh.query(
      `SELECT count(*)::int AS n FROM access_log WHERE actor_user_id = $1`,
      [moderator.id]
    );
    const res = await detail(listing.id, await support.cookieFor(moderator, ['user', 'moderator']));
    expect(res.status).toBe(200);
    expect(res.body.listing.addressLine1).toBe(STREET);
    expect(res.body.listing.lat).toBe(PRECISE.lat);

    const after = await dbh.query(
      `SELECT actor_user_id, subject_user_id, purpose, resource
         FROM access_log WHERE actor_user_id = $1`,
      [moderator.id]
    );
    expect(after.rows.length).toBe(before.rows[0].n + 1);
    expect(after.rows[after.rows.length - 1]).toMatchObject({
      actor_user_id: moderator.id,
      subject_user_id: host.id,
      purpose: 'fr07_safety_alert',
      resource: `listing:${listing.id}`,
    });
  });

  test('unauthenticated detail read is refused with 401 (AB-08)', async () => {
    const res = await request(app).get(`/api/listings/${listing.id}`);
    expect(res.status).toBe(401);
  });

  test('an unknown listing id is a structured JSON 404', async () => {
    const res = await detail('00000000-0000-4000-8000-000000000000', viewerCookie);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
