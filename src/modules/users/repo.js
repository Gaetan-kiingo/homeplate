// src/modules/users/repo.js — U2-IDENTITY: the users/host_profiles data access layer.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-10 (TC-10) — createUser writes email_verified=false + password hash only;
//                   markEmailVerified flips the flag after token confirmation.
//   NFR-04        — this repo accepts a HASH (passwords.js output); no code path here
//                   ever sees or stores a plaintext password.
//   NFR-06        — setEligibilityFlags persists canReserveSeat / canPublishListing as
//                   computed by the single U2-ELIGIBILITY policy (users/service.js calls
//                   it — this repo only persists the result, it implements NO rule).
//   NFR-11        — every statement is parameterized ($n placeholders, U1-DB pool/client).
//   NFR-13        — phone and the §3.4 emergency contact are stored ONLY as AES-256-GCM
//                   ciphertext (src/db/fieldCrypto.js *_enc columns); serializeUser builds
//                   API output from an explicit field ALLOWLIST — password_hash and raw
//                   ciphertext can never leak through it (AB-08 data minimization).
//   AB-07         — duplicate email registration surfaces PostgreSQL 23505 on
//                   users_email_key; the service maps it to 409.
//   NFR-12        — touchLastActive maintains last_active_at for the inactivity sweep.
'use strict';

const { query } = require('../../db/pool');
const { encrypt, decrypt } = require('../../db/fieldCrypto');

/** Runs on the caller's transaction client when given one, else on the pool (NFR-11). */
function runner(client) {
  return client || { query };
}

/**
 * Insert a new unverified user (FR-10). Eligibility flags start false (schema default);
 * the service recomputes them through the U2-ELIGIBILITY policy after commit.
 * Throws pg error 23505 (users_email_key) on a duplicate email — the service maps it
 * to ConflictError 409 (AB-07).
 * @param {import('pg').PoolClient} client  the registration transaction's client
 * @param {{email: string, passwordHash: string, fullName?: string|null, phone?: string|null}} data
 * @returns {Promise<object>} the inserted users row
 */
async function createUser(client, { email, passwordHash, fullName = null, phone = null }) {
  const { rows } = await runner(client).query(
    `INSERT INTO users (email, password_hash, full_name, phone_enc)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [email, passwordHash, fullName, encrypt(phone)]
  );
  return rows[0];
}

/** Case-canonical lookup for login/registration (schemas lowercase the email first). */
async function findByEmail(email, client = null) {
  const { rows } = await runner(client).query(`SELECT * FROM users WHERE email = $1`, [email]);
  return rows[0] || null;
}

async function findById(id, client = null) {
  const { rows } = await runner(client).query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

/** FR-10: flip email_verified after successful token consumption (same transaction). */
async function markEmailVerified(client, userId) {
  const { rows } = await runner(client).query(
    `UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1 RETURNING *`,
    [userId]
  );
  return rows[0] || null;
}

// PATCH /api/users/me → SET clause fragments. Keys are the API patch fields; encrypted
// columns go through fieldCrypto so plaintext never reaches PostgreSQL (NFR-13).
const PROFILE_COLUMNS = Object.freeze({
  fullName: { column: 'full_name', transform: (v) => v },
  phone: { column: 'phone_enc', transform: (v) => encrypt(v) },
  emergencyContactName: { column: 'emergency_contact_name_enc', transform: (v) => encrypt(v) },
  emergencyContactPhone: { column: 'emergency_contact_phone_enc', transform: (v) => encrypt(v) },
  emergencyContactEmail: { column: 'emergency_contact_email_enc', transform: (v) => encrypt(v) },
});

/**
 * Apply a partial profile update (NFR-06 attribute surface). `patch` uses API field names;
 * a null value clears the column. Unknown keys are a programming error and throw.
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @param {object} patch  e.g. { fullName, phone, emergencyContactName, ... }
 * @returns {Promise<object>} the updated users row
 */
async function updateProfileFields(client, userId, patch) {
  const sets = [];
  const values = [userId];
  for (const [field, value] of Object.entries(patch)) {
    const spec = PROFILE_COLUMNS[field];
    if (!spec) {
      throw new TypeError(`users repo: unknown profile field "${field}"`);
    }
    values.push(value === null ? null : spec.transform(value));
    sets.push(`${spec.column} = $${values.length}`);
  }
  if (sets.length === 0) {
    const row = await findById(userId, client);
    return row;
  }
  const { rows } = await runner(client).query(
    `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    values
  );
  return rows[0] || null;
}

