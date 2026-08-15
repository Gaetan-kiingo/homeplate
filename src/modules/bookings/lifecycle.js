// src/modules/bookings/lifecycle.js — U3-BOOKINGS: the booking lifecycle vocabulary
// (outbox job types + notification events) and the deferred transitions built on it.
//
// Requirement traceability (SRS Appendix B):
//   FR-13 (TC-13, RT-02) — enqueueBookingNotification() writes the 'notify.booking' outbox
//                   row on the CALLER'S transaction client (ADR-001/003 — booking row and
//                   outbox row commit together, no dual write). Payloads carry IDs only,
//                   enforced by outbox.assertIdOnlyPayload at enqueue. The dedupe key is the
//                   idempotency key the worker hands the handler, so redelivery after a
//                   crash cannot double-send.
//                   Every §3.4 transition this module owns notifies: promoteDueBooking's
//                   pending → in_progress enqueues EVENTS.STARTED for the guest AND the host
//                   on its own transaction client (TCB-W3-03) — FR-13 covers "created,
//                   cancelled, or CHANGES STATUS", and that transition is the moment FR-04
//                   completion confirmation becomes possible for both parties.
//   FR-12 / FR-04  — promotion pending → in_progress is a PER-BOOKING SCHEDULED outbox job
//                   ('booking.promote', availableAt = the listing's scheduled_start;
//                   build-plan §6.4): transactional with the booking insert, idempotent
//                   under redelivery (conditional UPDATE — repo.promotePending), and
//                   self-repairing when a listing's start moves later (promoteDueBooking
//                   re-enqueues for the new instant). IT3-F1: a delivery that finds the
//                   start still in the future NEVER completes unless a pending promote row
//                   OTHER than the one being delivered survives for the current instant —
//                   an unchanged start reproduces the delivered row's own dedupe key, so
//                   the re-enqueue is secured (securePromotionSchedule) instead of being
//                   allowed to dedupe onto the very row the worker is about to mark
//                   delivered (which silently lost the promotion under DB/app clock skew
//                   or an operator requeue).
//   NFR-08 (MT-01) — promoteDueBooking() audit-logs the transition with the job's
//                   correlation ID (the worker scopes handlers via requestContext) and an
//                   EXPLICIT actor: a scheduler-driven transition has no user actor, so it
//                   records { actorUserId: null, actor: 'system:outbox' } instead of omitting
//                   the field (MT-01 requires an actor on every record).
//   NFR-09         — a promote job that finds nothing to do finishes cleanly; failures throw
//                   so the worker's retry/backoff/dead-letter budget applies.
//
// Request-path-safe: this module imports NO adapter (ADR-001/003) — only the outbox writer
// and the db layer. The worker-only side (transport delivery) lives in
// src/outbox/handlers/bookingNotifications.js.
//
// Public contract (build-plan §3): job types 'notify.booking' {bookingId, event,
// recipientUserId} with event ∈ EVENTS, and 'booking.promote' {bookingId} enqueued with
// availableAt = scheduled_start. U3-LISTINGS enqueues 'notify.booking' with event
// 'listing_cancelled' as a declared type string only — no code import (3A independence).
'use strict';

const { withTransaction } = require('../../db/tx');
const { logger, audit } = require('../../lib/logger');
// Namespace import (not destructured) so tests can inject an enqueue failure and prove the
// FR-13 same-transaction guarantee (both rows commit or neither — ADR-001/003).
const outbox = require('../../outbox/outbox');
const repo = require('./repo');

/** Outbox job type: deliver one booking notification to one recipient (FR-13). */
const NOTIFY_JOB_TYPE = 'notify.booking';

/** Outbox job type: promote one booking pending → in_progress at its scheduled start. */
const PROMOTE_JOB_TYPE = 'booking.promote';

