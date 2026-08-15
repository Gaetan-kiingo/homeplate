// src/modules/safety/routes.js — U4-SAFETY: the FR-07 HTTP surface (mounted by the U1-HTTP
// route registry; build-plan §4 U4-SAFETY; SPMP WA-5).
//
// Mounting: this module exports { basePath: '/api', router } and declares its two FULL paths
// itself, because the FR-07 surface deliberately spans two nouns (build-plan §4 acceptance,
// requirements-inventory FR-07):
//     POST /api/bookings/:id/safety-alerts   — raising an alert is an action ON A BOOKING
//     GET  /api/moderation/alerts            — the Moderator-role queue for those alerts
// The registry mounts `bookings` and `moderation` BEFORE `safety` (src/routes/index.js
// KNOWN_MODULES order), and neither of those routers declares these paths, so both requests
// fall through into this router — the same fall-through pattern U3-SEARCH uses to serve
// /api/listings/search from its own module (build-plan §6.5). Nothing mounts at /api/safety.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-07 (TC-07, IT-04) — POST persists the alert and its outbox row in one transaction and
//            answers 201; GET serves the moderator queue in which an alert stays visible for
//            review however its delivery ends.
//   FR-13 / ADR-001/003 — no adapter, transport or outbox handler is imported here or by the
//            service: the request path only ever writes rows; the worker delivers. A SendGrid
//            outage cannot delay or fail a user's alert.
//   AB-08 / NFR-13 — both routes require a session (401 otherwise); the queue additionally
//            requires the Moderator role (403 otherwise — SRS §2.3). Responses are the
//            service's explicit allowlists: IDs, delivery state and timestamps only, never
//            an address, a name or an emergency-contact value.
//   NFR-11 / AB-06 — every route declares its body/query/params schemas through the ONE
//            shared validation middleware (src/schemas/safety.js), so hostile input is 422
//            or inert data — never a 500, never string-built SQL.
//   NFR-08 (MT-01) — req.log (correlation-scoped) flows into the service so every alert's
//            audit record carries the originating request's correlation ID.
'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const safetySchemas = require('../../schemas/safety');
const { requireSession } = require('../auth/middleware');
const service = require('./service');

const router = express.Router();

// POST /api/bookings/:id/safety-alerts — raise an alert on a booking (FR-07). Returns 201
// BEFORE any external service is touched: delivery is the worker's deferred work.
router.post(
  '/bookings/:id/safety-alerts',
  requireSession,
  validate({ params: safetySchemas.raiseAlertParams, body: safetySchemas.raiseAlertBody }),
  async (req, res, next) => {
    try {
      const alert = await service.raiseAlert(req.auth.userId, req.params.id, { log: req.log });
      res.status(201).json({ alert });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/moderation/alerts — the FR-07 moderator queue (Moderator role only).
router.get(
  '/moderation/alerts',
  requireSession,
  validate({ query: safetySchemas.alertQueueQuery }),
  async (req, res, next) => {
    try {
      const result = await service.listAlertsForModerator(req.auth, req.query);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = { basePath: '/api', router };
