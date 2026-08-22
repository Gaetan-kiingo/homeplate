// src/modules/safety/service.js — U4-SAFETY: the FR-07 safety-alert service (SPMP WA-5).
//
// Requirement traceability (SRS Appendix B):
//   FR-07 (TC-07, IT-04) — raiseAlert() runs ONE PostgreSQL transaction: participant check →
//                   safety_alerts INSERT (delivery_status 'pending') → 'safety.alert' outbox
//                   row, both on the same client. The request returns 201 having touched NO
//                   external service: notifying the moderator and attempting the emergency-
//                   contact email are the worker's job (src/outbox/handlers/safetyAlert.js),
//                   so a SendGrid outage can neither delay nor roll back the alert
//                   (ADR-001/003 "no dual writes"; ADR-011 email is the v1.0 channel).
//                   listAlertsForModerator() is the queue side of "notify the moderator": an
//                   alert is visible for review from the instant it is persisted and STAYS
//                   visible however its delivery ends — including after the outbox job
//                   dead-letters (FR-07 "remain visible for review").
//   FR-13          — the deferred-work contract is the shared outbox: payload carries IDs
//                   only ({alertId, bookingId}), enforced by outbox.assertIdOnlyPayload.
//   NFR-08 (MT-01) — every raise (success AND refusal) writes one audit record through the
//                   request-scoped logger: actor + booking/alert IDs, never PII.
//   NFR-09         — nothing on this path can fail because an external provider is down;
//                   the alert is durable before any delivery is attempted.
//   AB-04 (ST-02)  — escalateAlert() lets a Moderator raise a safety alert on the booking
//                   behind flagged content (POST /api/moderation/alerts): moderator-gated,
//                   the same one-transaction persist-and-defer as raiseAlert, and audited as
//                   'safety.alert_escalated' (success AND refusal) with the request
//                   correlation ID (NFR-08).
//   NFR-13 / AB-08 — the serializers below are explicit allowlists of IDs, lifecycle state
//                   and timestamps. No name, address, phone or emergency-contact value is
//                   selected by this module at all; the moderator queue exposes the listing
//                   and host IDs only, so seeing an exact address still requires the
//                   access-logged ADR-010 moderator path (src/modules/listings/access.js).
//
// Moderator-queue note (U4-SAFETY-COMPLETE, build-plan §5): the safety_alerts row itself is
// the FR-07 queue entry, surfaced to the Moderator role at GET /api/moderation/alerts and
// intact whatever delivery does — including after the outbox job dead-letters. On top of it
// the delivery worker files a UNIFIED-queue entry (a moderation_queue row of content_type
// 'safety_alert', migration 0006) through repo.fileUnifiedQueueEntry, gated on the 4A read
// model declaring support for the type (repo.unifiedQueueSupported — see the rationale
// there), so moderators work one queue once 4A serves it. A moderator can also ESCALATE
// (AB-04): POST /api/moderation/alerts raises a real booking-bound alert (escalateAlert
// below) that follows the normal deferred delivery path.
//
// Request-path-safe (ADR-001/003): this module imports NO adapter and no transport — only
// the outbox writer, the db layer and the wave-3 bookings repository.
'use strict';

const { withTransaction } = require('../../db/tx');
const { ForbiddenError, NotFoundError } = require('../../lib/errors');
const { logger, audit } = require('../../lib/logger');
const outbox = require('../../outbox/outbox');
const bookingsRepo = require('../bookings/repo');
const repo = require('./repo');

/** Outbox job type: deliver one safety alert (moderator notice + emergency contact email). */
const JOB_TYPE = 'safety.alert';

/** The role SRS §2.3 puts in charge of safety alerts. */
const MODERATOR_ROLE = 'moderator';

// ---- serialization (explicit allowlists — NFR-13) --------------------------------------------

/** The raiser's view of their own alert: IDs, delivery state, timestamps. */
function serializeAlert(alert) {
  return {
    id: alert.id,
    bookingId: alert.booking_id,
    raisedByUserId: alert.raised_by,
    deliveryStatus: alert.delivery_status,
    deliveredAt: alert.delivered_at,
    createdAt: alert.created_at,
  };
}

