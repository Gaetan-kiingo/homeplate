// src/modules/reviews/routes.js — U4-REVIEWS: the FR-05 HTTP surface (mounted by the
// U1-HTTP route registry; build-plan §4B; SPMP WA-4).
//
// Mounting: this module exports { basePath: '/api', router } and declares its ONE full path
// itself, because leaving a review is an action ON A BOOKING:
//     POST /api/bookings/:id/reviews
// The registry mounts `bookings` BEFORE `reviews` (src/routes/index.js KNOWN_MODULES order)
// and the bookings router declares no `/:id/reviews` route, so the request falls through
// into this router — the same fall-through pattern U4-SAFETY uses for
// /api/bookings/:id/safety-alerts (build-plan §6.5). Nothing mounts at /api/reviews, and
// there is deliberately NO public review-listing route here: approved reviews are read
// through the EXISTING wave-3 paths (GET /api/hosts/:id, GET /api/hosts/:id/reviews and the
// listing-detail host context), which select moderation_status='approved' rows only.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-05 (TC-05) — POST persists the review (rating 1..5, comment, photos by storage key)
//            with moderation_status='pending' and its 'moderation.scan' outbox row in one
//            transaction, and answers 201. Completed bookings only (409); one review per
//            author per booking (409); participants only (403).
//   FR-08 / AB-01 / AB-04 — nothing returned or stored here is publicly visible until the
//            ADR-002 pipeline approves it; the 201 body is the author's own submission.
//   ADR-001/003 — no adapter, transport or outbox handler is imported here or by the
//            service: the request path only ever writes rows; the scan runs in the worker.
//   AB-08 / NFR-13 — the route requires a session (401 otherwise); the response is the
//            service's explicit allowlist — IDs, the caller's own sanitized text, rating
//            and lifecycle state only. No address, name or contact value is ever selected.
//   NFR-11 / AB-06 — body and params are validated through the ONE shared validation
//            middleware (src/schemas/reviews.js): a bad rating is 422 before any SQL runs,
//            and hostile text arrives sanitized/inert (ST-04).
//   NFR-08 (MT-01) — req.log (correlation-scoped) flows into the service so every review's
//            audit record carries the originating request's correlation ID.
'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const reviewSchemas = require('../../schemas/reviews');
const { requireSession } = require('../auth/middleware');
const service = require('./service');

const router = express.Router();

// POST /api/bookings/:id/reviews — leave a review on a completed booking (FR-05). Returns
// 201 with the pending review; publication is the moderation pipeline's decision (FR-08).
router.post(
  '/bookings/:id/reviews',
  requireSession,
  validate({ params: reviewSchemas.createReviewParams, body: reviewSchemas.createReviewBody }),
  async (req, res, next) => {
    try {
      const review = await service.createReview(req.auth.userId, req.params.id, req.body, {
        log: req.log,
      });
      res.status(201).json({ review });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = { basePath: '/api', router };
