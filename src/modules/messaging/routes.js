// src/modules/messaging/routes.js — U4-MESSAGING: the FR-06 HTTP surface (mounted by the
// U1-HTTP route registry; build-plan §4 wave 4C; SPMP WA-4).
//
// Mounting: this module exports { basePath: '/api', router } and declares its ONE full path
// itself (both verbs), because a thread is an object ON A BOOKING:
//     POST /api/bookings/:id/messages
//     GET  /api/bookings/:id/messages
// The registry mounts `bookings` BEFORE `messaging` (src/routes/index.js KNOWN_MODULES
// order) and the bookings router declares no `/:id/messages` route, so both requests fall
// through into this router — the same fall-through pattern U4-REVIEWS uses for
// /api/bookings/:id/reviews and U4-SAFETY for /api/bookings/:id/safety-alerts (build-plan
// §6.5). Nothing mounts at /api/messaging, and there is deliberately NO moderator
// thread-reading route: a moderator sees flagged content only through the moderation
// queue's excerpt view (data minimization — NFR-13).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-06 (TC-06) — POST persists the message with its 'moderation.scan' outbox row in one
//            transaction and answers 201 IMMEDIATELY (delivery never waits on the scan —
//            ADR-002); GET serves the thread to the booking's guest and the listing's host
//            only, hiding messages a moderation rejection has flagged (AB-04).
//   ADR-001/003 — no adapter, transport or outbox handler is imported here or by the
//            service: the request path only ever writes/reads rows; the scan runs in the
//            worker. Zero LLM adapter loads on this path (adr-conformance lane).
//   AB-08 / NFR-13 — both routes require a session (401 otherwise); responses are the
//            service's explicit allowlist — sender id, body, timestamps and lifecycle IDs
//            only. No email, phone, name, address or listing location is ever selected.
//   NFR-11 / AB-06 — body, query and params are validated through the ONE shared
//            validation middleware (src/schemas/messaging.js): hostile input is 422 or
//            inert sanitized data (ST-04), and the thread page is capped (NFR-02).
//   NFR-08 (MT-01) — req.log (correlation-scoped) flows into the service so every
//            message's audit record carries the originating request's correlation ID.
'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const messagingSchemas = require('../../schemas/messaging');
const { requireSession } = require('../auth/middleware');
const service = require('./service');

const router = express.Router();

// POST /api/bookings/:id/messages — send a message into the booking thread (FR-06).
// Returns 201 with the delivered message BEFORE any scan runs: moderation is asynchronous.
router.post(
  '/bookings/:id/messages',
  requireSession,
  validate({ params: messagingSchemas.messageParams, body: messagingSchemas.postMessageBody }),
  async (req, res, next) => {
    try {
      const message = await service.postMessage(req.auth.userId, req.params.id, req.body, {
        log: req.log,
      });
      res.status(201).json({ message });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/bookings/:id/messages — read the thread, participants only (FR-06), paginated
// oldest-first; rejected (flagged) messages are hidden (AB-04).
router.get(
  '/bookings/:id/messages',
  requireSession,
  validate({ params: messagingSchemas.messageParams, query: messagingSchemas.listMessagesQuery }),
  async (req, res, next) => {
    try {
      const result = await service.listMessages(req.auth.userId, req.params.id, req.query, {
        log: req.log,
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

module.exports = { basePath: '/api', router };
