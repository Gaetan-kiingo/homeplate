// src/modules/messaging/service.js — U4-MESSAGING: the FR-06 host↔guest booking thread
// (SPMP WA-4; build-plan §4 wave 4C).
//
// Requirement traceability (SRS Appendix B):
//   FR-06 (TC-06) — postMessage() runs ONE PostgreSQL transaction: participant/state check
//                   (the booking's guest or the listing's host only — 403 anyone else,
//                   404 unknown booking, 409 cancelled; pending/in_progress/completed all
//                   allowed) → messages INSERT → 'moderation.scan' outbox row via the
//                   published U4-MODERATION interface — all on the same client, so a
//                   message can never exist without its scan job (ADR-001/003 "no dual
//                   writes"). The message is persisted and RETURNED IMMEDIATELY: delivery
//                   never waits on the scan (ADR-002 — private messages deliver first,
//                   are scanned asynchronously). listMessages() gates identically and
//                   serves every non-rejected message, so the other participant reads a
//                   posted message at once regardless of scan state, and a later-flagged
//                   (rejected) message disappears from subsequent reads while it sits in
//                   the moderator queue (AB-04).
//   FR-08 / AB-04 — this module contains NO moderation verdict path: the scan runs in the
//                   worker (src/outbox/handlers/moderationScan.js) and only the
//                   U4-MODERATION repo ever flips a message's moderation_status.
//   NFR-13 / ADR-010 — serializeMessage() is an explicit allowlist: sender id, body,
//                   timestamps and lifecycle IDs only — never an email, phone, name or
//                   address, and no listing location data ever rides a message payload.
//                   There is deliberately NO moderator thread-reading surface beyond the
//                   moderation queue's flagged-content excerpt (data minimization): a
//                   moderator who is not a participant is 403 like any third party.
//   NFR-08 (MT-01) — every mutation (success AND refusal) writes one structured audit
//                   record through the request-scoped logger: actor + booking/message IDs
//                   and reason codes only — never the message text, never PII.
//   NFR-11 / AB-06 — all HTTP input is validated by src/schemas/messaging.js at the
//                   routes; this service only ever sees sanitized, bounded, typed values.
//
// Request-path-safe (ADR-001/003): this module imports NO adapter and no transport — only
// the db layer, the wave-3 bookings repo and the U4-MODERATION service (whose
// submitForReview is a pure outbox write; its LLM stage runs exclusively in the worker).
'use strict';

const { withTransaction } = require('../../db/tx');
const { ConflictError, ForbiddenError, NotFoundError } = require('../../lib/errors');
const { logger, audit } = require('../../lib/logger');
const bookingsRepo = require('../bookings/repo');
const moderationService = require('../moderation/service');
const repo = require('./repo');

/** Explicit-allowlist projection of one message (NFR-13/ADR-010 — never a row spread;
 *  sender id, body and timestamps only: no email/phone/address, no listing location). */
