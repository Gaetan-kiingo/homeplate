// src/modules/messaging/repo.js — U4-MESSAGING: data access for the FR-06 booking thread
// (§3.4 MESSAGE; db/migrations/0001 messages, 0002 messages_booking_created_idx).
//
// Requirement traceability (SRS Appendix B):
//   FR-06 (TC-06) — insertMessage() persists one thread message (booking, sender, body);
//                   the row is born moderation_status='pending' (0001 column default),
//                   which for a MESSAGE means "delivered, scan outstanding" — delivery
//                   never waits on moderation (ADR-002). listVisibleForBooking() /
//                   countVisibleForBooking() are the thread read: every message EXCEPT
//                   rejected ones, oldest first, so a later-flagged (rejected) message
//                   disappears from subsequent GETs while pending/approved ones stay.
//   FR-08 / AB-04 — this repo never flips moderation_status: the ONE writer of
//                   approved/rejected is the U4-MODERATION repo, on the pipeline's or a
//                   human moderator's decision. Hiding is a READ-side rule here.
//   NFR-13 / ADR-010 — MESSAGE_COLS selects IDs, the body and timestamps only: no email,
//                   phone, address or coordinate column exists on messages, and none is
//                   ever joined in, so nothing a message read serializes can leak §3.4
//                   PII or a listing location (no listing location data rides a message).
//   NFR-11 (ST-04) — parameterized SQL only ($n placeholders); identifiers are static.
//
// All functions accept an optional pg client so callers can compose them into a
// withTransaction unit of work (ADR-001 — one transaction, no dual writes).
'use strict';

const { query } = require('../../db/pool');

/** Message columns that leave this module (never a raw row spread). */
const MESSAGE_COLS = 'id, booking_id, sender_id, body, moderation_status, created_at';

function run(text, params, client) {
  return client ? client.query(text, params) : query(text, params);
}

/**
 * Persist one thread message (FR-06). The caller (service) has already established that
 * the sender is a participant of the booking and that the booking is not cancelled.
 *
 * @param {import('pg').PoolClient} client  the transaction client (the message row and its
 *        moderation.scan outbox row MUST commit together — ADR-001/003)
 * @param {{bookingId: string, senderId: string, body: string}} message
 * @returns {Promise<object>} the persisted message row (snake_case, MESSAGE_COLS)
 */
async function insertMessage(client, { bookingId, senderId, body }) {
  const { rows } = await client.query(
    `INSERT INTO messages (booking_id, sender_id, body)
     VALUES ($1, $2, $3)
     RETURNING ${MESSAGE_COLS}`,
    [bookingId, senderId, body]
  );
  return rows[0];
}

/**
 * The visible thread page for one booking, oldest first (FR-06 chat order; 0002
 * messages_booking_created_idx). "Visible" = everything except rejected: a pending message
 * is already delivered (ADR-002 — the async scan never withholds it) and an approved one
 * stays; only a moderation rejection hides a message from subsequent reads (AB-04).
 *
 * @param {string} bookingId
 * @param {{page?: number, pageSize?: number}} pageOpts  capped by the shared schema (NFR-02)
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<object[]>} message rows (MESSAGE_COLS), created_at ascending
 */
async function listVisibleForBooking(bookingId, { page = 1, pageSize = 20 } = {}, client = null) {
  const { rows } = await run(
    `SELECT ${MESSAGE_COLS} FROM messages
      WHERE booking_id = $1 AND moderation_status <> 'rejected'
      ORDER BY created_at ASC, id ASC
      LIMIT $2 OFFSET $3`,
    [bookingId, pageSize, (page - 1) * pageSize],
    client
  );
  return rows;
}

/** Total visible (non-rejected) messages of one booking — pagination metadata (NFR-02). */
async function countVisibleForBooking(bookingId, client = null) {
  const { rows } = await run(
    `SELECT count(*)::int AS count FROM messages
      WHERE booking_id = $1 AND moderation_status <> 'rejected'`,
    [bookingId],
    client
  );
  return rows[0].count;
}

module.exports = {
  MESSAGE_COLS,
  insertMessage,
  listVisibleForBooking,
  countVisibleForBooking,
};
