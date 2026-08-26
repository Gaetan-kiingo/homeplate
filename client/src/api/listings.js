// client/src/api/listings.js — U5-API-CLIENT: /api/listings CRUD endpoints, transcribed
// from src/modules/listings/routes.js on this tree (never invented). Search lives in
// ./search.js (the backend mounts it as its own module under the same base path).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-11 — create/update/cancel. Expect typed failures: NOT_ELIGIBLE + reason codes
//     (FR-09 gate), MEHKO_DAILY_LISTING_LIMIT (ADR-009 caps), VALIDATION_FAILED — each a
//     stable `e.code` for per-code messaging (NFR-07 groundwork).
//   FR-02 — get(): detail payload = listing projection + host summary + approved-review
//     preview in ONE response (DETAIL_CONTEXT_KEYS).
//   ADR-010 / AB-08 — responses default to the PUBLIC serializer (coarse location only);
//     precise address fields appear ONLY on the privileged paths and are always optional
//     (see ./types.js MaybePrivilegedListing).
import { get, post, patch, pathParam } from './http.js';

/**
 * POST /api/listings — create (201). Content is PENDING until moderation approves (ADR-002).
 * @param {object} body  src/schemas/listings.js `create` shape
 * @returns {Promise<{listing: import('./types.js').MaybePrivilegedListing}>}
 */
export function create(body) {
  return post('/api/listings', { body });
}

/**
 * GET /api/listings/:id — FR-02 detail (listing + host + reviews preview).
 * @param {string} id
 * @returns {Promise<{listing: import('./types.js').ListingDetail}>}
 */
export function getListing(id) {
  return get(`/api/listings/${pathParam(id, 'id')}`);
}

/**
 * PATCH /api/listings/:id — owner-only update; material edits reset moderation to pending.
 * @param {string} id
 * @param {object} body  src/schemas/listings.js `update` shape
 * @returns {Promise<{listing: import('./types.js').MaybePrivilegedListing}>}
 */
export function update(id, body) {
  return patch(`/api/listings/${pathParam(id, 'id')}`, { body });
}

/**
 * POST /api/listings/:id/cancel — cancel with transactional guest notifications (FR-13).
 * The id is the whole input (the route declares no body schema).
 * @param {string} id
 * @returns {Promise<object>}
 */
export function cancel(id) {
  return post(`/api/listings/${pathParam(id, 'id')}/cancel`);
}
