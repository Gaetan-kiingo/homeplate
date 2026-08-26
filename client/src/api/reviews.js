// client/src/api/reviews.js — U5-API-CLIENT: the booking-scoped review endpoint,
// transcribed from src/modules/reviews/routes.js on this tree (never invented). Reading
// reviews happens via the host page (./hosts.js) and listing detail (./listings.js).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-05 — review a completed booking: integer rating 1..5, comment, optional previously
//     minted image keys (./media.js supply path). The 201 response carries the PENDING
//     review — publication is the moderation pipeline's decision (FR-08/ADR-002), so the
//     UI must present "submitted for review", never "published".
import { post, pathParam } from './http.js';

/**
 * POST /api/bookings/:id/reviews — leave a review on a completed booking (201, pending).
 * @param {string} bookingId
 * @param {{rating: number, comment: string, imageKeys?: string[]}} body
 * @returns {Promise<{review: object}>}
 */
export function create(bookingId, body) {
  return post(`/api/bookings/${pathParam(bookingId, 'bookingId')}/reviews`, { body });
}
