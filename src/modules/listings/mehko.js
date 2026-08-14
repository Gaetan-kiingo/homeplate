// src/modules/listings/mehko.js — U3-LISTINGS: THE single server-side MEHKO enforcement point
// (build-plan wave 3A; ADR-009; SPMP WA-2).
//
// Requirement traceability (SRS Appendix B):
//   FR-11 (TC-11) — enforces the configured one-listing-per-host-per-day and meal/seat caps on
//            every listing create/update path. Cancelled listings never count (FR-11 re-create
//            path). This module is consulted by src/modules/listings/service.js for create,
//            update and cancel/re-create; NO other module re-implements any cap (AB-07 grep).
//   AB-03 / AB-07 — the daily-uniqueness rule this module enforces in-process is backed by the
//            0002 partial unique index listings_host_local_date_key, so concurrent duplicate
//            creations cannot both commit; the service maps that 23505 to the same 409.
//   ADR-009 — every numeric cap is read from config.mehko (src/config/locale.js is the one
//            home of the numbers — NO cap literal appears in this file, the adr-conformance
//            lane greps for exactly that). Day and week boundaries are evaluated in
//            config.mehko.timezone (America/Los_Angeles) via Intl.DateTimeFormat — never UTC,
//            never the caller's timezone: half past eleven PM PT and half past midnight PT
//            the next day are different days even when they share a UTC day. Weeks are
//            Monday-anchored in LA time.
//   NFR-11 — all SQL parameterized on the caller's transaction client (ADR-001: the check and
//            the insert commit or roll back together).
//
// Public interface (build-plan wave-3A contract):
//   assertWithinCaps(client, { hostId, scheduledStart, seatCapacity, excludeListingId? })
//       → Promise<{ localDate, weekStart, weekEnd }>; throws typed AppError:
//         409 ConflictError   MEHKO_DAILY_LISTING_LIMIT
//         422 ValidationError MEHKO_DAILY_MEAL_LIMIT | MEHKO_WEEKLY_MEAL_LIMIT
//   localDateFor(instant)     → 'YYYY-MM-DD' in the configured operating timezone
//   weekRangeFor(instant)     → { weekStart, weekEnd } (Monday-anchored, LA time)
'use strict';

