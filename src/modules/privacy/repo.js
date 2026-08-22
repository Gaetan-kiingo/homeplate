// src/modules/privacy/repo.js — U4-PRIVACY: data access for the NFR-12/NFR-13 data
// lifecycle (deletion, erasure, CCPA export, inactivity sweep) — SPMP WA-6.
//
// Requirement traceability (SRS Appendix B):
//   NFR-12 (ST-05) — eraseUserRow empties every SRS §3.4 PII column on the USER row (name,
//                    email, phone, emergency contact, password hash) and stamps
//                    deleted_at/anonymized_at; severAuthorReferences rewrites reviews,
//                    messages and safety alerts to anonymized author
//                    references while RETAINING the rows ("reviews may be retained in
//                    anonymized form"); scrubListings removes the host's listing content
//                    incl. the precise/coarse location (§3.4 register: "listing content
//                    incl. location — deleted with host account") while keeping the row so
//                    retained bookings stay resolvable; findInactiveUsers backs the
//                    24-month sweep (clock-injected `now`, months from config).
//   NFR-13 (ST-06) — collectExport assembles a machine-readable copy of EVERY §3.4
//                    PII-register class for ONE user id — each query is keyed on that id, so
//                    no other user's personal data can enter the export; the account class
//                    reuses the users repo's allowlist serializer (decrypting phone and
//                    emergency contact for the owner, never exposing hashes/ciphertext).
//   NFR-11         — every statement is parameterized ($n placeholders); the only inline
//                    SQL strings are fixed sentinel literals ('erased:<id>'), never input.
//   NFR-04         — the erased password_hash sentinel is not a valid Argon2id hash, so an
//                    erased account can never authenticate again.
//   ADR-009        — no policy number appears here: windows come from config via the service.
'use strict';

const { query } = require('../../db/pool');
const usersRepo = require('../users/repo');

/** Runs on the caller's transaction client when given one, else on the pool (NFR-11). */
function runner(client) {
  return client || { query };
}

// ---- data_requests (NFR-12 erasure/inactivity_notice, NFR-13 export) -------------------------

/** Allowlist serializer for a data_requests row (AB-08 — responses never spread rows). */
function serializeRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

/**
 * Insert one data_requests row (kind: 'erasure' | 'export' | 'inactivity_notice').
 * @param {import('pg').PoolClient} client  the caller's transaction client (ADR-001)
 */
async function createRequest(client, { userId, kind, dueAt, detail = {} }) {
  const { rows } = await runner(client).query(
    `INSERT INTO data_requests (user_id, kind, due_at, detail)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [userId, kind, dueAt, JSON.stringify(detail)]
  );
  return rows[0];
}

async function findRequestById(id, client = null) {
  const { rows } = await runner(client).query(`SELECT * FROM data_requests WHERE id = $1`, [id]);
  return rows[0] || null;
}

/** Owner-scoped lookup (AB-08: a user can only ever read THEIR OWN request). */
async function findRequestForUser(id, userId, client = null) {
  const { rows } = await runner(client).query(
    `SELECT * FROM data_requests WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0] || null;
}

