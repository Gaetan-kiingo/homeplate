// src/modules/safety/repo.js — U4-SAFETY: SAFETY_ALERT data access (§3.4 SAFETY_ALERT;
// db/migrations/0001_core_schema.sql safety_alerts). Parameterized SQL only (NFR-11); every
// statement that belongs to a unit of work takes the caller's TRANSACTION client so the
// service can commit the alert row and its outbox row together (ADR-001/003).
//
// Requirement traceability (SRS Appendix B):
//   FR-07 (TC-07, IT-04) — insertAlert() persists the alert with delivery_status 'pending';
//                   the delivery worker moves it to 'delivered' / 'retrying' / 'failed' /
//                   'no_channel' through the mark* statements below. Every mark* is
//                   conditional on the row not already being 'delivered', so a redelivered
//                   outbox job can never walk a delivered alert backwards (RT-02).
//                   listForModerators() is the FR-07 moderator queue: an alert stays listed
//                   for review no matter how its delivery ends — including after the outbox
//                   job dead-letters ("failed delivery … shall remain visible for review").
//   NFR-11 (ST-04) — $n placeholders everywhere; identifiers are static strings.
//   NFR-13         — this module never selects a name, phone or email. The ONE column of
//                   third-party PII it reads is users.emergency_contact_email_enc, returned
//                   as CIPHERTEXT to the worker-only delivery handler, which decrypts it at
//                   send time and hands it straight to the transport (§3.4 PII register).
//
// Public interface (build-plan §3 wave-4 contract):
//   insertAlert(client, {bookingId, raisedBy})            → alert row
//   loadForDelivery(alertId)                              → alert + booking + contact ciphertext
//   markDelivered / markRetrying / markFailed / markNoChannel(alertId)
//   listModeratorIds()                                    → moderator user IDs (FR-07 notify)
//   listForModerators({page,pageSize,status}) / countForModerators({status})
//   unifiedQueueSupported() / fileUnifiedQueueEntry(alertId) — the U4-SAFETY-COMPLETE
//   unified-4A-queue write model (moderation_queue rows of content_type 'safety_alert')
'use strict';

const pool = require('../../db/pool');
// Published U4-MODERATION contract only (build-plan §5 note: 4A owns src/modules/moderation).
// CONTENT_TYPES is the read model's declared content-type domain; nothing else is consumed.
const moderationRepo = require('../moderation/repo');

/** Alert columns that ever leave this module (never a raw row spread). */
const ALERT_COLS = `id, booking_id, raised_by, delivery_status, delivered_at, created_at, updated_at`;

function runner(client) {
  return client ?? pool;
}

/**
 * Persist one safety alert (FR-07 "the system shall persist the alert").
 * MUST run on the caller's transaction client: the alert row and the outbox row that defers
 * its delivery commit together or not at all (ADR-001/003 — no dual writes).
 *
 * @param {import('pg').PoolClient} client  the transaction client (withTransaction)
 * @param {{bookingId: string, raisedBy: string}} input
 * @returns {Promise<object>} the persisted alert row (delivery_status 'pending')
 */
async function insertAlert(client, { bookingId, raisedBy }) {
  const { rows } = await client.query(
    `INSERT INTO safety_alerts (booking_id, raised_by) VALUES ($1, $2) RETURNING ${ALERT_COLS}`,
    [bookingId, raisedBy]
  );
  return rows[0];
}

/** One alert by id (participant read-back / tests). */
async function findById(alertId, client = null) {
  const { rows } = await runner(client).query(
    `SELECT ${ALERT_COLS} FROM safety_alerts WHERE id = $1`,
    [alertId]
  );
  return rows[0] ?? null;
}

/**
 * Everything the worker-only delivery handler needs for one alert, in one read: the alert
 * state, its booking/listing references, and the raising user's emergency-contact address
 * AS CIPHERTEXT (decrypted at send time by the handler — never here, never in a log line).
 * A raiser whose account was erased (raised_by NULL / users row soft-deleted) yields a null
 * ciphertext, which the handler records as 'no_channel' rather than inventing a recipient.
 *
 * @returns {Promise<object|null>} null when the alert no longer exists
 */
