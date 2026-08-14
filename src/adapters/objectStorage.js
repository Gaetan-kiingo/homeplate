// src/adapters/objectStorage.js — U2-MEDIA-LLM: S3-compatible object-storage adapter with
// per-object deletion (ADR-004; MinIO locally, any S3-compatible store in deployment).
//
// Requirement traceability (SRS Appendix B):
//   FR-02 / FR-03 / FR-05 — listing, host-profile and review media live HERE, referenced from
//                    PostgreSQL by key (media_objects.storage_key); serializers derive image
//                    URLs from these keys, never from database blobs.
//   NFR-12 (ST-05) — deleteByKey(key) removes exactly ONE object; the account-erasure job
//                    (mediaService.deleteForUser) calls it once per owned key so a deleted
//                    user's uploads are gone from storage, not just from the database.
//   NFR-09 (RT-01) — every call runs under withResilience (per-attempt timeout, bounded
//                    retries, exponential backoff). A storage outage surfaces as the typed
//                    ObjectStorageUnavailableError (503, code OBJECT_STORAGE_UNAVAILABLE,
//                    retryable) so callers can render a placeholder instead of a 500.
//   NFR-11         — keys are validated against a strict allowlist pattern before any call;
//                    nothing caller-supplied is ever interpolated into a bucket path blindly.
//
// ADR-001/ADR-003 — WORKER-ONLY MODULE. Nothing under src/adapters/ may be imported by a
// request handler; only src/outbox/handlers/* and worker code (e.g. the NFR-12 erasure job
// calling mediaService.deleteForUser) reach this adapter. The adr-conformance lane enforces it.
//
// Endpoint, region, bucket and credentials come exclusively from the environment via
// src/config (OBJECT_STORAGE_* — see .env.example); no secret is hardcoded here.
'use strict';

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const config = require('../config');
const { AppError, NotFoundError, ServiceUnavailableError } = require('../lib/errors');
const { withResilience } = require('../lib/resilience');
const { logger } = require('../lib/logger');

/**
 * Typed degraded-mode error (NFR-09): the store is unreachable/misbehaving. Callers catch
 * this (or match code OBJECT_STORAGE_UNAVAILABLE) and render a placeholder image instead of
 * failing the whole page; the outbox worker treats it as retryable.
 */
class ObjectStorageUnavailableError extends ServiceUnavailableError {
  constructor(message = 'Object storage is temporarily unavailable', options = {}) {
    super(message, { code: 'OBJECT_STORAGE_UNAVAILABLE', ...options });
  }
}

// Storage-key allowlist: S3-safe charset, no leading slash, no traversal, bounded length.
// This is THE canonical key rule — src/modules/media/service.js validates through it too.
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_\-.]{0,511}$/;

// SDK-internal retries stay OFF (a single attempt per send): withResilience owns the retry
// policy from config.adapters.* (NFR-09), so attempt counts stay deterministic/observable.
// Named constant, not policy — the ADR-009 config-only scan checks no policy knob is inlined.
const SDK_ATTEMPTS_SINGLE = 1;

function assertValidKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key) || key.includes('..')) {
    throw new AppError('Invalid object-storage key', {
      status: 422,
      code: 'INVALID_STORAGE_KEY',
      retryable: false,
    });
  }
  return key;
}

/**
 * Maps a raw SDK/network failure to the adapter's typed error taxonomy. A missing object is
 * a non-retryable 404 (the NFR-12 "subsequent get 404s" contract); credential/authorization
 * problems are non-retryable configuration faults; everything else (network refusals, 5xx,
 * throttling, timeouts) is a retryable outage.
 */
function classifyStorageError(err, operation, signal) {
  if (err instanceof AppError) return err; // e.g. the TimeoutError withResilience aborted with
  if (signal && signal.aborted && signal.reason instanceof AppError) return signal.reason;

  const upstreamStatus = (err && err.$metadata && err.$metadata.httpStatusCode) || null;
  const name = (err && err.name) || '';

  if (name === 'NoSuchKey' || name === 'NotFound' || upstreamStatus === 404) {
    return new NotFoundError('Media object not found', {
      code: 'MEDIA_NOT_FOUND',
      retryable: false,
      cause: err,
    });
  }
  if (
    upstreamStatus === 403 ||
    name === 'AccessDenied' ||
    name === 'InvalidAccessKeyId' ||
    name === 'SignatureDoesNotMatch' ||
    name === 'NoSuchBucket'
  ) {
    // Misconfiguration, not a transient outage — retrying cannot fix credentials/bucket.
    return new AppError(`Object storage rejected ${operation} (configuration)`, {
      status: 502,
      code: 'OBJECT_STORAGE_REJECTED',
      retryable: false,
      cause: err,
    });
  }
  return new ObjectStorageUnavailableError(`Object storage ${operation} failed`, { cause: err });
}

