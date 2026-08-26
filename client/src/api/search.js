// client/src/api/search.js — U5-API-CLIENT: GET /api/listings/search (FR-01), transcribed
// from src/modules/search/routes.js on this tree. THE ONE PLACE degraded mode is modelled.
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-09 (build-plan §6.1 5B behaviour 3) — degraded search is a FIRST-CLASS STATE, not
//     an exception. The backend contract (src/modules/search/service.js):
//       200                              → fresh answer                  → state 'ok'
//       200 + degraded: true             → stale-cache answer during a
//                                          Maps outage (never re-cached) → state 'degraded'
//       503 { code: 'SEARCH_DEGRADED' }  → no answer possible            → state 'unavailable'
//     search() NEVER throws for those three; `error.message` on 'unavailable' is the
//     server's user-facing text, ready for the aria-live channel (NFR-07 groundwork).
//     Anything else (401, 422, NETWORK_ERROR, ...) throws ApiError as usual.
//   ADR-010 / AB-08 — results are exactly the backend's PUBLIC allowlist projection
//     (coarseLat/coarseLng + areaLabel; no address, ever — see ./types.js).
import { get } from './http.js';
import { ApiError } from './errors.js';

/**
 * FR-01 discovery search.
 * @param {{location?: string, radiusKm?: number, from?: string, to?: string, hostId?: string,
 *          cuisine?: string, page?: number, pageSize?: number}} [params]
 *   Optional filters, matching src/schemas/search.js (from/to: ISO 8601 with timezone).
 * @returns {Promise<import('./types.js').SearchResult>}
 * @throws {ApiError} for failures OTHER than the typed 503 SEARCH_DEGRADED
 */
export async function search(params = {}) {
  let payload;
  try {
    payload = await get('/api/listings/search', { query: params });
  } catch (err) {
    if (err instanceof ApiError && err.status === 503 && err.code === 'SEARCH_DEGRADED') {
      return { state: 'unavailable', error: err };
    }
    throw err;
  }
  const { results, page, pageSize, total, degraded } =
    payload && typeof payload === 'object' ? payload : {};
  return {
    state: degraded === true ? 'degraded' : 'ok',
    listings: Array.isArray(results) ? results : [],
    page,
    pageSize,
    total,
  };
}