/** The newest not-yet-completed request of one kind for a user (idempotent re-request). */
async function findOpenRequest(userId, kind, client = null) {
  const { rows } = await runner(client).query(
    `SELECT * FROM data_requests
      WHERE user_id = $1 AND kind = $2 AND status IN ('pending', 'processing')
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [userId, kind]
  );
  return rows[0] || null;
}

/** Transition a request to 'processing' (erasure/export job picked it up). */
async function markRequestProcessing(id, client = null) {
  const { rows } = await runner(client).query(
    `UPDATE data_requests SET status = 'processing', updated_at = now() WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

/**
 * Complete a request at the (possibly clock-injected) instant, merging `detail` into the
 * stored jsonb — the CCPA export payload and the erasure/cancellation evidence live there.
 */
async function completeRequest(client, id, { completedAt, detail = {} }) {
  const { rows } = await runner(client).query(
    `UPDATE data_requests
        SET status = 'completed', completed_at = $2, detail = detail || $3::jsonb,
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, completedAt, JSON.stringify(detail)]
  );
  return rows[0] || null;
}

/** Terminal failure (e.g. export requested for an account erased in the meantime). */
async function failRequest(id, reason, client = null) {
  const { rows } = await runner(client).query(
    `UPDATE data_requests
        SET status = 'failed', detail = detail || $2::jsonb, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, JSON.stringify({ failedReason: reason })]
  );
  return rows[0] || null;
}

/** Merge extra evidence into a request's detail without changing its status. */
async function mergeRequestDetail(id, detail, client = null) {
  const { rows } = await runner(client).query(
    `UPDATE data_requests SET detail = detail || $2::jsonb, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(detail)]
  );
  return rows[0] || null;
}

// ---- users (NFR-12 deletion mark + §3.4 erasure) ---------------------------------------------

async function getUser(userId, client = null) {
  const { rows } = await runner(client).query(`SELECT * FROM users WHERE id = $1`, [userId]);
  return rows[0] || null;
}

/**
 * Soft-delete mark (NFR-12): sets deleted_at so the account instantly vanishes from login,
 * profile, search, host and listing read paths (they all filter deleted_at IS NULL) while
 * the PII survives until the scheduled erasure instant empties it.
 */
async function markDeleted(client, userId, at) {
  const { rows } = await runner(client).query(
    `UPDATE users SET deleted_at = COALESCE(deleted_at, $2), updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [userId, at]
  );
  return rows[0] || null;
}

/**
 * Empty EVERY §3.4 PII column on the users row (ST-05). Idempotent by construction: the
 * sentinels are deterministic per user id, so a retried job converges on the same state.
 *  - email      → 'erased:<id>' (NOT NULL UNIQUE survives; not email-shaped, so the address
 *                 can never be logged into, mailed, or mistaken for personal data)
 *  - password_hash → 'erased' (NFR-04: not a valid hash — authentication is impossible)
 *  - full_name, phone_enc, emergency_contact_*_enc → NULL (third-party PII included —
 *                 NFR-13: the emergency contact is in the registering user's deletion scope)
 *  - eligibility flags → false; anonymized_at stamped with the (clock-injected) instant.
 */
async function eraseUserRow(client, userId, at) {
  const { rows } = await runner(client).query(
    `UPDATE users
        SET email = 'erased:' || id,
            email_verified = false,
            password_hash = 'erased',
            full_name = NULL,
            phone_enc = NULL,
            emergency_contact_name_enc = NULL,
            emergency_contact_phone_enc = NULL,
            emergency_contact_email_enc = NULL,
            can_reserve_seat = false,
            can_publish_listing = false,
            deleted_at = COALESCE(deleted_at, $2),
            anonymized_at = $2,
            updated_at = now()
      WHERE id = $1
      RETURNING id, deleted_at, anonymized_at`,
    [userId, at]
  );
  return rows[0] || null;
}

/**
 * Rewrite the user's authored/actor references to anonymized ones while RETAINING every row
 * (NFR-12: "reviews may be retained in anonymized form"; §3.4 register: booking and
 * safety-alert records anonymized; the author identity behind moderation decisions is
 * severed through these content references — see the note below). The
 * nullable FKs were designed for exactly this (0001 schema). Bookings keep their guest_id:
 * the reference now resolves to the erased user shell, which carries no PII — severing it is
 * impossible anyway (NOT NULL) and unnecessary (an opaque UUID identifies nobody).
 * @returns {Promise<{reviews:number, messages:number, safetyAlerts:number,
 *                    reviewTargets:number}>} rows rewritten
 */
async function severAuthorReferences(client, userId) {
  const r = runner(client);
  const reviews = await r.query(
    `UPDATE reviews SET author_id = NULL, updated_at = now() WHERE author_id = $1`,
    [userId]
  );
  const reviewTargets = await r.query(
    `UPDATE reviews SET target_user_id = NULL, updated_at = now() WHERE target_user_id = $1`,
    [userId]
  );
  // §3.4 register, Messages row: "Deleted with account; moderation evidence retained
  // anonymized" — the CONTENT goes (a chat line is the author's personal data and routinely
  // carries names/addresses), the anonymized shell stays so threads and the moderation
  // decisions on them remain resolvable.
  const messages = await r.query(
    `UPDATE messages
        SET sender_id = NULL, body = '[removed: sender account deleted (NFR-12)]'
      WHERE sender_id = $1`,
    [userId]
  );
  const safetyAlerts = await r.query(
    `UPDATE safety_alerts SET raised_by = NULL, updated_at = now() WHERE raised_by = $1`,
    [userId]
  );
  // Moderation records (moderation_decisions.decided_by_user_id, moderation_queue
  // .assigned_to) are NOT touched here: the moderation module is their single writer
  // (AB-01 one-writer invariant, st-security-wave3), and the §3.4 "author identity
  // severed" rule is satisfied through the CONTENT references above — decided_by/assigned
  // ids are moderator references that, once the user row is erased, resolve to an
  // anonymized shell carrying no PII (same argument as bookings.guest_id).
  return {
    reviews: reviews.rowCount,
    reviewTargets: reviewTargets.rowCount,
    messages: messages.rowCount,
    safetyAlerts: safetyAlerts.rowCount,
  };
}

/**
 * Remove the host's listing CONTENT while retaining the rows (§3.4 register: "listing
 * content incl. location and images — deleted with host account"; images go separately, by
 * storage key, through mediaService.deleteForUser). The listing's street address and exact
 * coordinates ARE the host's PII (ADR-010), so every location column is emptied — public
 * precision included, since a coarse point still centers on a home. Rows survive because
 * retained bookings reference them (FK NOT NULL); status 'cancelled' takes them out of the
 * FR-11 daily-uniqueness set and every discovery path (which already filters deleted hosts).
 */
async function scrubListings(client, userId) {
  const { rowCount } = await runner(client).query(
    `UPDATE listings
        SET title = 'Listing removed',
            description = 'Content removed: the host account was deleted (NFR-12).',
            ingredients = '{}',
            allergens = '{}',
            cuisine = NULL,
            address_line1 = NULL,
            address_line2 = NULL,
            city = NULL,
            region = NULL,
            postal_code = NULL,
            lat = NULL,
            lng = NULL,
            coarse_lat = NULL,
            coarse_lng = NULL,
            area_label = NULL,
            status = 'cancelled',
            updated_at = now()
      WHERE host_id = $1`,
    [userId]
  );
  return rowCount;
}

/** Clear the user-authored host-profile text (kept row: the PK anchors media/host reads). */
async function clearHostProfile(client, userId) {
  const { rowCount } = await runner(client).query(
    `UPDATE host_profiles SET bio = NULL, updated_at = now() WHERE user_id = $1`,
    [userId]
  );
  return rowCount;
}

/** Outstanding verification tokens are dead credentials for a dead account — drop them. */
async function deleteVerificationTokens(client, userId) {
  const { rowCount } = await runner(client).query(
    `DELETE FROM email_verification_tokens WHERE user_id = $1`,
    [userId]
  );
  return rowCount;
}

/**
 * Erase stored CCPA export copies for the user (ST-05): a completed export's detail holds a
 * full PII snapshot, which must not survive the account it describes.
 */
async function wipeExportDetails(client, userId) {
  const { rowCount } = await runner(client).query(
    `UPDATE data_requests SET detail = '{}'::jsonb, updated_at = now()
      WHERE user_id = $1 AND kind = 'export'`,
    [userId]
  );
  return rowCount;
}

// ---- inactivity sweep (NFR-12: 24 months, then notice, then erasure) -------------------------

/**
 * Accounts stale at the (clock-injected) instant: last active `months` or more before `now`,
 * not deleted, not already flagged by an open inactivity_notice request.
 * @returns {Promise<Array<{id: string}>>}
 */
async function findInactiveUsers({ now, months, limit }, client = null) {
  const { rows } = await runner(client).query(
    `SELECT id FROM users
      WHERE deleted_at IS NULL
        AND anonymized_at IS NULL
        AND last_active_at <= $1::timestamptz - make_interval(months => $2)
        AND NOT EXISTS (
              SELECT 1 FROM data_requests dr
               WHERE dr.user_id = users.id
                 AND dr.kind = 'inactivity_notice'
                 AND dr.status IN ('pending', 'processing'))
      ORDER BY last_active_at ASC, id ASC
      LIMIT $3`,
    [now, months, limit]
  );
  return rows;
}

// ---- CCPA export (NFR-13: every §3.4 register class, requesting user ONLY) -------------------

/**
 * Machine-readable copy of every §3.4 PII-register class for `userId`. Each query is keyed
 * on that one id; nothing joins another user's personal attributes (a booking on the user's
 * listing surfaces as ids and status — the guest's identity is the GUEST's data, not the
 * requester's, and is excluded by design).
 */
async function collectExport(userId, client = null) {
  const r = runner(client);

  const userRow = await getUser(userId, client);
  if (!userRow) return null;
  const { rows: hostProfileRows } = await r.query(
    `SELECT * FROM host_profiles WHERE user_id = $1`,
    [userId]
  );

  const { rows: listings } = await r.query(
    `SELECT id, title, description, ingredients, allergens, cuisine, scheduled_start,
            duration_minutes, address_line1, address_line2, city, region, postal_code,
            country, lat, lng, area_label, seat_capacity, seats_remaining,
            moderation_status, status, created_at
       FROM listings WHERE host_id = $1 ORDER BY created_at`,
    [userId]
  );

  const { rows: bookings } = await r.query(
    `SELECT id, listing_id, status, host_confirmed_completion, guest_confirmed_completion,
            cancelled_at, created_at
       FROM bookings WHERE guest_id = $1 ORDER BY created_at`,
    [userId]
  );

  const { rows: reviews } = await r.query(
    `SELECT id, booking_id, rating, body, moderation_status, created_at
       FROM reviews WHERE author_id = $1 ORDER BY created_at`,
    [userId]
  );

  const { rows: messages } = await r.query(
    `SELECT id, booking_id, body, moderation_status, created_at
       FROM messages WHERE sender_id = $1 ORDER BY created_at`,
    [userId]
  );

  const { rows: safetyAlerts } = await r.query(
    `SELECT id, booking_id, delivery_status, delivered_at, created_at
       FROM safety_alerts WHERE raised_by = $1 ORDER BY created_at`,
    [userId]
  );

  const { rows: media } = await r.query(
    `SELECT storage_key, entity_type, entity_id, content_type, size_bytes, created_at
       FROM media_objects WHERE owner_user_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    [userId]
  );

  // §3.4 register: "Moderation decisions — retained anonymized" — the decisions ON this
  // user's authored content are part of their record.
  const { rows: moderationDecisions } = await r.query(
    `SELECT d.id, d.content_type, d.content_id, d.category, d.outcome, d.decided_by,
            d.created_at
       FROM moderation_decisions d
      WHERE (d.content_type = 'review'
               AND d.content_id IN (SELECT id FROM reviews WHERE author_id = $1))
         OR (d.content_type = 'message'
               AND d.content_id IN (SELECT id FROM messages WHERE sender_id = $1))
         OR (d.content_type = 'listing'
               AND d.content_id IN (SELECT id FROM listings WHERE host_id = $1))
      ORDER BY d.created_at`,
    [userId]
  );

  // §3.4 register: "Logs and notification attempts — user IDs only" (safe to return whole).
  const { rows: notificationAttempts } = await r.query(
    `SELECT id, channel, template, status, sent_at, created_at
       FROM notification_attempts WHERE recipient_user_id = $1 ORDER BY created_at`,
    [userId]
  );

  const { rows: dataRequests } = await r.query(
    `SELECT id, kind, status, due_at, completed_at, created_at
       FROM data_requests WHERE user_id = $1 ORDER BY created_at`,
    [userId]
  );

  // NFR-13: privileged reads OF this user's data (who accessed it, when, why).
  const { rows: accessLog } = await r.query(
    `SELECT purpose, resource, created_at
       FROM access_log WHERE subject_user_id = $1 ORDER BY created_at`,
    [userId]
  );

  return {
    // Account identity + emergency contact classes — the users repo's OWNER allowlist
    // serializer (decrypted phone/emergency contact; hashes and ciphertext have no path out).
    account: usersRepo.serializeUser(userRow, hostProfileRows[0] || null),
    listings: listings.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      ingredients: row.ingredients,
      allergens: row.allergens,
      cuisine: row.cuisine,
      scheduledStart: row.scheduled_start,
      durationMinutes: row.duration_minutes,
      address: {
        line1: row.address_line1,
        line2: row.address_line2,
        city: row.city,
        region: row.region,
        postalCode: row.postal_code,
        country: row.country,
      },
      lat: row.lat,
      lng: row.lng,
      areaLabel: row.area_label,
      seatCapacity: row.seat_capacity,
      seatsRemaining: row.seats_remaining,
      moderationStatus: row.moderation_status,
      status: row.status,
      createdAt: row.created_at,
    })),
    bookings: bookings.map((row) => ({
      id: row.id,
      listingId: row.listing_id,
      status: row.status,
      hostConfirmedCompletion: row.host_confirmed_completion,
      guestConfirmedCompletion: row.guest_confirmed_completion,
      cancelledAt: row.cancelled_at,
      createdAt: row.created_at,
    })),
    reviews: reviews.map((row) => ({
      id: row.id,
      bookingId: row.booking_id,
      rating: row.rating,
      body: row.body,
      moderationStatus: row.moderation_status,
      createdAt: row.created_at,
    })),
    messages: messages.map((row) => ({
      id: row.id,
      bookingId: row.booking_id,
      body: row.body,
      moderationStatus: row.moderation_status,
      createdAt: row.created_at,
    })),
    safetyAlerts: safetyAlerts.map((row) => ({
      id: row.id,
      bookingId: row.booking_id,
      deliveryStatus: row.delivery_status,
      deliveredAt: row.delivered_at,
      createdAt: row.created_at,
    })),
    media: media.map((row) => ({
      storageKey: row.storage_key,
      entityType: row.entity_type,
      entityId: row.entity_id,
      contentType: row.content_type,
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      createdAt: row.created_at,
    })),
    moderationDecisions: moderationDecisions.map((row) => ({
      id: row.id,
      contentType: row.content_type,
      contentId: row.content_id,
      category: row.category,
      outcome: row.outcome,
      decidedBy: row.decided_by,
      createdAt: row.created_at,
    })),
    notificationAttempts: notificationAttempts.map((row) => ({
      id: row.id,
      channel: row.channel,
      template: row.template,
      status: row.status,
      sentAt: row.sent_at,
      createdAt: row.created_at,
    })),
    dataRequests: dataRequests.map(serializeRequest),
    accessLog: accessLog.map((row) => ({
      purpose: row.purpose,
      resource: row.resource,
      createdAt: row.created_at,
    })),
  };
}

module.exports = {
  serializeRequest,
  createRequest,
  findRequestById,
  findRequestForUser,
  findOpenRequest,
  markRequestProcessing,
  completeRequest,
  failRequest,
  mergeRequestDetail,
  getUser,
  markDeleted,
  eraseUserRow,
  severAuthorReferences,
  scrubListings,
  clearHostProfile,
  deleteVerificationTokens,
  wipeExportDetails,
  findInactiveUsers,
  collectExport,
};
