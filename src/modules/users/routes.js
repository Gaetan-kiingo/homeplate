// src/modules/users/routes.js — U2-IDENTITY: /api/users endpoints (mounted by the U1-HTTP
// route registry).
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-06 (IT-02) — PATCH /me applies profile changes and the response carries the
//                    freshly recomputed canReserveSeat / canPublishListing flags (computed
//                    by the single U2-ELIGIBILITY policy inside the users service).
//   NFR-11 / AB-06 — the PATCH body is validated by the shared U1-VALID middleware against
//                    src/schemas/auth.js profileUpdate; free-text fields are sanitized.
//   NFR-13 / AB-08 — both endpoints REQUIRE a session (401 otherwise — personal data is
//                    never served unauthenticated) and respond with the explicit allowlist
//                    serializer only; a user can only ever read/update THEIR OWN profile
//                    (the id comes from req.auth, never from the URL).
'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const authSchemas = require('../../schemas/auth');
const { requireSession } = require('../auth/middleware');
const usersService = require('./service');

const router = express.Router();

// GET /api/users/me — the authenticated user's own profile (AB-08: session required).
// noInput schema: input-less routes still declare a validator (NFR-11 route enumeration).
router.get(
  '/me',
  requireSession,
  validate({ query: authSchemas.noInput }),
  async (req, res, next) => {
    try {
      const profile = await usersService.getProfile(req.auth.userId);
      res.status(200).json({ user: profile });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/users/me — profile update + eligibility recomputation (NFR-06).
router.patch(
  '/me',
  requireSession,
  validate({ body: authSchemas.profileUpdate }),
  async (req, res, next) => {
    try {
      const profile = await usersService.updateProfile(req.auth.userId, req.body, {
        log: req.log,
      });
      res.status(200).json({ user: profile });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
