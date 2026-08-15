// src/modules/media/service.js — U2-MEDIA-LLM: the media service (ADR-004 media path).
//
// Requirement traceability (SRS Appendix B):
//   FR-02 / FR-03 / FR-05 — attach(userId, key, kind) records ownership of a listing /
//                    host-profile / review image in media_objects; list(ownerId) is what
//                    feature serializers use to resolve a user's media keys into URLs.
//   NFR-12 (ST-05) — deleteForUser(userId) is THE account-erasure media hook: it calls
//                    objectStorage.deleteByKey once PER OWNED KEY and removes each row only
//                    after its object is gone, so erasure covers storage, not just the
//                    database. Partial failure leaves the failed rows in place and raises a
//                    retryable error — the erasure job simply runs again (ADR-004).
//   NFR-09 (RT-01) — a storage outage during erasure surfaces as a typed retryable error
//                    (MEDIA_ERASURE_INCOMPLETE) instead of losing track of undeleted media.
//   NFR-11         — inputs are validated against strict allowlists (uuid, key pattern,
//                    entity-kind enum) before any SQL runs; all SQL is parameterized (repo).
//
// ADR-001/ADR-003 boundary: attach() and list() touch PostgreSQL only and are safe anywhere.
// deleteForUser() drives the object-storage ADAPTER and is therefore WORKER-ONLY — it is
// called by the NFR-12 erasure job (wave-4 outbox handler), never from a request handler.
// The adapter is resolved lazily inside that one function, and NOTHING request-reachable in
// this module reaches for it — not even to validate a key — so serving a request never loads
// src/adapters/objectStorage.js and never constructs its module-scope S3 client. Key
// validation goes through the dependency-free src/lib/mediaUrls.assertValidKey instead
// (adr-conformance lane's per-route adapter-delta assertion, build-plan §5.1/§6.3).
'use strict';

const repo = require('./repo');
const { assertValidKey } = require('../../lib/mediaUrls');
const {
  ValidationError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} = require('../../lib/errors');
const { logger } = require('../../lib/logger');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value, field) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ValidationError(`${field} must be a UUID`, { details: { field } });
  }
  return value;
}

// WORKER-ONLY adapter access (ADR-001/003). Resolved at call time and called from EXACTLY ONE
// place — deleteForUser(), the NFR-12 erasure hook that runs on the worker. Do not call this
// from attach()/list()/listKeys(): those are reachable from POST/GET /api/media, and merely
// require()-ing the adapter there executes its module scope (a new S3Client) inside a request.
function getStorage() {
  return require('../../adapters/objectStorage');
}

/**
 * Records that `userId` owns the object stored under `key` (FR-02/03/05).
 *
 * @param {string} userId  Owner (users.id).
 * @param {string} key     Object-storage key the media was uploaded under.
 * @param {string} kind    One of repo.MEDIA_KINDS: 'listing' | 'review' | 'host_profile'.
 * @param {object} [opts]  { entityId, contentType, sizeBytes, client } — client composes the
 *                         insert into a caller's withTransaction unit of work (ADR-001).
 * @returns {Promise<object>} the created media row (camelCase, includes storageKey).
 */
async function attach(userId, key, kind, opts = {}) {
  assertUuid(userId, 'userId');
  // Pure, adapter-free key check (ADR-001/003): same pattern and same 422 INVALID_STORAGE_KEY
  // error the adapter raises worker-side; tests/unit/listings.test.js pins them identical.
  assertValidKey(key);
  if (!repo.MEDIA_KINDS.includes(kind)) {
    throw new ValidationError(`kind must be one of: ${repo.MEDIA_KINDS.join(', ')}`, {
      details: { field: 'kind' },
    });
  }
  if (opts.entityId !== undefined && opts.entityId !== null) assertUuid(opts.entityId, 'entityId');

  try {
    return await repo.insertMediaObject(
      {
        ownerUserId: userId,
        storageKey: key,
        entityType: kind,
        entityId: opts.entityId ?? null,
        contentType: opts.contentType ?? null,
        sizeBytes: opts.sizeBytes ?? null,
      },
      opts.client ?? null
    );
  } catch (err) {
    if (err && err.code === '23505') {
      throw new ConflictError('This storage key is already attached', {
        code: 'MEDIA_KEY_EXISTS',
        cause: err,
      });
    }
    if (err && err.code === '23503') {
      throw new NotFoundError('Owner user not found', {
        code: 'MEDIA_OWNER_NOT_FOUND',
        cause: err,
      });
    }
    throw err;
  }
}

/**
 * Every live media row owned by `ownerId`, oldest first. Each row carries `storageKey` —
 * feature serializers turn those keys into image URLs (FR-02/03/05).
 */
async function list(ownerId, opts = {}) {
  assertUuid(ownerId, 'ownerId');
  return repo.listByOwner(ownerId, {}, opts.client ?? null);
}

/** Convenience projection of list(): the owned storage keys only (NFR-12 erasure audit). */
async function listKeys(ownerId, opts = {}) {
  const rows = await list(ownerId, opts);
  return rows.map((row) => row.storageKey);
}

/**
 * NFR-12 erasure hook (WORKER-ONLY — see module header): deletes every media object owned
 * by `userId` from object storage BY KEY (one deleteByKey call per key, ADR-004) and removes
 * each row after its object deletion succeeds.
 *
 * Retry-safe by construction: a row is removed only once its object is gone, and
 * objectStorage.deleteByKey is idempotent, so re-running after a partial failure finishes
 * the job without orphaning objects. If any key fails, the failed rows stay in place and a
 * retryable MEDIA_ERASURE_INCOMPLETE error is raised for the outbox worker's backoff.
 *
 * @returns {Promise<{deletedObjects: number, deletedRows: number, total: number}>}
 */
async function deleteForUser(userId) {
  assertUuid(userId, 'userId');
  const storage = getStorage();
  const log = logger.child({ module: 'mediaService' });

  // includeDeleted: a retried job also sweeps rows already carrying the erasure audit mark.
  const owned = await repo.listByOwner(userId, { includeDeleted: true });
  let deletedObjects = 0;
  let deletedRows = 0;
  const failedIds = [];

  for (const media of owned) {
    try {
      // Called through the adapter module so the call-per-key contract stays observable
      // (ST-05 asserts one deleteByKey per owned key).
      await storage.deleteByKey(media.storageKey);
      deletedObjects += 1;
      if (await repo.removeById(media.id)) deletedRows += 1;
    } catch (err) {
      failedIds.push(media.id);
      // IDs only — storage keys and user IDs are not PII, but keep log lines minimal.
      log.warn(
        { event: 'media_erasure_key_failed', mediaId: media.id, code: err && err.code },
        'media erasure: deleteByKey failed; row retained for retry'
      );
    }
  }

  if (failedIds.length > 0) {
    throw new ServiceUnavailableError(
      `Media erasure incomplete: ${failedIds.length} of ${owned.length} object(s) could not be deleted`,
      {
        code: 'MEDIA_ERASURE_INCOMPLETE',
        retryable: true,
        details: { failedCount: failedIds.length, totalCount: owned.length },
      }
    );
  }

  return { deletedObjects, deletedRows, total: owned.length };
}

module.exports = { attach, list, listKeys, deleteForUser, MEDIA_KINDS: repo.MEDIA_KINDS };
