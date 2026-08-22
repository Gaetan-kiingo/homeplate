// src/modules/reviews/repo.js — U4-REVIEWS: data access for reviews (§3.4 REVIEW).
//
// Requirement traceability (SRS Appendix B):
//   FR-05 (TC-05) — insertReview() persists one review of a completed booking (rating,
//                   body, author → target direction); the 0001 schema enforces the numeric
//                   bounds (rating CHECK 1..5) and the at-most-two-per-booking rule
//                   (reviews_one_per_booking_author UNIQUE — one per author per booking),
//                   so the acceptance 409 for a duplicate is a database guarantee, not a
//                   read-then-write race.
//   FR-08 / AB-01 — a review row is born moderation_status='pending' (0001 column default;
//                   asserted by the service's returned row): nothing this repo writes is
//                   publicly readable until the ADR-002 pipeline approves it. The approved
//                   READ paths deliberately do NOT live here: hosts/repo.listApprovedReviews
//                   and getReviewStats already own them (wave 3) and keep working unchanged.
//   AB-08 / FR-05 — findReviewAuthorId() is the authorship rule behind "a photo can only be
//                   attached to a review the caller wrote" — the published interface the
//                   media module consumes (build-plan §4B). MOVED HERE from
//                   src/modules/media/repo.js exactly as that repo's TRANSITIONAL HOME
//                   docblock instructed, now that the reviews module exists.
//   NFR-11 (ST-04) — every statement is parameterized ($n placeholders); no caller value is
//                   ever interpolated into SQL text. This module is the ONLY place in the
//                   reviews unit that talks to PostgreSQL: routes validate, the service
//                   orchestrates, the repo queries (ADR-001 layering).
//
// All functions accept an optional pg client so callers can compose them into a
// withTransaction unit of work (ADR-001 — one transaction, no dual writes).
'use strict';

const { query } = require('../../db/pool');

/** Review columns that leave this module (never a raw row spread). */
const REVIEW_COLS =
  'id, booking_id, author_id, target_user_id, rating, body, moderation_status, created_at, updated_at';

function run(text, params, client) {
  return client ? client.query(text, params) : query(text, params);
}

/**
 * Persist one review (FR-05). The caller (service) has already established that the booking
 * is completed and that authorId is one of its participants; the 0001 constraints keep the
 * rating bounds and the one-review-per-(booking, author) rule true under concurrency —
 * the service maps the 23505 violation to the acceptance 409.
 *
 * @param {import('pg').PoolClient} client  the transaction client (the review row and its
 *        moderation.scan outbox row MUST commit together — ADR-001/003)
 * @param {{bookingId: string, authorId: string, targetUserId: string,
 *          rating: number, body: string}} review
 * @returns {Promise<object>} the persisted review row (snake_case, REVIEW_COLS)
 */
async function insertReview(client, { bookingId, authorId, targetUserId, rating, body }) {
  const { rows } = await client.query(
    `INSERT INTO reviews (booking_id, author_id, target_user_id, rating, body)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${REVIEW_COLS}`,
    [bookingId, authorId, targetUserId, rating, body]
  );
  return rows[0];
}

/**
 * Authorship of one review, for the FR-05 / AB-08 attach check ("a photo can only be
 * attached to a review the caller wrote"). This is the PUBLISHED reviews-repo interface the
 * media module consumes (build-plan §4B) — moved here from src/modules/media/repo.js, which
 * re-exports it unchanged for its route's pinned call site.
 *
 * @returns {Promise<{authorId: string|null}|null>} null when no such review exists (→ 404);
 *   otherwise the author id, which is null for a review whose author was anonymized by the
 *   NFR-12 erasure path — such a review is attachable by nobody (→ 403).
 */
async function findReviewAuthorId(reviewId, client = null) {
  const { rows } = await run(`SELECT author_id FROM reviews WHERE id = $1`, [reviewId], client);
  if (rows.length === 0) return null;
  return { authorId: rows[0].author_id };
}

module.exports = {
  REVIEW_COLS,
  insertReview,
  findReviewAuthorId,
};
