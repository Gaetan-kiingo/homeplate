// src/schemas/bookings.js — U3-BOOKINGS: request schemas for the /api/bookings surface,
// enforced by the ONE shared validation middleware (src/middleware/validate.js).
//
// Requirement traceability (SRS Appendix B):
//   FR-12 (TC-12) — createBooking: the reservation body carries exactly { listingId: uuid };
//                   unknown properties are stripped, malformed ids are 422 before any
//                   capacity work is touched.
//   FR-14 (TC-14) / FR-04 (TC-04) — bookingIdParams validates the :id path segment on
//                   cancel / confirm-completion / detail routes; the action bodies are
//                   declared empty (input-less routes still declare a validator so the
//                   NFR-11 route-enumeration check can prove full coverage).
//   NFR-11 / AB-06 — every shape composes src/schemas/common.js (uuid, pagination) rather
//                   than redefining per-module copies; hostile strings fail as shape
//                   violations (422) or pass through as inert data for parameterized SQL.
'use strict';

const { z } = require('zod');
const common = require('./common');

/** POST /api/bookings — reserve one seat on a listing (FR-12). IDs only, nothing else. */
const createBooking = z.object({
  listingId: common.uuid,
});

/** :id path param for cancel / confirm-completion / detail routes (FR-14, FR-04). */
const bookingIdParams = z.object({
  id: common.uuid,
});

/** Action endpoints take no body; declaring the empty object keeps unknown keys stripped
 *  and the route enumerable by the NFR-11 conformance check. */
const emptyBody = z.object({});

/** Input-less GET routes still declare a query validator (NFR-11 route enumeration). */
const noInput = z.object({});

/** GET /api/bookings — the caller's own bookings, both roles, paginated (NFR-02 caps). */
const listQuery = common.pagination.extend({
  // 'guest' = bookings I made; 'host' = bookings on my listings; 'any' = both (default).
  role: z.enum(['guest', 'host', 'any']).default('any'),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
});

module.exports = {
  createBooking,
  bookingIdParams,
  emptyBody,
  noInput,
  listQuery,
};
