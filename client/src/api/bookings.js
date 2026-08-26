// client/src/api/bookings.js — U5-API-CLIENT: /api/bookings endpoints, transcribed from
// src/modules/bookings/routes.js on this tree (never invented).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-12 — create(): atomic seat reservation. Expect typed failures: NOT_ELIGIBLE +
//     reason codes (FR-09), NO_CAPACITY (AB-02 race loser), VALIDATION_FAILED — each a
//     stable `e.code` for per-code messaging announced via aria-live (NFR-07 groundwork).
//   FR-14 — cancel(); FR-04 — confirmCompletion() (dual confirmation; the response reports
//     the booking's resulting state).
//   AB-08 — list()/getBooking() serve participant-only data; a foreign booking id is a
//     403/404 by design, not an error to "fix" client-side.
import { get, post, pathParam } from './http.js';

/**
 * POST /api/bookings — reserve a seat on a listing (201).
 * @param {string} listingId
 * @returns {Promise<{booking: object}>}
 */
export function create(listingId) {
  return post('/api/bookings', { body: { listingId: listingId } });
}

/**
 * GET /api/bookings — the caller's own bookings, both roles, paginated.
 * @param {{role?: 'guest'|'host'|'any', status?: 'pending'|'in_progress'|'completed'|'cancelled',
 *          page?: number, pageSize?: number}} [query]
 * @returns {Promise<object>} paged result
 */
export function list(query) {
  return get('/api/bookings', { query });
}

/**
 * GET /api/bookings/:id — participant-only booking detail.
 * @param {string} id
 * @returns {Promise<{booking: object}>}
 */
export function getBooking(id) {
  return get(`/api/bookings/${pathParam(id, 'id')}`);
}

/**
 * POST /api/bookings/:id/cancel — guest or host, before scheduled start (FR-14). The route
 * declares an EMPTY body schema, so an explicit {} is sent.
 * @param {string} id
 * @returns {Promise<{booking: object}>}
 */
export function cancel(id) {
  return post(`/api/bookings/${pathParam(id, 'id')}/cancel`, { body: {} });
}

/**
 * POST /api/bookings/:id/confirm-completion — record this participant's completion
 * confirmation (FR-04); the booking completes when both sides have confirmed.
 * @param {string} id
 * @returns {Promise<object>}
 */
export function confirmCompletion(id) {
  return post(`/api/bookings/${pathParam(id, 'id')}/confirm-completion`, { body: {} });
}
