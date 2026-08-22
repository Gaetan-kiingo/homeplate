// tests/unit/reviews.test.js — U4-REVIEWS implementer tests: the FR-05 review service,
// repository and schema — completed-bookings-only gate, participant gate, the constraint-
// backed duplicate 409, ONE-transaction persistence (review row + moderation.scan outbox row
// + photo attachments, xmin-proven), the ADR-003 IDs-only payload, the AB-08 imageKey
// namespace wall, the NFR-13 response allowlist, the NFR-08 audit records, and the
// findReviewAuthorId takeover from the media repo (published interface + delegation).
//
// The HTTP acceptance lives in tests/tc-core/tc05-reviews.test.js (canonical TC-05).
'use strict';

const crypto = require('crypto');

const { query, makeUser, makeListing, makeBooking, closeDb } = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const { ForbiddenError, NotFoundError } = require('../../src/lib/errors');
const service = require('../../src/modules/reviews/service');
const reviewsRepo = require('../../src/modules/reviews/repo');
const mediaRepo = require('../../src/modules/media/repo');
const reviewSchemas = require('../../src/schemas/reviews');

const UNKNOWN_UUID = '00000000-0000-4000-8000-00000000ff05';

let host;
let guest;
let stranger;
let listing;

beforeAll(async () => {
  host = await makeUser({ can_publish_listing: true });
  guest = await makeUser();
  stranger = await makeUser();
  listing = await makeListing({ host_id: host.id, moderation_status: 'approved' });
});

afterAll(async () => {
  await closeDb();
  await closeTestRedis();
});

/** A completed booking on the shared listing (0001 CHECK: both confirmation flags). */
async function completedBooking(overrides = {}) {
  return makeBooking({
    listing_id: listing.id,
    guest_id: guest.id,
    status: 'completed',
    host_confirmed_completion: true,
    guest_confirmed_completion: true,
    ...overrides,
  });
}

async function reviewRows(bookingId) {
  const { rows } = await query(
    `SELECT * FROM reviews WHERE booking_id = $1 ORDER BY created_at, id`,
    [bookingId]
  );
  return rows;
}

