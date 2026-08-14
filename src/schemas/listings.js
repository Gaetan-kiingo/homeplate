// src/schemas/listings.js — U3-LISTINGS: zod schemas for every /api/listings route (API
// boundary, build-plan wave 3A).
//
// Requirement traceability (SRS Appendix B):
//   FR-11  — complete listing data shape (title, description, ingredients, allergy info,
//            schedule, seats, address). seatCapacity carries NO upper-bound literal here on
//            purpose: the MEHKO caps are configuration (ADR-009) enforced by the single
//            server-side enforcement point (src/modules/listings/mehko.js), never by a
//            schema constant.
//   FR-02  — the detail payload's editable fields (dish, ingredients, allergens) validated
//            on the way in.
//   NFR-11 / AB-06 — every field validated + sanitized through the shared U1-VALID layer
//            (safeText escapes markup; hostile strings arrive as inert data, 422 on shape
//            violations, unknown keys stripped).
//   NFR-13 / ADR-010 — the address is collected minimally (street line(s), city, region,
//            postal code, country) and stored for the PRIVILEGED serializer only; nothing in
//            this schema ever echoes back publicly without src/modules/listings/serializers.
//   ADR-009 — scheduledStart must be an ISO 8601 datetime WITH timezone (shared isoDateTime):
//            day/week boundaries are computed server-side in America/Los_Angeles, never from
//            a caller-implied local time.
'use strict';

const { z } = require('zod');
const { uuid, isoDateTime, safeText } = require('./common');

/** Ingredients / allergens: short user-authored labels (FR-02), bounded lists. */
const shortLabel = safeText({ min: 1, max: 100 });

/** scheduledStart: timezone-explicit and in the future — a meal cannot be scheduled into
 *  the past (FR-11 "complete listing data"). */
const scheduledStart = isoDateTime.refine((value) => new Date(value).getTime() > Date.now(), {
  message: 'must be in the future',
});

/** ISO 3166-1 alpha-2 country code; DB default is US (SRS §2.1.7 v1.0 jurisdiction). */
const country = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'must be a 2-letter country code');

// Address fields (ADR-010 privileged data — never public without the serializer chokepoint).
const addressFields = {
  addressLine1: safeText({ min: 1, max: 200 }),
  addressLine2: safeText({ min: 1, max: 200 }),
  city: safeText({ min: 1, max: 120 }),
  region: safeText({ min: 1, max: 120 }),
  postalCode: safeText({ min: 1, max: 20 }),
  country,
};

/** POST /api/listings (FR-11 create). */
const create = z.object({
  title: safeText({ min: 3, max: 200 }),
  description: safeText({ min: 1, max: 5000 }),
  ingredients: z.array(shortLabel).min(1, 'must list at least one ingredient').max(50),
  allergens: z.array(shortLabel).max(50).default([]),
  cuisine: safeText({ min: 1, max: 80 }).optional(),
  scheduledStart,
  durationMinutes: z.coerce.number().int('must be an integer').min(1).max(1440),
  // Lower bound only — the AB 626 upper bounds live in src/config (ADR-009) and are
  // enforced by mehko.assertWithinCaps with 422 MEHKO_DAILY_MEAL_LIMIT.
  seatCapacity: z.coerce.number().int('must be an integer').min(1),
  addressLine1: addressFields.addressLine1,
  addressLine2: addressFields.addressLine2.optional(),
  city: addressFields.city,
  region: addressFields.region,
  postalCode: addressFields.postalCode.optional(),
  country: country.optional(),
});

/** PATCH /api/listings/:id (FR-11 update) — every field optional, at least one required.
 *  A material content change (title/description/ingredients/allergens/cuisine) resets
 *  moderation_status to 'pending' in the service (FR-08). */
const update = z
  .object({
    title: safeText({ min: 3, max: 200 }).optional(),
    description: safeText({ min: 1, max: 5000 }).optional(),
    ingredients: z.array(shortLabel).min(1).max(50).optional(),
    allergens: z.array(shortLabel).max(50).optional(),
    cuisine: safeText({ min: 1, max: 80 }).nullable().optional(),
    scheduledStart: scheduledStart.optional(),
    durationMinutes: z.coerce.number().int('must be an integer').min(1).max(1440).optional(),
    seatCapacity: z.coerce.number().int('must be an integer').min(1).optional(),
    addressLine1: addressFields.addressLine1.optional(),
    addressLine2: addressFields.addressLine2.nullable().optional(),
    city: addressFields.city.optional(),
    region: addressFields.region.optional(),
    postalCode: addressFields.postalCode.nullable().optional(),
    country: country.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'must set at least one listing field',
  });

/** Path params for /:id routes — the id is additionally UUID-regex-constrained in the route
 *  pattern itself so /api/listings/search falls through to the search router (build-plan §6.5). */
const idParams = z.object({ id: uuid });

/** Input-less routes (GET /:id, POST /:id/cancel) still declare a validator (NFR-11). */
const noInput = z.object({});

module.exports = { create, update, idParams, noInput };
