// src/modules/listings/service.js — U3-LISTINGS: the FR-11 listing lifecycle service
// (build-plan wave 3A; SPMP WA-2).
//
// Requirement traceability (SRS Appendix B):
//   FR-11 (TC-11) — create/update/cancel with the single MEHKO enforcement point
//            (./mehko.assertWithinCaps) consulted on EVERY create/update path; the 0002
//            unique-index 23505 is mapped to the same 409 MEHKO_DAILY_LISTING_LIMIT so
//            concurrent duplicates lose deterministically. Owner-only mutation (403).
//            Cancel cascades to active bookings and enqueues one notify.booking job per
//            affected guest IN THE SAME TRANSACTION (FR-13, ADR-001/003).
//   FR-02 (TC-02) — getListing: full detail with image URLs from media_objects keys, PLUS —
//            in the SAME response — the host summary (display name, bio, average rating,
//            review count) and the approved reviews about the host, loaded through the
//            U3-HOSTS-MEDIA repo/serializer pair (../hosts) so this page and the FR-03 host
//            page can never disagree on what is public (NFR-13: those queries never select
//            email/phone/address columns). Pending/rejected listings are 404 to everyone but
//            the owning host; the exact address/precise coordinates ride ONLY the privileged
//            serializer behind ./access.canViewPreciseLocation (ADR-010).
//   FR-08  — listings are born moderation_status='pending' and a moderation.scan job is
//            enqueued in the creating transaction; a MATERIAL edit (title/description/
//            ingredients/allergens/cuisine) resets to 'pending' and re-enqueues. The scan
//            handler lands in wave 4 (U4-MODERATION): until then jobs retry then dead-letter
//            and content STAYS PENDING — FR-08's required failure direction (build-plan §6.2).
//   FR-09  — creation is gated by requireEligibility(PUBLISH_LISTING) at the route; this
//            service never re-implements eligibility (ADR-006 single-interface rule).
//   NFR-08 (MT-01) — every mutation writes one structured audit record (event, actor, entity,
//            outcome, host id + local date per AB-07) through a request-scoped logger, so the
//            correlation ID rides every line and into the outbox rows.
//   NFR-11 — all SQL parameterized (repo/mehko); input shapes validated at the boundary
//            (src/schemas/listings.js).
//   NFR-13 / AB-08 — responses are serializer allowlists only; logs carry IDs, field NAMES
//            and dates — never address text or other personal data.
//   AB-01 / AB-03 — pending-until-approved plus the MEHKO caps make fake/spam listings
//            invisible and rate-bounded; AB-07 — one enforcement point, logged creations.
//   ADR-001/003 — geocoding is DEFERRED: the request path only persists address fields and
//            enqueues listing.geocode (worker-only Maps call). A Maps outage never blocks or
//            delays creation (NFR-09). No adapter is imported anywhere in this module.
'use strict';

const { withTransaction } = require('../../db/tx');
const outbox = require('../../outbox/outbox');
const requestContext = require('../../middleware/requestContext');
const { audit } = require('../../lib/logger');
const { ConflictError, ForbiddenError, NotFoundError } = require('../../lib/errors');
const repo = require('./repo');
const mehko = require('./mehko');
const access = require('./access');
const serializers = require('./serializers');
// U3-HOSTS-MEDIA primitives for the FR-02 host context (PII-minimized at the query — the
// hosts repo never selects email/phone/address columns; NFR-13/ADR-010 stay intact).
const hostsRepo = require('../hosts/repo');
const hostSerializers = require('../hosts/serializers');
const { PROFILE_REVIEWS_LIMIT } = require('../hosts/service');

// Outbox job types this unit publishes (build-plan wave-3A contract).
const JOB_LISTING_GEOCODE = 'listing.geocode';
const JOB_MODERATION_SCAN = 'moderation.scan';
const JOB_NOTIFY_BOOKING = 'notify.booking'; // handler owned by U3-BOOKINGS

// A change to any of these fields is a MATERIAL content edit: moderation resets to pending
// and a fresh moderation.scan is enqueued (FR-08, FR-11 acceptance).
const MATERIAL_FIELDS = Object.freeze([
  'title',
  'description',
  'ingredients',
  'allergens',
  'cuisine',
]);

// A change to any of these invalidates the stored geocode → re-enqueue listing.geocode.
const ADDRESS_FIELDS = Object.freeze([
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postalCode',
  'country',
]);

const ADDRESS_COLUMN = Object.freeze({
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  city: 'city',
  region: 'region',
  postalCode: 'postal_code',
  country: 'country',
});