/** One moderator-queue entry: the alert plus the references needed to act on it. */
function serializeQueueEntry(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    bookingStatus: row.booking_status,
    listingId: row.listing_id,
    hostId: row.host_id,
    raisedByUserId: row.raised_by,
    deliveryStatus: row.delivery_status,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---- raise (FR-07) ---------------------------------------------------------------------------

/**
 * The ONE-transaction persist-and-defer both raise paths share: the safety_alerts row and
 * its 'safety.alert' outbox row commit together on the caller's client (ADR-001/003 — no
 * dual writes; payload IDs only; per-alert dedupe key, RT-02).
 * @param {import('pg').PoolClient} client
 * @param {{bookingId: string, raisedBy: string}} input
 * @returns {Promise<object>} the persisted alert row (delivery_status 'pending')
 */
async function persistAlertWithJob(client, { bookingId, raisedBy }) {
  const created = await repo.insertAlert(client, { bookingId, raisedBy });
  await outbox.enqueue(client, {
    type: JOB_TYPE,
    payload: { alertId: created.id, bookingId }, // IDs only (assertIdOnlyPayload)
    dedupeKey: `${JOB_TYPE}:${created.id}`,
  });
  return created;
}

/**
 * Raise a safety alert on a booking. Either participant may raise one — a guest in a host's
 * home and a host with a guest in their home are equally exposed — in ANY booking state: an
 * incident can surface during a pending, in-progress, completed or cancelled meal, and FR-07
 * puts no lifecycle condition on the alert.
 *
 * @param {string} userId     authenticated caller (routes.js requires a session)
 * @param {string} bookingId  the booking the alert concerns
 * @param {{log?: object}} [ctx]  request-scoped logger (correlation ID — NFR-08)
 * @returns {Promise<object>} the serialized alert (201 body)
 * @throws {NotFoundError} unknown booking
 * @throws {ForbiddenError} caller is neither the guest nor the listing's host
 */
async function raiseAlert(userId, bookingId, { log = logger } = {}) {
  const refuse = (err, reason) => {
    audit(log, {
      event: 'safety.alert_raised',
      outcome: 'failure',
      actorUserId: userId,
      entityType: 'booking',
      entityId: bookingId,
      reason,
    });
    return err;
  };

  const { alert, listingId, role } = await withTransaction(async (client) => {
    // The wave-3 published contract (build-plan §3): resolve booking + caller relationship.
    const found = await bookingsRepo.findParticipantBooking(bookingId, userId, client);
    if (!found) {
      throw refuse(
        new NotFoundError('Booking not found', { code: 'BOOKING_NOT_FOUND' }),
        'BOOKING_NOT_FOUND'
      );
    }
    if (found.role === null) {
      throw refuse(
        new ForbiddenError('Only the guest or the host may raise a safety alert on this booking.', {
          code: 'NOT_PARTICIPANT',
        }),
        'NOT_PARTICIPANT'
      );
    }

    // Alert row + its deferred delivery, SAME transaction (ADR-001/003 — no dual writes).
    const created = await persistAlertWithJob(client, { bookingId, raisedBy: userId });

    return { alert: created, listingId: found.listing.id, role: found.role };
  });

  audit(log, {
    event: 'safety.alert_raised',
    outcome: 'success',
    actorUserId: userId,
    entityType: 'safety_alert',
    entityId: alert.id,
    bookingId,
    listingId,
    role,
  });
  return serializeAlert(alert);
}

// ---- moderator escalation (AB-04) ------------------------------------------------------------

/**
 * A Moderator escalates flagged content by raising a safety alert on the booking behind it
 * (AB-04; POST /api/moderation/alerts). The alert is REAL and booking-bound: it is persisted
 * with the escalating moderator as raised_by, its 'safety.alert' outbox row commits in the
 * same transaction, and delivery follows the normal worker path — every Moderator is
 * notified, and the escalator's own emergency-contact leg resolves like any raiser's
 * (usually 'no_channel', which FR-07 records and never retries).
 *
 * The moderator need NOT be a participant of the booking — that exemption is the entire
 * point of the escalation clause. The booking must exist (404 otherwise). Success and every
 * refusal write one 'safety.alert_escalated' audit record through the request-scoped logger
 * (NFR-08 — correlation ID, IDs only).
 *
 * @param {{userId: string, roles?: string[]}} auth  req.auth
 * @param {{bookingId: string}} input  validated body (src/schemas/safety.js)
 * @param {{log?: object}} [ctx]
 * @returns {Promise<object>} the serialized alert (201 body)
 * @throws {ForbiddenError} caller lacks the Moderator role
 * @throws {NotFoundError} unknown booking
 */
async function escalateAlert(auth, { bookingId } = {}, { log = logger } = {}) {
  const userId = auth && auth.userId;
  const refuse = (err, reason) => {
    audit(log, {
      event: 'safety.alert_escalated',
      outcome: 'failure',
      actorUserId: userId ?? null,
      entityType: 'booking',
      entityId: bookingId,
      reason,
    });
    return err;
  };

  const roles = Array.isArray(auth && auth.roles) ? auth.roles : [];
  if (!roles.includes(MODERATOR_ROLE)) {
    throw refuse(
      new ForbiddenError('Only a moderator may escalate content to a safety alert.', {
        code: 'NOT_MODERATOR',
      }),
      'NOT_MODERATOR'
    );
  }

  const { alert, listingId } = await withTransaction(async (client) => {
    // Existence check through the published wave-3 contract; the role result is ignored —
    // a moderator escalates bookings they are no participant of.
    const found = await bookingsRepo.findParticipantBooking(bookingId, userId, client);
    if (!found) {
      throw refuse(
        new NotFoundError('Booking not found', { code: 'BOOKING_NOT_FOUND' }),
        'BOOKING_NOT_FOUND'
      );
    }
    const created = await persistAlertWithJob(client, { bookingId, raisedBy: userId });
    return { alert: created, listingId: found.listing.id };
  });

  audit(log, {
    event: 'safety.alert_escalated',
    outcome: 'success',
    actorUserId: userId,
    entityType: 'safety_alert',
    entityId: alert.id,
    bookingId,
    listingId,
  });
  return serializeAlert(alert);
}

// ---- moderator queue (FR-07) -----------------------------------------------------------------

/**
 * The FR-07 moderator alert queue (GET /api/moderation/alerts): every safety alert, newest
 * first, optionally filtered by delivery status. Restricted to the Moderator role (SRS §2.3);
 * every other authenticated caller is 403 — an alert list is exactly the kind of data AB-08
 * forbids serving to ordinary sessions.
 *
 * @param {{userId: string, roles?: string[]}} auth  req.auth
 * @param {{page: number, pageSize: number, status?: string}} query  validated query
 * @returns {Promise<{alerts: object[], page: number, pageSize: number, total: number}>}
 */
async function listAlertsForModerator(auth, { page, pageSize, status } = {}) {
  const roles = Array.isArray(auth && auth.roles) ? auth.roles : [];
  if (!roles.includes(MODERATOR_ROLE)) {
    throw new ForbiddenError('Only a moderator may read the safety-alert queue.', {
      code: 'NOT_MODERATOR',
    });
  }
  const [rows, total] = await Promise.all([
    repo.listForModerators({ page, pageSize, status }),
    repo.countForModerators({ status }),
  ]);
  return {
    alerts: rows.map(serializeQueueEntry),
    page,
    pageSize,
    total,
  };
}

module.exports = {
  JOB_TYPE,
  MODERATOR_ROLE,
  raiseAlert,
  escalateAlert,
  listAlertsForModerator,
  // exported for the unit tests that pin the NFR-13 allowlists
  serializeAlert,
  serializeQueueEntry,
};