/**
 * Builds an adapter instance. The default export uses config; tests inject a fake `client`
 * (and tighter retry/backoff knobs) to exercise the NFR-09 outage path without a network.
 *
 * @param {object} [overrides]
 * @param {{send: Function, destroy?: Function}} [overrides.client]  S3Client-compatible.
 * @param {string} [overrides.bucket]
 * @param {number} [overrides.timeoutMs]   Per-attempt budget (default config.adapters.timeoutMs).
 * @param {number} [overrides.retries]     Retries after the first attempt (default config).
 * @param {object} [overrides.backoff]     { baseMs, factor, maxMs, jitter }.
 * @param {object} [overrides.log]
 */
function createObjectStorage(overrides = {}) {
  const bucket = overrides.bucket ?? config.objectStorage.bucket;
  const timeoutMs = overrides.timeoutMs ?? config.adapters.timeoutMs;
  const retries = overrides.retries ?? config.adapters.retryMax;
  const backoff = overrides.backoff ?? { baseMs: config.adapters.backoffBaseMs };
  const log = overrides.log ?? logger.child({ module: 'objectStorage' });

  const client =
    overrides.client ??
    new S3Client({
      endpoint: config.objectStorage.endpoint,
      region: config.objectStorage.region,
      forcePathStyle: config.objectStorage.forcePathStyle,
      credentials: {
        accessKeyId: config.objectStorage.accessKey,
        secretAccessKey: config.objectStorage.secretKey,
      },
      maxAttempts: SDK_ATTEMPTS_SINGLE,
    });

  /** Shared resilience harness: one command per attempt, abortable on timeout. */
  function send(operation, makeCommand) {
    return withResilience(
      async ({ signal }) => {
        try {
          return await client.send(makeCommand(), { abortSignal: signal });
        } catch (err) {
          throw classifyStorageError(err, operation, signal);
        }
      },
      { name: `objectStorage.${operation}`, timeoutMs, retries, backoff, log }
    );
  }

  /**
   * Stores one object under `key`. Body may be a Buffer, string or Uint8Array.
   * @returns {Promise<{key: string, etag: string|undefined, sizeBytes: number}>}
   */
  async function put(key, body, { contentType } = {}) {
    assertValidKey(key);
    if (body === undefined || body === null) {
      throw new AppError('put(key, body): body is required', {
        status: 422,
        code: 'INVALID_MEDIA_BODY',
        retryable: false,
      });
    }
    const payload = typeof body === 'string' ? Buffer.from(body) : body;
    const response = await send(
      'put',
      () =>
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: payload,
          ContentType: contentType,
        })
    );
    return { key, etag: response.ETag, sizeBytes: payload.byteLength ?? payload.length };
  }

  /**
   * Fetches one object. A key that does not exist rejects with NotFoundError
   * (code MEDIA_NOT_FOUND, HTTP 404) — the NFR-12 post-erasure contract.
   * @returns {Promise<{key: string, body: Buffer, contentType: string|undefined,
   *                    contentLength: number|undefined}>}
   */
  async function get(key) {
    assertValidKey(key);
    const response = await send('get', () => new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await response.Body.transformToByteArray();
    return {
      key,
      body: Buffer.from(bytes),
      contentType: response.ContentType,
      contentLength: response.ContentLength,
    };
  }

  /**
   * Deletes exactly ONE object by key (ADR-004 per-object deletion — the NFR-12 erasure
   * primitive). Idempotent: deleting an already-absent key succeeds, so the erasure job can
   * be retried safely after a partial failure.
   * @returns {Promise<{key: string, deleted: true}>}
   */
  async function deleteByKey(key) {
    assertValidKey(key);
    await send('deleteByKey', () => new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return { key, deleted: true };
  }

  /** Releases the underlying HTTP handler sockets (tests, graceful shutdown). */
  function destroy() {
    if (typeof client.destroy === 'function') client.destroy();
  }

  return { put, get, deleteByKey, destroy, bucket };
}

// Default instance on the configured store. Exposed as module-level functions so worker
// code (and jest spies asserting the NFR-12 call-per-key contract) share one object.
const defaultAdapter = createObjectStorage();

module.exports = {
  put: (key, body, opts) => defaultAdapter.put(key, body, opts),
  get: (key) => defaultAdapter.get(key),
  deleteByKey: (key) => defaultAdapter.deleteByKey(key),
  destroy: () => defaultAdapter.destroy(),
  createObjectStorage,
  assertValidKey,
  KEY_PATTERN,
  ObjectStorageUnavailableError,
};
