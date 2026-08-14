// src/modules/bookings/service.js — U3-BOOKINGS: the booking service — atomic reservation,
// cancellation, dual-confirmation completion, participant reads (SPMP WA-3, the never-cut
// core loop).
//
// Requirement traceability (SRS Appendix B):
//   FR-12 (TC-12, LT-01) — createBooking() runs ONE PostgreSQL transaction: per-guest
//                   advisory lock → AB-02 pending-cap check (409 BOOKING_LIMIT, zero rows
//                   written) → conditional capacity decrement (409 NO_CAPACITY when zero
//                   rows match) → booking INSERT → 'notify.booking' rows for guest + host
//                   AND the scheduled 'booking.promote' job, all on the same client.
//                   Eligibility (FR-09) is enforced by requireEligibility(RESERVE_SEAT) in
//                   routes.js BEFORE this service runs — an ineligible guest is 403 with no
//                   capacity work. Booking one's own listing → 409.
//   FR-14 (TC-14) — cancelBooking(): guest or host, strictly before scheduled_start;
//                   pending→cancelled + seat restore + notification rows in one transaction;
//                   repeat/concurrent cancels are idempotent (no double restore).
//   FR-04 (TC-04) — confirmCompletion(): only while 'in_progress'; one confirmation reports
//                   awaiting-the-other; both flags → 'completed' + completed_at (migration
//                   0004); repeats are 200 no-ops; third parties 403.
//   FR-13 (TC-13, RT-02) — every state change enqueues its notifications transactionally
//                   via lifecycle.enqueueBookingNotifications (IDs only); NO adapter or
//                   transport is imported here (ADR-001/003 — delivery is worker-only).
//   AB-02          — the cap + audit trail: every create/cancel writes an MT-01 audit
//                   record (actor + booking IDs) so hoarding patterns are reconstructable.
//   NFR-08 (MT-01) — audit records with correlation IDs on every mutation, success AND
//                   refusal; IDs only, never PII.
//   NFR-11         — all input pre-validated by src/schemas/bookings.js; all SQL
//                   parameterized in ./repo.
//   ADR-010        — serializeBooking() is an explicit allowlist: the embedded listing
//                   carries PUBLIC fields only (coarse coordinates, area label, city);
//                   street address / precise coordinates are never selected by this module.
'use strict';

const config = require('../../config');
const { withTransaction } = require('../../db/tx');
const { ConflictError, ForbiddenError, NotFoundError } = require('../../lib/errors');
const { logger, audit } = require('../../lib/logger');
const repo = require('./repo');
const lifecycle = require('./lifecycle');

// ---- serialization (ADR-010 allowlist) -------------------------------------------------------

/** Public-fields-only listing reference for booking payloads (ADR-010: the privileged
 *  address lives ONLY behind GET /api/listings/:id — never in a booking response). */
function serializeListingRef(listing) {
  return {
    id: listing.id,
    hostId: listing.host_id,
    title: listing.title,
    cuisine: listing.cuisine,
    scheduledStart: listing.scheduled_start,
    durationMinutes: listing.duration_minutes,
    city: listing.city,
    areaLabel: listing.area_label,
    coarseLat: listing.coarse_lat,
    coarseLng: listing.coarse_lng,
    status: listing.status,
  };
}

/** Explicit allowlist for the booking wire shape — IDs, lifecycle state and timestamps only. */
function serializeBooking(booking, listing, role = null) {
  return {
    id: booking.id,
    listingId: booking.listing_id,
    guestId: booking.guest_id,
    status: booking.status,
    guestConfirmedCompletion: booking.guest_confirmed_completion,
    hostConfirmedCompletion: booking.host_confirmed_completion,
    cancelledAt: booking.cancelled_at,
    completedAt: booking.completed_at,
    createdAt: booking.created_at,
    updatedAt: booking.updated_at,
    ...(role !== null ? { role } : {}),
    listing: serializeListingRef(listing),
  };
}

// ---- create (FR-12 / AB-02 / FR-13) ----------------------------------------------------------

/**
 * Reserve one seat atomically. See the module header for the exact transaction script.
 * @param {string} guestId  authenticated caller (routes.js — FR-09 gate already passed)
 * @param {string} listingId
 * @param {{log?: object}} [ctx]  request-scoped logger (correlation ID — NFR-08)
 * @returns {Promise<object>} serialized booking (201 body)
 */
