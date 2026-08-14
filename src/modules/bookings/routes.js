// src/modules/bookings/routes.js — U3-BOOKINGS: /api/bookings endpoints (mounted by the
// U1-HTTP route registry; SPMP WA-3).
//
// Requirement traceability (SRS Appendix B):
//   FR-12 (TC-12) — POST / sits behind requireSession AND requireEligibility(RESERVE_SEAT):
//                   an ineligible guest is 403 BEFORE any capacity work (FR-09, AB-02);
//                   the atomic reservation itself is the service's single transaction.
//   FR-14 (TC-14) — POST /:id/cancel (guest or host, before scheduled start, idempotent).
//   FR-04 (TC-04) — POST /:id/confirm-completion (dual-confirmation completion).
//   FR-13         — no adapter, transport or outbox handler is imported here (ADR-001/003):
//                   the request path only ever writes rows; the worker delivers.
//   AB-08         — every route requires a session (401 otherwise); responses are built by
//                   the service's explicit allowlist serializer — IDs, lifecycle state and
//                   the ADR-010 PUBLIC listing reference only (no street address, no
//                   precise coordinates, no contact data).
//   NFR-08        — req.log (correlation-scoped) flows into the service so every mutation's
//                   audit record carries the request's correlation ID (MT-01).
//   NFR-11        — every route declares body/query/params schemas via the ONE shared
//                   validation middleware (src/schemas/bookings.js).
'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const { requireSession } = require('../auth/middleware');
const { requireEligibility } = require('../../modules/eligibility/middleware');
const policy = require('../../modules/eligibility/policy');
const schemas = require('../../schemas/bookings');
const service = require('./service');

const router = express.Router();

// POST /api/bookings — atomic seat reservation (FR-12). Order: session (401) → boundary
// validation (422, ADR-006) → FR-09 eligibility gate (403) — all BEFORE any capacity work
// in the service (AB-02: an ineligible or malformed request never touches seats_remaining).
router.post(
  '/',
  requireSession,
  validate({ body: schemas.createBooking }),
  requireEligibility(policy.ACTIONS.RESERVE_SEAT),
  async (req, res, next) => {
    try {
      const booking = await service.createBooking(req.auth.userId, req.body.listingId, {
        log: req.log,
      });
      res.status(201).json({ booking });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/bookings — the caller's own bookings, both roles (participant data only).
router.get('/', requireSession, validate({ query: schemas.listQuery }), async (req, res, next) => {
  try {
    const result = await service.listBookings(req.auth.userId, req.query);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/bookings/:id — participant-only detail (403 for anyone else).
router.get(
  '/:id',
  requireSession,
  validate({ params: schemas.bookingIdParams, query: schemas.noInput }),
  async (req, res, next) => {
    try {
      const booking = await service.getBooking(req.auth.userId, req.params.id);
      res.status(200).json({ booking });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/bookings/:id/cancel — guest or host, before scheduled start (FR-14).
router.post(
  '/:id/cancel',
  requireSession,
  validate({ params: schemas.bookingIdParams, body: schemas.emptyBody }),
  async (req, res, next) => {
    try {
      const booking = await service.cancelBooking(req.auth.userId, req.params.id, {
        log: req.log,
      });
      res.status(200).json({ booking });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/bookings/:id/confirm-completion — dual-confirmation completion (FR-04).
router.post(
  '/:id/confirm-completion',
  requireSession,
  validate({ params: schemas.bookingIdParams, body: schemas.emptyBody }),
  async (req, res, next) => {
    try {
      const result = await service.confirmCompletion(req.auth.userId, req.params.id, {
        log: req.log,
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
