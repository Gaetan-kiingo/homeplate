// client/src/api/safety.js — U5-API-CLIENT: the FR-07 safety-alert endpoints, transcribed
// from src/modules/safety/routes.js on this tree (never invented). The moderator ALERT
// queue lives here too — the backend deliberately declares /api/moderation/alerts on the
// safety module's router (fall-through mounting), and this module mirrors that ownership.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-07 — raiseAlert(): a participant raises an alert on a booking; 201 BEFORE any
//     delivery happens (the outbox worker delivers, ADR-001/003) — the UI must confirm
//     "alert recorded", never "alert delivered".
//   AB-04 — escalateAlert(): a moderator escalates flagged content by raising a real alert
//     on the booking behind it (bookingId only; free text is deliberately absent).
//   AB-08 — the moderator queue serves IDs and lifecycle state, never addresses or author
//     identities beyond what FR-07 handling requires.
import { get, post, pathParam } from './http.js';

/**
 * POST /api/bookings/:id/safety-alerts — raise an alert on a booking (201). The route
 * declares an EMPTY body schema (the booking id is the whole input), so {} is sent.
 * @param {string} bookingId
 * @returns {Promise<{alert: object}>}
 */
export function raiseAlert(bookingId) {
  return post(`/api/bookings/${pathParam(bookingId, 'bookingId')}/safety-alerts`, { body: {} });
}

/**
 * GET /api/moderation/alerts — the FR-07 moderator alert queue (Moderator role; 403
 * otherwise), filterable by delivery status, paginated.
 * @param {{status?: string, page?: number, pageSize?: number}} [query]
 * @returns {Promise<object>} paged result
 */
export function listModerationAlerts(query) {
  return get('/api/moderation/alerts', { query });
}

/**
 * POST /api/moderation/alerts — AB-04 moderator escalation (201; worker delivers).
 * @param {{bookingId: string}} body
 * @returns {Promise<{alert: object}>}
 */
export function escalateAlert(body) {
  return post('/api/moderation/alerts', { body });
}
