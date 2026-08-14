// src/modules/notifications/repo.js — U2-ADAPTERS-COMMS: NOTIFICATION_ATTEMPT persistence
// (§3.4 NOTIFICATION_ATTEMPT; db/migrations/0001_core_schema.sql notification_attempts).
//
// Every transport.send() — mock or live — writes exactly one attempt row here, and the
// entire automated suite asserts on these rows instead of any third party's behaviour
// (ADR-011). Rows carry the RECIPIENT USER ID only, never a name, email address or phone
// number (§3.4 PII register, ADR-003); the worker resolves the recipient address at send
// time via getRecipientEmail() and it never lands in a row or a log line.
//
// Requirement traceability (SRS Appendix B):
//   FR-13, FR-14 — booking notification attempts recorded per try with status
//                  sent/failed/retrying (TC-13/TC-14 assert on these rows)
//   FR-07        — emergency-contact delivery attempts remain visible for review;
//                  retries increment attempt_count (TC-07/IT-04)
//   NFR-09       — recordTry/markFailed give the resilience path a persisted audit of
//                  bounded retries; a failed attempt is a row, not an exception
//   NFR-08       — attempt rows carry stable statuses + timestamps for MT-01 audits
//   NFR-11       — parameterized SQL only ($n placeholders, never interpolation)
//
// transport.send() idempotency: notification_attempts.idempotency_key is UNIQUE, so a
// retried outbox delivery that reuses its key reuses its row (createAttempt ON CONFLICT).
'use strict';

const { query } = require('../../db/pool');
const { InternalError } = require('../../lib/errors');

const RETURNING = `id, recipient_user_id, channel, template, params, status, attempt_count,
                   idempotency_key, last_error, sent_at, created_at, updated_at`;

/**
 * Insert the attempt row for one transport.send(), or reuse the existing row when the
 * idempotencyKey was seen before (UNIQUE constraint — the double-send guard, ADR-011).
 *
 * @param {object} input { recipientUserId, channel, template, params, idempotencyKey }
 * @param {import('pg').PoolClient} [client]  optional transaction client
 * @returns {Promise<{attempt: object, created: boolean}>}
 */
async function createAttempt(
  { recipientUserId, channel, template, params = {}, idempotencyKey = null },
  client = null
) {
  const run = (text, values) => (client ? client.query(text, values) : query(text, values));
  const insert = await run(
    `INSERT INTO notification_attempts (recipient_user_id, channel, template, params, idempotency_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING ${RETURNING}`,
    [recipientUserId, channel, template, params, idempotencyKey]
  );
  if (insert.rows.length > 0) {
    return { attempt: insert.rows[0], created: true };
  }
  // Conflict: a row with this idempotency key already exists — reuse it.
  const existing = await findByIdempotencyKey(idempotencyKey, client);
  if (!existing) {
    // Only reachable if the conflicting row vanished between the two statements.
    throw new InternalError('notification attempt insert conflicted but no row was found', {
      code: 'NOTIFICATION_ATTEMPT_RACE',
    });
  }
  return { attempt: existing, created: false };
}

/**
 * Record one delivery try: increments attempt_count and, from the second try on, moves the
 * row to 'retrying' (FR-07 "failed delivery shall be retried and remain visible").
 * The 0002 trigger maintains updated_at.
 * @returns {Promise<object>} the updated row
 */
async function recordTry(id, lastError = null, client = null) {
  const run = (text, values) => (client ? client.query(text, values) : query(text, values));
  const { rows } = await run(
    `UPDATE notification_attempts
     SET attempt_count = attempt_count + 1,
         status = CASE WHEN attempt_count + 1 > 1
                       THEN 'retrying'::notification_status
                       ELSE status END,
         last_error = COALESCE($2, last_error)
     WHERE id = $1
     RETURNING ${RETURNING}`,
    [id, lastError]
  );
  return rows[0] ?? null;
}

/** Delivery succeeded: status 'sent', sent_at stamped, last_error cleared. */
async function markSent(id, client = null) {
  const run = (text, values) => (client ? client.query(text, values) : query(text, values));
  const { rows } = await run(
    `UPDATE notification_attempts
     SET status = 'sent', sent_at = now(), last_error = NULL
     WHERE id = $1
     RETURNING ${RETURNING}`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Delivery exhausted its bounded retries (or was refused, e.g. the ADR-011 push gate):
 * status 'failed' with a PII-free reason. The row remains for review (FR-07, NFR-09).
 */
async function markFailed(id, lastError, client = null) {
  const run = (text, values) => (client ? client.query(text, values) : query(text, values));
  const { rows } = await run(
    `UPDATE notification_attempts
     SET status = 'failed', last_error = $2
     WHERE id = $1
     RETURNING ${RETURNING}`,
    [id, lastError]
  );
  return rows[0] ?? null;
}

/**
 * FR-07: the raising user has no approved emergency-contact channel — the attempt is
 * RECORDED as 'no_channel' (visible for review), which is distinct from a failure: there
 * was nothing to deliver to, so nothing is retried (§3.4 notification_status).
 */
async function markNoChannel(id, note = 'no emergency contact on file (FR-07)', client = null) {
  const run = (text, values) => (client ? client.query(text, values) : query(text, values));
  const { rows } = await run(
    `UPDATE notification_attempts
     SET status = 'no_channel', last_error = $2
     WHERE id = $1
     RETURNING ${RETURNING}`,
    [id, note]
  );
  return rows[0] ?? null;
}

/** Lookup by idempotency key (UNIQUE) — the transport's double-send guard. */
async function findByIdempotencyKey(idempotencyKey, client = null) {
  if (idempotencyKey === null || idempotencyKey === undefined) return null;
  const run = (text, values) => (client ? client.query(text, values) : query(text, values));
  const { rows } = await run(
    `SELECT ${RETURNING} FROM notification_attempts WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  return rows[0] ?? null;
}

/** Lookup by primary key. */
async function findById(id) {
  const { rows } = await query(`SELECT ${RETURNING} FROM notification_attempts WHERE id = $1`, [
    id,
  ]);
  return rows[0] ?? null;
}

/** All attempts for one recipient, oldest first (uses the 0002 recipient index). */
async function listForUser(recipientUserId) {
  const { rows } = await query(
    `SELECT ${RETURNING} FROM notification_attempts
     WHERE recipient_user_id = $1
     ORDER BY created_at ASC, id ASC`,
    [recipientUserId]
  );
  return rows;
}

/**
 * Resolve the recipient's email address AT SEND TIME for the live email adapter.
 * The address is handed straight to the adapter and must never be written to a
 * notification row, an outbox payload or a log line (§3.4 PII register, ADR-003).
 * @returns {Promise<{email: string|null, emailVerified: boolean}|null>} null → no such user
 */
async function getRecipientEmail(userId) {
  const { rows } = await query(
    `SELECT email, email_verified FROM users WHERE id = $1 AND deleted_at IS NULL`,
    [userId]
  );
  if (rows.length === 0) return null;
  return { email: rows[0].email ?? null, emailVerified: rows[0].email_verified };
}

module.exports = {
  createAttempt,
  recordTry,
  markSent,
  markFailed,
  markNoChannel,
  findByIdempotencyKey,
  findById,
  listForUser,
  getRecipientEmail,
};
