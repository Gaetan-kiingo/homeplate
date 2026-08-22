// src/modules/privacy/routes.js — U4-PRIVACY: the NFR-12/NFR-13 HTTP surface (mounted by
// the U1-HTTP route registry; build-plan §4D; SPMP WA-6).
//
// Mounting: this module exports { basePath: '/api', router } and declares its FULL paths
// itself, because deletion and export are actions on the ACCOUNT — they live under
// /api/users/me. The registry mounts `users` BEFORE `privacy` (src/routes/index.js
// KNOWN_MODULES order) and the users router declares only GET/PATCH /me, so DELETE /me and
// the /me/export paths fall through into this router — the same fall-through pattern
// U4-REVIEWS/U4-SAFETY use under /api/bookings/:id. Nothing mounts at /api/privacy.
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-12 (ST-05) — DELETE /api/users/me answers 202: the deletion is MARKED now (account
//            gone from every read path, sessions dead) and the §3.4 erasure runs at
//            now + config.privacy.erasureDays via the 'account.erasure' outbox job written
//            in the same transaction.
//   NFR-13 (ST-06) — POST /api/users/me/export answers 202 with the request row (30-day SLA
//            due date); GET /api/users/me/export/:id returns the OWNER's machine-readable
//            §3.4 register copy once the worker produced it.
//   AB-08 / NFR-13 — every route requires a session (401 otherwise) and operates on
//            req.auth.userId ONLY — no caller-supplied target user exists on this surface,
//            and the export lookup is owner-scoped (foreign ids are 404).
//   NFR-11 / AB-06 — all input is validated by the ONE shared middleware against
//            src/schemas/privacy.js (input-less routes still declare a schema).
//   ADR-001/003 — no adapter, transport or outbox handler is imported here or by the
//            service: the request path only writes rows; media deletion, the notice email
//            and the export assembly run in the worker.
//   NFR-08 (MT-01) — req.log (correlation-scoped) flows into the service so every audit
//            record carries the originating request's correlation ID.
'use strict';

const express = require('express');
const validate = require('../../middleware/validate');
const privacySchemas = require('../../schemas/privacy');
const { requireSession } = require('../auth/middleware');
const sessions = require('../auth/sessions');
const service = require('./service');

const router = express.Router();

// DELETE /api/users/me — NFR-12 account deletion. 202: accepted now, erased at the
// scheduled instant. The response also clears the session cookie (the Redis record is
// already destroyed by the service — AB-05).
router.delete(
  '/users/me',
  requireSession,
  validate({ query: privacySchemas.noInput }),
  async (req, res, next) => {
    try {
      const result = await service.requestDeletion(req.auth.userId, {
        sessionToken: sessions.tokenFromRequest(req),
        log: req.log,
      });
      sessions.clearSessionCookie(res);
      res.status(202).json({ request: result.request });
    } catch (err) {
      next(err);
    }
  }
);

// POST /api/users/me/export — NFR-13 CCPA export request. 202: the worker produces the
// copy; the due date is the statutory 30-day SLA, asserted by ST-06.
router.post(
  '/users/me/export',
  requireSession,
  validate({ body: privacySchemas.noInput }),
  async (req, res, next) => {
    try {
      const { request } = await service.requestExport(req.auth.userId, { log: req.log });
      res.status(202).json({ request });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/users/me/export/:id — the owner's view of one export request (data present once
// status is 'completed'; a foreign or unknown id is a plain 404 — AB-08).
router.get(
  '/users/me/export/:id',
  requireSession,
  validate({ params: privacySchemas.exportGetParams }),
  async (req, res, next) => {
    try {
      const exportRequest = await service.getExportForUser(req.auth.userId, req.params.id);
      res.status(200).json({ export: exportRequest });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = { basePath: '/api', router };