async function createBooking(guestId, listingId, { log = logger } = {}) {
  const refuse = (err, reason) => {
    audit(log, {
      event: 'booking.created',
      outcome: 'failure',
      actorUserId: guestId,
      entityType: 'listing',
      entityId: listingId,
      reason,
    });
    return err;
  };

  const { booking, listing } = await withTransaction(async (client) => {
    // (1) AB-02 race-free cap: serialize this guest's create attempts for the transaction.
    await repo.lockGuestForBooking(client, guestId);

    // (2) Per-guest concurrent pending cap (config, never inline — FR-12).
    const pendingCount = await repo.countPendingForGuest(client, guestId);
    if (pendingCount >= config.booking.maxConcurrentPending) {
      throw refuse(
        new ConflictError(
          `You already have ${pendingCount} pending bookings — complete or cancel one first.`,
          { code: 'BOOKING_LIMIT', details: { limit: config.booking.maxConcurrentPending } }
        ),
        'BOOKING_LIMIT'
      );
    }

    // (3) Classify the listing BEFORE the decrement so refusals carry honest statuses.
    const target = await repo.selectListing(client, listingId);
    if (!target) {
      throw refuse(
        new NotFoundError('Listing not found', { code: 'LISTING_NOT_FOUND' }),
        'LISTING_NOT_FOUND'
      );
    }
    if (target.host_id === guestId) {
      throw refuse(
        new ConflictError('You cannot book a seat on your own listing.', { code: 'OWN_LISTING' }),
        'OWN_LISTING'
      );
    }
    if (target.moderation_status !== 'approved') {
      // FR-08 pending-until-approved: an unapproved listing is publicly invisible — 404,
      // indistinguishable from "does not exist" (no moderation-state oracle).
      throw refuse(
        new NotFoundError('Listing not found', { code: 'LISTING_NOT_FOUND' }),
        'LISTING_NOT_APPROVED'
      );
    }
    if (target.status !== 'active') {
      throw refuse(
        new ConflictError('This listing has been cancelled.', { code: 'LISTING_NOT_BOOKABLE' }),
        'LISTING_CANCELLED'
      );
    }
    if (new Date(target.scheduled_start).getTime() <= Date.now()) {
      throw refuse(
        new ConflictError('This listing has already started.', { code: 'LISTING_STARTED' }),
        'LISTING_STARTED'
      );
    }

    // (4) The atomic conditional decrement — the ONLY capacity authority (FR-12).
    const decremented = await repo.decrementSeat(client, listingId);
    if (!decremented) {
      throw refuse(
        new ConflictError('No seats remaining on this listing.', { code: 'NO_CAPACITY' }),
        'NO_CAPACITY'
      );
    }

    // (5) Booking row + its deferred work, same client (ADR-001/003 — no dual writes).
    const created = await repo.insertBooking(client, { listingId, guestId });
    await lifecycle.enqueueBookingNotifications(client, {
      bookingId: created.id,
      event: lifecycle.EVENTS.CREATED,
      recipientUserIds: [guestId, decremented.host_id],
    });
    await lifecycle.enqueuePromotion(client, {
      bookingId: created.id,
      scheduledStart: decremented.scheduled_start,
    });

    return {
      booking: created,
      listing: { ...target, seats_remaining: decremented.seats_remaining },
    };
  });

  audit(log, {
    event: 'booking.created',
    outcome: 'success',
    actorUserId: guestId,
    entityType: 'booking',
    entityId: booking.id,
    listingId,
  });
  return serializeBooking(booking, listing, 'guest');
}

// ---- cancel (FR-14 / FR-13) ------------------------------------------------------------------

/**
 * Cancel a pending booking before the listing starts (guest or host). Idempotent: a repeat
 * or concurrent cancel returns the cancelled state without touching capacity again.
 * @returns {Promise<object>} serialized booking (200 body)
 */
async function cancelBooking(userId, bookingId, { log = logger } = {}) {
  const outcome = await withTransaction(async (client) => {
    const found = await repo.selectBookingWithListing(bookingId, { client, lock: true });
    if (!found) {
      throw new NotFoundError('Booking not found', { code: 'BOOKING_NOT_FOUND' });
    }
    const { booking, listing } = found;

    let role = null;
    if (booking.guest_id === userId) role = 'guest';
    else if (listing.host_id === userId) role = 'host';
    if (role === null) {
      // Non-participant (TC-14) — refuse before revealing any state transition.
      throw new ForbiddenError('Only the guest or the host may cancel this booking.', {
        code: 'NOT_PARTICIPANT',
      });
    }

    if (booking.status === 'cancelled') {
      // Idempotent repeat: no restore, no new notifications, same terminal state.
      return { booking, listing, role, idempotent: true };
    }

    // The atomic transition: pending → cancelled strictly before scheduled_start (FR-14).
    const cancelled = await repo.markCancelledBeforeStart(client, bookingId);
    if (!cancelled) {
      // Zero rows: classify. (The FOR UPDATE lock above means no concurrent transition can
      // be in flight NOW — the row's current state is the truth.)
      if (new Date(listing.scheduled_start).getTime() <= Date.now()) {
        throw new ConflictError(
          'The meal has already started — this booking can no longer be cancelled.',
          {
            code: 'CANCEL_TOO_LATE',
          }
        );
      }
      throw new ConflictError(`A ${booking.status} booking cannot be cancelled.`, {
        code: 'BOOKING_NOT_CANCELLABLE',
        details: { status: booking.status },
      });
    }

    // Seat restore + notifications, SAME transaction (FR-14/FR-13; CHECK backstops ≤ capacity).
    const restored = await repo.restoreSeat(client, booking.listing_id);
    await lifecycle.enqueueBookingNotifications(client, {
      bookingId,
      event:
        role === 'guest' ? lifecycle.EVENTS.CANCELLED_BY_GUEST : lifecycle.EVENTS.CANCELLED_BY_HOST,
      recipientUserIds: [booking.guest_id, listing.host_id],
    });
    return {
      booking: cancelled,
      listing: {
        ...listing,
        seats_remaining: restored ? restored.seats_remaining : listing.seats_remaining,
      },
      role,
      idempotent: false,
    };
  });

  audit(log, {
    event: 'booking.cancelled',
    outcome: 'success',
    actorUserId: userId,
    entityType: 'booking',
    entityId: bookingId,
    role: outcome.role,
    idempotent: outcome.idempotent,
  });
  return serializeBooking(outcome.booking, outcome.listing, outcome.role);
}