/** The notification events the 'notify.booking' contract carries (build-plan §3).
 *  One member per §3.4 lifecycle transition that FR-13 calls out ("created, cancelled, or
 *  CHANGES STATUS"): created → started (pending → in_progress) → completed, plus the three
 *  cancellation flavours. STARTED closes TCB-W3-03 — the scheduled promotion used to move the
 *  booking to 'in_progress' silently, so neither party learned the meal window (and with it
 *  FR-04 completion confirmation) had opened. */
const EVENTS = Object.freeze({
  CREATED: 'created',
  STARTED: 'started', // pending → in_progress (promoteDueBooking); FR-13 status transition
  CANCELLED_BY_GUEST: 'cancelled_by_guest',
  CANCELLED_BY_HOST: 'cancelled_by_host',
  LISTING_CANCELLED: 'listing_cancelled', // enqueued by U3-LISTINGS' cancel path
  COMPLETED: 'completed',
});

const EVENT_VALUES = Object.freeze(Object.values(EVENTS));

/**
 * Enqueue one 'notify.booking' job per recipient on the caller's TRANSACTION client
 * (FR-13 — same transaction as the booking mutation; ADR-003 payload carries IDs only).
 * The dedupe key (booking × event × recipient) makes the enqueue idempotent and doubles as
 * the transport idempotency key in the worker (RT-02 exactly-once).
 *
 * @param {import('pg').PoolClient} client  the transaction client the booking write used
 * @param {{bookingId: string, event: string, recipientUserIds: string[]}} input
 */
async function enqueueBookingNotifications(client, { bookingId, event, recipientUserIds }) {
  if (!EVENT_VALUES.includes(event)) {
    throw new TypeError(`enqueueBookingNotifications: unknown event "${String(event)}"`);
  }
  const jobs = [];
  for (const recipientUserId of recipientUserIds) {
    const { job } = await outbox.enqueue(client, {
      type: NOTIFY_JOB_TYPE,
      payload: { bookingId, event, recipientUserId }, // IDs only (assertIdOnlyPayload)
      dedupeKey: `${NOTIFY_JOB_TYPE}:${bookingId}:${event}:${recipientUserId}`,
    });
    jobs.push(job);
  }
  return jobs;
}

/**
 * Enqueue the per-booking scheduled promotion job (availableAt = scheduled_start) on the
 * caller's transaction client. The dedupe key includes the target instant, so a listing
 * whose start moves later gets a FRESH job for the new instant (the delivered old job's key
 * never collides) while redundant enqueues for the same instant dedupe to one row.
 *
 * @param {import('pg').PoolClient} client
 * @param {{bookingId: string, scheduledStart: Date|string}} input
 */
async function enqueuePromotion(client, { bookingId, scheduledStart }) {
  const at = scheduledStart instanceof Date ? scheduledStart : new Date(scheduledStart);
  if (Number.isNaN(at.getTime())) {
    throw new TypeError('enqueuePromotion: scheduledStart must be a valid timestamp');
  }
  const { job } = await outbox.enqueue(client, {
    type: PROMOTE_JOB_TYPE,
    payload: { bookingId }, // IDs only (ADR-003)
    dedupeKey: promotionDedupeKey(bookingId, at.getTime()),
    availableAt: at,
  });
  return job;
}

/** The dedupe key for the promote job targeting one (booking, start-instant) pair. */
function promotionDedupeKey(bookingId, atMs) {
  return `${PROMOTE_JOB_TYPE}:${bookingId}:${atMs}`;
}

/**
 * Probe whether an outbox row is LIVE — still 'pending' AND not claim-locked by a worker
 * delivering it right now. FOR UPDATE SKIP LOCKED never blocks: a row locked by a worker's
 * claim (src/outbox/worker.js CLAIM_SQL holds the lock while the handler runs) is skipped,
 * and a row this probe does return stays locked on the caller's transaction only until it
 * commits, so a concurrent claim cannot spend it out from under the caller's decision.
 */
async function isLivePendingJob(client, jobRowId) {
  const { rows } = await client.query(
    `SELECT id FROM outbox_jobs WHERE id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED`,
    [jobRowId]
  );
  return rows.length > 0;
}

