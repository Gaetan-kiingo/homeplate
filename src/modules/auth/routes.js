// src/modules/auth/routes.js — U2-IDENTITY: /api/auth endpoints (mounted by the U1-HTTP
// route registry).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-10 (TC-10) — POST /register (201 unverified account; the verification token is NEVER
//                   in the response — inbox ownership is the whole point), GET/POST
//                   /verify-email (single-use token → email_verified=true; wrong/used/
//                   expired → 400).
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