async function scanJobsFor(reviewId) {
  const { rows } = await query(
    `SELECT id, type, payload, status, xmin::text AS xid FROM outbox_jobs
      WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
    [reviewId]
  );
  return rows;
}

/** A caller-namespaced review storage key of the exact server-minted shape (AB-08). */
function mintKey(userId) {
  return `review/${String(userId).toLowerCase()}/${crypto.randomUUID()}.jpg`;
}

/** Capturing logger for NFR-08 audit assertions (audit() writes through log.info). */
function captureLog() {
  const records = [];
  return {
    records,
    info: (fields) => records.push(fields),
    warn: () => {},
    error: () => {},
    child() {
      return this;
    },
  };
}

// ---- createReview: the FR-05 happy paths -----------------------------------------------------

describe('service.createReview — FR-05 persistence, direction and the one-transaction proof', () => {
  test('the guest reviews the host: born pending, scan row in the SAME transaction, IDs-only payload', async () => {
    const booking = await completedBooking();
    const log = captureLog();
    const review = await service.createReview(
      guest.id,
      booking.id,
      { rating: 5, comment: 'Wonderful dinner, kind host.' },
      { log }
    );

    // NFR-13 allowlist: exactly these keys, nothing else (no address, no email, no spread).
    expect(Object.keys(review).sort()).toEqual(
      [
        'id',
        'bookingId',
        'authorId',
        'targetUserId',
        'rating',
        'comment',
        'moderationStatus',
        'createdAt',
        'imageKeys',
      ].sort()
    );
    expect(review).toMatchObject({
      bookingId: booking.id,
      authorId: guest.id,
      targetUserId: host.id, // FR-05 direction: guest → host
      rating: 5,
      moderationStatus: 'pending', // FR-08: born pending, never published unreviewed
      imageKeys: [],
    });

    const rows = await reviewRows(booking.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].moderation_status).toBe('pending');

    // ADR-001/003 one-transaction proof: review row and scan row share ONE xmin.
    const jobs = await scanJobsFor(review.id);
    expect(jobs).toHaveLength(1);
    expect(Object.keys(jobs[0].payload).sort()).toEqual(['contentId', 'contentType']); // IDs only
    expect(jobs[0].payload).toEqual({ contentType: 'review', contentId: review.id });
    const { rows: reviewXid } = await query(`SELECT xmin::text AS xid FROM reviews WHERE id = $1`, [
      review.id,
    ]);
    expect(jobs[0].xid).toBe(reviewXid[0].xid);

    // NFR-08: one success audit record with IDs only — never the review text.
    const audits = log.records.filter((r) => r.audit === true && r.event === 'review.created');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      outcome: 'success',
      actorUserId: guest.id,
      entityType: 'review',
      entityId: review.id,
      bookingId: booking.id,
      targetUserId: host.id,
    });
    expect(JSON.stringify(audits[0])).not.toContain('Wonderful dinner');
  });

  test('the host reviews the guest on the same booking (two per booking, one per direction)', async () => {
    const booking = await completedBooking();
    await service.createReview(guest.id, booking.id, { rating: 4, comment: 'Great host.' });
    const byHost = await service.createReview(host.id, booking.id, {
      rating: 3,
      comment: 'Pleasant guest, would host again.',
    });
    expect(byHost).toMatchObject({
      authorId: host.id,
      targetUserId: guest.id, // FR-05 direction: host → guest
      moderationStatus: 'pending',
    });
    expect(await reviewRows(booking.id)).toHaveLength(2);
  });

  test('imageKeys attach through the media module in the SAME transaction (FR-05 photos, ADR-004)', async () => {
    const booking = await completedBooking();
    const keys = [mintKey(guest.id), mintKey(guest.id)];
    const review = await service.createReview(guest.id, booking.id, {
      rating: 5,
      comment: 'Photo-backed review.',
      imageKeys: keys,
    });
    expect(review.imageKeys).toEqual(keys);

    const { rows: media } = await query(
      `SELECT owner_user_id, entity_type, entity_id, storage_key, deleted_at, xmin::text AS xid
         FROM media_objects WHERE entity_id = $1 ORDER BY created_at, id`,
      [review.id]
    );
    expect(media).toHaveLength(2);
    for (const m of media) {
      expect(m).toMatchObject({
        owner_user_id: guest.id,
        entity_type: 'review',
        entity_id: review.id,
        deleted_at: null,
      });
    }
    // Same inserting transaction as the review row itself (no dual writes).
    const { rows: reviewXid } = await query(`SELECT xmin::text AS xid FROM reviews WHERE id = $1`, [
      review.id,
    ]);
    expect(new Set(media.map((m) => m.xid))).toEqual(new Set([reviewXid[0].xid]));
  });
});

// ---- createReview: the refusal matrix --------------------------------------------------------

describe('service.createReview — refusals write nothing and audit the reason (NFR-08)', () => {
  test('a booking that is not completed is a 409-shaped ConflictError, per non-completed state', async () => {
    for (const status of ['pending', 'in_progress', 'cancelled']) {
      const booking = await makeBooking({
        listing_id: listing.id,
        guest_id: guest.id,
        status,
        ...(status === 'cancelled' ? { cancelled_at: new Date() } : {}),
      });
      const log = captureLog();
      await expect(
        service.createReview(guest.id, booking.id, { rating: 5, comment: 'too early' }, { log })
      ).rejects.toMatchObject({ status: 409, code: 'BOOKING_NOT_COMPLETED' });
      expect(await reviewRows(booking.id)).toEqual([]); // nothing persisted
      const audits = log.records.filter((r) => r.audit === true);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ outcome: 'failure', reason: 'BOOKING_NOT_COMPLETED' });
    }
  });

  test('a non-participant is 403 NOT_PARTICIPANT; an unknown booking is 404', async () => {
    const booking = await completedBooking();
    await expect(
      service.createReview(stranger.id, booking.id, { rating: 5, comment: 'not mine' })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.createReview(guest.id, UNKNOWN_UUID, { rating: 5, comment: 'ghost booking' })
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await reviewRows(booking.id)).toEqual([]);
  });

  test('a second review by the same author on the same booking is the constraint-backed 409', async () => {
    const booking = await completedBooking();
    await service.createReview(guest.id, booking.id, { rating: 5, comment: 'first' });
    const log = captureLog();
    await expect(
      service.createReview(guest.id, booking.id, { rating: 1, comment: 'second' }, { log })
    ).rejects.toMatchObject({ status: 409, code: 'REVIEW_EXISTS' });
    expect(await reviewRows(booking.id)).toHaveLength(1); // the duplicate left no row
    expect(log.records.filter((r) => r.audit === true)[0]).toMatchObject({
      outcome: 'failure',
      reason: 'REVIEW_EXISTS',
    });
  });

  test('an imageKey outside the caller namespace is 403 MEDIA_KEY_FORBIDDEN and nothing is written', async () => {
    const booking = await completedBooking();
    await expect(
      service.createReview(guest.id, booking.id, {
        rating: 5,
        comment: 'stolen key',
        imageKeys: [mintKey(stranger.id)], // someone else's namespace
      })
    ).rejects.toMatchObject({ status: 403, code: 'MEDIA_KEY_FORBIDDEN' });
    expect(await reviewRows(booking.id)).toEqual([]);
  });

  test('a failing photo attachment rolls the WHOLE review back — no dual writes (ADR-001)', async () => {
    const booking = await completedBooking();
    const key = mintKey(guest.id);
    // Occupy the storage key first: the in-transaction attach then raises MEDIA_KEY_EXISTS.
    await query(
      `INSERT INTO media_objects (owner_user_id, entity_type, storage_key)
       VALUES ($1, 'review', $2)`,
      [guest.id, key]
    );

    await expect(
      service.createReview(guest.id, booking.id, {
        rating: 5,
        comment: 'photo conflict',
        imageKeys: [key],
      })
    ).rejects.toMatchObject({ status: 409, code: 'MEDIA_KEY_EXISTS' });

    // Atomicity: neither the review row nor its scan job survived the rollback.
    const rows = await reviewRows(booking.id);
    expect(rows).toEqual([]);
    const { rows: jobs } = await query(
      `SELECT id FROM outbox_jobs WHERE type = 'moderation.scan' AND payload->>'contentId' IN
        (SELECT id::text FROM reviews WHERE booking_id = $1)`,
      [booking.id]
    );
    expect(jobs).toEqual([]);
  });
});

// ---- the findReviewAuthorId takeover (build-plan §4B) ----------------------------------------

describe('repo.findReviewAuthorId — the published interface the media module consumes', () => {
  test('distinguishes "no such review" (null) from "author severed" ({authorId: null})', async () => {
    expect(await reviewsRepo.findReviewAuthorId(UNKNOWN_UUID)).toBeNull();

    const booking = await completedBooking();
    const review = await service.createReview(guest.id, booking.id, {
      rating: 5,
      comment: 'authorship fixture',
    });
    expect(await reviewsRepo.findReviewAuthorId(review.id)).toEqual({ authorId: guest.id });

    // NFR-12 anonymized shape: retained review, severed author — attachable by nobody.
    await query(`UPDATE reviews SET author_id = NULL WHERE id = $1`, [review.id]);
    expect(await reviewsRepo.findReviewAuthorId(review.id)).toEqual({ authorId: null });
  });

  test('the media repo re-exports the reviews repo function UNCHANGED (takeover, not a copy)', () => {
    // One implementation, two import paths: the media route's pinned call site
    // (mediaRepo.findReviewAuthorId) resolves to the reviews module's published function.
    expect(mediaRepo.findReviewAuthorId).toBe(reviewsRepo.findReviewAuthorId);
  });
});

// ---- schema boundary (NFR-11 / AB-06 — the acceptance 422 shapes) ----------------------------

describe('schemas/reviews — the FR-05 validation boundary', () => {
  const valid = { rating: 5, comment: 'a perfectly ordinary review' };

  test('rating outside 1..5, non-integer or non-number fails (the acceptance 422)', () => {
    for (const rating of [0, 6, -1, 2.5, '5', null, undefined, Number.NaN]) {
      const parsed = reviewSchemas.createReviewBody.safeParse({ ...valid, rating });
      expect(parsed.success).toBe(false);
    }
    for (const rating of [1, 2, 3, 4, 5]) {
      expect(reviewSchemas.createReviewBody.safeParse({ ...valid, rating }).success).toBe(true);
    }
  });

  test('comment is required, bounded and sanitized — markup cannot survive (ST-04)', () => {
    expect(reviewSchemas.createReviewBody.safeParse({ rating: 5 }).success).toBe(false);
    expect(reviewSchemas.createReviewBody.safeParse({ rating: 5, comment: '' }).success).toBe(
      false
    );
    expect(
      reviewSchemas.createReviewBody.safeParse({ rating: 5, comment: 'x'.repeat(2001) }).success
    ).toBe(false);
    const xss = reviewSchemas.createReviewBody.parse({
      rating: 5,
      comment: '<script>alert(1)</script> tasty!',
    });
    expect(xss.comment).not.toContain('<');
    expect(xss.comment).not.toContain('>');
  });

  test('imageKeys must be canonical storage keys, bounded in count, defaulting to []', () => {
    expect(reviewSchemas.createReviewBody.parse(valid).imageKeys).toEqual([]);
    const good = reviewSchemas.createReviewBody.safeParse({
      ...valid,
      imageKeys: [`review/${guest.id}/a.jpg`],
    });
    expect(good.success).toBe(true);
    for (const bad of [
      ['../etc/passwd'],
      ['review/a/../../b.jpg'],
      ['/leading/slash.jpg'],
      [''],
      'not-an-array',
    ]) {
      expect(reviewSchemas.createReviewBody.safeParse({ ...valid, imageKeys: bad }).success).toBe(
        false
      );
    }
    const tooMany = Array.from(
      { length: reviewSchemas.MAX_IMAGE_KEYS + 1 },
      (_, i) => `review/${guest.id}/k${i}.jpg`
    );
    expect(reviewSchemas.createReviewBody.safeParse({ ...valid, imageKeys: tooMany }).success).toBe(
      false
    );
  });

  test('the :id path param must be a UUID', () => {
    expect(reviewSchemas.createReviewParams.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
    expect(reviewSchemas.createReviewParams.safeParse({ id: UNKNOWN_UUID }).success).toBe(true);
  });
});
