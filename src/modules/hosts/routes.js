// src/modules/hosts/routes.js — U3-HOSTS-MEDIA: /api/hosts endpoints (mounted by the U1-HTTP
// route registry; build-plan wave 3B; SPMP WA-8).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-03 (TC-03) — GET /:id serves the host personal page; GET /:id/reviews serves the
//            paginated approved-review list (LT-01 exercises it).
//   NFR-13 / AB-08 — BOTH routes require a session (401 unauthenticated — personal-page data
//            is never served to anonymous scrapers); responses are the hosts serializer
//            allowlists only, and example dishes ride the ADR-010 publicListing chokepoint
//            (coarse location only — this surface can never emit a street address).
//   NFR-11 / AB-06 — every route declares its zod schema through the shared U1-VALID
//            middleware (hostile :id or pagination input → 422 or inert data, never a 500;
//            the st-security route enumeration requires a validator on EVERY mounted route).
//   ADR-001 — nothing reachable from these handlers imports src/adapters/*: the page is
//            PostgreSQL reads plus local URL derivation (src/lib/mediaUrls).
'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const hostSchemas = require('../../schemas/hosts');
const { requireSession } = require('../auth/middleware');
const service = require('./service');

const router = express.Router();

// GET /api/hosts/:id/reviews — FR-03 paginated approved reviews (registered before /:id so
// the more specific path wins deterministically).
router.get(
  '/:id/reviews',
  requireSession,
  validate({ params: hostSchemas.idParams, query: hostSchemas.reviewsQuery }),
  async (req, res, next) => {
    try {
      const result = await service.listHostReviews(req.auth, req.params.id, {
        page: req.query.page,
        pageSize: req.query.pageSize,
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/hosts/:id — FR-03 host personal page (AB-08: session required, 401 otherwise).
router.get(
  '/:id',
  requireSession,
  validate({ params: hostSchemas.idParams, query: hostSchemas.noInput }),
  async (req, res, next) => {
    try {
      const host = await service.getHostPage(req.auth, req.params.id);
      res.status(200).json({ host });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
