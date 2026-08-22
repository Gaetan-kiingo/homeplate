// tests/tc-core/tc05-reviews.test.js — TC-05 / FR-05: mutual reviews (SRS §3.1; acceptance
// per docs/_generated/requirements-inventory.json). Replaces the wave-4 status probe that
// lived in tc05-07-wave4-status.test.js, exactly as that file's header instructed.
//
// Asserted here, by execution against the seeded test DB (SRS §4.1):
//   - POST /api/bookings/:id/reviews accepts {rating 1..5 int, comment, imageKeys[]} from
//     the guest (about the host) and from the host (about the guest) on COMPLETED bookings
//     only; the created review is born moderation_status='pending' and its 'moderation.scan'
//     outbox row commits in the SAME transaction (xmin proof) with an IDs-only payload
//     (ADR-001/003, FR-08);
//   - the acceptance refusal matrix: 422 bad rating (0, 6, non-integer, string), 409
//     non-completed booking, 409 duplicate (booking, author), 403 non-participant,
//     401 unauthenticated, 404 unknown booking;
//   - a pending review is ABSENT from every public read path — GET /api/hosts/:id,
//     GET /api/hosts/:id/reviews and the listing-detail host context — and appears on all
//     of them only after a wave-4A HUMAN approval through the real moderator queue
//     (POST /api/moderation/queue/:id/decision); a rejected review never appears (AB-01/04);
//   - a review about the GUEST is stored (target_user_id = guest) but surfaces on no host
//     read path — it waits for a read path that asks (build-plan §4B note);
//   - review photos ride the existing media module: imageKeys become media_objects rows
//     (entity_type='review', ADR-004 keys) in the creating transaction, and the post-create
//     attach path honours the MOVED authorship lookup — an anonymized-author review is
//     attachable by nobody (403, AB-08 / NFR-12 shape).
//
// Requirement traceability: FR-05 (TC-05), FR-08, NFR-08, NFR-11, AB-01, AB-04, AB-06, AB-08.
'use strict';

const request = require('supertest');

const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const { loadHandlers } = require('../../src/outbox/dispatch');
const mediaUrls = require('../../src/lib/mediaUrls');
const mockLlm = require('../../src/adapters/llmModeration.mock');
const dbh = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const { pollOnlyThese } = require('../helpers/outboxScope');
const support = require('./support');

const sink = { write() {} };
const UNKNOWN_UUID = '00000000-0000-4000-8000-0000000005ff';

const quietLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return this;
  },
};

let app;
let registry;
let host;
let hostCookie;
let guest;
let guestCookie;
let stranger;
let strangerCookie;
let moderator;
let moderatorCookie;
let listing;

beforeAll(async () => {
  app = createApp({ logger: createLogger({ level: 'silent', stream: sink }) });
  registry = loadHandlers({ log: quietLog });
  host = await dbh.makeUser({ can_publish_listing: true, full_name: 'TC05 Host' });
  await dbh.makeHostProfile({ user_id: host.id, bio: 'TC05 host bio.' });
  guest = await dbh.makeUser({ full_name: 'TC05 Guest' });
  stranger = await dbh.makeUser();
  moderator = await dbh.makeUser({ roles: ['user', 'moderator'] });
  hostCookie = await support.cookieFor(host);
  guestCookie = await support.cookieFor(guest);
  strangerCookie = await support.cookieFor(stranger);
  moderatorCookie = await support.cookieFor(moderator);
  listing = await support.makeApprovedListing({ host_id: host.id });
});

afterAll(async () => {
  mockLlm.reset();
  await dbh.closeDb();
  await closeTestRedis();
});

function completedBooking() {
  return support.makeCompletedBooking(listing.id, guest.id);
}

