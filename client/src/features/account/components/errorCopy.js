// client/src/features/account/components/errorCopy.js — U6-ACCOUNT-MOD: one human message
// per typed API error code on the account/auth surface (wave-5 contract: `catch (e)
// { e.code }` — a stringified body is a defect).
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-07 — every failure the account screens render or announce (via useAnnounce) goes
//     through this map, so each code gets ONE consistent, actionable, PII-free message.
//   NFR-05 — loginLockoutMessage() is the HONEST lockout copy: it names the temporary lock,
//     the reason, and when to retry (details.retryAfterSeconds from the 429
//     LOGIN_RATE_LIMITED envelope — the same value the server puts in Retry-After).
//     Findings AMV-W6-01/-02: the server's live throttle codes are LOGIN_RATE_LIMITED
//     (src/modules/auth/service.js:318) and VERIFICATION_RESEND_RATE_LIMITED
//     (service.js:174) — never the bare class default RATE_LIMITED — so throttle detection
//     goes through isThrottleError() (the 429 STATUS family), which no future rename of a
//     code can silently bypass.
//   FR-10 / AB-05 — resend-verification copy never promises delivery and never confirms an
//     address exists (the API answers 202 for every address by design).
import { ApiError } from '../../../api/index.js';

/** Human form of a Retry-After style seconds value ("about 30 seconds" / "about 5 minutes"). */
export function formatRetryDelay(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 'a few minutes';
  }
  if (seconds < 90) {
    return `about ${Math.ceil(seconds)} seconds`;
  }
  return `about ${Math.ceil(seconds / 60)} minutes`;
}

/**
 * True for any 429 throttle answer on the auth surface (AMV-W6-01/-02: match the status
 * family, not one code name — the live codes are LOGIN_RATE_LIMITED and
 * VERIFICATION_RESEND_RATE_LIMITED).
 * @param {*} err
 * @returns {boolean}
 */
export function isThrottleError(err) {
  return err instanceof ApiError && err.status === 429;
}

/**
 * NFR-05: the honest login-lockout message. Names WHAT happened (temporary lock after
 * repeated failed attempts), WHY (account protection), and WHEN it ends — never a vague
 * "try again later" and never a pretend server outage.
 * @param {ApiError} err  the 429 LOGIN_RATE_LIMITED error from POST /api/auth/login
 */
export function loginLockoutMessage(err) {
  const delay = formatRetryDelay(err && err.details && err.details.retryAfterSeconds);
  return (
    'Too many failed sign-in attempts, so sign-in is temporarily locked to protect the ' +
    `account. Wait ${delay}, then try again with your correct password — the lock lifts by ` +
    'itself and nothing else is required.'
  );
}

/** The resend-verification throttle (429 VERIFICATION_RESEND_RATE_LIMITED), with the wait
 *  horizon from the envelope — one copy shared by SignupPage and ResendVerificationForm. */
export function resendThrottledMessage(err) {
  return `You asked for verification emails too often. Wait ${formatRetryDelay(
    err && err.details && err.details.retryAfterSeconds
  )} before requesting another one.`;
}

/** FR-10/AB-05 resend confirmation: 202 means "queued if the account exists" — say exactly
 *  that, promising neither existence nor delivery. */
export function resendQueuedMessage(email) {
  return (
    `If an account exists for ${email}, a new verification email has been queued. ` +
    'Delivery happens in the background and can take a few minutes — check your spam folder too.'
  );
}

/**
 * One message per typed code for the account/auth surface. Server-issued codes pass through
 * here; the two client-derived transport codes keep the ApiError's own user-facing message.
 * @param {*} err
 * @returns {string}
 */
export function messageForAccountError(err) {
  if (!(err instanceof ApiError)) {
    return 'Something went wrong. Please try again.';
  }
  switch (err.code) {
    case 'INVALID_CREDENTIALS':
      return 'Invalid email or password.';
    case 'LOGIN_RATE_LIMITED':
    case 'VERIFICATION_RESEND_RATE_LIMITED':
    case 'RATE_LIMITED':
      return `Too many attempts. Please wait ${formatRetryDelay(
        err.details && err.details.retryAfterSeconds
      )} and try again.`;
    case 'EMAIL_IN_USE':
      return 'An account with this email address already exists — try signing in instead.';
    case 'INVALID_VERIFICATION_TOKEN':
      return 'This verification link is invalid, already used, or expired. Request a new verification email below.';
    case 'VALIDATION_FAILED':
      return 'The server did not accept some of the submitted fields. Check the form and try again.';
    case 'NO_SESSION': // requireSession's live 401 code (src/modules/auth/middleware.js)
    case 'AUTHENTICATION_REQUIRED': // the class default a bare AuthenticationError carries
      return 'You need to be signed in to do that. Your session may have ended — sign in again.';
    case 'NOT_FOUND':
      return 'That record no longer exists.';
    case 'NETWORK_ERROR':
    case 'UNEXPECTED_RESPONSE':
      return err.message; // already user-facing, written by the wave-5 API client
    default:
      return err.message || 'The request failed. Please try again.';
  }
}
