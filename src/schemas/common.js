// src/schemas/common.js — shared zod schemas for the API boundary (U1-VALID, wave 1).
//
// Traceability: NFR-11 (all user input validated by one shared layer), AB-06 (injection
// attacks arrive as type/shape/length violations or as hostile strings — the former are
// rejected here with 422, the latter pass through as INERT DATA because parameterized SQL,
// not input rejection, is the SQLi defense), ADR-006 (validation at the API boundary).
//
// Contract (build-plan "Public interfaces"): shared schemas — email, phone E.164, uuid,
// pagination, ISO datetime. Later waves compose these inside their route schemas via
// `validate({ body, query, params })` (src/middleware/validate.js) rather than redefining
// per-module copies.
'use strict';

const { z } = require('zod');
const sanitize = require('../lib/sanitize');

/** RFC 5321 upper bound for a whole address; trimmed and lowercased so lookups against the
 *  unique users.email column (SRS 3.4) are canonical. */
const email = z.string().trim().toLowerCase().max(254).email('must be a valid email address');

/** E.164 international phone number: "+" then 2-15 digits, no spaces or punctuation
 *  (e.g. +14155552671). Stored encrypted at rest by U1-DB fieldCrypto (NFR-13). */
const phoneE164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{1,14}$/, 'must be an E.164 phone number, e.g. +14155552671');

/** Canonical id shape for every path/body reference (users, listings, bookings, ...). */
const uuid = z.string().trim().uuid('must be a UUID');

/** ISO 8601 datetime WITH timezone ("Z" or a numeric offset). Naive local datetimes are
 *  rejected: every scheduling decision is timezone-explicit — ADR-009 day/week boundaries
 *  are computed server-side in the configured locale timezone (src/config/locale.js),
 *  never from a caller's implied zone. */
const isoDateTime = z
  .string()
  .trim()
  .datetime({ offset: true, message: 'must be an ISO 8601 datetime with timezone' });

/** Query-string pagination with hard caps so no request can demand an unbounded page
 *  (NFR-02 scale discipline). Extend per route: `pagination.extend({ q: ... })`. */
const pagination = z.object({
  page: z.coerce.number().int('must be an integer').min(1).max(10000).default(1),
  pageSize: z.coerce.number().int('must be an integer').min(1).max(100).default(20),
});

/** WGS84 coordinates. Precision handling (coarsening for public reads) is ADR-010 territory
 *  and lives in src/lib/geoPrecision.js — these only bound the numeric range. */
const latitude = z.coerce.number().min(-90, 'must be >= -90').max(90, 'must be <= 90');
const longitude = z.coerce.number().min(-180, 'must be >= -180').max(180, 'must be <= 180');

/**
 * Builder for user-authored free-text fields (listing text, chat, reviews, profile bios —
 * the AB-06 attack surface). Length limits are enforced on the RAW input, then the value is
 * passed through sanitize.text so what reaches services/repositories can never carry
 * executable markup (NFR-11, ST-04). SQLi strings survive untouched as inert data.
 *
 * @param {{min?: number, max?: number}} [options]
 * @returns {import('zod').ZodType<string>}
 */
function safeText({ min = 1, max = 1000 } = {}) {
  return z
    .string()
    .trim()
    .min(min, `must be at least ${min} character(s)`)
    .max(max, `must be at most ${max} character(s)`)
    .transform((value) => sanitize.text(value));
}

module.exports = {
  email,
  phoneE164,
  uuid,
  isoDateTime,
  pagination,
  latitude,
  longitude,
  safeText,
};
