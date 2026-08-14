// src/modules/users/tokens.js — U2-IDENTITY: email-verification tokens (FR-10).
//
// Requirement traceability (SRS Appendix B):
//   FR-10 (TC-10) — a registration creates a single-use, expiring verification token;
//                   only confirming the correct raw token marks the email verified. The
//                   database stores ONLY the SHA-256 digest (email_verification_tokens.
//                   token_hash, U1-DB migration 0001): a database leak yields no usable
//                   verification links. Expiry is config.auth.emailTokenTtlHours
//                   (EMAIL_TOKEN_TTL_HOURS); consumption is atomic and single-use.
//   AB-07         — an account cannot act as verified until this confirmation runs.
//
// The RAW token exists only in memory (and, in live mode, in the verification email);
// it is never persisted, never logged (the U1-OBS logger redacts *token keys as
// defence in depth), and never returned in an API response.
'use strict';

const crypto = require('crypto');
const config = require('../../config');

const TOKEN_BYTES = 32; // 256-bit single-use capability

/** SHA-256 hex digest — the only form of the token that ever touches PostgreSQL. */
function hashToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length === 0) {
    throw new TypeError('hashToken: rawToken must be a non-empty string');
  }
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/** Mint a fresh raw token + its storage digest. */
function generateToken() {
  const raw = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

/**
 * Create an email-verification token row for a user, on the CALLER'S transaction client —
 * registration commits the user row, this token and the outbox row atomically (FR-10,
 * ADR-001 "no dual writes").
 * @param {import('pg').PoolClient} client  the withTransaction client
 * @param {string} userId
 * @param {{ttlHours?: number}} [options]
 * @returns {Promise<{raw: string, hash: string, expiresAt: Date}>}
 */
async function createEmailVerificationToken(client, userId, { ttlHours } = {}) {
  const hours = ttlHours ?? config.auth.emailTokenTtlHours;
  const { raw, hash } = generateToken();
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000);
  await client.query(
    `INSERT INTO email_verification_tokens (token_hash, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [hash, userId, expiresAt]
  );
  return { raw, hash, expiresAt };
}

/**
 * Atomically consume a verification token: exactly one UPDATE marks it used IF it exists,
 * is unconsumed, and is unexpired — the WHERE clause is the entire FR-10 validity rule, so
 * wrong, already-used and expired tokens all fall into the same "0 rows" failure and the
 * caller returns 400 with email_verified unchanged. Single-use is guaranteed by
 * `consumed_at IS NULL` even under concurrent confirmation attempts (row-level lock on
 * UPDATE).
 * @param {import('pg').PoolClient} client  transaction client (same tx flips users.email_verified)
 * @param {string} rawToken
 * @returns {Promise<string|null>} the owning user_id, or null when invalid/used/expired
 */
async function consumeEmailVerificationToken(client, rawToken) {
  const { rows } = await client.query(
    `UPDATE email_verification_tokens
        SET consumed_at = now()
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING user_id`,
    [hashToken(rawToken)]
  );
  return rows.length === 1 ? rows[0].user_id : null;
}

module.exports = {
  generateToken,
  hashToken,
  createEmailVerificationToken,
  consumeEmailVerificationToken,
  TOKEN_BYTES,
};
