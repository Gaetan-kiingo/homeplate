// src/schemas/search.js — U3-SEARCH: zod schema for GET /api/listings/search (API boundary,
// build-plan wave 3B).
//
// Requirement traceability (SRS Appendix B):
//   FR-01 (TC-01) — the four search dimensions, each optional and freely combinable:
//            location (+radiusKm), time window (from/to), hostId, cuisine, plus the shared
//            bounded pagination. No filter is required: an empty query is a plain browse.
//   NFR-11 / AB-06 (ST-04) — validated through the shared U1-VALID middleware: unknown query
//            params are STRIPPED (zod object semantics), type/range violations return
//            field-level 422s, and hostile strings that fit the shape (SQLi text in
//            `location`, XSS text in `cuisine`) pass through as INERT DATA — the SQL defence
//            is parameterization (src/modules/search/repo.js), never input rejection.
//   NFR-02 — pagination caps come from the shared schema so no request can demand an
//            unbounded result page at 10k-user volume.
//   ADR-009 — from/to must be ISO 8601 datetimes WITH timezone (shared isoDateTime): the
//            server never guesses a caller's local zone.
//
// `cuisine` reuses safeText with the exact bounds of src/schemas/listings.js so the filter
// value is sanitized IDENTICALLY to how listing cuisines were sanitized at creation — an
// equality match therefore compares like with like (NFR-11).
'use strict';

const { z } = require('zod');
const { uuid, isoDateTime, pagination, safeText } = require('./common');

// Free-text location query ("La Jolla", "downtown san diego"). Bounded, then treated as
// inert data: it is resolved by the Maps adapter (which normalizes + hashes it for its
// cache key) and is never echoed back or interpolated into SQL (NFR-11, AB-06).
const location = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(200, 'must be at most 200 characters');

// Search radius around the resolved area(s), in kilometres. Bounded: distance filtering
// operates on ADR-010 COARSE coordinates, so sub-kilometre radii would only pretend to a
// precision the public projection deliberately does not have.
const radiusKm = z.coerce
  .number()
  .positive('must be a positive number of kilometres')
  .max(100, 'must be at most 100 km');

/** GET /api/listings/search query (FR-01). Unknown properties are stripped (NFR-11). */
const query = pagination
  .extend({
    location: location.optional(),
    radiusKm: radiusKm.optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    hostId: uuid.optional(),
    cuisine: safeText({ min: 1, max: 80 }).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.from && value.to && new Date(value.from) > new Date(value.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'must not be before "from"',
      });
    }
  });

module.exports = { query };