const config = require('../../config');
const { ConflictError, ValidationError } = require('../../lib/errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAYS_PER_WEEK = 7;
const MS_PER_DAY = 86400000; // 24 h — written as one literal so no MEHKO-cap-shaped number
// ever appears anywhere in this file (ADR-009: the adr-conformance lane greps for exactly that).

/**
 * Calendar date (YYYY-MM-DD) of an instant in the configured operating timezone
 * (ADR-009 — config.mehko.timezone, America/Los_Angeles for v1.0). 'en-CA' formats as
 * YYYY-MM-DD directly; no date library is needed (build-plan §3).
 * @param {Date|string} instant
 * @returns {string}
 */
function localDateFor(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('mehko.localDateFor: instant must be a Date or parseable timestamp');
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.mehko.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Parse a YYYY-MM-DD local-date string into UTC-midnight for pure calendar arithmetic. */
function calendarUtc(localDate) {
  const [y, m, d] = localDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatCalendarUtc(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Monday-anchored week containing an instant, evaluated on the LA calendar (ADR-009 —
 * "weeks start Monday, LA time", src/config/locale.js). The day-of-week of a calendar date
 * is a timezone-free fact, so once the LA local date is known the arithmetic runs on UTC
 * midnights without ever re-entering timezone math.
 * @param {Date|string} instant
 * @returns {{weekStart: string, weekEnd: string}} inclusive YYYY-MM-DD bounds (Mon..Sun)
 */
function weekRangeFor(instant) {
  const localDate = localDateFor(instant);
  const asUtc = calendarUtc(localDate);
  // getUTCDay(): 0=Sunday..6=Saturday → days since Monday.
  const sinceMonday = (asUtc.getUTCDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK;
  const weekStart = new Date(asUtc.getTime() - sinceMonday * MS_PER_DAY);
  const weekEnd = new Date(weekStart.getTime() + (DAYS_PER_WEEK - 1) * MS_PER_DAY);
  return { weekStart: formatCalendarUtc(weekStart), weekEnd: formatCalendarUtc(weekEnd) };
}

/**
 * Enforce every configured MEHKO cap for one prospective listing state (FR-11, ADR-009).
 * Runs on the caller's TRANSACTION client so the check and the subsequent insert/update
 * commit atomically; the 0002 unique index remains the concurrency backstop.
 *
 * @param {import('pg').PoolClient} client  the transaction client the mutation uses
 * @param {object} input
 * @param {string} input.hostId            listing host (users.id)
 * @param {Date|string} input.scheduledStart  the listing's (new) start instant
 * @param {number} input.seatCapacity      the listing's (new) seat capacity
 * @param {string} [input.excludeListingId]  on updates: the listing being changed, excluded
 *                                          from its own counts
 * @returns {Promise<{localDate: string, weekStart: string, weekEnd: string}>}
 * @throws {ConflictError}  409 MEHKO_DAILY_LISTING_LIMIT — the host already has a
 *         non-cancelled listing on that America/Los_Angeles calendar day
 * @throws {ValidationError} 422 MEHKO_DAILY_MEAL_LIMIT / MEHKO_WEEKLY_MEAL_LIMIT — the
 *         seat capacity would exceed the configured daily/weekly meal caps
 */
async function assertWithinCaps(
  client,
  { hostId, scheduledStart, seatCapacity, excludeListingId }
) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('mehko.assertWithinCaps: client must be a pg transaction client');
  }
  if (typeof hostId !== 'string' || !UUID_RE.test(hostId)) {
    throw new TypeError('mehko.assertWithinCaps: hostId must be a UUID');
  }
  if (!Number.isInteger(seatCapacity) || seatCapacity < 1) {
    throw new ValidationError('seatCapacity must be a positive integer', {
      details: { field: 'seatCapacity' },
    });
  }
  if (excludeListingId !== undefined && excludeListingId !== null) {
    if (typeof excludeListingId !== 'string' || !UUID_RE.test(excludeListingId)) {
      throw new TypeError('mehko.assertWithinCaps: excludeListingId must be a UUID');
    }
  }

  const caps = config.mehko; // ADR-009: the ONLY source of the numbers
  const localDate = localDateFor(scheduledStart);
  const { weekStart, weekEnd } = weekRangeFor(scheduledStart);
  const exclude = excludeListingId ?? null;

  // Same-LA-day non-cancelled listings + their seats, and the Monday-anchored-week seat sum,
  // in one round trip on the transaction client (NFR-11 parameterized).
  const { rows } = await client.query(
    `SELECT
       count(*) FILTER (WHERE local_date = $2)::int                          AS day_listings,
       COALESCE(sum(seat_capacity) FILTER (WHERE local_date = $2), 0)::int  AS day_seats,
       COALESCE(sum(seat_capacity), 0)::int                                  AS week_seats
     FROM listings
     WHERE host_id = $1
       AND status <> 'cancelled'
       AND local_date BETWEEN $3 AND $4
       AND ($5::uuid IS NULL OR id <> $5)`,
    [hostId, localDate, weekStart, weekEnd, exclude]
  );
  const { day_listings: dayListings, day_seats: daySeats, week_seats: weekSeats } = rows[0];

  if (dayListings >= caps.listingsPerHostPerDay) {
    throw new ConflictError(
      'This host already has a listing on that day (one listing per host per day).',
      {
        code: 'MEHKO_DAILY_LISTING_LIMIT',
        details: { localDate, limit: caps.listingsPerHostPerDay },
      }
    );
  }

  if (seatCapacity > caps.maxMealsPerDay || daySeats + seatCapacity > caps.maxMealsPerDay) {
    throw new ValidationError(
      'Seat capacity exceeds the configured daily MEHKO meal limit for this host.',
      {
        code: 'MEHKO_DAILY_MEAL_LIMIT',
        details: { localDate, limit: caps.maxMealsPerDay, alreadyScheduled: daySeats },
      }
    );
  }

  if (weekSeats + seatCapacity > caps.maxMealsPerWeek) {
    throw new ValidationError(
      'Seat capacity exceeds the configured weekly MEHKO meal limit for this host.',
      {
        code: 'MEHKO_WEEKLY_MEAL_LIMIT',
        details: { weekStart, weekEnd, limit: caps.maxMealsPerWeek, alreadyScheduled: weekSeats },
      }
    );
  }

  return { localDate, weekStart, weekEnd };
}

module.exports = { assertWithinCaps, localDateFor, weekRangeFor };
