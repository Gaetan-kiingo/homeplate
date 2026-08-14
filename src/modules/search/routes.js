// src/modules/search/routes.js — U3-SEARCH: GET /api/listings/search (mounted by the U1-HTTP
// route registry; build-plan wave 3B; SPMP WA-2).
//
// Mounting (build-plan §6.5): this module exports { basePath: '/api/listings', router } so the
// search endpoint lives under the listings base path — the Appendix-B "Search Service" stays
// its own module while the URL reads naturally. The registry mounts `listings` BEFORE `search`
// and the listings router UUID-constrains its `:id` param, so `/api/listings/search` falls
// through the listings router into this one. Nothing mounts at /api/search.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-01 (TC-01) — the search endpoint: any combination of location(+radiusKm), from/to,
//            hostId, cuisine, paginated.
//   NFR-11 / AB-06 — the query is validated by the shared U1-VALID middleware against
//            src/schemas/search.js: unknown params stripped, shape violations 422, hostile
//            strings inert (ST-04).
//   NFR-13 / AB-08 — requireSession first: personal/location data (even at coarse public
//            precision) is never served unauthenticated — 401, never data. The response body
//            is built exclusively from the ADR-010 public serializer (see ./service.js).
//   NFR-09 — a Maps outage on an uncached location query surfaces as the service's typed
//            503 SEARCH_DEGRADED through the shared error handler — a structured JSON error
//            with a user-facing message, never an unhandled 500.
//   ADR-001 — this file imports no adapter; the service call-time-requires the Maps READ
//            adapter under the documented ADR-005 exception (build-plan §6.1).
'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const searchSchemas = require('../../schemas/search');
const { requireSession } = require('../auth/middleware');
const service = require('./service');

const router = express.Router();

// GET /api/listings/search — FR-01 discovery.
router.get(
  '/search',
  requireSession,
  validate({ query: searchSchemas.query }),
  async (req, res, next) => {
    try {
      const result = await service.searchListings(req.query);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = { basePath: '/api/listings', router };