/**
 * IT3-F1 — guarantee that a pending 'booking.promote' row scheduled at `scheduledStart`
 * SURVIVES the delivery currently in progress. The naive re-enqueue is not enough: when the
 * listing's start is unchanged the new dedupe key is identical to the delivered row's own
 * key, so ON CONFLICT DO NOTHING collapses onto the very row the worker is about to mark
 * 'delivered' — and the promotion is silently lost (booking stays 'pending' forever, FR-04
 * completion 409s for both parties). Reachable in production with nothing more exotic than
 * the DB clock running ahead of the Node clock (available_at <= now() is evaluated by
 * PostgreSQL, startsAt > Date.now() by Node) or an operator requeue.
 *
 * A deduped-onto row only counts as the surviving schedule when it is (a) NOT the row being
 * delivered (deliveringJobId) and (b) genuinely live per isLivePendingJob. Otherwise a
 * second enqueue disambiguates the key with the delivering row's id, creating a fresh
 * pending row for the same instant.
 *
 * @param {import('pg').PoolClient} client  promoteDueBooking's transaction client
 * @param {{bookingId: string, scheduledStart: Date, deliveringJobId: string|null}} input
 * @returns {Promise<object|null>} the surviving job row, or null when none could be secured
 *   (the caller must then FAIL the delivery so the worker keeps the delivered row pending)
 */
async function securePromotionSchedule(client, { bookingId, scheduledStart, deliveringJobId }) {
  const baseKey = promotionDedupeKey(bookingId, scheduledStart.getTime());
  const attempt = async (dedupeKey) => {
    const { job, deduped } = await outbox.enqueue(client, {
      type: PROMOTE_JOB_TYPE,
      payload: { bookingId }, // IDs only (ADR-003)
      dedupeKey,
      availableAt: scheduledStart,
    });
    if (!deduped) return job; // fresh row committed with us — schedule secured
    if (deliveringJobId !== null && String(job.id) === String(deliveringJobId)) return null;
    return (await isLivePendingJob(client, job.id)) ? job : null;
  };
  const first = await attempt(baseKey);
  if (first) return first;
  // The base key collapsed onto the row being delivered (an unchanged start reproduces its
  // key exactly) or onto a spent/claimed row: disambiguate with the delivering row's id so
  // a genuinely fresh pending row can exist for the same instant.
  return attempt(`${baseKey}:r${deliveringJobId ?? 'direct'}`);
}

/**
 * The 'booking.promote' core, called by the worker handler when the job comes due:
 *   - booking gone / no longer 'pending' / listing no longer active → clean no-op;
 *   - listing's scheduled_start still in the FUTURE (moved later, or this row delivered
 *     early — DB/app clock skew, operator requeue) → secure a pending promote row for the
 *     current instant (securePromotionSchedule, IT3-F1) and finish; if no surviving row can
 *     be secured, THROW so the worker's retry/backoff keeps the delivered row pending
 *     (NFR-09) instead of silently losing the promotion;
 *   - otherwise → pending → in_progress (conditional UPDATE; idempotent under RT-02
 *     redelivery because a second delivery finds the booking no longer pending) PLUS one
 *     EVENTS.STARTED notify.booking row per participant on the same transaction (FR-13).
 *
 * @param {string} bookingId
 * @param {{log?: object, jobId?: string|null}} [ctx]  worker job context: correlationId-
 *   scoped logger (NFR-08) and the id of the outbox row being delivered (ctx.jobId), which
 *   the self-dedupe detection needs (IT3-F1); null when called outside the worker.
 * @returns {Promise<'promoted'|'rescheduled'|'noop'>}
 */
