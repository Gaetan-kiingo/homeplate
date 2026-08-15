// src/modules/listings/access.js — U3-LISTINGS: the ADR-010 precise-location access decision
// (build-plan wave 3A; SPMP WA-2).
//
// Requirement traceability (SRS Appendix B):
//   FR-02 (TC-02) / ADR-010 — exact street address and precise coordinates are released ONLY to:
//       (a) the listing's own host (their own data),
//       (b) a guest holding a booking on that listing in status 'pending' or 'in_progress'
//           (a cancelled or completed booking REVERTS the guest to the public projection),
//       (c) a caller with the Moderator role while an FR-07 safety alert exists on one of the
//           listing's bookings — and case (c) WRITES AN access_log ROW (actor, subject host,
//           purpose 'fr07_safety_alert') per NFR-13 "role-restricted access is logged".
//   NFR-13 / AB-08 — every other caller (browsing users, past guests, scrapers with sessions)
//       is answered false and gets the public serializer; the decision consumes IDs and roles
//       only — no personal data flows through this module or its logs.
//   NFR-11 — parameterized SQL on the pool or the caller's transaction client (ADR-001).
//
// Public interface (build-plan wave-3A contract):
//   canViewPreciseLocation(viewer, listingId, client?) → Promise<boolean>
//     viewer: { userId, roles } (req.auth shape) or null/undefined for anonymous.
//     The moderator path writes the access_log row as a side effect of a true answer.
//   PURPOSE_SAFETY_ALERT → the access_log.purpose literal written by case (c). Exported so the
//     wave-4 moderation views and any NFR-13 audit query filter on the constant rather than
//     re-typing the string; its value is pinned by tests/st-security/st-security-wave3.test.js.
'use strict';

const pool = require('../../db/pool');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURPOSE_SAFETY_ALERT = 'fr07_safety_alert';

function runner(client) {
  return client ?? pool;
}

/**
 * Decide whether `viewer` may see the exact address / precise coordinates of `listingId`
 * (ADR-010). Single decision point: the listing service, host profile, booking payloads and
 * wave-4 moderation views all consult THIS function — never a local re-derivation.
 *
 * @param {{userId: string, roles?: string[]}|null} viewer  req.auth, or null when anonymous
 * @param {string} listingId
 * @param {import('pg').PoolClient|null} [client]  optional transaction client (ADR-001)
 * @returns {Promise<boolean>}
 */
async function canViewPreciseLocation(viewer, listingId, client = null) {
  if (!viewer || typeof viewer.userId !== 'string' || !UUID_RE.test(viewer.userId)) {
    return false; // AB-08: anonymous callers never see precise location
  }
  if (typeof listingId !== 'string' || !UUID_RE.test(listingId)) {
    return false; // malformed reference — nothing to disclose
  }
  const run = runner(client);

  const { rows: listingRows } = await run.query(`SELECT host_id FROM listings WHERE id = $1`, [
    listingId,
  ]);
  if (listingRows.length === 0) return false;
  const hostId = listingRows[0].host_id;

  // (a) The host's own listing — their own address (NFR-13 poses no restriction on self).
  if (viewer.userId === hostId) return true;

  // (b) Guest with a live booking: pending or in_progress ONLY — cancelled/completed revert
  //     to the public projection (ADR-010 disclosure window).
  const { rows: bookingRows } = await run.query(
    `SELECT 1 FROM bookings
     WHERE listing_id = $1 AND guest_id = $2 AND status IN ('pending', 'in_progress')
     LIMIT 1`,
    [listingId, viewer.userId]
  );
  if (bookingRows.length > 0) return true;

  // (c) Moderator handling an FR-07 safety alert on this listing's bookings. The read is
  //     role-restricted AND access-logged (NFR-13): actor, subject host, purpose, resource.
  const roles = Array.isArray(viewer.roles) ? viewer.roles : [];
  if (roles.includes('moderator')) {
    const { rows: alertRows } = await run.query(
      `SELECT 1 FROM safety_alerts sa
       JOIN bookings b ON b.id = sa.booking_id
       WHERE b.listing_id = $1
       LIMIT 1`,
      [listingId]
    );
    if (alertRows.length > 0) {
      await run.query(
        `INSERT INTO access_log (actor_user_id, subject_user_id, purpose, resource)
         VALUES ($1, $2, $3, $4)`,
        [viewer.userId, hostId, PURPOSE_SAFETY_ALERT, `listing:${listingId}`]
      );
      return true;
    }
  }

  return false;
}

module.exports = { canViewPreciseLocation, PURPOSE_SAFETY_ALERT };
