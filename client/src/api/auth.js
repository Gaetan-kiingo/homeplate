// client/src/api/auth.js — U5-API-CLIENT: /api/auth endpoints, transcribed from
// src/modules/auth/routes.js on this tree (never invented).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-10 — register / verify-email / resend-verification (the recovery path is always 202,
//     indistinguishable outcomes by design — do not build UI that promises delivery).
//   NFR-03 / AB-05 — login sets and logout clears the opaque HttpOnly session cookie
//     SERVER-side; this module only observes JSON responses. NFR-05: a rate-limited login
//     surfaces as ApiError { status: 429, code, details.retryAfterSeconds }.
import { get, post } from './http.js';

/**
 * POST /api/auth/register — create an unverified account (201). The verification token is
 * never in the response; the user proves inbox ownership via the emailed link.
 * @param {{email: string, password: string, fullName: string} & object} body
 * @returns {Promise<{user: import('./types.js').SessionUser}>}
 */
export function register(body) {
  return post('/api/auth/register', { body });
}

/**
 * POST /api/auth/login — credential check; on success the opaque session cookie is set by
 * the response (HttpOnly — invisible here, by design).
 * @param {{email: string, password: string}} body
 * @returns {Promise<{user: import('./types.js').SessionUser}>}
 */
export function login(body) {
  return post('/api/auth/login', { body });
}

/**
 * POST /api/auth/logout — destroy the server session and clear the cookie (204 → null).
 * @returns {Promise<null>}
 */
export function logout() {
  return post('/api/auth/logout');
}

/**
 * POST /api/auth/verify-email — redeem a single-use verification token (FR-10). The GET
 * variant of this route exists for direct email-link landings; the SPA posts the token.
 * @param {string} token
 * @returns {Promise<{emailVerified: boolean}>}
 */
export function verifyEmail(token) {
  return post('/api/auth/verify-email', { body: { token } });
}

/**
 * GET /api/auth/verify-email?token=... — the email-link variant of token redemption
 * (same handler server-side; useful when the SPA relays the link's query string as-is).
 * @param {string} token
 * @returns {Promise<{emailVerified: boolean}>}
 */
export function verifyEmailFromLink(token) {
  return get('/api/auth/verify-email', { query: { token } });
}

/**
 * POST /api/auth/resend-verification — FR-10 recovery path. ALWAYS answers 202
 * { accepted: true } (anti-enumeration, AB-05); throttled on its own counter (429).
 * @param {string} email
 * @returns {Promise<{accepted: boolean}>}
 */
export function resendVerification(email) {
  return post('/api/auth/resend-verification', { body: { email } });
}
