// src/outbox/handlers/bookingNotifications.js — U3-BOOKINGS: worker-side delivery of every
// 'notify.booking' job (FR-13 end to end), discovered by src/outbox/dispatch.js. Follows the
// wave-2 emailVerification.js precedent: the feature unit owns its handler file, so wave 3
// closes the FR-13 loop and U4-NOTIFY keeps only non-booking handlers.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-13 (TC-13, RT-02) — booking created / cancelled / completed (and U3-LISTINGS'
//                   'listing_cancelled') notifications reach the recipient through the ONE
//                   wave-2 transport contract, which persists a NOTIFICATION_ATTEMPT row per
//                   send — mock in dev/test, SendGrid live (ADR-011). A failed delivery
//                   throws, so the worker's retry/backoff budget applies and the job
//                   dead-letters at config.outbox.maxAttempts with its reason recorded.
//   FR-14          — cancellation notices ride the same path (events cancelled_by_guest /
//                   cancelled_by_host / listing_cancelled).
//   ADR-001/003    — this file is the ONLY place booking notifications touch a transport:
//                   it runs exclusively under the outbox worker, never on a request path.
//                   The payload carries IDs only ({bookingId, event, recipientUserId} —
//                   enforced at enqueue by outbox.assertIdOnlyPayload); the transport
//                   resolves the recipient address at send time (§3.4 PII register).
//   RT-02          — ctx.idempotencyKey (the enqueue-side dedupe key
//                   'notify.booking:<bookingId>:<event>:<recipientUserId>') doubles as the
//                   transport idempotency key: a job redelivered after a worker crash reuses
//                   its NOTIFICATION_ATTEMPT row and can never double-send.
//   NFR-08 (MT-01) — ctx.log is the worker's job-scoped child logger carrying the
//                   originating request's correlationId into these lines.
//
// Handler contract (build-plan §1 convention 3): { type, handle(payload, ctx) } with ctx
// = { jobId, type, attempt, correlationId, idempotencyKey, log } (src/outbox/dispatch.js).
'use strict';

const { logger } = require('../../lib/logger');
// Worker-only import (ADR-001/003): the transport reaches src/adapters/*.
const transport = require('../../modules/notifications/transport');
const { NOTIFY_JOB_TYPE, EVENT_VALUES } = require('../../modules/bookings/lifecycle');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = {
  type: NOTIFY_JOB_TYPE,

  /**
   * Deliver one booking notification to one recipient (FR-13).
   * @param {{bookingId: string, event: string, recipientUserId: string}} payload IDs only
   * @param {{idempotencyKey?: string, log?: object}} [ctx]  worker job context
   * @returns {Promise<{status: 'sent', attemptId: string}>}
   * @throws on a malformed payload (a caller bug — retries then dead-letters) and on a
   *   failed delivery (so the worker retries with backoff and eventually dead-letters,
   *   keeping the attempt row visible — NFR-09)
   */
  async handle(payload, ctx = {}) {
    const log = ctx.log || logger;
    if (!payload || typeof payload !== 'object') {
      throw new TypeError(
        `${NOTIFY_JOB_TYPE}: payload must be { bookingId, event, recipientUserId }`
      );
    }
    const { bookingId, event, recipientUserId } = payload;
    if (typeof bookingId !== 'string' || !UUID_RE.test(bookingId)) {
      throw new TypeError(`${NOTIFY_JOB_TYPE}: payload.bookingId must be a UUID`);
    }
    if (typeof recipientUserId !== 'string' || !UUID_RE.test(recipientUserId)) {
      throw new TypeError(`${NOTIFY_JOB_TYPE}: payload.recipientUserId must be a UUID`);
    }
    if (!EVENT_VALUES.includes(event)) {
      throw new TypeError(
        `${NOTIFY_JOB_TYPE}: payload.event must be one of ${EVENT_VALUES.join(', ')}`
      );
    }

    // The enqueue-side dedupe key doubles as the transport idempotency key (RT-02).
    const idempotencyKey =
      ctx.idempotencyKey || `${NOTIFY_JOB_TYPE}:${bookingId}:${event}:${recipientUserId}`;

    // ADR-011: email is the v1.0 channel; the transport resolves mock/SendGrid by config
    // and refuses push while the gate is off. Params carry IDs only (§3.4 PII register).
    const result = await transport.send(
      {
        userId: recipientUserId,
        channel: 'email',
        template: `booking.${event}`,
        params: { bookingId, event },
        idempotencyKey,
      },
      { log }
    );

    if (result.status !== 'sent') {
      // Provider outage after the transport's own bounded retries: throw so the OUTBOX
      // retry/backoff/dead-letter budget takes over (NFR-09 — deferred, never dropped).
      throw new Error(
        `${NOTIFY_JOB_TYPE}: delivery failed (attempt row ${result.attemptId}); outbox will retry`
      );
    }
    return { status: result.status, attemptId: result.attemptId };
  },
};
