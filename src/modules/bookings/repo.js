// src/modules/bookings/repo.js — U3-BOOKINGS: booking data access. Parameterized SQL only
// (NFR-11); every statement that belongs to a unit of work takes the caller's TRANSACTION
// client so the service can compose the FR-12/FR-14 atomic flows via withTransaction.
//
// Requirement traceability (SRS Appendix B):
//   FR-12 (TC-12, LT-01) — decrementSeat() is the mandated conditional UPDATE
//                   (`seats_remaining - 1 WHERE … seats_remaining > 0`): under a 50-way race
//                   exactly one caller matches a row; everyone else sees zero rows and is
//                   rejected without touching capacity. lockGuestForBooking() +
//                   countPendingForGuest() make the AB-02 per-guest pending cap race-free
//                   (pg_advisory_xact_lock serializes a guest's concurrent create attempts).
//   FR-14 (TC-14) — markCancelledBeforeStart() flips pending→cancelled ONLY while the listing
//                   has not started (time gate inside the atomic statement); zero rows on a
//                   repeat/concurrent cancel is the idempotence signal, so restoreSeat() runs
//                   at most once per booking and seats_remaining can never exceed
//                   seat_capacity (the 0001 CHECK backstops even that).
//   FR-04 (TC-04) — applyCompletionConfirmation() records one party's confirmation and, when
//                   both flags are true, moves the booking to 'completed' with completed_at
//                   (migration 0004) in the SAME statement — the 0001 CHECK refuses
//                   'completed' without both flags.
//   AB-02          — countPendingForGuest() backs the config.booking.maxConcurrentPending cap
//                   (0002 index bookings_guest_status_idx keeps it O(log n)).
//   NFR-11 (ST-04) — $n placeholders everywhere; identifiers are static strings.
//
// Public interface (build-plan §3 wave-3 contract):
//   findParticipantBooking(bookingId, userId[, client]) → { booking, listing, role } | null
//   — wave-4 messaging/reviews/safety gate "participant + status" through THIS function.
//   `listing` here is the INTERNAL row subset (public fields + host_id + lifecycle columns);
//   HTTP serialization is the service's allowlist — precise address/coordinates are never
//   selected by this module at all (ADR-010: booking payloads reference the listing by
//   public fields only; the privileged address stays on GET /api/listings/:id).
'use strict';

const pool = require('../../db/pool');

/** Listing columns bookings ever need: public-precision fields (ADR-010 — no address_line*,
 *  no lat/lng) plus host_id and the lifecycle/capacity columns the flows check. */
const LISTING_COLS = `
  l.id                AS l_id,
  l.host_id           AS l_host_id,
  l.title             AS l_title,
  l.cuisine           AS l_cuisine,
  l.scheduled_start   AS l_scheduled_start,
  l.duration_minutes  AS l_duration_minutes,
  l.city              AS l_city,
  l.area_label        AS l_area_label,
  l.coarse_lat        AS l_coarse_lat,
  l.coarse_lng        AS l_coarse_lng,
  l.status            AS l_status,
  l.moderation_status AS l_moderation_status,
  l.seat_capacity     AS l_seat_capacity,
  l.seats_remaining   AS l_seats_remaining`;

const BOOKING_COLS = `
  b.id, b.listing_id, b.guest_id, b.status,
  b.host_confirmed_completion, b.guest_confirmed_completion,
  b.cancelled_at, b.completed_at, b.created_at, b.updated_at`;

/** Split one joined row into { booking, listing } objects. */
function splitRow(row) {
  if (!row) return null;
  const booking = {};
  const listing = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('l_')) listing[key.slice(2)] = value;
    else booking[key] = value;
  }
  return { booking, listing };
}

function runnerFor(client) {
  return client ?? pool;
}

/**
 * Serialize this guest's booking attempts with a transaction-scoped advisory lock (FR-12 /
 * AB-02): two concurrent creates by the same guest queue here, so the pending-count check
 * that follows can never race past the cap. hashtextextended gives a stable 64-bit key from
 * the guest UUID; the 'booking:guest:' prefix namespaces it away from other lock users.
 * MUST run on a transaction client — the lock releases at COMMIT/ROLLBACK.
 */
