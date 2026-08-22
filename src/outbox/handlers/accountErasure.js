// src/outbox/handlers/accountErasure.js — U4-PRIVACY: the 'account.erasure' outbox handler
// — the ONLY place the NFR-12 erasure meets worker-only code (media adapter + notification
// transport), discovered by src/outbox/dispatch.js.
//
// Requirement traceability (SRS Appendix B):
//   NFR-12 (ST-05) — runs privacyService.processErasure at the job's scheduled instant
//            (available_at = deletion time + config.privacy.erasureDays): empties every
//            §3.4 PII column, deletes every owned media object BY KEY through the EXISTING
//            ADR-004 primitive mediaService.deleteForUser (one deleteByKey per key,
//            retryable on partial failure — never reimplemented here), rewrites
//            reviews/messages/safety alerts to anonymized references, stamps anonymized_at.
//            For inactivity-flagged accounts the first delivery sends the NFR-12 notice and
//            schedules the final erasure one notice window later (two-phase; the service
//            cancels if the user became active again).
//   FR-13 / ADR-011 — the inactivity notice goes through the ONE notification transport
//            (mock in dev/test → persisted NOTIFICATION_ATTEMPT row; SendGrid live), with
//            params carrying IDs only. Template 'inactivity-notice' has a registered
//            subject in the SendGrid registry.
//   ADR-001/003 — WORKER-ONLY adapter reach: this handler is the sole importer of
//            mediaService.deleteForUser's call site and (with the other handlers) of the
//            notifications transport; request handlers never touch either. A storage or
//            provider failure throws a retryable error, so the worker's
//            retry/backoff/dead-letter budget applies (NFR-09) while the account stays
//            soft-deleted (already invisible on every read path) until erasure succeeds.
//   NFR-08 (MT-01) — ctx.log carries the originating request's correlation ID into every
//            audit record the service emits; lines carry IDs and dates only (§3.4).
//
// Clock injection (build-plan §4D): ctx.now — set only by tests — is the simulated instant
// the job runs at; production omits it and the real clock applies. This is the injectable
// now() seam the plan prefers over fake timers, so PostgreSQL's own now() stays coherent.
//
// Handler contract (build-plan §1 convention 3): { type, handle(payload, ctx) } with ctx
// = { jobId, type, attempt, correlationId, idempotencyKey, log } (src/outbox/dispatch.js).
'use strict';

const { logger } = require('../../lib/logger');
// Worker-only imports (ADR-001/003): deleteForUser drives the object-storage adapter and
// the transport reaches src/adapters/* — legal here, never on a request path.
const mediaService = require('../../modules/media/service');
const transport = require('../../modules/notifications/transport');
const privacyService = require('../../modules/privacy/service');

const TYPE = privacyService.ERASURE_JOB_TYPE; // 'account.erasure'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = ['deletion', 'inactivity'];

module.exports = {
  type: TYPE,

  /**
   * @param {{userId: string, dataRequestId: string, reason?: 'deletion'|'inactivity'}} payload
   *   IDs only (ADR-003).
   * @param {{idempotencyKey?: string, log?: object, now?: Date|string}} [ctx]  worker job
   *   context; ctx.now is the test-only clock-injection seam.
   */
  async handle(payload, ctx = {}) {
    const log = ctx.log || logger;
    if (!payload || typeof payload !== 'object') {
      throw new TypeError(`${TYPE}: payload must be { userId, dataRequestId, reason }`);
    }
    const { userId, dataRequestId, reason = 'deletion' } = payload;
    if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
      throw new TypeError(`${TYPE}: payload.userId must be a UUID`);
    }
    if (typeof dataRequestId !== 'string' || !UUID_RE.test(dataRequestId)) {
      throw new TypeError(`${TYPE}: payload.dataRequestId must be a UUID`);
    }
    if (!REASONS.includes(reason)) {
      throw new TypeError(`${TYPE}: payload.reason must be one of ${REASONS.join(', ')}`);
    }

    return privacyService.processErasure(
      { userId, dataRequestId, reason },
      {
        // The EXISTING ADR-004 delete-by-key primitive — one deleteByKey call per owned
        // storage key, idempotent, retryable (proven against MinIO). Never reimplemented.
        deleteMedia: (ownerId) => mediaService.deleteForUser(ownerId),
        // ADR-011: the notice rides the one transport; dev/test resolve the mock that
        // records the NOTIFICATION_ATTEMPT row the suite asserts on. Params carry IDs only.
        sendNotice: ({ userId: recipientId, dataRequestId: requestId }) =>
          transport.send(
            {
              userId: recipientId,
              channel: 'email',
              template: 'inactivity-notice',
              params: { userId: recipientId, dataRequestId: requestId },
              // RT-02 exactly-once: a redelivered phase-1 job reuses the sent attempt row.
              idempotencyKey: `inactivity-notice:${requestId}`,
            },
            { log }
          ),
        now: ctx.now ? new Date(ctx.now) : new Date(),
        log,
      }
    );
  },
};
