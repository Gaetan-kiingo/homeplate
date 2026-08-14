// src/modules/hosts/repo.js — U3-HOSTS-MEDIA: data access for the FR-03 host personal page
// (build-plan wave 3B; SPMP WA-8).
//
// Requirement traceability (SRS Appendix B):
//   FR-03 (TC-03) — findHost joins users + host_profiles (self-introduction = bio);
//            listApprovedReviews / getReviewStats supply the approved reviews about the host
//            with numeric ratings, average and count; listHostProfileMedia supplies the
//            kitchen/dining images (media referenced BY KEY per ADR-004 — URL derivation is
//            src/lib/mediaUrls via the serializers).
//   FR-05 / FR-08 — ONLY moderation_status='approved' reviews are ever selected here:
//            pending/rejected reviews are invisible on every host read path (AB-01 direction
//            for reviews — unreviewed content never reaches the public).
//   NFR-13 / AB-08 — PII minimization AT THE QUERY: these statements select ONLY non-personal
//            columns (id, full_name as display identity, bio, created_at, rating, body,
//            storage_key). email, phone_enc, emergency-contact ciphertext, password_hash and
//            listing address columns are never fetched, so no forgotten serializer key could
//            leak them — the data never enters the process for this page.
//   NFR-11 (ST-04) — every statement is parameterized ($n placeholders via src/db/pool);
//            no caller value is ever interpolated into SQL text.
//   NFR-02 — reviews queries ride the 0002 reviews_target_moderation_idx; media lookups ride
//            media_objects_owner_idx / media_objects_entity_idx (LT-01 pagination target).
//
// All functions accept an optional pg client so callers can compose them into a
// withTransaction unit of work (ADR-001).
'use strict';

const { query } = require('../../db/pool');

function run(text, params, client) {
  return client ? client.query(text, params) : query(text, params);
}

/**
 * The host identity for the FR-03 page: a NON-DELETED user WITH a host profile.
 * Returns null (→ 404 upstream) for unknown ids, deleted accounts and users who never
 * created a host profile. Only non-PII columns are selected (NFR-13 — see module header).
 *
 * @returns {Promise<{id: string, fullName: string|null, bio: string|null,
 *                    memberSince: Date, hostSince: Date}|null>}
 */
async function findHost(hostId, client = null) {
  const { rows } = await run(
    `SELECT u.id, u.full_name, u.created_at AS member_since,
            hp.bio, hp.created_at AS host_since
       FROM users u
       JOIN host_profiles hp ON hp.user_id = u.id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [hostId],
    client
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    bio: row.bio,
    memberSince: row.member_since,
    hostSince: row.host_since,
  };
}

/**
 * Live kitchen/dining images for a host (FR-03): media_objects rows of entity_type
 * 'host_profile' owned by the host, oldest first. Rows marked deleted_at (delete-mark via
 * DELETE /api/media/:id, or the NFR-12 erasure sweep) are excluded — deleted media never
 * resurface on any read path (ADR-004).
 */
async function listHostProfileMedia(hostId, client = null) {
  const { rows } = await run(
    `SELECT id, storage_key, content_type
       FROM media_objects
      WHERE entity_type = 'host_profile' AND owner_user_id = $1 AND deleted_at IS NULL
      ORDER BY created_at, id`,
    [hostId],
    client
  );
  return rows;
}

/**
 * Live listing images for a SET of listings in one round trip (avoids an N+1 over the
 * host's example dishes — NFR-01/NFR-02 read-path discipline).
 * @param {string[]} listingIds
 * @returns {Promise<Map<string, Array<{id: string, storage_key: string, content_type: string|null}>>>}
 *          keyed by listing id; listings without media simply have no entry.
 */
async function listMediaForListings(listingIds, client = null) {
  const byListing = new Map();
  if (!Array.isArray(listingIds) || listingIds.length === 0) return byListing;
  const { rows } = await run(
    `SELECT id, entity_id, storage_key, content_type
       FROM media_objects
      WHERE entity_type = 'listing' AND entity_id = ANY($1::uuid[]) AND deleted_at IS NULL
      ORDER BY created_at, id`,
    [listingIds],
    client
  );
  for (const row of rows) {
    const list = byListing.get(row.entity_id) || [];
    list.push({ id: row.id, storage_key: row.storage_key, content_type: row.content_type });
    byListing.set(row.entity_id, list);
  }
  return byListing;
}

/**
 * Aggregate over the APPROVED reviews about a host (FR-03 averageRating / reviewCount).
 * avg() is computed by PostgreSQL over the same filtered set the list queries use, so the
 * page numbers and the aggregate can never disagree.
 * @returns {Promise<{reviewCount: number, averageRating: number|null}>} averageRating is the
 *          raw float (callers round for presentation); null when there are no reviews.
 */
async function getReviewStats(hostId, client = null) {
  const { rows } = await run(
    `SELECT count(*)::int AS review_count, avg(rating)::float8 AS average_rating
       FROM reviews
      WHERE target_user_id = $1 AND moderation_status = 'approved'`,
    [hostId],
    client
  );
  return {
    reviewCount: rows[0].review_count,
    averageRating: rows[0].average_rating === null ? null : Number(rows[0].average_rating),
  };
}

/**
 * One page of APPROVED reviews about a host, newest first (FR-03; FR-05 numeric ratings;
 * LT-01 pagination target). The author join carries full_name ONLY (display identity) and
 * tolerates NFR-12 anonymization: a severed author_id (NULL) or deleted author row yields
 * author_full_name NULL, which the serializer renders as an anonymized display name.
 *
 * @param {string} hostId
 * @param {{limit: number, offset: number}} page
 * @returns {Promise<Array<{id, rating, body, created_at, author_id, author_full_name}>>}
 */
async function listApprovedReviews(hostId, { limit, offset = 0 }, client = null) {
  const { rows } = await run(
    `SELECT r.id, r.rating, r.body, r.created_at, r.author_id,
            u.full_name AS author_full_name
       FROM reviews r
       LEFT JOIN users u ON u.id = r.author_id AND u.deleted_at IS NULL
      WHERE r.target_user_id = $1 AND r.moderation_status = 'approved'
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $2 OFFSET $3`,
    [hostId, limit, offset],
    client
  );
  return rows;
}

module.exports = {
  findHost,
  listHostProfileMedia,
  listMediaForListings,
  getReviewStats,
  listApprovedReviews,
};
