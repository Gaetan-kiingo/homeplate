// client/src/api/messages.js — U5-API-CLIENT: the booking-scoped messaging endpoints,
// transcribed from src/modules/messaging/routes.js on this tree (never invented).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-06 — participants message within a booking thread. Delivery is IMMEDIATE (201 with
//     the message); moderation scans asynchronously AFTER delivery (ADR-002) — the UI must
//     not wait for or display any moderation verdict on send.
//   AB-04 — the thread read hides rejected (flagged) messages server-side.
//   AB-08 — participants only; a foreign booking id is 403/404 by design.
import { get, post, pathParam } from './http.js';

/**
 * POST /api/bookings/:id/messages — send into the booking thread (201).
 * @param {string} bookingId
 * @param {string} body  the message text (bounded, sanitized server-side)
 * @returns {Promise<{message: object}>}
 */
export function send(bookingId, body) {
  return post(`/api/bookings/${pathParam(bookingId, 'bookingId')}/messages`, {
    body: { body },
  });
}

/**
 * GET /api/bookings/:id/messages — the thread, oldest first, capped pages.
 * @param {string} bookingId
 * @param {{page?: number, pageSize?: number}} [query]
 * @returns {Promise<object>} paged result
 */
export function list(bookingId, query) {
  return get(`/api/bookings/${pathParam(bookingId, 'bookingId')}/messages`, { query });
}
