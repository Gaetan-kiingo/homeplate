// src/outbox/handlers/bookingPromote.js — U3-BOOKINGS: worker-side execution of the
// per-booking scheduled 'booking.promote' job (pending → in_progress at scheduled_start),
// discovered by src/outbox/dispatch.js.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-04 / FR-12  — the §3.4 booking lifecycle's pending → in_progress transition happens
//                   HERE, when the job enqueued at creation (availableAt = the listing's
//                   scheduled_start — build-plan §6.4) comes due. Completion confirmation
//                   (FR-04) only accepts bookings this transition has moved to
//                   'in_progress'.
//   ADR-001/003    — the job was enqueued in the SAME transaction as the booking insert;
//                   this handler runs only under the outbox worker. All the actual logic
//                   lives in src/modules/bookings/lifecycle.promoteDueBooking so nothing
//                   worker-only leaks into the request path and vice versa.
//   RT-02          — idempotent under redelivery: the transition is a conditional UPDATE
//                   (status='pending' only), so a job delivered twice — or racing a
//                   cancellation — no-ops cleanly the second time.
//   NFR-09         — a booking already cancelled → clean no-op; a listing whose start moved
//                   later → the handler re-enqueues a fresh job for the new instant and
//                   finishes (self-repairing schedule); a real failure throws so the
//                   worker's retry/backoff/dead-letter budget applies.
//   NFR-08 (MT-01) — ctx.log carries the originating request's correlationId; the promoted
//                   transition writes an audit record (lifecycle.js).
//
// Handler contract (build-plan §1 convention 3): { type, handle(payload, ctx) }.
'use strict';

const { logger } = require('../../lib/logger');
const lifecycle = require('../../modules/bookings/lifecycle');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = {
  type: lifecycle.PROMOTE_JOB_TYPE,

  /**
   * Promote one due booking (or re-schedule / no-op — see lifecycle.promoteDueBooking).
   * ctx.jobId (the outbox row being delivered) is passed through so a delivery that finds
   * the start still in the future can detect a re-enqueue deduping onto its OWN row and
   * secure a fresh one instead of losing the schedule (IT3-F1).
   * @param {{bookingId: string}} payload  IDs only (ADR-003)
   * @param {{log?: object, jobId?: string}} [ctx]  worker job context
   * @returns {Promise<{outcome: 'promoted'|'rescheduled'|'noop'}>}
   * @throws on a malformed payload (caller bug — retries then dead-letters) and on any
   *   database failure (worker retry/backoff applies)
   */
  async handle(payload, ctx = {}) {
    const log = ctx.log || logger;
    if (!payload || typeof payload !== 'object') {
      throw new TypeError(`${lifecycle.PROMOTE_JOB_TYPE}: payload must be { bookingId }`);
    }
    const { bookingId } = payload;
    if (typeof bookingId !== 'string' || !UUID_RE.test(bookingId)) {
      throw new TypeError(`${lifecycle.PROMOTE_JOB_TYPE}: payload.bookingId must be a UUID`);
    }
    const outcome = await lifecycle.promoteDueBooking(bookingId, {
      log,
      jobId: ctx.jobId ?? null,
    });
    return { outcome };
  },
};