async function loadForDelivery(alertId, client = null) {
  const { rows } = await runner(client).query(
    `SELECT sa.id, sa.booking_id, sa.raised_by, sa.delivery_status, sa.delivered_at,
            sa.created_at, sa.updated_at,
            b.listing_id, b.status AS booking_status,
            u.emergency_contact_email_enc
       FROM safety_alerts sa
       JOIN bookings b ON b.id = sa.booking_id
       LEFT JOIN users u ON u.id = sa.raised_by AND u.deleted_at IS NULL
      WHERE sa.id = $1`,
    [alertId]
  );
  return rows[0] ?? null;
}

/**
 * Terminal success: the emergency-contact email was accepted by the transport (FR-07).
 * Conditional so a duplicate delivery cannot re-stamp delivered_at (RT-02 idempotence).
 */
async function markDelivered(alertId, client = null) {
  const { rows } = await runner(client).query(
    `UPDATE safety_alerts SET delivery_status = 'delivered', delivered_at = now()
      WHERE id = $1 AND delivery_status <> 'delivered'
      RETURNING ${ALERT_COLS}`,
    [alertId]
  );
  return rows[0] ?? null;
}

/**
 * Delivery failed and the outbox still has retry budget (FR-07 "failed delivery shall be
 * retried and remain visible for review"): the alert reads 'retrying' while the worker backs
 * off, and it stays in the moderator queue throughout.
 */
async function markRetrying(alertId, client = null) {
  const { rows } = await runner(client).query(
    `UPDATE safety_alerts SET delivery_status = 'retrying'
      WHERE id = $1 AND delivery_status <> 'delivered'
      RETURNING ${ALERT_COLS}`,
    [alertId]
  );
  return rows[0] ?? null;
}

/**
 * Terminal failure: the retry budget is exhausted (the job dead-letters on this attempt) or
 * the stored contact channel is unusable. The row REMAINS in the moderator queue — a failed
 * safety alert is exactly what a human must see (FR-07, NFR-09 visibility).
 */
async function markFailed(alertId, client = null) {
  const { rows } = await runner(client).query(
    `UPDATE safety_alerts SET delivery_status = 'failed'
      WHERE id = $1 AND delivery_status <> 'delivered'
      RETURNING ${ALERT_COLS}`,
    [alertId]
  );
  return rows[0] ?? null;
}

/**
 * The raising user has no approved emergency-contact channel: there is nothing to deliver to,
 * which is NOT a failure and is never retried (§3.4 alert_delivery_status 'no_channel').
 */
async function markNoChannel(alertId, client = null) {
  const { rows } = await runner(client).query(
    `UPDATE safety_alerts SET delivery_status = 'no_channel'
      WHERE id = $1 AND delivery_status <> 'delivered'
      RETURNING ${ALERT_COLS}`,
    [alertId]
  );
  return rows[0] ?? null;
}

/**
 * The moderators to notify (SRS §2.3: "Moderators … receive safety alerts (FR-07)").
 * IDs only — the transport resolves each address at send time (§3.4 PII register).
 */
async function listModeratorIds(client = null) {
  const { rows } = await runner(client).query(
    `SELECT id FROM users
      WHERE 'moderator' = ANY(roles) AND deleted_at IS NULL
      ORDER BY created_at ASC, id ASC`
  );
  return rows.map((r) => r.id);
}

/**
 * The FR-07 moderator queue page: alerts newest first with the booking/listing references a
 * moderator needs to act. No PII is selected here — and this module deliberately writes no
 * NFR-13 access record, because it discloses none: opening the listing itself is what triggers
 * the ADR-010 moderator disclosure and its logging, in src/modules/listings/access.js (the ONE
 * writer of that table).
 *
 * @param {{page?: number, pageSize?: number, status?: string}} [options]
 */
