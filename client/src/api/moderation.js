// client/src/api/moderation.js — U5-API-CLIENT: the FR-08 moderator queue endpoints,
// transcribed from src/modules/moderation/routes.js on this tree (never invented; the
// FR-07 ALERT queue is the safety module's surface — see ./safety.js).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-08 — the human review stage of the ADR-002 two-stage pipeline: list the queue
//     (status/content-type filters, paged) and record approve/reject decisions with a
//     category and optional note. Both routes require the Moderator role (403 otherwise).
//   AB-08 — queue items carry IDs, scan-text excerpt and lifecycle state only — never an
//     address, coordinate or author identity; the client renders what it is given and
//     requests nothing wider.
import { get, post, pathParam } from './http.js';

/**
 * GET /api/moderation/queue — the human review queue (Moderator role only).
 * @param {{status?: 'open'|'in_review'|'resolved', contentType?: string,
 *          page?: number, pageSize?: number}} [query]
 * @returns {Promise<object>} paged result
 */
export function queue(query) {
  return get('/api/moderation/queue', { query });
}

/**
 * POST /api/moderation/queue/:id/decision — record the human decision (FR-08).
 * @param {string} id  queue item id
 * @param {{decision: 'approve'|'reject', category: string, note?: string}} body
 * @returns {Promise<object>}
 */
export function decide(id, body) {
  return post(`/api/moderation/queue/${pathParam(id, 'id')}/decision`, { body });
}