async function promoteDueBooking(bookingId, { log = logger, jobId = null } = {}) {
  return withTransaction(async (client) => {
    const found = await repo.selectBookingWithListing(bookingId, { client, lock: true });
    if (!found) {
      log.info(
        { event: 'booking_promote_noop', bookingId, reason: 'missing' },
        'booking_promote_noop'
      );
      return 'noop';
    }
    const { booking, listing } = found;
    if (booking.status !== 'pending') {
      // Cancelled (guest/host/listing) or already promoted — nothing to do (idempotent).
      log.info(
        { event: 'booking_promote_noop', bookingId, status: booking.status },
        'booking_promote_noop'
      );
      return 'noop';
    }
    if (listing.status !== 'active') {
      // Listing cancelled out from under a still-pending booking: never promote into a
      // cancelled listing; the listing-cancel flow owns the booking's cancellation.
      log.warn(
        { event: 'booking_promote_noop', bookingId, reason: 'listing_not_active' },
        'booking_promote_noop'
      );
      return 'noop';
    }
    const startsAt = new Date(listing.scheduled_start);
    if (startsAt.getTime() > Date.now()) {
      // Start still in the future: either the host moved it later, or this very row was
      // delivered early (IT3-F1). Only finish 'rescheduled' once a pending promote row
      // OTHER than the one being delivered is secured for the current instant — a naive
      // re-enqueue with an unchanged start dedupes onto the delivered row itself and the
      // promotion is silently lost.
      const secured = await securePromotionSchedule(client, {
        bookingId,
        scheduledStart: startsAt,
        deliveringJobId: jobId,
      });
      if (!secured) {
        const err = new Error(
          `booking.promote for ${bookingId} came due early (scheduled_start ` +
            `${startsAt.toISOString()} is still in the future) and no replacement row ` +
            'could be secured — failing the delivery so the worker keeps this row pending ' +
            '(retry/backoff, NFR-09) instead of silently losing the promotion (IT3-F1)'
        );
        err.code = 'BOOKING_PROMOTE_UNSECURED';
        throw err;
      }
      log.info(
        { event: 'booking_promote_rescheduled', bookingId, scheduledStart: startsAt.toISOString() },
        'booking_promote_rescheduled'
      );
      return 'rescheduled';
    }
    const promoted = await repo.promotePending(client, bookingId);
    if (!promoted) {
      // Lost a race with cancel between the locked read and here — conditional UPDATE says no.
      log.info(
        { event: 'booking_promote_noop', bookingId, reason: 'concurrent_transition' },
        'booking_promote_noop'
      );
      return 'noop';
    }
    // FR-13 (TCB-W3-03): pending → in_progress IS a status transition, so both affected
    // parties get one notify.booking row — enqueued on THIS transaction client, so the
    // transition and its notifications commit together or not at all (ADR-001/003, no dual
    // write). The dedupe key (booking × event × recipient) makes an RT-02 redelivery that
    // re-runs this block collapse onto the existing rows, so the guest and the host are told
    // exactly once that the meal window — and with it FR-04 completion — has opened.
    await enqueueBookingNotifications(client, {
      bookingId,
      event: EVENTS.STARTED,
      recipientUserIds: [booking.guest_id, listing.host_id],
    });
    // NFR-08 (MT-01): every audit record names an ACTOR. This transition has no human
    // actor — the scheduler fired it — so the system is recorded EXPLICITLY rather than the
    // field being omitted: `actorUserId: null` keeps the key present (pino emits nulls; it
    // drops undefined), so a reviewer filtering by actor still sees the record and can tell
    // "promoted by the scheduler" apart from "field dropped by a bug", and `actor` names
    // which system did it. Convention for every worker-emitted audit record: the pair
    // { actorUserId: null, actor: 'system:<subsystem>' }. `actor` is not a §3.4 PII-register
    // key and carries no suffix the logger redacts, so it survives the redaction pipeline.
    audit(log, {
      event: 'booking.promoted',
      outcome: 'success',
      actorUserId: null,
      actor: 'system:outbox',
      entityType: 'booking',
      entityId: bookingId,
    });
    return 'promoted';
  });
}

module.exports = {
  NOTIFY_JOB_TYPE,
  PROMOTE_JOB_TYPE,
  EVENTS,
  EVENT_VALUES,
  enqueueBookingNotifications,
  enqueuePromotion,
  promoteDueBooking,
};
