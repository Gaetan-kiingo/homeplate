// src/modules/eligibility/repo.js — U2-ELIGIBILITY: read-only attribute snapshot for the
// eligibility policy (FR-09, NFR-06).
//
// Requirement traceability (SRS Appendix B):
//   FR-09 / NFR-06 — supplies exactly the attributes the policy rules need (email_verified,
//                    full_name presence, phone presence, host profile completeness,
//                    host-agreement acceptance) in ONE parameterized query.
//   NFR-11         — parameterized SQL only ($1 placeholder; no interpolation).
//   NFR-12         — soft-deleted (deleted_at) and anonymized (anonymized_at) accounts are
//                    treated as not found: an erased account can never act.
//   NFR-13 / AB-08 — data minimization: presence is computed IN SQL and only booleans leave
//                    the database. The encrypted phone ciphertext, the full name text and the
//                    email address are never selected, so no PII can reach results or logs.
//
// PostgreSQL is the sole source of truth for eligibility inputs (SRS §2.4); the denormalized
// users.can_reserve_seat / can_publish_listing flags are OUTPUTS the identity module persists
// from the policy's answer, so this repo deliberately does not read them.
'use strict';

const pool = require('../../db/pool');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SNAPSHOT_SQL = `
  SELECT u.id                                                        AS user_id,
         u.email_verified                                            AS email_verified,
         (u.full_name IS NOT NULL AND btrim(u.full_name) <> '')      AS has_full_name,
         (u.phone_enc IS NOT NULL AND btrim(u.phone_enc) <> '')      AS has_phone,
         (hp.user_id IS NOT NULL
          AND hp.bio IS NOT NULL AND btrim(hp.bio) <> '')            AS host_profile_complete,
         hp.host_agreement_accepted_at                               AS host_agreement_accepted_at
  FROM users u
  LEFT JOIN host_profiles hp ON hp.user_id = u.id
  WHERE u.id = $1
    AND u.deleted_at IS NULL
    AND u.anonymized_at IS NULL
`;

/**
 * Load the eligibility attribute snapshot for one user.
 *
 * @param {string} userId  UUID; a malformed id is treated as "no such user" rather than
 *   surfacing a PostgreSQL 22P02 cast error as a 500 (defense in depth at the boundary).
 * @param {import('pg').PoolClient|null} [client]  optional transaction client (ADR-001:
 *   wave-3 flows evaluate eligibility on the same client as their business write).
 * @returns {Promise<null | {
 *   user_id: string,
 *   email_verified: boolean,
 *   has_full_name: boolean,
 *   has_phone: boolean,
 *   host_profile_complete: boolean,
 *   host_agreement_accepted_at: Date|null,
 * }>} null when the user does not exist or is deleted/anonymized (NFR-12).
 */
async function getEligibilityAttributes(userId, client = null) {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return null;
  }
  const runner = client ?? pool;
  const { rows } = await runner.query(SNAPSHOT_SQL, [userId]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    user_id: row.user_id,
    email_verified: Boolean(row.email_verified),
    has_full_name: Boolean(row.has_full_name),
    has_phone: Boolean(row.has_phone),
    host_profile_complete: Boolean(row.host_profile_complete),
    host_agreement_accepted_at: row.host_agreement_accepted_at ?? null,
  };
}

module.exports = { getEligibilityAttributes };
