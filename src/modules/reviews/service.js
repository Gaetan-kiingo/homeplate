// src/modules/reviews/service.js — U4-REVIEWS: the FR-05 mutual-review service (SPMP WA-4).
//
// Requirement traceability (SRS Appendix B):
//   FR-05 (TC-05) — createReview() runs ONE PostgreSQL transaction: participant/state check
//                   (completed bookings only — 409 otherwise; 403 non-participant) → reviews
//                   INSERT (guest reviews the host, host reviews the guest; a second review
//                   by the same author on the same booking is the constraint-backed 409) →
//                   'moderation.scan' outbox row via the published U4-MODERATION interface →
//                   photo attachments through the EXISTING media module (entity_type
//                   'review', ADR-004 keys) — all on the same client, so a review can never
//                   exist without its scan job and never keeps photos of a rolled-back
//                   review (ADR-001/003 "no dual writes").
//   FR-08 / AB-01 / AB-04 — a created review is born moderation_status='pending' (0001
//                   default, asserted below) and this module contains NO publish path: every
//                   public read of reviews flows through the wave-3 approved-only queries
//                   (hosts repo / listings detail), so an abusive or fake review meets the
//                   ADR-002 pipeline before any reader — never published unreviewed.
//   AB-08         — imageKeys must sit inside the caller's own server-issued upload
//                   namespace (review/<userId>/…, the same rule POST /api/media enforces),
//                   so a review can never capture someone else's uploaded object.
//   NFR-08 (MT-01) — every mutation (success AND refusal) writes one structured audit
//                   record through the request-scoped logger: actor + booking/review IDs
//                   and reason codes only — never the review text, never PII.
//   NFR-11 / AB-06 — all HTTP input is validated by src/schemas/reviews.js at the routes;
//                   this service only ever sees sanitized, bounded, typed values.
//
// Request-path-safe (ADR-001/003): this module imports NO adapter and no transport — only
// the db layer, the wave-3 bookings/media layers and the U4-MODERATION service (whose
// submitForReview is a pure outbox write; its LLM stage runs exclusively in the worker).
'use strict';

const { withTransaction } = require('../../db/tx');
const { ConflictError, ForbiddenError, NotFoundError } = require('../../lib/errors');
const { logger, audit } = require('../../lib/logger');
const bookingsRepo = require('../bookings/repo');
const mediaService = require('../media/service');
const moderationService = require('../moderation/service');
const repo = require('./repo');

/** The caller's own review-photo upload namespace (mirror of the server-generated key shape
 *  `review/<userId>/<uuid>.<ext>` from mediaUrls.createUploadTarget — AB-08). */
function ownReviewPrefix(userId) {
  return `review/${String(userId).toLowerCase()}/`;
}

/** Explicit-allowlist projection of a review for the create response (NFR-13/AB-08 — never
 *  a row spread; IDs, the caller's own sanitized text and lifecycle state only). */
function serializeReview(row, media = []) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    authorId: row.author_id,
    targetUserId: row.target_user_id,
    rating: Number(row.rating),
    comment: row.body,
    moderationStatus: row.moderation_status,
    createdAt: row.created_at,
    imageKeys: media.map((m) => m.storageKey),
  };
}

/**
 * Create one review of a completed booking (FR-05): the guest about the host, or the host
 * about the guest. Born 'pending'; published only by an ADR-002 moderation approval.
 *
 * @param {string} userId     authenticated caller (routes.js requires a session)
 * @param {string} bookingId  the completed booking under review
 * @param {{rating: number, comment: string, imageKeys?: string[]}} input  validated body
 * @param {{log?: object}} [ctx]  request-scoped logger (correlation ID — NFR-08)
 * @returns {Promise<object>} the serialized review (201 body), moderationStatus 'pending'
 * @throws {NotFoundError} unknown booking (404)
 * @throws {ForbiddenError} caller is neither the guest nor the listing's host (403), or an
 *         imageKey outside the caller's own namespace (403 MEDIA_KEY_FORBIDDEN)
 * @throws {ConflictError} booking not completed (409 BOOKING_NOT_COMPLETED) or a second
 *         review by the same author on the same booking (409 REVIEW_EXISTS)
 */
