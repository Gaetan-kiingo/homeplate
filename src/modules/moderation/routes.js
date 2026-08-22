// src/modules/moderation/routes.js — U4-MODERATION: the FR-08 moderator HTTP surface,
// mounted by the U1-HTTP route registry at /api/moderation (src/routes/index.js).
//
// Mounting note: the registry mounts `moderation` BEFORE `safety`, and the FR-07 alert queue
// (GET /api/moderation/alerts) is deliberately declared by the SAFETY module's router at
// basePath '/api'. This router declares ONLY /queue and /queue/:id/decision, so an
// /api/moderation/alerts request finds no route here and falls through to safety — the same
// fall-through pattern U3-SEARCH uses (build-plan §6.5). Do not declare /alerts here.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-08 (TC-08) — GET /api/moderation/queue (status/content-type filters, paged) and
//            POST /api/moderation/queue/:id/decision (approve/reject + category + optional
//            note) — the human review stage of the ADR-002 pipeline.
//   AB-08 / NFR-13 — both routes require a session (401) and the Moderator role (403 — SRS
//            §2.3); responses are the service's explicit allowlists (IDs, scan-text excerpt,
//            lifecycle state) — never an address, coordinate or author identity.
//   NFR-11 / AB-06 — every route declares its schemas through the ONE shared validation
//            middleware (src/schemas/moderation.js), so hostile input is 422 or inert data.
//   NFR-08 (MT-01) — req.log (correlation-scoped) flows into the service so the
//            moderation-decision audit record carries the request's correlation ID.
//   ADR-001/003 — no adapter, transport or outbox handler is imported here or by the
//            service: the LLM stage runs ONLY in the worker (handlers/moderationScan.js).
'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const moderationSchemas = require('../../schemas/moderation');
const { requireSession } = require('../auth/middleware');
const service = require('./service');

const router = express.Router();

// GET /api/moderation/queue — the human review queue (Moderator role only).
router.get(
  '/queue',
  requireSession,
  validate({ query: moderationSchemas.queueQuery }),
  async (req, res, next) => {
    try {
      const result = await service.listQueue(req.auth, req.query);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/moderation/queue/:id/decision — record the human decision (FR-08, MT-01).
router.post(
  '/queue/:id/decision',
  requireSession,
  validate({
    params: moderationSchemas.decisionParams,
    body: moderationSchemas.decisionBody,
  }),
  async (req, res, next) => {
    try {
      const result = await service.decide(req.auth, req.params.id, req.body, { log: req.log });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
