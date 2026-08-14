// src/modules/auth/middleware.js — U2-IDENTITY: session authentication middleware.
//
// Requirement / decision traceability (SRS Appendix B):
//   AB-05 / AB-08 — every protected endpoint sits behind requireSession: no valid Redis
//                   session record → 401, and personal data is never served to an
//                   unauthenticated caller. A logged-out (deleted) session fails here
//                   immediately — the cookie token alone proves nothing.
//   NFR-08        — the authenticated userId lands on req.auth, which the U1-OBS request
//                   completion log line and audit records read; the sessionId exposed here
//                   is the SHA-256 digest of the cookie token (safe to log, cannot be
//                   inverted into a usable token).
//   ADR-006       — the ONE auth boundary: downstream modules (eligibility, listings,
//                   bookings, …) consume req.auth and never parse cookies themselves.
//
// Contract (build-plan §3 public interfaces):
//   requireSession — Express middleware; on success sets
//                    req.auth = { userId, sessionId, roles } and calls next();
//                    otherwise forwards AuthenticationError (401), never a redirect.
'use strict';

const { AuthenticationError } = require('../../lib/errors');
const sessions = require('./sessions');

/**
 * Require a valid session cookie. Reads the opaque token from the configured cookie
 * (cookie-parser is mounted by U1-HTTP before any route), resolves it in Redis, and
 * attaches the identity to req.auth.
 * @type {import('express').RequestHandler}
 */
async function requireSession(req, res, next) {
  try {
    const token = sessions.tokenFromRequest(req);
    if (!token) {
      return next(new AuthenticationError('Authentication required', { code: 'NO_SESSION' }));
    }
    const session = await sessions.getSession(token);
    if (!session) {
      // Expired, destroyed by logout (AB-05), or never issued — indistinguishable on purpose.
      return next(new AuthenticationError('Session is invalid or expired', { code: 'NO_SESSION' }));
    }
    req.auth = {
      userId: session.userId,
      sessionId: session.sessionId,
      roles: session.roles,
    };
    return next();
  } catch (err) {
    // Redis unreachable etc. — fail closed as an authentication failure is WRONG here:
    // it would mask an outage as bad credentials. Let the error handler classify it (5xx)
    // while the request stays unauthenticated (NFR-09: degrade loudly, never mis-serve).
    return next(err);
  }
}

module.exports = { requireSession };