async function listForModerators({ page = 1, pageSize = 20, status } = {}) {
  const params = [];
  let where = '';
  if (status !== undefined) {
    params.push(status);
    where = `WHERE sa.delivery_status = $${params.length}::alert_delivery_status`;
  }
  params.push(pageSize, (page - 1) * pageSize);
  const { rows } = await pool.query(
    `SELECT sa.id, sa.booking_id, sa.raised_by, sa.delivery_status, sa.delivered_at,
            sa.created_at, sa.updated_at,
            b.status AS booking_status, b.listing_id, l.host_id
       FROM safety_alerts sa
       JOIN bookings b ON b.id = sa.booking_id
       JOIN listings l ON l.id = b.listing_id
       ${where}
      ORDER BY sa.created_at DESC, sa.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

// ---- unified 4A queue (U4-SAFETY-COMPLETE — moderation_queue rows of type 'safety_alert') ----

/** The moderation_content_type label a safety alert's unified-queue entry carries
 *  (db/migrations/0006_safety_moderation_queue.sql). */
const UNIFIED_QUEUE_CONTENT_TYPE = 'safety_alert';

/** The moderation_queue.reason recorded on an alert's unified-queue entry. */
const UNIFIED_QUEUE_REASON = 'safety_alert';

/**
 * Whether the U4-MODERATION unified-queue READ model can serve 'safety_alert' entries yet.
 *
 * The moderation module publishes its supported content-type domain as repo.CONTENT_TYPES,
 * and its queue page loader (loadContentForQueuePage), decision writer (insertDecision) and
 * publication gate (setModerationStatus) all hard-assert membership of that list. Until 4A
 * declares 'safety_alert' there, a filed row would make every UNFILTERED
 * GET /api/moderation/queue page that contains it throw — a moderator-facing 500 on the
 * FR-08 surface. So the worker files unified-queue entries ONLY once the published contract
 * says the read model can serve them; meanwhile GET /api/moderation/alerts (this module) is
 * the complete FR-07 queue, exactly as shipped by wave 3 (build-plan §5: "do not regress").
 * Evaluated per call, never cached: the moment 4A widens CONTENT_TYPES, filing turns on.
 *
 * Since repair U-V4R-SAFETY-QUEUE, 4A's published contract DOES declare 'safety_alert'
 * (excerpt branch in loadContentForQueuePage; recorded no-op setModerationStatus), so this
 * returns true and filing is ACTIVE; the gate remains as the interlock that would switch
 * filing back off if the read model ever withdrew the type.
 *
 * @returns {boolean}
 */
function unifiedQueueSupported() {
  return moderationRepo.CONTENT_TYPES.includes(UNIFIED_QUEUE_CONTENT_TYPE);
}

/**
 * File one alert's unified-queue entry: a moderation_queue row of content_type
 * 'safety_alert' whose content_id is the safety_alerts.id (FR-07 "moderators work one
 * queue"). Written with this module's own SQL because 4A's insertQueueItem asserts its
 * FR-08 content-type list (build-plan §5 U4-SAFETY-COMPLETE note: "write moderation_queue
 * rows through the handler's own SQL if the interface does not fit").
 *
 * Idempotent while an open item exists for the alert: the INSERT targets 0002's
 * moderation_queue_open_content_key partial unique index exactly as 4A's writer does, so a
 * redelivered 'safety.alert' job can never file a duplicate (RT-02). The entry is filed by
 * the worker BEFORE any delivery leg runs, so it exists — and remains — however delivery
 * ends, including after the job dead-letters (FR-07 "remain visible for review").
 *
 * @param {string} alertId  safety_alerts.id
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<{item: object, created: boolean}>} the open queue row either way
 */
async function fileUnifiedQueueEntry(alertId, client = null) {
  const inserted = await runner(client).query(
    `INSERT INTO moderation_queue (content_type, content_id, reason)
     VALUES ('safety_alert', $1, $2)
     ON CONFLICT (content_type, content_id) WHERE status <> 'resolved' DO NOTHING
     RETURNING id, content_type, content_id, reason, status, created_at`,
    [alertId, UNIFIED_QUEUE_REASON]
  );
  if (inserted.rows.length > 0) {
    return { item: inserted.rows[0], created: true };
  }
  const existing = await runner(client).query(
    `SELECT id, content_type, content_id, reason, status, created_at
       FROM moderation_queue
      WHERE content_type = 'safety_alert' AND content_id = $1 AND status <> 'resolved'
      ORDER BY created_at DESC LIMIT 1`,
    [alertId]
  );
  return { item: existing.rows[0] ?? null, created: false };
}

/** Total alerts matching the queue filter (pagination metadata for the moderator view). */
async function countForModerators({ status } = {}) {
  const params = [];
  let where = '';
  if (status !== undefined) {
    params.push(status);
    where = `WHERE delivery_status = $${params.length}::alert_delivery_status`;
  }
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM safety_alerts ${where}`,
    params
  );
  return rows[0].count;
}

module.exports = {
  UNIFIED_QUEUE_CONTENT_TYPE,
  UNIFIED_QUEUE_REASON,
  insertAlert,
  findById,
  loadForDelivery,
  markDelivered,
  markRetrying,
  markFailed,
  markNoChannel,
  listModeratorIds,
  listForModerators,
  countForModerators,
  unifiedQueueSupported,
  fileUnifiedQueueEntry,
};