async function lockGuestForBooking(client, guestId) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('booking:guest:' || $1, 0))`, [
    guestId,
  ]);
}

/** Count the guest's concurrent PENDING bookings (AB-02 cap input; 0002 index). */
async function countPendingForGuest(client, guestId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS count FROM bookings WHERE guest_id = $1 AND status = 'pending'`,
    [guestId]
  );
  return rows[0].count;
}

/** Load the listing subset the booking flow checks (visibility, ownership, time, capacity). */
async function selectListing(client, listingId) {
  const { rows } = await client.query(`SELECT ${LISTING_COLS} FROM listings l WHERE l.id = $1`, [
    listingId,
  ]);
  if (rows.length === 0) return null;
  return splitRow(rows[0]).listing;
}

/**
 * FR-12: the atomic capacity decrement — the build-plan-mandated conditional UPDATE. All
 * bookability conditions live INSIDE the statement, so under any race exactly one concurrent
 * caller can match the row while seats_remaining is 1. Zero rows → not bookable now (the
 * service classifies why). The 0001 CHECK (0 ≤ seats_remaining ≤ seat_capacity) makes
 * overbooking impossible even if this statement ever regressed.
 */
async function decrementSeat(client, listingId) {
  const { rows } = await client.query(
    `UPDATE listings
     SET seats_remaining = seats_remaining - 1
     WHERE id = $1
       AND seats_remaining > 0
       AND status = 'active'
       AND moderation_status = 'approved'
       AND scheduled_start > now()
     RETURNING id, host_id, seats_remaining, seat_capacity, scheduled_start`,
    [listingId]
  );
  return rows[0] ?? null;
}

/** Insert the booking row (status 'pending' by default — §3.4 lifecycle). */
async function insertBooking(client, { listingId, guestId }) {
  const { rows } = await client.query(
    `INSERT INTO bookings (listing_id, guest_id) VALUES ($1, $2) RETURNING *`,
    [listingId, guestId]
  );
  return rows[0];
}

/**
 * Load one booking joined with its listing subset. `lock: true` takes FOR UPDATE OF the
 * BOOKING row (not the listing) so concurrent cancel/confirm calls on the same booking
 * serialize without blocking other bookings on the listing.
 * @returns {Promise<{booking: object, listing: object}|null>}
 */
async function selectBookingWithListing(bookingId, { client = null, lock = false } = {}) {
  const runner = runnerFor(client);
  const { rows } = await runner.query(
    `SELECT ${BOOKING_COLS}, ${LISTING_COLS}
     FROM bookings b
     JOIN listings l ON l.id = b.listing_id
     WHERE b.id = $1
     ${lock ? 'FOR UPDATE OF b' : ''}`,
    [bookingId]
  );
  return splitRow(rows[0] ?? null);
}

/**
 * FR-14: pending → cancelled, strictly before the listing's scheduled start, in ONE atomic
 * statement. Zero rows means "did not transition NOW": already cancelled (idempotent repeat),
 * no longer pending, or too late — the service re-reads to classify. Because only the caller
 * that got the row back restores the seat, a repeat/concurrent cancel can never double-restore.
 */
async function markCancelledBeforeStart(client, bookingId) {
  const { rows } = await client.query(
    `UPDATE bookings b
     SET status = 'cancelled', cancelled_at = now()
     FROM listings l
     WHERE b.id = $1
       AND b.status = 'pending'
       AND l.id = b.listing_id
       AND l.scheduled_start > now()
     RETURNING b.*`,
    [bookingId]
  );
  return rows[0] ?? null;
}

/** FR-14: give the seat back. Runs ONLY after a successful pending→cancelled transition;
 *  the 0001 CHECK (seats_remaining ≤ seat_capacity) backstops any logic regression. */