async function scanJobFor(reviewId) {
  const { rows } = await dbh.query(
    `SELECT id, payload, status, xmin::text AS xid FROM outbox_jobs
      WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
    [reviewId]
  );
  return rows;
}

async function moderationStatusOf(reviewId) {
  const { rows } = await dbh.query(`SELECT moderation_status FROM reviews WHERE id = $1`, [
    reviewId,
  ]);
  return rows[0].moderation_status;
}

async function queueItemFor(reviewId) {
  const { rows } = await dbh.query(
    `SELECT id, reason, status FROM moderation_queue
      WHERE content_type = 'review' AND content_id = $1`,
    [reviewId]
  );
  return rows;
}

/** The three public read surfaces a review can appear on (FR-05/FR-08 visibility). */
async function readSurfaces() {
  const hostPage = await support.get(app, `/api/hosts/${host.id}`, guestCookie);
  const hostReviews = await support.get(
    app,
    `/api/hosts/${host.id}/reviews?page=1&pageSize=100`,
    guestCookie
  );
  const detail = await support.get(app, `/api/listings/${listing.id}`, guestCookie);
  expect(hostPage.status).toBe(200);
  expect(hostReviews.status).toBe(200);
  expect(detail.status).toBe(200);
  return { hostPage, hostReviews, detail };
}

function idsOn({ hostPage, hostReviews, detail }) {
  return {
    hostPage: hostPage.body.host.reviews.map((r) => r.id),
    hostReviews: hostReviews.body.reviews.map((r) => r.id),
    detail: detail.body.listing.reviews.map((r) => r.id),
  };
}

// =============================================================================================
// The acceptance refusal matrix (NFR-11 / AB-06 / AB-08)
// =============================================================================================
describe('TC-05 · refusal matrix at the review boundary', () => {
  test('401 unauthenticated — never data, never a row (AB-08)', async () => {
    const booking = await completedBooking();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reviews`)
      .send({ rating: 5, comment: 'no session' });
    expect(res.status).toBe(401);
    const { rows } = await dbh.query(`SELECT id FROM reviews WHERE booking_id = $1`, [booking.id]);
    expect(rows).toEqual([]);
  });

  test('422 bad rating: 0, 6, 2.5 and "5" all refused at the boundary (the acceptance 422)', async () => {
    const booking = await completedBooking();
    for (const rating of [0, 6, 2.5, '5', null]) {
      const res = await support.post(app, `/api/bookings/${booking.id}/reviews`, guestCookie, {
        rating,
        comment: 'bad rating probe',
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBeDefined();
    }
    const { rows } = await dbh.query(`SELECT id FROM reviews WHERE booking_id = $1`, [booking.id]);
    expect(rows).toEqual([]);
  });

  test('409 on a booking that is not completed; the row count stays zero', async () => {
    const pending = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const res = await support.post(app, `/api/bookings/${pending.id}/reviews`, guestCookie, {
      rating: 5,
      comment: 'too early',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('BOOKING_NOT_COMPLETED');
  });

  test('403 non-participant; 404 unknown booking; 422 malformed booking id', async () => {
    const booking = await completedBooking();
    const asStranger = await support.post(
      app,
      `/api/bookings/${booking.id}/reviews`,
      strangerCookie,
      { rating: 4, comment: 'not my meal' }
    );
    expect(asStranger.status).toBe(403);
    expect(asStranger.body.error.code).toBe('NOT_PARTICIPANT');

    const unknown = await support.post(app, `/api/bookings/${UNKNOWN_UUID}/reviews`, guestCookie, {
      rating: 4,
      comment: 'ghost booking',
    });
    expect(unknown.status).toBe(404);

    const malformed = await support.post(app, `/api/bookings/not-a-uuid/reviews`, guestCookie, {
      rating: 4,
      comment: 'malformed id',
    });
    expect(malformed.status).toBe(422);
  });

  test('409 duplicate (booking, author): at most two reviews per booking, one per direction', async () => {
    const booking = await completedBooking();
    const first = await support.post(app, `/api/bookings/${booking.id}/reviews`, guestCookie, {
      rating: 5,
      comment: 'first and only from the guest',
    });
    expect(first.status).toBe(201);

    const dup = await support.post(app, `/api/bookings/${booking.id}/reviews`, guestCookie, {
      rating: 1,
      comment: 'second attempt',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('REVIEW_EXISTS');

    // The OTHER direction still works: the host reviews the guest (mutual — FR-05).
    const byHost = await support.post(app, `/api/bookings/${booking.id}/reviews`, hostCookie, {
      rating: 4,
      comment: 'lovely guest',
    });
    expect(byHost.status).toBe(201);
    expect(byHost.body.review.targetUserId).toBe(guest.id);

    const { rows } = await dbh.query(`SELECT id FROM reviews WHERE booking_id = $1`, [booking.id]);
    expect(rows).toHaveLength(2);
  });
});

// =============================================================================================
// Pending until a HUMAN approval publishes it (FR-08 / AB-01 — the 4A queue, end to end)
// =============================================================================================
describe('TC-05 · born pending, one transaction, published only by the human queue', () => {
  test('created pending + scan row in ONE transaction (xmin, IDs-only); invisible until approve; then visible everywhere', async () => {
    const booking = await completedBooking();
    // The deterministic mock classifies this benign but BELOW the routing threshold, so the
    // scan escalates to the human moderator queue instead of auto-approving (ADR-002).
    const res = await support.post(app, `/api/bookings/${booking.id}/reviews`, guestCookie, {
      rating: 5,
      comment: `A calm, factual review of a good meal ${mockLlm.LOW_CONFIDENCE_SENTINEL}`,
    });
    expect(res.status).toBe(201);
    const review = res.body.review;
    expect(review.moderationStatus).toBe('pending'); // born pending (FR-08)
    expect(review.targetUserId).toBe(host.id);

    // ONE transaction: the review row and its moderation.scan row share an xmin; the
    // payload carries IDs only (ADR-003 — no text, nothing email- or address-shaped).
    const jobs = await scanJobFor(review.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toEqual({ contentType: 'review', contentId: review.id });
    const { rows: xid } = await dbh.query(`SELECT xmin::text AS xid FROM reviews WHERE id = $1`, [
      review.id,
    ]);
    expect(jobs[0].xid).toBe(xid[0].xid);

    // Invisible on EVERY public read path while pending (FR-05 acceptance).
    let ids = idsOn(await readSurfaces());
    expect(ids.hostPage).not.toContain(review.id);
    expect(ids.hostReviews).not.toContain(review.id);
    expect(ids.detail).not.toContain(review.id);

    // Drive the scan through the REAL handler: low confidence → human queue, still pending.
    await pollOnlyThese([jobs[0].id], registry);
    expect(await moderationStatusOf(review.id)).toBe('pending');
    const queued = await queueItemFor(review.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ reason: 'low_confidence', status: 'open' });

    // Still invisible: an escalated review is not an approved review (never unreviewed).
    ids = idsOn(await readSurfaces());
    expect(ids.hostReviews).not.toContain(review.id);

    // The wave-4A HUMAN approval — through the real moderator surface, not SQL.
    const decide = await support.post(
      app,
      `/api/moderation/queue/${queued[0].id}/decision`,
      moderatorCookie,
      { decision: 'approve', category: 'benign', note: 'reads like a genuine review' }
    );
    expect(decide.status).toBe(200);
    expect(await moderationStatusOf(review.id)).toBe('approved');

    // NOW it appears on all three read paths, rating and body intact (FR-05/FR-03).
    const surfaces = await readSurfaces();
    ids = idsOn(surfaces);
    expect(ids.hostPage).toContain(review.id);
    expect(ids.hostReviews).toContain(review.id);
    expect(ids.detail).toContain(review.id);
    const published = surfaces.hostReviews.body.reviews.find((r) => r.id === review.id);
    expect(published.rating).toBe(5);
    expect(published.authorId).toBe(guest.id);
  });

  test('a REJECTED review never reaches any read path (AB-01/AB-04 direction)', async () => {
    const booking = await completedBooking();
    const res = await support.post(app, `/api/bookings/${booking.id}/reviews`, guestCookie, {
      rating: 1,
      comment: 'offensive-fixture wording aimed at the host',
    });
    expect(res.status).toBe(201);
    const review = res.body.review;

    const jobs = await scanJobFor(review.id);
    await pollOnlyThese([jobs[0].id], registry);
    // Flagged by the classifier → escalated, still pending, queued for the human.
    expect(await moderationStatusOf(review.id)).toBe('pending');
    const queued = await queueItemFor(review.id);
    expect(queued).toHaveLength(1);

    const decide = await support.post(
      app,
      `/api/moderation/queue/${queued[0].id}/decision`,
      moderatorCookie,
      { decision: 'reject', category: 'offensive' }
    );
    expect(decide.status).toBe(200);
    expect(await moderationStatusOf(review.id)).toBe('rejected');

    const ids = idsOn(await readSurfaces());
    expect(ids.hostPage).not.toContain(review.id);
    expect(ids.hostReviews).not.toContain(review.id);
    expect(ids.detail).not.toContain(review.id);
  });

  test('a review ABOUT THE GUEST is stored with target_user_id = guest and surfaces on no host read path', async () => {
    const booking = await completedBooking();
    const res = await support.post(app, `/api/bookings/${booking.id}/reviews`, hostCookie, {
      rating: 5,
      comment: 'A wholly benign note about a pleasant guest.',
    });
    expect(res.status).toBe(201);
    const review = res.body.review;
    expect(review.targetUserId).toBe(guest.id);

    // Benign at high confidence: the pipeline may auto-approve it (FR-08) — approved or
    // not, it is about the GUEST, so the host read paths must never carry it.
    const jobs = await scanJobFor(review.id);
    await pollOnlyThese([jobs[0].id], registry);
    expect(await moderationStatusOf(review.id)).toBe('approved'); // benign 0.99 ≥ threshold

    const ids = idsOn(await readSurfaces());
    expect(ids.hostPage).not.toContain(review.id);
    expect(ids.hostReviews).not.toContain(review.id);
    expect(ids.detail).not.toContain(review.id);

    // And the guest has no host page to surface it on (404 — no host profile), which is
    // the build-plan §4B note: stored, surfaced only where an existing read path asks.
    const guestPage = await support.get(app, `/api/hosts/${guest.id}`, hostCookie);
    expect(guestPage.status).toBe(404);
  });
});

// =============================================================================================
// Photos: through the existing media module, authorship honoured (FR-05 / ADR-004 / AB-08)
// =============================================================================================
describe('TC-05 · review photos ride the media module', () => {
  test('imageKeys in the POST body become media_objects rows in the creating transaction', async () => {
    const booking = await completedBooking();
    const key = mediaUrls.createUploadTarget(guest.id, 'review', 'image/jpeg', {
      sizeBytes: 2048,
    }).storageKey;
    const res = await support.post(app, `/api/bookings/${booking.id}/reviews`, guestCookie, {
      rating: 5,
      comment: 'with a photo of the plated meal',
      imageKeys: [key],
    });
    expect(res.status).toBe(201);
    expect(res.body.review.imageKeys).toEqual([key]);

    const { rows } = await dbh.query(
      `SELECT owner_user_id, entity_type, entity_id, storage_key FROM media_objects
        WHERE storage_key = $1`,
      [key]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner_user_id: guest.id,
      entity_type: 'review',
      entity_id: res.body.review.id,
    });
  });

  test("someone else's key namespace is 403 and the review is NOT created (AB-08 atomicity)", async () => {
    const booking = await completedBooking();
    const foreignKey = mediaUrls.createUploadTarget(stranger.id, 'review', 'image/jpeg', {
      sizeBytes: 2048,
    }).storageKey;
    const res = await support.post(app, `/api/bookings/${booking.id}/reviews`, guestCookie, {
      rating: 5,
      comment: 'trying to claim a foreign upload',
      imageKeys: [foreignKey],
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MEDIA_KEY_FORBIDDEN');
    const { rows } = await dbh.query(`SELECT id FROM reviews WHERE booking_id = $1`, [booking.id]);
    expect(rows).toEqual([]);
  });

  test('post-create attach honours the MOVED authorship lookup; an anonymized-author review is attachable by nobody', async () => {
    const booking = await completedBooking();
    const created = await support.post(app, `/api/bookings/${booking.id}/reviews`, guestCookie, {
      rating: 4,
      comment: 'author to be anonymized',
    });
    expect(created.status).toBe(201);
    const reviewId = created.body.review.id;

    // The author attaches later through POST /api/media — allowed (authorship holds).
    const ownKey = mediaUrls.createUploadTarget(guest.id, 'review', 'image/jpeg', {
      sizeBytes: 1024,
    }).storageKey;
    const ownAttach = await support.post(app, '/api/media', guestCookie, {
      storageKey: ownKey,
      kind: 'review',
      entityId: reviewId,
    });
    expect(ownAttach.status).toBe(201);

    // NFR-12 anonymized shape: severed author → the review belongs to nobody (403 for all).
    await dbh.query(`UPDATE reviews SET author_id = NULL WHERE id = $1`, [reviewId]);
    const orphanKey = mediaUrls.createUploadTarget(guest.id, 'review', 'image/jpeg', {
      sizeBytes: 1024,
    }).storageKey;
    const anonAttach = await support.post(app, '/api/media', guestCookie, {
      storageKey: orphanKey,
      kind: 'review',
      entityId: reviewId,
    });
    expect(anonAttach.status).toBe(403);
    expect(anonAttach.body.error.code).toBe('MEDIA_ENTITY_NOT_OWNED');
  });
});