// ---- confirm completion (FR-04 / FR-13) ------------------------------------------------------

/**
 * Record the caller's completion confirmation (FR-04). Both parties confirmed →
 * status 'completed' + completed_at; a lone confirmation reports awaiting the other party;
 * repeats are 200 no-ops.
 * @returns {Promise<{booking: object, awaitingOtherParty: boolean}>}
 */
async function confirmCompletion(userId, bookingId, { log = logger } = {}) {
  const outcome = await withTransaction(async (client) => {
    const found = await repo.selectBookingWithListing(bookingId, { client, lock: true });
    if (!found) {
      throw new NotFoundError('Booking not found', { code: 'BOOKING_NOT_FOUND' });
    }
    const { booking, listing } = found;

    let role = null;
    if (booking.guest_id === userId) role = 'guest';
    else if (listing.host_id === userId) role = 'host';
    if (role === null) {
      throw new ForbiddenError('Only the guest or the host may confirm this booking.', {
        code: 'NOT_PARTICIPANT',
      });
    }

    const ownFlag =
      role === 'guest' ? booking.guest_confirmed_completion : booking.host_confirmed_completion;

    if (booking.status === 'completed') {
      // Terminal + both flags set (0001 CHECK): any repeat confirmation is a no-op (TC-04).
      return { booking, listing, role, transitioned: false, noop: true };
    }
    if (booking.status !== 'in_progress') {
      // pending (meal not started) or cancelled — confirmation is meaningless (409).
      throw new ConflictError(`A ${booking.status} booking cannot be confirmed as completed.`, {
        code: 'BOOKING_NOT_IN_PROGRESS',
        details: { status: booking.status },
      });
    }
    if (ownFlag) {
      // Same party confirming twice while still awaiting the other: idempotent no-op.
      return { booking, listing, role, transitioned: false, noop: true };
    }

    const updated = await repo.applyCompletionConfirmation(client, bookingId, role);
    if (!updated) {
      // Unreachable while we hold the row lock, but fail loudly rather than lie.
      throw new ConflictError('Booking is no longer in progress.', {
        code: 'BOOKING_NOT_IN_PROGRESS',
      });
    }
    const transitioned = updated.status === 'completed';
    if (transitioned) {
      // FR-13: the status change notifies both parties — same transaction, IDs only.
      await lifecycle.enqueueBookingNotifications(client, {
        bookingId,
        event: lifecycle.EVENTS.COMPLETED,
        recipientUserIds: [booking.guest_id, listing.host_id],
      });
    }
    return { booking: updated, listing, role, transitioned, noop: false };
  });

  audit(log, {
    event: outcome.transitioned ? 'booking.completed' : 'booking.completion_confirmed',
    outcome: 'success',
    actorUserId: userId,
    entityType: 'booking',
    entityId: bookingId,
    role: outcome.role,
    noop: outcome.noop,
  });
  return {
    booking: serializeBooking(outcome.booking, outcome.listing, outcome.role),
    awaitingOtherParty: outcome.booking.status === 'in_progress',
  };
}

// ---- reads -----------------------------------------------------------------------------------

/**
 * One booking, participant-only (GET /api/bookings/:id): 404 unknown id, 403 non-participant.
 * The embedded listing is the ADR-010 public reference — never the street address.
 */
async function getBooking(userId, bookingId) {
  const found = await repo.findParticipantBooking(bookingId, userId);
  if (!found) {
    throw new NotFoundError('Booking not found', { code: 'BOOKING_NOT_FOUND' });
  }
  if (found.role === null) {
    throw new ForbiddenError('Only the guest or the host may view this booking.', {
      code: 'NOT_PARTICIPANT',
    });
  }
  return serializeBooking(found.booking, found.listing, found.role);
}

/** The caller's own bookings (GET /api/bookings), newest first, paginated. */
async function listBookings(userId, { page, pageSize, role, status } = {}) {
  const rows = await repo.listForUser(userId, { page, pageSize, role, status });
  return {
    bookings: rows.map(({ booking, listing }) =>
      serializeBooking(booking, listing, booking.guest_id === userId ? 'guest' : 'host')
    ),
    page,
    pageSize,
  };
}

module.exports = {
  createBooking,
  cancelBooking,
  confirmCompletion,
  getBooking,
  listBookings,
  // exported for the unit tests that pin the ADR-010 allowlist
  serializeBooking,
};
