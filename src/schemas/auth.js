// src/schemas/auth.js — U2-IDENTITY: zod schemas for every auth/users route (API boundary).
//
// Requirement traceability (SRS Appendix B):
//   FR-10  — registration and email-verification input shapes (valid data creates an
//            unverified account; the token is an opaque single-use string)
//   NFR-04 — password policy bounds; max 72 characters keeps the documented bcryptjs
//            cost-12 fallback sound (bcrypt truncates input at 72 bytes — ST-02 notes)
//   NFR-06 — profile-update shape carries exactly the attributes the eligibility policy
//            reads (full name, phone, host profile/agreement); recomputation happens in
//            src/modules/users/service.js through the single U2-ELIGIBILITY policy
//   NFR-11 / AB-06 — every field is validated + sanitized through the shared U1-VALID
//            layer (safeText escapes markup; hostile strings arrive as inert data)
//   NFR-13 — emergency contact collected minimally (name, phone, email only — §3.4)
//
// These schemas are consumed by validate({ body, query, params }) from
// src/middleware/validate.js; password values are redacted from its error output.
'use strict';

const { z } = require('zod');
const { email, phoneE164, safeText } = require('./common');

// NFR-04: minimum 8 characters (NIST SP 800-63B style length-first policy); maximum 72 so
// the documented bcryptjs fallback (ST-02) can never silently truncate what Argon2id hashed.
const password = z
  .string()
  .min(8, 'must be at least 8 characters')
  .max(72, 'must be at most 72 characters');

// Opaque email-verification token: 32 random bytes base64url-encoded (43 chars) from
// src/modules/users/tokens.js. Bounds only — the DB lookup decides validity (FR-10).
const verificationToken = z
  .string()
  .trim()
  .min(20, 'must be a verification token')
  .max(200, 'must be a verification token')
  .regex(/^[A-Za-z0-9_-]+$/, 'must be a verification token');

/** POST /api/auth/register (FR-10). fullName/phone are optional at registration — the
 *  NFR-06 eligibility flags simply stay false until the profile is completed. */
const register = z.object({
  email,
  password,
  fullName: safeText({ min: 1, max: 120 }).optional(),
  phone: phoneE164.optional(),
});

/** POST /api/auth/login (NFR-05). Bounds only — never reveal the password policy here,
 *  and never distinguish "no such account" from "wrong password" (AB-05). */
const login = z.object({
  email,
  password: z.string().min(1, 'is required').max(72, 'must be at most 72 characters'),
});

/** POST /api/auth/verify-email — token in the body (FR-10). */
const verifyEmailBody = z.object({ token: verificationToken });

/** GET /api/auth/verify-email?token=… — token in the query string (FR-10). */
const verifyEmailQuery = z.object({ token: verificationToken });

/** §3.4 emergency contact: a third party's personal data, collected minimally —
 *  name, phone, email and nothing else (NFR-13). Stored encrypted at rest (U1-DB). */
const emergencyContact = z.object({
  name: safeText({ min: 1, max: 120 }),
  phone: phoneE164,
  email,
});

/** Host-profile completion data (NFR-06 canPublishListing inputs). acceptHostAgreement
 *  is literal true — an agreement cannot be "accepted" with false, and un-acceptance is
 *  not a v1.0 flow. */
const hostProfile = z
  .object({
    bio: safeText({ min: 1, max: 2000 }).optional(),
    acceptHostAgreement: z.literal(true).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'must set at least one host-profile field',
  });

/** PATCH /api/users/me (NFR-06). Every field optional; null clears a nullable attribute.
 *  After this mutation the users service recomputes canReserveSeat / canPublishListing
 *  through the single U2-ELIGIBILITY policy (FR-09/NFR-06 — never a local re-implementation). */
const profileUpdate = z
  .object({
    fullName: safeText({ min: 1, max: 120 }).nullable().optional(),
    phone: phoneE164.nullable().optional(),
    emergencyContact: emergencyContact.nullable().optional(),
    hostProfile: hostProfile.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'must set at least one profile field',
  });

/** For routes that accept NO input (GET /me, POST /logout): validates the query as an
 *  empty object (unknown keys stripped) so the NFR-11 route-enumeration check finds a
 *  declared schema on EVERY route, input-less ones included. */
const noInput = z.object({});

module.exports = {
  register,
  login,
  verifyEmailBody,
  verifyEmailQuery,
  profileUpdate,
  password,
  verificationToken,
  emergencyContact,
  noInput,
};
