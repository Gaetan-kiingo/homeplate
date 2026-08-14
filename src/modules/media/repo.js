// src/modules/media/repo.js — U2-MEDIA-LLM: data access for media_objects (§3.4 Media).
//
// Requirement traceability (SRS Appendix B):
//   FR-02 / FR-03 / FR-05 — listing, host-profile and review images are referenced from
//                    PostgreSQL BY KEY (media_objects.storage_key) per ADR-004; feature
//                    modules resolve these rows into image URLs.
//   NFR-12 (ST-05) — listByOwner / removeById are the erasure surface: the account-deletion
//                    job enumerates a user's keys, deletes each object from storage, then
//                    removes the row — media vanish with the account.
//   NFR-11 (ST-04) — every statement is parameterized ($n placeholders via src/db/pool);
//                    no caller value is ever interpolated into SQL text.
//
// All functions accept an optional pg client so callers can compose them into a
// withTransaction unit of work (ADR-001 — one transaction, no dual writes).
'use strict';

const { query } = require('../../db/pool');

/** media_objects.entity_type enum values (db/migrations/0001_core_schema.sql, ADR-004). */
const MEDIA_KINDS = Object.freeze(['listing', 'review', 'host_profile']);

/** Maps a media_objects row to the camelCase shape services and serializers consume. */
function toMediaObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    storageKey: row.storage_key,
    contentType: row.content_type,
    sizeBytes:
      row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  };
}

function run(text, params, client) {
  return client ? client.query(text, params) : query(text, params);
}

/**
 * Records one owned media object (FR-02/03/05 attach path).
 * Uniqueness of storage_key is enforced by the media_objects_storage_key_key constraint;
 * the service maps the 23505 violation to a ConflictError.
 */
async function insertMediaObject(
  { ownerUserId, storageKey, entityType, entityId = null, contentType = null, sizeBytes = null },
  client = null
) {
  const { rows } = await run(
    `INSERT INTO media_objects (owner_user_id, entity_type, entity_id, storage_key, content_type, size_bytes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [ownerUserId, entityType, entityId, storageKey, contentType, sizeBytes],
    client
  );
  return toMediaObject(rows[0]);
}

/**
 * Every live media row owned by a user, oldest first (deterministic order).
 * `includeDeleted: true` also returns rows already carrying the NFR-12 erasure audit mark,
 * so a retried erasure job can finish cleaning up after a partial failure.
 */
async function listByOwner(ownerUserId, { includeDeleted = false } = {}, client = null) {
  const { rows } = await run(
    `SELECT * FROM media_objects
     WHERE owner_user_id = $1 ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
     ORDER BY created_at, id`,
    [ownerUserId],
    client
  );
  return rows.map(toMediaObject);
}

/** Single row by its unique storage key (or null). */
async function findByKey(storageKey, client = null) {
  const { rows } = await run(
    `SELECT * FROM media_objects WHERE storage_key = $1`,
    [storageKey],
    client
  );
  return toMediaObject(rows[0]);
}

/**
 * Single row by id, scoped to its owner in the statement itself (or null) — so callers can
 * keep "not found" and "not yours" indistinguishable (AB-08). Returns delete-marked rows
 * too (deletedAt set), letting the owner's DELETE stay idempotent.
 */
async function findOwnedById(ownerUserId, id, client = null) {
  const { rows } = await run(
    `SELECT * FROM media_objects WHERE id = $1 AND owner_user_id = $2`,
    [id, ownerUserId],
    client
  );
  return toMediaObject(rows[0]);
}

/**
 * Delete-MARKS one media row (sets deleted_at) so it drops out of every read path
 * immediately; physical per-key deletion stays on the worker/erasure path (ADR-004,
 * NFR-12 — see removeById). Idempotent: an already-marked row is left untouched.
 * @returns {Promise<boolean>} true when this call marked the row.
 */
async function markDeleted(id, client = null) {
  const result = await run(
    `UPDATE media_objects SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [id],
    client
  );
  return result.rowCount === 1;
}

/**
 * Removes one media row (NFR-12: called only AFTER the object was deleted from storage by
 * key, so a crash between the two leaves a row a retried job will re-process — never an
 * orphaned object that survives erasure).
 * @returns {Promise<boolean>} true when a row was removed.
 */
async function removeById(id, client = null) {
  const result = await run(`DELETE FROM media_objects WHERE id = $1`, [id], client);
  return result.rowCount === 1;
}

module.exports = {
  MEDIA_KINDS,
  toMediaObject,
  insertMediaObject,
  listByOwner,
  findByKey,
  findOwnedById,
  markDeleted,
  removeById,
};