async function createReview(userId, bookingId, { rating, comment, imageKeys = [] } = {}, ctx = {}) {
  const log = ctx.log || logger;

  const refuse = (err, reason) => {
    audit(log, {
      event: 'review.created',
      outcome: 'failure',
      actorUserId: userId,
      entityType: 'booking',
      entityId: bookingId,
      reason,
    });
    return err;
  };

  // AB-08: only keys under the caller's own server-issued namespace are attachable — the
  // same wall POST /api/media builds, enforced BEFORE any row is written.
  const prefix = ownReviewPrefix(userId);
  for (const key of imageKeys) {
    if (!key.startsWith(prefix)) {
      throw refuse(
        new ForbiddenError('imageKeys must be inside your own upload namespace', {
          code: 'MEDIA_KEY_FORBIDDEN',
        }),
        'MEDIA_KEY_FORBIDDEN'
      );
    }
  }

  let created;
  try {
    created = await withTransaction(async (client) => {
      // The wave-3 published contract (build-plan §3): booking + caller relationship.
      const found = await bookingsRepo.findParticipantBooking(bookingId, userId, client);
      if (!found) {
        throw refuse(
          new NotFoundError('Booking not found', { code: 'BOOKING_NOT_FOUND' }),
          'BOOKING_NOT_FOUND'
        );
      }
      if (found.role === null) {
        throw refuse(
          new ForbiddenError('Only the guest or the host may review this booking.', {
            code: 'NOT_PARTICIPANT',
          }),
          'NOT_PARTICIPANT'
        );
      }
      if (found.booking.status !== 'completed') {
        throw refuse(
          new ConflictError('Reviews are allowed on completed bookings only.', {
            code: 'BOOKING_NOT_COMPLETED',
            details: { status: found.booking.status },
          }),
          'BOOKING_NOT_COMPLETED'
        );
      }

      // FR-05 direction: the guest reviews the host, the host reviews the guest.
      const targetUserId = found.role === 'guest' ? found.listing.host_id : found.booking.guest_id;

      const review = await repo.insertReview(client, {
        bookingId,
        authorId: userId,
        targetUserId,
        rating,
        body: comment,
      });

      // Review row + its FR-08 scan job, SAME transaction (ADR-001/003 — no dual writes;
      // payload carries IDs only, enforced by outbox.assertIdOnlyPayload).
      await moderationService.submitForReview(client, 'review', review.id);

      // FR-05 "including photos": attach each minted key through the EXISTING media module
      // (adapter-free on this path — ADR-001/003), on the same client so photos of a
      // rolled-back review never persist.
      const media = [];
      for (const key of imageKeys) {
        media.push(
          await mediaService.attach(userId, key, 'review', { entityId: review.id, client })
        );
      }

      return { review, media, role: found.role, targetUserId };
    });
  } catch (err) {
    if (err && err.code === '23505' && err.constraint === 'reviews_one_per_booking_author') {
      // Constraint-backed duplicate (FR-05 acceptance): at most two reviews per booking,
      // one per direction — atomic under concurrency, never a read-then-write race.
      throw refuse(
        new ConflictError('You have already reviewed this booking.', {
          code: 'REVIEW_EXISTS',
          cause: err,
        }),
        'REVIEW_EXISTS'
      );
    }
    throw err;
  }

  audit(log, {
    event: 'review.created',
    outcome: 'success',
    actorUserId: userId,
    entityType: 'review',
    entityId: created.review.id,
    bookingId,
    targetUserId: created.targetUserId,
    role: created.role,
    imageCount: created.media.length,
  });
  return serializeReview(created.review, created.media);
}

module.exports = {
  createReview,
  // exported for the unit tests that pin the NFR-13 allowlist and the AB-08 namespace rule
  serializeReview,
  ownReviewPrefix,
};
