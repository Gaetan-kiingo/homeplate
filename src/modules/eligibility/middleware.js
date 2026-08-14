// src/modules/eligibility/middleware.js — U2-ELIGIBILITY: requireEligibility(action) route gate.
//
// Requirement traceability (SRS Appendix B):
//   FR-09  — the restricted state: an ineligible user's request is answered 403 with the
//            machine-readable reason codes from the policy; the permitted state falls through
//            to next(). Wave-3 mounts this on POST /api/bookings (reserve_seat) and
//            POST /api/listings (publish_listing).
//   NFR-06 — the decision is delegated ENTIRELY to policy.evaluate(); this middleware holds
//            no rule of its own (ADR-006 single-interface rule).
//   AB-02  — the gate runs before any capacity logic, so ineligible hoarders are stopped
//            without touching seats_remaining.
//   AB-08  — an unauthenticated request gets 401 and is never served anything; error bodies
//            carry codes and IDs only, never personal data.
//
// Contract (build-plan §3): requireEligibility(action) reads req.auth.userId (set by
// U2-IDENTITY's requireSession) and next()s a ForbiddenError carrying
// details = { action, reasons } when the policy says no. The response envelope is produced
// by src/middleware/errorHandler.js:
//   403 { error: { code: 'NOT_ELIGIBLE', message, correlationId, details: { action, reasons } } }
'use strict';

const policy = require('./policy');
const { AuthenticationError, ForbiddenError } = require('../../lib/errors');

/**
 * Build the eligibility gate for one action. The action is validated at DEFINITION time
 * (i.e. when the route file loads), so a typo'd action name fails at boot, never in
 * production traffic.
 *
 * @param {string} action  one of policy.ACTIONS.* ('reserve_seat' | 'publish_listing')
 * @returns {import('express').RequestHandler}
 */
function requireEligibility(action) {
  policy.assertAction(action);

  return async function requireEligibilityMiddleware(req, _res, next) {
    try {
      const userId = req.auth && req.auth.userId;
      if (!userId) {
        // Route was mounted without (or before) requireSession, or the session carried no
        // user — authentication, not eligibility, is what is missing (AB-08).
        return next(new AuthenticationError());
      }

      const { allowed, reasons } = await policy.evaluate(userId, action);
      if (!allowed) {
        return next(
          new ForbiddenError('You are not eligible to perform this action.', {
            code: 'NOT_ELIGIBLE',
            details: { action, reasons },
          })
        );
      }

      // Downstream handlers may want the verdict without re-evaluating (IDs/codes only).
      req.eligibility = Object.freeze({ action, allowed: true, reasons: Object.freeze([]) });
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireEligibility };
