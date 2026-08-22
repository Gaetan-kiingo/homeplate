// src/outbox/handlers/dataExport.js — U4-PRIVACY: the 'data.export' outbox handler — the
// worker side of the NFR-13 CCPA export, discovered by src/outbox/dispatch.js.
//
// Requirement traceability (SRS Appendix B):
//   NFR-13 (ST-06) — runs privacyService.processExport: assembles the machine-readable copy
//            of every SRS §3.4 PII-register class for the REQUESTING USER ONLY and stores
//            it on the data_requests row, where GET /api/users/me/export/:id serves it to
//            its owner. The job was enqueued in the same transaction as the request row
//            (due date = the 30-day statutory SLA) and runs immediately.
//   ADR-003 — the outbox payload carries {userId, dataRequestId} ONLY; the export CONTENT
//            never rides a payload — it exists in PostgreSQL and nowhere else, and is wiped
//            again by account erasure (repo.wipeExportDetails).
//   ADR-001/003 — pure PostgreSQL work: no adapter is imported or reached here, but the
//            assembly still runs in the worker so a large register read can never sit on a
//            request path (NFR-01).
//   NFR-08 (MT-01) — ctx.log carries the originating request's correlation ID into the
//            completion audit record; IDs and dates only (§3.4 PII register).
//
// Clock injection (build-plan §4D): ctx.now — set only by tests — is the simulated instant;
// production omits it and the real clock applies.
'use strict';

const { logger } = require('../../lib/logger');
const privacyService = require('../../modules/privacy/service');

const TYPE = privacyService.EXPORT_JOB_TYPE; // 'data.export'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = {
  type: TYPE,

  /**
   * @param {{userId: string, dataRequestId: string}} payload  IDs only (ADR-003).
   * @param {{log?: object, now?: Date|string}} [ctx]  worker job context; ctx.now is the
   *   test-only clock-injection seam.
   */
  async handle(payload, ctx = {}) {
    const log = ctx.log || logger;
    if (!payload || typeof payload !== 'object') {
      throw new TypeError(`${TYPE}: payload must be { userId, dataRequestId }`);
    }
    const { userId, dataRequestId } = payload;
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
      throw new TypeError(`${TYPE}: payload.userId must be a UUID`);
    }
    if (typeof dataRequestId !== 'string' || !UUID_RE.test(dataRequestId)) {
      throw new TypeError(`${TYPE}: payload.dataRequestId must be a UUID`);
    }

    return privacyService.processExport(
      { userId, dataRequestId },
      { now: ctx.now ? new Date(ctx.now) : new Date(), log }
    );
  },
};
