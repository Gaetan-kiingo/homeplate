// client/src/features/moderation/components/errorCopy.js — U6-ACCOUNT-MOD: one human
// message per typed API error code on the moderation surface (wave-5 contract: `catch (e)
// { e.code }` — a stringified body is a defect).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-08 / FR-07 — the queue and alerts views render and announce (useAnnounce) exactly
//     one consistent message per code, including the role-gate 403s (NOT_MODERATOR /
//     FORBIDDEN — the server is the enforcement; this copy is the honest surface of it).
//   NFR-07 — messages are actionable and PII-free; transport failures keep the API
//     client's own user-facing wording.
import { ApiError } from '../../../api/index.js';

/** @param {*} err @returns {string} */
export function messageForModerationError(err) {
  if (!(err instanceof ApiError)) {
    return 'Something went wrong. Please try again.';
  }
  switch (err.code) {
    case 'NOT_MODERATOR':
    case 'FORBIDDEN':
      return 'Your account does not hold the moderator role, so this area is unavailable (403).';
    case 'NO_SESSION': // requireSession's live 401 code (src/modules/auth/middleware.js)
    case 'AUTHENTICATION_REQUIRED': // the class default a bare AuthenticationError carries
      return 'Your session has ended — sign in again to continue moderating.';
    case 'QUEUE_ITEM_NOT_FOUND':
      return 'That queue item no longer exists — reload the queue.';
    case 'QUEUE_ITEM_RESOLVED':
      return 'This item was already resolved (possibly by another moderator) — reload the queue to see the recorded decision.';
    case 'NOT_FOUND':
      return 'That record no longer exists.';
    case 'VALIDATION_FAILED':
      return 'The server did not accept the submitted input. Check the form and try again.';
    case 'RATE_LIMITED':
      return 'Too many requests — wait a moment and try again.';
    case 'NETWORK_ERROR':
    case 'UNEXPECTED_RESPONSE':
      return err.message; // already user-facing, written by the wave-5 API client
    default:
      return err.message || 'The request failed. Please try again.';
  }
}