/**
 * Persist the eligibility flags exactly as the single policy computed them (NFR-06 —
 * "registration and profile update recompute and persist the eligibility flags").
 * @param {string} userId
 * @param {{canReserveSeat: boolean, canPublishListing: boolean}} flags
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object>} the updated users row
 */
async function setEligibilityFlags(userId, { canReserveSeat, canPublishListing }, client = null) {
  const { rows } = await runner(client).query(
    `UPDATE users
        SET can_reserve_seat = $2, can_publish_listing = $3, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [userId, canReserveSeat === true, canPublishListing === true]
  );
  return rows[0] || null;
}

/** NFR-12: successful logins refresh last_active_at for the 24-month inactivity sweep. */
async function touchLastActive(userId, client = null) {
  await runner(client).query(`UPDATE users SET last_active_at = now() WHERE id = $1`, [userId]);
}

/** Upsert the user's host profile (NFR-06 canPublishListing inputs; §3.4: one per user). */
async function upsertHostProfile(client, userId, { bio, acceptHostAgreement } = {}) {
  const { rows } = await runner(client).query(
    `INSERT INTO host_profiles (user_id, bio, host_agreement_accepted_at)
     VALUES ($1, $2, CASE WHEN $3 THEN now() ELSE NULL END)
     ON CONFLICT (user_id) DO UPDATE SET
       bio = COALESCE(EXCLUDED.bio, host_profiles.bio),
       host_agreement_accepted_at = CASE
         WHEN $3 THEN COALESCE(host_profiles.host_agreement_accepted_at, now())
         ELSE host_profiles.host_agreement_accepted_at
       END,
       updated_at = now()
     RETURNING *`,
    [userId, bio ?? null, acceptHostAgreement === true]
  );
  return rows[0];
}

async function getHostProfile(userId, client = null) {
  const { rows } = await runner(client).query(`SELECT * FROM host_profiles WHERE user_id = $1`, [
    userId,
  ]);
  return rows[0] || null;
}

/**
 * The explicit ALLOWLIST serializer for a user's OWN profile (NFR-13 / AB-08: responses
 * are built from allowlists, never by spreading a row). Decrypts the owner's phone and
 * emergency contact — this shape is only ever returned to the authenticated owner
 * (GET/PATCH /api/users/me). password_hash and raw *_enc ciphertext have no path out.
 * @param {object} row  users row
 * @param {object|null} [hostProfile]  host_profiles row
 * @returns {object}
 */
function serializeUser(row, hostProfile = null) {
  const emergencyContact =
    row.emergency_contact_name_enc ||
    row.emergency_contact_phone_enc ||
    row.emergency_contact_email_enc
      ? {
          name: decrypt(row.emergency_contact_name_enc),
          phone: decrypt(row.emergency_contact_phone_enc),
          email: decrypt(row.emergency_contact_email_enc),
        }
      : null;
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified,
    fullName: row.full_name,
    phone: decrypt(row.phone_enc),
    emergencyContact,
    canReserveSeat: row.can_reserve_seat,
    canPublishListing: row.can_publish_listing,
    roles: row.roles,
    hostProfile: hostProfile
      ? {
          bio: hostProfile.bio,
          hostAgreementAcceptedAt: hostProfile.host_agreement_accepted_at,
        }
      : null,
    createdAt: row.created_at,
  };
}

module.exports = {
  createUser,
  findByEmail,
  findById,
  markEmailVerified,
  updateProfileFields,
  setEligibilityFlags,
  touchLastActive,
  upsertHostProfile,
  getHostProfile,
  serializeUser,
};