function logFor(opts = {}) {
  return opts.log || requestContext.getLogger();
}

/** True when the 23505 came from the FR-11/AB-07 daily-uniqueness backstop index. */
function isDailyLimitViolation(err) {
  return err && err.code === '23505' && err.constraint === 'listings_host_local_date_key';
}

function dailyLimitConflict(cause) {
  return new ConflictError(
    'This host already has a listing on that day (one listing per host per day).',
    { code: 'MEHKO_DAILY_LISTING_LIMIT', cause }
  );
}

/** Deep-equal for the patch comparison (arrays of strings, nullable scalars). */
function sameValue(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ---- create ----------------------------------------------------------------------------------

/**
 * FR-11 create: MEHKO-checked insert + listing.geocode + moderation.scan, one transaction.
 * @param {{userId: string}} auth  req.auth of the eligibility-gated host (FR-09 at the route)
 * @param {object} input           validated body (src/schemas/listings.js create)
 * @returns {Promise<object>} the owner's privileged projection of the new listing
 */
async function createListing(auth, input, opts = {}) {
  const log = logFor(opts);
  const hostId = auth.userId;

  let row;
  try {
    row = await withTransaction(async (client) => {
      // ADR-009: THE single enforcement point; local_date is ITS output, never the caller's.
      const { localDate } = await mehko.assertWithinCaps(client, {
        hostId,
        scheduledStart: input.scheduledStart,
        seatCapacity: input.seatCapacity,
      });

      const inserted = await repo.insertListing(client, { ...input, hostId, localDate });

      // Deferred geocoding (ADR-001/003): worker-only Maps call; outage never blocks create.
      await outbox.enqueue(client, {
        type: JOB_LISTING_GEOCODE,
        payload: { listingId: inserted.id },
      });
      // FR-08 substrate: pending until approved; scan handler lands in wave 4.
      await outbox.enqueue(client, {
        type: JOB_MODERATION_SCAN,
        payload: { contentType: 'listing', contentId: inserted.id },
      });
      return inserted;
    });
  } catch (err) {
    if (isDailyLimitViolation(err)) {
      // Concurrency race loser: the 0002 unique index fired after our in-transaction count.
      audit(log, {
        event: 'listing.created',
        outcome: 'failure',
        actorUserId: hostId,
        entityType: 'listing',
        reason: 'MEHKO_DAILY_LISTING_LIMIT',
      });
      throw dailyLimitConflict(err);
    }
    throw err;
  }

  // AB-07 / NFR-08: creations logged with host ID and local date (IDs + dates only).
  audit(log, {
    event: 'listing.created',
    outcome: 'success',
    actorUserId: hostId,
    entityType: 'listing',
    entityId: row.id,
    hostId,
    localDate: String(row.local_date),
    seatCapacity: row.seat_capacity,
    moderationStatus: row.moderation_status,
  });

  return serializers.privilegedListing(row, []);
}

// ---- read ------------------------------------------------------------------------------------

/**
 * FR-02 host context: the host summary + the approved reviews about the host, riding the
 * SAME detail response (the FR-02/TC-02 acceptance — a client never needs a second call).
 * Composed exclusively from the U3-HOSTS-MEDIA repo (non-PII columns only — NFR-13) and its
 * publicReview allowlist serializer, and capped at the FR-03 page size so this view and
 * GET /api/hosts/:id can never disagree. Only approved reviews are ever read (FR-05/FR-08).
 *
 * @param {string} hostId
 * @returns {Promise<{host: {displayName, bio, averageRating, reviewCount}|null,
 *                    reviews: object[]}>} host is null when the account was deleted or never
 *          had a host profile (NFR-12-safe: the listing still renders, nothing leaks).
 */
async function hostContextFor(hostId) {
  const [host, stats, reviewRows] = await Promise.all([
    hostsRepo.findHost(hostId),
    hostsRepo.getReviewStats(hostId),
    hostsRepo.listApprovedReviews(hostId, { limit: PROFILE_REVIEWS_LIMIT }),
  ]);
  return {
    host: host
      ? {
          // serializers.HOST_SUMMARY_KEYS allowlist — display identity + aggregates only.
          displayName: host.fullName ?? hostSerializers.ANONYMIZED_AUTHOR,
          bio: host.bio ?? null,
          averageRating: hostSerializers.roundedAverage(stats.averageRating),
          reviewCount: stats.reviewCount,
        }
      : null,
    reviews: reviewRows.map(hostSerializers.publicReview),
  };
}

/**
 * FR-02 detail read with ADR-010 progressive disclosure.
 *  - owner: privileged projection, ANY moderation status (sees own pending/rejected).
 *  - everyone else: 404 unless moderation_status='approved'; then privileged ONLY when
 *    access.canViewPreciseLocation says so (live guest / access-logged FR-07 moderator),
 *    public projection otherwise.
 *  - EVERY successful response additionally carries the FR-02 host context ({host, reviews}
 *    — serializers.DETAIL_CONTEXT_KEYS) in the same payload.
 * @param {{userId: string, roles?: string[]}} auth  authenticated viewer (AB-08: 401 upstream)
 */
async function getListing(auth, listingId) {
  const row = await repo.findById(listingId);
  if (!row) throw new NotFoundError('Listing not found');

  const media = await repo.listMediaForListing(listingId);

  let base;
  if (auth.userId === row.host_id) {
    base = serializers.privilegedListing(row, media);
  } else if (row.moderation_status !== 'approved') {
    // FR-08 / AB-01: unreviewed content is invisible — indistinguishable from absent.
    throw new NotFoundError('Listing not found');
  } else {
    const privileged = await access.canViewPreciseLocation(auth, listingId);
    base = privileged
      ? serializers.privilegedListing(row, media)
      : serializers.publicListing(row, media);
  }

  // FR-02 acceptance: host summary + approved host reviews ride the SAME response.
  const context = await hostContextFor(row.host_id);
  return { ...base, host: context.host, reviews: context.reviews };
}

// ---- update ----------------------------------------------------------------------------------

/**
 * FR-11 update: owner-only, MEHKO-checked, material edits reset moderation to pending
 * (FR-08), address edits re-enqueue geocoding — all in one transaction.
 * @returns {Promise<object>} the owner's privileged projection of the updated listing
 */
async function updateListing(auth, listingId, patch, opts = {}) {
  const log = logFor(opts);
  const changedFields = [];

  let row;
  try {
    row = await withTransaction(async (client) => {
      const current = await repo.findByIdForUpdate(client, listingId);
      if (!current) throw new NotFoundError('Listing not found');
      if (current.host_id !== auth.userId) {
        throw new ForbiddenError('Only the listing host may modify this listing.');
      }
      if (current.status === 'cancelled') {
        throw new ConflictError('A cancelled listing cannot be updated.', {
          code: 'LISTING_CANCELLED',
        });
      }

      // ADR-009: the SAME single enforcement point on the update path, with the listing's
      // prospective state and itself excluded from its own counts.
      const effectiveStart = patch.scheduledStart ?? current.scheduled_start;
      const effectiveSeats = patch.seatCapacity ?? current.seat_capacity;
      const { localDate } = await mehko.assertWithinCaps(client, {
        hostId: current.host_id,
        scheduledStart: effectiveStart,
        seatCapacity: effectiveSeats,
        excludeListingId: listingId,
      });

      const columnPatch = {};

      // Material content fields (FR-08 moderation reset on change).
      let material = false;
      for (const key of MATERIAL_FIELDS) {
        if (patch[key] === undefined) continue;
        const currentValue = key === 'cuisine' ? current.cuisine : current[key];
        if (!sameValue(patch[key], currentValue)) {
          columnPatch[key] = patch[key];
          changedFields.push(key);
          material = true;
        }
      }

      // Address fields (ADR-010 privileged data) — a change invalidates the geocode.
      let addressChanged = false;
      for (const key of ADDRESS_FIELDS) {
        if (patch[key] === undefined) continue;
        if (!sameValue(patch[key], current[ADDRESS_COLUMN[key]])) {
          columnPatch[key] = patch[key];
          changedFields.push(key);
          addressChanged = true;
        }
      }

      // Schedule (ADR-009: local_date ALWAYS recomputed by mehko, never caller-supplied).
      if (patch.scheduledStart !== undefined) {
        const next = new Date(patch.scheduledStart).getTime();
        if (next !== new Date(current.scheduled_start).getTime()) {
          columnPatch.scheduledStart = patch.scheduledStart;
          columnPatch.localDate = localDate;
          changedFields.push('scheduledStart');
        }
      }
      if (
        patch.durationMinutes !== undefined &&
        patch.durationMinutes !== current.duration_minutes
      ) {
        columnPatch.durationMinutes = patch.durationMinutes;
        changedFields.push('durationMinutes');
      }

      // Capacity: seats_remaining re-derived from live bookings (FR-12 consistency; the
      // 0001 CHECK seats_remaining BETWEEN 0 AND seat_capacity remains the DB backstop).
      if (patch.seatCapacity !== undefined && patch.seatCapacity !== current.seat_capacity) {
        const active = await repo.countActiveBookings(client, listingId);
        if (patch.seatCapacity < active) {
          throw new ConflictError(
            'Seat capacity cannot drop below the number of active bookings.',
            { code: 'SEAT_CAPACITY_BELOW_BOOKED', details: { activeBookings: active } }
          );
        }
        columnPatch.seatCapacity = patch.seatCapacity;
        columnPatch.seatsRemaining = patch.seatCapacity - active;
        changedFields.push('seatCapacity');
      }

      if (changedFields.length === 0) {
        return current; // no-op PATCH: nothing differed — idempotent success
      }

      if (material) {
        // FR-08: a material edit makes the content unreviewed again — pending until approved.
        columnPatch.moderationStatus = 'pending';
      }
      if (addressChanged) {
        // Stale precise/coarse location must not survive an address change (ADR-010).
        columnPatch.lat = null;
        columnPatch.lng = null;
        columnPatch.coarseLat = null;
        columnPatch.coarseLng = null;
        columnPatch.areaLabel = null;
      }

      const updated = await repo.updateListing(client, listingId, columnPatch);

      if (material) {
        await outbox.enqueue(client, {
          type: JOB_MODERATION_SCAN,
          payload: { contentType: 'listing', contentId: listingId },
        });
      }
      if (addressChanged) {
        await outbox.enqueue(client, {
          type: JOB_LISTING_GEOCODE,
          payload: { listingId },
        });
      }
      return updated;
    });
  } catch (err) {
    if (isDailyLimitViolation(err)) throw dailyLimitConflict(err);
    throw err;
  }

  // NFR-08 audit: field NAMES only, never values (SRS §3.4 PII register).
  audit(log, {
    event: 'listing.updated',
    outcome: 'success',
    actorUserId: auth.userId,
    entityType: 'listing',
    entityId: listingId,
    hostId: row.host_id,
    localDate: String(row.local_date),
    changedFields,
    moderationStatus: row.moderation_status,
  });

  return serializers.privilegedListing(row, await repo.listMediaForListing(listingId));
}

// ---- cancel ----------------------------------------------------------------------------------

/**
 * FR-11 cancel: owner-only; cascades to active bookings and enqueues one notify.booking job
 * per affected guest in the SAME transaction (FR-13, FR-14 semantics, ADR-001/003).
 * Idempotent: cancelling an already-cancelled listing is a no-op success.
 * @returns {Promise<{listing: object, cancelledBookings: number}>}
 */
async function cancelListing(auth, listingId, opts = {}) {
  const log = logFor(opts);

  const result = await withTransaction(async (client) => {
    const current = await repo.findByIdForUpdate(client, listingId);
    if (!current) throw new NotFoundError('Listing not found');
    if (current.host_id !== auth.userId) {
      throw new ForbiddenError('Only the listing host may cancel this listing.');
    }
    if (current.status === 'cancelled') {
      return { row: current, affected: [], alreadyCancelled: true };
    }

    const row = await repo.cancelListing(client, listingId);
    const affected = await repo.cancelActiveBookings(client, listingId);

    // FR-13: one notify.booking job per affected guest, committed WITH the cancellation.
    // Payload is IDs only (ADR-003; outbox.enqueue enforces); the handler is owned by
    // U3-BOOKINGS. dedupeKey makes a retried request exactly-once per booking (RT-02).
    for (const booking of affected) {
      await outbox.enqueue(client, {
        type: JOB_NOTIFY_BOOKING,
        payload: {
          bookingId: booking.id,
          event: 'listing_cancelled',
          recipientUserId: booking.guest_id,
        },
        dedupeKey: `${JOB_NOTIFY_BOOKING}:${booking.id}:listing_cancelled`,
      });
    }
    return { row, affected, alreadyCancelled: false };
  });

  if (!result.alreadyCancelled) {
    audit(log, {
      event: 'listing.cancelled',
      outcome: 'success',
      actorUserId: auth.userId,
      entityType: 'listing',
      entityId: listingId,
      hostId: result.row.host_id,
      localDate: String(result.row.local_date),
      cancelledBookings: result.affected.length,
    });
  }

  return {
    listing: serializers.privilegedListing(result.row, []),
    cancelledBookings: result.affected.length,
  };
}

module.exports = {
  createListing,
  getListing,
  updateListing,
  cancelListing,
  JOB_LISTING_GEOCODE,
  JOB_MODERATION_SCAN,
  JOB_NOTIFY_BOOKING,
};