async function restoreSeat(client, listingId) {
  const { rows } = await client.query(
    `UPDATE listings SET seats_remaining = seats_remaining + 1
     WHERE id = $1
     RETURNING id, seats_remaining, seat_capacity`,
    [listingId]
  );
  return rows[0] ?? null;
}

/**
 * FR-04: record one party's completion confirmation while the booking is 'in_progress'.
 * When the OTHER flag is already set, the same statement moves the booking to 'completed'
 * and stamps completed_at (migration 0004) — one atomic transition, and the 0001 CHECK
 * refuses 'completed' unless both flags are true. Zero rows → booking not in_progress.
 * @param {'guest'|'host'} role  whose flag to set (validated by the service)
 */
async function applyCompletionConfirmation(client, bookingId, role) {
  const guestConfirms = role === 'guest';
  const { rows } = await client.query(
    `UPDATE bookings
     SET guest_confirmed_completion = guest_confirmed_completion OR $2,
         host_confirmed_completion  = host_confirmed_completion OR $3,
         status = CASE
           WHEN (guest_confirmed_completion OR $2) AND (host_confirmed_completion OR $3)
             THEN 'completed'::booking_status
           ELSE status
         END,
         completed_at = CASE
           WHEN (guest_confirmed_completion OR $2) AND (host_confirmed_completion OR $3)
             THEN now()
           ELSE completed_at
         END
     WHERE id = $1 AND status = 'in_progress'
     RETURNING *`,
    [bookingId, guestConfirms, !guestConfirms]
  );
  return rows[0] ?? null;
}

/** Lifecycle: pending → in_progress at the scheduled start (bookingPromote handler).
 *  Conditional on 'pending' so a redelivered promote job is a natural no-op (RT-02). */
async function promotePending(client, bookingId) {
  const { rows } = await client.query(
    `UPDATE bookings SET status = 'in_progress' WHERE id = $1 AND status = 'pending' RETURNING *`,
    [bookingId]
  );
  return rows[0] ?? null;
}

/**
 * The wave-3 public contract wave-4 units gate on (build-plan §3): resolve a booking and
 * the caller's relationship to it in one read.
 * @returns {Promise<{booking: object, listing: object, role: 'guest'|'host'|null}|null>}
 *   null → no such booking; role null → the booking exists but userId is neither the guest
 *   nor the listing's host (callers decide 403 vs 404). `listing` is the internal subset —
 *   public-precision location only, never street address or precise coordinates (ADR-010).
 */
async function findParticipantBooking(bookingId, userId, client = null) {
  const found = await selectBookingWithListing(bookingId, { client });
  if (!found) return null;
  const { booking, listing } = found;
  let role = null;
  if (booking.guest_id === userId) role = 'guest';
  else if (listing.host_id === userId) role = 'host';
  return { booking, listing, role };
}

/**
 * The caller's own bookings, newest first (GET /api/bookings): as guest ('guest'), as the
 * listing's host ('host'), or both ('any'). Optional status filter; paginated (NFR-02 caps
 * enforced by the schema).
 */
async function listForUser(userId, { page = 1, pageSize = 20, role = 'any', status } = {}) {
  const conditions = [];
  if (role === 'guest') conditions.push('b.guest_id = $1');
  else if (role === 'host') conditions.push('l.host_id = $1');
  else conditions.push('(b.guest_id = $1 OR l.host_id = $1)');

  const params = [userId];
  if (status !== undefined) {
    params.push(status);
    conditions.push(`b.status = $${params.length}::booking_status`);
  }
  params.push(pageSize, (page - 1) * pageSize);

  const { rows } = await pool.query(
    `SELECT ${BOOKING_COLS}, ${LISTING_COLS}
     FROM bookings b
     JOIN listings l ON l.id = b.listing_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY b.created_at DESC, b.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows.map(splitRow);
}

module.exports = {
  lockGuestForBooking,
  countPendingForGuest,
  selectListing,
  decrementSeat,
  insertBooking,
  selectBookingWithListing,
  markCancelledBeforeStart,
  restoreSeat,
  applyCompletionConfirmation,
  promotePending,
  findParticipantBooking,
  listForUser,
};
