// src/modules/auth/routes.js — U2-IDENTITY: /api/auth endpoints (mounted by the U1-HTTP
// route registry).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-10 (TC-10) — POST /register (201 unverified account; the verification token is NEVER
//                   in the response — inbox ownership is the whole point), GET/POST
//                   /verify-email (single-use token → email_verified=true;
//                   wrong/used/expired → 400), POST /resend-verification (recovery path: a
//                   dead-lettered or lost delivery must not strand an account forever —
//                   always 202, throttled on its own counter).
//   NFR-05 (ST-03) — a rate-limited login answers 429 WITH a Retry-After header.
//   NFR-11 / AB-06 — every route declares its zod schema through the shared U1-VALID
//                   middleware; hostile input arrives as 422 or inert data, never a 500.
//   AB-05          — the session cookie is set/cleared ONLY here via ./sessions (HttpOnly,
//                   Secure, SameSite=Lax); POST /logout destroys the Redis session.
//   AB-07          — duplicate email → 409 from the service's unique-constraint mapping.
//   ADR-001        — nothing reachable from these handlers imports src/adapters/* — the
//                   verification email happens in the outbox worker, not here.
'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { RateLimitError } = require('../../lib/errors');
const authSchemas = require('../../schemas/auth');
const authService = require('./service');
const sessions = require('./sessions');
const { requireSession } = require('./middleware');
const usersRepo = require('../users/repo');

const router = express.Router();

// POST /api/auth/register — FR-10: create the unverified account + queued verification email.
router.post('/register', validate({ body: authSchemas.register }), async (req, res, next) => {
  try {
    const { user } = await authService.register(req.body, { log: req.log });
    // Allowlist serializer (NFR-13); the raw verification token is deliberately absent.
    res.status(201).json({ user: usersRepo.serializeUser(user, null) });
  } catch (err) {
    next(err);
  }
});

// Shared verify-email handler — token from body (POST) or query string (GET) (FR-10).
function verifyEmailHandler(readToken) {
  return async (req, res, next) => {
    try {
      const result = await authService.verifyEmail(readToken(req), { log: req.log });
      res.status(200).json({ emailVerified: result.emailVerified });
    } catch (err) {
      next(err);
    }
  };
}

router.post(
  '/verify-email',
  validate({ body: authSchemas.verifyEmailBody }),
  verifyEmailHandler((req) => req.body.token)
);

router.get(
  '/verify-email',
  validate({ query: authSchemas.verifyEmailQuery }),
  verifyEmailHandler((req) => req.query.token)
);

// POST /api/auth/resend-verification — FR-10 recovery path (NFR-09 "deferred, never
// dropped"): re-queue a verification email when the first one never arrived — the outbox job
// exhausted config.outbox.maxAttempts during a provider outage and dead-lettered, the mailbox
// bounced, or the message was lost. Without this route users.email_verified could never
// become true for that account and the FR-09 eligibility policy would refuse POST /api/bookings
// and POST /api/listings forever.
//
// Deliberately session-OPTIONAL and keyed on the address: an account that has not proved
// inbox ownership yet may have no live session, and requiring one would leave exactly the
// stranded users this route exists for with no way out.
//
// AB-05 anti-enumeration: the answer is ALWAYS 202 — unknown address, soft-deleted account,
// already-verified account and freshly re-queued job are indistinguishable to the caller.
// NFR-05 discipline: throttled on its OWN counter (auth/rateLimit.checkResend), never the
// login lockout counter, so nobody can lock an account out of login by requesting
// verification emails; the throttle counts unknown addresses too, so even the 429 boundary
// reveals nothing. The 429 carries Retry-After exactly as login does (ST-03).
//
// ADR-001/003: this handler enqueues an outbox row and returns — it touches no adapter; the
// worker delivers the mail.
router.post(
  '/resend-verification',
  validate({ body: authSchemas.resendVerification }),
  async (req, res, next) => {
    try {
      await authService.resendVerificationEmail(
        { email: req.body.email, ip: req.ip },
        { log: req.log }
      );
      // The result is deliberately NOT reflected in the response (see AB-05 above).
      res.status(202).json({ accepted: true });
    } catch (err) {
      if (err instanceof RateLimitError && err.details && err.details.retryAfterSeconds) {
        res.set('Retry-After', String(err.details.retryAfterSeconds));
      }
      next(err);
    }
  }
);

// POST /api/auth/login — NFR-05/AB-05: rate-limited credential check, opaque session cookie.
router.post('/login', validate({ body: authSchemas.login }), async (req, res, next) => {
  try {
    const { user, session } = await authService.login(
      { email: req.body.email, password: req.body.password, ip: req.ip },
      { log: req.log }
    );
    sessions.setSessionCookie(res, session.token, session.ttlSeconds);
    const hostProfile = await usersRepo.getHostProfile(user.id);
    res.status(200).json({ user: usersRepo.serializeUser(user, hostProfile) });
  } catch (err) {
    // ST-03: the lockout response carries Retry-After (seconds) alongside the 429 body.
    if (err instanceof RateLimitError && err.details && err.details.retryAfterSeconds) {
      res.set('Retry-After', String(err.details.retryAfterSeconds));
    }
    next(err);
  }
});

// POST /api/auth/logout — AB-05: destroy the Redis session; the token is unusable at once.
// noInput schema: input-less routes still declare a validator (NFR-11 route enumeration).
router.post(
  '/logout',
  requireSession,
  validate({ query: authSchemas.noInput }),
  async (req, res, next) => {
    try {
      const token = sessions.tokenFromRequest(req);
      await authService.logout(token, {
        log: req.log,
        userId: req.auth.userId,
        sessionId: req.auth.sessionId,
      });
      sessions.clearSessionCookie(res);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
