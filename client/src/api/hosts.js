// client/src/api/hosts.js — U5-API-CLIENT: /api/hosts endpoints, transcribed from
// src/modules/hosts/routes.js on this tree (never invented).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-03 — the host personal page (display identity, bio, profile media, example dishes,
//     approved reviews + aggregates) and the paginated approved-reviews list.
//   ADR-010 / NFR-13 / AB-08 — the host page is an allowlist projection: display data and
//     PUBLIC-precision listings only. No contact data, no address key exists in this
//     payload — client code must not expect one.
import { get, pathParam } from './http.js';

/**
 * GET /api/hosts/:id — FR-03 host page.
 * @param {string} id  host user id
 * @returns {Promise<{host: object}>}
 */
export function getHost(id) {
  return get(`/api/hosts/${pathParam(id, 'id')}`);
}

/**
 * GET /api/hosts/:id/reviews — approved reviews about the host, paginated (capped pages).
 * @param {string} id  host user id
 * @param {{page?: number, pageSize?: number}} [query]
 * @returns {Promise<object>} paged result (reviews + totals)
 */
export function reviews(id, query) {
  return get(`/api/hosts/${pathParam(id, 'id')}/reviews`, { query });
}