function serializeMessage(row) {
  return {
    id: row.id,
    bookingId: row.booking_id,
    senderId: row.sender_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

/**
 * The FR-06 participant/state gate shared by both verbs. Throws the acceptance refusal —
 * 404 unknown booking, 403 non-participant (moderators included — data minimization,
 * NFR-13), 409 cancelled — and returns the participant context otherwise.
 *
 * @param {{booking: object, listing: object, role: 'guest'|'host'|null}|null} found
 *        bookingsRepo.findParticipantBooking result (the published wave-3 contract)
 * @param {(err: Error, reason: string) => Error} refuse  audit-then-throw wrapper
 * @returns {{booking: object, listing: object, role: 'guest'|'host'}}
 */
function assertThreadOpen(found, refuse) {
  if (!found) {
    throw refuse(
      new NotFoundError('Booking not found', { code: 'BOOKING_NOT_FOUND' }),
      'BOOKING_NOT_FOUND'
    );
  }
  if (found.role === null) {
    throw refuse(
      new ForbiddenError('Only the guest or the host may use this booking thread.', {
        code: 'NOT_PARTICIPANT',
      }),
      'NOT_PARTICIPANT'
    );
  }
  if (found.booking.status === 'cancelled') {
    throw refuse(
      new ConflictError('This booking is cancelled; its thread is closed.', {
        code: 'BOOKING_CANCELLED',
      }),
      'BOOKING_CANCELLED'
    );
  }
  return found;
}

/**
 * Post one message into a booking thread (FR-06): persisted, scan enqueued, returned
 * immediately — delivery NEVER waits on moderation (ADR-002).
 *
 * @param {string} userId     authenticated caller (routes.js requires a session)
 * @param {string} bookingId  the booking whose thread is being written
 * @param {{body: string}} input  validated, sanitized body (src/schemas/messaging.js)
 * @param {{log?: object}} [ctx]  request-scoped logger (correlation ID — NFR-08)
 * @returns {Promise<object>} the serialized message (201 body)
 * @throws {NotFoundError} unknown booking (404)
 * @throws {ForbiddenError} caller is neither the guest nor the listing's host (403)
 * @throws {ConflictError} the booking is cancelled (409 BOOKING_CANCELLED)
 */
async function postMessage(userId, bookingId, { body } = {}, ctx = {}) {
  const log = ctx.log || logger;

  const refuse = (err, reason) => {
    audit(log, {
      event: 'message.sent',
      outcome: 'failure',
      actorUserId: userId,
      entityType: 'booking',
      entityId: bookingId,
      reason,
    });
    return err;
  };

  const created = await withTransaction(async (client) => {
    // The wave-3 published contract (build-plan §3): booking + caller relationship.
    const found = assertThreadOpen(
      await bookingsRepo.findParticipantBooking(bookingId, userId, client),
      refuse
    );

    const message = await repo.insertMessage(client, {
      bookingId,
      senderId: userId,
      body,
    });

    // Message row + its FR-08 scan job, SAME transaction (ADR-001/003 — no dual writes;
    // payload carries IDs only, enforced by outbox.assertIdOnlyPayload). The scan itself
    // runs LATER, in the worker: this request path loads no adapter and the 201 below
    // never waits on any classification (ADR-002 — deliver first, scan asynchronously).
    await moderationService.submitForReview(client, 'message', message.id);

    return { message, role: found.role };
  });

  // NFR-08: one structured audit record per mutation — IDs and the role only, never the
  // message text (§3.4: content is not log material).
  audit(log, {
    event: 'message.sent',
    outcome: 'success',
    actorUserId: userId,
    entityType: 'message',
    entityId: created.message.id,
    bookingId,
    role: created.role,
  });
  return serializeMessage(created.message);
}

/**
 * Read a booking thread (FR-06): participants only, same truth table as posting. Serves
 * every non-rejected message oldest-first — a pending message is already delivered
 * (ADR-002), a rejected one is hidden (AB-04).
 *
 * @param {string} userId     authenticated caller
 * @param {string} bookingId  the booking whose thread is being read
 * @param {{page: number, pageSize: number}} query  validated pagination (NFR-02 caps)
 * @param {{log?: object}} [ctx]  request-scoped logger (refusal audits — NFR-08)
 * @returns {Promise<{items: object[], page: number, pageSize: number, total: number}>}
 * @throws {NotFoundError|ForbiddenError|ConflictError} same gate as postMessage
 */
async function listMessages(userId, bookingId, { page = 1, pageSize = 20 } = {}, ctx = {}) {
  const log = ctx.log || logger;

  const refuse = (err, reason) => {
    // Reads mutate nothing, but a REFUSED thread access is still a security-relevant
    // event worth one structured record (AB-08 scraping visibility, NFR-08).
    audit(log, {
      event: 'message.thread_read',
      outcome: 'failure',
      actorUserId: userId,
      entityType: 'booking',
      entityId: bookingId,
      reason,
    });
    return err;
  };

  assertThreadOpen(await bookingsRepo.findParticipantBooking(bookingId, userId), refuse);

  const [rows, total] = await Promise.all([
    repo.listVisibleForBooking(bookingId, { page, pageSize }),
    repo.countVisibleForBooking(bookingId),
  ]);
  return {
    items: rows.map(serializeMessage),
    page,
    pageSize,
    total,
  };
}

module.exports = {
  postMessage,
  listMessages,
  // exported for the unit tests that pin the NFR-13 allowlist
  serializeMessage,
};
