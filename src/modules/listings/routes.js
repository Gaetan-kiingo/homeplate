// src/modules/listings/routes.js — U3-LISTINGS: /api/listings endpoints (mounted by the
// U1-HTTP route registry; build-plan wave 3A; SPMP WA-2).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-11 (TC-11) — POST / (create), PATCH /:id (update), POST /:id/cancel — all behind
//            requireSession; creation additionally behind the SINGLE eligibility gate
//            requireEligibility(PUBLISH_LISTING) (FR-09, ADR-006 — never re-implemented).
//   FR-02 (TC-02) — GET /:id detail. The :id parameter is UUID-REGEX-CONSTRAINED so
//            GET /api/listings/search falls through this router to the U3-SEARCH router
//            mounted at the same base path (build-plan §6.5).
//   NFR-11 / AB-06 — every route declares its zod schema through the shared U1-VALID
//            middleware (hostile input → 422 or inert data, never a 500; the st-security
//            route enumeration requires a validator on EVERY mounted route).
//   NFR-13 / AB-08 — a session is required on every route (401 otherwise); responses are
//            serializer allowlists only (ADR-010 via ../listings/serializers).
//   ADR-001 — nothing reachable from these handlers imports src/adapters/*: geocoding and
//            moderation happen on the worker via outbox jobs enqueued in the service.
'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const listingSchemas = require('../../schemas/listings');
const { requireSession } = require('../auth/middleware');
const { requireEligibility } = require('../../modules/eligibility/middleware');
const { ACTIONS } = require('../../modules/eligibility/policy');
const service = require('./service');

// Inline UUID constraint for the :id param (Express 4 / path-to-regexp custom matcher):
// non-UUID path segments — '/search' in particular — do NOT match these routes and fall
// through to the next router on the same base path (U3-SEARCH, build-plan §6.5).
const UUID_PARAM =
  ':id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';

const router = express.Router();

// POST /api/listings — FR-11 create (FR-09: eligibility gate BEFORE any listing logic).
router.post(
  '/',
  requireSession,
  requireEligibility(ACTIONS.PUBLISH_LISTING),
  validate({ body: listingSchemas.create }),
  async (req, res, next) => {
    try {
      const listing = await service.createListing(req.auth, req.body, { log: req.log });
      res.status(201).json({ listing });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/listings/:id — FR-02 detail with ADR-010 progressive disclosure (AB-08: session
// required — personal/location data is never served unauthenticated). The response carries
// the listing projection PLUS — in the same payload (FR-02/TC-02 acceptance) — the host
// summary and the approved host reviews (serializers.DETAIL_CONTEXT_KEYS).
router.get(
  `/${UUID_PARAM}`,
  requireSession,
  validate({ params: listingSchemas.idParams, query: listingSchemas.noInput }),
  async (req, res, next) => {
    try {
      const listing = await service.getListing(req.auth, req.params.id);
      res.status(200).json({ listing });
    } catch (err) {
      next(err);
    }
  }
);

// PATCH /api/listings/:id — FR-11 update (owner-only; material edits reset moderation).
router.patch(
  `/${UUID_PARAM}`,
  requireSession,
  validate({ params: listingSchemas.idParams, body: listingSchemas.update }),
  async (req, res, next) => {
    try {
      const listing = await service.updateListing(req.auth, req.params.id, req.body, {
        log: req.log,
      });
      res.status(200).json({ listing });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/listings/:id/cancel — FR-11 cancel with FR-13 transactional notifications.
// Input-less body: the id in the path is the whole input (NFR-11: validator still declared).
router.post(
  `/${UUID_PARAM}/cancel`,
  requireSession,
  validate({ params: listingSchemas.idParams }),
  async (req, res, next) => {
    try {
      const result = await service.cancelListing(req.auth, req.params.id, { log: req.log });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
