// client/src/api/errors.js — U5-API-CLIENT: the typed error contract every wave-6 screen
// consumes (build-plan §6.1 5B behaviour 2).
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-07 (groundwork) — screens render a user-facing message PER `code` and announce it
//     via the UI kit's aria-live region; that only works if every failure carries a stable
//     machine-readable code (`catch (e) { e.code }` is the published wave-5 interface),
//     never a stringified response body.
//   NFR-08 — `requestId` carries the API's correlationId (src/middleware/errorHandler.js
//     envelope) so a user-visible failure can be joined to the server's structured logs.
//   NFR-09 — transport failure and unparseable responses are first-class codes
//     (NETWORK_ERROR / UNEXPECTED_RESPONSE), so an outage degrades to a typed, renderable
//     state instead of an uncaught TypeError.
//
// Server-issued codes pass through verbatim (NOT_ELIGIBLE + reason codes,
// MEHKO_DAILY_LISTING_LIMIT, NO_CAPACITY, SEARCH_DEGRADED, VALIDATION_FAILED,
// AUTHENTICATION_REQUIRED, RATE_LIMITED, ...). The three codes below are the ONLY
// client-derived ones — they cover failures that never produced a typed server body.

/** Transport-level failure: fetch itself rejected (offline, DNS, TLS, aborted). */
export const NETWORK_ERROR = 'NETWORK_ERROR';

/** The response body was not the API's typed JSON envelope (or a 2xx body was unparseable). */
export const UNEXPECTED_RESPONSE = 'UNEXPECTED_RESPONSE';

/** The direct-to-storage media PUT (ADR-004 supply path) answered non-2xx. */
export const MEDIA_UPLOAD_FAILED = 'MEDIA_UPLOAD_FAILED';

/**
 * The one error shape the API client ever throws.
 *
 * @property {number} status     HTTP status (0 for transport-level failures).
 * @property {string} code       Stable machine-readable code — server-issued, or one of the
 *                               three client-derived codes above.
 * @property {*} [details]       Safe field-level details from the server envelope (e.g. the
 *                               VALIDATION_FAILED issue list, NOT_ELIGIBLE reason codes,
 *                               RATE_LIMITED retryAfterSeconds).
 * @property {string} [requestId] The server's correlationId for this request (NFR-08).
 */
export class ApiError extends Error {
  /**
   * @param {string} message  User-presentable, PII-free message (the server envelope's
   *                          message for typed bodies; a generic transport message otherwise).
   * @param {{status?: number, code?: string, details?: *, requestId?: string, cause?: *}} [options]
   */
  constructor(message, { status = 0, code = UNEXPECTED_RESPONSE, details, requestId, cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    if (requestId !== undefined) this.requestId = requestId;
  }
}
