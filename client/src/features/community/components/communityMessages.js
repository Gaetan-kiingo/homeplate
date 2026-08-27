// client/src/features/community/components/communityMessages.js — U6-COMMUNITY: the shared
// typed-error → human-message map for the community screens (MessagesPage / ReviewPage /
// SafetyAlertPage).
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-07 — every failure renders a REAL human message per machine code and the calling
//     screen announces it through the shell's aria-live channel (useAnnounce). Rendering a
//     stringified error body is a defect (build-plan G.2), so the ONLY inputs here are the
//     ApiError's stable `code` and, as a fallback, its server-authored user-presentable
//     `message` (src/middleware/errorHandler.js envelope — PII-free by contract).
//   FR-05 / FR-06 / FR-07 — per-screen overrides carry the flow-specific refusal copy
//     (REVIEW_EXISTS, BOOKING_CANCELLED, MEDIA_UPLOAD_FAILED, ...); this base map carries
//     the codes every booking-scoped community screen shares.

/** The 401 guidance. requireSession — the only auth gate on every community-consumed
 *  route — always answers code NO_SESSION (src/modules/auth/middleware.js); the class
 *  default AUTHENTICATION_REQUIRED (src/lib/errors.js) stays as an alias so a bare
 *  AuthenticationError (e.g. the eligibility middleware) gets the same guidance.
 *  Finding U6VC-F1: keying only the alias left this copy unreachable dead code. */
const SIGN_IN_MESSAGE =
  'You need to sign in first. Go to the login page, sign in, then come back here.';

/** Codes the three community screens share, with copy that says what to DO about it. */
const BASE_MESSAGES = {
  NO_SESSION: SIGN_IN_MESSAGE,
  AUTHENTICATION_REQUIRED: SIGN_IN_MESSAGE,
  BOOKING_NOT_FOUND:
    'This booking could not be found. Check that the link you followed is still valid.',
  NOT_PARTICIPANT: "Only this booking's guest or host can use this page.",
  NETWORK_ERROR: 'Homeplate could not be reached. Check your connection and try again.',
};

/**
 * Resolve a thrown error to the human message a community screen renders and announces.
 * Precedence: screen-specific override by code → shared base map by code → the server's own
 * user-presentable message (typed envelope pass-through) → a generic fallback.
 *
 * @param {*} err  usually an ApiError ({ code, message, status }) from src/api
 * @param {Object<string, string>} [overrides]  screen-specific copy keyed by error code
 * @returns {string} a complete, user-presentable sentence — never a code, never JSON
 */
export function messageForError(err, overrides = {}) {
  const code = err && typeof err.code === 'string' ? err.code : null;
  if (code && overrides[code]) return overrides[code];
  if (code && BASE_MESSAGES[code]) return BASE_MESSAGES[code];
  if (err && typeof err.message === 'string' && err.message !== '') return err.message;
  return 'Something went wrong. Please try again.';
}
